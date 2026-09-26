package main

// A handoff revokes runtime forwarding, not actions already delivered to the
// browser, Xvnc or its extension. The caller must stabilize/re-document the
// retained page before evaluating a replacement script.

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

const viewerHandoffAnnotation = "popcorn.dev/viewer-handoff"
const viewerHandoffStatusPath = "/_popcorn/viewer-handoff-status"
const viewerHandoffDrainTimeout = 10 * time.Second

var errViewerRevoked = errors.New("viewer forwarding is unavailable")

type viewerHandoffStatus struct {
	Version           int     `json:"version"`
	State             string  `json:"state"`
	SessionID         *string `json:"sessionId"`
	PodUID            string  `json:"podUid"`
	RuntimeInstanceID string  `json:"runtimeInstanceId"`
}

type viewerHandoff struct {
	mu                 sync.Mutex
	status             viewerHandoffStatus
	boundAt            string
	activated          chan struct{}
	stop               chan struct{}
	stopped            bool
	conns              map[net.Conn]struct{}
	requests           map[*handoffRequest]struct{}
	work               sync.WaitGroup
	hooks              []func()
	after              []func()
	drainTimeout       time.Duration
	preservationFailed bool
}

type handoffRequest struct{ cancel context.CancelFunc }

func newViewerHandoff(podUID string) (*viewerHandoff, error) {
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return nil, err
	}
	return &viewerHandoff{
		status:    viewerHandoffStatus{Version: 1, State: "awaiting_binding", PodUID: podUID, RuntimeInstanceID: hex.EncodeToString(nonce[:])},
		activated: make(chan struct{}), stop: make(chan struct{}),
		conns: make(map[net.Conn]struct{}), requests: make(map[*handoffRequest]struct{}),
		drainTimeout: viewerHandoffDrainTimeout,
	}, nil
}

