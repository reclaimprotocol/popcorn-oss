package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// kbdHub is a tiny fan-out relay for soft-keyboard focus signals. The proxy
// browser extension (running inside the remote Chromium) publishes the current
// editable-focus state — {"editable":true} / {"editable":false} — whenever an
// editable element gains or loses focus. Every connected viewer receives it and
// raises or dismisses the mobile on-screen keyboard.
//
// Design goals, in order:
//   - Keep focus detection entirely OFF the CDP path (no automation signal).
//   - Survive lossy / high-latency mobile networks: signals are absolute state
//     (idempotent), so a dropped or reordered message is self-correcting on the
//     next event. A freshly (re)connected viewer is resynced immediately from a
//     cached last-state, so a dropped connection never leaves a wedged keyboard.
//   - Never let one slow/dead client stall the others: each client has its own
//     writer goroutine fed by a single-slot coalescing mailbox. Because state is
//     idempotent, coalescing to "latest" loses nothing meaningful.
type kbdHub struct {
	mu         sync.Mutex
	clients    map[*kbdClient]struct{}
	lastState  []byte
	publishers int // connected ?role=pub clients; lastState is only live while > 0

	// Current JS dialog, if the page has one open (see broadcastDialog). Cached
	// like lastState so a viewer that connects — or reconnects mid-dialog on a
	// flaky link — is told about a dialog that is already blocking the page.
	lastDialog []byte
	// Current foreground popup window, if any (see broadcastPopup). Cached for
	// the same reason as lastDialog and then some: a popup OUTLIVES the viewer
	// connection — it is a real window on the remote side — so a viewer that
	// reloads mid-OAuth must still be told there is a window to close, or the
	// close button vanishes and the session is stuck on accounts.google.com.
	lastPopup []byte
	// onViewerMsg receives the small control frames a VIEWER may send (currently
	// a dialog reply or a popup-close request). Viewers stay unable to broadcast
	// to other viewers; this is a server-mediated request, not a relay.
	onViewerMsg func(payload []byte)
	// onPublisherMsg receives control frames from the PUBLISHER that are for the
	// server rather than for viewers (see readLoop). Never fanned out.
	onPublisherMsg func(payload []byte)
	// mirrorOn is true while at least one connected viewer has ASKED for field-value
	// mirroring (?mirror=1). The extension publishes the focused field's text only
	// while this is set, so by default this channel carries structure — rects,
	// hints, value LENGTH — and never what the user typed into a search box, an
	// email field or a recovery answer. State, not a relay: it is recomputed from
	// the connected clients and pushed to the publisher, so a mirror viewer leaving
	// turns the value stream back off.
	mirrorOn bool
	// bridgeToken is handed to the PUBLISHER (the extension) the moment it
	// connects, and to nobody else. It authenticates the extension's dialog
	// bridge (see dialog.go): the endpoint is reachable by the remote page too, and
	// without a gate a hostile page could make the viewer draw arbitrary chrome
	// outside the page area. Delivered on this socket because the extension already
	// holds it, so no new distribution channel is needed — and it lands in the
	// extension's isolated world, which page script cannot read.
	bridgeToken string
}

func newKbdHub() *kbdHub {
	return &kbdHub{clients: make(map[*kbdClient]struct{})}
}

// viewers counts the connected non-publisher clients. The dialog path consults it:
// an alert with nobody watching has to be accepted immediately (no one can ever
// acknowledge it), while an alert with a viewer attached stays blocking until the
// user taps OK. See the javascriptDialogOpening handler in emulate.go.
func (h *kbdHub) viewers() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	n := 0
	for c := range h.clients {
		if !c.publisher {
			n++
		}
	}
	return n
}

func (h *kbdHub) full() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.clients) >= kbdMaxClients
}

// kbdWriteDeadline bounds a single frame write so a stalled TCP send on a bad
// network is detected and torn down instead of pinning the writer goroutine.
const kbdWriteDeadline = 10 * time.Second

