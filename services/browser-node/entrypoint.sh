#!/bin/bash
# Remove set -e to prevent grep failures from killing the script
# set -e 

echo "🔍 Debugging Supervisor Config:"
ls -R /etc/supervisor
echo "--------------------------------"

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

if [ -z "${NEKO_NAT1TO1}" ]; then
  export NEKO_NAT1TO1=$MY_IP
fi
PORT=8080

echo "🌍 My IP is: $MY_IP"

# 2. Register with Pool Manager (Retry Logic)
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
      # Check if response contains iceServers (simple check)
      if echo "$RESPONSE" | grep -q "iceServers"; then
          echo "✅ Registered! Response: $RESPONSE"
          ICE_SERVERS=$(echo "$RESPONSE" | jq -c '.iceServers')
          echo "🧊 Received ICE Servers: $ICE_SERVERS"
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
echo "Starting wrapper..."
/docker-wrapper.sh &
NEKO_PID=$!

# 6. Wait for Neko to finish
echo "⏳ Waiting for Neko/Wrapper process ($NEKO_PID)..."
wait $NEKO_PID || {
    echo "❌ Wrapper exited with code $?"
    echo "😴 Sleeping 1h for debugging..."
    sleep 3600
}
