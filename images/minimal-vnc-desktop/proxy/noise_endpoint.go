package main

// LiveView's E2EE transport.  The gateway is deliberately not involved in
// this code: it only forwards WebSocket bytes.  The pod authenticates the
// client's static key against the allocation binding before it accepts any
// application data.

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/flynn/noise"
)

const (
	noiseProtocolName     = "Noise_IK_25519_ChaChaPoly_SHA256"
	noisePrologue         = "popcorn-liveview/v1"
	noiseMaxPlaintext     = 65519 // 65535-byte WS payload minus the 16-byte Poly1305 tag.
	noiseMaxCiphertext    = noiseMaxPlaintext + 16
	noiseHandshakeTimeout = 10 * time.Second
)

var (
	errNoiseNotBound = errors.New("liveview e2ee allocation binding is not available")
	errNoiseMismatch = errors.New("liveview e2ee allocation binding does not match")
)

type noiseBinding struct {
	SessionID         string
	ClientKey         []byte
	BindingSecretHash []byte
	PodUID            string
}

// noiseEndpoint owns one pod static key for its entire process lifetime.  It
// is never serialized and is not included in GameServer metadata.
type noiseEndpoint struct {
	static         noise.DHKey
	public         []byte
	mu             sync.RWMutex
	binding        noiseBinding
	plaintextConns map[net.Conn]struct{}
	kubernetes     bool
	// bindingFile is useful for local development and for runtimes that mount an
	// allocation result. In Kubernetes the SDK GameServer metadata is preferred.
	bindingFile string
	uid         string
	sdkURL      string
}

func newNoiseEndpoint() (*noiseEndpoint, error) {
	key, err := noise.DH25519.GenerateKeypair(rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("generate liveview e2ee pod key: %w", err)
	}
	e := &noiseEndpoint{
		static: key, public: append([]byte(nil), key.Public...),
		plaintextConns: make(map[net.Conn]struct{}),
		bindingFile:    strings.TrimSpace(os.Getenv("LIVEVIEW_E2E_BINDING_FILE")),
		uid:            strings.TrimSpace(os.Getenv("POD_UID")),
		sdkURL:         "http://" + envDefault("AGONES_SDK_HOST", "127.0.0.1") + ":" + envDefault("AGONES_SDK_HTTP_PORT", "9358"),
		kubernetes:     strings.TrimSpace(os.Getenv("KUBERNETES_SERVICE_HOST")) != "" && strings.TrimSpace(os.Getenv("POD_NAME")) != "",
	}
	// An explicit binding in the environment is primarily for one-process pod
	// tests. It is also a safe fallback when the allocator injects env values.
	e.binding = noiseBinding{
		SessionID:         strings.TrimSpace(os.Getenv("LIVEVIEW_E2E_SESSION_ID")),
		ClientKey:         decodePublicKey(os.Getenv("LIVEVIEW_E2E_CLIENT_PUBLIC_KEY")),
		BindingSecretHash: decodePublicKey(os.Getenv("LIVEVIEW_E2E_BINDING_SECRET_HASH")),
		PodUID:            e.uid,
	}
	return e, nil
}

func decodePublicKey(value string) []byte {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	b, err := base64.RawURLEncoding.DecodeString(value)
	if err == nil && len(b) == 32 && base64.RawURLEncoding.EncodeToString(b) == value {
		return b
	}
	return nil
}

func encodePublicKey(key []byte) string { return base64.RawURLEncoding.EncodeToString(key) }

// publicKey is the only key material exposed to callers.  The private key is
// intentionally not returned by any status/metadata helper.
func (e *noiseEndpoint) publicKey() []byte { return append([]byte(nil), e.public...) }

func (e *noiseEndpoint) publicKeyString() string { return encodePublicKey(e.public) }

