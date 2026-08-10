package main

// Keep every Chromium toplevel sized to the X screen ("window-follows-screen").
//
// The X screen is client-driven — a magnify/fit viewer grows it past the boot
// geometry — but a --kiosk window is sized once at launch and nothing re-fits
// it afterwards: openbox ignores the RandR change, and CDP setWindowBounds can
// only resize a window in state "normal", which draws the tab strip into the
// stream. Screen area the window does not cover renders as the bare X root, so
// every tall fit showed a black band. A raw X-level resize (xdotool windowsize)
// is the one path that resizes in place and stays chromeless: measured on a
// live container, Chromium re-lays the page out and neither openbox nor the CDP
// fullscreen watchdog fights it.
//
// EVENT-DRIVEN, deliberately, with one chained xdotool invocation per check:
// under Rosetta (Docker Desktop on Apple silicon) every process spawned in the
// container leaks an fd into Xvnc's table, and a 400ms three-exec poll killed
// Xvnc on FD_SETSIZE in under five minutes. Real Linux does not leak, but the
// dev boxes here all do. So requestWindowFit runs after the known screen-change
// events and the backstop poll only catches what no event announces (a raw RFB
// client resizing the screen itself).

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
// screen in one xdotool invocation and resizes the ones that disagree.
// Idempotent; returns how many windows it saw, which is how the watcher's boot
// phase knows the browser is up. alreadyFit dedupes the log line per
// window+size so a window that refuses a size cannot spam it; one-shot callers
// pass nil and always log.
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
// Two delays because the event races the X resize it predicts: an /emulate POST
// and its RFB SetDesktopSize travel on separate connections, so a lossy uplink
// can deliver the resize a second late. The timers RESET on each request, so
// both delays measure from the LATEST event — coalescing onto the FIRST event's
// deadlines fired both checks before a slow client's resize landed. A resize
// slower than the long delay falls to the backstop poll.
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
// at 1919x1079 on a 1920x1080 screen) and then runs the backstop poll. Fails
// open when xdotool is absent: one log line and the goroutine exits, leaving
// geometry as it was before this file existed. Transient errors (X still
// booting) are logged only when they change.
func windowWatcher(logf func(string, ...any)) {
	if _, err := exec.LookPath("xdotool"); err != nil {
		logf("window watcher disabled: xdotool not found (window-follows-screen unavailable)")
		return
	}
	backstop := 10 * time.Second
	// /run/rosetta/rosetta is not stat-able from the container's mount namespace,
	// but a translated process's exe link points at it and pid 1 is always one.
	// Back right off there: each spawn costs an Xvnc fd (see the header).
	if exe, err := os.Readlink("/proc/1/exe"); err == nil && strings.Contains(exe, "rosetta") {
		backstop = 120 * time.Second
	}
	logf("window watcher: event-driven window-follows-screen, backstop poll every %v", backstop)
	fit := map[string]string{}
	lastErr := ""
	// Boot phase: tick fast until the browser window exists and has been checked
	// once. The kiosk window is born 1919x1079 on a 1920x1080 screen and no event
	// is guaranteed before the first plain viewer connects. Bounded, so a
	// container without a browser stops spending spawns.
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
