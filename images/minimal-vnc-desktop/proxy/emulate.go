package main

// Device-viewport emulation. The viewer (liveview.html) POSTs its own viewport
// size + deviceScaleFactor; we drive CDP Emulation.setDeviceMetricsOverride on
// the container's Chromium so the page REFLOWS to that layout (mobile
// breakpoints fire) at a framebuffer-filling density.
//
// A single POST target isn't enough: links/popups (e.g. "Sign in with Google")
// open NEW page targets that never had the override, so they render desktop-
// width and overflow. So we hold ONE persistent browser-level CDP connection
// with Target.setAutoAttach and (re)apply the current emulation to every page
// target — existing, newly-opened, and after each navigation.
//
// SECURITY: served on the public noVNC port, this exposes ONLY
// setDeviceMetricsOverride + setTouchEmulationEnabled with numeric-validated
// params — never general CDP. Worst case a caller resizes the emulated
// viewport. (The full CDP endpoint stays bound to loopback / behind -p.)

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"math/rand"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type emulateRequest struct {
	Width             int     `json:"width"`
	Height            int     `json:"height"`
	DeviceScaleFactor float64 `json:"deviceScaleFactor"`
	Mobile            bool    `json:"mobile"`
	Touch             bool    `json:"touch"`
	Reset             bool    `json:"reset"`
}

// emulator holds the desired emulation AND a persistent CDP connection that
// (a) applies the emulation to every page target and (b) dispatches touch input
// (Input.dispatchTouchEvent) so the remote page handles scroll/drag/sliders/
// pinch NATIVELY — VNC only carries mouse, so real touch must come via CDP.
type emulator struct {
	cdpUpstream string
	mu          sync.Mutex
	params      *emulateRequest
	dirty       chan struct{}
	cmds        chan cdpCmd // input/other commands to send on the live session

	sessMu sync.Mutex
	active string // page sessionId that receives input (newest/foreground)

	// ---- JS dialog interception ---------------------------------------------
	// Chromium lays alert()/confirm()/prompt() out against the real browser
	// WINDOW, not the emulated viewport, so under a narrow mobile emulation the
	// dialog overflows and its OK button can end up off-screen — and because a
	// dialog blocks script execution, an unreachable button wedges the page. The
	// alternative failure is worse: an automation layer that silently auto-accepts
	// makes the site's message vanish, so a validation error shows the user
	// nothing at all.
	//
	// So we intercept: Page.javascriptDialogOpening is forwarded to the viewer,
	// which draws a real-DOM sheet at the correct size, and the reply comes back
	// as accept/dismiss + text. handleJavaScriptDialog is issued from HERE, never
	// by the viewer, so answering a dialog does not require exposing a
	// page-control CDP method to whoever can reach the port.
	// FedCM account chooser — same "browser UI clipped by emulation" problem as a
	// JS dialog, but with no safe auto-accept (picking an account is the user's
	// decision). See fedcm.go.
	fedcm fedcmState

	dlgMu      sync.Mutex
	dlgSession string // session whose dialog is open ("" when none)
	dlgSeq     uint64 // identifies a dialog so a stale reply can't answer a new one
	onDialog   func(payload []byte, open bool)

	// ---- secondary windows ---------------------------------------------------
	// A sign-in flow ("Continue with Google", payment flows) puts a SECOND
	// top-level page in front of the user. On the remote side that is a real
	// window, and it covers the whole screen — either because targetCreated
	// fullscreens it, or because a new window on a kiosk-sized X screen fills it
	// anyway. Chromium runs --kiosk, so it has no title bar, no tab strip and no
	// URL bar: a user who changes their mind has NO way back to the page
	// underneath, and it outlives a viewer reload because it lives in the remote
	// browser, not the viewer.
	//
	// Tracked by "is there more than one top-level page", NOT by openerId. The
	// flow this exists for — Pinterest's Google sign-in — is FedCM
	// (accounts.google.com/gsi/fedcm/signin), and its target is reported with
	// openerId EMPTY, so an opener-based test misses the exact case that matters.
	// Verified against the live flow; a window.open popup does carry an opener,
	// and counting pages covers both, plus target=_blank tabs.
	//
	// The rule also protects the session for free: with one page there is nothing
	// to close, so the primary page can never be the thing we offer to destroy.
	popMu    sync.Mutex
	pages    []string // top-level page targetIds, creation order (newest last)
	popFront string   // targetId currently advertised as closable ("" = none)
	popSeq   uint64   // identifies that window; stale taps are dropped
	onPopup  func(payload []byte, open bool)
}

// cdpCmd is a command queued from another goroutine (e.g. the /input handler)
// to be written on the emulator's live CDP connection.
type cdpCmd struct {
	method  string
	params  map[string]any
	session string
}

// setDialogSink installs the fan-out used to tell viewers about a dialog.
func (e *emulator) setDialogSink(f func(payload []byte, open bool)) {
	e.dlgMu.Lock()
	e.onDialog = f
	e.dlgMu.Unlock()
}

// noteDialogOpen records the dialog and returns its sequence number. An
// informational one (alert, already accepted natively) leaves dlgSession empty:
// there is nothing left to answer, so a later reply must not resolve anything.
func (e *emulator) noteDialogOpen(sessionID string, informational bool) uint64 {
	e.dlgMu.Lock()
	defer e.dlgMu.Unlock()
	e.dlgSeq++
	if informational {
		e.dlgSession = ""
	} else {
		e.dlgSession = sessionID
	}
	return e.dlgSeq
}