// loadBinding accepts allocator-provided JSON without trusting a bearer token.
// Accepted names intentionally include the old liveview prefix so rolling
// allocator/proxy deployments can overlap safely.
func (e *noiseEndpoint) loadBinding() noiseBinding {
	e.mu.RLock()
	b := noiseBinding{SessionID: e.binding.SessionID, ClientKey: append([]byte(nil), e.binding.ClientKey...), BindingSecretHash: append([]byte(nil), e.binding.BindingSecretHash...), PodUID: e.binding.PodUID}
	e.mu.RUnlock()
	if e.bindingFile == "" {
		// Continue below: in Agones the allocator binding arrives as a
		// GameServer annotation and is read through the local SDK.
	}
	if e.bindingFile != "" {
		if data, err := os.ReadFile(e.bindingFile); err == nil {
			var v struct {
				SessionID         string `json:"sessionId"`
				ClientPublicKey   string `json:"clientPublicKey"`
				BindingSecretHash string `json:"bindingSecretHash"`
				PodUID            string `json:"podUid"`
			}
			if json.Unmarshal(data, &v) == nil {
				if strings.TrimSpace(v.SessionID) != "" {
					b.SessionID = strings.TrimSpace(v.SessionID)
				}
				if k := decodePublicKey(v.ClientPublicKey); k != nil {
					b.ClientKey = k
				}
				if h := decodePublicKey(v.BindingSecretHash); h != nil {
					b.BindingSecretHash = h
				}
				if strings.TrimSpace(v.PodUID) != "" {
					b.PodUID = strings.TrimSpace(v.PodUID)
				}
			}
		}
	}
	if gs, err := e.gameServer(); err == nil {
		b = e.bindingFromGameServer(b, gs)
	}
	return b
}

func (e *noiseEndpoint) bindingFromGameServer(b noiseBinding, gs agonesGameServer) noiseBinding {
	if value := strings.TrimSpace(gs.ObjectMeta.Annotations["popcorn.dev/session-id"]); value != "" {
		b.SessionID = value
	}
	if value := decodePublicKey(gs.ObjectMeta.Annotations["popcorn.dev/e2e-client-public-key"]); value != nil {
		b.ClientKey = value
	}
	if value := decodePublicKey(gs.ObjectMeta.Annotations["popcorn.dev/e2e-binding-secret-hash"]); value != nil {
		b.BindingSecretHash = value
	}
	if strings.TrimSpace(gs.ObjectMeta.Annotations["agones.dev/sdk-e2e-binding-consumed"]) == "1" {
		if value := decodePublicKey(gs.ObjectMeta.Annotations["agones.dev/sdk-e2e-client-public-key"]); value != nil {
			b.ClientKey = value
			b.BindingSecretHash = nil
		}
	}
	// The control plane authenticates the Kubernetes Pod UID in the Noise
	// prologue. Agones returns the GameServer object's different UID here, so
	// use it only outside Kubernetes when POD_UID was not injected.
	if value := strings.TrimSpace(gs.ObjectMeta.UID); b.PodUID == "" && value != "" {
		b.PodUID = value
	}
	return b
}

type agonesGameServer struct {
	ObjectMeta struct {
		UID         string            `json:"uid"`
		Annotations map[string]string `json:"annotations"`
	} `json:"object_meta"`
}

func (e *noiseEndpoint) gameServer() (agonesGameServer, error) {
	var gs agonesGameServer
	client := &http.Client{Timeout: 750 * time.Millisecond}
	resp, err := client.Get(strings.TrimRight(e.sdkURL, "/") + "/gameserver")
	if err != nil {
		return gs, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return gs, fmt.Errorf("agones gameserver: %s", resp.Status)
	}
	err = json.NewDecoder(resp.Body).Decode(&gs)
	return gs, err
}

func (e *noiseEndpoint) publishPublicKey() error {
	if err := e.publishAnnotation("e2e-public-key", e.publicKeyString()); err != nil {
		return err
	}
	return e.publishAnnotation("e2e-version", "1")
}

func (e *noiseEndpoint) publishAnnotation(key, value string) error {
	body := []byte(`{"key":"` + key + `","value":"` + value + `"}`)
	req, err := http.NewRequest(http.MethodPut, strings.TrimRight(e.sdkURL, "/")+"/metadata/annotation", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := (&http.Client{Timeout: 2 * time.Second}).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("agones annotation %s: %s", key, resp.Status)
	}
	return nil
}

func bindingRequiresE2E(binding noiseBinding) bool {
	return binding.SessionID != "" && (len(binding.ClientKey) == 32 || len(binding.BindingSecretHash) == 32)
}

