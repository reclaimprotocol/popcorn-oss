#!/bin/sh
set -eu

gateway_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
test_id="popcorn-gateway-response-identity-$$"
network="$test_id-network"
upstream="$test_id-upstream"
gateway="$test_id-gateway"
image="$test_id-image"
key_file=$(mktemp)

cleanup() {
  docker rm -f "$gateway" "$upstream" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  rm -f "$key_file"
}
trap cleanup EXIT INT TERM

printf 'test public key\n' > "$key_file"
docker build -t "$image" "$gateway_dir" >/dev/null
docker network create "$network" >/dev/null
docker run -d --name "$upstream" --network "$network" \
  -v "$gateway_dir/tests/response-identity-upstream.conf:/etc/nginx/conf.d/default.conf:ro" \
  nginx:alpine >/dev/null
docker run -d --name "$gateway" --network "$network" \
  -e GATEWAY_REDIS_HOST=127.0.0.1 \
  -e GATEWAY_POOL_MANAGER_HOST="$upstream" \
  -v "$key_file:/etc/nginx/certs/public.pem:ro" \
  -p "127.0.0.1::80" "$image" >/dev/null

host_port=$(docker port "$gateway" 80/tcp | sed 's/.*://')
python3 - "$host_port" "$gateway" <<'PY'
import http.client
import subprocess
import sys
import time

port = int(sys.argv[1])


def check(path, expected_status, host=None, gateway_error=False, method="GET", extra_headers=None):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    headers = {"Host": host} if host is not None else {}
    headers.update(extra_headers or {})
    connection.request(method, path, headers=headers)
    response = connection.getresponse()
    body = response.read().decode(errors="replace")
    assert response.status == expected_status, (path, response.status, body)
    assert not any(name.lower() == "server" for name, _ in response.getheaders())
    assert "openresty" not in body.lower()
    if gateway_error:
        assert body == "Request failed.\n", (path, body)
    connection.close()


for attempt in range(10):
    try:
        check("/health", 200)
        break
    except OSError:
        if attempt == 9:
            raise
        time.sleep(1)

for attempt in range(10):
    try:
        check("/", 200)
        break
    except AssertionError:
        if attempt == 9:
            raise
        time.sleep(1)
check("/liveview/demo/invalid/", 403, gateway_error=True)
check("/liveview/demo/invalid-secret/?query-secret=hidden", 403, gateway_error=True, method="POST")
check("/health?query-secret=hidden", 200)
check("/health", 400, host="", gateway_error=True)
check("/health", 400, gateway_error=True, extra_headers={"X-Oversized": "x" * 16384})
check("/upstream-close", 502, gateway_error=True)
logs = subprocess.run(["docker", "logs", sys.argv[2]], check=True, capture_output=True, text=True).stdout
assert '"POST /liveview/demo/[REDACTED]/ HTTP/1.1" 403' in logs, logs
assert '"GET /health HTTP/1.1" 200' in logs, logs
assert "invalid-secret" not in logs and "query-secret" not in logs, logs
print("gateway responses hide OpenResty on success and error paths")
PY
