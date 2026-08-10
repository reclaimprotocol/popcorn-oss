package main

import (
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
	k.connect()
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
	k.connect()
	k.disconnect()
	time.Sleep(20 * time.Millisecond)
	k.connect() // reload landed
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
	k.connect()
	k.connect()
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
		k.connect()
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
	k.connect()
	k.disconnect()
	time.Sleep(90 * time.Millisecond)
	if count() == 0 {
		t.Fatal("keeper wedged: a real session's departure never restored")
	}
}

func TestNilKeeperIsSafe(t *testing.T) {
	// serveWebsocket calls these unconditionally; a nil keeper must not panic.
	var k *screenKeeper
	k.connect()
	k.disconnect()
}