func (e *noiseEndpoint) setBinding(binding noiseBinding) {
	e.mu.Lock()
	e.binding = noiseBinding{SessionID: strings.TrimSpace(binding.SessionID), ClientKey: append([]byte(nil), binding.ClientKey...), BindingSecretHash: append([]byte(nil), binding.BindingSecretHash...), PodUID: strings.TrimSpace(binding.PodUID)}
	var stale []net.Conn
	if bindingRequiresE2E(e.binding) {
		stale = make([]net.Conn, 0, len(e.plaintextConns))
		for conn := range e.plaintextConns {
			stale = append(stale, conn)
			delete(e.plaintextConns, conn)
		}
	}
	e.mu.Unlock()
	for _, conn := range stale {
		_ = conn.Close()
	}
}

func (e *noiseEndpoint) trackPlaintextConn(conn net.Conn) func() {
	e.mu.Lock()
	if bindingRequiresE2E(e.binding) {
		e.mu.Unlock()
		_ = conn.Close()
		return func() {}
	}
	e.plaintextConns[conn] = struct{}{}
	e.mu.Unlock()
	return func() {
		e.mu.Lock()
		delete(e.plaintextConns, conn)
		e.mu.Unlock()
	}
}

// watchAllocationBinding observes the allocation metadata before a route is
// published. It closes any plaintext WebSocket opened against the idle pool pod
// as soon as Agones assigns that pod to an encrypted session.
func (e *noiseEndpoint) watchAllocationBinding() {
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	for {
		gs, err := e.gameServer()
		if err == nil {
			annotations := gs.ObjectMeta.Annotations
			if strings.TrimSpace(annotations["popcorn.dev/session-id"]) != "" {
				if strings.TrimSpace(annotations["popcorn.dev/e2e-version"]) != "1" {
					return
				}
				e.mu.RLock()
				base := noiseBinding{SessionID: e.binding.SessionID, ClientKey: append([]byte(nil), e.binding.ClientKey...), BindingSecretHash: append([]byte(nil), e.binding.BindingSecretHash...), PodUID: e.binding.PodUID}
				e.mu.RUnlock()
				binding := e.bindingFromGameServer(base, gs)
				if bindingRequiresE2E(binding) {
					e.setBinding(binding)
					return
				}
			}
		}
		<-ticker.C
	}
}

// requiresE2E answers whether this allocation has been bound to the encrypted
// transport. A positive result is copied into process memory and is therefore
// sticky: a transient Agones SDK failure can never reopen plaintext access
// after this process has observed an E2E binding.
func (e *noiseEndpoint) requiresE2E() bool {
	if e == nil {
		return false
	}
	e.mu.RLock()
	bound := bindingRequiresE2E(e.binding)
	e.mu.RUnlock()
	if bound {
		return true
	}
	b := e.loadBinding()
	if b.SessionID == "" || (len(b.ClientKey) != 32 && len(b.BindingSecretHash) != 32) {
		return false
	}
	e.setBinding(b)
	return true
}

func (e *noiseEndpoint) validateBinding() (noiseBinding, error) {
	b := e.loadBinding()
	if (len(b.ClientKey) != 32 && len(b.BindingSecretHash) != 32) || b.SessionID == "" || b.PodUID == "" {
		return noiseBinding{}, errNoiseNotBound
	}
	return b, nil
}

