package main

import (
	"bufio"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/flynn/noise"
)

func handoffMetadata(sid, pod string) agonesGameServer {
	var gs agonesGameServer
	gs.ObjectMeta.Annotations = map[string]string{
		"popcorn.dev/session-id":       sid,
		"popcorn.dev/session-bound-at": "2026-09-24T12:00:00.000Z",
	}
	if pod != "" {
		gs.ObjectMeta.Annotations[viewerHandoffAnnotation] = pod
	}
	return gs
}

func activeHandoff(t *testing.T) *viewerHandoff {
	t.Helper()
	g, err := newViewerHandoff("pod-uid")
	if err != nil {
		t.Fatal(err)
	}
	g.observe(handoffMetadata("session", ""))
	if !g.allowed() {
		t.Fatal("valid allocation was not activated")
	}
	return g
}

func awaitHandoffState(t *testing.T, g *viewerHandoff, want string) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if g.snapshot().State == want {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("handoff state = %s, want %s", g.snapshot().State, want)
}

func TestViewerHandoffBindingAndRestart(t *testing.T) {
	g, err := newViewerHandoff("pod-uid")
	if err != nil {
		t.Fatal(err)
	}
	if g.allowed() || g.snapshot().State != "awaiting_binding" {
		t.Fatal("startup admitted viewers")
	}
	g.observe(agonesGameServer{})
	if g.allowed() {
		t.Fatal("missing metadata admitted viewers")
	}
	badTime := handoffMetadata("session", "")
	badTime.ObjectMeta.Annotations["popcorn.dev/session-bound-at"] = "not-a-timestamp"
	g.observe(badTime)
	if g.allowed() {
		t.Fatal("invalid allocation admitted viewers")
	}
	g.observe(handoffMetadata("session", ""))
	if !g.allowed() {
		t.Fatal("valid binding did not open admission")
	}
	g.observe(handoffMetadata("session", "pod-uid"))
	if g.snapshot().State != "revoked" || g.allowed() {
		t.Fatal("handoff not revoked")
	}
	g.observe(handoffMetadata("session", ""))
	if g.allowed() {
		t.Fatal("removed annotation reopened admission")
	}

	restarted, err := newViewerHandoff("pod-uid")
	if err != nil {
		t.Fatal(err)
	}
	restarted.observe(handoffMetadata("session", "pod-uid"))
	if restarted.snapshot().State != "revoked" {
		t.Fatal("persisted request was not honored on restart")
	}
	if restarted.snapshot().RuntimeInstanceID == g.snapshot().RuntimeInstanceID {
		t.Fatal("restart reused instance identity")
	}
	if len(g.snapshot().RuntimeInstanceID) != 32 {
		t.Fatal("invalid runtime instance identity")
	}
}

func TestViewerHandoffRejectsAmbiguousIdentity(t *testing.T) {
	for _, scenario := range []string{"other-session", "other-bound-at", "other-pod", "missing-binding"} {
		t.Run(scenario, func(t *testing.T) {
			g := activeHandoff(t)
			gs := handoffMetadata("session", "")
			switch scenario {
			case "other-session":
				gs.ObjectMeta.Annotations["popcorn.dev/session-id"] = "other"
			case "other-bound-at":
				gs.ObjectMeta.Annotations["popcorn.dev/session-bound-at"] = "2026-09-24T13:00:00Z"
			case "other-pod":
				gs.ObjectMeta.Annotations[viewerHandoffAnnotation] = "other-pod"
			case "missing-binding":
				gs = agonesGameServer{}
			}
			g.observe(gs)
			if g.allowed() || g.snapshot().State != "unconfirmed" {
				t.Fatalf("ambiguous allocation acknowledged: %+v", g.snapshot())
			}
		})
	}
}

