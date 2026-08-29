# An embedded view inside a web view

A third-party view arrives as a widget embedded in one of our pages, and in the
app that matters here that page runs inside a host app's web view rather than in
a browser. This case compares that surface directly against the same page
through Popcorn LiveView.

Files:

| File | Role |
| --- | --- |
| `cases/webview-embed-widget.pair.json` | The pair. Names the `webview-shell` launch target and nothing else. |
| `fixture/cases/webview-embed-widget.html` | The page under test: embeds the widget and paints visible phase markers. |
| `fixture/cases/webview-embed-stub-widget.html` | A deterministic stand-in so the case runs without an embed target. |
| `fixture/cases/webview-embed-target.local.js.example` | Template for the ignored local config that points the fixture at an embed target. |

## Point the fixture at a widget

The fixture loads `webview-embed-target.local.js` if it is present. That file is
gitignored, so no program identifier or host ends up in a case or in git.

Against a real program:

```bash
cp fixture/cases/webview-embed-target.local.js.example fixture/cases/webview-embed-target.local.js
# set EMBED_VIEW_URL to your program's verification URL
```

Against the stub, for a run that needs no third-party account:

```bash
echo "window.EMBED_VIEW_URL = './webview-embed-stub-widget.html';" \
  > fixture/cases/webview-embed-target.local.js
```

With neither, the page paints a red `NO VERIFICATION URL CONFIGURED` block and
the run fails at its first marker instead of quietly testing nothing.

The fixture embeds the verification URL in a plain iframe by default, which
needs no third-party script. Set `EMBED_VIEW_SDK_URL` to embed through the provider's
JS library instead — the fixture calls `embedSdk.loadInlineIframe` and falls back
to the plain iframe if the library cannot be loaded or its shape differs. Both
paths are observed identically, so the case does not depend on which one is
used. A `?verificationUrl=` / `?jslibUrl=` query overrides either, which is
handy when driving the page by hand.

## What the markers mean

Four marker blocks sit across the top of the page. Each has a unique colour so
the harness can wait for one without matching another.

| Marker | Colour | Fires when |
| --- | --- | --- |
| fixture ready | `#00c8ff` | The page resolved its configuration and embedded the widget |
| widget loaded | `#ffd400` | The iframe's `load` event fired |
| widget active | `#ff7a00` | The widget posted its first message to the page |
| widget stepped | `#00ff6a` | The widget reported a different height **after** the native tap |

Everything is observed from the embedding page only: the iframe's `load` event,
`postMessage` from the widget's origin, and the height the widget reports. The
fixture never reaches into the third-party document, and it assumes no
undocumented callback. A step change is read as a height change because an
auto-height widget reports its height to its embedder as it moves between
steps — the fixture applies that height, the way an embedder does, which is also
what makes the change visible in the framebuffer.

A widget that never posts a message will not reach the `widget active` marker.
That is a real finding about the surface, not a harness failure; adjust the
fixture if the widget you embed signals differently.

## The native action

`#6a007a` is the continue control, and it is the only region on the page in that
colour. The harness resolves a `tapRelativeToColor` action from the centroid of
**every** matching pixel, so a second region in the same colour — a container
border, for instance — drags the tap off the control and the step never fires.
When editing this fixture, keep marker and action colours unique.

## Limits worth knowing before writing more of these

- Neither shell offers a working file chooser. The Android shell cancels the
  request explicitly; iOS presents its own document picker, which puts system UI
  in the framebuffer. A case that reaches a document-upload step has to stop
  before it.
- Camera and microphone permissions are granted automatically by both shells, so
  a capture-based verification step will not stall on a permission prompt.
- Both sides of the pair use the same shell. A browser's URL bar changes the
  usable viewport height, which would make the comparison meaningless.

## The soft keyboard is where a web view stops behaving like a browser

`cases/webview-bottom-input-keyboard.pair.json` pins this. Measured on an
emulator (Pixel 7, API 34, WebView 113) by tapping an input pinned to the bottom
of the page:

| Surface | `innerHeight` | `visualViewport.height` | `offsetTop` | Field still visible |
| --- | --- | --- | --- | --- |
| Chrome | 783 → 783 | 783 → 471 | 0 → 312 | yes |
| shell, `softInput=resize` (default) | 839 → **527** | 839 → 527 | 0 | yes, but the page reflowed |
| shell, `softInput=pan` | 839 → 839 | 839 → 839 | 0 | **no — the keyboard covers it** |

A browser keeps the layout viewport and shrinks only the visual viewport. A
WebView never does that: `resize` shrinks the **layout** viewport so the page
reflows, and `pan`/`nothing` leave the page unable to see the keyboard at all,
so a bottom-pinned field ends up behind it.

The fixture reports both facts as separate markers, so one run tells you which
you got:

