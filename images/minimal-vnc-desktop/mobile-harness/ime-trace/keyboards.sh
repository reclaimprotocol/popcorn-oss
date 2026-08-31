#!/usr/bin/env bash
# keyboards.sh — fetch, verify, install and select Android IMEs for IME testing.
#
# Android never tells a page which keyboard is running, so the only way to know
# the viewer survives a given IME is to install it and drive it. This gets the
# keyboards onto the device with provenance you can actually check.
#
# TWO CLASSES OF KEYBOARD, and they are not equally automatable:
#
#   OSS (F-Droid)  — fetched and installed with no interaction. `fetch-oss`.
#   Proprietary    — SwiftKey, Grammarly, Facemoji, Chrooma, Yandex. These ship
#                    only through Play. APKMirror answers 403 to every scripted
#                    request (Cloudflare); defeating that is against their terms,
#                    so this script does not try. Download in a browser, drop the
#                    file in ./apk-drop/, and `install-drop` verifies and installs.
#
# WHAT MAKES A MIRRORED APK SAFE is not where it came from, it is who signed it.
# Every install path here prints the signing certificate SHA-256 and pins it in
# keyboards.lock on first sight; a later build signed by a different key fails
# loudly instead of installing. Compare a first-sight fingerprint against the
# publisher before trusting it — this script cannot know Microsoft's key for you.
#
# Usage:
#   ./keyboards.sh list                 installed IMEs, versions, active one
#   ./keyboards.sh fetch-oss            download + install every F-Droid keyboard
#                                       (and Fennec/Firefox, for the Gecko path)
#   ./keyboards.sh install-drop         verify + install everything in ./apk-drop
#   ./keyboards.sh verify <apk>         print sha256 + signer fingerprint only
#   ./keyboards.sh select <ime-id>      make one active (use the id from `list`)
#   ./keyboards.sh play <package>       open its Play page on the device to install
#   ./keyboards.sh reset                re-select Gboard
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DROP="$HERE/apk-drop"
CACHE="$HERE/.apk-cache"
LOCK="$HERE/keyboards.lock"
SERIAL="${ANDROID_SERIAL:-$(adb devices | awk 'NR>1 && $2=="device"{print $1; exit}')}"
[ -n "$SERIAL" ] || { echo "no adb device"; exit 1; }
ADB=(adb -s "$SERIAL")

# apksigner reads the v2/v3 signing block but needs a JRE, which this host does
# not have. openssl can read the v1 (JAR) certificate straight out of the zip
# with no Java at all, and that certificate is the same publisher identity — good
# enough to pin against. An APK signed ONLY with v2/v3 has no META-INF cert, and
# signer_fp reports `unknown` for it rather than inventing a value.
APKSIGNER="$(ls /opt/homebrew/share/android-commandlinetools/build-tools/*/apksigner 2>/dev/null | tail -1)"
command -v java >/dev/null 2>&1 || APKSIGNER=""

# F-Droid keyboards. OpenBoard and FlorisBoard are the AOSP-LatinIME-lineage
# entries; Unexpected Keyboard and Hacker's Keyboard both expose arrows and
# modifiers, which is the caret-key path most soft keyboards cannot reach.
OSS_PACKAGES=(
  org.pocketworkstation.pckeyboard        # Hacker's Keyboard — arrows, Ctrl, Esc
  rkr.simplekeyboard.inputmethod          # Simple Keyboard — AOSP-derived, minimal
  org.dslul.openboard.inputmethod.latin   # OpenBoard — AOSP LatinIME fork
  com.menny.android.anysoftkeyboard       # AnySoftKeyboard
  dev.patrickgold.florisboard             # FlorisBoard
  juloo.keyboard2                         # Unexpected Keyboard — arrows, modifiers
  org.smc.inputmethod.indic               # Indic Keyboard — Devanagari/Tamil/Bengali/Malayalam
)

# Browsers worth testing alongside the keyboards: the ENGINE decides which input
# path runs. Fennec is Firefox's F-Droid build, so the Gecko path (which has its
# own branch in kbd/kbd-detect.js) is reachable without Play.
OSS_BROWSERS=(
  org.mozilla.fennec_fdroid                 # Firefox / Gecko — no EditContext, vk=0
)