func (e *emulator) dialogSink() func([]byte, bool) {
	e.dlgMu.Lock()
	defer e.dlgMu.Unlock()
	return e.onDialog
}

// answerDialog resolves the open dialog. `seq` must match the dialog currently
// open: on a slow link a reply for a DISMISSED dialog can arrive after the page
// has opened another one (a validation loop fires alert() repeatedly), and
// answering the new dialog with the old tap would accept something the user never
// saw. A mismatched or absent dialog is dropped.
func (e *emulator) answerDialog(seq uint64, accept bool, text string) bool {
	e.dlgMu.Lock()
	if e.dlgSession == "" || seq != e.dlgSeq {
		e.dlgMu.Unlock()
		return false
	}
	sid := e.dlgSession
	e.dlgSession = ""
	e.dlgMu.Unlock()

	p := map[string]any{"accept": accept}
	if accept && text != "" {
		p["promptText"] = text
	}
	e.enqueueCmd(cdpCmd{method: "Page.handleJavaScriptDialog", params: p, session: sid})
	return true
}

// forgetDialog clears dialog state without answering (target detached / the page
// navigated out from under it), so a later reply can't be applied to nothing.
func (e *emulator) forgetDialog(sessionID string) bool {
	e.dlgMu.Lock()
	defer e.dlgMu.Unlock()
	if e.dlgSession == "" || (sessionID != "" && e.dlgSession != sessionID) {
		return false
	}
	e.dlgSession = ""
	return true
}

// setPopupSink installs the fan-out used to tell viewers about a popup window.
func (e *emulator) setPopupSink(f func(payload []byte, open bool)) {
	e.popMu.Lock()
	e.onPopup = f
	e.popMu.Unlock()
}

func (e *emulator) popupSink() func([]byte, bool) {
	e.popMu.Lock()
	defer e.popMu.Unlock()
	return e.onPopup
}

// pageTargets snapshots the tracked top-level page targetIds for the kiosk
// watchdog (see the fullscreen ticker in session()).
func (e *emulator) pageTargets() []string {
	e.popMu.Lock()
	defer e.popMu.Unlock()
	out := make([]string, len(e.pages))
	copy(out, e.pages)
	return out
}

// frontLocked is the window we offer to close: the newest top-level page, and
// only when there is more than one (never the last page standing).
func (e *emulator) frontLocked() string {
	if len(e.pages) < 2 {
		return ""
	}
	return e.pages[len(e.pages)-1]
}

// republishLocked recomputes the advertised window. The sequence is bumped only
// when the FRONT window changes, so a tap already in flight for a window that has
// since closed cannot be applied to whatever replaced it — and an unrelated
// target churning does not invalidate a close the user is about to tap.
func (e *emulator) republishLocked() (seq uint64, open bool, changed bool) {
	front := e.frontLocked()
	if front == e.popFront {
		return e.popSeq, front != "", false
	}
	e.popFront = front
	if front == "" {
		e.popSeq = 0
		return 0, false, true
	}
	e.popSeq++
	return e.popSeq, true, true
}

// notePage records a top-level page. Every page counts, including the primary
// one — "closable" is derived from the COUNT, so the primary must be tracked or
// the second page would look like the only one.
func (e *emulator) notePage(targetID string) (seq uint64, open bool, changed bool) {
	e.popMu.Lock()
	defer e.popMu.Unlock()
	for _, t := range e.pages {
		if t == targetID {
			return e.popSeq, e.popFront != "", false // already tracked; targetCreated can repeat
		}
	}
	e.pages = append(e.pages, targetID)
	return e.republishLocked()
}

// forgetPage drops a destroyed page and republishes. Reports changed=false for a
// target we never tracked (targetDestroyed fires for iframes, workers and every
// other target type), so unrelated churn never flickers the button.
func (e *emulator) forgetPage(targetID string) (seq uint64, open bool, changed bool) {
	e.popMu.Lock()
	defer e.popMu.Unlock()
	idx := -1
	for i, t := range e.pages {
		if t == targetID {
			idx = i
			break
		}
	}
	if idx < 0 {
		return e.popSeq, e.popFront != "", false
	}
	e.pages = append(e.pages[:idx], e.pages[idx+1:]...)
	return e.republishLocked()
}

// closePopup resolves a viewer's close request into a Target.closeTarget on the
// advertised window. `seq` must match what we advertised: on a slow link a tap
// for a window that has already closed itself (the sign-in completing) can land
// after another opened, and closing THAT one would destroy a window the user
// never asked to dismiss.
func (e *emulator) closePopup(seq uint64) bool {
	e.popMu.Lock()
	if e.popFront == "" || seq == 0 || seq != e.popSeq {
		e.popMu.Unlock()
		return false
	}
	tid := e.popFront
	e.popMu.Unlock()

	// Browser-level command (no session): a FedCM window and a blank OAuth popup
	// are both reachable only by targetId — the latter is deliberately never
	// attached, so there is no session to send this on.
	e.enqueueCmd(cdpCmd{method: "Target.closeTarget", params: map[string]any{"targetId": tid}})
	return true
}

