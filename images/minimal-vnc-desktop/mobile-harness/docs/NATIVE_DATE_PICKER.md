# Native temporal pickers

## Problem

Popcorn rendered an HTML date control in the remote framebuffer, so tapping it
did not reliably produce Safari's native iOS calendar or return a chosen date to
the remote page. The earlier combined date/time case records this failure in
[`2026-08-21T14-48-59-963Z-native-date-time-pickers-pair`](../artifacts/2026-08-21T14-48-59-963Z-native-date-time-pickers-pair).

## Implementation

Eligible visible `date`, `time`, `datetime-local`, `month`, and `week` inputs
publish bounded descriptors over the
existing keyboard channel. Each descriptor contains a stable key, mapped
rectangle, current value, `min`, `max`, `step`, and accessibility label.

The LiveView page maps a transparent real input of the same type over each
streamed control. Because that input belongs to the local Safari page, Safari
presents the native iOS picker. On confirmation, LiveView sends the normalized
HTML value and descriptor key to
the publisher. The publisher accepts it only when the active frame is still
advertising that key and the live input still matches; it then applies browser
normalization and `checkValidity()` before dispatching `input` and `change`.

The descriptor and choice paths are capped, size-checked, and allowlisted. A
stale key, malformed temporal value, disabled/read-only input, or value outside the remote
input's constraints is rejected.

## Test result

The dedicated iPhone 17 Pro pair is
[`2026-08-22T15-38-36-031Z-native-date-picker-pair`](../artifacts/2026-08-22T15-38-36-031Z-native-date-picker-pair).
Safari and LiveView both:

1. Open the iOS 26 calendar.
2. Select August 29.
3. Confirm the date.
4. Commit `2026-08-29` and display the green success marker.

The pair passes with a 0.13% relative transition delta. Its report includes raw
and touch-annotated videos for both sides. A container integration test also
proves descriptor publication, successful event round-trip, and rejection of an
out-of-range value.

## Remaining temporal types

iOS 26.2 was probed before gesture calibration and provides a distinct native
surface for every remaining type. The retained pairs all pass:

- [`time`](../artifacts/2026-08-22T20-41-45-102Z-native-time-picker-pair): iOS
  hour/minute/period wheels, `11:16`, 0.10% transition delta.
- [`datetime-local`](../artifacts/2026-08-22T20-44-48-061Z-native-datetime-local-picker-pair):
  combined calendar and embedded time wheels, `2026-08-29T11:16`, 0.08% delta.
- [`month`](../artifacts/2026-08-22T20-46-03-424Z-native-month-picker-pair): iOS
  month/year wheels, `2026-09`, 0.41% delta.
- [`week`](../artifacts/2026-08-22T20-47-21-086Z-native-week-picker-pair): iOS
  calendar with a complete week-row selection, `2026-W35`, 0.24% delta.

Every pair contains raw and touch-annotated Safari and LiveView videos. The
container integration test covers descriptor publication, type-specific value
round trips, `input`/`change` semantics, and rejection of out-of-range values.
Picker Reset is transported as an empty value and the remote input's `required`
constraint decides whether it is accepted.

## Nesting: a picker two iframes deep

Reported against a host app's web view holding a page that embeds a partner frame that embeds the
signup form — the date-of-birth input sits at depth 3.

`content.js` runs in every frame and measures frame-local rects; `emit()` shifts them into
top-window coords with the offset accumulated down the chain, because the viewer maps a descriptor
rect straight onto framebuffer pixels. `offsetState` shifted `rect`, `rects`, `selects`, and `nc` —
and never `pickers`. So the transparent local date input was pinned at the form frame's own
coordinates, short by the sum of both iframe origins: the tap on the DOB field opened nothing, or
opened whatever control the misplaced box happened to cover. Selects in the same frame were placed
correctly, which is what made this read as a picker bug rather than a nesting one.

Fixed by offsetting `pickers` alongside `selects`, cloning the descriptors the way the select path
already does — `report()` reuses `cachedPickers` across emits, so shifting in place would walk the
rect further down the page on every heartbeat.

Covered by:

- `kbd/test/nested-picker-offset.test.mjs` — the depth-3 offset, descriptor preservation, the
  clone, and the overlay landing on the remote pixels (iOS).
- `kbd/test/nested-picker-offset-android.test.mjs` — the same chain in an embedded Android viewer,
  plus the adjustResize cell: when the WebView shrinks the layout viewport for the soft keyboard, a
  temporal control that moves behind the keyboard retires its hit target instead of leaving an
  invisible one, and gets it back on dismissal.
- `mobile-harness/cases/nested-webview-dob-picker.pair.json` — the device pair. Its fixture is the
  three-document chain (`nested-webview-dob-picker.html` → `nested-webview-dob-relay.html` →
  `nested-webview-dob-form.html`); the input's `#dcfce7` is the only region of that colour in any of
  the three, and the green marker is painted by the OUTER page, so it can only appear if the chosen
  date reached the depth-3 input and its `change` event travelled back up two frame boundaries.

### Test result

Both platforms run the case green in the WebView shell, against a LiveView session with the
fixture chain loaded in the remote browser.

What the publisher put on the wire (`/kbdstate`, remote viewport 402x778):

```json
{"k":"x5a4gg:1","t":"date","r":{"x":42,"y":231,"w":278,"h":64},"v":"1994-03-17","min":"1900-01-01","max":"2008-12-31"}
```

Measured in the page at the same moment: the input's rect inside its OWN frame is `(14, 73)`, the
relay iframe sits at `(16, 116)`, and the form iframe at `(12, 42)` within it — an accumulated
offset of `(28, 158)`. `14+28 = 42` and `73+158 = 231`, so the published rect carries the whole
chain. Unshifted it is `(14, 73)`: 158px above the field, more than two field heights.

| | iOS 26.3, iPhone 17 Pro | Android 14, Pixel API 34 |
| --- | --- | --- |
| Picker | iOS calendar, March 1994, 17 selected | Material dialog, Thu Mar 17 1994 |
| Day | `label: "18"` | `text: "18"` |
| Confirm | checkmark, accessibility label `Done` | `android:id/button1` (SET) |
| Committed | `03/18/1994`, depth-1 marker | `03/18/1994`, depth-1 marker |

Both bounds ride through: the calendar opens on the field's own value and honours `min`/`max`.

### The fixture's date input cannot use width:100%

WebKit computes `input[type=date]` as content-box whatever the author asks — `box-sizing: border-box`
on the element is ignored, and `getComputedStyle(el).boxSizing` still reports `content-box` with two
author rules setting it. So `width: 100%` overflows its container by the
control's own padding and border and the field is clipped by the frame edge, and `width: auto` is
no help because a form control's auto width is its intrinsic size. The fixture subtracts the box
explicitly. `native-date-picker.html` has the same latent overflow.
