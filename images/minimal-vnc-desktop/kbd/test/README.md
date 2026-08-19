# kbd characterization tests

Behavior lock for the mobile-keyboard/IME layer (`kbd-autofocus.js` + `kbd/*.js`).
These tests drive synthetic input events through the real `PopcornKbd.attach()`
API against a mock RFB and assert on the **exact keysym stream** — so any
refactor that changes what goes on the wire fails loudly.

Run (Node ≥ 20, zero deps, no build step):

```bash
node --test kbd/test/*.test.mjs
```

Rules that keep the harness honest:

- **One platform profile per test file.** `kbd/env.js` freezes `isIOS`/`isAndroid`/
  `DESKTOP`/`MAGNIFY`… once per process from the globals present at first import;
  `node --test` runs each file in its own process, which is what isolates profiles.
  `installGlobals(profile)` must be the first thing a test file does.
- Within a file, `freshViewer()` cache-busts only the core module for per-test
  state. Child modules (latency, rtt, diag) are shared per process — tests that
  mutate them (e.g. seeding the RTT EMA to force slow-link behavior) get their
  own file (see `slow-link-ec.test.mjs`).
- The `/kbd` focus-signal is driven by firing `onmessage` on the captured
  WebSocket (`pushSignal(state)`) — the same transport the proxy extension uses;
  never reach into module internals.
- `setTimeout` is real (the 90 ms deferred backspace, grace windows); `setInterval`
  registers but never self-ticks — `tickIntervals()` drives interval-owned logic
  (the watchdog) explicitly. Age-based logic (send-queue staleness, idle
  reconcile) uses the controllable `performance.now` clock — `advanceClock(ms)`.
- Lifecycle observables: the suite reads keyboard state through what a user sees —
  `document.activeElement === proxy` (raised/focused) and the proxy's parked
  position (`left === '-9999px'`), never internal flags.
- `fireViewport('resize')` + `setVisualViewportHeight()` drive the keyboard
  detectors; `parentMessages` records `POPCORN_VIEWPORT`/`POPCORN_INPUT_DRIFT`
  posts to the embedding frame.
- **Embedded profiles.** `installGlobals(profile, { embedded: true })` makes
  `window !== window.top`, which is what the layer branches on for an embedded
  viewer (host-bridge inbound arming, iframe focus claiming, the iOS raise path).
  Pair it with `search: '?parentOrigin=https://portal.test'` — the inbound policy is
  fail-closed, so without that the viewer ignores every host message by design.
- **Host messages.** `fireHostMessage(data)` delivers a host→viewer `postMessage`
  the way a configured embedder would: from the real parent window, with the
  expected origin. Both are checked, so a test that gets either wrong sees the
  message silently ignored — which is the production behaviour, and the reason to
  use this helper rather than hand-rolling the event. `fireWindow(type, props)` is
  the general form for window-level events.

Suite map: `ios-input` / `android-value-diff` / `android-ec` / `composition-ios` /
`slow-link-ec` (keystroke translation) · `send-queue` (reconnect queue) ·
`desktop` (bridge + clipboard) · `viewport-gestures` (pinch/pan) · `lifecycle`
(raise/dismiss/recovery/grace) · `detectors` (visualViewport shrink/grow +
floating-keyboard keep) · `host-geometry` (embedded viewer: host-supplied keyboard
rect, detector exclusivity, origin/source rejection, heartbeat-vs-dismiss) ·
`mirror` (?mirror=1 seed/diff/idle-reconcile) · `stateless` (?stateless=1
advisory-signal invariants) · `watchdog` · `blind-coverage-raise` (a tap on a
cross-origin form field raises without waiting for the remote confirm) ·
`e2e-trace` (input→paint legs + the privacy shape of a trace line) ·
`fbtarget` (the framebuffer/CDP size agreement that makes deviceScaleFactor>1 safe) ·
`fbscale` (when supersampling is worth its k² pixels) · `portal-blind-host` (a
misconfigured embedder cannot break the keyboard) ·
`host-embed-layout` / `host-embed-params` (the EMBEDDER side — see below).

### Host-side suites

`host-embed-layout` and `host-embed-params` test `host/popcorn-host.js`, which is
a classic script an integrator drops into their own page — not a module, so it
cannot be imported. `host-stub.mjs` evaluates it against a hand-built window whose
only job is to be honest about what the layout audit reads (`getComputedStyle`, the
parent chain, `getBoundingClientRect`, the viewport size); a test writes the DOM
shape it wants to characterise and asserts on what the audit says about it. That
stub models the page ABOVE the viewer, so it is deliberately separate from
`stub-dom.mjs`, which models the viewer's own document.

New in the embed/diagnostics group: `health` (the integration verdict sent to the
embedder) · `fbscale-pinned` (a pinned ?fbscale=N must actually reach the
framebuffer) · `e2e-trace` (input->paint legs, including the remote-confirmation
leg and the field-aware paint sampler) · `watchdog` (focus reclaim vs dismissal).

A browser-driven counterpart lives at `host/test/embed-contract.browser.mjs`: the
embedding contract is a BROWSER behaviour (raster scale, iframe lifetime,
permission policy) and a stub can only disagree with a browser in the direction
nobody wrote a test for — which is exactly how `PopcornHost.layer()` shipped
broken while its stub test passed. It skips with exit 0 when no Chrome or no pod
is available.