// popupPayload is the state the viewer renders its close affordance from.
func popupPayload(seq uint64, open bool) ([]byte, error) {
	return json.Marshal(map[string]any{"popup": map[string]any{"open": open, "seq": seq}})
}

// publishPopup pushes the current popup state to viewers.
func (e *emulator) publishPopup(seq uint64, open bool) {
	sink := e.popupSink()
	if sink == nil {
		return
	}
	if b, err := popupPayload(seq, open); err == nil {
		sink(b, open)
	}
}

// defaultEmulation is the viewport applied to every page target until a viewer
// POSTs /emulate with its own size.
//
// Without it the page is laid out by Fortress, which clamps the viewport to a
// plausible window on the screen size its persona advertises (--uxr-screen-*,
// 1920x1080): measured live at 1728x866 inside a 1919x2399 kiosk window, so a
// plain desktop session streamed a page painted across a fraction of the
// framebuffer with blank background around it. Emulating WIDTHxHEIGHT makes the
// layout match the framebuffer, and it stays fingerprint-coherent because
// applyTo pins screen.* to 1920x1080 — the same screen the persona claims.
func defaultEmulation() *emulateRequest {
	w := envInt("WIDTH", 1920)
	h := envInt("HEIGHT", 1080)
	return &emulateRequest{Width: w, Height: h, DeviceScaleFactor: 1}
}

func envInt(name string, fallback int) int {
	v, err := strconv.Atoi(strings.TrimSpace(os.Getenv(name)))
	if err != nil || v <= 0 {
		return fallback
	}
	return v
}

// geometryHTTPHandler serves the container's BOOT framebuffer geometry
// (WIDTH x FB_HEIGHT) — the advertised desktop size the screen keeper restores
// and the size the kiosk window starts at. (The window itself is no longer fixed
// there: window.go re-fits it to whatever screen size viewers ask for.) The
// viewer reads this to cap its framebuffer-resize requests (viewer.js
// rfb._screenSize) instead of inferring the cap from the connect-time
// framebuffer, which is unreliable on a REUSED container: a prior phone-sized
// session leaves the X screen sticky-small, so a later desktop viewer would
// otherwise latch onto the tiny size and render a narrow strip. Authoritative
// (reflects the boot env, matched to defaultEmulation/screen-restore) and
// dynamic (fetched at runtime, no hardcoding). Cheap constant; no ready gate
// needed.
func geometryHTTPHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		width := envInt("WIDTH", 1920)
		height := envInt("FB_HEIGHT", envInt("HEIGHT", 1080))
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write([]byte(`{"width":` + strconv.Itoa(width) + `,"height":` + strconv.Itoa(height) + `}`))
	}
}

func newEmulator(cdpUpstream string) *emulator {
	e := &emulator{cdpUpstream: cdpUpstream, dirty: make(chan struct{}, 1), cmds: make(chan cdpCmd, 512)}
	if os.Getenv("MVD_EMULATOR_OFF") == "1" {
		return e // diagnostic: no CDP auto-attach / emulation at all
	}
	e.params = defaultEmulation()
	go e.run()
	return e
}

func (e *emulator) setActive(sid string) {
	e.sessMu.Lock()
	e.active = sid
	e.sessMu.Unlock()
}

func (e *emulator) activeSession() string {
	e.sessMu.Lock()
	defer e.sessMu.Unlock()
	return e.active
}

// enqueue a command for the active page session; drops if no session or the
// queue is full (input is high-frequency; a dropped move self-corrects).
func (e *emulator) queue(method string, params map[string]any) {
	sid := e.activeSession()
	if sid == "" {
		return
	}
	select {
	case e.cmds <- cdpCmd{method: method, params: params, session: sid}:
	default:
	}
}

// queueImportant enqueues a command that MUST NOT be silently dropped. A dropped
// touchStart/End/Cancel leaves the remote page with a stuck finger (the touch
// sequence never balances), so — unlike a move — we wait briefly for a queue
// slot instead of dropping on a full channel. Bounded so a wedged consumer can't
// stall the /input read loop forever.
func (e *emulator) queueImportant(method string, params map[string]any) {
	sid := e.activeSession()
	if sid == "" {
		return
	}
	cmd := cdpCmd{method: method, params: params, session: sid}
	select {
	case e.cmds <- cmd:
		return
	default:
	}
	timer := time.NewTimer(200 * time.Millisecond)
	defer timer.Stop()
	select {
	case e.cmds <- cmd:
	case <-timer.C: // consumer wedged; drop rather than block input indefinitely
	}
}

// enqueueCmd queues a command for a SPECIFIC session (queueImportant always
// targets the foreground one). A dialog must be answered on the session that
// raised it, which may not be the foreground target — a popup can block on its
// own alert. Bounded wait, then dropped, so a wedged consumer can't pin the
// caller; the viewer can tap OK again.
func (e *emulator) enqueueCmd(cmd cdpCmd) {
	select {
	case e.cmds <- cmd:
		return
	default:
	}
	timer := time.NewTimer(200 * time.Millisecond)
	defer timer.Stop()
	select {
	case e.cmds <- cmd:
	case <-timer.C:
	}
}

type touchPoint struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

