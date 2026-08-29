package main

import (
	"bufio"
	"crypto/rand"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/flynn/noise"
)

func TestCDPReadyGate(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/json/version" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]string{
			"webSocketDebuggerUrl": "ws://" + r.Host + "/devtools/browser/test",
		})
	}))
	defer upstream.Close()

	readyFile := filepath.Join(t.TempDir(), "ready")
	handler := cdpMux(upstream.URL, true, readyGate{file: readyFile})

	req := httptest.NewRequest(http.MethodGet, "http://proxy.example/json/version", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("before readiness status = %d, want %d", rec.Code, http.StatusServiceUnavailable)
	}

	wsReq := httptest.NewRequest(http.MethodGet, "http://proxy.example/devtools/browser/test", nil)
	wsReq.Header.Set("Upgrade", "websocket")
	wsReq.Header.Set("Connection", "Upgrade")
	wsReq.Header.Set("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, wsReq)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("websocket before readiness status = %d, want %d", rec.Code, http.StatusServiceUnavailable)
	}

	if err := os.WriteFile(readyFile, []byte("ready"), 0o600); err != nil {
		t.Fatal(err)
	}

	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("after readiness status = %d, want %d: %s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "ws://proxy.example/devtools/browser/test") {
		t.Fatalf("expected rewritten websocket URL, got %s", rec.Body.String())
	}
}

func TestViewerBundleCachePolicies(t *testing.T) {
	dir := t.TempDir()
	readyFile := filepath.Join(dir, "ready")
	if err := os.WriteFile(readyFile, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{
		"viewer-deadbeef.bundle.js",
		"viewer-fallback-deadbeef.bundle.js",
	} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("export {};"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	handler := staticHandler(dir, readyGate{file: readyFile})
	for _, tc := range []struct {
		path string
		want string
	}{
		{"/viewer-deadbeef.bundle.js", "public, max-age=31536000, immutable"},
		{"/viewer-fallback-deadbeef.bundle.js", "no-store, max-age=0, must-revalidate"},
	} {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "http://proxy.example"+tc.path, nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("%s status = %d, want 200", tc.path, rec.Code)
		}
		if got := rec.Header().Get("Cache-Control"); got != tc.want {
			t.Errorf("%s Cache-Control = %q, want %q", tc.path, got, tc.want)
		}
	}
}

func TestCDPDiscoveryURLsIncludeGatewayPrefix(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/json/version":
			_ = json.NewEncoder(w).Encode(map[string]string{
				"webSocketDebuggerUrl": "ws://" + r.Host + "/devtools/browser/test",
			})
		case "/json":
			_ = json.NewEncoder(w).Encode([]map[string]string{
				{
					"devtoolsFrontendUrl":  "devtools://devtools/bundled/inspector.html?ws=" + r.Host + "/devtools/page/abc",
					"webSocketDebuggerUrl": "ws://" + r.Host + "/devtools/page/abc",
				},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()

	handler := cdpMux(upstream.URL, true, readyGate{})

	req := httptest.NewRequest(http.MethodGet, "http://gateway.example/json/version", nil)
	req.Header.Set("X-Forwarded-Proto", "https")
	req.Header.Set("X-Forwarded-Prefix", "/cdp/session-1/token-1")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("version status = %d, want %d: %s", rec.Code, http.StatusOK, rec.Body.String())
	}

	var version struct {
		WebSocketDebuggerURL string `json:"webSocketDebuggerUrl"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &version); err != nil {
		t.Fatal(err)
	}
	if version.WebSocketDebuggerURL != "wss://gateway.example/cdp/session-1/token-1/devtools/browser/test" {
		t.Fatalf("webSocketDebuggerUrl = %q", version.WebSocketDebuggerURL)
	}

	req = httptest.NewRequest(http.MethodGet, "http://gateway.example/json", nil)
	req.Header.Set("X-Forwarded-Proto", "https")
	req.Header.Set("X-Forwarded-Prefix", "/cdp/session-1/token-1")
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("list status = %d, want %d: %s", rec.Code, http.StatusOK, rec.Body.String())
	}

	var targets []struct {
		DevtoolsFrontendURL  string `json:"devtoolsFrontendUrl"`
		WebSocketDebuggerURL string `json:"webSocketDebuggerUrl"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &targets); err != nil {
		t.Fatal(err)
	}
	if len(targets) != 1 {
		t.Fatalf("targets len = %d, want 1", len(targets))
	}
	if targets[0].WebSocketDebuggerURL != "wss://gateway.example/cdp/session-1/token-1/devtools/page/abc" {
		t.Fatalf("target webSocketDebuggerUrl = %q", targets[0].WebSocketDebuggerURL)
	}

	frontendURL, err := url.Parse(targets[0].DevtoolsFrontendURL)
	if err != nil {
		t.Fatal(err)
	}
	if got := frontendURL.Query().Get("ws"); got != "gateway.example/cdp/session-1/token-1/devtools/page/abc" {
		t.Fatalf("devtools ws query = %q", got)
	}
}

func TestNoVNCMuxRequiresReadyFile(t *testing.T) {
	readyFile := filepath.Join(t.TempDir(), "ready")
	handler := noVNCMux(t.TempDir(), "127.0.0.1:5900", "127.0.0.1:9223", readyGate{file: readyFile})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "http://proxy.example/liveview.html", nil)
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("noVNC before readiness status = %d, want %d", rec.Code, http.StatusServiceUnavailable)
	}

}

