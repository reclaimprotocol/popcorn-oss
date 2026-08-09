package main

// Restore the X screen to the advertised desktop size once no viewer is left.
//
// The screen size is CLIENT-driven and there is only one screen. A magnify/fit
// viewer MUST resize it (RFB SetDesktopSize) to lay the remote page out at the
// phone's width — that is how fit-to-width works, not a bug. What is a bug is
// that nothing ever puts it back, so the size the last viewer asked for becomes
// the size every LATER session inherits: connect a phone once and a desktop
// viewer joining afterwards gets a 360x688 screen with the page cropped to the
// top-left corner. Observed exactly that on a container which had booted
// 1920x1080 and was serving 360x688 later the same session.
//
// entrypoint.sh only sets the size at boot, which cannot help here — by the time
// a phone has connected, boot is long past. So track VNC clients and, when the
// last one goes, put the screen back and re-assert the default emulation; the
// restore path also re-fits the kiosk window at the X level (setScreenSize →
// checkAndFitWindows in window.go).
//
// Every session then starts from the same baseline instead of inheriting the
// previous one's geometry.

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
	// geoMu serializes every geometry mutation (idle restore, first-connect
	// reset) and gates every NEW session's handshake behind one that is in
	// flight: without it, viewer B's RFB handshake races viewer A's reset, and
	// B's SetDesktopSize/emulation can land first only to be clobbered by A's
	// xrandr + em.set a few exec-latencies later (worse under Rosetta, where an
	// exec takes 100ms+).
	geoMu   sync.Mutex
	restore func()
	// resetOnFirst runs synchronously when clients go 0 -> 1, BEFORE the new
	// session's RFB handshake proxies. The delayed restore alone cannot protect a
	// viewer that connects inside the delay window: connect() cancels the pending
	// timer, so a plain viewer arriving 1s after a magnify session left would
	// inherit the phone-shaped screen forever (its resize=scale mode never
	// resizes). Resetting before the handshake also means the client reads the
	// TRUE boot framebuffer at connect — viewer.js learns its fbcap from exactly
	// that. See resetScreenOnFirstConnect.
	//
	// KNOWN LIMITATION: only the 0 -> 1 transition resets. A viewer that died
	// without a close frame (backgrounded phone, radio loss) holds its client
	// slot until the websocket read deadline reaps it (~75s, main.go), and a
	// changeover viewer connecting inside that window is 1 -> 2: no reset, and it
	// inherits the zombie's geometry until it resizes itself or reloads. Fixing
	// that needs client liveness, not connection counting.
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

// connect notes a new VNC client and cancels any pending restore — the screen is
// in use again, and resizing it under a live viewer is exactly the thrash this
// delay exists to avoid. The FIRST client of a session instead gets the reset
// hook: cancelling the restore is only correct when someone else already owns
// the geometry; when nobody does, the newcomer must start from boot geometry.
//
// keepGeometry skips the reset for a viewer that manages its own geometry (the
// magnify viewer sends ?keep=1 on its websocket): it resizes the screen itself
// right after the handshake anyway, and resetting first would bounce the remote
// page through a desktop-width relayout on every soft reconnect — which
// reload-on-resize sites answer with a page reload, losing session state.
//
// Every connect passes through geoMu, taken or not: a session must not start
// its handshake while a restore or another session's reset is mid-flight, or
// its own SetDesktopSize can land first and be clobbered a few exec-latencies
// later.
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

// finishRestore completes a restore decision the timer made on a screen it
// found idle at generation gen. Split from the timer closure so the TOCTOU
// guard is testable: a viewer whose connect slips in between the timer's idle
// check and the restore's xrandr must win — its session is live, and restoring
// now would snap the screen and emulation out from under it, stickily (nothing
// re-pushes /emulate on its own). The re-check runs under geoMu, so a connect
// that arrives after it blocks until the restore finishes and its handshake
// still starts on settled geometry.
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

// setScreenSize resizes the X screen to w x h, re-asserts the default emulation
// so the page layout follows, and re-fits the kiosk window immediately (window.go)
// rather than waiting a watcher tick — the window must cover the new screen
// before the next handshake paints it.
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
	// Re-fit the kiosk window immediately — it must cover the new screen before
	// the next handshake paints it — then again shortly after, since Chromium may
	// still be re-laying out from the resize.
	if _, err := checkAndFitWindows(logf, nil); err != nil {
		logf("window re-fit after screen resize: %v", err)
	}
	requestWindowFit(logf)
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

// resetScreenOnFirstConnect is the screenKeeper.resetOnFirst hook: when the
// first viewer of a session connects onto a screen an earlier session resized
// (whose restore this very connect just cancelled, or which never fired), put
// the screen back to boot geometry before the handshake proceeds. A no-op when
// the screen is already at boot size, so plain reloads cost nothing; a magnify
// reload pays one extra resize and then re-fits itself as it always does. Fails
// open when the geometry cannot be read (dev host without xdotool / X down).
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
