# ime-trace — capture what a real Android keyboard actually does

`adb shell input text` injects key events straight at the input dispatcher and
**bypasses the installed IME** (see `src/text-entry.mjs`), so no `typeText` case
can reach composition, suggestions, glide or autocorrect. This tool closes that
gap: it serves a page instrumented like the viewer's proxy, you drive it with a
real keyboard, and every DOM event is posted back and dumped as JSON.

Those dumps are the ground truth behind `kbd/test/gboard-device-traces.test.mjs`.
The suite used to assert what we *believed* a keyboard does, which is how the
whitespace and delete defects shipped.

Values are masked in the recorder (letters → `a`, digits → `9`); whitespace and
punctuation are kept verbatim as code points, since those are what is under
investigation. Use fake credentials anyway.

## Run

```sh
node server.mjs &                                  # host, port 8731
adb reverse tcp:8731 tcp:8731
adb shell am start -a android.intent.action.VIEW \
  -d "http://localhost:8731/?r=$(date +%s)" com.android.chrome
```

The cache-buster matters — Chrome will otherwise show a stale blank page.

```sh
curl -X POST localhost:8731/reset      # start a clean capture
curl localhost:8731/dump               # everything since the reset
```

Tap fields and keys with `adb shell input tap X Y`, reading coordinates off
`adb exec-out screencap -p`. Taps land on the keyboard as real touches, so the
IME runs its full pipeline — which is the entire point.

## Switching keyboards

```sh
adb shell ime list -s -a                                   # what is installed
adb shell ime enable <id> && adb shell ime set <id>
adb shell settings get secure default_input_method         # confirm
```

Gboard ships on Google Play emulator images. Hacker's Keyboard is on F-Droid
(`org.pocketworkstation.pckeyboard`) and is worth having: it is the only one here
with arrows, Ctrl, Alt and Esc, and its **full 5-row layout only appears in
landscape** (`adb shell settings put system user_rotation 1`). SwiftKey, Fleksy,
Grammarly, Chrooma, Facemoji and Yandex are proprietary and need a Play Store
sign-in on the emulator; do not pull them from APK mirrors.

Restore afterwards: set rotation back to 0, re-enable
`accelerometer_rotation`, and `ime set` Gboard again.

## What was measured (Android 14 / API 34, Gboard 12.4.05, Chrome 113)

Chrome 113 has no EditContext, so this configuration exercises the
hidden-`<input>` value-diff path — the one Samsung and Android WebView take. The
EditContext path needs Chrome 121+.

| Shape | What the keyboard actually sends |
|---|---|
| Gboard, prose field | every letter is `insertCompositionText`, `isComposing=1` — Gboard composes *per character* |
| Gboard, `type=password` | `insertText`, `isComposing=0`, no `compositionstart` at all |
| Gboard suggestion tap | commits the word **plus U+0020** — `"Teh"` → `"The "` |
| Gboard double-space | `deleteContentBackward`, then `insertText` of `U+002E U+0020` |
| Gboard word-delete (swipe left on ⌫) | ONE `deleteContentBackward` taking the value 11 → 0 |
| Gboard ⌫, empty field | `keydown key=Backspace` + `beforeinput`, and **no `input` event** |
| Hacker's Keyboard | `insertText`, never composing; real `ArrowLeft/Right/Up` with keyCodes 37/39/38 |

Two findings worth keeping in mind when reading traces:

- `keydown key='Unidentified'` shows up on **every** keyboard measured, composing
  or not, for ordinary letters as well as deletes. Nothing may assume an
  identified key.
- A password field changes Gboard's behaviour wholesale. That is what the secure
  surface buys, and it is why a credential field must reach the IME as a real
  `<input type=password>`.

## keyboards.sh — getting IMEs onto the device

`fetch-oss` installs every F-Droid keyboard unattended and pins each one's
signing certificate in `keyboards.lock`; a later build signed by a different key
is refused rather than installed. `play <pkg>` drives an install through the
device's own Play session by tapping the button by its accessibility label.

APKMirror is deliberately not used: it answers 403 to every scripted request
(Cloudflare), and working around that is both against their terms and the wrong
habit to build. Play is the only sanctioned source for the proprietary ones, and
it is the only one that yields a publisher-signed binary.

Note `apksigner` and `sdkmanager` both need a JRE. Without one, signature
verification falls back to reading the v1 certificate out of the APK zip with
openssl, and refuses to pin anything it cannot compute — an empty pin matches
everything, which is worse than no pin at all.

## Browsers matter as much as keyboards

The engine decides which input path runs. Chrome 121+ has EditContext; Chrome
113 and every Gecko build do not, so those take the hidden-`<input>` value-diff
path. `kbd/kbd-detect.js` carries a Gecko-only branch (`isFirefox`, "VP grew on
gecko -> keep kbd") because Firefox reverts the visual viewport while the IME is
up — behaviour no Blink engine shows. Until this run, that branch had only ever
executed against a stub.

Fennec (Firefox's F-Droid build, `org.mozilla.fennec_fdroid`) installs without
Play, so the Gecko path is reachable unattended.

## Two traps that silently invalidate a run

**`&` in `adb shell am start -d <url>` is eaten by the DEVICE shell.** The URL is
truncated at the first ampersand, so `?kbddebug=1&magnify=1&e2e=20` arrives as
`?kbddebug=1` and the run quietly tests the wrong configuration. Quote the whole
command so the device shell sees one argument:

```sh
adb shell "am start -a android.intent.action.VIEW -d '$URL' com.android.chrome"
```

Verify rather than assume — read `location.search` back over CDP, and check the
boot line, which prints `magnify=` from the parsed value. Note there may be
several viewer tabs open; make sure you read the foreground one.

This matters because `TOUCH_INPUT = MAGNIFY && isTouch`: without magnify the
native `/input` touch channel never opens and taps fall back to noVNC
touch->mouse, so a whole transport path goes untested. With magnify on, the boot
log shows `kickReconnects (sock=1 input=1)`, `emulate 412x783@1.000`, and
`input socket open`.

**Clearing a remote field with JS desyncs the viewer.** Setting `.value=''`
through CDP leaves the proxy's `lastSentValue` stale, and the next diff replays
that buffer — drift-recon is off on sensitive fields by design, so nothing
notices. Reset by switching fields (which is what makes field-session call
`clearProxy()`), not by clearing the value.

## Nested chain

`host/test-host.html?nest=1&viewer=<base>` loads itself one level deeper, giving
host -> relay iframe -> viewer. Serve `images/minimal-vnc-desktop` and reverse
the port:

```sh
python3 -m http.server 8749 --bind 127.0.0.1
adb reverse tcp:8749 tcp:8749
```

A healthy nested boot logs `nested mode: child is this page in relay mode`,
`HELLO proto=1 vk=1 vv=1 magnify=1`, and
`host-bridge: embedder proved it can see the keyboard -> local detectors stand down`.
