package main

// Keep every Chromium toplevel sized to the X screen ("window-follows-screen").
//
// The X screen is CLIENT-driven: a magnify/fit viewer grows it (RFB
// SetDesktopSize) to lay the page out taller than the boot geometry, and
// screen.go restores it when viewers change over. The --kiosk Chromium window,
// however, is sized once at launch (start-chromium --window-size) and nothing
// else re-fits it when the screen changes: openbox is running but does not
// re-fit fullscreen windows on a RandR change, and the CDP path
// (Browser.setWindowBounds) can only resize a window in state "normal", which
// draws the tab strip into the stream (entrypoint.sh: 796px of chrome). Any
// screen rows/cols the window does not cover are painted as the bare X root —
// the black band under every tall fit.
//
// MEASURED (2026-08-09, live container): a raw X-level resize does what the CDP
// path cannot. `xdotool windowsize` grew the kiosk window 1919x1079 -> 1072x2052
// in place; Chromium re-laid the page out to fill it, no tab strip or omnibox
// appeared, openbox did not fight it, and emulate.go's 2s CDP fullscreen
// watchdog left the size alone.
//
// The design is EVENT-DRIVEN, not a fast poll, and each check is ONE chained
// xdotool invocation. Both choices are load-bearing: on a Rosetta-translated
// dev container (Docker Desktop on Apple silicon) every process spawned
// anywhere in the container leaks one /proc/<pid>/auxv fd into every
// translated process's fd table — measured ~6 fds/s in Xvnc under a 400ms
// three-exec poll, which walked Xvnc into FD_SETSIZE (1024) and a fortify
// abort (__fdelt_chk) in under five minutes. Real Linux hosts do not leak, but
// every developer here is on Apple silicon. So: requestWindowFit() runs after
// the known screen-change events (viewer /emulate pushes, first-connect reset,
// idle restore, popup fullscreening), and a slow backstop poll catches what
// events cannot (a raw RFB client resizing the screen directly) — 10s on real
// Linux, 120s under Rosetta where each spawn spends fd budget.