// kbdReadDeadline drops a client that has gone silent (no data, no pong) for
// this long — catches half-open connections that mobile networks leave behind.
const kbdReadDeadline = 70 * time.Second

// kbdPingInterval keeps NAT/proxy paths warm and gives us liveness feedback.
const kbdPingInterval = 30 * time.Second

// kbdMaxClients bounds concurrent connections so a flood can't exhaust memory.
const kbdMaxClients = 64

// kbdMaxPayload caps a /kbd frame, rejected from the length header so an oversized claim costs no allocation.
// Measured worst case is ~12 KiB (60 rects + a 2048-char CJK val); 8 KiB silently dropped those states.
// Still bounds the flood: kbdMaxClients * 32 KiB is 2 MB, against the 4 GiB the 64MB ceiling allowed.
const kbdMaxPayload = 32768

// kbdPubOriginEnv pins the publisher origin to one exact value, e.g. the extension's
// chrome-extension://ankpocoakajannlnbiahpdjfkieigoff. Unset, any chrome-extension origin is accepted.
const kbdPubOriginEnv = "KBD_PUB_ORIGIN"

// publisherAllowed gates ?role=pub, which is a TRUST level (fan-out to every viewer + the dialog-bridge
// token) and was previously self-asserted. Loopback excludes viewers, which reach :6080 from outside the pod;
// the browser-stamped Origin excludes the page, which can reach loopback but cannot forge that header.
// An absent Origin passes: page script always has one, so it can only be a local non-browser client.
func publisherAllowed(r *http.Request) bool {
	if !loopbackAddr(r.RemoteAddr) {
		return false
	}
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if pinned := strings.TrimSpace(os.Getenv(kbdPubOriginEnv)); pinned != "" {
		return origin == pinned
	}
	return origin == "" || strings.HasPrefix(origin, "chrome-extension://")
}

func loopbackAddr(remoteAddr string) bool {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		host = remoteAddr
	}
	// Strip an IPv6 zone ("fe80::1%eth0") before parsing.
	if i := strings.IndexByte(host, '%'); i >= 0 {
		host = host[:i]
	}
	ip := net.ParseIP(strings.Trim(host, "[]"))
	return ip != nil && ip.IsLoopback()
}

// Log the first few rejections only — enough to diagnose a broken extension, not a disk-fill lever.
// A wrong KBD_PUB_ORIGIN makes the extension retry hard: it hit this limit in seconds during testing.
var kbdPubRejects int32

const kbdPubRejectLogLimit = 10

func logPublisherReject(r *http.Request) {
	if n := atomic.AddInt32(&kbdPubRejects, 1); n <= kbdPubRejectLogLimit {
		log.Printf("kbd: rejected role=pub from %s (origin %q)", r.RemoteAddr, r.Header.Get("Origin"))
	}
}

type kbdClient struct {
	conn    net.Conn
	writeMu sync.Mutex

	// publisher clients (the browser extension, connecting with ?role=pub AND
	// passing publisherAllowed) are the only ones allowed to broadcast focus
	// state. Viewers are receive-only, so a connected viewer can't inject fake
	// signals to other viewers.
	publisher bool

	// wantsMirror: this viewer asked for field-value mirroring. Guarded by the
	// hub's mutex (the hub aggregates it), not by mailMu.
	wantsMirror bool

	mailMu  sync.Mutex
	pending []byte // latest focus state awaiting write (coalesced)
	// Dialogs get their OWN slot. Focus state is idempotent, so coalescing to
	// "latest" loses nothing — but a dialog arriving just before a focus signal
	// would be overwritten in a single-slot mailbox and the viewer would never
	// learn the page is blocked. Two slots, dialog drained first.
	pendingDialog []byte
	// Popup state gets a third slot for the same reason. A popup can raise a
	// dialog (an OAuth window running a confirm()), so the two states genuinely
	// coexist and sharing a slot would drop whichever arrived first.
	pendingPopup []byte
	// Control frames for the PUBLISHER (dialog-bridge token, mirror on/off). A
	// short QUEUE rather than a coalescing slot: these are distinct one-shot
	// messages, so the newer one must not overwrite an undelivered older one.
	pendingCtl [][]byte
	notify     chan struct{}
	closed     chan struct{}
}