// dispatchTouch sends a touch event to the active page. CDP wants the currently
// pressed points; for touchEnd of the last finger that's an empty slice.
//
// Each point carries a non-zero, slightly-varying force and a contact radius:
// real fingers report those, and behavioral captchas (GeeTest, reCAPTCHA) treat
// a constant force of 0 / zero radius as a synthetic-input tell.
func (e *emulator) dispatchTouch(evType string, points []touchPoint) {
	tp := make([]map[string]any, 0, len(points))
	for _, p := range points {
		force := math.Round((0.45+rand.Float64()*0.2)*100) / 100 // ~0.45..0.65
		radius := math.Round(12 + rand.Float64()*6)              // ~12..18 px
		tp = append(tp, map[string]any{
			"x": p.X, "y": p.Y,
			"force":   force,
			"radiusX": radius, "radiusY": radius,
		})
	}
	params := map[string]any{"type": evType, "touchPoints": tp}
	if evType == "touchMove" {
		e.queue("Input.dispatchTouchEvent", params) // high-frequency; a dropped move self-corrects
	} else {
		e.queueImportant("Input.dispatchTouchEvent", params) // start/end/cancel: never drop (stuck-finger)
	}
}

// dispatchCompatClick sends the mouse press/release pair a real phone produces
// after a tap (the compatibility mouse events). pointerType "touch" keeps it
// coherent with the touch device we present: a Windows touch screen emitting a
// bare mouse click with no pointer type would be its own fingerprint tell.
//
// queueImportant, not queue: a dropped release leaves the remote page with a held
// mouse button, which is the same class of stuck-input bug as a dropped touchEnd.
func (e *emulator) dispatchCompatClick(p touchPoint) {
	base := map[string]any{
		"x": p.X, "y": p.Y,
		"button": "left", "clickCount": 1,
		"pointerType": "touch",
	}
	press := map[string]any{"type": "mousePressed", "buttons": 1}
	release := map[string]any{"type": "mouseReleased", "buttons": 0}
	for k, v := range base {
		press[k] = v
		release[k] = v
	}
	e.queueImportant("Input.dispatchMouseEvent", press)
	e.queueImportant("Input.dispatchMouseEvent", release)
}

func (e *emulator) set(req emulateRequest) {
	e.mu.Lock()
	e.params = &req
	e.mu.Unlock()
	select {
	case e.dirty <- struct{}{}:
	default:
	}
}

func (e *emulator) current() *emulateRequest {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.params
}

func emulateHTTPHandler(em *emulator, ready readyGate) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "POST only", http.StatusMethodNotAllowed)
			return
		}
		if !ready.ready() {
			http.Error(w, "not ready", http.StatusServiceUnavailable)
			return
		}
		var req emulateRequest
		if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&req); err != nil {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}
		em.set(req)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}
}

// /input liveness/limits mirror the /kbd and /websockify channels: without them
// a half-open mobile connection (carrier NAT drop, wifi<->cell handoff) lingers
// undetected because this channel only reads, and nothing bounds concurrent
// clients feeding the single active session.
const (
	inputReadDeadline  = 70 * time.Second
	inputWriteDeadline = 10 * time.Second
	inputPingInterval  = 30 * time.Second
	inputMaxClients    = 8
	inputMaxPayload    = 8192
)

var inputClients int32

// inputWSHandler streams touch input from the viewer to the remote as native
// CDP touch events. Messages are JSON: {"t":"start|move|end|cancel","points":
// [{"x":<remoteCssPx>,"y":<remoteCssPx>}]}. A persistent socket keeps per-move
// latency to one tunnel hop (no per-event handshake).
func inputWSHandler(em *emulator, ready readyGate) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !ready.ready() {
			http.Error(w, "not ready", http.StatusServiceUnavailable)
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
		if atomic.AddInt32(&inputClients, 1) > inputMaxClients {
			atomic.AddInt32(&inputClients, -1)
			http.Error(w, "too many input clients", http.StatusServiceUnavailable)
			return
		}
		defer atomic.AddInt32(&inputClients, -1)
		hj, ok := w.(http.Hijacker)
		if !ok {
			http.Error(w, "hijacking unsupported", http.StatusInternalServerError)
			return
		}
		conn, rw, err := hj.Hijack()
		if err != nil {
			return
		}
		defer conn.Close()
		_, _ = fmt.Fprintf(rw, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n", websocketAccept(key))
		_ = rw.Flush()

		// Server->client pings keep the carrier-NAT path warm and force a torn-down
		// socket to error the read below (browsers auto-pong; a dead peer never
		// does, so the read deadline fires). Only this goroutine writes.
		var writeMu sync.Mutex
		closed := make(chan struct{})
		defer close(closed)
		go func() {
			ticker := time.NewTicker(inputPingInterval)
			defer ticker.Stop()
			for {
				select {
				case <-closed:
					return
				case <-ticker.C:
					_ = conn.SetWriteDeadline(time.Now().Add(inputWriteDeadline))
					if err := writeFrameToConn(conn, &writeMu, 0x9, nil, false, true); err != nil {
						_ = conn.Close() // unblock the read loop
						return
					}
				}
			}
		}()

		for {
			_ = conn.SetReadDeadline(time.Now().Add(inputReadDeadline))
			fin, opcode, payload, err := readFrame(rw.Reader)
			if err != nil {
				return
			}
			if opcode == 0x8 { // close
				return
			}
			if opcode == 0x9 { // ping -> pong
				_ = conn.SetWriteDeadline(time.Now().Add(inputWriteDeadline))
				_ = writeFrameToConn(conn, &writeMu, 0xA, payload, false, true)
				continue
			}
			if !fin || (opcode != 0x1 && opcode != 0x2) { // pong/continuation/other
				continue
			}
			if len(payload) > inputMaxPayload {
				continue
			}
			var msg struct {
				T      string       `json:"t"`
				Points []touchPoint `json:"points"`
			}
			if json.Unmarshal(payload, &msg) != nil {
				continue
			}
			var evType string
			switch msg.T {
			case "start":
				evType = "touchStart"
			case "move":
				evType = "touchMove"
			case "end":
				evType = "touchEnd"
			case "cancel":
				evType = "touchCancel"
			case "click":
				// Compatibility mouse click for a tap that landed inside a
				// cross-origin iframe. Chrome synthesizes `click` from a CDP touch
				// tap in the main frame but not inside an out-of-process one, so
				// reCAPTCHA's checkbox received pointerdown/touchstart/touchend and
				// no click, and never activated. The viewer decides when to send
				// this (it knows where those frames are) — sending it for every tap
				// would double-fire wherever the touch already produced a click.
				if len(msg.Points) == 1 {
					em.dispatchCompatClick(msg.Points[0])
				}
				continue
			default:
				continue
			}
			em.dispatchTouch(evType, msg.Points)
		}
	}
}

