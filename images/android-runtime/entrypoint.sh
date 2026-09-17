#!/usr/bin/env bash
# Starts the Android session runtime.
#
# Kept deliberately thin: everything conditional lives in the Node process,
# where it can be tested. This exists to surface a missing /dev/kvm early and
# to make adb's own daemon someone's explicit responsibility.
set -euo pipefail

if [ ! -e /dev/kvm ]; then
  echo "[entrypoint] /dev/kvm is not present in this container." >&2
  echo "[entrypoint] The emulator will run under software CPU emulation and" >&2
  echo "[entrypoint] will be far too slow to serve a session. Schedule this" >&2
  echo "[entrypoint] pod on a nested-virtualization node and expose the" >&2
  echo "[entrypoint] device (see charts/android-fleet)." >&2
  if [ "${REQUIRE_KVM:-true}" = "true" ]; then
    echo "[entrypoint] Refusing to start. Set REQUIRE_KVM=false to override." >&2
    exit 1
  fi
fi

adb start-server >/dev/null 2>&1 || true
exec node /app/dist/index.js