func TestViewerHandoffWaitsForInFlightForwarding(t *testing.T) {
	g := activeHandoff(t)
	entered, release, ended := make(chan struct{}), make(chan struct{}), make(chan struct{})
	go func() {
		defer close(ended)
		_ = g.forward(func() error { close(entered); <-release; return nil })
	}()
	<-entered
	done := make(chan struct{})
	go func() { g.revoke(true); close(done) }()
	awaitHandoffState(t, g, "revoking")
	if err := g.forward(func() error { t.Error("new command forwarded"); return nil }); !errors.Is(err, errViewerRevoked) {
		t.Fatal(err)
	}
	select {
	case <-done:
		t.Fatal("ACK preceded forwarding completion")
	default:
	}
	close(release)
	<-ended
	<-done
	if g.snapshot().State != "revoked" {
		t.Fatal(g.snapshot())
	}
}

func TestViewerHandoffCanceledHTTPMustDrain(t *testing.T) {
	g := activeHandoff(t)
	entered, canceled, release, done := make(chan struct{}), make(chan struct{}), make(chan struct{}), make(chan struct{})
	h := g.guard(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(entered)
		<-r.Context().Done()
		close(canceled)
		<-release
	}), false)
	go func() {
		h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/emulate", nil))
		close(done)
	}()
	<-entered
	revoked := make(chan struct{})
	go func() { g.revoke(true); close(revoked) }()
	<-canceled
	if g.snapshot().State != "revoking" {
		t.Fatal("cancellation alone acknowledged handoff")
	}
	close(release)
	<-done
	<-revoked
	if g.snapshot().State != "revoked" {
		t.Fatal(g.snapshot())
	}
}

func TestViewerHandoffUnfinishedWorkCannotAcknowledge(t *testing.T) {
	g := activeHandoff(t)
	g.drainTimeout = 15 * time.Millisecond
	if !g.begin() {
		t.Fatal("work not admitted")
	}
	g.revoke(true)
	if g.snapshot().State != "unconfirmed" || g.allowed() {
		t.Fatal("timed-out drain acknowledged")
	}
	g.end()
	g.observe(handoffMetadata("session", "pod-uid"))
	if g.snapshot().State != "unconfirmed" {
		t.Fatal("late completion replaced failed acknowledgment")
	}
}

func TestViewerHandoffEmulatorQueuesAreDiscarded(t *testing.T) {
	t.Setenv("MVD_EMULATOR_OFF", "1")
	g := activeHandoff(t)
	em := newEmulator("127.0.0.1:1", g)
	em.setActive("target-session")
	var callbacks atomic.Int32
	callback := func(wrote bool) {
		if wrote {
			t.Error("discarded command reported written")
		}
		callbacks.Add(1)
	}
	if !em.queueWithDone("Input.dispatchTouchEvent", nil, callback) || !em.queueImportantWithDone("Input.dispatchMouseEvent", nil, callback) {
		t.Fatal("queues rejected active commands")
	}
	g.revoke(true)
	if g.snapshot().State != "revoked" || len(em.prio)+len(em.cmds) != 0 || callbacks.Load() != 2 {
		t.Fatalf("not drained: status=%+v callbacks=%d", g.snapshot(), callbacks.Load())
	}
	if em.queueWithDone("Input.insertText", nil, nil) || em.enqueuePriority(cdpCmd{}, time.Millisecond) || em.enqueueCmd(cdpCmd{}) {
		t.Fatal("revoked emulator accepted input")
	}
}

func TestViewerHandoffScreenRestoreIsSuppressed(t *testing.T) {
	g := activeHandoff(t)
	var calls atomic.Int32
	k := newScreenKeeper(time.Hour, func() { calls.Add(1) })
	k.handoff = g
	g.onStop(k.stopForHandoff)
	k.connect(true)
	k.disconnect()
	g.revoke(true)
	k.mu.Lock()
	gen, timer := k.gen, k.timer
	k.mu.Unlock()
	if timer != nil {
		t.Fatal("restore timer retained")
	}
	k.finishRestore(gen)
	k.disconnect()
	if calls.Load() != 0 {
		t.Fatal("disconnect resized retained browser")
	}
	if _, err := checkAndFitWindows(func(string, ...any) {}, nil, g); !errors.Is(err, errViewerRevoked) {
		t.Fatal("window mutation gate not applied", err)
	}
}