// kbdMaxCtlQueue bounds the publisher control queue. Only the proxy itself writes
// to it and there are two message kinds, so this is a leak guard, not a limit
// anything legitimate reaches.
const kbdMaxCtlQueue = 8

func (h *kbdHub) add(c *kbdClient) {
	h.mu.Lock()
	h.clients[c] = struct{}{}
	if c.publisher {
		h.publishers++
	}
	// Resync a VIEWER to the current focus state so a reconnect never leaves the
	// keyboard stuck up or down — but ONLY while a publisher (the extension) is
	// actually connected. If the extension died (MV3 worker torn down, tab
	// closed) with editable:true cached, replaying it would wedge every new
	// viewer's keyboard up with no live source left to ever dismiss it. With no
	// publisher, a new viewer just starts keyboard-down; the extension re-publishes
	// absolute state on reconnect. Already-connected viewers are untouched here,
	// so a brief publisher gap (MV3 reconnect) causes no flicker.
	var last, dlg, pop, mirror []byte
	if !c.publisher && h.publishers > 0 {
		last = h.lastState
	}
	// A publisher that (re)connects has to be told the current mirror state — the
	// MV3 worker is torn down and restarted constantly, and it defaults to OFF, so
	// without this a mid-session extension restart would silently stop mirroring.
	if c.publisher {
		mirror = mirrorPayload(h.mirrorOn)
	}
	// A dialog resync does NOT depend on a live publisher: the dialog comes from
	// our own CDP connection, not the extension, and it blocks the page whether
	// or not the extension is up.
	if !c.publisher {
		dlg = h.lastDialog
		pop = h.lastPopup
	}
	h.mu.Unlock()

	if last != nil {
		c.enqueue(last)
	}
	if dlg != nil {
		c.enqueueDialog(dlg)
	}
	if pop != nil {
		c.enqueuePopup(pop)
	}
	if mirror != nil {
		c.enqueueCtl(mirror)
	}
}

func (h *kbdHub) remove(c *kbdClient) {
	h.mu.Lock()
	if _, ok := h.clients[c]; ok {
		delete(h.clients, c)
		if c.publisher {
			h.publishers--
		}
	}
	// A departing mirror viewer must turn the value stream back off, or the
	// extension would keep publishing field text to whoever is left.
	pubs, mirror := h.recomputeMirrorLocked()
	h.mu.Unlock()
	for _, p := range pubs {
		p.enqueueCtl(mirror)
	}
	select {
	case <-c.closed:
	default:
		close(c.closed)
	}
	_ = c.conn.Close()
}

func mirrorPayload(on bool) []byte {
	if on {
		return []byte(`{"mirror":true}`)
	}
	return []byte(`{"mirror":false}`)
}

// recomputeMirrorLocked re-derives the aggregate mirror state from the connected
// viewers. Returns the publishers to notify and the payload, or (nil, nil) when
// nothing changed. Caller holds h.mu.
func (h *kbdHub) recomputeMirrorLocked() ([]*kbdClient, []byte) {
	want := false
	for c := range h.clients {
		if !c.publisher && c.wantsMirror {
			want = true
			break
		}
	}
	if want == h.mirrorOn {
		return nil, nil
	}
	h.mirrorOn = want
	pubs := make([]*kbdClient, 0, 2)
	for c := range h.clients {
		if c.publisher {
			pubs = append(pubs, c)
		}
	}
	return pubs, mirrorPayload(want)
}

