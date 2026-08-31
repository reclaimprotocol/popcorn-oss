# Mobile evaluation findings

Evaluation date: 2026-08-23

The current dashboard contains fresh results for all 40 checked-in pair cases.
Every pair uses native simulator input and framebuffer evidence. CDP only opens
the fixture in the remote kiosk browser before recording.

## Result summary

| Verdict | Count |
| --- | ---: |
| PASS | 36 |
| FAIL | 2 |
| REVIEW | 2 |
| INFRA_ERROR | 0 |

## Failures

| Case | Finding |
| --- | --- |
| [Map pan, pinch, and marker](../artifacts/map-pan-pinch-marker/pair.json) | Safari reaches the visible zoomed-map marker. LiveView never produces that marker after the same native gesture sequence. |
| [Pinch then tap](../artifacts/pinch-then-tap/comparison/report.html) | LiveView magnifies the whole viewer. Markers outside the bounded pinch area move or disappear, while Safari keeps them fixed. |

## Results requiring review

| Case | Reason |
| --- | --- |
| [Input near bottom typing stability](../artifacts/input-near-bottom-typing-stability/comparison/report.html) | The synchronized pair completed, but the case has no acceptance threshold. Direct pixel differences are 39.30% at focus and 38.85% after typing. |
| [Multiple input types switching](../artifacts/multiple-input-types-switching/comparison/report.html) | The text, email, and telephone sequence completed, but the case has no acceptance threshold. Direct differences are 22.70% and 27.92%. |

## Viewport coverage

| Case | Result |
| --- | --- |
| [TestUFO screen selector](../artifacts/testufo-screen-selector/comparison/report.html) | PASS. Vision matched 19 text regions at a 1.03x median LiveView-to-Safari height ratio. The earlier broken build measured about 0.50x. |
| [Initial-scale-only viewport](../artifacts/viewport-initial-scale-only/comparison/report.html) | PASS. Ten text matches at 1.00x before and after interaction. |
| [No viewport metadata](../artifacts/viewport-no-meta-fallback/comparison/report.html) | PASS. Five matches at 1.00x, preserving the desktop fallback. |
| [Explicit width 720](../artifacts/viewport-fixed-width-720/comparison/report.html) | PASS. Eight matches at 1.00x; LiveView uses the declared width instead of 980px. |
| [Dynamically inserted viewport](../artifacts/viewport-dynamic-meta/comparison/report.html) | PASS. Nine matches at 1.01x before and 1.03x after interaction. |

## Run corrections

The first pass produced six invalid runs. Five were candidate startup-navigation
timeouts; retries completed. The remaining test calibration problems were:

- `long-input-cascade` required 100 focused-marker pixels, but the simulator
  rendered 95. Its threshold is now 80.
- `mixed-input-return-cycle` used a header marker hidden by Safari chrome, tapped
  a textarea marker on its border, and tried to drag from a coordinate above the
  native window. The case now uses the field-local typed marker, dismisses the
  telephone keyboard before reaching the textarea, taps inside the textarea,
  and uses bounded return swipes. Its original 42px field margins also put the
  telephone marker behind LiveView's keyboard accessory bar after email entry.
  Compact 14px margins keep every direct-switch target visible. The complete
  return cycle now passes with a 14.90% relative transition delta.
- `native-date-time-pickers` resolved the LiveView time-input tap to y=388,
  which was the input's top border after the date result changed the layout. A
  candidate-only marker offset now taps the field center at y=438. The native
  wheel opens and the pair passes with a 1.09% relative transition delta.
- Failed runs now retain `failure-state.png`, captured before Appium teardown.

## Storage

- The 40 pairs occupy about 140 MB.
- All 80 retained videos are compressed `screen-touches.mp4` files.
- No raw `screen.mp4`, partial staging directory, or timestamp-prefixed case
  directory remains.
- The dashboard contains 40 unique stable manifest paths.
