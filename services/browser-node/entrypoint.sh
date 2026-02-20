#!/bin/bash

# 0. SEV-SNP Attestation now handled by attestor sidecar
echo "🔒 Skipping legacy attestation..."

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


# 2. Register with Pool Manager (Legacy / Dynamic Mode) - SKIPPED FOR AGONES
# Fleet configuration provides NEKO_ICESERVERS via environment variables.

if [ ! -z "$TURN_KEY_ID" ] && [ ! -z "$TURN_API_TOKEN" ]; then
    echo "🔄 Fetching TURN credentials from Cloudflare..."
    RESPONSE=$(curl -s -X POST \
        -H "Authorization: Bearer $TURN_API_TOKEN" \
        -H "Content-Type: application/json" \
        -d '{"ttl": 86400}' \
        "https://rtc.live.cloudflare.com/v1/turn/keys/$TURN_KEY_ID/credentials/generate-ice-servers")

    # Extract iceServers array from response
    GENERATED_ICE_SERVERS=$(echo "$RESPONSE" | jq -c '.iceServers')

    if [ "$GENERATED_ICE_SERVERS" != "null" ] && [ ! -z "$GENERATED_ICE_SERVERS" ]; then
        export NEKO_ICESERVERS="$GENERATED_ICE_SERVERS"
        echo "✅ NEKO_ICESERVERS configured dynamically from Cloudflare."
    else
        echo "❌ Failed to fetch TURN credentials. Response: $RESPONSE"
    fi
fi

if [ -z "${NEKO_ICESERVERS}" ]; then
    echo "⚠️  NEKO_ICESERVERS not set. WebRTC might fail if not behind a NAT."
else
    echo "❄️  NEKO_ICESERVERS found in environment."
fi

# 4. Start Heartbeat Loop
echo "💓 Starting Heartbeat loop..."
(
    while true; do
        curl -s -X POST -H "Content-Type: application/json" -d "{\"name\":\"$HOSTNAME\"}" "$HEARTBEAT_URL" > /dev/null
        sleep 10
    done
) &

# 5. Start wrapper (Chromium + Neko + Supervisord)
export ENABLE_WEBRTC=true
# Fix Neko bind address and port to avoid conflicts (Agones SDK uses 8080)
sed -i "s/0.0.0.0:8080/:$PORT/g" /etc/supervisor/conf.d/services/neko.conf

echo "Starting wrapper..."
/wrapper.sh &
NEKO_PID=$!

# -----------------------------------------------------------------------------
# Agones SDK Integration (Restored)
# -----------------------------------------------------------------------------

# Function to mark GameServer as Ready
agones_ready() {
  echo "[entrypoint] 🎮 Signaling Agones: READY"
  curl -X POST http://localhost:9358/ready -d '{}' -H "Content-Type: application/json" || echo "[entrypoint] ⚠️ Failed to signal Agones Ready"
}

# Function to mark GameServer as Shutdown
agones_shutdown() {
  echo "[entrypoint] 🎮 Signaling Agones: SHUTDOWN"
  curl -X POST http://localhost:9358/shutdown -d '{}' -H "Content-Type: application/json" || echo "[entrypoint] ⚠️ Failed to signal Agones Shutdown"
}

# Health Check Loop (Background)
start_agones_health() {
  echo "[entrypoint] Starting Agones Health pings..."
  while true; do
    curl -X POST http://localhost:9358/health -d '{}' -H "Content-Type: application/json" >/dev/null 2>&1
    sleep 2
  done &
  AGONES_HEALTH_PID=$!
}

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

# Wait for Neko to serve HTTP (indicating readiness)
echo "[entrypoint] Waiting for Neko to become ready on :$PORT..."
for i in {1..60}; do
    if curl -s http://localhost:$PORT >/dev/null; then
        echo "[entrypoint] ✅ Neko is reachable!"
        break
    fi
    sleep 1
done

# Signal Readiness and Start Health Pings
agones_ready
start_agones_health

# 6. Wait for Neko to finish
echo "⏳ Waiting for Neko/Wrapper process ($NEKO_PID)..."
wait $NEKO_PID || {
    echo "❌ Wrapper exited with code $?"
    echo "😴 Sleeping 5min for debugging..."
    sleep 360
}