import (
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

// windowSizeMax mirrors the emulate.go setDeviceMetricsOverride clamp and the
// viewer's FB_MAX: never chase a screen beyond what the render path allows —
// a raw RFB client could ask Xvnc for an absurd screen, and a 30k-pixel-wide
// Chromium window is a self-inflicted denial of service.
const windowSizeMax = 4096

// xdo runs one xdotool invocation (possibly a chained command) against the
// container display.
func xdo(args ...string) (string, error) {
	cmd := exec.Command("xdotool", args...)
	cmd.Env = append(os.Environ(), "DISPLAY="+envDefault("DISPLAY", ":1"))
	out, err := cmd.Output()
	return strings.TrimSpace(string(out)), err
}

// displayGeometry reports the current X screen size ("1920 1080").
func displayGeometry() (int, int, error) {
	out, err := xdo("getdisplaygeometry")
	if err != nil {
		return 0, 0, fmt.Errorf("xdotool getdisplaygeometry: %w", err)
	}
	w, h, ok := parsePair(out)
	if !ok {
		return 0, 0, fmt.Errorf("xdotool getdisplaygeometry: unparseable %q", out)
	}
	return w, h, nil
}

// parsePair parses "W H" (xdotool getdisplaygeometry output).
func parsePair(s string) (int, int, bool) {
	fields := strings.Fields(s)
	if len(fields) != 2 {
		return 0, 0, false
	}
	w, err1 := strconv.Atoi(fields[0])
	h, err2 := strconv.Atoi(fields[1])
	if err1 != nil || err2 != nil || w <= 0 || h <= 0 {
		return 0, 0, false
	}
	return w, h, true
}

type windowGeom struct {
	id   string // decimal window id, as xdotool prints and accepts it
	w, h int
}

// parseChainedGeometry parses the output of the single chained query
//
//	xdotool getdisplaygeometry search ... getwindowgeometry --shell %@
//
// which is one "W H" line followed by KEY=value blocks per window (WINDOW=,
// X=, Y=, WIDTH=, HEIGHT=, SCREEN=). A container with no browser window yet
// parses fine as zero windows.
func parseChainedGeometry(s string) (sw, sh int, wins []windowGeom, ok bool) {
	lines := strings.Fields(s)
	if len(lines) < 2 {
		return 0, 0, nil, false
	}
	sw, _ = strconv.Atoi(lines[0])
	sh, _ = strconv.Atoi(lines[1])
	if sw <= 0 || sh <= 0 {
		return 0, 0, nil, false
	}
	var cur *windowGeom
	for _, tok := range lines[2:] {
		if v, found := strings.CutPrefix(tok, "WINDOW="); found {
			wins = append(wins, windowGeom{id: v})
			cur = &wins[len(wins)-1]
		} else if v, found := strings.CutPrefix(tok, "WIDTH="); found && cur != nil {
			cur.w, _ = strconv.Atoi(v)
		} else if v, found := strings.CutPrefix(tok, "HEIGHT="); found && cur != nil {
			cur.h, _ = strconv.Atoi(v)
		}
	}
	return sw, sh, wins, true
}

// checkAndFitWindows compares every visible Chromium toplevel against the X
// screen in ONE xdotool invocation and resizes the ones that disagree (each
// resize is its own invocation, but a mismatch is a rare event, not a steady
// state). Idempotent and safe to call from anywhere; returns how many windows
// it saw so the watcher's boot phase knows when the browser is up. alreadyFit
// dedupes log lines per window+size across repeated calls (a window that
// refuses a size must not spam the log); one-shot callers pass nil and always
// log.
func checkAndFitWindows(logf func(string, ...any), alreadyFit map[string]string) (int, error) {
	out, err := xdo("getdisplaygeometry", "search", "--onlyvisible", "--class", "chromium", "getwindowgeometry", "--shell", "%@")
	// When search matches nothing (browser still starting) the chain exits
	// nonzero AFTER printing the display line — parse what arrived and only
	// fail when even that is missing.
	sw, sh, wins, ok := parseChainedGeometry(out)
	if !ok {
		if err != nil {
			return 0, fmt.Errorf("xdotool geometry query: %w", err)
		}
		return 0, fmt.Errorf("xdotool geometry query: unparseable %q", out)
	}
	if sw > windowSizeMax {
		sw = windowSizeMax
	}
	if sh > windowSizeMax {
		sh = windowSizeMax
	}
	want := fmt.Sprintf("%dx%d", sw, sh)
	for _, win := range wins {
		if win.w == sw && win.h == sh || win.w <= 0 || win.h <= 0 {
			continue
		}
		if _, err := xdo("windowsize", win.id, strconv.Itoa(sw), strconv.Itoa(sh)); err != nil {
			continue // window closed mid-pass
		}
		if alreadyFit == nil || alreadyFit[win.id] != want {
			logf("window %s re-fit to screen %s (was %dx%d)", win.id, want, win.w, win.h)
		}
		if alreadyFit != nil {
			alreadyFit[win.id] = want
		}
	}
	return len(wins), nil
}

// requestWindowFit schedules fit checks shortly after a screen-change event.
// Two delays because the caller's event races the actual X resize: a viewer's
// /emulate POST arrives around the same instant as its RFB SetDesktopSize (on
// separate connections — a lossy uplink can deliver the resize a second late),
// and a popup's fullscreen transition takes Chromium a beat to act on. The
// timers RESET on every request, so both delays are measured from the LATEST
// event: a coalescing design that kept the FIRST event's deadlines was found to
// fire both checks before a slow client's resize landed, leaving the band up
// until the backstop poll. A resize slower than the long delay still falls to
// the backstop — that is the trade against polling fast (see the header).
var (
	windowFitMu     sync.Mutex
	windowFitTimers [2]*time.Timer
)

func requestWindowFit(logf func(string, ...any)) {
	delays := [2]time.Duration{250 * time.Millisecond, 1200 * time.Millisecond}
	windowFitMu.Lock()
	defer windowFitMu.Unlock()
	for i, d := range delays {
		if windowFitTimers[i] != nil {
			windowFitTimers[i].Reset(d)
			continue
		}
		// logf is captured by the first caller for the timer's lifetime; every
		// caller passes log.Printf, so nothing is lost.
		windowFitTimers[i] = time.AfterFunc(d, func() {
			if _, err := checkAndFitWindows(logf, nil); err != nil {
				logf("window fit: %v", err)
			}
		})
	}
}

// windowWatcher fixes the boot geometry once (openbox places the kiosk window
// at 1919x1079 on a 1920x1080 screen) and then runs the slow backstop poll for
// screen changes no event announces. Fails open when xdotool is absent (a dev
// host or an image predating the lock entry): one log line, then the goroutine
// exits and geometry behaves as before. Transient errors (X still booting) are
// logged only when they change, not every tick.
func windowWatcher(logf func(string, ...any)) {
	if _, err := exec.LookPath("xdotool"); err != nil {
		logf("window watcher disabled: xdotool not found (window-follows-screen unavailable)")
		return
	}
	backstop := 10 * time.Second
	// /run/rosetta/rosetta is not stat-able from the container's mount namespace,
	// but every translated process's exe link points at it — pid 1 has been
	// translated since boot, so its link is the reliable Rosetta detector.
	if exe, err := os.Readlink("/proc/1/exe"); err == nil && strings.Contains(exe, "rosetta") {
		// Rosetta leaks one Xvnc fd per process spawned in the container (see the
		// header comment); at 120s the backstop spends ~30 fds/hour of the ~1000
		// budget instead of crashing Xvnc mid-workday.
		backstop = 120 * time.Second
	}
	logf("window watcher: event-driven window-follows-screen, backstop poll every %v", backstop)
	fit := map[string]string{}
	lastErr := ""
	// Boot phase: tick fast until the browser window exists and has been checked
	// once — the kiosk window is BORN 1919x1079 on a 1920x1080 screen (openbox
	// placement) and no /emulate event is guaranteed before a plain viewer
	// connects. Bounded, so a container without a browser stops spending spawns.
	booted := false
	bootTicks := 60
	for {
		windows, err := checkAndFitWindows(logf, fit)
		msg := ""
		if err != nil {
			msg = err.Error()
		}
		if msg != lastErr {
			if msg != "" {
				logf("window watcher: %s", msg)
			} else {
				logf("window watcher: recovered")
			}
			lastErr = msg
		}
		if !booted {
			bootTicks--
			booted = (err == nil && windows > 0) || bootTicks <= 0
			if !booted {
				time.Sleep(2 * time.Second)
				continue
			}
		}
		time.Sleep(backstop)
	}
}