# Proprietary, Play-only. Listed so `list` can report them as absent rather than
# silently omitting them from a matrix.
PLAY_PACKAGES=(
  com.touchtype.swiftkey                  # Microsoft SwiftKey
  com.grammarly.android.keyboard          # Grammarly Keyboard
  ru.yandex.androidkeyboard               # Yandex Keyboard
  com.sec.android.inputmethod             # Samsung Keyboard (Samsung hardware only)
  com.touchtalent.bobbleapp               # Bobble AI — large share in India
  com.simejikeyboard                      # Facemoji Keyboard
)

sha256() { shasum -a 256 "$1" | awk '{print $1}'; }

# The package id as the APK declares it — NOT the filename. A mirror renames
# freely, and a pin keyed on the filename silently re-pins instead of comparing
# the signer, which is the whole point of the lock file.
pkg_id() {
  local out
  out="$(aapt2 dump packagename "$1" 2>/dev/null | tr -d '\r')"
  [ -n "$out" ] || out="$(ls /opt/homebrew/share/android-commandlinetools/build-tools/*/aapt2 2>/dev/null | tail -1 \
      | xargs -I{} {} dump packagename "$1" 2>/dev/null | tr -d '\r')"
  [ -n "$out" ] || out="$(unzip -p "$1" AndroidManifest.xml 2>/dev/null | strings \
      | grep -oE '^[a-z][a-z0-9_]*(\.[a-z0-9_]+){2,}$' | head -1)"
  printf '%s' "${out:-$(basename "$1" | sed 's/_.*//')}"
}

# The signing certificate digest, which is the identity that survives mirroring.
signer_fp() {
  local apk="$1" fp=""
  if [ -x "${APKSIGNER:-}" ]; then
    fp="$("$APKSIGNER" verify --print-certs "$apk" 2>/dev/null \
          | awk -F': ' '/SHA-256 digest/{print $2; exit}' | tr -d ' ' | head -c 64)"
  fi
  if [ -z "$fp" ]; then
    local cert; cert="$(unzip -l "$apk" 2>/dev/null \
      | awk '{print $4}' | grep -iE '^META-INF/.*\.(RSA|DSA|EC)$' | head -1)"
    if [ -n "$cert" ]; then
      fp="$(unzip -p "$apk" "$cert" 2>/dev/null \
        | openssl pkcs7 -inform DER -print_certs 2>/dev/null \
        | openssl x509 -noout -fingerprint -sha256 2>/dev/null \
        | sed 's/.*=//; s/://g' | tr 'A-F' 'a-f')"
    fi
  fi
  printf '%s' "${fp:-unknown}"
}

# Trust-on-first-use: record a signer once, then refuse anything signed by a
# different key. Catches a re-hosted or repackaged build on the SECOND fetch,
# which is when a mirror is most likely to have drifted.
pin_or_fail() {
  local pkg="$1" fp="$2"
  if [ -z "$fp" ] || [ "$fp" = "unknown" ]; then
    echo "    could not read a signing certificate — NOT pinning, NOT installing"
    echo "    (v2/v3-only APK and no JRE for apksigner; install a JDK to verify)"
    return 1
  fi
  touch "$LOCK"
  local known; known="$(awk -v p="$pkg" '$1==p{print $2}' "$LOCK" | head -1)"
  if [ -z "$known" ]; then
    printf '%s %s\n' "$pkg" "$fp" >> "$LOCK"
    echo "    signer PINNED (first sight): $fp"
    echo "    ^ verify this against the publisher before trusting the app"
  elif [ "$known" != "$fp" ]; then
    echo "    SIGNER MISMATCH for $pkg"
    echo "      pinned: $known"
    echo "      got:    $fp"
    return 1
  else
    echo "    signer matches pin"
  fi
}

