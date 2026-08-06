#!/bin/sh
set -eu

image="popcorn-gateway-auth-test"
gateway_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
docker build -t "$image" "$gateway_dir" >/dev/null
docker run --rm --entrypoint /usr/local/openresty/bin/resty "$image" -e '
  local auth = require "auth"
  assert(auth.is_supported_algorithm({ valid = true, header = { alg = "RS256" } }))
  assert(not auth.is_supported_algorithm({ valid = true, header = { alg = "HS256" } }))
  assert(not auth.is_supported_algorithm({ valid = true, header = { alg = "none" } }))
  assert(not auth.is_supported_algorithm({ valid = false, header = { alg = "RS256" } }))
  assert(auth.is_route_bound_deadline_active("2000", 1999))
  assert(not auth.is_route_bound_deadline_active("2000", 2000))
  assert(not auth.is_route_bound_deadline_active("invalid", 1000))
'
