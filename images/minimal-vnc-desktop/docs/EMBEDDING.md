# Embedding the live view

`liveview.html` is designed to be opened directly on a phone **and** to be embedded
in an `<iframe>` by a host application (the Reclaim portal), including when that
host is itself embedded in a customer's page by our SDK:

```
customer page   [SDK]      measures the keyboard, posts geometry down
  portal        [app]      relays geometry down, consumes viewer events
    liveview    [viewer]   applies the lift, streams pixels
```

The viewer stays inside its own origin, so the pod's JS never runs in the host's
document, and the viewer always ships with the pod image it talks to — the `/kbd`,
`/input` and `/emulate` contracts are internal and unversioned, so viewer/pod skew
is not a thing that can happen.

What an embedded viewer cannot do for itself is measure the **soft keyboard**:
`navigator.virtualKeyboard` stays mute in a cross-origin iframe unless the embed
carries `allow="virtual-keyboard"`, and a subframe's `visualViewport` does not
reliably shrink when the keyboard opens. Without a keyboard rect there is no lift —
`currentVisibleBottom()` falls back to `innerHeight`, the focused remote field sits
behind the keys, and the paste button lands on top of them. So the host measures and
posts the rect in. Top-level `visualViewport` is not permission-gated, which is why
this works with no cooperation from the embedding page.

## Host script

`host/popcorn-host.js` implements the host side. One script, two roles, resolved
automatically — the same call is correct at every level:

```js
const host = PopcornHost.attach(iframeEl, { childOrigin: 'https://pod.example' });
host.on('frame', () => hideLoadingCover());
host.on('kbdstate', ({ active }) => setChromeHidden(active));
host.toggleMagnify();
host.destroy();
```

| Resolves to | When |
| --- | --- |
| `MEASURE` | Top-level — nobody above us can see more than we can. |
| `RELAY` | Embedded and the parent is posting geometry: forward its numbers, not our possibly-blind ones. |
| `MEASURE` (fallback) | Embedded but no upstream geometry within 2 s — a hand-rolled embed with no SDK above us. Better a local guess than no lift. |

It switches back to `RELAY` if an upstream host appears late (async SDK load), and
`.on()` listeners fire in every mode, so a relaying frame still drives its own UI
while forwarding. Read the clipboard in the **host** and send it with `host.paste()`:
a nested cross-origin frame is the most restricted place to ask for that permission.

`host/test-min.html` (bare iframe) and `host/test-host.html` (same, plus a debug
panel and buttons) are runnable harnesses; `?nest=1` on the latter builds the full
three-level chain, `?noorigin=1` reproduces the fail-closed misconfiguration.

To test on a real phone, `scripts/tunnel.sh --run --embed` puts the harness on its
own quick tunnel — a **different https origin** from the viewer, which is the whole
point: a same-origin embed would pass even with the postMessage bridge, the origin
checks or the Permissions-Policy delegation broken. It prints both URLs, and the
harness passes viewer query params (`quality`, `smooth`, `iosbridge`, …) straight
through, so on-device A/B needs no rebuild.

## Layout: the iframe must own the viewport

The viewer iframe must be a full-viewport `position: fixed` box, with host chrome
**layered over** it:

```css
iframe { position: fixed; top: 0; left: 0; width: 100%; height: 100%; border: 0; }
.chrome { position: fixed; z-index: 10; /* … */ }
```

Do **not** make it a flex/grid sibling that shrinks it, and do not put an
`overflow: auto` sibling in the same stacking context. Verified on iOS Safari: with
the iframe as a flex child next to a scrollable panel, the stream rendered visibly
blurry while every measurable value was identical to a sharp top-level tab —
framebuffer 980 px, canvas 393 CSS px, `zoom=1.00`, same JPEG quality. WebKit
rasterises the iframe's compositing layer below device scale in that shape.

Two related notes, since "the stream looks blurry" invites the wrong fixes:

- Encoder quality is **not** the lever when the page is scaled down: at the
  whole-page fit scale the downscale destroys glyph detail before encoding, so
  `?quality=9` changes nothing. Compare embedder layouts first.
- Framebuffer density cannot be raised with CDP `deviceScaleFactor`: it crops
  rather than supersamples, because the framebuffer is the X screen size (see the
  note at `kbd/fit.js:248`).

The host page should also carry `overscroll-behavior: none` and constrain
`touch-action`, or an outer-page pinch shrinks `visualViewport` and is misread as a
keyboard.

## iframe attributes

```html
<iframe src="…/liveview.html?magnify=1&parentOrigin=https%3A%2F%2Fportal.example"
        allow="virtual-keyboard; clipboard-read; clipboard-write"></iframe>
```

