package main

import "testing"

// The fit decisions are exec-and-parse; the parsers are the testable core.
// Samples are verbatim xdotool output from the live container.

func TestParsePair(t *testing.T) {
	cases := []struct {
		in   string
		w, h int
		ok   bool
	}{
		{"1920 1080", 1920, 1080, true},
		{"1072 2052\n", 1072, 2052, true},
		{"", 0, 0, false},
		{"1920", 0, 0, false},
		{"1920 1080 24", 0, 0, false},
		{"w h", 0, 0, false},
		{"0 1080", 0, 0, false},
		{"-1 1080", 0, 0, false},
	}
	for _, c := range cases {
		w, h, ok := parsePair(c.in)
		if w != c.w || h != c.h || ok != c.ok {
			t.Errorf("parsePair(%q) = %d,%d,%v; want %d,%d,%v", c.in, w, h, ok, c.w, c.h, c.ok)
		}
	}
}

func TestParseChainedGeometry(t *testing.T) {
	// One chained invocation: display line, then a KEY=value block per window.
	out := "1920 1080\nWINDOW=2097155\nX=0\nY=0\nWIDTH=1920\nHEIGHT=1080\nSCREEN=0\nWINDOW=4194307\nX=1\nY=1\nWIDTH=500\nHEIGHT=690\nSCREEN=0"
	sw, sh, wins, ok := parseChainedGeometry(out)
	if !ok || sw != 1920 || sh != 1080 {
		t.Fatalf("screen = %d,%d,%v; want 1920,1080,true", sw, sh, ok)
	}
	if len(wins) != 2 {
		t.Fatalf("parsed %d windows, want 2", len(wins))
	}
	if wins[0].id != "2097155" || wins[0].w != 1920 || wins[0].h != 1080 {
		t.Errorf("window[0] = %+v; want id=2097155 1920x1080", wins[0])
	}
	if wins[1].id != "4194307" || wins[1].w != 500 || wins[1].h != 690 {
		t.Errorf("window[1] = %+v; want id=4194307 500x690", wins[1])
	}

	// No browser window yet: search matches nothing, only the display line
	// arrives (and xdotool exits nonzero — the caller treats this as zero
	// windows, not an error).
	sw, sh, wins, ok = parseChainedGeometry("1920 1080")
	if !ok || sw != 1920 || sh != 1080 || len(wins) != 0 {
		t.Fatalf("bare display line = %d,%d,%d windows,%v; want 1920,1080,0,true", sw, sh, len(wins), ok)
	}

	if _, _, _, ok := parseChainedGeometry(""); ok {
		t.Fatal("empty output parsed as ok")
	}
	if _, _, _, ok := parseChainedGeometry("junk"); ok {
		t.Fatal("junk output parsed as ok")
	}
}

// A phone-sized screen asks for a window Chromium will not give (it enforces a
// ~500px minimum width), so the fit must give up instead of re-issuing the
// resize on every screen event — each attempt reflows the remote page.
func TestWindowFitStopsFightingAClampedWindow(t *testing.T) {
	windowFitStateMu.Lock()
	windowFitState = map[string]windowFitAttempt{}
	windowFitStateMu.Unlock()

	const id, want = "8388611", "360x633"
	for i := 0; i < windowFitAttempts; i++ {
		if !windowFitAllowed(id, want) {
			t.Fatalf("attempt %d refused; the first tries must go through (the screen resize can race the check)", i+1)
		}
	}
	if windowFitAllowed(id, want) {
		t.Fatal("kept trying a size the browser clamps")
	}

	// A screen that really changed is a different question, and gets asked.
	if !windowFitAllowed(id, "500x900") {
		t.Fatal("a new want was refused")
	}
	// And once the window matches, forget it: a later drift at the same size is
	// a fixable mismatch, not the clamp.
	windowFitSettled(id)
	if !windowFitAllowed(id, want) {
		t.Fatal("a settled window was not retried")
	}
}

// The give-up line explains a window narrower than the screen, so it must be
// said once per size and again when the screen really changes.
func TestWindowFitGiveUpLineIsSaidOncePerSize(t *testing.T) {
	windowFitStateMu.Lock()
	windowFitState = map[string]windowFitAttempt{}
	windowFitStateMu.Unlock()

	const id, want = "8388611", "360x633"
	for i := 0; i < windowFitAttempts; i++ {
		windowFitAllowed(id, want)
	}
	if !windowFitNote(id, want) {
		t.Fatal("first give-up was not logged")
	}
	if windowFitNote(id, want) {
		t.Fatal("give-up line repeated for the same size")
	}
	// A different want is a different question; it gets its own line once it,
	// too, runs out of attempts.
	windowFitAllowed(id, "500x900")
	if windowFitNote(id, "500x900") {
		t.Fatal("logged a give-up for a size still being attempted")
	}
}
