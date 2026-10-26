#!/usr/bin/env bash
set -euo pipefail

version=$(sed -n 's/^tigervnc-standalone-server=//p' /build/apt-packages.txt)
test -n "$version"

cd /build
set -- /build/tigervnc-*/debian/rules
test "$#" -eq 1
cd "${1%/debian/rules}"
cp /build/tigervnc-device-types.patch debian/patches/popcorn-device-types.patch
printf '\npopcorn-device-types.patch\n' >> debian/patches/series

# Keep the modified package distinguishable from the unmodified Ubuntu build.
python3 - "$version" "${SOURCE_DATE_EPOCH:-0}" <<'PY'
import datetime, email.utils, pathlib, sys
version, epoch = sys.argv[1:]
date = email.utils.format_datetime(datetime.datetime.fromtimestamp(int(epoch), datetime.timezone.utc))
path = pathlib.Path('debian/changelog')
entry = f'''tigervnc ({version}+popcorn1) jammy; urgency=medium

  * Declare the native VNC pointer and keyboard XInput device types.

 -- Popcorn build <build@localhost>  {date}

'''
path.write_text(entry + path.read_text())
PY

# The package's source-unification prerequisites race under top-level -j.
# Keep compilation serial too: GCC LTO can inherit unusable jobserver FDs.
DEB_BUILD_OPTIONS=parallel=1 MAKEFLAGS=-j1 dpkg-buildpackage --build=binary --no-sign
mkdir -p /out
arch=$(dpkg --print-architecture)
for package in tigervnc-common tigervnc-standalone-server; do
  set -- "/build/${package}_"*"_${arch}.deb"
  test "$#" -eq 1 && test -f "$1"
  cp "$1" /out/
done
cp /build/tigervnc-device-types.patch /out/
dpkg-parsechangelog -S Version > /out/version
