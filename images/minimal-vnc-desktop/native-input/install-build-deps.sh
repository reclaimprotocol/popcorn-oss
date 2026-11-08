#!/usr/bin/env bash
set -euo pipefail

version=$(sed -n 's/^tigervnc-standalone-server=//p' /build/apt-packages.txt)
test -n "$version"

# Use the same signed Ubuntu snapshot and source version as the base image.
snapshot="${UBUNTU_SNAPSHOT:-$(sed -n 's/^UBUNTU_SNAPSHOT=//p' /build/ubuntu-snapshot.lock)}"
test -n "$snapshot"
rm -f /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources
printf '%s\n' \
  "deb https://snapshot.ubuntu.com/ubuntu/$snapshot/ jammy main restricted universe multiverse" \
  "deb https://snapshot.ubuntu.com/ubuntu/$snapshot/ jammy-updates main restricted universe multiverse" \
  "deb https://snapshot.ubuntu.com/ubuntu/$snapshot/ jammy-backports main restricted universe multiverse" \
  "deb https://snapshot.ubuntu.com/ubuntu/$snapshot/ jammy-security main restricted universe multiverse" \
  > /etc/apt/sources.list
printf 'Acquire::Check-Valid-Until "false";\nAcquire::Retries "3";\n' > /etc/apt/apt.conf.d/99snapshot
sed -n 's/^deb /deb-src /p' /etc/apt/sources.list > /etc/apt/sources.list.d/popcorn-source.list
apt-get update
apt-get -y --no-install-recommends install build-essential dpkg-dev python3
apt-get -y --no-install-recommends build-dep "tigervnc=$version"
cd /build
apt-get source "tigervnc=$version"
