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

When Safari and LiveView present the same native control with different system
layouts, an action may define `targetOverrides.baseline` and
`targetOverrides.candidate`. Use this only for coordinate calibration (for
example, the same select option in a Safari popover and a LiveView bottom
sheet). Overrides cannot change the shared action's `type` or `name`.
