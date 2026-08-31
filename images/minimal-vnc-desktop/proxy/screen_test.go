package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// The screen keeper decides when to hand the X screen back to its advertised
// size. Both directions matter: never restoring means a phone session's 360x688
// is inherited by every later viewer, and restoring too eagerly resizes the
// framebuffer out from under a viewer that was merely reloading.

func recorder() (func(), func() int) {
	var mu sync.Mutex
	n := 0
	return func() { mu.Lock(); n++; mu.Unlock() },
		func() int { mu.Lock(); defer mu.Unlock(); return n }
}

func TestRestoresAfterLastViewerLeaves(t *testing.T) {
	restore, count := recorder()
	k := newScreenKeeper(30*time.Millisecond, restore)
	k.connect(false)
	k.disconnect()
	if count() != 0 {
		t.Fatal("restored synchronously; the delay exists to absorb a reload")
	}
	time.Sleep(120 * time.Millisecond)
	if count() != 1 {
		t.Fatalf("restore ran %d times, want 1", count())
	}
}

func TestReloadWithinDelayDoesNotRestore(t *testing.T) {
	// A viewer reload is disconnect-then-reconnect within a few hundred ms.
	// Resizing in that gap costs two framebuffer reallocs and the returning
	// viewer just resizes it back.
	restore, count := recorder()
	k := newScreenKeeper(80*time.Millisecond, restore)
	k.connect(false)
	k.disconnect()
	time.Sleep(20 * time.Millisecond)
	k.connect(false) // reload landed
	time.Sleep(150 * time.Millisecond)
	if count() != 0 {
		t.Fatalf("restore ran %d times during a reload, want 0", count())
	}
}

func TestSecondViewerKeepsGeometry(t *testing.T) {
	// Two viewers share one screen. One leaving must not re-shape it under the
	// other — whoever is still watching keeps the geometry they asked for.
	restore, count := recorder()
	k := newScreenKeeper(30*time.Millisecond, restore)
	k.connect(false)
	k.connect(false)
	k.disconnect()
	time.Sleep(120 * time.Millisecond)
	if count() != 0 {
		t.Fatalf("restore ran %d times with a viewer still connected, want 0", count())
	}
	if k.clientCount() != 1 {
		t.Fatalf("clientCount=%d, want 1", k.clientCount())
	}
	k.disconnect()
	time.Sleep(120 * time.Millisecond)
	if count() != 1 {
		t.Fatalf("restore ran %d times after the last left, want 1", count())
	}
}

func TestRestoreRunsOncePerIdlePeriod(t *testing.T) {
	// Churn must not queue up restores — each one is a framebuffer realloc.
	restore, count := recorder()
	k := newScreenKeeper(40*time.Millisecond, restore)
	for i := 0; i < 5; i++ {
		k.connect(false)
		k.disconnect()
	}
	time.Sleep(200 * time.Millisecond)
	if count() != 1 {
		t.Fatalf("restore ran %d times after churn, want 1", count())
	}
}

func TestUnbalancedDisconnectDoesNotUnderflow(t *testing.T) {
	// A handler can only ever disconnect what it connected, but a negative count
	// would wedge the keeper permanently (clients > 0 forever), so clamp.
	restore, count := recorder()
	k := newScreenKeeper(20*time.Millisecond, restore)
	k.disconnect()
	k.disconnect()
	if k.clientCount() != 0 {
		t.Fatalf("clientCount=%d, want 0", k.clientCount())
	}
	time.Sleep(90 * time.Millisecond)
	k.connect(false)
	k.disconnect()
	time.Sleep(90 * time.Millisecond)
	if count() == 0 {
		t.Fatal("keeper wedged: a real session's departure never restored")
	}
}

func TestNilKeeperIsSafe(t *testing.T) {
	// serveWebsocket calls these unconditionally; a nil keeper must not panic.
	var k *screenKeeper
	k.connect(false)
	k.disconnect()
}

func TestFirstConnectRunsResetOncePerSession(t *testing.T) {
	// The delayed restore protects nobody who connects INSIDE the delay: connect
	// cancels the timer, so a plain viewer arriving right after a magnify session
	// would inherit its screen. The first client of each session gets the reset
	// hook instead — and only the first, since a second viewer joining must not
	// re-shape the screen under the one already watching.
	restore, _ := recorder()
	reset, resets := recorder()
	k := newScreenKeeper(30*time.Millisecond, restore)
	k.resetOnFirst = reset
	k.connect(false)
	if resets() != 1 {
		t.Fatalf("reset ran %d times on the first connect, want 1", resets())
	}
	k.connect(false) // second viewer joins the live session
	if resets() != 1 {
		t.Fatalf("reset ran %d times after a second viewer joined, want still 1", resets())
	}
	k.disconnect()
	k.disconnect()
	k.connect(false) // next session, within or after the delay — either way it resets
	if resets() != 2 {
		t.Fatalf("reset ran %d times across two sessions, want 2", resets())
	}
}

