package main

// Device viewport emulation. The public endpoint accepts only validated
// emulation settings; the full CDP endpoint remains loopback-only.

import (
	"bufio"
	"encoding/json"
	"errors"
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

// emulator maintains device emulation and sends native touch events over CDP.
type emulator struct {
	cdpUpstream string
	mu          sync.Mutex
	params      *emulateRequest
	dirty       chan struct{}
	cmds        chan cdpCmd // input/other commands to send on the live session
	// prio reserves capacity for terminal input events and dialog answers.
	prio chan cdpCmd
	// inputDesync triggers a cancel before the next gesture after a lost terminal event.
	inputDesync atomic.Bool

	sessMu sync.Mutex
	active string // page sessionId that receives input (the foreground window)
	// sessTarget maps CDP sessions to targets for foreground input routing.
	sessTarget map[string]string

	// Browser dialogs and FedCM are rendered by the viewer to avoid mobile clipping.
	// The proxy alone sends their CDP responses.
	fedcm fedcmState

	// Dialog state is per target; dlgSeq rejects stale viewer replies.
	dlgMu    sync.Mutex
	dlgSeq   uint64
	dialogs  map[string]*openDialog
	onDialog func(payload []byte, open bool)
	// viewerCount determines whether an alert can be shown to a user.
	viewerCount func() int

	// Track all top-level pages. The viewer may close a focused secondary page;
	// the newest page is used until the extension reports foreground focus.
	popMu      sync.Mutex
	pages      []pageEntry // top-level pages, creation order (newest last)
	popFront   string      // targetId currently advertised as closable ("" = none)
	popSeq     uint64      // identifies that window; stale taps are dropped
	foreground string      // URL of the focused top document ("" = unknown)
	onPopup    func(payload []byte, open bool)
}

// pageEntry associates a top-level target with its URL for focus matching.
type pageEntry struct {
	targetID string
	url      string
}

// cdpCmd is a command queued from another goroutine (e.g. the /input handler)
// to be written on the emulator's live CDP connection.
type cdpCmd struct {
	method  string
	params  map[string]any
	session string
	// done observes whether the command was written to the live CDP socket.
	// It is used only by opt-in /input diagnostics; normal commands leave it nil.
	done func(bool)
}

// openDialog stores a blocking dialog and its viewer payload.
type openDialog struct {
	seq     uint64
	session string
	payload []byte
}

// alertAckWait prevents an unattended alert from blocking a page indefinitely.
const alertAckWait = 15 * time.Second

// setViewerCounter installs the "is anyone watching" probe (the /kbd hub).
func (e *emulator) setViewerCounter(f func() int) {
	e.dlgMu.Lock()
	e.viewerCount = f
	e.dlgMu.Unlock()
}

// dialogIsInformational reports whether a dialog can be accepted the moment it
// opens, making our sheet a message to read rather than a question to answer. Only
// an alert with NOBODY watching qualifies: alert() has no return value, so accepting
// it invents nothing — but doing so while a viewer is attached is what used to make
// the message vanish before it was read and hand the page a machine-fast return.
func (e *emulator) dialogIsInformational(dialogType string) bool {
	return dialogType == "alert" && !e.hasViewer()
}

func (e *emulator) hasViewer() bool {
	e.dlgMu.Lock()
	f := e.viewerCount
	e.dlgMu.Unlock()
	return f != nil && f() > 0
}

// dialogStillOpen reports whether the dialog with this sequence number is still
// waiting for an answer.
func (e *emulator) dialogStillOpen(seq uint64) bool {
	e.dlgMu.Lock()
	defer e.dlgMu.Unlock()
	for _, d := range e.dialogs {
		if d.seq == seq {
			return true
		}
	}
	return false
}

// setDialogSink installs the fan-out used to tell viewers about a dialog.
func (e *emulator) setDialogSink(f func(payload []byte, open bool)) {
	e.dlgMu.Lock()
	e.onDialog = f
	e.dlgMu.Unlock()
}

// noteDialogOpen records the dialog and returns its sequence number. An
// informational one (an alert accepted natively because no viewer is attached) is
// NOT recorded: there is nothing left to answer, so a later reply must not resolve
// anything. See dialogIsInformational.
func (e *emulator) noteDialogOpen(sessionID string, informational bool) uint64 {
	e.dlgMu.Lock()
	defer e.dlgMu.Unlock()
	e.dlgSeq++
	if !informational {
		if e.dialogs == nil {
			e.dialogs = make(map[string]*openDialog)
		}
		e.dialogs[sessionID] = &openDialog{seq: e.dlgSeq, session: sessionID}
	}
	return e.dlgSeq
}

// rememberDialogPayload stores the state broadcast for a dialog so it can be
// republished when an unrelated dialog closes (see forgetDialog).
func (e *emulator) rememberDialogPayload(seq uint64, payload []byte) {
	e.dlgMu.Lock()
	defer e.dlgMu.Unlock()
	for _, d := range e.dialogs {
		if d.seq == seq {
			d.payload = payload
			return
		}
	}
}

func (e *emulator) dialogSink() func([]byte, bool) {
	e.dlgMu.Lock()
	defer e.dlgMu.Unlock()
	return e.onDialog
}

// answerDialog resolves the dialog identified by `seq`. The sequence number must
// match a dialog that is still open: on a slow link a reply for a DISMISSED
// dialog can arrive after the page has opened another one (a validation loop
// fires alert() repeatedly), and answering the new dialog with the old tap would
// accept something the user never saw. A mismatched or absent dialog is dropped.
//
// Reports whether the answer was really dispatched. The dialog is deliberately
// NOT forgotten here: Chrome's Page.javascriptDialogClosed is the only proof it
// closed, and clearing state before that (as an earlier version did) meant a
// command dropped by a saturated CDP queue left Chrome blocked with the viewer's
// sheet gone and nothing cached to resync. Keeping the entry lets the viewer tap
// again and a reconnecting viewer see the dialog that is still blocking the page.
func (e *emulator) answerDialog(seq uint64, accept bool, text string) bool {
	e.dlgMu.Lock()
	var target *openDialog
	for _, d := range e.dialogs {
		if d.seq == seq {
			target = d
			break
		}
	}
	if target == nil {
		e.dlgMu.Unlock()
		return false
	}
	sid := target.session
	e.dlgMu.Unlock()

	p := map[string]any{"accept": accept}
	if accept && text != "" {
		p["promptText"] = text
	}
	return e.enqueuePriority(cdpCmd{method: "Page.handleJavaScriptDialog", params: p, session: sid}, dialogEnqueueWait)
}

// resetSessions forgets the session->target map when the connection dies: those
// sessionIds are gone, and a stale one would route input nowhere.
func (e *emulator) resetSessions() {
	e.sessMu.Lock()
	e.sessTarget = nil
	e.sessMu.Unlock()
}

// resetDialogs drops every tracked dialog when the CDP connection dies. Their
// sessionIds die with it, so nothing could answer them afterwards; leaving the
// state would strand a sheet — and the resync cache behind it — on a dialog no
// reply can ever reach.
func (e *emulator) resetDialogs() {
	e.dlgMu.Lock()
	had := len(e.dialogs) > 0
	e.dialogs = nil
	e.dlgMu.Unlock()
	if !had {
		return
	}
	if sink := e.dialogSink(); sink != nil {
		if b, err := json.Marshal(map[string]any{"dialog": map[string]any{"open": false}}); err == nil {
			sink(b, false)
		}
	}
}

// forgetDialog clears one target's dialog state without answering (Chrome
// reported it closed, the target detached, or the page navigated out from under
// it), so a later reply can't be applied to nothing. Returns whether anything was
// forgotten plus the newest dialog STILL blocking another target, whose state has
// to be republished because the viewer holds only one dialog at a time.
func (e *emulator) forgetDialog(sessionID string) (bool, []byte) {
	e.dlgMu.Lock()
	defer e.dlgMu.Unlock()
	if _, ok := e.dialogs[sessionID]; !ok {
		return false, nil
	}
	delete(e.dialogs, sessionID)
	var newest *openDialog
	for _, d := range e.dialogs {
		if newest == nil || d.seq > newest.seq {
			newest = d
		}
	}
	if newest == nil {
		return true, nil
	}
	return true, newest.payload
}

// publishDialogClosed tells viewers a target's dialog is gone, then restores any
// dialog still blocking another target.
func (e *emulator) publishDialogClosed(sessionID string) {
	forgotten, remaining := e.forgetDialog(sessionID)
	if !forgotten {
		return
	}
	sink := e.dialogSink()
	if sink == nil {
		return
	}
	if b, err := json.Marshal(map[string]any{"dialog": map[string]any{"open": false}}); err == nil {
		sink(b, false)
	}
	if remaining != nil {
		sink(remaining, true)
	}
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
	out := make([]string, 0, len(e.pages))
	for _, p := range e.pages {
		out = append(out, p.targetID)
	}
	return out
}

// frontLocked is the window we offer to close. Never with fewer than two pages
// (the last page standing IS the session). Otherwise:
//
//   - the page the extension reports as FOCUSED, when that is not the first page
//     tracked — that is the window actually in front of the user;
//   - nothing, when the focused page is the first one: the user is looking at the
//     page they started from, so there is nothing covering it to dismiss (the
//     affordance comes back the moment a popup takes focus again);
//   - the newest page, when we have no focus report to go on (extension not up
//     yet, or a window with no content script) — the old creation-order rule as
//     the fallback.
func (e *emulator) frontLocked() string {
	if len(e.pages) < 2 {
		return ""
	}
	if e.foreground != "" {
		for i, p := range e.pages {
			if p.url != "" && sameDocument(p.url, e.foreground) {
				if i == 0 {
					return ""
				}
				return p.targetID
			}
		}
	}
	return e.pages[len(e.pages)-1].targetID
}

// sameDocument compares a CDP target URL with the URL the extension reported for
// the focused document. Fragments are ignored: an in-page anchor is not a different
// window, and the two sources can disagree about one.
func sameDocument(targetURL, reported string) bool {
	return strings.TrimSuffix(trimFragment(targetURL), "/") == strings.TrimSuffix(trimFragment(reported), "/")
}

func trimFragment(u string) string {
	if i := strings.IndexByte(u, '#'); i >= 0 {
		return u[:i]
	}
	return u
}

// setForeground records which document the user is looking at (from the extension's
// document.hasFocus() report — see keyboard.go's publisher control frames) and
// republishes the close affordance if that changed which window it points at.
func (e *emulator) setForeground(url string) (seq uint64, open bool, changed bool) {
	e.popMu.Lock()
	defer e.popMu.Unlock()
	if url == e.foreground {
		return e.popSeq, e.popFront != "", false
	}
	e.foreground = url
	// Route input to the window the user is looking at. Attach order was the only
	// signal before, so a site that refocused an older window (or its opener) kept
	// receiving touches on the newest target instead — the same class of bug as the
	// close button pointing at the wrong window, and invisible to the user because
	// the stream still moves.
	for _, p := range e.pages {
		if p.url != "" && sameDocument(p.url, url) {
			if sid := e.sessionForTarget(p.targetID); sid != "" {
				e.setActive(sid)
			}
			break
		}
	}
	return e.republishLocked()
}

// notePageURL keeps a tracked page's URL current (targetInfoChanged fires on every
// navigation), so the foreground report keeps matching after the popup navigates.
func (e *emulator) notePageURL(targetID, url string) (seq uint64, open bool, changed bool) {
	e.popMu.Lock()
	defer e.popMu.Unlock()
	for i := range e.pages {
		if e.pages[i].targetID == targetID {
			if e.pages[i].url == url || url == "" {
				return e.popSeq, e.popFront != "", false
			}
			e.pages[i].url = url
			return e.republishLocked()
		}
	}
	return e.popSeq, e.popFront != "", false
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
func (e *emulator) notePage(targetID, url string) (seq uint64, open bool, changed bool) {
	e.popMu.Lock()
	defer e.popMu.Unlock()
	for i, p := range e.pages {
		if p.targetID == targetID {
			// targetCreated can repeat; a later report may carry the url the first
			// one lacked (a popup opens blank, then navigates).
			if url != "" && p.url != url {
				e.pages[i].url = url
				return e.republishLocked()
			}
			return e.popSeq, e.popFront != "", false
		}
	}
	e.pages = append(e.pages, pageEntry{targetID: targetID, url: url})
	return e.republishLocked()
}

// forgetPage drops a destroyed page and republishes. Reports changed=false for a
// target we never tracked (targetDestroyed fires for iframes, workers and every
// other target type), so unrelated churn never flickers the button.
func (e *emulator) forgetPage(targetID string) (seq uint64, open bool, changed bool) {
	e.popMu.Lock()
	defer e.popMu.Unlock()
	idx := -1
	for i, p := range e.pages {
		if p.targetID == targetID {
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
	e := &emulator{
		cdpUpstream: cdpUpstream,
		dirty:       make(chan struct{}, 1),
		cmds:        make(chan cdpCmd, 512),
		prio:        make(chan cdpCmd, 64),
	}
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

// noteSession records an attached page session and makes it active (a freshly
// attached page is in front). forgetSession drops it.
func (e *emulator) noteSession(sid, targetID string) {
	e.sessMu.Lock()
	if e.sessTarget == nil {
		e.sessTarget = make(map[string]string)
	}
	e.sessTarget[sid] = targetID
	e.active = sid
	e.sessMu.Unlock()
}

func (e *emulator) forgetSession(sid string) {
	e.sessMu.Lock()
	delete(e.sessTarget, sid)
	e.sessMu.Unlock()
}

// sessTargetOf returns the targetId an attached session belongs to.
func (e *emulator) sessTargetOf(sid string) string {
	e.sessMu.Lock()
	defer e.sessMu.Unlock()
	return e.sessTarget[sid]
}

// sessionForTarget returns the attached session for a targetId, if we have one.
func (e *emulator) sessionForTarget(targetID string) string {
	e.sessMu.Lock()
	defer e.sessMu.Unlock()
	for sid, tid := range e.sessTarget {
		if tid == targetID {
			return sid
		}
	}
	return ""
}

func (e *emulator) activeSession() string {
	e.sessMu.Lock()
	defer e.sessMu.Unlock()
	return e.active
}

// enqueue a command for the active page session; drops if no session or the
// queue is full (input is high-frequency; a dropped move self-corrects).
func (e *emulator) queue(method string, params map[string]any) {
	e.queueWithDone(method, params, nil)
}

func (e *emulator) queueWithDone(method string, params map[string]any, done func(bool)) bool {
	sid := e.activeSession()
	if sid == "" {
		return false
	}
	select {
	case e.cmds <- cdpCmd{method: method, params: params, session: sid, done: done}:
		return true
	default:
		return false
	}
}

// queueImportant enqueues a command that MUST NOT be silently dropped. A dropped
// touchStart/End/Cancel leaves the remote page with a stuck finger (the touch
// sequence never balances), so it goes on the RESERVED queue (e.prio), which
// moves are never written to — a burst of touchMoves can fill e.cmds without
// costing the touchEnd behind it a single slot. Bounded so a wedged consumer can't
// stall the /input read loop forever; if it does expire, the gesture is marked
// desynced and the next one opens with a cancel.
func (e *emulator) queueImportant(method string, params map[string]any) {
	e.queueImportantWithDone(method, params, nil)
}

func (e *emulator) queueImportantWithDone(method string, params map[string]any, done func(bool)) bool {
	sid := e.activeSession()
	if sid == "" {
		return false
	}
	if !e.enqueuePriority(cdpCmd{method: method, params: params, session: sid, done: done}, inputEnqueueWait) {
		e.inputDesync.Store(true)
		return false
	}
	return true
}

// cmdEnqueueWait bounds a generic queued command; dialogEnqueueWait bounds one
// whose loss WEDGES the page (a dialog answer). The long bound is affordable
// because a dialog answer is a single human-paced event, and losing it is the
// expensive outcome: Chrome stays blocked until something else answers.
const (
	cmdEnqueueWait    = 200 * time.Millisecond
	inputEnqueueWait  = 200 * time.Millisecond
	dialogEnqueueWait = 3 * time.Second
)

// enqueuePriority queues on the reserved channel (see emulator.prio). Same bounded
// wait as enqueueCmd, but the queue it competes for carries only never-drop
// commands, so the bound is reached only when the CDP consumer itself is wedged.
func (e *emulator) enqueuePriority(cmd cdpCmd, wait time.Duration) bool {
	select {
	case e.prio <- cmd:
		return true
	default:
	}
	timer := time.NewTimer(wait)
	defer timer.Stop()
	select {
	case e.prio <- cmd:
		return true
	case <-timer.C:
		return false
	}
}

// enqueueCmd queues a command for a SPECIFIC session (queueImportant always
// targets the foreground one). A dialog must be answered on the session that
// raised it, which may not be the foreground target — a popup can block on its
// own alert. Bounded wait, then dropped, so a wedged consumer can't pin the
// caller.
func (e *emulator) enqueueCmd(cmd cdpCmd) bool {
	return e.enqueueCmdWait(cmd, cmdEnqueueWait)
}

// enqueueCmdWait is enqueueCmd with an explicit bound. Reports whether the
// command was queued, so a caller whose state depends on it (a dialog answer)
// can keep that state instead of assuming the command went out.
func (e *emulator) enqueueCmdWait(cmd cdpCmd, wait time.Duration) bool {
	select {
	case e.cmds <- cmd:
		return true
	default:
	}
	timer := time.NewTimer(wait)
	defer timer.Stop()
	select {
	case e.cmds <- cmd:
		return true
	case <-timer.C:
		return false
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
	e.dispatchTouchWithDone(evType, points, nil)
}

// dispatchTouchWithDone queues a native touch command and reports whether it
// entered the CDP queue. done runs once the command is written (or rejected
// because its target disappeared).
func (e *emulator) dispatchTouchWithDone(evType string, points []touchPoint, done func(bool)) bool {
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
	// A gesture that lost its terminal event left the remote holding a finger down.
	// Clear it before starting a new one, or the two touches combine into a pinch /
	// drag the user never made. Sent on the reserved queue like any other terminal
	// event; if even this is lost the flag stays set and the next start retries.
	if evType == "touchStart" && e.inputDesync.Load() {
		if e.enqueuePriority(cdpCmd{
			method:  "Input.dispatchTouchEvent",
			params:  map[string]any{"type": "touchCancel", "touchPoints": []map[string]any{}},
			session: e.activeSession(),
		}, inputEnqueueWait) {
			e.inputDesync.Store(false)
		}
	}
	params := map[string]any{"type": evType, "touchPoints": tp}
	if evType == "touchMove" {
		return e.queueWithDone("Input.dispatchTouchEvent", params, done) // high-frequency; a dropped move self-corrects
	} else {
		return e.queueImportantWithDone("Input.dispatchTouchEvent", params, done) // start/end/cancel: never drop (stuck-finger)
	}
}

// dispatchCompatClick sends compatibility mouse events after a touch tap.
// Google Identity requires these to use pointerType "mouse" for one-tap
// activation inside its cross-origin frame.
//
// queueImportant, not queue: a dropped release leaves the remote page with a held
// mouse button, which is the same class of stuck-input bug as a dropped touchEnd.
func (e *emulator) dispatchCompatClick(p touchPoint) {
	e.dispatchCompatClickWithDone(p, nil)
}

func (e *emulator) dispatchCompatClickWithDone(p touchPoint, done func(bool)) bool {
	base := map[string]any{
		"x": p.X, "y": p.Y,
		"button": "left", "clickCount": 1,
		"pointerType": "mouse",
	}
	press := map[string]any{"type": "mousePressed", "buttons": 1}
	release := map[string]any{"type": "mouseReleased", "buttons": 0}
	for k, v := range base {
		press[k] = v
		release[k] = v
	}
	// A compatibility click is complete only after the release is written.
	if !e.queueImportantWithDone("Input.dispatchMouseEvent", press, nil) {
		return false
	}
	return e.queueImportantWithDone("Input.dispatchMouseEvent", release, done)
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
		// A terminal input acknowledgement closes the diagnostic blind spot: the
		// viewer can distinguish "sent to /input" from "written to the browser". It carries
		// only a random per-load SID, gesture id, event kind, and outcome.
		ackInput := func(sid string, gesture uint64, event, state string) {
			if sid == "" || gesture == 0 {
				return
			}
			b, err := json.Marshal(map[string]any{
				"diag": "input", "sid": sid, "g": gesture, "t": event, "state": state,
			})
			if err != nil {
				return
			}
			_ = conn.SetWriteDeadline(time.Now().Add(inputWriteDeadline))
			_ = writeFrameToConn(conn, &writeMu, 0x1, b, false, true)
		}
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
			// Capped at the length header: a touch message is a few hundred bytes, and decoding at the
			// transport ceiling let a client force a 64 MiB allocation per frame before we checked the size.
			fin, opcode, payload, err := readFrameLimit(rw.Reader, inputMaxPayload)
			if errors.Is(err, errFrameTooLarge) {
				continue // matches the pre-existing len(payload) > inputMaxPayload skip
			}
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
				D      string       `json:"d"` // opt-in diagnostic session id
				G      uint64       `json:"g"` // opt-in diagnostic gesture id
			}
			if json.Unmarshal(payload, &msg) != nil {
				continue
			}
			sid := klogSanitize(msg.D, 24)
			gesture := msg.G
			event := msg.T
			// One terminal acknowledgement proves the whole gesture path. Start is
			// intentionally omitted on the success path to keep permanent diagnostics
			// to a single browser round-trip per tap; an end/cancel failure still tells
			// us that the gesture could not complete.
			diagnostic := sid != "" && msg.G != 0 && (msg.T == "end" || msg.T == "cancel" || msg.T == "click")
			traceDone := func(ok bool) {
				if !diagnostic {
					return
				}
				state := "written"
				if !ok {
					state = "not-written"
					diagLog.Printf("[popcorn-input sid=%s] g=%d type=%s browser=%s", sid, gesture, event, state)
				}
				ackInput(sid, gesture, event, state)
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
				queued := len(msg.Points) == 1 && em.dispatchCompatClickWithDone(msg.Points[0], traceDone)
				if diagnostic {
					if !queued {
						diagLog.Printf("[popcorn-input sid=%s] g=%d type=%s points=%d rejected", sid, msg.G, msg.T, len(msg.Points))
						ackInput(sid, msg.G, msg.T, "rejected")
					}
				}
				continue
			default:
				continue
			}
			queued := em.dispatchTouchWithDone(evType, msg.Points, traceDone)
			if diagnostic {
				if !queued {
					diagLog.Printf("[popcorn-input sid=%s] g=%d type=%s points=%d rejected", sid, msg.G, msg.T, len(msg.Points))
					ackInput(sid, msg.G, msg.T, "rejected")
				}
			}
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
	send := func(method string, params map[string]any, sessionID string) (int, bool) {
		id := int(atomic.AddInt64(&idCounter, 1))
		msg := map[string]any{"id": id, "method": method, "params": params}
		if sessionID != "" {
			msg["sessionId"] = sessionID
		}
		b, _ := json.Marshal(msg)
		return id, writeFrameToConn(conn, &writeMu, 0x1, b, true, true) == nil
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
	attached := map[string]bool{} // targetIds we have already asked to attach

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
		if tid, _ := ti["targetId"].(string); tid != "" && !attached[tid] {
			attached[tid] = true
			send("Target.attachToTarget", map[string]any{"targetId": tid, "flatten": true}, "")
		}
	}

	// A popup that has NAVIGATED is safe to attach, and has to be: input routing
	// follows attached sessions, so an unattached popup in front of the user sent
	// every touch to the hidden page underneath — an OAuth/payment window was
	// unusable on a phone, where /input is the only way to interact at all.
	//
	// Still not attached while BLANK: the opener drives that first navigation
	// (GSI opens about:blank then navigates it cross-origin), and a debugging
	// session severs it, so the window would open blank and stay blank. Once a real
	// URL is loaded that navigation has already happened, so attaching here keeps
	// the flow intact — and the window gets mobile emulation like any other page.
	//
	// Gated on touch emulation: that is exactly the mode whose input depends on a
	// session (a plain desktop viewer drives these windows with real VNC mouse
	// events, which need no CDP target at all), so a non-magnify session keeps the
	// previous fully-native popup behaviour.
	attachNavigatedPopup := func(ti map[string]any) {
		if t, _ := ti["type"].(string); t != "page" {
			return
		}
		tid, _ := ti["targetId"].(string)
		if tid == "" || attached[tid] {
			return
		}
		u, _ := ti["url"].(string)
		if !strings.HasPrefix(u, "http://") && !strings.HasPrefix(u, "https://") {
			return
		}
		if p := e.current(); p == nil || !p.Touch {
			return
		}
		attached[tid] = true
		send("Target.attachToTarget", map[string]any{"targetId": tid, "flatten": true}, "")
	}

	// foreground picks the session of the NEWEST tracked page, so input falls back
	// to the window actually in front of the user rather than to whichever map entry
	// came out first (which could be a background tab).
	foreground := func() string {
		pages := e.pageTargets()
		for i := len(pages) - 1; i >= 0; i-- {
			if sid := e.sessionForTarget(pages[i]); sid != "" && sessions[sid] {
				return sid
			}
		}
		return ""
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

	// Ensure active session and dialog state are cleared when this connection dies
	// — both are keyed by sessionIds that do not survive it.
	defer e.setActive("")
	defer e.resetSessions()
	defer e.resetDialogs()

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
		case c := <-e.prio:
			// The reserved queue is selected alongside cmds, so a never-drop command
			// never waits behind a backlog of moves.
			ok := false
			if c.session == "" {
				_, ok = send(c.method, c.params, "")
			} else if sessions[c.session] {
				_, ok = send(c.method, c.params, c.session)
			}
			if c.done != nil {
				c.done(ok)
			}
		case c := <-e.cmds:
			// A browser-level command (empty session) addresses a target by id —
			// closing an unattached OAuth popup is the case that needs it, since
			// those never get a session at all.
			if c.session == "" {
				_, ok := send(c.method, c.params, "")
				if c.done != nil {
					c.done(ok)
				}
				continue
			}
			// Otherwise only dispatch if the target session still exists.
			if sessions[c.session] {
				_, ok := send(c.method, c.params, c.session)
				if c.done != nil {
					c.done(ok)
				}
			} else if c.done != nil {
				c.done(false)
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
						if seq, open, changed := e.notePage(tid, url); changed {
							e.publishPopup(seq, open)
						}
					}
					if t == "page" && op != "" {
						if tid != "" {
							send("Browser.getWindowForTarget", map[string]any{"targetId": tid}, "")
							if url != "" && url != "about:blank" && !attached[tid] {
								attached[tid] = true
								send("Target.attachToTarget", map[string]any{"targetId": tid, "flatten": true}, "")
							}
						}
					} else {
						attachIfMain(ti)
					}
				}
			case "Target.targetInfoChanged":
				// Discovery reports every url change, which is how we learn that a blank
				// popup has become a real page — the moment it is safe to attach one, and
				// the moment its URL can start matching the extension's foreground report.
				params, _ := m["params"].(map[string]any)
				if ti, _ := params["targetInfo"].(map[string]any); ti != nil {
					if t, _ := ti["type"].(string); t == "page" {
						tid, _ := ti["targetId"].(string)
						u, _ := ti["url"].(string)
						if tid != "" {
							if seq, open, changed := e.notePageURL(tid, u); changed {
								e.publishPopup(seq, open)
							}
						}
					}
					attachNavigatedPopup(ti)
				}
			case "Target.attachedToTarget":
				params, _ := m["params"].(map[string]any)
				ti, _ := params["targetInfo"].(map[string]any)
				sid, _ := params["sessionId"].(string)
				// attachedToTarget only fires for targets we explicitly attached (main
				// tab, real-URL content tabs, and a popup once it has NAVIGATED) — never a
				// blank popup, whose opener-driven navigation a debugging session would
				// sever — so emulate whatever arrives here.
				if t, _ := ti["type"].(string); t == "page" && sid != "" {
					sessions[sid] = true
					if tid, _ := ti["targetId"].(string); tid != "" {
						attached[tid] = true
						e.noteSession(sid, tid) // and it becomes the input target
					} else {
						e.setActive(sid)
					}
					applyTo(sid) // apply now for the current document
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
					// alert() is BLOCKING here, like every other dialog. An earlier version
					// accepted it natively the instant it opened and showed the sheet as a
					// mere notification — so the page resumed before the user had read
					// anything (breaking any flow that waits for the acknowledgement), and
					// alert() returned in ~18ms where a human takes seconds. That timing is
					// a published anti-automation probe: t=now(); alert(x); now()-t. So the
					// answer waits for the tap now, exactly like confirm.
					//
					// Two exceptions keep an unattended session alive, because a dialog
					// nobody can answer would otherwise freeze the page for good:
					//   - no viewer attached: accept at once (nobody can ever read it);
					//   - a viewer attached but silent for alertAckWait: accept then.
					// Neither applies to confirm/prompt/beforeunload, whose RESULT the page
					// acts on — guessing that is worse than staying blocked.
					informational := e.dialogIsInformational(dtype)
					seq := e.noteDialogOpen(sid, informational)
					if informational {
						// Written STRAIGHT to the socket, not queued. We are on the
						// connection's own goroutine — the one that drains e.cmds — so a
						// queued send could be dropped (or block the drain) exactly when
						// this accept is the only thing that unblocks the page, and the
						// sheet we show for it has no answer button to retry with.
						send("Page.handleJavaScriptDialog", map[string]any{"accept": true}, sid)
					} else if dtype == "alert" {
						// Liveness backstop for an alert the user never acknowledges (the viewer
						// went away mid-dialog, or the page fires them in a loop). Off the event
						// loop, and it re-checks the sequence number so it can only ever answer
						// the dialog it was armed for.
						go func(seq uint64) {
							time.Sleep(alertAckWait)
							if !e.dialogStillOpen(seq) {
								return
							}
							log.Printf("dialog: alert unacknowledged for %s, accepting so the page can continue", alertAckWait)
							e.answerDialog(seq, true, "")
						}(seq)
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
							// Kept so this dialog can be restored if a dialog on ANOTHER
							// target closes and clears the viewer's single sheet.
							if !informational {
								e.rememberDialogPayload(seq, b)
							}
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
				// forgetDialog returns false for those, since they were never recorded.
				// This is also the ONLY place a viewer's answer is confirmed: the reply
				// path dispatches handleJavaScriptDialog and leaves the state alone, so
				// the sheet comes down when Chrome really closed the dialog.
				sid, _ := m["sessionId"].(string)
				e.publishDialogClosed(sid)
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
					if tid := e.sessTargetOf(sid); tid != "" {
						// Re-attachable: a target that detaches without being destroyed
						// (crash, session teardown) has to be reachable again.
						delete(attached, tid)
					}
					e.forgetSession(sid)
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
					// viewer would be stuck showing a dialog nothing can answer. Any
					// dialog still blocking another tab is republished by this call.
					e.publishDialogClosed(sid)
					if e.activeSession() == sid {
						// Fall back to the page now in FRONT (newest tracked window), not
						// to an arbitrary remaining session: after a popup closes, input
						// has to land on the window the user is looking at.
						next := foreground()
						if next == "" {
							for other := range sessions {
								next = other
								break
							}
						}
						e.setActive(next)
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
						// opened normal+chromed), and the size openbox grants it may reflect a
						// stale monitor geometry — so follow up with an X-level fit
						// (window.go). Gate on the state: this reply also arrives on every
						// watchdog tick for already-fullscreen windows, and spawning xdotool
						// that often costs fd budget under Rosetta (see window.go).
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
										u, _ := ti["url"].(string)
										if seq, open, changed := e.notePage(tid, u); changed {
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
