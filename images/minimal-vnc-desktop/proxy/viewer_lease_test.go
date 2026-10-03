package main

import (
	"bufio"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestViewerHandoff(t *testing.T) {
	secret := strings.Repeat("s", 32)
	lease := newViewerLease(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) }), secret, "pod")
	call := func(addr, auth, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "http://local/internal/viewer-handoff", strings.NewReader(body))
		r.RemoteAddr = addr
		r.Header.Set("Authorization", auth)
		w := httptest.NewRecorder()
		lease.ServeHTTP(w, r)
		return w
	}
	body := `{"sessionId":"session","expectedPodUid":"pod"}`
	if w := call("192.0.2.1:1234", "Bearer "+secret, body); w.Code != 401 {
		t.Fatalf("non-local handoff accepted: %d", w.Code)
	}
	if w := call("127.0.0.1:1234", "Bearer wrong", body); w.Code != 401 {
		t.Fatalf("bad secret accepted: %d", w.Code)
	}
	if w := call("127.0.0.1:1234", "Bearer "+secret, `{"sessionId":"session","expectedPodUid":"other"}`); w.Code != 409 {
		t.Fatalf("replaced pod accepted: %d", w.Code)
	}
	a, b := net.Pipe()
	defer b.Close()
	lease.connections[a] = struct{}{}
	if w := call("127.0.0.1:1234", "Bearer "+secret, body); w.Code != 200 || !strings.Contains(w.Body.String(), `"viewerAccess":"revoked"`) {
		t.Fatalf("handoff failed: %d %s", w.Code, w.Body.String())
	}
	if _, err := b.Write([]byte("x")); err == nil {
		t.Fatal("viewer socket survived handoff")
	}
	w := httptest.NewRecorder()
	lease.ServeHTTP(w, httptest.NewRequest("GET", "http://local/", nil))
	if w.Code != 410 {
		t.Fatalf("new viewer accepted: %d", w.Code)
	}
	w = httptest.NewRecorder()
	lease.ServeHTTP(w, httptest.NewRequest("GET", "http://local/healthz", nil))
	if w.Code != 200 {
		t.Fatal("health was retired")
	}
}

type hijackWriter struct {
	*httptest.ResponseRecorder
	conn net.Conn
}

func (w *hijackWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	return w.conn, bufio.NewReadWriter(bufio.NewReader(w.conn), bufio.NewWriter(w.conn)), nil
}
func TestViewerHandoffHijackRace(t *testing.T) {
	lease := newViewerLease(http.NotFoundHandler(), strings.Repeat("s", 32), "pod")
	a, b := net.Pipe()
	defer b.Close()
	lease.revoked = true
	writer := &leaseWriter{ResponseWriter: &hijackWriter{httptest.NewRecorder(), a}, lease: lease}
	if _, _, err := writer.Hijack(); err == nil {
		t.Fatal("late hijack survived revocation")
	}
	if _, err := b.Read(make([]byte, 1)); err != io.EOF {
		t.Fatalf("late socket not closed: %v", err)
	}
}
