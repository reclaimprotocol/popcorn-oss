package main

import "testing"

// A gesture's terminal event (touchEnd/Cancel, mouse release) must survive a flood
// of moves. If it doesn't, the remote page keeps a finger pressed forever and every
// later gesture is read as a multi-touch continuation of it — the stream still
// moves, so the session looks alive while nothing responds to touch.

func newInputEmulator(moveCap, prioCap int) *emulator {
	e := &emulator{cmds: make(chan cdpCmd, moveCap), prio: make(chan cdpCmd, prioCap)}
	e.setActive("S1")
	return e
}

func TestTouchEndSurvivesAMoveFlood(t *testing.T) {
	e := newInputEmulator(4, 8) // tiny move queue, nothing draining it
	for i := 0; i < 50; i++ {
		e.dispatchTouch("touchMove", []touchPoint{{X: float64(i), Y: 10}})
	}
	if len(e.cmds) != 4 {
		t.Fatalf("move queue = %d, want it saturated at 4", len(e.cmds))
	}

	e.dispatchTouch("touchEnd", nil)
	if len(e.prio) != 1 {
		t.Fatalf("terminal events queued = %d, want 1 (the reserved queue is separate)", len(e.prio))
	}
	if cmd := <-e.prio; cmd.params["type"] != "touchEnd" {
		t.Fatalf("reserved queue carried %v, want touchEnd", cmd.params["type"])
	}
}

// If a terminal event IS lost (a wedged CDP consumer, not a full move queue), the
// remote is left holding a finger — so the next gesture has to cancel it first.
func TestLostTerminalEventCancelsTheNextGesture(t *testing.T) {
	e := newInputEmulator(4, 0) // unbuffered reserved queue, nothing reading
	e.dispatchTouch("touchEnd", nil)
	if !e.inputDesync.Load() {
		t.Fatal("a dropped touchEnd must mark the input desynced")
	}

	// Drain like a live connection would, then start a new gesture.
	got := make(chan cdpCmd, 2)
	done := make(chan struct{})
	go func() {
		for i := 0; i < 2; i++ {
			got <- <-e.prio
		}
		close(done)
	}()
	e.dispatchTouch("touchStart", []touchPoint{{X: 5, Y: 5}})
	<-done
	if cmd := <-got; cmd.params["type"] != "touchCancel" {
		t.Fatalf("first command = %v, want the touchCancel that clears the stuck finger", cmd.params["type"])
	}
	if cmd := <-got; cmd.params["type"] != "touchStart" {
		t.Fatalf("second command = %v, want touchStart", cmd.params["type"])
	}
	if e.inputDesync.Load() {
		t.Fatal("the desync flag must clear once the cancel is queued")
	}
}

func TestMovesAreDroppedNotQueuedOnThePriorityChannel(t *testing.T) {
	e := newInputEmulator(1, 1)
	e.dispatchTouch("touchMove", []touchPoint{{X: 1, Y: 1}})
	e.dispatchTouch("touchMove", []touchPoint{{X: 2, Y: 2}})
	if len(e.prio) != 0 {
		t.Fatalf("moves reached the reserved queue (%d) — that is the capacity terminal events need", len(e.prio))
	}
}