func TestViewerHandoffHTTPGuardAndStatus(t *testing.T) {
	g := activeHandoff(t)
	called := 0
	h := g.guard(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called++; w.WriteHeader(200) }), false)
	g.revoke(true)
	for _, path := range []string{"/kbd", "/kbdstate", "/dialog", "/emulate", "/geometry", "/input", "/klog", "/rtstats", "/websockify", "/e2e/rfb", "/e2e/control", "/vnc-ws/anything", "/liveview-ws/anything"} {
		for _, method := range []string{http.MethodGet, http.MethodPost} {
			w := httptest.NewRecorder()
			h.ServeHTTP(w, httptest.NewRequest(method, path, nil))
			if w.Code != http.StatusForbidden {
				t.Fatalf("%s %s admitted: %d", method, path, w.Code)
			}
		}
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, viewerHandoffStatusPath, nil))
	var status map[string]any
	if json.Unmarshal(w.Body.Bytes(), &status) != nil || len(status) != 5 || status["state"] != "revoked" || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("unexpected status", w.Body.String())
	}
	w = httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodPost, viewerHandoffStatusPath, nil))
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatal("status is not read-only")
	}
	if called != 0 {
		t.Fatal("controlled handler ran after handoff")
	}
	w = httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/liveview.html", nil))
	if w.Code != 200 || called != 1 {
		t.Fatal("static assets unnecessarily disabled")
	}
	var nilGate *viewerHandoff
	w = httptest.NewRecorder()
	nilGate.guard(h, false).ServeHTTP(w, httptest.NewRequest(http.MethodGet, viewerHandoffStatusPath, nil))
	if w.Code != 200 {
		t.Fatal("nil compatibility guard changed response")
	}
}

