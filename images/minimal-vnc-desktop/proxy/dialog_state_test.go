package main

import (
	"encoding/json"
	"testing"
)

// Dialog bookkeeping. Every rule here exists because breaking it leaves Chrome
// BLOCKED with no visible way out: the page is frozen behind a dialog, the viewer
// has no sheet (or a sheet whose reply resolves nothing), and the session is dead
// even though the stream still moves.

func newDialogEmulator(t *testing.T) (*emulator, *[][]byte) {
	t.Helper()
	// prio is the reserved queue dialog answers go on (see emulator.prio).
	e := &emulator{cmds: make(chan cdpCmd, 8), prio: make(chan cdpCmd, 8)}
	var sent [][]byte
	e.setDialogSink(func(payload []byte, open bool) {
		sent = append(sent, payload)
	})
	return e, &sent
}

func dialogOpen(t *testing.T, payload []byte) bool {
	t.Helper()
	var msg struct {
		Dialog struct {
			Open bool `json:"open"`
			Seq  uint64
		} `json:"dialog"`
	}
	if err := json.Unmarshal(payload, &msg); err != nil {
		t.Fatalf("unparsable dialog payload %s: %v", payload, err)
	}
	return msg.Dialog.Open
}

// A reply for an alert the proxy already accepted natively must resolve NOTHING —
// this is the reply that used to arrive late and clear a newer confirm's sheet.
func TestInformationalDialogIsNotAnswerable(t *testing.T) {
	e, _ := newDialogEmulator(t)
	seq := e.noteDialogOpen("S1", true)
	if e.answerDialog(seq, true, "") {
		t.Fatal("a notification alert has nothing left to answer")
	}
}

func TestBlockingDialogIsAnsweredOnItsOwnSession(t *testing.T) {
	e, _ := newDialogEmulator(t)
	seq := e.noteDialogOpen("S1", false)
	if !e.answerDialog(seq, true, "hello") {
		t.Fatal("answer rejected")
	}
	cmd := <-e.prio
	if cmd.method != "Page.handleJavaScriptDialog" || cmd.session != "S1" {
		t.Fatalf("wrong command: %+v", cmd)
	}
	if cmd.params["promptText"] != "hello" {
		t.Fatalf("prompt text lost: %+v", cmd.params)
	}
}

func TestStaleSequenceIsDropped(t *testing.T) {
	e, _ := newDialogEmulator(t)
	stale := e.noteDialogOpen("S1", false)
	e.publishDialogClosed("S1")
	e.noteDialogOpen("S1", false) // the page raised another one
	if e.answerDialog(stale, true, "") {
		t.Fatal("a reply for the dialog the user saw must not answer its successor")
	}
}

// Two attached pages can each block on their own confirm(). The second must not
// evict the first, or that page stays blocked with an unanswerable dialog.
func TestConcurrentDialogsAreTrackedPerTarget(t *testing.T) {
	e, _ := newDialogEmulator(t)
	first := e.noteDialogOpen("S1", false)
	second := e.noteDialogOpen("S2", false)

	if !e.answerDialog(second, true, "") {
		t.Fatal("second target's dialog rejected")
	}
	if cmd := <-e.prio; cmd.session != "S2" {
		t.Fatalf("answered session %q, want S2", cmd.session)
	}
	if !e.answerDialog(first, false, "") {
		t.Fatal("the FIRST target's dialog is still open and must remain answerable")
	}
	if cmd := <-e.prio; cmd.session != "S1" {
		t.Fatalf("answered session %q, want S1", cmd.session)
	}
}

// Closing one target's dialog clears the viewer's single sheet, so a dialog still
// blocking another target has to be republished or it becomes invisible.
func TestClosingOneDialogRepublishesTheOther(t *testing.T) {
	e, sent := newDialogEmulator(t)
	e.noteDialogOpen("S1", false)
	e.rememberDialogPayload(e.dlgSeq, []byte(`{"dialog":{"open":true,"seq":1,"type":"confirm"}}`))
	e.noteDialogOpen("S2", false)
	e.rememberDialogPayload(e.dlgSeq, []byte(`{"dialog":{"open":true,"seq":2,"type":"confirm"}}`))

	e.publishDialogClosed("S2")

	if len(*sent) != 2 {
		t.Fatalf("expected a close then a restore, got %d frames", len(*sent))
	}
	if dialogOpen(t, (*sent)[0]) {
		t.Fatal("first frame should take the answered sheet down")
	}
	if !dialogOpen(t, (*sent)[1]) {
		t.Fatal("the dialog still blocking S1 must be re-shown")
	}
}

