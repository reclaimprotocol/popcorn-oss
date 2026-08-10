package main

import "testing"

// The close affordance is the user's only exit from a sign-in window that has
// taken over the screen (see the secondary-window block in emulate.go). These pin
// the two rules that make it safe: it is derived from the page COUNT rather than
// from openerId, and its sequence number stops a stale tap destroying the wrong
// window.
//
// Counting matters because the flow this exists for — Pinterest's "Continue with
// Google" — is FedCM (accounts.google.com/gsi/fedcm/signin), whose target is
// reported with openerId EMPTY. An opener-based test passes against a synthetic
// window.open and misses the real thing.

func TestSinglePageOffersNothingToClose(t *testing.T) {
	e := &emulator{}
	_, open, changed := e.notePage("PRIMARY")
	if open {
		t.Fatal("the only page must never be offered for closing — that is the session")
	}
	if changed {
		t.Fatal("nothing to publish for the first page")
	}
}

func TestSecondPageBecomesClosable(t *testing.T) {
	e := &emulator{}
	e.notePage("PRIMARY")
	seq, open, changed := e.notePage("SIGNIN")
	if !open || !changed || seq == 0 {
		t.Fatalf("second page should publish a closable state: seq=%d open=%v changed=%v", seq, open, changed)
	}
}

// The regression this suite exists for: a FedCM window carries no opener.
func TestPageWithNoOpenerIsStillClosable(t *testing.T) {
	e := &emulator{cmds: make(chan cdpCmd, 4)}
	e.notePage("PRIMARY")
	seq, open, _ := e.notePage("FEDCM-NO-OPENER")
	if !open {
		t.Fatal("a page with no openerId must still be closable (FedCM sign-in)")
	}
	if !e.closePopup(seq) {
		t.Fatal("close rejected")
	}
	if cmd := <-e.cmds; cmd.params["targetId"] != "FEDCM-NO-OPENER" {
		t.Fatalf("closed %v, want the FedCM window", cmd.params["targetId"])
	}
}

func TestDuplicateTargetCreatedDoesNotBumpSequence(t *testing.T) {
	e := &emulator{}
	e.notePage("PRIMARY")
	seq, _, _ := e.notePage("SIGNIN")
	if _, _, changed := e.notePage("SIGNIN"); changed {
		t.Fatal("a repeated targetCreated must not republish")
	}
	if e.popSeq != seq {
		t.Fatalf("sequence moved on a duplicate: %d -> %d", seq, e.popSeq)
	}
}

func TestClosePopupRejectsStaleSequence(t *testing.T) {
	e := &emulator{cmds: make(chan cdpCmd, 4)}
	e.notePage("PRIMARY")
	seq, _, _ := e.notePage("SIGNIN")

	if e.closePopup(seq + 1) {
		t.Fatal("a stale sequence must not close the current window")
	}
	if len(e.cmds) != 0 {
		t.Fatal("stale request still queued a CDP command")
	}
	if !e.closePopup(seq) {
		t.Fatal("the current sequence should close")
	}
	cmd := <-e.cmds
	if cmd.method != "Target.closeTarget" {
		t.Fatalf("method = %q, want Target.closeTarget", cmd.method)
	}
	if cmd.params["targetId"] != "SIGNIN" {
		t.Fatalf("targetId = %v, want SIGNIN", cmd.params["targetId"])
	}
	// Browser-level: a FedCM window and an unattached OAuth popup are reachable
	// only by targetId, so there is no session to send this on.
	if cmd.session != "" {
		t.Fatalf("session = %q, want browser-level", cmd.session)
	}
}

func TestCloseIsRejectedWithOnlyThePrimaryPage(t *testing.T) {
	e := &emulator{cmds: make(chan cdpCmd, 4)}
	e.notePage("PRIMARY")
	for _, seq := range []uint64{0, 1, 2} {
		if e.closePopup(seq) {
			t.Fatalf("seq %d closed the primary page — that would kill the session", seq)
		}
	}
	if len(e.cmds) != 0 {
		t.Fatal("a CDP command was queued against the primary page")
	}
}

func TestClosingTheSignInWindowClearsTheButton(t *testing.T) {
	e := &emulator{}
	e.notePage("PRIMARY")
	e.notePage("SIGNIN")
	seq, open, changed := e.forgetPage("SIGNIN")
	if !changed {
		t.Fatal("losing the second page is a change")
	}
	if open || seq != 0 {
		t.Fatalf("only the primary is left; the button must go: seq=%d open=%v", seq, open)
	}
}

func TestNestedWindowRevealsTheOneUnderneath(t *testing.T) {
	e := &emulator{cmds: make(chan cdpCmd, 4)}
	e.notePage("PRIMARY")
	outerSeq, _, _ := e.notePage("OUTER")
	innerSeq, _, _ := e.notePage("INNER")

	seq, open, changed := e.forgetPage("INNER")
	if !changed || !open {
		t.Fatalf("OUTER should still be closable: changed=%v open=%v", changed, open)
	}
	if seq == innerSeq || seq == outerSeq {
		t.Fatalf("sequence must advance past both, got %d (inner=%d outer=%d)", seq, innerSeq, outerSeq)
	}
	if e.closePopup(innerSeq) {
		t.Fatal("in-flight tap for the closed window must not close the survivor")
	}
	if !e.closePopup(seq) {
		t.Fatal("the republished sequence should close the survivor")
	}
	if cmd := <-e.cmds; cmd.params["targetId"] != "OUTER" {
		t.Fatalf("closed %v, want OUTER", cmd.params["targetId"])
	}
}

func TestUnrelatedTargetDestroyedDoesNotFlickerTheButton(t *testing.T) {
	// targetDestroyed fires for iframes, workers and every other target type.
	// Republishing on those would flicker the button off mid sign-in.
	e := &emulator{}
	e.notePage("PRIMARY")
	e.notePage("SIGNIN")
	_, open, changed := e.forgetPage("SOME-IFRAME")
	if changed {
		t.Fatal("an untracked target must not republish")
	}
	if !open {
		t.Fatal("the sign-in window is still open")
	}
}

func TestPrimaryClosingLeavesNothingClosable(t *testing.T) {
	// If the ORIGINAL page goes away, the sign-in window is all that is left and
	// becomes the session — there is nothing to fall back to, so no close button.
	e := &emulator{cmds: make(chan cdpCmd, 4)}
	e.notePage("PRIMARY")
	seq, _, _ := e.notePage("SIGNIN")
	_, open, changed := e.forgetPage("PRIMARY")
	if !changed || open {
		t.Fatalf("one page left means nothing to close: changed=%v open=%v", changed, open)
	}
	if e.closePopup(seq) {
		t.Fatal("must not close the last remaining page")
	}
}

func TestPopupPayloadShape(t *testing.T) {
	b, err := popupPayload(12, true)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"popup":{"open":true,"seq":12}}`
	if string(b) != want {
		t.Fatalf("payload = %s, want %s", b, want)
	}
}