func clampInt(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// run maintains the persistent CDP connection, reconnecting with backoff.
func (e *emulator) run() {
	backoff := 500 * time.Millisecond
	for {
		if err := e.session(); err != nil {
			time.Sleep(backoff)
			if backoff < 10*time.Second {
				backoff *= 2
			}
			continue
		}
		backoff = 500 * time.Millisecond
	}
}

// session runs one CDP connection lifetime: auto-attach to targets and apply
// emulation to each page target on attach, on navigation, and on /emulate.
func (e *emulator) session() error {
	browserWS, err := cdpBrowserWSURL(e.cdpUpstream)
	if err != nil {
		return err
	}
	conn, reader, err := dialWebsocket(browserWS)
	if err != nil {
		return err
	}
	defer conn.Close()

	var writeMu sync.Mutex
	var idCounter int64
	send := func(method string, params map[string]any, sessionID string) int {
		id := int(atomic.AddInt64(&idCounter, 1))
		msg := map[string]any{"id": id, "method": method, "params": params}
		if sessionID != "" {
			msg["sessionId"] = sessionID
		}
		b, _ := json.Marshal(msg)
		_ = writeFrameToConn(conn, &writeMu, 0x1, b, true, true)
		return id
	}

	applyTo := func(sessionID string) {
		p := e.current()
		if p == nil {
			return
		}
		if p.Reset {
			send("Emulation.clearDeviceMetricsOverride", map[string]any{}, sessionID)
			send("Emulation.setTouchEmulationEnabled", map[string]any{"enabled": false, "maxTouchPoints": 1}, sessionID)
			return
		}
		w := clampInt(p.Width, 1, 4096)
		h := clampInt(p.Height, 1, 4096)
		dsf := p.DeviceScaleFactor
		// Fit-to-width (legacy non-responsive sites) renders a WIDE layout into the
		// phone-sized framebuffer via a fractional scale factor (< 1) — the same
		// state a browser is in when zoomed out, so it stays fingerprint-plausible.
		// Floor at 0.2 so an absurd request can't render a 1px-tall page.
		if dsf <= 0 {
			dsf = 1
		}
		if dsf < 0.2 {
			dsf = 0.2
		}
		if dsf > 4 {
			dsf = 4
		}
		// Keep screen.* at a coherent desktop resolution (a Windows touch monitor)
		// rather than the narrow window size — a "desktop" reporting a phone-sized
		// screen is itself a fingerprint tell. The viewport (width/height) is just
		// a small window on that screen.
		send("Emulation.setDeviceMetricsOverride", map[string]any{
			"width": w, "height": h, "deviceScaleFactor": dsf, "mobile": p.Mobile,
			"screenWidth": 1920, "screenHeight": 1080,
		}, sessionID)
		tp := 1
		if p.Touch {
			tp = 5
		}
		send("Emulation.setTouchEmulationEnabled", map[string]any{"enabled": p.Touch, "maxTouchPoints": tp}, sessionID)
	}

	sessions := map[string]bool{} // page sessionId -> true

	// DISCOVER targets without auto-attaching. Auto-attach grabs EVERY new
	// target, including popups (window.open — OAuth "Continue with Google",
	// payment windows). Merely attaching a debugging session to such a popup
	// severs the opener's ability to navigate it, so it opens blank and stays
	// blank. So we discover, then attach ONLY to top-level page targets that
	// have NO opener; popups (openerId set) are left completely native. flatten
	// routes the sessions we DO open over this socket.
	attachIfMain := func(ti map[string]any) {
		if t, _ := ti["type"].(string); t != "page" {
			return
		}
		if op, _ := ti["openerId"].(string); op != "" {
			return // popup — leave native
		}
		if tid, _ := ti["targetId"].(string); tid != "" {
			send("Target.attachToTarget", map[string]any{"targetId": tid, "flatten": true}, "")
		}
	}
	send("Target.setDiscoverTargets", map[string]any{"discover": true}, "")
	send("Target.getTargets", map[string]any{}, "")

	msgs := make(chan map[string]any, 128)
	errc := make(chan error, 1)
	go func() {
		for {
			fin, opcode, payload, err := readFrame(reader)
			if err != nil {
				errc <- err
				return
			}
			if opcode == 0x8 {
				errc <- fmt.Errorf("cdp connection closed")
				return
			}
			if !fin || (opcode != 0x1 && opcode != 0x2) {
				continue
			}
			var m map[string]any
			if json.Unmarshal(payload, &m) == nil {
				msgs <- m
			}
		}
	}()

	// Ensure active session is cleared when this connection dies.
	defer e.setActive("")

	// Kiosk fullscreen watchdog. Chrome's tab strip shows ONLY when a window is in
	// windowState 'normal' (measured: 'fullscreen' and 'maximized' are chromeless,
	// 'normal' shows a 35px toolbar even under --kiosk). Our proxy never sets
	// 'normal' — but Chromium can put a window there on its own (a window.open popup
	// with size features opens normal+chromed), and the extension's onCreated fast
	// path can miss a window that flips AFTER creation, since a single-window kiosk
	// fires no focus-change to re-check on. This connection is always alive, so it is
	// the reliable place to re-assert: each tick we ask for every tracked page's
	// window, and the getWindowForTarget reply handler above forces it fullscreen.
	// Idempotent on an already-fullscreen window (a no-op setWindowBounds), so the
	// cost is one round-trip per page per tick.
	watchdog := time.NewTicker(2 * time.Second)
	defer watchdog.Stop()

	for {
		select {
		case err := <-errc:
			return err
		case <-watchdog.C:
			for _, tid := range e.pageTargets() {
				send("Browser.getWindowForTarget", map[string]any{"targetId": tid}, "")
			}
		case <-e.dirty:
			for sid := range sessions {
				applyTo(sid)
			}
		case c := <-e.cmds:
			// A browser-level command (empty session) addresses a target by id —
			// closing an unattached OAuth popup is the case that needs it, since
			// those never get a session at all.
			if c.session == "" {
				send(c.method, c.params, "")
				continue
			}
			// Otherwise only dispatch if the target session still exists.
			if sessions[c.session] {
				send(c.method, c.params, c.session)
			}
		case m := <-msgs:
			method, _ := m["method"].(string)
			switch method {
			case "Target.targetCreated":
				// A new top-level page appeared. Fullscreen every script-opened
				// window/tab so it fills the view. Then decide whether to emulate:
				//   - BLANK popup (url ""/about:blank + opener) = OAuth-style window
				//     (GSI opens blank then navigates it cross-origin via postMessage;
				//     attaching a session breaks that) → leave native, do NOT attach.
				//   - Real-URL tab (opener + http(s) url, e.g. a target=_blank content
				//     link) → attach so it gets mobile emulation like the main tab.
				//   - Main page (no opener) → attach.
				params, _ := m["params"].(map[string]any)
				if ti, _ := params["targetInfo"].(map[string]any); ti != nil {
					op, _ := ti["openerId"].(string)
					t, _ := ti["type"].(string)
					url, _ := ti["url"].(string)
					tid, _ := ti["targetId"].(string)
					// Count EVERY top-level page, whatever opened it. The close
					// affordance is derived from how many exist, because the flow it
					// exists for (FedCM sign-in) reports no opener at all.
					if t == "page" && tid != "" {
						if seq, open, changed := e.notePage(tid); changed {
							e.publishPopup(seq, open)
						}
					}
					if t == "page" && op != "" {
						if tid != "" {
							send("Browser.getWindowForTarget", map[string]any{"targetId": tid}, "")
							if url != "" && url != "about:blank" {
								send("Target.attachToTarget", map[string]any{"targetId": tid, "flatten": true}, "")
							}
						}
					} else {
						attachIfMain(ti)
					}
				}
			case "Target.attachedToTarget":
				params, _ := m["params"].(map[string]any)
				ti, _ := params["targetInfo"].(map[string]any)
				sid, _ := params["sessionId"].(string)
				// attachedToTarget only fires for targets we explicitly attached
				// (main tab + real-URL content tabs) — OAuth blank popups are never
				// attached — so emulate whatever arrives here.
				if t, _ := ti["type"].(string); t == "page" && sid != "" {
					sessions[sid] = true
					e.setActive(sid) // newest page is the foreground one
					applyTo(sid)     // apply now for the current document
					// The override usually persists per target, but a FULL cross-
					// document navigation (clicking to another page in magnify) can
					// drop it, leaving the next page desktop-width. Enable Page so we
					// get frameNavigated and re-apply — but ONLY for the main frame
					// (below), so SPA route changes / iframe/ad loads don't trigger a
					// reflow-jitter storm.
					send("Page.enable", map[string]any{}, sid)
					// FedCM's chooser is browser UI too, and at mobile width its
					// Continue button is clipped off-screen — which makes Google
					// sign-in impossible, since that button is the only way through.
					// Enabling reports the dialog (including one already open) so the
					// viewer can draw its own; see fedcm.go.
					send("FedCm.enable", map[string]any{"disableRejectionDelay": true}, sid)
				}
			case "Page.javascriptDialogOpening":
				// The page is now BLOCKED until we answer. Forward it to the viewer;
				// the reply arrives via answerDialog (see the /kbd hub wiring in
				// main.go). If no viewer ever answers, the page stays blocked — the
				// same as a real browser with a dialog nobody clicks, and strictly
				// better than silently accepting a message the user never saw.
				params, _ := m["params"].(map[string]any)
				sid, _ := m["sessionId"].(string)
				if params != nil && sid != "" {
					msg, _ := params["message"].(string)
					dtype, _ := params["type"].(string)
					url, _ := params["url"].(string)
					def, _ := params["defaultPrompt"].(string)
					// Page.javascriptDialogOpening does NOT suppress Chromium's own
					// dialog, so a dialog we merely forward is drawn TWICE: the native
					// one (clipped, window-relative) plus our sheet.
					//
					// alert() has no return value, so we can accept it natively at
					// once — that removes it from the stream and unblocks the page
					// immediately — and show our sheet purely as a notification. The
					// message still reaches the user, which is the whole point.
					//
					// confirm/prompt/beforeunload cannot do this: their RESULT is what
					// the page acts on, so we must keep the page blocked until the user
					// chooses, and Chromium's dialog stays visible underneath until
					// then. Answering early to hide it would mean guessing the answer.
					informational := dtype == "alert"
					seq := e.noteDialogOpen(sid, informational)
					if informational {
						e.enqueueCmd(cdpCmd{
							method:  "Page.handleJavaScriptDialog",
							params:  map[string]any{"accept": true},
							session: sid,
						})
					}
					if sink := e.dialogSink(); sink != nil {
						// The ORIGIN is part of the payload on purpose: Chromium's own
						// dialog says "<origin> says", and dropping it would let one
						// origin's popup text be read as another's.
						b, err := json.Marshal(map[string]any{
							"dialog": map[string]any{
								"open": true, "seq": seq, "type": dtype,
								"message": msg, "url": url, "defaultPrompt": def,
								// notify=true: already answered, so the sheet is a
								// message to read, not a question to answer.
								"notify": informational,
							},
						})
						if err == nil {
							// A blocking dialog is CACHED for resync (a viewer that
							// reconnects mid-dialog must learn the page is stuck). A
							// notification is not: the page is already running, so
							// replaying it would show a viewer that connects minutes
							// later a stale message it can do nothing about.
							sink(b, !informational)
						}
					}
				}
			case "Page.javascriptDialogClosed":
				// Answered (by us, or by the browser itself on navigation). Tell the
				// viewer to take the sheet down and clear the resync cache.
				// Only for a dialog that was really blocking. An alert we accepted
				// natively closes within milliseconds, and broadcasting a close for it
				// would tear the notification sheet down before it could be read —
				// forgetDialog returns false for those, since they hold no session.
				sid, _ := m["sessionId"].(string)
				if e.forgetDialog(sid) {
					if sink := e.dialogSink(); sink != nil {
						if b, err := json.Marshal(map[string]any{"dialog": map[string]any{"open": false}}); err == nil {
							sink(b, false)
						}
					}
				}
			case "FedCm.dialogShown":
				params, _ := m["params"].(map[string]any)
				sid, _ := m["sessionId"].(string)
				if params != nil && sid != "" {
					title, _ := params["title"].(string)
					dtype, _ := params["dialogType"].(string)
					did, _ := params["dialogId"].(string)
					raw, _ := params["accounts"].([]any)
					accounts := make([]fedcmAccount, 0, len(raw))
					loginState, tos, privacy := "", "", ""
					for _, a := range raw {
						am, _ := a.(map[string]any)
						if am == nil {
							continue
						}
						id, _ := am["accountId"].(string)
						name, _ := am["name"].(string)
						email, _ := am["email"].(string)
						accounts = append(accounts, fedcmAccount{AccountID: id, Name: name, Email: email})
						// These ride on the account entries, not the dialog, but they
						// describe the RP so they are the same for every account.
						if loginState == "" {
							loginState, _ = am["loginState"].(string)
						}
						if tos == "" {
							tos, _ = am["termsOfServiceUrl"].(string)
						}
						if privacy == "" {
							privacy, _ = am["privacyPolicyUrl"].(string)
						}
					}
					if len(accounts) > 0 {
						seq := e.fedcm.note(sid, did, len(accounts))
						if sink := e.fedcm.sink(); sink != nil {
							if b, err := fedcmDialogPayload(seq, title, dtype, loginState, accounts, tos, privacy); err == nil {
								// Cached for resync ONLY while open: the payload carries a
								// real name and email, so a stale cached chooser must never
								// be replayable to a viewer that connects later. The close
								// below clears it.
								sink(b, true)
							}
						}
					}
				}
			case "FedCm.dialogClosed":
				sid, _ := m["sessionId"].(string)
				if e.fedcm.forget(sid) {
					if sink := e.fedcm.sink(); sink != nil {
						if b, err := json.Marshal(map[string]any{"dialog": map[string]any{"open": false}}); err == nil {
							sink(b, false)
						}
					}
				}
			case "Page.frameNavigated":
				// A full document loaded. Re-assert the emulation, but only for the
				// MAIN frame (no parentId) so sub-frames / ads / SPA embeds don't
				// cause repeated reflows. Fixes viewport reset on page-to-page
				// navigation in magnify.
				params, _ := m["params"].(map[string]any)
				if fr, _ := params["frame"].(map[string]any); fr != nil {
					if _, hasParent := fr["parentId"]; !hasParent {
						if sid, _ := m["sessionId"].(string); sid != "" && sessions[sid] {
							applyTo(sid)
						}
					}
				}
			case "Target.targetDestroyed":
				// A page went away — closed by us, by the sign-in flow completing, or
				// by the site. Once only the primary page is left the close affordance
				// must go, or the viewer keeps offering to close nothing. Discovery
				// (not attachment) delivers this, so it covers the windows we never
				// attach to as well.
				params, _ := m["params"].(map[string]any)
				if tid, _ := params["targetId"].(string); tid != "" {
					if seq, open, changed := e.forgetPage(tid); changed {
						e.publishPopup(seq, open)
					}
				}
			case "Target.detachedFromTarget":
				params, _ := m["params"].(map[string]any)
				if sid, _ := params["sessionId"].(string); sid != "" {
					delete(sessions, sid)
					// A closed tab takes its FedCM chooser with it too. forget(), never
					// dismiss: a dismissal would trigger Chrome's FedCM cooldown for the
					// site (hours to weeks) for what was really just a closed tab.
					if e.fedcm.forget(sid) {
						if sink := e.fedcm.sink(); sink != nil {
							if b, err := json.Marshal(map[string]any{"dialog": map[string]any{"open": false}}); err == nil {
								sink(b, false)
							}
						}
					}
					// A closed tab takes its dialog with it — drop the sheet, or the
					// viewer would be stuck showing a dialog nothing can answer.
					if e.forgetDialog(sid) {
						if sink := e.dialogSink(); sink != nil {
							if b, err := json.Marshal(map[string]any{"dialog": map[string]any{"open": false}}); err == nil {
								sink(b, false)
							}
						}
					}
					if e.activeSession() == sid {
						// Fall back to any remaining page session.
						e.setActive("")
						for other := range sessions {
							e.setActive(other)
							break
						}
					}
				}
			}
			// Command responses (have an id).
			if _, hasID := m["id"]; hasID {
				if result, ok := m["result"].(map[string]any); ok {
					// Browser.getWindowForTarget reply → fullscreen that window
					// (browser-level, no session). This is how popups lose their
					// location bar and fill the screen.
					//
					// FULLSCREEN IS THE ONLY STATE WE MAY EVER SET. Chromium's --kiosk
					// suppresses the tab strip and omnibox only while the window is
					// fullscreen: a window put into `normal` state draws its full chrome
					// inside the same geometry, so the user gets a real URL bar in a
					// session that is supposed to be a locked-down viewer. An earlier
					// version of this handler resized the window with explicit normal
					// bounds to cover a taller framebuffer, and that is exactly what it
					// leaked — measured 796px of browser UI inside the window. Do not
					// reintroduce a normal-state resize here; if a window must chase the
					// screen, the sanctioned path is the X-level fit in window.go
					// (requestWindowFit below), never un-fullscreening the kiosk.
					if wid, ok := result["windowId"]; ok {
						send("Browser.setWindowBounds", map[string]any{
							"windowId": wid,
							"bounds":   map[string]any{"windowState": "fullscreen"},
						}, "")
						// A window seen OUTSIDE fullscreen is a real transition (a popup just
						// opened normal+chromed) — the fullscreen size openbox grants it may
						// reflect a stale monitor geometry, so follow up with an X-level fit
						// (window.go). Gate on the reported state: this reply also arrives on
						// every 2s watchdog tick for already-fullscreen windows, and spawning
						// xdotool that often would spend the Rosetta fd budget the watcher's
						// slow backstop exists to protect (see window.go header).
						if b, _ := result["bounds"].(map[string]any); b != nil {
							if state, _ := b["windowState"].(string); state != "fullscreen" {
								requestWindowFit(log.Printf)
							}
						}
					}
					// Target.getTargets reply → attach to existing NON-popup pages, and
					// seed the page count. Seeding matters: the primary page already
					// exists when this connection opens, and if it were not counted the
					// next page to appear would look like the only one — no close button
					// on the very window the user needs to dismiss.
					if tis, ok := result["targetInfos"].([]any); ok {
						for _, x := range tis {
							if ti, _ := x.(map[string]any); ti != nil {
								if t, _ := ti["type"].(string); t == "page" {
									if tid, _ := ti["targetId"].(string); tid != "" {
										if seq, open, changed := e.notePage(tid); changed {
											e.publishPopup(seq, open)
										}
									}
								}
								attachIfMain(ti)
							}
						}
					}
				}
			}
		}
	}
}

func cdpBrowserWSURL(upstream string) (string, error) {
	var v struct {
		WebSocketDebuggerURL string `json:"webSocketDebuggerUrl"`
	}
	if err := cdpGetJSON("http://"+upstream+"/json/version", &v); err != nil {
		return "", err
	}
	if v.WebSocketDebuggerURL == "" {
		return "", fmt.Errorf("no webSocketDebuggerUrl")
	}
	return v.WebSocketDebuggerURL, nil
}

func cdpGetJSON(url string, out any) error {
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("status %d", resp.StatusCode)
	}
	return json.NewDecoder(bufio.NewReader(io.LimitReader(resp.Body, 1<<20))).Decode(out)
}
