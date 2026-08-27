# Popcorn harness WebView shell (iOS)

A minimal iOS Simulator app whose entire UI is one full-window `WKWebView`. It
exists so the harness can test a page the way a host app ships it — inside a web
view — instead of only in Safari. A page with an embedded third-party view
behaves differently there: no browser chrome, different safe-area and
keyboard handling, different permission and cookie handling.

The shell adds no UI and never injects script into the page under test, so every
assertion still comes from the device framebuffer.

## Build

Requirements: Xcode with the iOS Simulator SDK — which the harness already needs
for WebDriverAgent. There is no Xcode project and no `xcodebuild`: one
Info.plist, two Swift files, one `swiftc` call.

```bash
./build.sh
```

Output: `build/PopcornWebViewShell.app`, ad-hoc signed, built for the host
architecture. Ignored by git.

Overridable variables: `MIN_IOS` (16.0), `SWIFT_VERSION` (5), `ARCH`,
`IPHONESIMULATOR_SDK`, `OUTPUT_DIR`.

## Install and launch by hand

The harness installs the app automatically when the case selects the
`webview-shell` launch target, but the same thing by hand is:

```bash
xcrun simctl install <udid> build/PopcornWebViewShell.app

# URL as a launch argument (what the harness uses)
xcrun simctl launch --terminate-running-process <udid> \
  org.reclaimprotocol.popcorn.webviewshell \
  -url 'https://example.test/page' -clearData true
```

Watch the shell's own log lines, which carry the origin and path only so a
LiveView viewer token never lands in the log:

```bash
xcrun simctl spawn <udid> log stream --predicate 'eventMessage CONTAINS "PopcornShell"'
```

## Options

Delivered as `-name value` launch arguments, or as query items on a
`popcorn-shell://open?...` URL.

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `url` | string | none, stays blank | Page to load |
| `userAgent` | string | WKWebView default | Overrides the user agent |
| `fullscreen` | bool | `false` | Edge-to-edge instead of pinned to the safe area |
| `javaScript` | bool | `true` | `allowsContentJavaScript` |
| `clearData` | bool | `false` | Clear cookies, storage, and cache before loading |
| `inspect` | bool | `true` | `WKWebView.isInspectable` on iOS 16.4+ |

Set them per environment through the launch target's `extras` map rather than
in a case.

## Why launch arguments, not a custom URL scheme

The app does register `popcorn-shell://`, and `urlDelivery: "custom-scheme"`
uses it. But iOS shows a system confirmation dialog — *Open in "Popcorn WebView
Shell"?* — when another process opens a custom scheme, and an automated run has
nobody to tap **Open**. `simctl launch` delivers the URL with no dialog, so
`launch-args` is the default. The scheme remains useful for driving a shell by
hand.

## Deliberate limitations

- Camera and microphone `WKMediaCaptureType` requests are granted
  automatically, so a hidden permission prompt cannot stall a run.
- iOS presents its own document picker, so an upload step in an embedded flow
  leaves the page under test and the framebuffer sees system UI.
- Non-web navigation schemes are cancelled rather than handed to another app,
  keeping the test inside the shell.
- One surface: `createWebViewWith` loads into the same web view, so
  `target="_blank"` cannot open a window the framebuffer cannot see.
- Simulator only. The bundle is unsigned beyond an ad-hoc signature and
  declares `iPhoneSimulator`; a physical device needs a provisioning profile.