func TestE2EBindingRejectsPlaintextLiveViewAtPodBoundary(t *testing.T) {
	e, err := newNoiseEndpoint()
	if err != nil {
		t.Fatal(err)
	}
	client, err := noise.DH25519.GenerateKeypair(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	e.setBinding(noiseBinding{SessionID: "encrypted-session", ClientKey: client.Public, PodUID: "pod-1"})

	web := t.TempDir()
	if err := os.WriteFile(filepath.Join(web, "liveview.html"), []byte("viewer shell"), 0o600); err != nil {
		t.Fatal(err)
	}
	liveView := noVNCMux(web, "127.0.0.1:5900", "127.0.0.1:9223", readyGate{}, e)
	for _, route := range []string{
		"/kbd", "/kbdstate", "/dialog", "/emulate", "/geometry", "/input",
		"/klog", "/rtstats", "/websockify", "/vnc-ws/session", "/liveview-ws/session",
	} {
		rec := httptest.NewRecorder()
		liveView.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "http://pod.example"+route, nil))
		if rec.Code != http.StatusForbidden {
			t.Errorf("%s status = %d, want %d", route, rec.Code, http.StatusForbidden)
		}
	}

	// The unified viewer shell is public code and must remain loadable. The
	// selected transport is enforced when it attempts to open a data channel.
	rec := httptest.NewRecorder()
	liveView.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "http://pod.example/liveview.html", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("static viewer status = %d, want %d", rec.Code, http.StatusOK)
	}

	// Chromium's extension publishes dialogs over loopback for both transport
	// modes. External callers cannot use that plaintext control endpoint.
	loopbackDialog := httptest.NewRequest(http.MethodGet, "http://pod.example/dialog", nil)
	loopbackDialog.RemoteAddr = "127.0.0.1:12345"
	rec = httptest.NewRecorder()
	liveView.ServeHTTP(rec, loopbackDialog)
	if rec.Code == http.StatusForbidden {
		t.Fatal("loopback dialog publisher was blocked")
	}

	cdpUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{})
	}))
	defer cdpUpstream.Close()
	cdp := cdpMux(cdpUpstream.URL, true, readyGate{})
	rec = httptest.NewRecorder()
	cdp.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "http://pod.example/json/version", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("server-side CDP status = %d, want %d: %s", rec.Code, http.StatusOK, rec.Body.String())
	}
}