func TestReloadInsideDelayStillResets(t *testing.T) {
	// A reload that lands inside the restore delay cancels the timer (no restore
	// churn) but still passes through the first-connect reset — which is a no-op
	// on a clean screen and a correction on a dirty one. Both are cheaper than a
	// viewer session spent on the wrong geometry.
	restore, restores := recorder()
	reset, resets := recorder()
	k := newScreenKeeper(80*time.Millisecond, restore)
	k.resetOnFirst = reset
	k.connect(false)
	k.disconnect()
	time.Sleep(20 * time.Millisecond)
	k.connect(false) // reload landed inside the delay
	time.Sleep(150 * time.Millisecond)
	if restores() != 0 {
		t.Fatalf("restore ran %d times during a reload, want 0", restores())
	}
	if resets() != 2 {
		t.Fatalf("reset ran %d times, want 2 (one per first-connect)", resets())
	}
}

func TestKeepGeometryConnectSkipsReset(t *testing.T) {
	// A magnify viewer (?keep=1) manages its own geometry: resetting on its
	// soft reconnect would bounce the remote page through a desktop-width
	// relayout, which reload-on-resize sites answer with a state-losing reload.
	restore, _ := recorder()
	reset, resets := recorder()
	k := newScreenKeeper(30*time.Millisecond, restore)
	k.resetOnFirst = reset
	k.connect(true) // magnify reconnect
	if resets() != 0 {
		t.Fatalf("reset ran %d times for a keep-geometry viewer, want 0", resets())
	}
	k.disconnect()
	k.connect(false) // a plain viewer still gets the reset
	if resets() != 1 {
		t.Fatalf("reset ran %d times for the plain viewer, want 1", resets())
	}
}

func TestLateRestoreYieldsToConnectingViewer(t *testing.T) {
	// TOCTOU on the restore timer: the callback decides the screen is idle,
	// then a viewer connects before the restore's xrandr lands. The generation
	// re-check must abandon the restore — snapping the screen and emulation
	// under a live session is sticky (nothing re-pushes /emulate on its own).
	// finishRestore is the timer's second phase, called here directly with the
	// generation the timer would have sampled at its idle check.
	restore, restores := recorder()
	k := newScreenKeeper(time.Hour /* the real timer must not fire */, restore)
	k.connect(false)
	k.disconnect()
	k.mu.Lock()
	gen := k.gen // what the descheduled timer callback sampled
	k.mu.Unlock()
	k.connect(false) // viewer slips in before the restore lands
	k.finishRestore(gen)
	if restores() != 0 {
		t.Fatalf("restore ran %d times under a live viewer, want 0", restores())
	}
	k.disconnect()
	k.mu.Lock()
	gen = k.gen
	k.mu.Unlock()
	k.finishRestore(gen) // genuinely idle this time
	if restores() != 1 {
		t.Fatalf("restore ran %d times on the idle screen, want 1", restores())
	}
}

// The geometry endpoint carries the live viewer count so a second harness run can
// find out the container is already driving a session — one X screen serves every
// viewer, so two runs flap it between their device geometries and corrupt each
// other's evidence (and have aborted Xvnc).
func TestGeometryHandlerReportsAttachedViewers(t *testing.T) {
	keeper := newScreenKeeper(time.Millisecond, func() {})

	rec := httptest.NewRecorder()
	geometryHTTPHandler(func() int { return keeper.clientCount() })(rec, httptest.NewRequest(http.MethodGet, "/geometry", nil))
	if !strings.Contains(rec.Body.String(), `"viewers":0`) {
		t.Fatalf("idle container should report no viewers, got %s", rec.Body.String())
	}

	keeper.connect(true)
	defer keeper.disconnect()
	rec = httptest.NewRecorder()
	geometryHTTPHandler(func() int { return keeper.clientCount() })(rec, httptest.NewRequest(http.MethodGet, "/geometry", nil))
	if !strings.Contains(rec.Body.String(), `"viewers":1`) {
		t.Fatalf("attached viewer should be reported, got %s", rec.Body.String())
	}
}

func TestGeometryHandlerWithoutKeeper(t *testing.T) {
	rec := httptest.NewRecorder()
	geometryHTTPHandler(nil)(rec, httptest.NewRequest(http.MethodGet, "/geometry", nil))
	if !strings.Contains(rec.Body.String(), `"viewers":0`) {
		t.Fatalf("a handler with no keeper must still answer, got %s", rec.Body.String())
	}
}

func TestGeometryHandlerIsReadOnly(t *testing.T) {
	rec := httptest.NewRecorder()
	geometryHTTPHandler(nil)(rec, httptest.NewRequest(http.MethodPost, "/geometry", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST status = %d, want %d", rec.Code, http.StatusMethodNotAllowed)
	}
}