| Marker | Colour | Meaning |
| --- | --- | --- |
| page ready | `#00c8ff` | fixture loaded |
| layout reflow | `#ffd400` | the layout viewport lost a keyboard's height while the visual viewport did not scroll — the adjustResize signature |
| field visible | `#00ff6a` | the field that was tapped is still fully above the keyboard |

Two things follow for the viewer, both now covered by
`kbd/test/fit-webview-kbd.test.mjs`:

1. A keyboard open in a WebView is the only thing that fires a window `resize`,
   which is the same event `fit.js` uses to re-request the remote desktop size.
   Re-requesting it mid-typing reflows the remote page, re-creates the focused
   field and closes the keyboard — reported as "it keeps closing the keyboard
   when I enter the password".
2. So the keyboard-shrunk height must never define the remote viewport, for any
   caller — not just the resize path.

## Nesting: what it does and does not explain

Reported symptom, two or three frames deep inside a WebView: tapping a password
field opens the keyboard and it closes again, repeatedly.

Measured directly on the emulator with a three-level chain (outer → relay →
inner page holding a bottom-pinned input), tapping the input at depth 3:

```
{"what":"load",        "active":0,"inner":839,"vvh":839,"vvtop":0}
{"what":"pointerdown", "active":0,"inner":839,"vvh":839,"vvtop":0}
{"what":"focus",       "active":1,"inner":839,"vvh":839,"vvtop":0}
{"what":"resize",      "active":1,"inner":527,"vvh":527,"vvtop":0}
{"what":"vv-resize",   "active":1,"inner":527,"vvh":527,"vvtop":0}
```

Two things that follow:

- **Nesting itself is not the cause** for the keyboard. It *was* the cause for
  the temporal pickers, which is a separate defect in the same cell: their rects
  were the one descriptor kind that never got the accumulated frame offset. See
  [NATIVE_DATE_PICKER.md](NATIVE_DATE_PICKER.md) and
  `cases/nested-webview-dob-picker.pair.json`.
- **For the keyboard:** The field keeps focus, the keyboard stays
  up, and no blur arrives — with or without the frame-focus claim that
  `kbd-autofocus.js` makes inside the gesture (`window.focus()` when
  `window !== window.top`). Both variants behaved identically.
- **The layout viewport shrinks at every level** (839 → 527 here). That resize
  reaches the viewer's frame exactly as it would at depth 1, which is what made
  `fit.js` re-request the remote desktop size mid-typing. So the nested report
  and the single-level one share one cause, and one fix covers both.

The detector layer is also correct in this cell, which is the awkward one: the
WebView shrinks both viewports together, so `popcorn-host.js` `measure()` takes
its `|innerH - vv.height| < 50` branch and heartbeats `occludedBottom: 0` for
the whole keyboard session. `kbd/test/webview-nested-kbd.test.mjs` pins that the
keyboard is still detected locally, that those zeros never tear it down, and
that a real dismissal still works.

## What a three-level embed chain measures in a WebView

Reproduced on the emulator with the real SDK at both host levels — level 1
`PopcornHost.attach` in measure mode, level 2 the same SDK relaying, level 3 a
viewer stand-in that reports every `POPCORN_HOST_GEOMETRY` it receives — loaded
in the Android WebView shell, tapping a password field at depth 3:

| Stage | Before | After |
| --- | --- | --- |
| keyboard closed | `visibleHeight=839 occludedBottom=0` | same |
| keyboard open | `visibleHeight=527 occludedBottom=0` | `visibleHeight=527 occludedBottom=312` |
| dismissed | — | `visibleHeight=839 occludedBottom=0` |

Geometry *does* relay down through the middle frame; that was never the problem.
The problem was that the embedder went blind: an adjustResize WebView shrinks the
layout viewport, so its `innerHeight` and `visualViewport.height` move together,
`measure()` took its "both viewports agree, this is ordinary chrome geometry"
branch, relearned its baseline down to the shrunken height, and reported
`occludedBottom: 0` on every heartbeat for the whole keyboard session — in the
one cell where the viewer's own detectors are weakest.

Two consequences, both fixed:

- `host/popcorn-host.js` now reads a large height-only loss against the learned
  baseline as the keyboard, **gated on the viewer's `POPCORN_KBD_STATE` raise** —
  a split-screen drag produces identical numbers and the width guard cannot tell
  them apart, so without that gate the host would report a phantom keyboard.
- `kbd/watchdog.js` counts the viewer's own layout-resize latch as occlusion
  evidence, because in this cell no authoritative rect exists anywhere else.

Covered by `kbd/test/host-sdk-layout-keyboard.test.mjs` (the host side, driven in
a stub window) and `kbd/test/watchdog-dropped-focus.test.mjs` (the viewer side).