func TestClosingTheLastDialogPublishesOnlyAClose(t *testing.T) {
	e, sent := newDialogEmulator(t)
	e.noteDialogOpen("S1", false)
	e.publishDialogClosed("S1")
	if len(*sent) != 1 || dialogOpen(t, (*sent)[0]) {
		t.Fatalf("want exactly one close frame, got %d: %s", len(*sent), *sent)
	}
	if e.answerDialog(1, true, "") {
		t.Fatal("a forgotten dialog must not be answerable")
	}
}

// A dialog whose answer never reached the CDP queue must stay tracked: the viewer
// can tap again, and a reconnecting viewer is still told the page is blocked.
func TestUnqueuedAnswerKeepsTheDialogAnswerable(t *testing.T) {
	e, _ := newDialogEmulator(t)
	e.prio = make(chan cdpCmd) // unbuffered, nothing reading: enqueue times out
	seq := e.noteDialogOpen("S1", false)

	if e.answerDialog(seq, true, "") {
		t.Fatal("answerDialog must report failure when the command was not queued")
	}

	// Now drain, as a live CDP connection would, and retry.
	done := make(chan cdpCmd, 1)
	go func() { done <- <-e.prio }()
	if !e.answerDialog(seq, true, "") {
		t.Fatal("the dialog must still be answerable after a dropped attempt")
	}
	if cmd := <-done; cmd.session != "S1" {
		t.Fatalf("retry went to %q", cmd.session)
	}
}

// The sessionIds a dialog is keyed by die with the CDP connection, so nothing
// could answer it afterwards — the sheet and its resync cache must be cleared.
func TestConnectionLossClearsDialogs(t *testing.T) {
	e, sent := newDialogEmulator(t)
	seq := e.noteDialogOpen("S1", false)
	e.resetDialogs()
	if len(*sent) != 1 || dialogOpen(t, (*sent)[0]) {
		t.Fatalf("want one close frame, got %d: %s", len(*sent), *sent)
	}
	if e.answerDialog(seq, true, "") {
		t.Fatal("a dialog from a dead connection must not be answerable")
	}
}

// alert() is answered by the USER, not instantly by us: accepting it the moment it
// opens made the page resume before the message was read and returned in ~18ms,
// which is itself an automation probe. The exception is an unattended session —
// there, a dialog nobody can see would freeze the page forever.
func TestAlertBlocksOnlyWhileSomeoneIsWatching(t *testing.T) {
	e, _ := newDialogEmulator(t)
	viewers := 0
	e.setViewerCounter(func() int { return viewers })

	for _, dtype := range []string{"alert", "confirm", "prompt", "beforeunload"} {
		if dtype == "alert" {
			if !e.dialogIsInformational(dtype) {
				t.Fatal("with no viewer attached, an alert must be accepted immediately")
			}
		} else if e.dialogIsInformational(dtype) {
			t.Fatalf("%s must never be auto-accepted: the page acts on its result", dtype)
		}
	}

	viewers = 1
	if e.dialogIsInformational("alert") {
		t.Fatal("with a viewer attached, an alert must stay blocked until it is acknowledged")
	}
	// And it is then a real, answerable dialog.
	seq := e.noteDialogOpen("S1", e.dialogIsInformational("alert"))
	if !e.dialogStillOpen(seq) {
		t.Fatal("an acknowledged-by-user alert must be tracked")
	}
	if !e.answerDialog(seq, true, "") {
		t.Fatal("the alert must be answerable by the viewer's tap")
	}
	if cmd := <-e.prio; cmd.params["accept"] != true {
		t.Fatalf("alert answered with %+v, want accept", cmd.params)
	}
}

func TestViewerCounterIgnoresThePublisher(t *testing.T) {
	hub := newKbdHub()
	pub := &kbdClient{publisher: true, notify: make(chan struct{}, 1), closed: make(chan struct{})}
	hub.add(pub)
	if got := hub.viewers(); got != 0 {
		t.Fatalf("viewers = %d with only the extension connected, want 0", got)
	}
	viewer := &kbdClient{notify: make(chan struct{}, 1), closed: make(chan struct{})}
	hub.add(viewer)
	if got := hub.viewers(); got != 1 {
		t.Fatalf("viewers = %d, want 1", got)
	}
}

