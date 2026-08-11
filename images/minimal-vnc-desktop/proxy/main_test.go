package main

import (
	"bufio"
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
)

func TestStaticReadyGateAllowsOnlyLoopbackBootstrap(t *testing.T) {
	root := t.TempDir()
	readyFile := filepath.Join(t.TempDir(), "ready")
	if err := os.WriteFile(filepath.Join(root, "proxy-bootstrap.html"), []byte("bootstrap"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "liveview.html"), []byte("liveview"), 0o600); err != nil {
		t.Fatal(err)
	}
	handler := staticHandler(root, readyGate{file: readyFile})

	tests := []struct {
		name       string
		path       string
		remoteAddr string
		wantStatus int
	}{
		{name: "loopback bootstrap", path: "/proxy-bootstrap.html", remoteAddr: "127.0.0.1:12345", wantStatus: http.StatusOK},
		{name: "IPv6 loopback bootstrap", path: "/proxy-bootstrap.html", remoteAddr: "[::1]:12345", wantStatus: http.StatusOK},
		{name: "external bootstrap", path: "/proxy-bootstrap.html", remoteAddr: "192.0.2.1:12345", wantStatus: http.StatusServiceUnavailable},
		{name: "bootstrap query", path: "/proxy-bootstrap.html?unexpected=1", remoteAddr: "127.0.0.1:12345", wantStatus: http.StatusServiceUnavailable},
		{name: "loopback liveview", path: "/liveview.html", remoteAddr: "127.0.0.1:12345", wantStatus: http.StatusServiceUnavailable},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "http://proxy.example"+tt.path, nil)
			req.RemoteAddr = tt.remoteAddr
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)
			if rec.Code != tt.wantStatus {
				t.Fatalf("status = %d, want %d: %s", rec.Code, tt.wantStatus, rec.Body.String())
			}
		})
	}
}

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
	handler := noVNCMux(t.TempDir(), "127.0.0.1:5900", readyGate{file: readyFile})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "http://proxy.example/liveview.html", nil)
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("noVNC before readiness status = %d, want %d", rec.Code, http.StatusServiceUnavailable)
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