// acceptPeer atomically enrolls the first client static key. The enrollment
// secret travels only as the encrypted IK payload; the gateway sees neither
// the secret nor the client key. Once enrolled, possession of the matching
// static private key is sufficient for every channel and reconnect.
func (e *noiseEndpoint) acceptPeer(b noiseBinding, peerStatic, enrollmentSecret []byte) bool {
	if len(peerStatic) != 32 {
		return false
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if len(e.binding.ClientKey) == 32 {
		if !bytes.Equal(e.binding.ClientKey, peerStatic) {
			return false
		}
		if len(e.binding.BindingSecretHash) == 32 && !e.persistEnrolledPeer(peerStatic) {
			return false
		}
		e.binding.BindingSecretHash = nil
		return true
	}
	if len(b.ClientKey) == 32 {
		if !bytes.Equal(b.ClientKey, peerStatic) {
			return false
		}
		if len(b.BindingSecretHash) == 32 && !e.persistEnrolledPeer(peerStatic) {
			return false
		}
		b.BindingSecretHash = nil
		e.binding = b
		return true
	}
	if len(b.BindingSecretHash) != 32 || len(enrollmentSecret) != 32 {
		return false
	}
	digest := sha256.Sum256(enrollmentSecret)
	if subtle.ConstantTimeCompare(digest[:], b.BindingSecretHash) != 1 {
		return false
	}
	if !e.persistEnrolledPeer(peerStatic) {
		return false
	}
	b.ClientKey = append([]byte(nil), peerStatic...)
	// The secret is needed only for enrollment. Parallel handshakes that have
	// already decrypted it are accepted only when they carry this same key.
	b.BindingSecretHash = nil
	e.binding = b
	return true
}

func (e *noiseEndpoint) persistEnrolledPeer(peerStatic []byte) bool {
	if !e.kubernetes {
		return true
	}
	if err := e.publishAnnotation("e2e-client-public-key", encodePublicKey(peerStatic)); err != nil {
		log.Printf("liveview e2ee client-key publication failed: %v", err)
		return false
	}
	if err := e.publishAnnotation("e2e-binding-consumed", "1"); err != nil {
		log.Printf("liveview e2ee enrollment-secret consumption failed: %v", err)
		return false
	}
	return true
}

func noisePrologueFor(b noiseBinding, channel string) []byte {
	return []byte(noisePrologue + "\x00" + b.SessionID + "\x00" + b.PodUID + "\x00" + channel)
}

// serve terminates the standard Noise IK handshake. The session ID and both
// static keys come exclusively from allocator/pod state, never gateway input.
func (e *noiseEndpoint) serve(w http.ResponseWriter, r *http.Request, channel string, handler func(net.Conn, *bufio.Reader, *sync.Mutex, *noise.CipherState, *noise.CipherState)) {
	if !isWebsocketRequest(r) {
		http.Error(w, "websocket upgrade required", http.StatusBadRequest)
		return
	}
	b, err := e.validateBinding()
	if err != nil {
		http.Error(w, err.Error(), http.StatusServiceUnavailable)
		return
	}
	key := strings.TrimSpace(r.Header.Get("Sec-WebSocket-Key"))
	if key == "" {
		http.Error(w, "missing Sec-WebSocket-Key", http.StatusBadRequest)
		return
	}
	hj, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "hijacking unsupported", http.StatusInternalServerError)
		return
	}
	conn, rw, err := hj.Hijack()
	if err != nil {
		return
	}
	defer conn.Close()
	if _, err = fmt.Fprintf(rw, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n", websocketAccept(key)); err != nil || rw.Flush() != nil {
		return
	}
	_ = conn.SetReadDeadline(time.Now().Add(noiseHandshakeTimeout))
	firstFin, opcode, hello, err := readFrameLimit(rw.Reader, noiseMaxCiphertext)
	// Pre-bound IK uses an empty payload (96 bytes). First-connect enrollment
	// carries a raw 32-byte secret in that encrypted payload (128 bytes).
	if err != nil || !firstFin || opcode != 2 || (len(hello) != 96 && len(hello) != 128) {
		return
	}
	hs, hsErr := noise.NewHandshakeState(noise.Config{CipherSuite: noise.NewCipherSuite(noise.DH25519, noise.CipherChaChaPoly, noise.HashSHA256), Pattern: noise.HandshakeIK, Initiator: false, StaticKeypair: e.static, Prologue: noisePrologueFor(b, channel)})
	if hsErr != nil {
		return
	}
	payload, _, _, hsErr := hs.ReadMessage(nil, hello)
	if hsErr != nil || !e.acceptPeer(b, hs.PeerStatic(), payload) {
		return
	}
	response, r0, r1, hsErr := hs.WriteMessage(nil, nil)
	if hsErr != nil || len(response) != 48 {
		return
	}
	var writeMu sync.Mutex
	if err = writeFrameToConn(conn, &writeMu, 2, response, false, true); err != nil {
		return
	}
	_ = conn.SetReadDeadline(time.Now().Add(wsClientReadDeadline))
	stopPings := make(chan struct{})
	go sendNoiseWebSocketPings(conn, &writeMu, stopPings)
	handler(conn, rw.Reader, &writeMu, r1, r0)
	close(stopPings)
}