// The emulator marshals a dialog already wrapped ({"dialog":{…}}), and every
// consumer downstream adds an envelope of its own. Caching the wrapped form made
// three of the four paths double-wrap, and the viewer unwraps exactly once — so
// the sheet read open:undefined and tore itself down. Under e2e that meant no
// dialog, popup or FedCM chooser was EVER drawn, while the page stayed blocked
// until the alertAckWait backstop accepted it. Assert the shape on every path.
func TestDialogStateIsWrappedExactlyOnceOnEveryPath(t *testing.T) {
	hub := newKbdHub()
	viewer := &kbdClient{notify: make(chan struct{}, 1), closed: make(chan struct{})}
	hub.add(viewer)
	e2e := &e2eControlClient{out: make(chan []byte, 8), done: make(chan struct{})}
	hub.addE2E(e2e)
	drain(e2e) // the geometry frame every e2e client opens with

	hub.broadcastDialog([]byte(`{"dialog":{"open":true,"seq":7,"type":"alert"}}`), true)

	// The /kbd frame keeps the wrapper: signal.js routes on the key.
	if got := string(viewer.takeDialog()); got != `{"dialog":{"open":true,"seq":7,"type":"alert"}}` {
		t.Fatalf("/kbd frame = %s", got)
	}
	// The e2e channel names the state in its own {type,payload} envelope, so the
	// payload is the BARE state.
	assertE2EDialogOpen(t, drain(e2e))
	// /kbdstate writes the state under a "dialog" key, so it caches the bare state.
	if _, dialog, _ := hub.snapshot(); string(dialog) != `{"open":true,"seq":7,"type":"alert"}` {
		t.Fatalf("cached state = %s", dialog)
	}

	// Both resync paths have to agree with their live counterparts.
	late := &kbdClient{notify: make(chan struct{}, 1), closed: make(chan struct{})}
	hub.add(late)
	if got := string(late.takeDialog()); got != `{"dialog":{"open":true,"seq":7,"type":"alert"}}` {
		t.Fatalf("/kbd resync frame = %s", got)
	}
	lateE2E := &e2eControlClient{out: make(chan []byte, 8), done: make(chan struct{})}
	hub.addE2E(lateE2E)
	assertE2EDialogOpen(t, drain(lateE2E))
}

// A popup rides the same shape, and the FedCM chooser rides the dialog path.
func TestPopupStateIsWrappedExactlyOnceOnEveryPath(t *testing.T) {
	hub := newKbdHub()
	viewer := &kbdClient{notify: make(chan struct{}, 1), closed: make(chan struct{})}
	hub.add(viewer)

	hub.broadcastPopup([]byte(`{"popup":{"open":true,"seq":2}}`), true)

	if got := string(viewer.takePopup()); got != `{"popup":{"open":true,"seq":2}}` {
		t.Fatalf("/kbd frame = %s", got)
	}
	if _, _, popup := hub.snapshot(); string(popup) != `{"open":true,"seq":2}` {
		t.Fatalf("cached state = %s", popup)
	}
}

func drain(c *e2eControlClient) [][]byte {
	var out [][]byte
	for len(c.out) > 0 {
		out = append(out, <-c.out)
	}
	return out
}

func assertE2EDialogOpen(t *testing.T, frames [][]byte) {
	t.Helper()
	for _, frame := range frames {
		var envelope struct {
			Type    string `json:"type"`
			Payload struct {
				Open bool   `json:"open"`
				Seq  uint64 `json:"seq"`
				Type string `json:"type"`
			} `json:"payload"`
		}
		if err := json.Unmarshal(frame, &envelope); err != nil || envelope.Type != "dialog" {
			continue
		}
		if !envelope.Payload.Open || envelope.Payload.Seq != 7 || envelope.Payload.Type != "alert" {
			t.Fatalf("e2e dialog payload = %s", frame)
		}
		return
	}
	t.Fatalf("no e2e dialog frame in %q", frames)
}

