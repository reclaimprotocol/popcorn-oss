package main

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"testing"
	"time"

	"github.com/flynn/noise"
)

func TestNoiseIKTransportAndBinding(t *testing.T) {
	e, err := newNoiseEndpoint()
	if err != nil {
		t.Fatal(err)
	}
	client, err := noise.DH25519.GenerateKeypair(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	e.setBinding(noiseBinding{SessionID: "s-1", ClientKey: client.Public, PodUID: "pod-1"})
	b, err := e.validateBinding()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(b.ClientKey, client.Public) {
		t.Fatal("binding key changed")
	}

	cs := noise.NewCipherSuite(noise.DH25519, noise.CipherChaChaPoly, noise.HashSHA256)
	initiator, err := noise.NewHandshakeState(noise.Config{
		CipherSuite: cs, Pattern: noise.HandshakeIK, Initiator: true,
		StaticKeypair: client, PeerStatic: e.static.Public,
		Prologue: noisePrologueFor(b, "rfb"),
	})
	if err != nil {
		t.Fatal(err)
	}
	responder, err := noise.NewHandshakeState(noise.Config{
		CipherSuite: cs, Pattern: noise.HandshakeIK, Initiator: false,
		StaticKeypair: e.static, Prologue: noisePrologueFor(b, "rfb"),
	})
	if err != nil {
		t.Fatal(err)
	}
	hello, _, _, err := initiator.WriteMessage(nil, nil)
	if err != nil || len(hello) != 96 {
		t.Fatalf("IK hello: %d bytes, %v", len(hello), err)
	}
	if _, _, _, err = responder.ReadMessage(nil, hello); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(responder.PeerStatic(), client.Public) {
		t.Fatal("responder did not authenticate client static key")
	}
	response, rw, rr, err := responder.WriteMessage(nil, nil)
	if err != nil || len(response) != 48 {
		t.Fatalf("IK response: %d bytes, %v", len(response), err)
	}
	_, iw, ir, err := initiator.ReadMessage(nil, response)
	if err != nil {
		t.Fatal(err)
	}

	plain := bytes.Repeat([]byte{'x'}, noiseMaxPlaintext)
	ciphertext, err := iw.Encrypt(nil, nil, plain)
	if err != nil || len(ciphertext) != noiseMaxCiphertext {
		t.Fatalf("encrypt max frame: %d, %v", len(ciphertext), err)
	}
	decoded, err := rw.Decrypt(nil, nil, ciphertext)
	if err != nil || !bytes.Equal(decoded, plain) {
		t.Fatalf("decrypt max frame: %v", err)
	}
	var outbound bytes.Buffer
	writeConn := &deadlineCountingConn{Conn: &nopConn{w: &outbound}}
	secureWriter := &noiseCipherConn{conn: writeConn, send: rr}
	if _, err = secureWriter.Write([]byte("server direction")); err != nil {
		t.Fatal(err)
	}
	if writeConn.readDeadlineCalls != 1 {
		t.Fatalf("write refreshed read deadline %d times", writeConn.readDeadlineCalls)
	}

	inboundCiphertext, err := iw.Encrypt(nil, nil, []byte("client direction"))
	if err != nil {
		t.Fatal(err)
	}
	var inbound bytes.Buffer
	if err = writeFrameToConn(&nopConn{w: &inbound}, &sync.Mutex{}, 2, inboundCiphertext, false, true); err != nil {
		t.Fatal(err)
	}
	readConn := &deadlineCountingConn{Conn: &nopConn{w: &bytes.Buffer{}}}
	secureReader := &noiseCipherConn{conn: readConn, reader: bufio.NewReader(&inbound), recv: rw}
	readPlaintext := make([]byte, 32)
	n, err := secureReader.Read(readPlaintext)
	if err != nil || string(readPlaintext[:n]) != "client direction" {
		t.Fatalf("read encrypted frame: %q %v", readPlaintext[:n], err)
	}
	if readConn.readDeadlineCalls != 1 {
		t.Fatalf("read refreshed deadline %d times", readConn.readDeadlineCalls)
	}
	_ = ir // initiator read state is exercised by the response handshake above.
}

type deadlineCountingConn struct {
	net.Conn
	readDeadlineCalls int
}

func (c *deadlineCountingConn) SetReadDeadline(_ time.Time) error {
	c.readDeadlineCalls++
	return nil
}

func TestNoiseBindingFailsClosed(t *testing.T) {
	e, err := newNoiseEndpoint()
	if err != nil {
		t.Fatal(err)
	}
	if _, err = e.validateBinding(); err != errNoiseNotBound {
		t.Fatalf("missing binding error = %v", err)
	}
	client, _ := noise.DH25519.GenerateKeypair(rand.Reader)
	e.setBinding(noiseBinding{SessionID: "s", ClientKey: client.Public, PodUID: "pod"})
	if _, err = e.validateBinding(); err != nil {
		t.Fatal(err)
	}
	e.setBinding(noiseBinding{SessionID: "s", ClientKey: client.Public})
	if _, err = e.validateBinding(); err != errNoiseNotBound {
		t.Fatalf("missing pod uid error = %v", err)
	}
}

func TestNoiseFirstConnectionEnrollsExactlyOneClientKey(t *testing.T) {
	e, err := newNoiseEndpoint()
	if err != nil {
		t.Fatal(err)
	}
	secret := bytes.Repeat([]byte{0x42}, 32)
	digest := sha256.Sum256(secret)
	binding := noiseBinding{SessionID: "s", BindingSecretHash: digest[:], PodUID: "pod"}
	e.setBinding(binding)
	if _, err = e.validateBinding(); err != nil {
		t.Fatal(err)
	}
	client, _ := noise.DH25519.GenerateKeypair(rand.Reader)
	other, _ := noise.DH25519.GenerateKeypair(rand.Reader)
	if e.acceptPeer(binding, client.Public, bytes.Repeat([]byte{0x41}, 32)) {
		t.Fatal("accepted an invalid enrollment secret")
	}
	if !e.acceptPeer(binding, client.Public, secret) {
		t.Fatal("rejected a valid enrollment secret")
	}
	if !e.acceptPeer(binding, client.Public, nil) {
		t.Fatal("rejected the enrolled client key")
	}
	if e.acceptPeer(binding, other.Public, secret) {
		t.Fatal("rebound an enrolled session to a different client")
	}
}

func TestNoiseEnrollmentPersistsClientKeyAndConsumesSecret(t *testing.T) {
	client, _ := noise.DH25519.GenerateKeypair(rand.Reader)
	secret := bytes.Repeat([]byte{0x42}, 32)
	digest := sha256.Sum256(secret)
	annotations := map[string]string{
		"popcorn.dev/session-id":              "durable-session",
		"popcorn.dev/e2e-version":             "1",
		"popcorn.dev/e2e-binding-secret-hash": encodePublicKey(digest[:]),
	}
	var annotationMu sync.Mutex
	sdk := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		annotationMu.Lock()
		defer annotationMu.Unlock()
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/gameserver":
			copyAnnotations := make(map[string]string, len(annotations))
			for key, value := range annotations {
				copyAnnotations[key] = value
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"object_meta": map[string]any{"uid": "gameserver-uid", "annotations": copyAnnotations}})
		case r.Method == http.MethodPut && r.URL.Path == "/metadata/annotation":
			var body struct {
				Key   string `json:"key"`
				Value string `json:"value"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			annotations["agones.dev/sdk-"+body.Key] = body.Value
			w.WriteHeader(http.StatusOK)
		default:
			http.NotFound(w, r)
		}
	}))
	defer sdk.Close()

	e, err := newNoiseEndpoint()
	if err != nil {
		t.Fatal(err)
	}
	e.sdkURL = sdk.URL
	e.kubernetes = true
	binding := noiseBinding{SessionID: "durable-session", BindingSecretHash: digest[:], PodUID: "pod-uid"}
	e.setBinding(binding)
	if !e.acceptPeer(binding, client.Public, secret) {
		t.Fatal("valid enrollment failed")
	}

	annotationMu.Lock()
	gotKey := annotations["agones.dev/sdk-e2e-client-public-key"]
	gotConsumed := annotations["agones.dev/sdk-e2e-binding-consumed"]
	annotationMu.Unlock()
	if gotKey != encodePublicKey(client.Public) || gotConsumed != "1" {
		t.Fatalf("durable enrollment annotations: key=%q consumed=%q", gotKey, gotConsumed)
	}

	restarted, err := newNoiseEndpoint()
	if err != nil {
		t.Fatal(err)
	}
	restarted.sdkURL = sdk.URL
	restarted.kubernetes = true
	restarted.setBinding(noiseBinding{PodUID: "pod-uid"})
	reloaded, err := restarted.validateBinding()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(reloaded.ClientKey, client.Public) || len(reloaded.BindingSecretHash) != 0 {
		t.Fatalf("reloaded binding: %+v", reloaded)
	}
}

func TestE2EAllocationClosesExistingPlaintextConnections(t *testing.T) {
	e, err := newNoiseEndpoint()
	if err != nil {
		t.Fatal(err)
	}
	proxy, gateway := net.Pipe()
	defer gateway.Close()
	release := e.trackPlaintextConn(proxy)
	defer release()
	if err := gateway.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}

	secretHash := bytes.Repeat([]byte{0x23}, 32)
	e.setBinding(noiseBinding{SessionID: "encrypted-session", BindingSecretHash: secretHash, PodUID: "pod-uid"})
	if _, err := gateway.Read(make([]byte, 1)); err == nil {
		t.Fatal("plaintext connection survived E2E allocation")
	}
}

func TestNoiseAgonesMetadataPublicationAndBinding(t *testing.T) {
	client, err := noise.DH25519.GenerateKeypair(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	annotations := make(map[string]string)
	var annotationMu sync.Mutex
	sdk := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/gameserver":
			_ = json.NewEncoder(w).Encode(map[string]any{"object_meta": map[string]any{
				"uid": "sdk-gameserver-uid",
				"annotations": map[string]string{
					"popcorn.dev/session-id":            "sdk-session",
					"popcorn.dev/e2e-client-public-key": encodePublicKey(client.Public),
				},
			}})
		case r.Method == http.MethodPut && r.URL.Path == "/metadata/annotation":
			var body struct {
				Key   string `json:"key"`
				Value string `json:"value"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Errorf("decode annotation: %v", err)
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			annotationMu.Lock()
			annotations[body.Key] = body.Value
			annotationMu.Unlock()
			w.WriteHeader(http.StatusOK)
		default:
			http.NotFound(w, r)
		}
	}))
	defer sdk.Close()

	e, err := newNoiseEndpoint()
	if err != nil {
		t.Fatal(err)
	}
	e.sdkURL = sdk.URL
	e.bindingFile = ""
	e.setBinding(noiseBinding{PodUID: "kubernetes-pod-uid"})
	binding, err := e.validateBinding()
	if err != nil {
		t.Fatal(err)
	}
	if binding.SessionID != "sdk-session" || binding.PodUID != "kubernetes-pod-uid" || !bytes.Equal(binding.ClientKey, client.Public) {
		t.Fatalf("unexpected SDK binding: %+v", binding)
	}
	if err := e.publishPublicKey(); err != nil {
		t.Fatal(err)
	}
	annotationMu.Lock()
	defer annotationMu.Unlock()
	if annotations["e2e-public-key"] != e.publicKeyString() || annotations["e2e-version"] != "1" {
		t.Fatalf("unexpected published annotations: %#v", annotations)
	}
}

