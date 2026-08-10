package main

// Give every session the same screen geometry to start from.
//
// The screen is client-driven and there is only one of it: a magnify/fit viewer
// must resize it to lay the remote page out at the phone's width. Nothing put
// it back, so whatever the last viewer asked for became what every later
// session inherited — a desktop viewer joining after a phone got a 360x688
// screen with the page cropped into the corner. So track VNC clients and reset
// the screen at both ends of a session: when the last viewer leaves, and again
// for the first viewer of the next one (the delay below means the first is not
// enough on its own).

import (
	"fmt"
	"os"
	"os/exec"
	"sync"
	"time"
)

// A viewer reload disconnects and reconnects within a few hundred ms. Restoring
// in that gap would resize the screen twice for nothing — a full framebuffer
// realloc and encoder flush each way — and the returning viewer would then resize
// it straight back. Wait long enough that a reload is not mistaken for a
// departure, short enough that the next real session finds a clean screen.
const screenRestoreDelay = 3 * time.Second

type screenKeeper struct {
	mu      sync.Mutex
	clients int
	// gen counts connects. The restore timer samples it when it decides the
	// screen is idle and re-checks before touching the screen, so a viewer that
	// connects in the gap between the timer's idle check and its xrandr cannot
	// have the screen restored out from under its session.
	gen   uint64
	delay time.Duration
	// geoMu serializes geometry mutations and holds a new session's handshake
	// behind one in flight. Without it viewer B's SetDesktopSize can land during
	// viewer A's reset and be clobbered by A's xrandr an exec-latency later.
	geoMu   sync.Mutex
	restore func()
	// resetOnFirst runs when clients go 0 -> 1, before the new session's RFB
	// handshake proxies, so the client also reads the true boot framebuffer at
	// connect (viewer.js learns its fbcap from it). The delayed restore cannot
	// cover this case: connect() cancels the pending timer, so a plain viewer
	// arriving 1s after a magnify session would keep the phone-shaped screen for
	// good, never resizing it itself.
	//
	// KNOWN LIMITATION: only the 0 -> 1 transition resets. A viewer that died
	// without a close frame holds its slot until the websocket read deadline
	// reaps it (~75s, main.go), so a changeover inside that window is 1 -> 2 and
	// inherits the zombie's geometry. Fixing it needs client liveness, not
	// connection counting.
	resetOnFirst func()
	timer        *time.Timer
	logf         func(string, ...any)
}

func newScreenKeeper(delay time.Duration, restore func()) *screenKeeper {
	return &screenKeeper{delay: delay, restore: restore}
}

func (k *screenKeeper) note(format string, args ...any) {
	if k != nil && k.logf != nil {
		k.logf(format, args...)
	}
}

// connect notes a new VNC client and cancels any pending restore — resizing the
// screen under a live viewer is the thrash the delay exists to avoid. The first
// client of a session gets the reset instead: cancelling is only right when
// someone else already owns the geometry.
//
// keepGeometry skips the reset for a viewer that owns its own geometry (magnify
// sends ?keep=1): it resizes the screen itself after the handshake, and
// resetting first would bounce the remote page through a desktop-width relayout
// on every soft reconnect — a state-losing page reload on reload-on-resize
// sites.
//
// Every connect passes through geoMu, reset or not, so a handshake never starts
// while another session's geometry change is in flight.
func (k *screenKeeper) connect(keepGeometry bool) {
	if k == nil {
		return
	}
	k.mu.Lock()
	k.clients++
	k.gen++
	n := k.clients
	if k.timer != nil {
		k.timer.Stop()
		k.timer = nil
	}
	reset := k.resetOnFirst
	k.mu.Unlock()
	k.note("vnc client connected (now %d)", n)
	k.geoMu.Lock()
	if n == 1 && !keepGeometry && reset != nil {
		reset()
	}
	k.geoMu.Unlock()
}

// disconnect notes a client leaving and schedules the restore if it was the last.
func (k *screenKeeper) disconnect() {
	if k == nil {
		return
	}
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.clients > 0 {
		k.clients--
	}
	n := k.clients
	k.note("vnc client gone (now %d)", n)
	if k.clients > 0 {
		return // others still watching; their geometry stands
	}
	if k.timer != nil {
		k.timer.Stop()
	}
	k.timer = time.AfterFunc(k.delay, func() {
		// Re-check under the lock: a viewer may have reconnected while the timer
		// was in flight, and connect() racing with the fire is not enough on its
		// own to stop it.
		k.mu.Lock()
		idle := k.clients == 0
		gen := k.gen
		k.timer = nil
		k.mu.Unlock()
		if !idle || k.restore == nil {
			return
		}
		k.finishRestore(gen)
	})
}

// finishRestore completes a restore the timer decided on at generation gen. A
// viewer whose connect slips in between that decision and the xrandr must win:
// its session is live, and snapping the screen and emulation under it is sticky
// (nothing re-pushes /emulate on its own). Split out from the timer closure so
// the guard is testable.
func (k *screenKeeper) finishRestore(gen uint64) {
	k.geoMu.Lock()
	defer k.geoMu.Unlock()
	k.mu.Lock()
	idle := k.clients == 0 && k.gen == gen
	k.mu.Unlock()
	if idle {
		k.restore()
	}
}

// clientCount is for tests.
func (k *screenKeeper) clientCount() int {
	k.mu.Lock()
	defer k.mu.Unlock()
	return k.clients
}

// setScreenSize resizes the X screen, re-asserts the default emulation so the
// page layout follows, and re-fits the kiosk window at once rather than waiting
// a watcher tick — the window must cover the new screen before the next
// handshake paints it.
func setScreenSize(w, h int, em *emulator, logf func(string, ...any)) error {
	size := fmt.Sprintf("%dx%d", w, h)
	cmd := exec.Command("xrandr", "-s", size)
	// The proxy inherits DISPLAY from entrypoint.sh, but set it explicitly so a
	// standalone/dev invocation behaves the same.
	cmd.Env = append(os.Environ(), "DISPLAY="+envDefault("DISPLAY", ":1"))
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("xrandr -s %s: %v (%s)", size, err, string(out))
	}
	if em != nil {
		em.set(*defaultEmulation())
	}
	if _, err := checkAndFitWindows(logf, nil); err != nil {
		logf("window re-fit after screen resize: %v", err)
	}
	requestWindowFit(logf) // again shortly: Chromium may still be re-laying out
	return nil
}

// restoreScreenFunc resizes the X screen back to w x h and re-asserts the default
// emulation so the page layout and the kiosk window follow it.
func restoreScreenFunc(w, h int, em *emulator, logf func(string, ...any)) func() {
	return func() {
		if err := setScreenSize(w, h, em, logf); err != nil {
			logf("screen restore failed: %v", err)
			return
		}
		logf("no viewers left — screen restored to %dx%d", w, h)
	}
}

// resetScreenOnFirstConnect is the screenKeeper.resetOnFirst hook: put the
// screen back to boot geometry before the first viewer's handshake proceeds,
// covering the session an earlier restore never got to (this connect may have
// just cancelled it). A no-op when the screen is already at boot size, so
// reloads cost nothing. Fails open when the geometry cannot be read.
func resetScreenOnFirstConnect(w, h int, em *emulator, logf func(string, ...any)) func() {
	return func() {
		cw, ch, err := displayGeometry()
		if err != nil || (cw == w && ch == h) {
			return
		}
		if err := setScreenSize(w, h, em, logf); err != nil {
			logf("first-connect screen reset failed: %v", err)
			return
		}
		logf("first viewer connected onto a %dx%d screen — reset to boot %dx%d", cw, ch, w, h)
	}
}