func openNoiseForHandoff(t *testing.T, base, channel string, e *noiseEndpoint, client noise.DHKey) (net.Conn, *bufio.Reader, *noise.CipherState, *noise.CipherState) {
	t.Helper()
	conn, reader, err := dialWebsocket("ws" + strings.TrimPrefix(base, "http") + "/e2e/" + channel)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
	hs, err := noise.NewHandshakeState(noise.Config{CipherSuite: noise.NewCipherSuite(noise.DH25519, noise.CipherChaChaPoly, noise.HashSHA256), Pattern: noise.HandshakeIK, Initiator: true, StaticKeypair: client, PeerStatic: e.static.Public, Prologue: noisePrologueFor(noiseBinding{SessionID: "session", PodUID: "pod-uid"}, channel)})
	if err != nil {
		t.Fatal(err)
	}
	hello, _, _, err := hs.WriteMessage(nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = writeFrameToConn(conn, &sync.Mutex{}, 2, hello, true, true); err != nil {
		t.Fatal(err)
	}
	_, op, response, err := readFrameLimit(reader, noiseMaxCiphertext)
	if err != nil || op != 2 || len(response) != 48 {
		t.Fatalf("Noise handshake: %d %d %v", op, len(response), err)
	}
	_, send, recv, err := hs.ReadMessage(nil, response)
	if err != nil {
		t.Fatal(err)
	}
	return conn, reader, send, recv
}

func TestViewerHandoffClosesAuthenticatedNoiseTransports(t *testing.T) {
	t.Setenv("MVD_EMULATOR_OFF", "1")
	g := activeHandoff(t)
	e, err := newNoiseEndpoint()
	if err != nil {
		t.Fatal(err)
	}
	// No external SDK is consulted by the synthetic binding.
	sdk := httptest.NewServer(http.NotFoundHandler())
	defer sdk.Close()
	e.sdkURL = sdk.URL
	e.handoff = g
	client, err := noise.DH25519.GenerateKeypair(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	e.setBinding(noiseBinding{SessionID: "session", ClientKey: client.Public, PodUID: "pod-uid"})
	vnc, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer vnc.Close()
	upstreamClosed := make(chan struct{})
	go func() {
		defer close(upstreamClosed)
		c, err := vnc.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		_, _ = io.WriteString(c, "synthetic-rfb")
		_, _ = io.Copy(io.Discard, c)
	}()
	srv := httptest.NewServer(noVNCMux(t.TempDir(), vnc.Addr().String(), "127.0.0.1:1", readyGate{}, e))
	defer srv.Close()
	control, controlReader, _, controlRecv := openNoiseForHandoff(t, srv.URL, "control", e, client)
	_, op, ciphertext, err := readFrameLimit(controlReader, noiseMaxCiphertext)
	if err != nil || op != 2 {
		t.Fatal("encrypted control not active", err)
	}
	plain, err := controlRecv.Decrypt(nil, nil, ciphertext)
	if err != nil || !strings.Contains(string(plain), `"geometry"`) {
		t.Fatal("control did not authenticate", err)
	}
	rfb, rfbReader, _, rfbRecv := openNoiseForHandoff(t, srv.URL, "rfb", e, client)
	_, op, ciphertext, err = readFrameLimit(rfbReader, noiseMaxCiphertext)
	if err != nil || op != 2 {
		t.Fatal("encrypted RFB not active", err)
	}
	plain, err = rfbRecv.Decrypt(nil, nil, ciphertext)
	if err != nil || string(plain) != "synthetic-rfb" {
		t.Fatal("RFB did not authenticate", err)
	}
	g.observe(handoffMetadata("session", "pod-uid"))
	if g.snapshot().State != "revoked" {
		t.Fatal(g.snapshot())
	}
	for _, pair := range []struct {
		conn   net.Conn
		reader *bufio.Reader
	}{{control, controlReader}, {rfb, rfbReader}} {
		_ = pair.conn.SetReadDeadline(time.Now().Add(time.Second))
		for {
			_, _, _, err = readFrameLimit(pair.reader, noiseMaxCiphertext)
			if err != nil {
				break
			}
		}
		if nerr, ok := err.(net.Error); ok && nerr.Timeout() {
			t.Fatal("authenticated socket survived handoff")
		}
	}
	select {
	case <-upstreamClosed:
	case <-time.After(time.Second):
		t.Fatal("RFB forwarding did not drain")
	}
	for _, path := range []string{"/e2e/rfb", "/e2e/control"} {
		r, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		r.Body.Close()
		if r.StatusCode != 403 {
			t.Fatal("Noise reconnect admitted", r.StatusCode)
		}
	}
}

func TestViewerHandoffPublisherWriterIsJoined(t *testing.T) {
	g := activeHandoff(t)
	hub := newKbdHub()
	srv := httptest.NewServer(g.guard(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hub.serve(w, r, readyGate{}) }), false))
	defer srv.Close()
	conn, err := net.Dial("tcp", strings.TrimPrefix(srv.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_, err = fmt.Fprintf(conn, "GET /kbd?role=pub HTTP/1.1\r\nHost: test\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGVzdC13cy1rZXk=\r\nOrigin: chrome-extension://test-extension\r\n\r\n")
	if err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(conn)
	r, err := http.ReadResponse(reader, nil)
	if err != nil || r.StatusCode != 101 {
		t.Fatalf("publisher upgrade: %v %+v", err, r)
	}
	deadline := time.Now().Add(time.Second)
	var publisher *kbdClient
	for publisher == nil && time.Now().Before(deadline) {
		hub.mu.Lock()
		for c := range hub.clients {
			publisher = c
		}
		hub.mu.Unlock()
		if publisher == nil {
			time.Sleep(time.Millisecond)
		}
	}
	if publisher == nil {
		t.Fatal("publisher missing")
	}
	for range 128 {
		publisher.enqueueCtl([]byte(`{"selectChoice":{"key":"synthetic","index":1}}`))
	}
	g.revoke(true)
	if g.snapshot().State != "revoked" {
		t.Fatal(g.snapshot())
	}
	hub.mu.Lock()
	remaining := len(hub.clients)
	hub.mu.Unlock()
	if remaining != 0 {
		t.Fatal("publisher handler survived ACK")
	}
	publisher.mailMu.Lock()
	pending := len(publisher.pendingCtl)
	publisher.mailMu.Unlock()
	if pending != 0 {
		t.Fatal("publisher control queue retained after ACK")
	}
}

func TestViewerHandoffFreezesEmulatorWithoutDetaching(t *testing.T) {
	t.Setenv("MVD_EMULATOR_OFF", "0")
	g := activeHandoff(t)
	var commands, discoveries atomic.Int32
	connected := make(chan net.Conn, 1)
	closed := make(chan struct{})
	var socketWrite sync.Mutex
	var browser *httptest.Server
	browser = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/json/version" {
			discoveries.Add(1)
			_ = json.NewEncoder(w).Encode(map[string]string{"webSocketDebuggerUrl": "ws" + strings.TrimPrefix(browser.URL, "http") + "/devtools/browser/synthetic"})
			return
		}
		conn, rw, err := w.(http.Hijacker).Hijack()
		if err != nil {
			return
		}
		defer close(closed)
		defer conn.Close()
		_, _ = fmt.Fprintf(rw, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n", websocketAccept(r.Header.Get("Sec-WebSocket-Key")))
		_ = rw.Flush()
		connected <- conn
		for {
			_, opcode, payload, err := readFrame(rw.Reader)
			if err != nil {
				return
			}
			if opcode != 1 {
				continue
			}
			var cmd struct {
				ID     int    `json:"id"`
				Method string `json:"method"`
			}
			if json.Unmarshal(payload, &cmd) != nil {
				continue
			}
			commands.Add(1)
			result := map[string]any{}
			if cmd.Method == "Target.getTargets" {
				result["targetInfos"] = []any{}
			}
			response, _ := json.Marshal(map[string]any{"id": cmd.ID, "result": result})
			if writeFrameToConn(conn, &socketWrite, 1, response, false, true) != nil {
				return
			}
		}
	}))
	defer browser.Close()
	em := newEmulator(strings.TrimPrefix(browser.URL, "http://"), g)
	var conn net.Conn
	select {
	case conn = <-connected:
	case <-time.After(time.Second):
		t.Fatal("emulator did not connect")
	}
	defer conn.Close()
	deadline := time.Now().Add(time.Second)
	for commands.Load() < 2 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if commands.Load() < 2 {
		t.Fatal("emulator did not initialize")
	}
	g.revoke(true)
	if g.snapshot().State != "revoked" {
		t.Fatal(g.snapshot())
	}
	before := commands.Load()
	// These events normally trigger attach/emulation/window commands. After
	// handoff the existing owner stays connected but all event handling freezes.
	for _, event := range []string{
		`{"method":"Target.targetCreated","params":{"targetInfo":{"targetId":"new-page","type":"page","url":"https://synthetic.invalid/"}}}`,
		`{"method":"Target.attachedToTarget","params":{"sessionId":"new-session","targetInfo":{"targetId":"new-page","type":"page","url":"https://synthetic.invalid/"}}}`,
		`{"method":"Page.frameNavigated","sessionId":"new-session","params":{"frame":{"id":"main","url":"https://synthetic.invalid/"}}}`,
	} {
		if err := writeFrameToConn(conn, &socketWrite, 1, []byte(event), false, true); err != nil {
			t.Fatal("preserved owner detached", err)
		}
	}
	if em.enqueueCmd(cdpCmd{method: "Target.closeTarget"}) {
		t.Fatal("frozen emulator accepted command")
	}
	time.Sleep(30 * time.Millisecond)
	select {
	case <-closed:
		t.Fatal("emulation-owning CDP connection was closed")
	default:
	}
	if commands.Load() != before {
		t.Fatal("emulator forwarded command after acknowledgment")
	}
	_ = conn.Close()
	<-closed
	time.Sleep(30 * time.Millisecond)
	if discoveries.Load() != 1 {
		t.Fatal("frozen emulator reconnected")
	}
}