install_apk() {
  local apk="$1" pkg
  pkg="$("${ADB[@]}" shell pm 2>/dev/null >/dev/null; echo)"
  pkg="$(basename "$apk" .apk)"
  echo "  $(basename "$apk")"
  echo "    sha256 $(sha256 "$apk")"
  local fp; fp="$(signer_fp "$apk")"
  echo "    signer $fp"
  local id="${2:-$pkg}"
  pin_or_fail "$id" "$fp" || { echo "    REFUSED"; return 1; }
  if "${ADB[@]}" install -r -g "$apk" >/dev/null 2>&1; then
    echo "    installed"
  else
    echo "    install FAILED"; return 1
  fi
}

case "${1:-list}" in

list)
  echo "device: $("${ADB[@]}" shell getprop ro.product.model | tr -d '\r') / Android $("${ADB[@]}" shell getprop ro.build.version.release | tr -d '\r')"
  echo "active: $("${ADB[@]}" shell settings get secure default_input_method | tr -d '\r')"
  echo
  echo "enabled IMEs:"
  "${ADB[@]}" shell ime list -s -a | tr -d '\r' | sed 's/^/  /'
  echo
  echo "keyboard packages present:"
  for p in "${OSS_PACKAGES[@]}" "${PLAY_PACKAGES[@]}"; do
    v="$("${ADB[@]}" shell dumpsys package "$p" 2>/dev/null | awk -F= '/versionName=/{print $2; exit}' | tr -d '\r')"
    if [ -n "$v" ]; then printf '  %-42s %s\n' "$p" "$v"
    else printf '  %-42s %s\n' "$p" "ABSENT"; fi
  done
  ;;

fetch-oss)
  mkdir -p "$CACHE"
  for pkg in "${OSS_PACKAGES[@]}" "${OSS_BROWSERS[@]}"; do
    echo "$pkg"
    url="$(curl -sL -m 60 "https://f-droid.org/en/packages/$pkg/" \
           | grep -oE "https://f-droid\.org/repo/${pkg}_[0-9]+\.apk" | head -1)"
    if [ -z "$url" ]; then echo "    not on F-Droid (or page changed) — skipped"; continue; fi
    apk="$CACHE/${url##*/}"
    if [ ! -s "$apk" ]; then
      curl -sL -m 300 -o "$apk" "$url" || { echo "    download failed"; continue; }
    fi
    [ -s "$apk" ] || { echo "    empty download"; continue; }
    install_apk "$apk" "$pkg"
  done
  echo
  echo "enable + select with: $0 select <ime-id>   (ids from: $0 list)"
  ;;

