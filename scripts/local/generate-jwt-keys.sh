#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PRIVATE_KEY="${LOCAL_JWT_PRIVATE_KEY:-$ROOT_DIR/services/pool-manager/keys/private.pem}"
PUBLIC_KEY="${LOCAL_JWT_PUBLIC_KEY:-$ROOT_DIR/services/gateway/keys/public.pem}"

if ! command -v openssl >/dev/null 2>&1; then
  echo "error: openssl is required to generate local JWT keys" >&2
  exit 1
fi

mkdir -p "$(dirname "$PRIVATE_KEY")" "$(dirname "$PUBLIC_KEY")"

write_public_key() {
  openssl rsa -in "$PRIVATE_KEY" -pubout -out "$PUBLIC_KEY" >/dev/null 2>&1
  chmod 0644 "$PUBLIC_KEY"
}

if [[ ! -f "$PRIVATE_KEY" ]]; then
  echo "Generating local JWT key pair..."
  umask 077
  openssl genrsa -out "$PRIVATE_KEY" 2048 >/dev/null 2>&1
  chmod 0600 "$PRIVATE_KEY"
  write_public_key
  echo "Wrote $PRIVATE_KEY"
  echo "Wrote $PUBLIC_KEY"
  exit 0
fi

if ! openssl rsa -in "$PRIVATE_KEY" -check -noout >/dev/null 2>&1; then
  echo "error: existing local JWT private key is not a valid RSA key: $PRIVATE_KEY" >&2
  exit 1
fi

if [[ ! -f "$PUBLIC_KEY" ]]; then
  echo "Deriving local JWT public key from existing private key..."
  write_public_key
  echo "Wrote $PUBLIC_KEY"
  exit 0
fi

TMP_PUBLIC="$(mktemp)"
trap 'rm -f "$TMP_PUBLIC"' EXIT
openssl rsa -in "$PRIVATE_KEY" -pubout -out "$TMP_PUBLIC" >/dev/null 2>&1

if cmp -s "$TMP_PUBLIC" "$PUBLIC_KEY"; then
  echo "Local JWT keys already exist."
else
  echo "Refreshing local JWT public key to match existing private key..."
  cp "$TMP_PUBLIC" "$PUBLIC_KEY"
  chmod 0644 "$PUBLIC_KEY"
  echo "Wrote $PUBLIC_KEY"
fi
