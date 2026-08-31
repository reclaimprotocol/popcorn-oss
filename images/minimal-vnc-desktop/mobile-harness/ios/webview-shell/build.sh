#!/usr/bin/env bash
# Builds the harness WebView shell app for the iOS Simulator straight from the
# command-line toolchain. There is no Xcode project and no xcodebuild: one
# Info.plist, two Swift files, one swiftc call.
#
# Requirements: Xcode with the iOS Simulator SDK (the harness already needs it
# for WebDriverAgent).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
build="${OUTPUT_DIR:-$here/build}"
name="PopcornWebViewShell"
app="$build/$name.app"

MIN_IOS="${MIN_IOS:-16.0}"
SWIFT_VERSION="${SWIFT_VERSION:-5}"

fail() { echo "webview-shell: $*" >&2; exit 1; }

command -v xcrun >/dev/null 2>&1 || fail "xcrun not found; install Xcode and run xcode-select --switch"
sdk="${IPHONESIMULATOR_SDK:-$(xcrun --show-sdk-path --sdk iphonesimulator 2>/dev/null || true)}"
[ -n "$sdk" ] && [ -d "$sdk" ] || fail "iOS Simulator SDK not found; install Xcode (not just the Command Line Tools)"

case "${ARCH:-$(uname -m)}" in
  arm64) arch=arm64 ;;
  x86_64) arch=x86_64 ;;
  *) fail "unsupported host architecture $(uname -m)" ;;
esac

echo "webview-shell: sdk=$(basename "$sdk") target=$arch-apple-ios$MIN_IOS-simulator swift=$SWIFT_VERSION"

rm -rf "$build"
mkdir -p "$app"

xcrun swiftc \
  -sdk "$sdk" \
  -target "$arch-apple-ios$MIN_IOS-simulator" \
  -swift-version "$SWIFT_VERSION" \
  -O -whole-module-optimization \
  -module-name "$name" \
  -Xclang-linker -isysroot -Xclang-linker "$sdk" \
  -o "$app/$name" \
  "$here/Sources/ShellApp.swift" "$here/Sources/main.swift"

cp "$here/Info.plist" "$app/Info.plist"
plutil -lint "$app/Info.plist" >/dev/null

# Simulator builds do not need a real identity, but an ad-hoc signature keeps
# simctl install quiet across Xcode versions.
codesign --force --sign - --timestamp=none "$app" >/dev/null 2>&1 \
  || echo "webview-shell: ad-hoc codesign skipped" >&2

echo "webview-shell: built $app"
xcrun simctl help install >/dev/null 2>&1 && cat <<INSTALL
webview-shell: install and launch by hand with
  xcrun simctl install <udid> "$app"
  xcrun simctl openurl <udid> 'popcorn-shell://open?url=<percent-encoded-url>'
INSTALL