func TestE2EAllocationTerminatesPlaintextWebSocketOpenedWhilePodWasIdle(t *testing.T) {
	e, err := newNoiseEndpoint()
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	finished := make(chan struct{})
	handler := liveViewTransportGuard(e, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		conn, _, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Errorf("hijack: %v", err)
			return
		}
		defer conn.Close()
		close(started)
		_, _ = conn.Read(make([]byte, 1))
		close(finished)
	}))
	server := httptest.NewServer(handler)
	defer server.Close()
	u, _ := url.Parse(server.URL)
	viewer, err := net.Dial("tcp", u.Host)
	if err != nil {
		t.Fatal(err)
	}
	defer viewer.Close()
	if _, err = viewer.Write([]byte("GET /websockify HTTP/1.1\r\nHost: " + u.Host + "\r\n\r\n")); err != nil {
		t.Fatal(err)
	}
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("plaintext handler did not start")
	}
	if err = viewer.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	e.setBinding(noiseBinding{SessionID: "encrypted-session", BindingSecretHash: make([]byte, 32), PodUID: "pod-uid"})
	if _, err = viewer.Read(make([]byte, 1)); err == nil {
		t.Fatal("plaintext WebSocket survived E2E allocation")
	}
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("plaintext handler remained open")
	}
}

func TestUnboundPodKeepsDefaultTransportAvailable(t *testing.T) {
	e, err := newNoiseEndpoint()
	if err != nil {
		t.Fatal(err)
	}
	liveView := noVNCMux(t.TempDir(), "127.0.0.1:5900", "127.0.0.1:9223", readyGate{}, e)
	rec := httptest.NewRecorder()
	liveView.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "http://pod.example/kbdstate", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("default control status = %d, want %d: %s", rec.Code, http.StatusOK, rec.Body.String())
	}

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{})
	}))
	defer upstream.Close()
	cdp := cdpMux(upstream.URL, true, readyGate{})
	rec = httptest.NewRecorder()
	cdp.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "http://pod.example/json/version", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("default CDP status = %d, want %d: %s", rec.Code, http.StatusOK, rec.Body.String())
	}
}

// Content negotiation for the precompressed viewer bundle. A client that says it
// CANNOT take an encoding (q=0) and is served it anyway fails to load the bundle,
// so the whole session is a blank screen — hence pinning the refusal cases, not
// just the accept ones.
func TestAcceptsEncodingHonoursQValues(t *testing.T) {
	for _, tc := range []struct {
		header string
		enc    string
		want   bool
	}{
		{"gzip, deflate, br", "br", true},
		{"gzip, deflate, br", "gzip", true},
		{"gzip, deflate", "br", false},
		{"", "gzip", false},
		{"gzip;q=0", "gzip", false},
		{"gzip;q=0, identity", "gzip", false},
		{"br;q=0.0, gzip", "br", false},
		{"gzip;q=0.001", "gzip", true},
		{"GZIP;Q=0", "gzip", false},
		{"gzip ; q=0.5", "gzip", true},
		// A wildcard covers what is not named; an explicit entry outranks it.
		{"*", "br", true},
		{"*;q=0", "br", false},
		{"*;q=0, gzip", "gzip", true},
		{"*, br;q=0", "br", false},
		// A malformed q must not silently disable an encoding the client asked for.
		{"gzip;q=abc", "gzip", true},
	} {
		if got := acceptsEncoding(tc.header, tc.enc); got != tc.want {
			t.Errorf("acceptsEncoding(%q, %q) = %v, want %v", tc.header, tc.enc, got, tc.want)
		}
	}
}

