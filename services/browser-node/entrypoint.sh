#!/bin/bash

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


# 2. Register with Pool Manager (Legacy / Dynamic Mode)
# If NEKO_ICESERVERS is allowed set (e.g. via Fleet Env), we skip this blocking step.
if [ -z "${NEKO_ICESERVERS}" ] || [ "${NEKO_ICESERVERS}" == "null" ]; then
    POOL_MANAGER_URL="http://pool-manager/register"
    HEARTBEAT_URL="http://pool-manager/heartbeat"
    JSON_PAYLOAD="{\"name\":\"$HOSTNAME\", \"url\":\"http://$MY_IP:$PORT\"}"

    echo "🔌 Registering to Pool Manager at $POOL_MANAGER_URL..."

    MAX_RETRIES=150 # 150 * 2s = 300s (5 minutes)
    count=0
    REGISTER_SUCCESS=false
    ICE_SERVERS=""

    while [ $count -lt $MAX_RETRIES ]; do
      RESPONSE=$(curl -s -X POST -H "Content-Type: application/json" -d "$JSON_PAYLOAD" "$POOL_MANAGER_URL")
      
      if [ $? -eq 0 ] && [ ! -z "$RESPONSE" ]; then
          # Check if response contains iceServers
          if echo "$RESPONSE" | grep -q "iceServers"; then
              echo "✅ Registered! Response: $RESPONSE"
              ICE_SERVERS=$(echo "$RESPONSE" | jq -c '.iceServers')
              echo "🧊 Received ICE Servers: $ICE_SERVERS"
              REGISTER_SUCCESS=true
              break
          # Check for Agones signal
          elif echo "$RESPONSE" | grep -q "managed-by-agones"; then
              echo "🎮 Pool Manager says we are managed by Agones. Skipping registration loop."
              REGISTER_SUCCESS=true
              break
          else 
              echo "⚠️  Registration returned unexpected response: $RESPONSE"
          fi
      else
          echo "⏳ Waiting for Pool Manager ($count/$MAX_RETRIES)..."
      fi
      
      sleep 2
      count=$((count + 1))
    done

    if [ "$REGISTER_SUCCESS" = false ]; then
        echo "❌ Failed to register with Pool Manager after 300s. Exiting."
        exit 1
    fi

    # 3. Export ICE Servers for Neko
    if [ ! -z "$ICE_SERVERS" ] && [ "$ICE_SERVERS" != "null" ]; then
        echo "❄️  Setting NEKO_ICESERVERS from Pool Manager..."
        export NEKO_ICESERVERS="$ICE_SERVERS"
    else
        echo "⚠️  No ICE Servers received from Pool Manager."
    fi
else
    echo "❄️  NEKO_ICESERVERS already set in environment. Skipping registration."
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
    echo "😴 Sleeping 1h for debugging..."
    sleep 3600
}