func sendNoiseWebSocketPings(conn net.Conn, writeMu *sync.Mutex, stop <-chan struct{}) {
	ticker := time.NewTicker(wsPingInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			if err := writeFrameToConn(conn, writeMu, 9, nil, false, true); err != nil {
				_ = conn.Close()
				return
			}
		case <-stop:
			return
		}
	}
}

// noiseCipherConn adapts a Noise transport to an existing VNC TCP bridge.
type noiseCipherConn struct {
	conn       net.Conn
	reader     *bufio.Reader
	send, recv *noise.CipherState
	mu         sync.Mutex
	sharedMu   *sync.Mutex
	cipherMu   sync.Mutex
	pending    []byte
}

func (c *noiseCipherConn) frameWriteMutex() *sync.Mutex {
	if c.sharedMu != nil {
		return c.sharedMu
	}
	return &c.mu
}

func (c *noiseCipherConn) Read(p []byte) (int, error) {
	if len(c.pending) != 0 {
		n := copy(p, c.pending)
		c.pending = c.pending[n:]
		return n, nil
	}
	for {
		fin, op, b, err := readFrameLimit(c.reader, noiseMaxCiphertext)
		if err != nil {
			return 0, err
		}
		_ = c.conn.SetReadDeadline(time.Now().Add(wsClientReadDeadline))
		if op == 9 {
			_ = writeFrameToConn(c.conn, c.frameWriteMutex(), 10, b, false, true)
			continue
		}
		if op == 10 {
			continue
		}
		if op == 8 {
			return 0, io.EOF
		}
		if op != 2 {
			return 0, errors.New("liveview e2ee: unexpected websocket opcode")
		}
		if !fin {
			return 0, errors.New("liveview e2ee: fragmented transport record")
		}
		plain, err := c.recv.Decrypt(nil, nil, b)
		if err != nil {
			return 0, err
		}
		if len(plain) > noiseMaxPlaintext {
			return 0, errNoiseMismatch
		}
		if len(plain) == 0 {
			continue
		}
		n := copy(p, plain)
		if n < len(plain) {
			c.pending = append(c.pending[:0], plain[n:]...)
		}
		return n, nil
	}
}
func (c *noiseCipherConn) Write(p []byte) (int, error) {
	c.cipherMu.Lock()
	defer c.cipherMu.Unlock()
	if len(p) > noiseMaxPlaintext {
		return 0, errFrameTooLarge
	}
	enc, err := c.send.Encrypt(nil, nil, p)
	if err != nil {
		return 0, err
	}
	if err = writeFrameToConn(c.conn, c.frameWriteMutex(), 2, enc, false, true); err != nil {
		return 0, err
	}
	_ = c.conn.SetReadDeadline(time.Now().Add(wsClientReadDeadline))
	return len(p), nil
}
func (c *noiseCipherConn) Close() error                       { return c.conn.Close() }
func (c *noiseCipherConn) LocalAddr() net.Addr                { return c.conn.LocalAddr() }
func (c *noiseCipherConn) RemoteAddr() net.Addr               { return c.conn.RemoteAddr() }
func (c *noiseCipherConn) SetDeadline(t time.Time) error      { return c.conn.SetDeadline(t) }
func (c *noiseCipherConn) SetReadDeadline(t time.Time) error  { return c.conn.SetReadDeadline(t) }
func (c *noiseCipherConn) SetWriteDeadline(t time.Time) error { return c.conn.SetWriteDeadline(t) }

