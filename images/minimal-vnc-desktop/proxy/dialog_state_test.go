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
	e := &emulator{cmds: make(chan cdpCmd, 8)}
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
	cmd := <-e.cmds
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
	if cmd := <-e.cmds; cmd.session != "S2" {
		t.Fatalf("answered session %q, want S2", cmd.session)
	}
	if !e.answerDialog(first, false, "") {
		t.Fatal("the FIRST target's dialog is still open and must remain answerable")
	}
	if cmd := <-e.cmds; cmd.session != "S1" {
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
	e.cmds = make(chan cdpCmd) // unbuffered, nothing reading: enqueue times out
	seq := e.noteDialogOpen("S1", false)

	if e.answerDialog(seq, true, "") {
		t.Fatal("answerDialog must report failure when the command was not queued")
	}

	// Now drain, as a live CDP connection would, and retry.
	done := make(chan cdpCmd, 1)
	go func() { done <- <-e.cmds }()
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