`allow` must be granted at **every** hop (customer → portal → liveview);
Permissions Policy delegates through nesting but each level must opt in. With host
geometry flowing, `virtual-keyboard` is redundancy rather than a requirement — but
grant it anyway, because these attributes fail **silently**, which is how a whole
class of "no keyboard geometry on Android" bugs shipped once before (see
`MOBILE_KBD_BACKLOG.md` batch 17). A restrictive `Permissions-Policy` **header** on
the top-level page can block delegation regardless of the attribute; nothing can be
done about that beyond falling back to `zoomToField`.

Sandbox flags fail silently in the same way — audit them if focus or the clipboard
misbehave.

## Protocol

Wire version is `HOST_PROTOCOL` in `kbd/host-bridge.js`, announced in
`POPCORN_HELLO`. Bump it on any breaking shape change; a host that sees a version it
doesn't understand should refuse to drive the viewer rather than mis-drive it.

**Viewer → host**

| Message | Payload | Meaning |
| --- | --- | --- |
| `POPCORN_HELLO` | `protocol`, `magnify`, `vk`, `vv`, `unsupported` | Sent at boot. `vk: false` means host geometry is load-bearing for the lift. |
| `POPCORN_CONNECT` | — | RFB handshake completed. Not yet a visible stream. |
| `POPCORN_FRAME` | `width`, `height` | First **real** paint. Gate a loading cover on this, not on `CONNECT`. |
| `POPCORN_DISCONNECT` | `willReconnect`, `everConnected` | `willReconnect` separates a recoverable blip from a teardown. |
| `POPCORN_ERROR` | `reason` | Currently `unreachable` (connect blocked/failed before any success). |
| `POPCORN_KBD_STATE` | `active`, `reason` | Sent on raise **intent**, not on the geometry confirm — iOS can confirm a second later, and host chrome must move before the keys arrive. |
| `POPCORN_VIEWPORT` | `visibleHeight`, `occludedBottom` | The viewer's own view of its viewport; position host chrome from this. |
| `POPCORN_INPUT_DRIFT` | (see `field-session.js`) | Local/remote field text diverged. |

**Host → viewer** (ignored unless `?parentOrigin=` matches and the sender is the
real parent — unauthenticated geometry could wedge the lift, and unauthenticated
paste could type into the remote session)

| Message | Payload | Meaning |
| --- | --- | --- |
| `POPCORN_HOST_GEOMETRY` | `visibleHeight`, `occludedBottom` | Authoritative keyboard rect. Outranks every local detector. |
| `POPCORN_TOGGLE_MAGNIFY` | — | Drive the magnify/fit toggle from host UI. |
| `POPCORN_TOGGLE_KBD` | — | Drive the keyboard toggle from host UI. |
| `POPCORN_PASTE` | `text` | Insert into the focused remote field. |

Geometry handling rules that matter if you write your own host:

- **Post on change and on a heartbeat.** Samples go stale after 8 s, at which point
  the viewer falls back to its local detectors — so a dead host degrades instead of
  freezing the lift. `popcorn-host.js` heartbeats every 3 s.
- **`occludedBottom: 0` is "no keyboard observed", not "dismiss".** The viewer only
  treats it as a dismissal once it has seen a real occlusion for that keyboard and
  the keyboard is not mid-open. Without that rule a heartbeat lands in the window
  right after a raise and tears the keyboard down — observed on device as "the
  keyboard closes and I have to tap the field twice".
- **Malformed samples are dropped** (non-finite, non-positive height, negative
  occlusion), so a host measuring mid-transition cannot apply a bogus lift.

Behaviour is locked by `kbd/test/host-geometry.test.mjs`.

## Query parameters

Beyond the usual viewer parameters (`magnify`, `quality`, `compression`, `resize`,
`view_only`, `password`, `path`, `reconnect`…):

| Parameter | Purpose |
| --- | --- |
| `parentOrigin` | Host origin. **Required** for any host→viewer message to be accepted. |
| `iosbridge=1` | Use the iOS temp-readonly raise bridge even when embedded. Off by default: the direct-focus branch is what has shipped embedded, and only device evidence should change that. |
| `stateless=1` | `/kbd` becomes advisory: raise is optimistic and local, dismiss only from real local events. Note it also disables the recovery **re-raise**, so a local dismiss then needs a fresh tap. |
| `kbddebug=1` | On-screen trace (also mirrored to `/klog`). |

## Diagnosing on a device

The layer ships its structural trace to `/klog`, so it lands in the pod's log —
no on-device capture:

```bash
docker logs <container> 2>&1 | grep kbd-client
```

Useful lines: `setup env:` (platform, `vk`/`vv` availability, `top=0` when
embedded), `emulate WxH@dsf`, `fit-to-width p1 layout=`, `boot fit-reveal z=`,
`TAP … hit= kbd= rects=`, `host geom occ=`, `proxy blur -> …`, and
`-> raiseKeyboard(reason)` / `-> dismissKeyboard`. A keyboard problem is almost
always readable straight from that sequence.
