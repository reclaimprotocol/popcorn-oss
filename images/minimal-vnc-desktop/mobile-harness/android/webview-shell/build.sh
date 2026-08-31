#!/usr/bin/env bash
# Builds the harness WebView shell APK straight from the Android SDK build tools.
# There is no Gradle and no Android Gradle Plugin: one manifest, one Java file,
# aapt2 -> javac -> d8 -> zipalign -> apksigner.
#
# Requirements: a real JDK (17 or newer), Android SDK platform + build-tools,
# and zip. Override any of the environment variables below to pin versions.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
build="${OUTPUT_DIR:-$here/build}"
apk="$build/popcorn-webview-shell.apk"

MIN_SDK="${MIN_SDK:-24}"
TARGET_SDK="${TARGET_SDK:-34}"
JAVA_TARGET="${JAVA_TARGET:-17}"
VERSION_CODE="${VERSION_CODE:-1}"
VERSION_NAME="${VERSION_NAME:-0.1.0}"

fail() { echo "webview-shell: $*" >&2; exit 1; }

sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
[ -d "$sdk" ] || fail "Android SDK not found at $sdk. Install it and set ANDROID_HOME (macOS: brew install --cask android-commandlinetools)"

# Newest build-tools and platform unless pinned.
pick_newest() { ls -1 "$1" 2>/dev/null | sort -V | tail -1; }
build_tools_version="${BUILD_TOOLS_VERSION:-$(pick_newest "$sdk/build-tools")}"
[ -n "$build_tools_version" ] || fail "no build-tools under $sdk/build-tools (sdkmanager 'build-tools;34.0.0')"
build_tools="$sdk/build-tools/$build_tools_version"

platform_version="${PLATFORM_VERSION:-$(pick_newest "$sdk/platforms")}"
android_jar="${ANDROID_JAR:-$sdk/platforms/$platform_version/android.jar}"
[ -f "$android_jar" ] || fail "no android.jar at $android_jar (sdkmanager 'platforms;android-34')"

javac_bin="${JAVA_HOME:+$JAVA_HOME/bin/}javac"
keytool_bin="${JAVA_HOME:+$JAVA_HOME/bin/}keytool"
command -v "$javac_bin" >/dev/null 2>&1 || fail "javac not found. Install a JDK 17+ and set JAVA_HOME (macOS: brew install --cask temurin@21)"
"$javac_bin" -version >/dev/null 2>&1 || fail "javac at $javac_bin is not a working JDK. Install a JDK 17+ and set JAVA_HOME"
command -v zip >/dev/null 2>&1 || fail "zip is required to add classes.dex to the linked APK"

for tool in aapt2 d8 zipalign apksigner; do
  [ -x "$build_tools/$tool" ] || fail "$tool missing from $build_tools"
done

echo "webview-shell: sdk=$sdk build-tools=$build_tools_version platform=$platform_version java-target=$JAVA_TARGET"

rm -rf "$build"
mkdir -p "$build/classes" "$build/dex"

# 1. Resources: the shell has none, so link the manifest alone and inject the
#    SDK levels and version here rather than hard-coding them in the manifest.
"$build_tools/aapt2" link \
  -o "$build/linked.apk" \
  -I "$android_jar" \
  --manifest "$here/AndroidManifest.xml" \
  --min-sdk-version "$MIN_SDK" \
  --target-sdk-version "$TARGET_SDK" \
  --version-code "$VERSION_CODE" \
  --version-name "$VERSION_NAME"

# 2. Compile against android.jar only.
find "$here/java" -name '*.java' -print0 | xargs -0 "$javac_bin" \
  -nowarn -Xlint:-options \
  -source "$JAVA_TARGET" -target "$JAVA_TARGET" \
  -classpath "$android_jar" \
  -d "$build/classes"

# 3. Dex.
find "$build/classes" -name '*.class' -print0 | xargs -0 "$build_tools/d8" \
  --release --min-api "$MIN_SDK" --lib "$android_jar" --output "$build/dex"

# 4. classes.dex belongs at the APK root.
cp "$build/linked.apk" "$build/unsigned.apk"
(cd "$build/dex" && zip -q -j "$build/unsigned.apk" classes.dex)

# 5. Align, then sign. A local debug keystore is generated once; override with
#    KEYSTORE/KEYSTORE_PASS/KEY_ALIAS to sign with your own key.
"$build_tools/zipalign" -f -p 4 "$build/unsigned.apk" "$build/aligned.apk"

# The signing key lives outside the build directory on purpose: it is generated
# once and reused, so a rebuilt APK can still upgrade an installed copy instead
# of failing with INSTALL_FAILED_UPDATE_INCOMPATIBLE.
signing="${SIGNING_DIR:-$here/.signing}"
mkdir -p "$signing"
keystore="${KEYSTORE:-$signing/debug.keystore}"
keystore_pass="${KEYSTORE_PASS:-android}"
key_alias="${KEY_ALIAS:-popcorn-harness}"
if [ ! -f "$keystore" ]; then
  echo "webview-shell: generating local signing key $keystore"
  "$keytool_bin" -genkeypair -v \
    -keystore "$keystore" -storepass "$keystore_pass" -keypass "$keystore_pass" \
    -alias "$key_alias" -keyalg RSA -keysize 2048 -validity 10000 \
    -dname 'CN=Popcorn Harness WebView Shell, OU=Harness, O=Popcorn, C=US' >/dev/null
fi

"$build_tools/apksigner" sign \
  --ks "$keystore" --ks-pass "pass:$keystore_pass" --key-pass "pass:$keystore_pass" \
  --ks-key-alias "$key_alias" \
  --out "$apk" "$build/aligned.apk"
"$build_tools/apksigner" verify "$apk"

rm -f "$build/linked.apk" "$build/unsigned.apk" "$build/aligned.apk" "$apk.idsig"
echo "webview-shell: built $apk"
shasum -a 256 "$apk" 2>/dev/null || sha256sum "$apk"