func serveNoiseRFB(e *noiseEndpoint, w http.ResponseWriter, r *http.Request, upstream string, ready readyGate, keeper *screenKeeper) {
	if !ready.ready() {
		http.Error(w, "app is not ready", http.StatusServiceUnavailable)
		return
	}
	e.serve(w, r, "rfb", func(conn net.Conn, reader *bufio.Reader, writeMu *sync.Mutex, send, recv *noise.CipherState) {
		if keeper != nil {
			keeper.connect(false)
			defer keeper.disconnect()
		}
		vnc, err := net.DialTimeout("tcp", upstream, 5*time.Second)
		if err != nil {
			return
		}
		defer vnc.Close()
		secure := &noiseCipherConn{conn: conn, reader: reader, sharedMu: writeMu, send: send, recv: recv}
		done := make(chan struct{}, 2)
		go func() { _, _ = io.Copy(vnc, secure); done <- struct{}{} }()
		go func() { _, _ = io.Copy(secure, vnc); done <- struct{}{} }()
		<-done
		_ = conn.Close()
	})
}

type e2eControlClient struct {
	secure   *noiseCipherConn
	hub      *kbdHub
	em       *emulator
	rtstats  *rtstatsStore
	onViewer func([]byte)
	out      chan []byte
	done     chan struct{}
}

func (c *e2eControlClient) enqueueE2E(kind string, payload []byte) {
	c.enqueue(kind, payload, false)
}

// enqueueE2EDiagnostic sends something the session can lose. This channel is the
// only path for keyboard state and touch under e2e, so an overflowing diagnostic
// is dropped rather than allowed to close it.
func (c *e2eControlClient) enqueueE2EDiagnostic(kind string, payload []byte) {
	c.enqueue(kind, payload, true)
}

func (c *e2eControlClient) enqueue(kind string, payload []byte, droppable bool) {
	msg := struct {
		Type    string          `json:"type"`
		Payload json.RawMessage `json:"payload"`
	}{Type: kind, Payload: append([]byte(nil), payload...)}
	b, err := json.Marshal(msg)
	if err != nil {
		return
	}
	select {
	case <-c.done:
		return
	default:
	}
	select {
	case c.out <- b:
	case <-c.done:
	default:
		if droppable {
			return
		}
		// State must not disappear silently. Closing makes the trusted client
		// reconnect, rerun Noise, and receive the hub snapshot.
		c.close()
	}
}

func (c *e2eControlClient) close() {
	select {
	case <-c.done:
	default:
		close(c.done)
	}
	if c.secure != nil {
		_ = c.secure.Close()
	}
}

func (c *e2eControlClient) run() {
	if !c.hub.addE2E(c) {
		return
	}
	defer c.hub.removeE2E(c)
	defer c.close()
	go func() {
		for {
			select {
			case <-c.done:
				return
			case b := <-c.out:
				if _, err := c.secure.Write(b); err != nil {
					c.close()
					return
				}
			}
		}
	}()
	for {
		buf := make([]byte, noiseMaxPlaintext)
		n, err := c.secure.Read(buf)
		if err != nil {
			return
		}
		if err := c.handle(buf[:n]); err != nil {
			return
		}
	}
}

