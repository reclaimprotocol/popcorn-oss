#!/bin/bash

# 0. AMD SEV attestation is handled by the browser-runtime-attestor sidecar.
echo "🔒 Attestation served by browser-runtime-attestor sidecar."

# 1. Determine IP Address
# Robust IP detection
# Try hostname -i, fallback to ip route
MY_IP=$(hostname -i | tr " " "\n" | grep -v ":" | head -n 1)
if [ -z "$MY_IP" ]; then
    echo "⚠️  hostname -i failed to give IPv4, trying ip route..."
    MY_IP=$(ip route get 1 | awk '{print $7; exit}')
fi

if [ -z "$MY_IP" ]; then
    echo "❌ Could not determine IP. Exiting."
    exit 1
fi

PORT=8082

echo "🌍 My IP is: $MY_IP"

# -----------------------------------------------------------------------------
# Agones SDK Integration
# -----------------------------------------------------------------------------

agones_ready() {
  echo "[entrypoint] 🎮 Signaling Agones: READY"
  curl -X POST http://localhost:9358/ready -d '{}' -H "Content-Type: application/json" || echo "[entrypoint] ⚠️ Failed to signal Agones Ready"
}

agones_shutdown() {
  echo "[entrypoint] 🎮 Signaling Agones: SHUTDOWN"
  curl -X POST http://localhost:9358/shutdown -d '{}' -H "Content-Type: application/json" || echo "[entrypoint] ⚠️ Failed to signal Agones Shutdown"
}

start_agones_health() {
  echo "[entrypoint] Starting Agones Health pings..."
  while true; do
    curl -X POST http://localhost:9358/health -d '{}' -H "Content-Type: application/json" >/dev/null 2>&1
    sleep 2
  done &
  AGONES_HEALTH_PID=$!
}

K8S_API="https://${KUBERNETES_SERVICE_HOST}:${KUBERNETES_SERVICE_PORT_HTTPS:-443}"
K8S_TOKEN_FILE="/var/run/secrets/kubernetes.io/serviceaccount/token"
K8S_CA_FILE="/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"

export NEKO_LEGACY=true
export NEKO_ICELITE=false
POPCORN_BROWSER_STREAMING_MODE="${POPCORN_BROWSER_STREAMING_MODE:-webrtc}"
ENABLE_WEBRTC_STREAM=false
ENABLE_VNC_STREAM=false
case "$POPCORN_BROWSER_STREAMING_MODE" in
    webrtc)
        ENABLE_WEBRTC_STREAM=true
        ;;
    vnc)
        ENABLE_VNC_STREAM=true
        ;;
    both)
        ENABLE_WEBRTC_STREAM=true
        ENABLE_VNC_STREAM=true
        ;;
    *)
        echo "[entrypoint] ❌ Invalid POPCORN_BROWSER_STREAMING_MODE: ${POPCORN_BROWSER_STREAMING_MODE}"
        exit 1
        ;;
esac

# Agones health is process liveness, not allocation readiness. Start pings before
# slower browser/TURN/bootstrap work so the sidecar does not retire the pod while
# Chromium is still coming up.
start_agones_health

k8s_get() {
    local path="$1"

    if [ ! -f "$K8S_TOKEN_FILE" ] || [ ! -f "$K8S_CA_FILE" ]; then
        echo "[entrypoint] ⚠️ Kubernetes service account credentials not available." >&2
        return 1
    fi

    local token
    token=$(cat "$K8S_TOKEN_FILE")

    curl -fsS \
        --cacert "$K8S_CA_FILE" \
        -H "Authorization: Bearer $token" \
        "$K8S_API$path"
}