// setMirror records a viewer's mirroring request and pushes the aggregate to the
// publisher. This is the ONLY way the extension starts publishing field text: the
// default channel is structural (rects, hints, value length), so a viewer that
// never asks — and the hub's resync cache — never sees the contents of a search
// box, an email field or a recovery answer.
func (h *kbdHub) setMirror(c *kbdClient, payload []byte) {
	var msg struct {
		Mirror *struct {
			On bool `json:"on"`
		} `json:"mirror"`
	}
	if json.Unmarshal(payload, &msg) != nil || msg.Mirror == nil {
		return
	}
	h.mu.Lock()
	c.wantsMirror = msg.Mirror.On
	pubs, mirror := h.recomputeMirrorLocked()
	h.mu.Unlock()
	for _, p := range pubs {
		p.enqueueCtl(mirror)
	}
}

// publish caches the state and fans it out to every client except the sender
// (the extension never needs to hear its own signal echoed back).
func (h *kbdHub) publish(sender *kbdClient, payload []byte) {
	buf := make([]byte, len(payload))
	copy(buf, payload)

	h.mu.Lock()
	h.lastState = buf
	targets := make([]*kbdClient, 0, len(h.clients))
	for c := range h.clients {
		if c != sender {
			targets = append(targets, c)
		}
	}
	h.mu.Unlock()

	for _, c := range targets {
		c.enqueue(buf)
	}
}

// broadcastDialog fans a dialog state out to every viewer and caches it for
// late joiners. Unlike publish it never touches lastState — a dialog must not
// overwrite the cached focus signal, or a reconnecting viewer would be resynced
// with a dialog in place of its keyboard state. An `open:false` state clears the
// cache so a dismissed dialog is never replayed to the next viewer.
func (h *kbdHub) broadcastDialog(payload []byte, open bool) {
	buf := make([]byte, len(payload))
	copy(buf, payload)

	h.mu.Lock()
	if open {
		h.lastDialog = buf
	} else {
		h.lastDialog = nil
	}
	targets := make([]*kbdClient, 0, len(h.clients))
	for c := range h.clients {
		if !c.publisher {
			targets = append(targets, c)
		}
	}
	h.mu.Unlock()

	for _, c := range targets {
		c.enqueueDialog(buf)
	}
}

// broadcastPopup fans the foreground-popup state out to every viewer and caches
// it for late joiners. Same shape as broadcastDialog, separate slot and cache:
// the two states are independent and a popup can itself raise a dialog.
func (h *kbdHub) broadcastPopup(payload []byte, open bool) {
	buf := make([]byte, len(payload))
	copy(buf, payload)

	h.mu.Lock()
	if open {
		h.lastPopup = buf
	} else {
		h.lastPopup = nil
	}
	targets := make([]*kbdClient, 0, len(h.clients))
	for c := range h.clients {
		if !c.publisher {
			targets = append(targets, c)
		}
	}
	h.mu.Unlock()

	for _, c := range targets {
		c.enqueuePopup(buf)
	}
}

// enqueue stashes the latest payload and pokes the writer. If a write is still
// in flight, the newer state simply replaces the older queued one.
func (c *kbdClient) enqueue(payload []byte) {
	c.mailMu.Lock()
	c.pending = payload
	c.mailMu.Unlock()
	select {
	case c.notify <- struct{}{}:
	default:
	}
}

func (c *kbdClient) enqueueDialog(payload []byte) {
	c.mailMu.Lock()
	c.pendingDialog = payload
	c.mailMu.Unlock()
	select {
	case c.notify <- struct{}{}:
	default:
	}
}

// takeDialog drains the dialog slot. Drained BEFORE the focus slot so a blocked
// page is reported even when both are pending.
func (c *kbdClient) takeDialog() []byte {
	c.mailMu.Lock()
	defer c.mailMu.Unlock()
	p := c.pendingDialog
	c.pendingDialog = nil
	return p
}

func (c *kbdClient) enqueuePopup(payload []byte) {
	c.mailMu.Lock()
	c.pendingPopup = payload
	c.mailMu.Unlock()
	select {
	case c.notify <- struct{}{}:
	default:
	}
}

func (c *kbdClient) takePopup() []byte {
	c.mailMu.Lock()
	defer c.mailMu.Unlock()
	p := c.pendingPopup
	c.pendingPopup = nil
	return p
}

