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
fixtures=$(mktemp -d)
repo_dir=$(CDPATH= cd -- "$gateway_dir/../.." && pwd)

cleanup() {
  docker rm -f "$gateway" "$upstream" "$redis" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  rm -rf "$fixtures"
}
trap cleanup EXIT INT TERM

helm template gateway-test "$repo_dir/charts/platform" \
  -f "$gateway_dir/tests/fixtures/session-extension-values.yaml" \
  --set gateway.redisHost="$redis" > "$fixtures/rendered.yaml"
awk '/^  session-extension-routes.conf: \|/ {inside=1; next} inside && /^---/ {exit} inside {sub(/^    /, ""); print}' "$fixtures/rendered.yaml" > "$fixtures/routes.conf"

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
docker exec "$redis" redis-cli set "route:events:$session_id" "$upstream_ip:80" EX 120 >/dev/null

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
  -v "$fixtures/routes.conf:/usr/local/openresty/nginx/conf/session-routes/extensions.conf:ro" \
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
e2e_rfb_url="http://127.0.0.1:$host_port/liveview-e2e-rfb/$session_id/$token"
e2e_rfb_status=$(curl -sS -o /dev/null -w '%{http_code}' "$e2e_rfb_url")
test "$e2e_rfb_status" = "200"
e2e_control_url="http://127.0.0.1:$host_port/liveview-e2e-control/$session_id/$token"
e2e_control_status=$(curl -sS -o /dev/null -w '%{http_code}' "$e2e_control_url")
test "$e2e_control_status" = "200"
api_url="http://127.0.0.1:$host_port/api/$session_id/$internal_token/reclaim/prove"
api_status=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$api_url")
test "$api_status" = "200"

# Exercise the Helm-generated extension routes in the same gateway fixture.
base="http://127.0.0.1:$host_port"
extension="$base/session-events/$session_id/$token/identity?cursor=7"
credential=$(openssl rand -hex 32)
response=$(curl -fsS -H 'Last-Event-ID: 7' -H 'X-Popcorn-Session-Id: spoofed' -H 'X-Popcorn-Scope: internal' -H 'X-Popcorn-Expires-At: 9999999999999' -H "Authorization: Bearer $credential" "$extension")
test "$response" = "GET|/identity?cursor=7|7|$session_id|restricted|$future_deadline|Bearer $credential"
internal_expiry=$(TOKEN="$internal_token" bun -e 'console.log(JSON.parse(Buffer.from(process.env.TOKEN.split(".")[1],"base64url")).exp*1000)')
response=$(curl -fsS -X POST -H 'X-Popcorn-Scope: restricted' -H "Authorization: Bearer $credential" "$base/session-events-internal/$session_id/$internal_token/identity")
test "$response" = "POST|/identity||$session_id|internal|$internal_expiry|Bearer $credential"
for invalid_token in invalid "$internal_token" "${token%.*}.invalid"; do
  test "$(curl -sS -o /dev/null -w '%{http_code}' "$base/session-events/$session_id/$invalid_token/identity")" = 403
done
test "$(curl -sS -o /dev/null -w '%{http_code}' "$base/session-events-internal/$session_id/$token/identity")" = 403
test "$(curl -sS -o /dev/null -w '%{http_code}' "$base/session-events/another-session/$token/identity")" = 403

# Explicit JWT expiry caps the Redis access deadline; identity needs one of them.
make_token() {
  (cd "$pool_dir" && TOKEN_TTL="$1" TOKEN_ROUTE_BOUND="$2" bun -e '
    import jwt from "jsonwebtoken"; import { readFileSync } from "node:fs";
    const exp = process.env.TOKEN_TTL === "none" ? {} : {exp:Math.floor(Date.now()/1000)+Number(process.env.TOKEN_TTL)};
    console.log(jwt.sign({sub:"route_bound_test",scope:"restricted",...exp,...(process.env.TOKEN_ROUTE_BOUND === "true" ? {routeBound:true} : {})},readFileSync("keys/private.pem"),{algorithm:"RS256",noTimestamp:true}));
  ')
}
short_token=$(make_token 30 true)
short_expiry=$(TOKEN="$short_token" bun -e 'console.log(JSON.parse(Buffer.from(process.env.TOKEN.split(".")[1],"base64url")).exp*1000)')
response=$(curl -fsS "$base/session-events/$session_id/$short_token/identity")
test "$response" = "GET|/identity||$session_id|restricted|$short_expiry|"
for invalid_token in "$(make_token -60 false)" "$(make_token none false)"; do
  test "$(curl -sS -o /dev/null -w '%{http_code}' "$base/session-events/$session_id/$invalid_token/identity")" = 403
done
docker exec "$redis" redis-cli del "auth:route-bound:$session_id" >/dev/null
test "$(curl -sS -o /dev/null -w '%{http_code}' "$extension")" = 403

past_deadline=$(bun -e 'console.log(Date.now() - 1)')
docker exec "$redis" redis-cli set "auth:route-bound:$session_id" "$past_deadline" PX 60000 >/dev/null
# OpenResty's cached time is refreshed at event-loop boundaries. Give the
# worker one tick before asserting an immediately-past millisecond deadline.
sleep 1
expired_status=$(curl -sS -o /dev/null -w '%{http_code}' "$url")
test "$expired_status" = "403"
expired_e2e_status=$(curl -sS -o /dev/null -w '%{http_code}' "$e2e_rfb_url")
test "$expired_e2e_status" = "403"

extended_deadline=$(bun -e 'console.log(Date.now() + 120000)')
docker exec "$redis" redis-cli set "auth:route-bound:$session_id" "$extended_deadline" PX 120000 >/dev/null
extended_status=$(curl -sS -o /dev/null -w '%{http_code}' "$url")
test "$extended_status" = "200"

echo "route-bound gateway access: active=$active_status liveview=$liveview_status liveview_ws=$liveview_ws_status e2e_rfb=$e2e_rfb_status e2e_control=$e2e_control_status api=$api_status expired=$expired_status expired_e2e=$expired_e2e_status extended_same_url=$extended_status"
