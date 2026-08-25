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