func TestPrecompressedVariantSkipsRefusedEncoding(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{"viewer.js", "viewer.js.gz", "viewer.js.br"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if enc, _ := precompressedVariant(root, "/viewer.js", "br;q=0, gzip"); enc != "gzip" {
		t.Fatalf("enc = %q, want gzip (br was refused)", enc)
	}
	if enc, _ := precompressedVariant(root, "/viewer.js", "br;q=0, gzip;q=0"); enc != "" {
		t.Fatalf("enc = %q, want the raw file when every variant is refused", enc)
	}
}

func TestRestrictedCDPFilter(t *testing.T) {
	bridge := &cdpBridge{allowed: allowedCDPCommands()}

	allowed, response := bridge.filterCDPCommand([]byte(`{"id":1,"method":"Browser.getVersion"}`))
	if !allowed || response != nil {
		t.Fatalf("Browser.getVersion allowed=%v response=%q, want allowed with no response", allowed, response)
	}

	allowed, response = bridge.filterCDPCommand([]byte(`{"id":2,"method":"Target.createTarget","params":{"url":"about:blank"}}`))
	if allowed {
		t.Fatal("Target.createTarget was allowed on restricted CDP")
	}
	var blocked struct {
		ID    int `json:"id"`
		Error struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(response, &blocked); err != nil {
		t.Fatalf("blocked response is not JSON: %v; body=%q", err, response)
	}
	if blocked.ID != 2 || blocked.Error.Code != -32000 || blocked.Error.Message != "Command not allowed" {
		t.Fatalf("unexpected blocked response: %+v", blocked)
	}

	allowed, response = bridge.filterCDPCommand([]byte(`{"method":"Runtime.evaluate"}`))
	if allowed || response != nil {
		t.Fatalf("notification blocked allowed=%v response=%q, want blocked without response", allowed, response)
	}
}

func TestRestrictedBridgeBlocksUnsafeFrames(t *testing.T) {
	tests := []struct {
		name    string
		opcode  byte
		payload []byte
		fin     bool
	}{
		{
			name:    "binary",
			opcode:  0x2,
			payload: []byte(`{"id":1,"method":"Browser.getVersion"}`),
			fin:     true,
		},
		{
			name:    "fragmented text",
			opcode:  0x1,
			payload: []byte(`{"id":1,"method":"Browser.getVersion"}`),
			fin:     false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			client, proxyClient := net.Pipe()
			upstream, proxyUpstream := net.Pipe()
			defer client.Close()
			defer proxyClient.Close()
			defer upstream.Close()
			defer proxyUpstream.Close()

			bridge := &cdpBridge{
				client:       proxyClient,
				clientReader: bufio.NewReader(proxyClient),
				upstream:     proxyUpstream,
				restricted:   true,
				allowed:      allowedCDPCommands(),
			}
			done := make(chan struct{})
			go func() {
				bridge.copyClientToUpstream()
				close(done)
			}()

			var mu sync.Mutex
			if err := client.SetDeadline(time.Now().Add(2 * time.Second)); err != nil {
				t.Fatal(err)
			}
			if err := upstream.SetReadDeadline(time.Now().Add(150 * time.Millisecond)); err != nil {
				t.Fatal(err)
			}
			if err := writeFrameToConn(client, &mu, tt.opcode, tt.payload, true, tt.fin); err != nil {
				t.Fatal(err)
			}

			_, opcode, _, err := readFrame(bufio.NewReader(client))
			if err != nil {
				t.Fatalf("expected close frame from restricted proxy: %v", err)
			}
			if opcode != 0x8 {
				t.Fatalf("opcode = 0x%x, want close frame", opcode)
			}

			_, _, _, err = readFrame(bufio.NewReader(upstream))
			if err == nil {
				t.Fatal("unsafe restricted frame was forwarded upstream")
			}

			select {
			case <-done:
			case <-time.After(2 * time.Second):
				t.Fatal("restricted bridge did not stop after unsafe frame")
			}
		})
	}
}

func TestRestrictedBridgeBlocksDisallowedCommand(t *testing.T) {
	client, proxyClient := net.Pipe()
	upstream, proxyUpstream := net.Pipe()
	defer client.Close()
	defer proxyClient.Close()
	defer upstream.Close()
	defer proxyUpstream.Close()

	bridge := &cdpBridge{
		client:       proxyClient,
		clientReader: bufio.NewReader(proxyClient),
		upstream:     proxyUpstream,
		restricted:   true,
		allowed:      allowedCDPCommands(),
	}
	done := make(chan struct{})
	go func() {
		bridge.copyClientToUpstream()
		close(done)
	}()

	var mu sync.Mutex
	if err := client.SetDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatal(err)
	}
	if err := upstream.SetReadDeadline(time.Now().Add(150 * time.Millisecond)); err != nil {
		t.Fatal(err)
	}
	if err := writeFrameToConn(client, &mu, 0x1, []byte(`{"id":7,"method":"Target.createTarget"}`), true, true); err != nil {
		t.Fatal(err)
	}

	_, opcode, payload, err := readFrame(bufio.NewReader(client))
	if err != nil {
		t.Fatalf("expected blocked command response: %v", err)
	}
	if opcode != 0x1 {
		t.Fatalf("opcode = 0x%x, want text response", opcode)
	}
	if !strings.Contains(string(payload), `"Command not allowed"`) {
		t.Fatalf("unexpected blocked payload: %s", payload)
	}

	_, _, _, err = readFrame(bufio.NewReader(upstream))
	if err == nil {
		t.Fatal("blocked restricted command was forwarded upstream")
	}
	_ = client.Close()
	<-done
}

