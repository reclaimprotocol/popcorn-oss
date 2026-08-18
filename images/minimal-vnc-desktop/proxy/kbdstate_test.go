package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// snapshot() is what lets the viewer drive the keyboard over ordinary HTTP before
// its /kbd WebSocket has connected. That matters because a tap is hit-tested against
// the editable rects this state carries, and with none the viewer deliberately never
// pops the keyboard — so on a path where each WebSocket upgrade cost ~4.3s and they
// were served one at a time, /kbd landed ~13s in and taps did nothing until then.
func TestHubSnapshotCarriesStateOnlyWhileAPublisherIsConnected(t *testing.T) {
	hub := newKbdHub()
	focus := []byte(`{"editable":true,"rects":[{"x":1,"y":2,"w":3,"h":4}],"vw":390,"vh":844}`)

	// Published state with no publisher connected describes a page that is gone;
	// the WebSocket path applies the same rule (see serve), so this must too.
	hub.mu.Lock()
	hub.lastState = focus
	hub.publishers = 0
	hub.mu.Unlock()
	if state, _, _ := hub.snapshot(); state != nil {
		t.Fatalf("served state with no publisher connected: %q", state)
	}

	hub.mu.Lock()
	hub.publishers = 1
	hub.mu.Unlock()
	state, _, _ := hub.snapshot()
	if string(state) != string(focus) {
		t.Fatalf("state altered in the snapshot:\n got %q\nwant %q", state, focus)
	}

	// Dialog and popup are cached independently of the publisher count, exactly as
	// the broadcast path treats them: a dialog blocking the page (or a popup window
	// that outlives the viewer connection) must reach a viewer that reloads.
	hub.mu.Lock()
	hub.lastDialog = []byte(`{"kind":"alert"}`)
	hub.lastPopup = []byte(`{"open":true,"seq":2}`)
	hub.mu.Unlock()
	_, dialog, popup := hub.snapshot()
	if string(dialog) != `{"kind":"alert"}` {
		t.Fatalf("dialog lost: %q", dialog)
	}
	if string(popup) != `{"open":true,"seq":2}` {
		t.Fatalf("popup lost: %q", popup)
	}
}

// The endpoint must answer valid, uncached JSON as soon as the app is ready, and
// must stay behind the readiness gate like every other route.
func TestKbdStateEndpoint(t *testing.T) {
	dir := t.TempDir()
	readyFile := filepath.Join(dir, "ready")
	handler := noVNCMux(dir, "127.0.0.1:5900", "127.0.0.1:9223", readyGate{file: readyFile})

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "http://proxy.example/kbdstate", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("before readiness = %d, want 503", rec.Code)
	}

	if err := os.WriteFile(readyFile, nil, 0o600); err != nil {
		t.Fatal(err)
	}

	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "http://proxy.example/kbdstate", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("after readiness = %d, want 200", rec.Code)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("snapshot must not be cached, got %q", got)
	}
	// No publisher in this harness, so the payload is an empty object — the viewer
	// needs that to parse cleanly rather than erroring on every early poll.
	var body map[string]json.RawMessage
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body is not JSON: %v (%q)", err, rec.Body.String())
	}
	if len(body) != 0 {
		t.Fatalf("expected an empty snapshot with no publisher, got %q", rec.Body.String())
	}

	// Writes are not this endpoint's job.
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "http://proxy.example/kbdstate", strings.NewReader("{}")))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST = %d, want 405", rec.Code)
	}
}
