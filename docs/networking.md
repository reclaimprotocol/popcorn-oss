# Browser Networking

Popcorn streams interactive browser sessions over **VNC / live view**. Chromium
runs headed on a virtual X display inside each browser pod, and its framebuffer
is streamed to the client as VNC-over-WebSocket through the gateway.

Everything is TCP and WebSocket through the gateway; the browser node and
GameServer are never exposed directly to clients.

## How Streaming Works

Inside the browser pod (the minimal-vnc "Popcorn Browser" image running Tilion
Fortress Chromium):

1. Chromium renders to a virtual X display.
2. `Xvnc` binds the RFB server on `127.0.0.1:5900` (localhost only).
3. `novnc-proxy` bridges VNC to an HTTP/WebSocket surface on port `6080`,
   serving the WebSocket at `/websockify` and the noVNC client at
   `liveview.html`.
4. The gateway proxies `/liveview-ws/<sessionId>/<token>` to the pod's `6080`
   port (rewriting to `/websockify`), and proxies `/liveview/<sessionId>/<token>/...`
   to the pod's HTTP surface for static assets.
5. The client's browser loads the noVNC client (`liveview.html`) and connects
   the WebSocket back through the gateway.

The RFB port `5900` and Chromium's DevTools upstream never leave the pod. Only
the gateway is public, and only `6080` is routed for streaming.

## Session URL Fields

The control-plane response keeps the compatibility field names `vncUrl` and
`vncWsUrl`. Their values point at the live-view routes:

```text
vncUrl:   {baseUrl}/liveview/{sessionId}/{token}/liveview.html?resize=scale&reconnect=1&reconnect_delay=2000
vncWsUrl: {wsBase}/liveview-ws/{sessionId}/{token}
```

The route shapes are:

```text
GET  /liveview/<sessionId>/<token>/liveview.html   -> noVNC client + static assets
WS   /liveview-ws/<sessionId>/<token>              -> proxied to pod :6080/websockify
```

The gateway also accepts the legacy `/vnc-ws/<sessionId>/<token>` prefix and
maps it to the same route. See
[`images/minimal-vnc-desktop/README.md`](../images/minimal-vnc-desktop/README.md)
for the full HTML/route contract.

## Container Port And Route Key

The browser image serves noVNC HTTP/WebSocket on container port `6080`
(`NOVNC_PORT`). The browser fleet exposes it as a `None`-policy TCP port when
VNC streaming is enabled:

```yaml
ports:
  - name: novnc
    containerPort: 6080
    portPolicy: None
    protocol: TCP
```

The platform route key for this image is `liveview`, mapped to `6080`. The
gateway resolves `/liveview-ws/<sessionId>/<token>` by looking up the
`liveview` route (falling back to the legacy `vnc` route key) in Redis, then
proxies to `<pod-ip>:6080/websockify`.

Set the fleet streaming mode to `vnc` with `streaming.mode` in the browser-fleet
chart.

## Local Kind

The local Kind setup needs no special network plumbing for live view — streaming
is plain TCP/WebSocket, so nothing beyond the gateway route is required.

- Set `LOCAL_BROWSER_STREAMING_MODE=vnc`. The Makefile wires the `liveview`
  route to `6080` and returns `/liveview/.../liveview.html` in the session URL.

## Troubleshooting

If the live-view page loads but the stream does not connect, the failure is
almost always one of two things.

**1. The TCP route to `6080` is missing or wrong.**

Check that the session has a `liveview` (or legacy `vnc`) route in Redis and
that the pod is exposing `6080`:

```bash
kubectl -n popcorn get gameservers -o wide
kubectl -n popcorn logs <browser-pod-name> -c browser-runtime --tail=200
```

A missing route surfaces as `404` from the gateway on
`/liveview-ws/<sessionId>/<token>`.

**2. The app window is not ready yet.**

The noVNC and CDP listeners bind early, but their HTTP and WebSocket routes
return `503` until Chromium opens an X window matching the readiness pattern
(`READY_WINDOW_PATTERN`, which defaults to matching Chromium/Chrome). Until the
app window is visible, the live-view route is intentionally unhealthy so it
never reports ready before the browser has launched.

If you see `503` on the live-view route, wait for Chromium to start, or check
`xvnc.log` / `app.log` under the pod's log directory (`/var/log/app` by
default) for a startup failure. `READY_TIMEOUT` bounds how long startup waits
for the app window before failing.