// enqueueCtl queues a publisher control frame. Drops the OLDEST if the queue is
// somehow full, so the newest state (which is the authoritative one) survives.
func (c *kbdClient) enqueueCtl(payload []byte) {
	c.mailMu.Lock()
	if len(c.pendingCtl) >= kbdMaxCtlQueue {
		c.pendingCtl = c.pendingCtl[1:]
	}
	c.pendingCtl = append(c.pendingCtl, payload)
	c.mailMu.Unlock()
	select {
	case c.notify <- struct{}{}:
	default:
	}
}

func (c *kbdClient) takeCtl() [][]byte {
	c.mailMu.Lock()
	defer c.mailMu.Unlock()
	p := c.pendingCtl
	c.pendingCtl = nil
	return p
}

func (c *kbdClient) take() []byte {
	c.mailMu.Lock()
	defer c.mailMu.Unlock()
	p := c.pending
	c.pending = nil
	return p
}

func (c *kbdClient) writeFrame(opcode byte, payload []byte) error {
	_ = c.conn.SetWriteDeadline(time.Now().Add(kbdWriteDeadline))
	return writeFrameToConn(c.conn, &c.writeMu, opcode, payload, false, true)
}

// writeLoop drains the coalescing mailbox and sends server->client pings.
func (c *kbdClient) writeLoop() {
	ticker := time.NewTicker(kbdPingInterval)
	defer ticker.Stop()
	for {
		select {
		case <-c.closed:
			return
		case <-c.notify:
			for _, p := range c.takeCtl() {
				if err := c.writeFrame(0x1, p); err != nil {
					return
				}
			}
			if p := c.takeDialog(); p != nil {
				if err := c.writeFrame(0x1, p); err != nil {
					return
				}
			}
			if p := c.takePopup(); p != nil {
				if err := c.writeFrame(0x1, p); err != nil {
					return
				}
			}
			if p := c.take(); p != nil {
				if err := c.writeFrame(0x1, p); err != nil {
					return
				}
			}
		case <-ticker.C:
			if err := c.writeFrame(0x9, nil); err != nil {
				return
			}
		}
	}
}

func (h *kbdHub) serve(w http.ResponseWriter, r *http.Request, ready readyGate) {
	if !ready.ready() {
		http.Error(w, "app is not ready", http.StatusServiceUnavailable)
		return
	}
	if !isWebsocketRequest(r) {
		http.Error(w, "websocket upgrade required", http.StatusBadRequest)
		return
	}
	key := strings.TrimSpace(r.Header.Get("Sec-WebSocket-Key"))
	if key == "" {
		http.Error(w, "missing Sec-WebSocket-Key", http.StatusBadRequest)
		return
	}
	if h.full() {
		http.Error(w, "too many keyboard clients", http.StatusServiceUnavailable)
		return
	}
	publisher := r.URL.Query().Get("role") == "pub"
	if publisher && !publisherAllowed(r) {
		// Refuse outright rather than silently downgrade to viewer: a quietly demoted publisher looks exactly
		// like a keyboard that stopped working for no reason.
		logPublisherReject(r)
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "hijacking unsupported", http.StatusInternalServerError)
		return
	}
	conn, rw, err := hijacker.Hijack()
	if err != nil {
		return
	}

	_, _ = fmt.Fprintf(rw, "HTTP/1.1 101 Switching Protocols\r\n")
	_, _ = fmt.Fprintf(rw, "Upgrade: websocket\r\n")
	_, _ = fmt.Fprintf(rw, "Connection: Upgrade\r\n")
	_, _ = fmt.Fprintf(rw, "Sec-WebSocket-Accept: %s\r\n", websocketAccept(key))
	_, _ = fmt.Fprint(rw, "\r\n")
	if err := rw.Flush(); err != nil {
		_ = conn.Close()
		return
	}

	client := &kbdClient{
		conn:      conn,
		publisher: publisher,
		notify:    make(chan struct{}, 1),
		closed:    make(chan struct{}),
	}
	h.add(client)
	defer h.remove(client)

	go client.writeLoop()
	// Hand the extension its dialog-bridge token. Publishers only — a viewer that
	// learned it could forge dialogs on behalf of the page, which is the very thing
	// the token exists to prevent.
	if publisher {
		h.mu.Lock()
		tok := h.bridgeToken
		h.mu.Unlock()
		if tok != "" {
			if b, err := json.Marshal(map[string]string{"bridgeToken": tok}); err == nil {
				client.enqueueCtl(b) // publisher control queue: never coalesced away
			}
		}
	}
	h.readLoop(client, rw.Reader)
}

