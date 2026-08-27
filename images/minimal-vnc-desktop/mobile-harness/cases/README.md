# Test cases

Each test case is one pair JSON file plus one dedicated visible fixture page.
Copy `../templates/case.pair.json` to `cases/CASE_NAME.pair.json` and copy
`../templates/fixture.html` to `../fixture/cases/CASE_NAME.html`.

A case defines only behavior:

- one observable expectation in `testDescription`;
- visible READY/before/after markers;
- one shared native action sequence;
- synchronized comparison checkpoints;
- optional case-specific analysis thresholds.

Device IDs, ports, hosts, tokens, cluster names, gateway URLs, and shared
LiveView flags belong in an environment file, never in a case.

A case may add `launchTarget` (or `baseline.launchTarget` and
`candidate.launchTarget`) to choose which app hosts the page: `chrome` or
`safari` by default, or `webview-shell` for a page that ships inside a host
app's web view. That is a behavioral choice, so the case names the target and
nothing else; bundle ids, activities, binary paths, and host-app options live in
the environment. See [../docs/CONFIGURATION.md](../docs/CONFIGURATION.md).

`webview-embed-widget` is a worked example of a web-view case,
including how a third-party widget gets visible phase markers without
reaching into its document. See
[../docs/WEBVIEW_EMBED.md](../docs/WEBVIEW_EMBED.md).

For scale-independent drag cases, use `dragRelativeToColors` with unique visible
`sourceColor` and `targetColor` markers. The harness resolves both marker
centroids independently from each simulator framebuffer, then performs a real
multi-step native touch drag between them. Optional `holdMs`, `durationMs`,
`steps`, and source/target offsets tune the gesture without hard-coding layout
coordinates.

For scale-independent motion cases, `swipeRelativeToColors` resolves its start
and end from two visible markers. `repeatedTapRelativeToColor` performs a
configurable burst at one visible marker. `pinchRelativeToColor` centers a
two-finger native pinch on a visible marker. These actions preserve native touch
input without assuming Safari and LiveView use identical coordinates.
Set `engine` to `mobile` on `tapRelativeToColor` when the tap must use
XCUITest's native coordinate-tap command (for example, immediately after a
multi-touch gesture).
Set `singleSequence` on `repeatedTapRelativeToColor` when the operating system
must recognize the taps as one multi-tap gesture rather than separate commands.
`doubleTapRelativeToColor` resolves a visible marker and invokes XCUITest's
native coordinate double-tap gesture at that point.
Use the `pinch-zoom-integrity` comparison profile for controlled client zoom.
It measures a unique visible marker before and after the pinch, requires its
framebuffer area to grow, and compares the within-side area ratio from Safari
with the within-side area ratio from LiveView. Configure at least two
`stableColors` on markers outside the bounded pinch area; they must remain the
same size and position, so scaling the whole view cannot produce a false PASS.
The case must finish with a visible post-zoom interaction marker so coordinate
mapping is also verified. All checks use framebuffer evidence, not DOM or CDP.
Use `dragRelativeToColorByOffset` when the destination is intentionally not
visible at gesture start (for example, autoscroll). It resolves the source from
the framebuffer, then applies `deltaX` and `deltaY` in native screen points.

## Nothing in a case may be a screen coordinate

A literal coordinate encodes the device AND the surface it was calibrated on: the
same number lands somewhere else in Chrome, in a chrome-less web view and in
Firefox, because their chrome heights differ, and somewhere else again on another
device. A case with coordinates in it therefore only ever passes where it was
written, which is not a property of the product. Every case here is expressed
with the vocabulary below instead, and a coordinate in a case should be treated
as a bug in the case.

**Where to touch: a visible marker.** `tapRelativeToColor` and the other
`*RelativeToColor*` actions resolve their point from the framebuffer, so they
follow the element wherever the surface puts it.

**How far to scroll: a fraction of the window.** `swipe` takes
`fromYFraction`/`toYFraction` (and the X pair), each `0..1` of the native window,
resolved at run time. Keep them inside roughly `0.2..0.8`: a start point above
that can land on the browser's own chrome, where the page never receives the
gesture, and below it on the gesture-navigation strip. `swipeRelativeToColorByOffset`
anchors a scroll to a marker instead when the start has to be a specific element.

**What to type: the platform's input path.** `typeText` puts text into the
focused field (`input text` through the IME on Android, XCUITest typing on iOS)
and `pressKey` sends one editor key (`enter`, `next`, `done`, `backspace`, `tab`,
`escape`, `back`). Tapping keyboard KEYS by coordinate cannot port: the same
letter moves with the surface and again with the keyboard app, so a
tap-per-key case is calibrated against one keyboard as well as one browser.
`hideKeyboard` dismisses the IME, which a numeric keypad with no Return key
otherwise needs a blank-spot tap for.

**Native pickers: accessibility text.** Date wheels, select dialogs and IME
accessory rows are OS windows with no fixture colors in them, so
`tapNativeElement` addresses them by what they expose: `android` takes `text`,
`description`, `resourceId`, or a raw `uiSelector` (a `UiScrollable` expression
scrolls a long list to its item in one step, which is how the country case
reaches Zimbabwe without 24 blind swipes); `ios` takes `label`, `name`, a raw
`predicate`, or `pickerValue` for a wheel, which is set rather than tapped.
`android:id/button1` is the confirm button in every platform dialog.

Where the two platforms disagree structurally — Android steps a `NumberPicker`
one visible value at a time, iOS sets the whole wheel at once — an action may
carry `platforms: ["Android"]` and is skipped elsewhere. Use it only for that:
a case whose *behavior* differs per platform is two cases.

When Safari and LiveView present the same native control with different system
layouts, an action may define `targetOverrides.baseline` and
`targetOverrides.candidate`. Use this only for coordinate calibration (for
example, the same select option in a Safari popover and a LiveView bottom
sheet). Overrides cannot change the shared action's `type` or `name`.
