package main

import (
	"bufio"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"net"
	"net/http"
	"strings"
	"sync"
)

// Allocation-local handoff. It retires existing viewer sockets as well as
// rejecting new viewers; Chrome and the internal CDP transport stay alive.
type viewerLease struct {
	mu                         sync.Mutex
	revoked                    bool
	connections                map[net.Conn]struct{}
	secret, podUID, instanceID string
	next                       http.Handler
}

func newViewerLease(next http.Handler, secret, podUID string) *viewerLease {
	id := make([]byte, 16)
	if _, err := rand.Read(id); err != nil {
		panic(err)
	}
	return &viewerLease{next: next, secret: secret, podUID: podUID, instanceID: hex.EncodeToString(id), connections: make(map[net.Conn]struct{})}
}

func (v *viewerLease) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/internal/viewer-handoff" {
		v.handoff(w, r)
		return
	}
	// Readiness remains available after handoff; it carries no viewer data.
	if r.URL.Path == "/healthz" {
		v.next.ServeHTTP(w, r)
		return
	}
	v.mu.Lock()
	revoked := v.revoked
	v.mu.Unlock()
	if revoked {
		http.Error(w, "viewer retired", http.StatusGone)
		return
	}
	v.next.ServeHTTP(&leaseWriter{ResponseWriter: w, lease: v}, r)
}

func (v *viewerLease) handoff(w http.ResponseWriter, r *http.Request) {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	ip := net.ParseIP(host)
	token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") || err != nil || ip == nil || !ip.IsLoopback() || len(v.secret) < 32 ||
		subtle.ConstantTimeCompare([]byte(token), []byte(v.secret)) != 1 {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var input struct {
		SessionID      string `json:"sessionId"`
		ExpectedPodUID string `json:"expectedPodUid"`
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	dec.DisallowUnknownFields()
	if dec.Decode(&input) != nil || input.SessionID == "" || v.podUID == "" || input.ExpectedPodUID != v.podUID {
		http.Error(w, "allocation mismatch", http.StatusConflict)
		return
	}
	v.mu.Lock()
	v.revoked = true
	connections := v.connections
	v.connections = make(map[net.Conn]struct{})
	v.mu.Unlock()
	for conn := range connections {
		_ = conn.Close()
	}
	v.mu.Lock()
	v.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "sessionId": input.SessionID, "podUid": v.podUID, "viewerAccess": "revoked", "runtimeInstanceId": v.instanceID})
}

type leaseWriter struct {
	http.ResponseWriter
	lease *viewerLease
}

func (w *leaseWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	conn, rw, err := w.ResponseWriter.(http.Hijacker).Hijack()
	if err != nil {
		return conn, rw, err
	}
	w.lease.mu.Lock()
	defer w.lease.mu.Unlock()
	if w.lease.revoked {
		_ = conn.Close()
		return nil, nil, net.ErrClosed
	}
	tracked := &leaseConn{Conn: conn, lease: w.lease}
	w.lease.connections[tracked] = struct{}{}
	return tracked, rw, nil
}
func (w *leaseWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

type leaseConn struct {
	net.Conn
	lease *viewerLease
}

func (c *leaseConn) Close() error {
	c.lease.mu.Lock()
	delete(c.lease.connections, c)
	c.lease.mu.Unlock()
	return c.Conn.Close()
}