configure_direct_webrtc() {
    if [ -z "${POD_NAMESPACE:-}" ] || [ -z "${POD_NAME:-}" ]; then
        echo "[entrypoint] ⚠️ POD_NAMESPACE or POD_NAME missing; skipping direct WebRTC configuration."
        return
    fi

    echo "[entrypoint] 🔍 Resolving Agones WebRTC UDP allocation for ${POD_NAMESPACE}/${POD_NAME}..."
    local gameserver_json
    if ! gameserver_json=$(k8s_get "/apis/agones.dev/v1/namespaces/${POD_NAMESPACE}/gameservers/${POD_NAME}"); then
        echo "[entrypoint] ⚠️ Failed to fetch GameServer ${POD_NAMESPACE}/${POD_NAME}; continuing with TURN fallback only."
        return
    fi

    local udp_port
    udp_port=$(echo "$gameserver_json" | jq -r '
        (
          [
            (.status.ports[]? | select(.name == "webrtc-udp") | (.port // .hostPort // .containerPort)),
            (.spec.ports[]? | select(.name == "webrtc-udp") | (.hostPort // .containerPort // .port))
          ] | map(select(. != null)) | .[0]
        ) // empty
    ')

    if [ -z "$udp_port" ]; then
        echo "[entrypoint] ⚠️ No allocated webrtc-udp port found on GameServer; continuing with TURN fallback only."
        return
    fi

    local node_candidate
    if [ -n "${POPCORN_WEBRTC_ADVERTISE_HOST:-}" ]; then
        node_candidate="$POPCORN_WEBRTC_ADVERTISE_HOST"
        echo "[entrypoint] ℹ️ Using configured WebRTC advertise host ${node_candidate}."
    fi

    if [ -z "$node_candidate" ]; then
        if [ -z "${NODE_NAME:-}" ]; then
            echo "[entrypoint] ⚠️ NODE_NAME missing; continuing with TURN fallback only."
            return
        fi

        echo "[entrypoint] 🔍 Resolving node address for ${NODE_NAME}..."
        local node_json
        if ! node_json=$(k8s_get "/api/v1/nodes/${NODE_NAME}"); then
            echo "[entrypoint] ⚠️ Failed to fetch Node ${NODE_NAME}; continuing with TURN fallback only."
            return
        fi

        node_candidate=$(echo "$node_json" | jq -r '
        (
          [
            (.status.addresses[]? | select(.type == "ExternalIP") | .address),
            (.status.addresses[]? | select(.type == "ExternalDNS") | .address)
          ] | map(select(. != null and . != "")) | .[0]
        ) // empty
        ')

        if [ -z "$node_candidate" ]; then
            node_candidate=$(echo "$gameserver_json" | jq -r '.status.address // empty')
            if [ -n "$node_candidate" ]; then
                echo "[entrypoint] ℹ️ Node ${NODE_NAME} has no ExternalIP/ExternalDNS; using GameServer address ${node_candidate} for local direct WebRTC."
            fi
        fi

        if [ -z "$node_candidate" ]; then
            node_candidate=$(echo "$node_json" | jq -r '
            (
              [
                (.status.addresses[]? | select(.type == "InternalIP") | .address),
                (.status.addresses[]? | select(.type == "Hostname") | .address)
              ] | map(select(. != null and . != "")) | .[0]
            ) // empty
            ')
            if [ -n "$node_candidate" ]; then
                echo "[entrypoint] ℹ️ Node ${NODE_NAME} has no ExternalIP/ExternalDNS; using node-internal address ${node_candidate} for local direct WebRTC."
            fi
        fi
    fi

    if [ -z "$node_candidate" ]; then
        echo "[entrypoint] ⚠️ Node ${NODE_NAME} has no usable WebRTC address; continuing with TURN fallback only."
        return
    fi

    export NEKO_UDPMUX="$udp_port"
    export NEKO_NAT1TO1="$node_candidate"

    echo "[entrypoint] ✅ Direct WebRTC candidate configured: external=${NEKO_NAT1TO1} udp_mux=${NEKO_UDPMUX}"
    echo "[entrypoint] ℹ️ WebRTC mode: direct+TURN fallback"
}

# 2. Register with Pool Manager (Legacy / Dynamic Mode) - SKIPPED FOR AGONES
# Fleet configuration provides NEKO_ICESERVERS via environment variables.

if [ "$ENABLE_WEBRTC_STREAM" = "true" ] && [ ! -z "$TURN_KEY_ID" ] && [ ! -z "$TURN_API_TOKEN" ]; then
    echo "🔄 Fetching TURN credentials from Cloudflare..."
    RESPONSE=$(curl -s -X POST \
        -H "Authorization: Bearer $TURN_API_TOKEN" \
        -H "Content-Type: application/json" \
        -d '{"ttl": 86400}' \
        "https://rtc.live.cloudflare.com/v1/turn/keys/$TURN_KEY_ID/credentials/generate-ice-servers")

    # Extract iceServers array from response
    GENERATED_ICE_SERVERS=$(echo "$RESPONSE" | jq -c '
        (.iceServers // [])
        | map(
            .urls |= (
                if type == "array" then
                    map(select(test(":53([/?]|$)") | not))
                elif type == "string" then
                    if test(":53([/?]|$)") then [] else [.] end
                else
                    []
                end
            )
        )
        | map(select((.urls | length) > 0))
    ')

    if [ "$GENERATED_ICE_SERVERS" != "null" ] && [ "$GENERATED_ICE_SERVERS" != "[]" ] && [ ! -z "$GENERATED_ICE_SERVERS" ]; then
        export NEKO_ICESERVERS="$GENERATED_ICE_SERVERS"
        echo "✅ NEKO_ICESERVERS configured dynamically from Cloudflare (filtered port 53 URLs)."
    else
        echo "❌ Failed to fetch TURN credentials. Response: $RESPONSE"
    fi
elif [ "$ENABLE_WEBRTC_STREAM" = "true" ]; then
    echo "⚠️  TURN_KEY_ID or TURN_API_TOKEN not set; skipping dynamic Cloudflare TURN configuration."
fi

if [ "$ENABLE_WEBRTC_STREAM" = "true" ]; then
    if [ -z "${NEKO_ICESERVERS}" ]; then
        echo "⚠️  NEKO_ICESERVERS not set. WebRTC might fail if not behind a NAT."
    else
        echo "❄️  NEKO_ICESERVERS found in environment."
    fi

    configure_direct_webrtc
    if [ -z "${NEKO_UDPMUX:-}" ] || [ -z "${NEKO_NAT1TO1:-}" ]; then
        echo "[entrypoint] ℹ️ WebRTC mode: TURN fallback only"
    fi
else
    echo "[entrypoint] ℹ️ Browser streaming mode: ${POPCORN_BROWSER_STREAMING_MODE}"
fi

# 4. Start wrapper (Chromium + Neko + Supervisord)
if [ "$ENABLE_WEBRTC_STREAM" = "true" ]; then
    export ENABLE_WEBRTC=true
else
    export ENABLE_WEBRTC=false
fi
if [ "$ENABLE_VNC_STREAM" = "true" ]; then
    export ENABLE_VNC=true
else
    export ENABLE_VNC=false
fi
# Fix Neko bind address and port to avoid conflicts (Agones SDK uses 8080)
sed -i "s/0.0.0.0:8080/:$PORT/g" /etc/supervisor/conf.d/services/neko.conf

echo "Starting wrapper..."
/wrapper.sh &
NEKO_PID=$!

# Cleanup handler
cleanup() {
    echo "[entrypoint] Cleaning up..."
    if [ ! -z "$AGONES_HEALTH_PID" ]; then
        kill $AGONES_HEALTH_PID
    fi
    agones_shutdown
    kill $NEKO_PID
}
trap cleanup TERM INT

wait_for_stream() {
    local name="$1"
    local port="$2"
    echo "[entrypoint] Waiting for ${name} to become ready on :${port}..."
    for i in {1..60}; do
        if curl -s "http://localhost:${port}" >/dev/null; then
            echo "[entrypoint] ✅ ${name} is reachable!"
            return 0
        fi
        sleep 1
    done
    echo "[entrypoint] ❌ ${name} did not become reachable on :${port} within 60s"
    return 1
}

if [ "$ENABLE_WEBRTC_STREAM" = "true" ]; then
    wait_for_stream "Neko" "$PORT" || {
        agones_shutdown
        kill "$NEKO_PID" 2>/dev/null || true
        exit 1
    }
fi

if [ "$ENABLE_VNC_STREAM" = "true" ]; then
    wait_for_stream "noVNC" 6080 || {
        agones_shutdown
        kill "$NEKO_PID" 2>/dev/null || true
        exit 1
    }
fi

# Signal Readiness and Start Health Pings
agones_ready

# 6. Wait for Neko to finish
echo "⏳ Waiting for Neko/Wrapper process ($NEKO_PID)..."
wait $NEKO_PID || {
    echo "❌ Wrapper exited with code $?"
    echo "😴 Sleeping 5min for debugging..."
    sleep 360
}