func TestNoisePublicKeysRequireCanonicalBase64URL(t *testing.T) {
	raw := bytes.Repeat([]byte{0xff}, 32)
	canonical := encodePublicKey(raw)
	if got := decodePublicKey(canonical); !bytes.Equal(got, raw) {
		t.Fatal("canonical key rejected")
	}
	for _, invalid := range []string{canonical + "=", base64.RawStdEncoding.EncodeToString(raw), canonical[:42]} {
		if got := decodePublicKey(invalid); got != nil {
			t.Fatalf("non-canonical key accepted: %q", invalid)
		}
	}
}

func TestNoiseControlWebSocketRoundTrip(t *testing.T) {
	e, err := newNoiseEndpoint()
	if err != nil {
		t.Fatal(err)
	}
	client, err := noise.DH25519.GenerateKeypair(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	e.setBinding(noiseBinding{SessionID: "ws-session", ClientKey: client.Public, PodUID: "pod-uid"})
	hub := newKbdHub()
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		serveNoiseControlSession(e, w, r, readyGate{}, hub, nil, newRtstatsStore(func(string, ...interface{}) {}), nil)
	})
	// The production handler only needs ResponseWriter/Request; wrapping it in
	// httptest gives the endpoint a real hijackable TCP connection.
	ts := httptest.NewServer(h)
	defer ts.Close()
	u, _ := url.Parse(ts.URL)
	conn, err := net.Dial("tcp", u.Host)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	key := "dGVzdC13cy1rZXk="
	if _, err = fmt.Fprintf(conn, "GET /e2e/control?sessionId=attacker-controlled HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: %s\r\n\r\n", u.Host, key); err != nil {
		t.Fatal(err)
	}
	rd := bufio.NewReader(conn)
	resp, err := http.ReadResponse(rd, nil)
	if err != nil || resp.StatusCode != 101 {
		t.Fatalf("upgrade: %v status=%v", err, resp.StatusCode)
	}
	cs := noise.NewCipherSuite(noise.DH25519, noise.CipherChaChaPoly, noise.HashSHA256)
	hs, _ := noise.NewHandshakeState(noise.Config{CipherSuite: cs, Pattern: noise.HandshakeIK, Initiator: true, StaticKeypair: client, PeerStatic: e.static.Public, Prologue: noisePrologueFor(noiseBinding{SessionID: "ws-session", PodUID: "pod-uid"}, "control")})
	hello, _, _, _ := hs.WriteMessage(nil, nil)
	var mu sync.Mutex
	if err = writeFrameToConn(conn, &mu, 2, hello, true, true); err != nil {
		t.Fatal(err)
	}
	_, op, response, err := readFrameLimit(rd, noiseMaxCiphertext)
	if err != nil || op != 2 || len(response) != 48 {
		t.Fatalf("handshake response: op=%d len=%d err=%v", op, len(response), err)
	}
	_, iw, ir, err := hs.ReadMessage(nil, response)
	if err != nil {
		t.Fatal(err)
	}
	_, op, geometryCiphertext, err := readFrameLimit(rd, noiseMaxCiphertext)
	if err != nil || op != 2 {
		t.Fatalf("geometry: %v", err)
	}
	if bytes.Contains(geometryCiphertext, []byte(`"geometry"`)) {
		t.Fatal("gateway-visible geometry frame contains plaintext")
	}
	var gm struct {
		Type string `json:"type"`
	}
	geometry, err := ir.Decrypt(nil, nil, geometryCiphertext)
	if err != nil || json.Unmarshal(geometry, &gm) != nil || gm.Type != "geometry" {
		t.Fatalf("geometry record: %s", geometry)
	}
	helloPlaintext := []byte(`{"type":"hello","payload":{}}`)
	msg, _ := iw.Encrypt(nil, nil, helloPlaintext)
	if bytes.Contains(msg, helloPlaintext) {
		t.Fatal("gateway-visible control frame contains plaintext")
	}
	if err = writeFrameToConn(conn, &mu, 2, msg, true, true); err != nil {
		t.Fatal(err)
	}
	_, op, reply, err := readFrameLimit(rd, noiseMaxCiphertext)
	if err != nil || op != 2 {
		t.Fatalf("reply: op=%d err=%v", op, err)
	}
	decoded, err := ir.Decrypt(nil, nil, reply)
	if err != nil || !bytes.Contains(decoded, []byte(`"type":"signal"`)) {
		t.Fatalf("decrypt reply: %q %v", decoded, err)
	}
}