func TestRestrictedBridgeForwardsAllowedCommand(t *testing.T) {
	client, proxyClient := net.Pipe()
	upstream, proxyUpstream := net.Pipe()
	defer client.Close()
	defer proxyClient.Close()
	defer upstream.Close()
	defer proxyUpstream.Close()

	bridge := &cdpBridge{
		client:       proxyClient,
		clientReader: bufio.NewReader(proxyClient),
		upstream:     proxyUpstream,
		restricted:   true,
		allowed:      allowedCDPCommands(),
	}
	done := make(chan struct{})
	go func() {
		bridge.copyClientToUpstream()
		close(done)
	}()

	var mu sync.Mutex
	if err := client.SetDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatal(err)
	}
	if err := upstream.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatal(err)
	}
	if err := writeFrameToConn(client, &mu, 0x1, []byte(`{"id":1,"method":"Browser.getVersion"}`), true, true); err != nil {
		t.Fatal(err)
	}

	_, opcode, payload, err := readFrame(bufio.NewReader(upstream))
	if err != nil {
		t.Fatalf("expected forwarded allowed command: %v", err)
	}
	if opcode != 0x1 || string(payload) != `{"id":1,"method":"Browser.getVersion"}` {
		t.Fatalf("forwarded opcode=0x%x payload=%s", opcode, payload)
	}
	_ = client.Close()
	<-done
}

func TestWebsocketCloseInfo(t *testing.T) {
	code, reason := websocketCloseInfo([]byte{0x03, 0xE8, 'b', 'y', 'e', '\n', 'x'})
	if code != 1000 {
		t.Fatalf("code = %d, want 1000", code)
	}
	if reason != "bye x" {
		t.Fatalf("reason = %q, want sanitized close text", reason)
	}
	if code, reason := websocketCloseInfo([]byte{1}); code != 0 || reason != "" {
		t.Fatalf("short payload = (%d, %q), want empty", code, reason)
	}
}

// The keyboard extension is an in-pod publisher, not user-facing transport. Its
// field rects and remote viewport are what let a tap map to a remote coordinate
// and raise the keyboard.
func TestE2EBindingAllowsTheLoopbackKeyboardPublisher(t *testing.T) {
	e, err := newNoiseEndpoint()
	if err != nil {
		t.Fatal(err)
	}
	client, err := noise.DH25519.GenerateKeypair(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	e.setBinding(noiseBinding{SessionID: "encrypted-session", ClientKey: client.Public, PodUID: "pod-1"})
	liveView := noVNCMux(t.TempDir(), "127.0.0.1:5900", "127.0.0.1:9223", readyGate{}, e)

	ask := func(target, remote, origin string) int {
		r := httptest.NewRequest(http.MethodGet, "http://pod.example"+target, nil)
		r.RemoteAddr = remote
		if origin != "" {
			r.Header.Set("Origin", origin)
		}
		rec := httptest.NewRecorder()
		liveView.ServeHTTP(rec, r)
		return rec.Code
	}
	if code := ask("/kbd?role=pub", "127.0.0.1:12345", "chrome-extension://abc"); code == http.StatusForbidden {
		t.Error("the pod's own keyboard publisher was blocked; the session loses every field rect")
	}
	// The carve-out is exactly the publisher trust level, nothing wider.
	for _, c := range []struct {
		name, target, remote, origin string
	}{
		{"remote publisher", "/kbd?role=pub", "203.0.113.7:443", "chrome-extension://abc"},
		{"page origin", "/kbd?role=pub", "127.0.0.1:12345", "https://example.test"},
		{"loopback subscriber", "/kbd", "127.0.0.1:12345", ""},
	} {
		if code := ask(c.target, c.remote, c.origin); code != http.StatusForbidden {
			t.Errorf("%s status = %d, want %d", c.name, code, http.StatusForbidden)
		}
	}
}