type handoffObservedConn struct {
	net.Conn
	onClose func()
}

func (c *handoffObservedConn) Close() error {
	err := c.Conn.Close()
	c.onClose()
	return err
}

func handoffBridgePair(t *testing.T, g *viewerHandoff, wrap func(net.Conn) net.Conn) (*cdpBridge, net.Conn, net.Conn, <-chan struct{}, <-chan struct{}) {
	t.Helper()
	viewer, client := net.Pipe()
	upstream, browser := net.Pipe()
	ownerClosed := make(chan struct{})
	observed := &handoffObservedConn{Conn: upstream, onClose: sync.OnceFunc(func() { close(ownerClosed) })}
	var owner net.Conn = observed
	if wrap != nil {
		owner = wrap(owner)
	}
	b := &cdpBridge{handoff: g, client: client, clientReader: bufio.NewReader(client), upstream: owner, upstreamReader: bufio.NewReader(owner), restricted: true, allowed: allowedCDPCommands()}
	if !g.begin() {
		t.Fatal("bridge not admitted")
	}
	done := make(chan struct{})
	go func() { defer close(done); defer g.end(); b.run() }()
	t.Cleanup(func() {
		viewer.Close()
		browser.Close()
		select {
		case <-ownerClosed:
		case <-time.After(time.Second):
			t.Error("CDP owner failed to close after browser EOF")
		}
	})
	return b, viewer, browser, done, ownerClosed
}