func (g *viewerHandoff) allowed() bool {
	if g == nil {
		return true
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.status.State == "active"
}

// begin serializes the last forwarding decision with revocation. Once closed,
// no work can enter the wait group. A failed drain can never produce an ACK.
func (g *viewerHandoff) begin() bool {
	if g == nil {
		return true
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.status.State != "active" {
		return false
	}
	g.work.Add(1)
	return true
}

func (g *viewerHandoff) end() {
	if g != nil {
		g.work.Done()
	}
}

func (g *viewerHandoff) forward(f func() error) error {
	if !g.begin() {
		return errViewerRevoked
	}
	defer g.end()
	return f()
}

// Hooks are installed before the metadata watcher starts.
func (g *viewerHandoff) onStop(f func()) {
	if g != nil {
		g.hooks = append(g.hooks, f)
	}
}

func (g *viewerHandoff) onDrained(f func()) {
	if g != nil {
		g.after = append(g.after, f)
	}
}

func (g *viewerHandoff) snapshot() viewerHandoffStatus {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.status
}

func (g *viewerHandoff) failPreservation() {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.stopped {
		g.preservationFailed = true
	}
}

func (g *viewerHandoff) serveStatus(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	_ = json.NewEncoder(w).Encode(g.snapshot())
}

func (g *viewerHandoff) observe(gs agonesGameServer) {
	a := gs.ObjectMeta.Annotations
	sid := strings.TrimSpace(a["popcorn.dev/session-id"])
	boundAt := strings.TrimSpace(a["popcorn.dev/session-bound-at"])
	_, validTime := time.Parse(time.RFC3339Nano, boundAt)
	g.mu.Lock()
	if g.stopped {
		g.mu.Unlock()
		return
	}
	if sid == "" || boundAt == "" || validTime != nil || g.status.PodUID == "" {
		wasBound := g.status.SessionID != nil
		g.mu.Unlock()
		if wasBound {
			g.revoke(false)
		}
		return
	}
	if g.status.SessionID != nil && (*g.status.SessionID != sid || g.boundAt != boundAt) {
		g.mu.Unlock()
		g.revoke(false)
		return
	}
	if g.status.SessionID == nil {
		g.status.SessionID = new(sid)
		g.boundAt = boundAt
	}
	handoff := strings.TrimSpace(a[viewerHandoffAnnotation])
	if handoff != "" {
		valid := handoff == g.status.PodUID
		g.mu.Unlock()
		g.revoke(valid)
		return
	}
	if g.status.State == "awaiting_binding" {
		g.status.State = "active"
		close(g.activated)
	}
	g.mu.Unlock()
}

func (g *viewerHandoff) watch(e *noiseEndpoint) {
	for {
		if gs, err := e.gameServer(); err == nil {
			g.observe(gs)
		}
		select {
		case <-g.stop:
			return
		case <-time.After(250 * time.Millisecond):
		}
	}
}

func (g *viewerHandoff) revoke(valid bool) {
	g.mu.Lock()
	if g.stopped {
		g.mu.Unlock()
		return
	}
	g.stopped = true
	g.status.State = "revoking"
	close(g.stop)
	conns := make([]net.Conn, 0, len(g.conns))
	for conn := range g.conns {
		conns = append(conns, conn)
	}
	for request := range g.requests {
		request.cancel()
	}
	g.mu.Unlock()
	for _, conn := range conns {
		_ = conn.Close()
	}
	done := make(chan struct{})
	go func() {
		// Closing admission comes first: disconnect hooks must not schedule a
		// restore, and a publisher must not send controls taken from its queue.
		for _, hook := range g.hooks {
			hook()
		}
		g.work.Wait()
		for _, hook := range g.after {
			hook()
		}
		close(done)
	}()
	confirmed := false
	select {
	case <-done:
		confirmed = valid
	case <-time.After(g.drainTimeout):
	}
	g.mu.Lock()
	if confirmed && !g.preservationFailed {
		g.status.State = "revoked"
	} else {
		g.status.State = "unconfirmed"
	}
	g.mu.Unlock()
}

func (g *viewerHandoff) track(conn net.Conn) func() {
	g.mu.Lock()
	if g.status.State != "active" {
		g.mu.Unlock()
		_ = conn.Close()
		return func() {}
	}
	g.conns[conn] = struct{}{}
	g.mu.Unlock()
	return func() {
		g.mu.Lock()
		delete(g.conns, conn)
		g.mu.Unlock()
	}
}

// The full trusted CDP listener never uses this guard. Restricted CDP uses
// all=true. The viewer listener keeps only static files and status available.
func (g *viewerHandoff) guard(next http.Handler, all bool) http.Handler {
	if g == nil {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		controlled := all || isPlaintextLiveViewPath(r.URL.Path) || strings.HasPrefix(r.URL.Path, "/e2e/") || isWebsocketRequest(r) || (r.Method != http.MethodGet && r.Method != http.MethodHead)
		if r.URL.Path == viewerHandoffStatusPath && !all {
			g.serveStatus(w, r)
			return
		}
		if !controlled {
			next.ServeHTTP(w, r)
			return
		}
		g.mu.Lock()
		if g.status.State != "active" {
			g.mu.Unlock()
			http.Error(w, "viewer access is unavailable", http.StatusForbidden)
			return
		}
		ctx, cancel := context.WithCancel(r.Context())
		request := &handoffRequest{cancel: cancel}
		g.requests[request] = struct{}{}
		g.work.Add(1)
		g.mu.Unlock()
		tracked := &handoffResponseWriter{ResponseWriter: w, gate: g}
		defer func() {
			cancel()
			tracked.release()
			g.mu.Lock()
			delete(g.requests, request)
			g.mu.Unlock()
			g.work.Done()
		}()
		next.ServeHTTP(tracked, r.WithContext(ctx))
	})
}

type handoffResponseWriter struct {
	http.ResponseWriter
	gate    *viewerHandoff
	cleanup func()
}

func (w *handoffResponseWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	h, ok := w.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, errors.New("hijacking unsupported")
	}
	conn, rw, err := h.Hijack()
	if err == nil {
		w.cleanup = w.gate.track(conn)
	}
	return conn, rw, err
}

func (w *handoffResponseWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func (w *handoffResponseWriter) release() {
	if w.cleanup != nil {
		w.cleanup()
	}
}
