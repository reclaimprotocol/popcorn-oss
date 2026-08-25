# Native select proxy POC

## Decision

The approach is feasible. A real `<select>` in the local Safari LiveView layer can
be aligned over a select rendered in the streamed framebuffer. Safari then owns
the option UI, so it looks and behaves like an iOS control. The local `change`
event can be forwarded to the corresponding remote select.

The runnable plain HTML/JS proof is
[`fixture/poc/native-select-overlay.html`](../fixture/poc/native-select-overlay.html).
It deliberately uses a mock framebuffer so the browser boundary is unambiguous.

## Tested result

The iPhone 17 Pro simulator test completed this flow:

1. Detect the READY marker and start recording.
2. Tap the visible framebuffer-style select at `(204, 383)`.
3. Confirm an iOS option popover appears, anchored to that field.
4. Tap `Business` at `(200, 405)`.
5. Confirm the page receives `change`, updates its visible remote-state mock, and
   renders the green success marker.

Evidence is in
[`artifacts/2026-08-21T23-45-50-087Z-native-select-overlay-poc`](../artifacts/2026-08-21T23-45-50-087Z-native-select-overlay-poc).

The important CSS finding is that `opacity: .01` did not activate the picker on
this Safari build. The working proxy remains rendered and hit-testable, while its
background, text, border, and native appearance are transparent. It also sits
above the framebuffer with an explicit `z-index`.

## LiveView implementation and result

The proxy is now implemented. Eligible visible single-select controls publish a
bounded descriptor over `/kbd`; the touch viewer maps a transparent, real local
`<select>` over the framebuffer control; and the chosen original option index is
sent through a strictly allowlisted viewer-to-publisher control message. The
extension revalidates the active tab, frame, current advertised descriptor, live
element, and enabled option before dispatching the remote `input` and `change`
events. Unsupported, oversized, stale, multiple, and listbox selects keep the
existing remote picker fallback.

The first real LiveView run exposed a transport-age bug: a static page had not
sent a frame report for six seconds, so the background rejected a choice even
though it was still advertising that same descriptor to the viewer. Routing now
validates against the currently advertised descriptor instead of applying the
geometry-cache expiry to an offered control. A delayed integration test waits
past the old cutoff and proves the choice still commits.

The final iPhone 17 Pro pair is
[`artifacts/2026-08-22T00-19-05-347Z-native-select-picker-pair`](../artifacts/2026-08-22T00-19-05-347Z-native-select-picker-pair).
Both Safari and LiveView open the compact iOS popover, choosing `Business`
produces the visible remote success marker, and the relative transition delta is
1.70% against a 20% limit. The report includes raw and touch-annotated videos for
both sides.

## Dynamic options test and fix

Dynamic data was tested with the native picker already open. After 2.2 seconds,
the page inserts `Team` before `Business`, moving `Business` from option index 1
to index 2. The test then selects the visible `Business` row and requires the
remote page's green `BUSINESS SELECTED` marker.

The pre-fix pair
[`artifacts/2026-08-22T00-43-17-578Z-native-select-dynamic-options-pair`](../artifacts/2026-08-22T00-43-17-578Z-native-select-dynamic-options-pair)
failed in LiveView while Safari passed. Safari updated the open picker in place;
LiveView dismissed it because the viewer removed and recreated its transparent
local `<select>` whenever the option shape changed.

The viewer now replaces the option children on the existing local `<select>`.
It preserves the focused element—the native picker's owner—while updating labels,
values, disabled state, optgroups, and the selected option. The unchanged
post-fix pair
[`artifacts/2026-08-22T00-57-25-250Z-native-select-dynamic-options-pair`](../artifacts/2026-08-22T00-57-25-250Z-native-select-dynamic-options-pair)
passes. Its `picker-after-data-update` evidence shows the still-open native picker
with `Personal`, newly inserted `Team`, moved `Business`, and `Enterprise`; the
following selection reaches the green success marker.

## Long-list coverage

The pre-fix 195-country run
[`artifacts/2026-08-22T09-44-37-455Z-native-select-all-countries-pair`](../artifacts/2026-08-22T09-44-37-455Z-native-select-all-countries-pair)
was functionally correct but exposed a presentation failure: the 60-option cap
forced LiveView onto Popcorn's searchable HTML sheet while Safari used the iOS
native popover.

The complete country descriptor measures about 5 KiB, comfortably inside the
background's 24 KiB merged-state budget and the hub's 32 KiB frame limit. The
per-select and per-frame option budgets are now 250. The existing wire guard is
unchanged: if page-controlled labels make the merged state too large, it drops
the complete native-select descriptor set atomically and marks it truncated,
leaving the functional in-page picker fallback instead of losing keyboard state
or exposing a partial list.

The unchanged post-fix case
[`artifacts/2026-08-22T10-18-38-316Z-native-select-all-countries-pair`](../artifacts/2026-08-22T10-18-38-316Z-native-select-all-countries-pair)
passes with the iOS native popover on both Safari and LiveView. It performs 24
recorded swipes, reaches Zimbabwe, commits option index 194, and renders the
green success marker. The relative transition delta is 0.47%. A container-level
integration test separately proves that all 195 descriptors cross `/kbd` and
that the final choice produces the remote `input` and `change` events.

## Required follow-up cases

- A select that moves while the page scrolls or the LiveView fit changes.
- Disabled options and disabled/hidden optgroups.
- Same-origin and cross-origin iframe selects.
- Multiple visible selects and rapid switching between them.
- Navigation/re-render invalidating the old stable key.
- `multiple` and `size > 1` controls, which should initially use the fallback.
- Privacy and payload limits for large or sensitive option lists.

The original standalone POC changes no product code. The LiveView implementation
described above adds the descriptor transport, local native control, selection
relay, and focused-element-preserving dynamic update behavior to Popcorn.