func (c *e2eControlClient) handle(raw []byte) error {
	var envelope struct {
		Type    string          `json:"type"`
		Payload json.RawMessage `json:"payload"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil || envelope.Type == "" {
		return errors.New("invalid e2e control envelope")
	}
	switch envelope.Type {
	case "dialog-reply":
		var p struct {
			Seq          uint64 `json:"seq"`
			Accept       bool   `json:"accept"`
			Text         string `json:"text"`
			Bridge       bool   `json:"bridge"`
			Fedcm        bool   `json:"fedcm"`
			AccountIndex int    `json:"accountIndex"`
		}
		if json.Unmarshal(envelope.Payload, &p) != nil {
			return errors.New("invalid dialog reply")
		}
		b, _ := json.Marshal(map[string]any{"dialogReply": p})
		if c.onViewer != nil {
			c.onViewer(b)
		}
	case "popup-close":
		var p struct {
			Seq uint64 `json:"seq"`
		}
		if json.Unmarshal(envelope.Payload, &p) != nil {
			return errors.New("invalid popup close")
		}
		b, _ := json.Marshal(map[string]any{"popupClose": p})
		if c.onViewer != nil {
			c.onViewer(b)
		}
	case "mirror":
		var p struct {
			On bool `json:"on"`
		}
		if json.Unmarshal(envelope.Payload, &p) != nil {
			return errors.New("invalid mirror request")
		}
		c.hub.setE2EMirror(c, p.On)
	case "touch":
		var p struct {
			T       string       `json:"t"`
			Points  []touchPoint `json:"points"`
			SID     string       `json:"sid"`
			Gesture uint64       `json:"gesture"`
		}
		if json.Unmarshal(envelope.Payload, &p) != nil {
			return errors.New("invalid touch request")
		}
		ev := map[string]string{"start": "touchStart", "move": "touchMove", "end": "touchEnd", "cancel": "touchCancel", "click": "click"}[p.T]
		if ev == "" {
			return errors.New("invalid touch type")
		}
		// Same gate as the plaintext /input handler (inputAckWanted): one terminal
		// ack per gesture, never one per move.
		ack := func(state string) {
			if !inputAckWanted(p.SID, p.Gesture, p.T) {
				return
			}
			c.enqueueE2EDiagnostic("input-ack", mustJSON(map[string]any{"sid": p.SID, "gesture": p.Gesture, "event": p.T, "state": state}))
		}
		ok := false
		if ev == "click" && len(p.Points) == 1 {
			ok = c.em.dispatchCompatClickWithDone(p.Points[0], func(done bool) { ack(ackState(done)) })
		} else {
			ok = c.em.dispatchTouchWithDone(ev, p.Points, func(done bool) { ack(ackState(done)) })
		}
		if !ok {
			ack("rejected")
		}
	case "emulate":
		var p emulateRequest
		if json.Unmarshal(envelope.Payload, &p) != nil {
			return errors.New("invalid emulate request")
		}
		c.em.set(p)
		requestWindowFit(log.Printf)
	case "hello":
		var p struct {
			Mirror bool `json:"mirror"`
		}
		if json.Unmarshal(envelope.Payload, &p) == nil {
			c.hub.setE2EMirror(c, p.Mirror)
		}
	case "ping":
		var p struct {
			ID uint64 `json:"id"`
		}
		if json.Unmarshal(envelope.Payload, &p) != nil {
			return errors.New("invalid ping")
		}
		// Preserve the existing viewer's RTT probe over the encrypted control
		// channel. Echo only the opaque sequence number; timestamps stay local.
		c.enqueueE2E("pong", mustJSON(p))
		return nil
	case "diag", "rtt":
		if envelope.Type == "diag" {
			if !ingestKlog(envelope.Payload) {
				return errors.New("invalid diag payload")
			}
		} else if _, ok := ingestRTStats(c.rtstats, envelope.Payload); !ok {
			return errors.New("invalid rtt payload")
		}
	default:
		return errors.New("unsupported e2e control type")
	}
	// The viewer parses this bare acknowledgement and discards it (see
	// liveview-transport.js: "Command acknowledgements are not keyboard state").
	// Nothing reads it, so the high-rate kinds skip it rather than spend one
	// encrypted frame per touch move, and the rest stays droppable.
	switch envelope.Type {
	case "touch", "diag", "rtt":
		return nil
	}
	c.enqueueE2EDiagnostic("signal", mustJSON(map[string]string{"ack": envelope.Type}))
	return nil
}

func mustJSON(v any) []byte { b, _ := json.Marshal(v); return b }
func ackState(ok bool) string {
	if ok {
		return "written"
	}
	return "not-written"
}

func serveNoiseControlSession(e *noiseEndpoint, w http.ResponseWriter, r *http.Request, ready readyGate, hub *kbdHub, em *emulator, rtstats *rtstatsStore, onViewer func([]byte)) {
	if !ready.ready() {
		http.Error(w, "app is not ready", http.StatusServiceUnavailable)
		return
	}
	e.serve(w, r, "control", func(conn net.Conn, reader *bufio.Reader, writeMu *sync.Mutex, send, recv *noise.CipherState) {
		c := &e2eControlClient{secure: &noiseCipherConn{conn: conn, reader: reader, sharedMu: writeMu, send: send, recv: recv}, hub: hub, em: em, rtstats: rtstats, onViewer: onViewer, out: make(chan []byte, 32), done: make(chan struct{})}
		c.run()
	})
}