func TestViewerHandoffRetainsRestrictedCDPOwnerAndRejectsBufferedFrames(t *testing.T) {
	g := activeHandoff(t)
	b, viewer, browser, done, ownerClosed := handoffBridgePair(t, g, nil)
	g.revoke(true)
	<-done
	if g.snapshot().State != "revoked" || !b.retained.Load() {
		t.Fatal("restricted owner not retained", g.snapshot())
	}
	if _, err := viewer.Read(make([]byte, 1)); err == nil {
		t.Fatal("viewer connection survived")
	}
	select {
	case <-ownerClosed:
		t.Fatal("handoff detached restricted CDP owner")
	default:
	}
	if err := b.forwardClientFrame(1, []byte(`{"id":3,"method":"Input.insertText","params":{"text":"synthetic"}}`), true); !errors.Is(err, errViewerRevoked) {
		t.Fatal("buffered input passed final gate", err)
	}
	_ = browser.SetDeadline(time.Now().Add(time.Second))
	// The retained owner drains existing responses without sending anything to
	// the viewer. The only upstream write permitted is a websocket-level pong.
	if err := writeFrameToConn(browser, &sync.Mutex{}, 1, []byte(`{"method":"Page.frameNavigated","params":{}}`), false, true); err != nil {
		t.Fatal("retained reader not draining", err)
	}
	if err := writeFrameToConn(browser, &sync.Mutex{}, 9, []byte("transport-ping"), false, true); err != nil {
		t.Fatal(err)
	}
	_, opcode, payload, err := readFrame(bufio.NewReader(browser))
	if err != nil || opcode != 10 || string(payload) != "transport-ping" {
		t.Fatalf("inert owner emitted unexpected frame: opcode=%d payload=%q err=%v", opcode, payload, err)
	}
}

