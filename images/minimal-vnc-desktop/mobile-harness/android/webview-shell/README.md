# Popcorn harness WebView shell

A minimal Android app whose entire UI is one full-window `WebView`. It exists so
the harness can test a page the way a host app ships it — inside a WebView —
instead of only in Chrome. A page with an embedded third-party view behaves
differently there: no browser chrome, different viewport defaults,
different permission and cookie handling.

The shell adds no UI and never injects script into the page under test, so
every assertion still comes from the device framebuffer.

## Build

Requirements: a real JDK 17+, Android SDK platform + build-tools, `zip`. There
is no Gradle; the script drives `aapt2 → javac → d8 → zipalign → apksigner`
directly.

```bash
export ANDROID_HOME="$HOME/Library/Android/sdk"   # or ANDROID_SDK_ROOT
export JAVA_HOME="$(/usr/libexec/java_home -v 21)" # macOS
./build.sh
```

Output: `build/popcorn-webview-shell.apk`, signed with a local debug key that
the script generates once at `build/debug.keystore`. Both are ignored by git.

Overridable variables: `MIN_SDK` (24), `TARGET_SDK` (34), `JAVA_TARGET` (17),
`BUILD_TOOLS_VERSION`, `PLATFORM_VERSION`, `ANDROID_JAR`, `VERSION_CODE`,
`VERSION_NAME`, `OUTPUT_DIR`, and `KEYSTORE` / `KEYSTORE_PASS` / `KEY_ALIAS`
to sign with your own key.

If the SDK is missing:

```bash
brew install --cask android-commandlinetools temurin@21
sdkmanager 'platform-tools' 'platforms;android-34' 'build-tools;34.0.0'
```

## Install and launch by hand

The harness installs the APK automatically when the case selects the
`webview-shell` launch target, but the same thing by hand is:

```bash
adb install -r -g build/popcorn-webview-shell.apk

# URL as an intent extra (what the harness uses)
adb shell am start -W -a android.intent.action.VIEW \
  -n org.reclaimprotocol.popcorn.webviewshell/.ShellActivity \
  --es url 'https://example.test/page'

# or exactly like Chrome
adb shell am start -W -a android.intent.action.VIEW \
  -p org.reclaimprotocol.popcorn.webviewshell -d 'https://example.test/page'
```

Logcat carries the shell's own lines only, with query strings stripped so a
LiveView viewer token never lands in the log:

```bash
adb logcat -s PopcornShell:I
```

## Intent extras

| Extra | Type | Default | Effect |
| --- | --- | --- | --- |
| `url` | string | intent data, else `about:blank` | Page to load |
| `userAgent` | string | WebView default | Overrides the user agent |
| `fullscreen` | bool | `false` | Immersive mode, hiding status and navigation bars |
| `wideViewPort` | bool | `true` | Honor the page's viewport meta tag like a browser |
| `javaScript` | bool | `true` | `WebSettings.setJavaScriptEnabled` |
| `thirdPartyCookies` | bool | `true` | Third-party cookies, needed by embedded widgets in iframes |
| `clearData` | bool | `false` | Clear cookies, web storage, and cache before loading |
| `debug` | bool | `true` | `WebView.setWebContentsDebuggingEnabled` |
| `softInput` | string | manifest (`resize`) | Window response to the keyboard: `resize`, `pan`, or `nothing` |

Set them per environment through the launch target's `extras` map rather than
in a case. `wideViewPort` defaults to `true` because a WebView otherwise
ignores the viewport meta tag and every layout comparison drifts; set it to
`false` to reproduce a host app that leaves the platform defaults alone.

## The soft keyboard is not browser-equivalent

Measured on an emulator (Pixel 7, API 34, WebView 113) with an input pinned to
the bottom of the page, tapping it:

| Surface | `innerHeight` | `visualViewport.height` | `offsetTop` |
| --- | --- | --- | --- |
| Chrome | 783 → 783 | 783 → 471 | 0 → 312 |
| shell, `softInput=resize` (default) | 839 → **527** | 839 → 527 | 0 |
| shell, `softInput=pan` | 839 → 839 | 839 → 839 | 0 |
| shell, `softInput=nothing` | 839 → 839 | 839 → 839 | 0 |

A browser keeps the layout viewport and shrinks only the visual viewport. No
window mode reproduces that in a WebView: `resize` shrinks the **layout**
viewport, so the page reflows — `100vh` boxes shrink and bottom-pinned elements
move — while `pan` and `nothing` leave the page unable to see the keyboard at
all (`visualViewport` never changes), so a bottom field can sit behind the keys.

`resize` stays the default because that is what a typical host app declares, so
it is the honest reproduction of what users get. This is a platform difference
to measure, not a shell bug — the `webview-bottom-input-keyboard` case exists to
pin it, and it is why `fit.js` must never treat a keyboard-driven height change
as a real viewport resize.

## Deliberate limitations

- No file chooser. `onShowFileChooser` cancels explicitly, so a document-upload
  step in an embedded flow ends with a visible cancellation instead of hanging.
  A case that needs upload has to stop before that step.
- Camera and microphone `PermissionRequest`s are granted automatically, and
  `adb install -g` pre-grants the declared Android permissions, so a hidden
  system dialog cannot stall a run.
- Non-web navigation schemes are blocked rather than handed to another app,
  keeping the test inside the shell.
- One window: `setSupportMultipleWindows(false)`, so `target="_blank"` does not
  open a second surface the framebuffer cannot see.
