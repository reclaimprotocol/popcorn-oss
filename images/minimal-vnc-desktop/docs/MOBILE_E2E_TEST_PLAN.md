# Mobile E2E test suite — iOS Simulator (plan)

Goal: **auto-test the real mobile keyboard + page-preview behavior on a real iOS
WebKit browser with a real soft keyboard** — the fidelity my current
headless-Chromium (Playwright) checks can't reach. It must do *real* interaction:
raise the keyboard by tapping a field, type on the actual soft keyboard, and
assert the text/selection landed on the **remote** page.

## Why the iOS Simulator (not headless Chromium)
- Every iOS browser is WebKit; the Simulator runs **real Mobile Safari** with the
  **real soft keyboard, IMEs, autocorrect, and the accessory bar**. That's exactly
  the surface our bugs live in (iOS composition, the `⌃`/`⌄` accessory arrows,
  visualViewport keyboard detection, select-on-tap) and that Chromium-with-a-
  spoofed-iPhone-UA does NOT exercise.
- Keep the fast Playwright tests as **tier 1** (logic/geometry/coordinate math,
  seconds to run); this Appium suite is **tier 2** (high-fidelity, slow, macOS-only).

## Stack
- **Xcode iOS Simulator** (e.g. iPhone 15, iOS 17/18).
- **Appium 2** + **appium-xcuitest-driver** (+ WebDriverAgent) to drive Mobile
  Safari and the native keyboard.
- **Test runner**: Python (`Appium-Python-Client`) or Node (`webdriverio`). Python
  fits the existing `scripts/` tooling.
- **Assertion oracle**: the running container's **CDP endpoint (`:9226`)** — the
  source of truth is the REMOTE page state, queried via `Runtime.evaluate`.
- The container itself (`popcorn/minimal-vnc-desktop:local`) serving the viewer.

## Network
The Simulator shares the Mac host network, so Safari reaches `http://localhost:6080`
directly — **no Cloudflare tunnel needed**. CDP on `127.0.0.1:9226` is queried by
the runner on the host (not from the sim).

## The crux: how "real typing" flows and how we assert it
Our input path is: soft keyboard → hidden proxy `<input>` in the VIEWER → RFB
`sendKey` → **remote** field. The visible "field" is just pixels on a `<canvas>`.
So the test must tap by coordinate and assert against the remote, not the viewer.

Per typing test:
1. **Open** the viewer URL in Safari (web context): `localhost:6080/liveview.html?magnify=1`.
2. **Tap the remote field by coordinate.** The field is canvas pixels — compute
   its screen point from a deterministic fixture page (known layout) mapped through
   the fit/emulation transform, or read the remote field's `getBoundingClientRect`
   via CDP and map it through the viewer's canvas rect + zoom transform to a screen
   xy. Tap via Appium `mobile: tap` / W3C pointer action.
3. **Assert the keyboard rose** — native context: `driver.is_keyboard_shown()`.
4. **Type on the real keyboard.** Native context; two options:
   - `driver.execute_script('mobile: type', {text})` / XCUITest `typeText` on the
     focused app — routes through the soft keyboard to the focused web input, or
   - tap individual key elements by accessibility id (needed to exercise
     autocorrect, punctuation, the `123`/emoji planes, and IME candidate bars).
5. **Assert on the REMOTE** via CDP: `Runtime.evaluate` → the field's `.value`
   (and `.selectionStart/End`) equals the expected text. This is the oracle.
6. Dismiss / move on.

## Deterministic fixtures (add under `scripts/e2e/fixtures/`)
Served by the container (or a tiny static server) so tests aren't at the mercy of a
live site:
- `responsive-form.html` — mobile-reflow form (email/tel/number/password/textarea).
- `fixed-width.html` — a non-responsive ~1000px page (fit-to-width path).
- `multi-field.html` — several inputs in tab order (field-to-field nav).
- `ime.html` — fields for CJK/emoji/Indic entry.
- `cursor.html` — pre-filled field (re-tap / select-all-collapse check).

## Test matrix
### Keyboard
- Tap a text field → soft keyboard appears (invoke-on-tap).
- Type ASCII → remote `.value` matches exactly.
- Backspace deletes on the remote (incl. the empty-buffer / mid-composition case).
- Enter / Tab / Escape route correctly (submit, next field, dismiss).
- Field-to-field: accessory `⌄`/`⌃` arrows move to next/prev remote field.
- Manual keyboard button (`⌨`) raises/dismisses.
- Keyboard dismiss (Done, tap-away, hardware back).
- **Bug regression:** re-tap a filled field → caret at end, NOT select-all;
  typing appends (asserts `selectionStart===len`).
- IME (where a system keyboard can be enabled): emoji plane, and if installable, a
  CJK keyboard → type Pinyin, commit a candidate → remote gets the composed glyph,
  and Enter-to-commit does NOT leak Enter to the form.
- inputmode/enterkeyhint: numeric field shows the number pad; `Go`/`Next` label.

### Page preview
- Non-responsive page → **fit-to-width**: whole page visible (assert remote
  `innerWidth === fitLayoutW`, `scrollWidth ≈ innerWidth`, no horizontal overflow),
  and default lands **zoomed-in/readable** (assert `#screen` transform scale > 1).
- Magnify button toggles fit ↔ readable (assert transform flips).
- Pinch-zoom in/out via W3C multi-touch actions (assert `#screen` transform scale).
- 3+ finger multi-touch reaches the remote (assert via CDP touch counters on a
  test page that logs touch points).
- Responsive page: narrow mobile reflow (assert remote `innerWidth ≈ viewport`).
- Keyboard-open on a fit page does NOT re-zoom (assert transform stable across a
  focus that raises the keyboard).

## Orchestration (a `scripts/e2e/run.sh`)
1. Build + `docker run` the container on `:6080` / `:9226` (or reuse a running one).
2. `xcrun simctl boot <device>`; **disable the hardware keyboard** so the soft
   keyboard shows (Appium cap `connectHardwareKeyboard: false`, or
   `defaults write com.apple.iphonesimulator ConnectHardwareKeyboard 0`).
3. Start the Appium server (xcuitest driver, `safari` automationName / browserName).
4. Run the test runner (Python), which owns both the Appium session (sim) and a
   CDP websocket (host `:9226`) for assertions.
5. Tear down: quit Appium, `simctl shutdown`, `docker rm -f`.

## CI
- Needs a **macOS runner with Xcode** — slow (sim boot + WDA build). Run **nightly
  / on-demand / pre-release**, not per-commit. Keep Playwright tier-1 on every PR.

## Known limitations (document as manual-only)
- **Glide/swipe typing** can't be programmatically driven — there's no API to
  synthesize a continuous swipe-to-word gesture; verify manually (or via the
  `?kbddebug=1` klog trace).
- **Voice dictation** can't be automated.
- Third-party IMEs (Gboard/SwiftKey/Ridmik) aren't on iOS; the sim tests the iOS
  system keyboards. Android-keyboard quirks (Samsung/Gboard/glide) still need a
  real Android device or an Android-emulator + Appium UiAutomator2 companion suite
  (a natural tier-2b, same harness shape, `mobile: type` + CDP oracle).

## Rough effort
- Harness + one green "tap → type ASCII → assert remote value" test: ~1 day.
- Full keyboard + page-preview matrix + fixtures: ~3–4 days.
- Android-emulator companion (UiAutomator2): +1–2 days.
