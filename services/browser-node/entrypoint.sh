#!/bin/bash
# Remove set -e to prevent grep failures from killing the script
# set -e 

echo "🔍 Debugging Supervisor Config:"
ls -R /etc/supervisor
echo "--------------------------------"

# 1. Start wrapper (Chromium + Neko + Supervisord)
export ENABLE_WEBRTC=true
echo "Starting wrapper..."
/docker-wrapper.sh &
NEKO_PID=$!

# 2. Register with Redis
# Wait for Neko to be ready
echo "⏳ Waiting 5s for network..."
sleep 5

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
echo "🔌 Registering $MY_IP:$PORT to Redis at $REDIS_HOST..."

# Redis register loop
JSON_PAYLOAD="{\"name\":\"$HOSTNAME\", \"url\":\"http://$MY_IP:$PORT\"}"

# Use a loop that doesn't exit on failure
count=0
while [ $count -lt 30 ]; do
  if redis-cli -h "$REDIS_HOST" -p 6379 LPUSH idle_pods "$JSON_PAYLOAD" > /dev/null 2>&1; then
      echo "✅ Registered! Ready for sessions."
      break
  fi
  echo "⏳ Waiting for Redis ($count/30)..."
  sleep 2
  count=$((count + 1))
done

if [ $count -ge 30 ]; then
    echo "❌ Failed to register with Redis after 60s."
fi

# 3. Wait for Neko to finish
echo "⏳ Waiting for Neko/Wrapper process ($NEKO_PID)..."
wait $NEKO_PID || {
    echo "❌ Wrapper exited with code $?"
    echo "😴 Sleeping 1h for debugging..."
    sleep 3600
}