func TestE2EControlHubFanoutAndResync(t *testing.T) {
	h := newKbdHub()
	c := &e2eControlClient{out: make(chan []byte, 16), done: make(chan struct{})}
	h.addE2E(c)
	defer h.removeE2E(c)
	if got := len(c.out); got != 1 {
		t.Fatalf("initial geometry records = %d", got)
	}
	h.publish(nil, []byte(`{"editable":true}`))
	h.broadcastDialog([]byte(`{"dialog":{"open":true}}`), true)
	h.broadcastPopup([]byte(`{"popup":{"open":true}}`), true)
	want := map[string]bool{"geometry": false, "signal": false, "dialog": false, "popup": false}
	for len(c.out) > 0 {
		var m struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal(<-c.out, &m); err == nil {
			want[m.Type] = true
		}
	}
	for typ, ok := range want {
		if !ok {
			t.Errorf("missing outbound %s", typ)
		}
	}
}

func TestE2EControlPingRoundTrip(t *testing.T) {
	c := &e2eControlClient{out: make(chan []byte, 1), done: make(chan struct{})}
	if err := c.handle([]byte(`{"type":"ping","payload":{"id":42}}`)); err != nil {
		t.Fatal(err)
	}
	var got struct {
		Type    string `json:"type"`
		Payload struct {
			ID uint64 `json:"id"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(<-c.out, &got); err != nil {
		t.Fatal(err)
	}
	if got.Type != "pong" || got.Payload.ID != 42 {
		t.Fatalf("unexpected pong: %#v", got)
	}
}

// A pinch is a sustained move stream, and under e2e one queue carries BOTH acks
// and field state. Acking every move fills it, and an overflow closes the only
// channel keyboard and touch have.
func TestInputAckOnlyOnTerminalEvents(t *testing.T) {
	for _, ev := range []string{"end", "cancel", "click"} {
		if !inputAckWanted("sid", 7, ev) {
			t.Errorf("%q must be acked: one terminal ack proves the gesture path", ev)
		}
	}
	for _, ev := range []string{"start", "move"} {
		if inputAckWanted("sid", 7, ev) {
			t.Errorf("%q must be silent: a gesture sends many, and they share the state queue", ev)
		}
	}
	// No diagnostic identity, nothing to correlate an ack with.
	if inputAckWanted("", 7, "end") || inputAckWanted("sid", 0, "end") {
		t.Error("acked an event with no session/gesture id")
	}
}

func TestDiagnosticEnqueueDropsInsteadOfClosingTheChannel(t *testing.T) {
	c := &e2eControlClient{out: make(chan []byte, 2), done: make(chan struct{})}
	for i := 0; i < 20; i++ {
		c.enqueueE2EDiagnostic("input-ack", mustJSON(map[string]any{"event": "end"}))
	}
	select {
	case <-c.done:
		t.Fatal("a droppable diagnostic closed the session's only control channel")
	default:
	}
	// State still owns the channel: losing it silently would leave the viewer
	// believing a stale field is focused, so an overflow must force a resync.
	c.enqueueE2E("signal", mustJSON(map[string]any{"editable": true}))
	select {
	case <-c.done:
	default:
		t.Fatal("state overflow no longer closes the channel for resync")
	}
}

// A gesture is a sustained stream. Under e2e it shares one queue with keyboard
// state, so a burst of moves must cost that queue nothing at all.
func TestTouchFloodQueuesNothing(t *testing.T) {
	em := &emulator{cmds: make(chan cdpCmd, 256), prio: make(chan cdpCmd, 256)}
	c := &e2eControlClient{em: em, out: make(chan []byte, 2), done: make(chan struct{})}
	for i := 0; i < 200; i++ {
		payload := mustJSON(map[string]any{"t": "move", "sid": "sid", "gesture": 1,
			"points": []map[string]any{{"x": i, "y": i, "id": 1}}})
		if err := c.handle(mustJSON(map[string]any{"type": "touch", "payload": json.RawMessage(payload)})); err != nil {
			t.Fatalf("touch move rejected: %v", err)
		}
	}
	select {
	case <-c.done:
		t.Fatal("a touch burst closed the channel that carries the keyboard")
	default:
	}
	if len(c.out) != 0 {
		t.Fatalf("touch moves queued %d control frames; the viewer reads none of them", len(c.out))
	}
}