func (h *kbdHub) readLoop(c *kbdClient, reader *bufio.Reader) {
	for {
		_ = c.conn.SetReadDeadline(time.Now().Add(kbdReadDeadline))
		// Capped at the length header: the len(payload) checks below only run once the frame is already in
		// memory, so decoding at the 64 MiB ceiling let any client force huge throwaway allocations.
		_, opcode, payload, err := readFrameLimit(reader, kbdMaxPayload)
		if errors.Is(err, errFrameTooLarge) {
			continue // body already drained; dropping one frame beats tearing down the publisher
		}
		if err != nil {
			return
		}
		switch opcode {
		case 0x0, 0x1, 0x2: // (continuation/)text/binary — a focus signal
			// Only publishers broadcast, and only tiny payloads. Viewer frames
			// (and anything oversized) are ignored, not relayed.
			if c.publisher && len(payload) > 0 && len(payload) <= kbdMaxPayload &&
				!bytes.Contains(payload, []byte(`"editable"`)) {
				// A publisher CONTROL frame (currently: which window is in front).
				// Consumed here, never fanned out — it can carry a URL, and viewers
				// have no business receiving one. Distinguished by the absence of
				// "editable", which every focus state has by construction (background.js
				// refuses to send one without it); anything that looks like a state is
				// still broadcast, so a page whose placeholder happens to contain a
				// keyword can't silence the keyboard.
				if h.onPublisherMsg != nil {
					h.onPublisherMsg(payload)
				}
			} else if c.publisher && len(payload) > 0 && len(payload) <= kbdMaxPayload {
				h.publish(c, payload)
			} else if !c.publisher && len(payload) > 0 && len(payload) <= kbdMaxPayload &&
				(bytes.Contains(payload, []byte(`"dialogReply"`)) || bytes.Contains(payload, []byte(`"popupClose"`))) {
				// A viewer answering a JS dialog, or asking to close the foreground
				// popup window. Both are handled by the server (which owns the CDP
				// connection) rather than relayed, so the viewer never gets to speak
				// CDP itself — it sends accept/dismiss + prompt text, or a bare
				// sequence number, and nothing more.
				//
				// This gate is an ALLOWLIST: a viewer frame that matches neither is
				// dropped, so adding a viewer->server message means adding it here.
				if h.onViewerMsg != nil {
					h.onViewerMsg(payload)
				}
			} else if !c.publisher && len(payload) > 0 && len(payload) <= 256 && bytes.Contains(payload, []byte(`"mirror"`)) {
				// A viewer opting IN to field-value mirroring (?mirror=1). Handled by
				// the hub rather than relayed: it is aggregated across viewers and
				// pushed to the publisher, which is what gates whether field text is
				// published at all. See setMirror.
				h.setMirror(c, payload)
			} else if !c.publisher && len(payload) > 0 && len(payload) <= 64 && bytes.Contains(payload, []byte(`"ping"`)) {
				// Viewer RTT probe: echo it straight back to the sender only (not
				// broadcast) so the viewer can measure tunnel round-trip time and
				// size its adaptive keyboard timers. Also keeps the NAT path warm.
				_ = c.writeFrame(0x1, payload)
			}
		case 0x8: // close
			_ = c.writeFrame(0x8, payload)
			return
		case 0x9: // ping -> pong
			_ = c.writeFrame(0xA, payload)
		case 0xA: // pong — liveness, read deadline already refreshed
		default:
			return
		}
	}
}
