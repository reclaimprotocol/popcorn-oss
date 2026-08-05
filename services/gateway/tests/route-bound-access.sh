#!/bin/sh
set -eu

gateway_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
pool_dir=$(CDPATH= cd -- "$gateway_dir/../pool-manager" && pwd)
test_id="popcorn-route-bound-$$"
network="$test_id-network"
redis="$test_id-redis"
upstream="$test_id-upstream"
gateway="$test_id-gateway"
image="popcorn-gateway-route-bound-test"
session_id="route_bound_test"

cleanup() {
  docker rm -f "$gateway" "$upstream" "$redis" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker build -t "$image" "$gateway_dir" >/dev/null
docker network create "$network" >/dev/null
docker run -d --name "$redis" --network "$network" redis:7-alpine >/dev/null
docker run -d --name "$upstream" --network "$network" \
  -v "$gateway_dir/tests/route-bound-upstream.conf:/etc/nginx/conf.d/default.conf:ro" \
  nginx:alpine >/dev/null

upstream_ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$upstream")
redis_ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$redis")
docker exec "$redis" redis-cli set "route:$session_id" "$upstream_ip:80" EX 120 >/dev/null
docker exec "$redis" redis-cli set "route:liveview:$session_id" "$upstream_ip:80" EX 120 >/dev/null
docker exec "$redis" redis-cli set "route:api:$session_id" "$upstream_ip:80" EX 120 >/dev/null

token=$(cd "$pool_dir" && bun -e '
  import { Auth } from "./src/services/auth.ts";
  console.log(Auth.signToken("route_bound_test", "restricted", undefined, true));
' | tail -n 1)
internal_token=$(cd "$pool_dir" && bun -e '
  import { Auth } from "./src/services/auth.ts";
  console.log(Auth.signToken("route_bound_test", "internal"));
' | tail -n 1)

docker run -d --name "$gateway" --network "$network" \
  -e GATEWAY_REDIS_HOST="$redis_ip" \
  -e GATEWAY_POOL_MANAGER_HOST="$upstream" \
  -v "$gateway_dir/keys/public.pem:/etc/nginx/certs/public.pem:ro" \
  -p "127.0.0.1::80" \
  "$image" >/dev/null

host_port=$(docker port "$gateway" 80/tcp | sed 's/.*://')
url="http://127.0.0.1:$host_port/browser-test/$session_id/$token/"
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  curl -sS -o /dev/null "$url" >/dev/null 2>&1 && break
  sleep 1
done

future_deadline=$(bun -e 'console.log(Date.now() + 60000)')
docker exec "$redis" redis-cli set "auth:route-bound:$session_id" "$future_deadline" PX 60000 >/dev/null
active_status=$(curl -sS -o /dev/null -w '%{http_code}' "$url")
test "$active_status" = "200"
liveview_url="http://127.0.0.1:$host_port/liveview/$session_id/$token/liveview.html?resize=scale&reconnect=1&reconnect_delay=2000"
liveview_status=$(curl -sS -o /dev/null -w '%{http_code}' "$liveview_url")
test "$liveview_status" = "200"
liveview_ws_url="http://127.0.0.1:$host_port/liveview-ws/$session_id/$token"
liveview_ws_status=$(curl -sS -o /dev/null -w '%{http_code}' "$liveview_ws_url")
test "$liveview_ws_status" = "200"
api_url="http://127.0.0.1:$host_port/api/$session_id/$internal_token/reclaim/prove"
api_status=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$api_url")
test "$api_status" = "200"

past_deadline=$(bun -e 'console.log(Date.now() - 1)')
docker exec "$redis" redis-cli set "auth:route-bound:$session_id" "$past_deadline" PX 60000 >/dev/null
expired_status=$(curl -sS -o /dev/null -w '%{http_code}' "$url")
test "$expired_status" = "403"

extended_deadline=$(bun -e 'console.log(Date.now() + 120000)')
docker exec "$redis" redis-cli set "auth:route-bound:$session_id" "$extended_deadline" PX 120000 >/dev/null
extended_status=$(curl -sS -o /dev/null -w '%{http_code}' "$url")
test "$extended_status" = "200"

echo "route-bound gateway access: active=$active_status liveview=$liveview_status liveview_ws=$liveview_ws_status api=$api_status expired=$expired_status extended_same_url=$extended_status"