// The rest of the viewer's chrome — the soft keyboard, and the descriptors that
// open a LOCAL native select or temporal picker (state.selects / state.pickers)
// — rides the focus signal. That one is bare on both paths, and the e2e viewer
// hands it to applySignal untouched, so the two must stay byte-identical: a
// wrapper on this path would be read as a signal with no editable field, closing
// the keyboard and dropping every native control descriptor with it.
func TestFocusSignalIsIdenticalOnBothPaths(t *testing.T) {
	hub := newKbdHub()
	pub := &kbdClient{publisher: true, notify: make(chan struct{}, 1), closed: make(chan struct{})}
	hub.add(pub)
	viewer := &kbdClient{notify: make(chan struct{}, 1), closed: make(chan struct{})}
	hub.add(viewer)
	e2e := &e2eControlClient{out: make(chan []byte, 8), done: make(chan struct{})}
	hub.addE2E(e2e)
	drain(e2e)

	state := `{"editable":true,"vw":390,"vh":844,"selects":[{"key":"a:1","index":0}],"pickers":[{"key":"a:2","kind":"date"}]}`
	hub.publish(pub, []byte(state))

	if got := string(viewer.take()); got != state {
		t.Fatalf("/kbd signal frame = %s", got)
	}
	assertE2EPayload(t, drain(e2e), "signal", state)

	// And the resync a reconnecting viewer gets has to be the same state again.
	lateE2E := &e2eControlClient{out: make(chan []byte, 8), done: make(chan struct{})}
	hub.addE2E(lateE2E)
	assertE2EPayload(t, drain(lateE2E), "signal", state)
}

func assertE2EPayload(t *testing.T, frames [][]byte, typ, want string) {
	t.Helper()
	for _, frame := range frames {
		var envelope struct {
			Type    string          `json:"type"`
			Payload json.RawMessage `json:"payload"`
		}
		if err := json.Unmarshal(frame, &envelope); err != nil || envelope.Type != typ {
			continue
		}
		if string(envelope.Payload) != want {
			t.Fatalf("e2e %s payload:\n got %s\nwant %s", typ, envelope.Payload, want)
		}
		return
	}
	t.Fatalf("no e2e %s frame in %q", typ, frames)
}

// The viewer's local native controls (select, date/time picker) report a choice
// back over whichever transport it is on, and the two paths reach the SAME
// canonicalizer — the plaintext socket by content-sniffing the frame, the e2e
// channel by envelope type. A payload one accepts and the other refuses would let
// the encrypted transport diverge exactly where the dialog envelope already did,
// so pin the pair rather than trusting the shared call.
func TestNativeControlChoicesAgreeOnBothPaths(t *testing.T) {
	rejected := []string{
		`{}`,
		`{"selectChoice":{}}`,
		`{"selectChoice":{"key":"","index":0}}`,
		`{"selectChoice":{"key":"a b","index":0}}`,     // space is not in the key alphabet
		`{"selectChoice":{"key":"a:1","index":-1}}`,    // negative index
		`{"selectChoice":{"key":"a:1","index":65536}}`, // above the cap
		`{"pickerChoice":{"key":"a:1"}}`,               // select payload on the picker relay
		`not json`,
	}
	for _, payload := range rejected {
		hub := newKbdHub()
		hub.add(&kbdClient{publisher: true, notify: make(chan struct{}, 1), closed: make(chan struct{})})
		if hub.relaySelectChoice([]byte(payload)) {
			t.Fatalf("/kbd relay accepted %s", payload)
		}
		e2e := &e2eControlClient{hub: hub, out: make(chan []byte, 4), done: make(chan struct{})}
		frame := []byte(`{"type":"select-choice","payload":` + payload + `}`)
		if !json.Valid([]byte(payload)) {
			frame = []byte(`{"type":"select-choice","payload":"` + payload + `"}`)
		}
		if err := e2e.handle(frame); err == nil {
			t.Fatalf("e2e channel accepted %s", payload)
		}
	}

	// And the shape both are meant to take is accepted by both, with the publisher
	// receiving the identical canonical frame either way.
	hub := newKbdHub()
	pub := &kbdClient{publisher: true, notify: make(chan struct{}, 1), closed: make(chan struct{})}
	hub.add(pub)
	pub.takeCtl() // the mirror state every publisher is told on connect
	if !hub.relaySelectChoice([]byte(`{"selectChoice":{"key":"a:1","index":2}}`)) {
		t.Fatal("/kbd relay rejected a valid choice")
	}
	viaPlain := joinFrames(pub.takeCtl())
	e2e := &e2eControlClient{hub: hub, out: make(chan []byte, 4), done: make(chan struct{})}
	if err := e2e.handle([]byte(`{"type":"select-choice","payload":{"selectChoice":{"key":"a:1","index":2}}}`)); err != nil {
		t.Fatalf("e2e channel rejected a valid choice: %v", err)
	}
	if viaE2E := joinFrames(pub.takeCtl()); viaE2E != viaPlain {
		t.Fatalf("publisher frames differ:\n /kbd %s\n e2e  %s", viaPlain, viaE2E)
	}
}

func joinFrames(frames [][]byte) string {
	out := ""
	for _, f := range frames {
		out += string(f)
	}
	return out
}
