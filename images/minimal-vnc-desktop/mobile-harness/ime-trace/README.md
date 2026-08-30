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
