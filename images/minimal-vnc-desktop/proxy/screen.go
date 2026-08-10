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
// last one goes, put the screen back and re-assert the default emulation. That
// re-assert also re-fits the kiosk window (see refitWindow in emulate.go), which
// matters because the window follows the screen DOWN and would otherwise stay
// phone-sized over a restored desktop screen.
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
	delay   time.Duration
	restore func()
	timer   *time.Timer
	logf    func(string, ...any)
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
// delay exists to avoid.
func (k *screenKeeper) connect() {
	if k == nil {
		return
	}
	k.mu.Lock()
	defer k.mu.Unlock()
	k.clients++
	n := k.clients
	if k.timer != nil {
		k.timer.Stop()
		k.timer = nil
	}
	k.note("vnc client connected (now %d)", n)
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
		k.timer = nil
		k.mu.Unlock()
		if idle && k.restore != nil {
			k.restore()
		}
	})
}

// clientCount is for tests.
func (k *screenKeeper) clientCount() int {
	k.mu.Lock()
	defer k.mu.Unlock()
	return k.clients
}

// restoreScreenFunc resizes the X screen back to w x h and re-asserts the default
// emulation so the page layout and the kiosk window follow it.
func restoreScreenFunc(w, h int, em *emulator, logf func(string, ...any)) func() {
	return func() {
		size := fmt.Sprintf("%dx%d", w, h)
		cmd := exec.Command("xrandr", "-s", size)
		// The proxy inherits DISPLAY from entrypoint.sh, but set it explicitly so a
		// standalone/dev invocation behaves the same.
		cmd.Env = append(os.Environ(), "DISPLAY="+envDefault("DISPLAY", ":1"))
		if out, err := cmd.CombinedOutput(); err != nil {
			logf("screen restore to %s failed: %v (%s)", size, err, string(out))
			return
		}
		logf("no viewers left — screen restored to %s", size)
		if em != nil {
			em.set(*defaultEmulation())
		}
	}
}