install-drop)
  mkdir -p "$DROP"
  shopt -s nullglob
  found=0
  for apk in "$DROP"/*.apk; do
    found=1
    install_apk "$apk" "$(pkg_id "$apk")"
  done
  # APKMirror bundles (.apkm) and .xapk are ZIPs of SPLIT apks — a base plus
  # per-arch/per-dpi/per-language pieces. They must go on with
  # `install-multiple`, and each split is signed by the same publisher key, so
  # verifying the base is what identifies the app.
  for bundle in "$DROP"/*.apkm "$DROP"/*.xapk; do
    found=1
    name="$(basename "$bundle")"
    echo "  $name (split bundle)"
    work="$(mktemp -d)"
    if ! unzip -q -o "$bundle" -d "$work" 2>/dev/null; then
      echo "    not a readable zip — skipped"; rm -rf "$work"; continue
    fi
    base="$(ls "$work"/base.apk 2>/dev/null || ls "$work"/*.apk 2>/dev/null | head -1)"
    if [ -z "$base" ]; then echo "    no apk inside — skipped"; rm -rf "$work"; continue; fi
    echo "    sha256 $(sha256 "$bundle")  (bundle)"
    fp="$(signer_fp "$base")"
    echo "    signer $fp  (from base.apk)"
    pin_or_fail "$(pkg_id "$base")" "$fp" || { echo "    REFUSED"; rm -rf "$work"; continue; }
    splits=("$work"/*.apk)
    echo "    installing ${#splits[@]} splits"
    if "${ADB[@]}" install-multiple -r -g "${splits[@]}" >/dev/null 2>&1; then
      echo "    installed"
    else
      echo "    install FAILED (Android 14 rejects targetSdk < 23; check with: adb install-multiple ...)"
    fi
    rm -rf "$work"
  done
  [ "$found" = 1 ] || {
    echo "nothing in $DROP"
    echo
    echo "Proprietary keyboards are Play-only and APKMirror blocks scripted"
    echo "downloads (403, Cloudflare). Download in a browser and drop them here:"
    for p in "${PLAY_PACKAGES[@]}"; do echo "  $p"; done
    echo
    echo "Then re-run: $0 install-drop"
    echo "Each install prints its signer fingerprint — check it against the"
    echo "publisher before you trust the app."
  }
  ;;

verify)
  [ -n "${2:-}" ] || { echo "usage: $0 verify <apk>"; exit 1; }
  echo "sha256 $(sha256 "$2")"
  echo "signer $(signer_fp "$2")"
  ;;

select)
  [ -n "${2:-}" ] || { echo "usage: $0 select <ime-id>"; exit 1; }
  "${ADB[@]}" shell ime enable "$2" | tr -d '\r'
  "${ADB[@]}" shell ime set "$2" | tr -d '\r'
  echo "active: $("${ADB[@]}" shell settings get secure default_input_method | tr -d '\r')"
  ;;

play)
  # Drive the user's own signed-in Play session: open the listing and tap the
  # Install button by its accessibility label, so the position of the button (and
  # the screen size) does not matter. Play is the ONLY sanctioned source for these
  # — it is also the only one that gives a publisher-signed binary.
  [ -n "${2:-}" ] || { echo "usage: $0 play <package> [more...]"; exit 1; }
  shift
  for pkg in "$@"; do
    echo "$pkg"
    "${ADB[@]}" shell am force-stop com.android.vending >/dev/null 2>&1
    "${ADB[@]}" shell am start -a android.intent.action.VIEW -d "market://details?id=$pkg" >/dev/null 2>&1
    sleep 6
    # UiSelector matches the label, not a coordinate.
    "${ADB[@]}" shell input keyevent KEYCODE_WAKEUP >/dev/null 2>&1
    tapped=0
    for attempt in 1 2 3; do
      dump="$("${ADB[@]}" shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1; "${ADB[@]}" shell cat /sdcard/ui.xml 2>/dev/null)"
      # bounds of a node whose text/content-desc is Install (not "Installed")
      bounds="$(printf '%s' "$dump" | tr '>' '\n' \
        | grep -iE 'text="Install"|content-desc="Install"' \
        | grep -oE 'bounds="\[[0-9]+,[0-9]+\]\[[0-9]+,[0-9]+\]"' | head -1)"
      if [ -n "$bounds" ]; then
        coords="$(printf '%s' "$bounds" | grep -oE '[0-9]+')"
        x1=$(echo "$coords" | sed -n 1p); y1=$(echo "$coords" | sed -n 2p)
        x2=$(echo "$coords" | sed -n 3p); y2=$(echo "$coords" | sed -n 4p)
        "${ADB[@]}" shell input tap $(( (x1+x2)/2 )) $(( (y1+y2)/2 ))
        echo "  tapped Install"; tapped=1; break
      fi
      if printf '%s' "$dump" | grep -qiE 'text="(Open|Uninstall|Update)"'; then
        echo "  already installed"; tapped=1; break
      fi
      sleep 5
    done
    [ "$tapped" = 1 ] || { echo "  could not find an Install button — sign in to Play on the device, or install by hand"; continue; }
    # Play downloads asynchronously; poll for the package to appear.
    for i in $(seq 1 60); do
      v="$("${ADB[@]}" shell dumpsys package "$pkg" 2>/dev/null | awk -F= '/versionName=/{print $2; exit}' | tr -d '\r')"
      [ -n "$v" ] && { echo "  installed $v"; break; }
      sleep 5
    done
    [ -n "${v:-}" ] || echo "  did not appear within 5min"
  done
  echo
  echo "enable with: $0 list   then   $0 select <ime-id>"
  ;;

reset)
  "${ADB[@]}" shell ime set com.google.android.inputmethod.latin/com.android.inputmethod.latin.LatinIME | tr -d '\r'
  ;;

*) sed -n '2,30p' "$0" ;;
esac