func TestViewerHandoffNormalRestrictedDisconnectClosesOwner(t *testing.T) {
	g := activeHandoff(t)
	b, viewer, _, done, ownerClosed := handoffBridgePair(t, g, nil)
	_ = viewer.Close()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("ordinary disconnect did not finish")
	}
	select {
	case <-ownerClosed:
	case <-time.After(time.Second):
		t.Fatal("ordinary disconnect leaked CDP owner")
	}
	if b.retained.Load() {
		t.Fatal("ordinary disconnect retained owner")
	}
	g.revoke(true)
	if g.snapshot().State != "revoked" {
		t.Fatal("earlier normal disconnect poisoned handoff")
	}
}

type handoffPartialWriteConn struct {
	net.Conn
	entered chan struct{}
	release chan struct{}
	once    sync.Once
}

func (c *handoffPartialWriteConn) Write(p []byte) (int, error) {
	c.once.Do(func() { close(c.entered) })
	<-c.release
	return min(1, len(p)), io.ErrUnexpectedEOF
}

func TestViewerHandoffPartialRestrictedFrameCannotAcknowledge(t *testing.T) {
	g := activeHandoff(t)
	entered, release := make(chan struct{}), make(chan struct{})
	_, viewer, _, done, ownerClosed := handoffBridgePair(t, g, func(conn net.Conn) net.Conn {
		return &handoffPartialWriteConn{Conn: conn, entered: entered, release: release}
	})
	writeDone := make(chan struct{})
	go func() {
		defer close(writeDone)
		_ = writeFrameToConn(viewer, &sync.Mutex{}, 1, []byte(`{"id":1,"method":"Input.insertText","params":{"text":"synthetic"}}`), true, true)
	}()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("frame write did not enter")
	}
	revoked := make(chan struct{})
	go func() { g.revoke(true); close(revoked) }()
	awaitHandoffState(t, g, "revoking")
	close(release)
	<-writeDone
	<-done
	<-revoked
	if g.snapshot().State != "unconfirmed" {
		t.Fatal("partial websocket write produced successful ACK", g.snapshot())
	}
	select {
	case <-ownerClosed:
	case <-time.After(time.Second):
		t.Fatal("corrupt CDP stream was retained")
	}
}

func TestViewerHandoffNormalWriteFailureDoesNotPoisonLaterHandoff(t *testing.T) {
	g := activeHandoff(t)
	entered, release := make(chan struct{}), make(chan struct{})
	close(release)
	b, viewer, _, done, _ := handoffBridgePair(t, g, func(conn net.Conn) net.Conn {
		return &handoffPartialWriteConn{Conn: conn, entered: entered, release: release}
	})
	_ = writeFrameToConn(viewer, &sync.Mutex{}, 1, []byte(`{"id":1,"method":"Input.insertText"}`), true, true)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("normal failed connection did not close")
	}
	if b.retained.Load() {
		t.Fatal("failed normal connection retained")
	}
	g.revoke(true)
	if g.snapshot().State != "revoked" {
		t.Fatal("historical closed connection poisoned handoff", g.snapshot())
	}
}

func TestViewerHandoffRestrictedDisconnectCutoffRace(t *testing.T) {
	for range 30 {
		g := activeHandoff(t)
		b, viewer, browser, done, ownerClosed := handoffBridgePair(t, g, nil)
		start := make(chan struct{})
		var racers sync.WaitGroup
		racers.Go(func() { <-start; _ = viewer.Close() })
		racers.Go(func() { <-start; g.revoke(true) })
		close(start)
		racers.Wait()
		<-done
		if g.snapshot().State != "revoked" {
			t.Fatal("clean disconnect/cutoff race failed", g.snapshot())
		}
		if b.retained.Load() {
			select {
			case <-ownerClosed:
				t.Fatal("cutoff-selected owner detached")
			default:
			}
		} else {
			select {
			case <-ownerClosed:
			case <-time.After(time.Second):
				t.Fatal("normal disconnect-selected owner leaked")
			}
		}
		_ = browser.Close()
	}
}
