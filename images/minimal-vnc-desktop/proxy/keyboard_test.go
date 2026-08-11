package main

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

// newTestClient wires a kbdClient to one end of an in-memory pipe and starts
// its writer goroutine, returning a reader over the other end.
func newTestClient() (*kbdClient, *bufio.Reader, net.Conn) {
	serverEnd, clientEnd := net.Pipe()
	c := &kbdClient{
		conn:   serverEnd,
		notify: make(chan struct{}, 1),
		closed: make(chan struct{}),
	}
	go c.writeLoop()
	return c, bufio.NewReader(clientEnd), clientEnd
}

// readText reads frames until a text frame arrives (skipping pings) and returns
// its payload, or fails if nothing arrives before the deadline.
func readText(t *testing.T, r *bufio.Reader, peer net.Conn) string {
	t.Helper()
	_ = peer.SetReadDeadline(time.Now().Add(2 * time.Second))
	for {
		_, opcode, payload, err := readFrame(r)
		if err != nil {
			t.Fatalf("readFrame: %v", err)
		}
		if opcode == 0x1 {
			return string(payload)
		}
	}
}

func TestKbdHubFanOutExcludesSender(t *testing.T) {
	hub := newKbdHub()

	sender, _, sConn := newTestClient()
	receiver, rReader, rConn := newTestClient()
	defer sConn.Close()
	defer rConn.Close()
	hub.add(sender)
	hub.add(receiver)

	hub.publish(sender, []byte(`{"editable":true}`))

	if got := readText(t, rReader, rConn); got != `{"editable":true}` {
		t.Fatalf("receiver got %q", got)
	}

	// The sender must NOT receive its own signal echoed back.
	_ = sConn.SetReadDeadline(time.Now().Add(150 * time.Millisecond))
	if _, _, _, err := readFrame(bufio.NewReader(sConn)); err == nil {
		t.Fatal("sender unexpectedly received an echoed frame")
	}
}

func TestKbdHubResyncsLateJoiner(t *testing.T) {
	hub := newKbdHub()

	// The state producer is the extension publisher (?role=pub). Resync of a late
	// viewer is only live WHILE a publisher is connected.
	first, _, fConn := newTestClient()
	first.publisher = true
	defer fConn.Close()
	hub.add(first)
	hub.publish(first, []byte(`{"editable":true}`))

	// A viewer that connects AFTER the signal must be resynced from cache — this
	// is what prevents a reconnect on a flaky network from wedging the keyboard.
	late, lReader, lConn := newTestClient()
	defer lConn.Close()
	hub.add(late)

	if got := readText(t, lReader, lConn); got != `{"editable":true}` {
		t.Fatalf("late joiner resync got %q", got)
	}
}

func TestKbdHubNoResyncWhenPublisherGone(t *testing.T) {
	hub := newKbdHub()

	// A publisher connects, publishes editable:true, then disconnects (MV3 worker
	// torn down / tab closed) leaving the cached state stale.
	pub, _, pConn := newTestClient()
	pub.publisher = true
	hub.add(pub)
	hub.publish(pub, []byte(`{"editable":true}`))
	hub.remove(pub)
	pConn.Close()

	// A viewer that joins now must NOT be resynced to the stale editable:true —
	// with no live publisher to ever dismiss it, replaying it would wedge the
	// keyboard up. It should receive nothing (start keyboard-down).
	late, lReader, lConn := newTestClient()
	defer lConn.Close()
	hub.add(late)

	_ = lConn.SetReadDeadline(time.Now().Add(200 * time.Millisecond))
	if _, _, _, err := readFrame(lReader); err == nil {
		t.Fatal("late joiner was resynced to stale state with no live publisher")
	}
}

func TestKbdHubFullCap(t *testing.T) {
	hub := newKbdHub()
	for i := 0; i < kbdMaxClients; i++ {
		hub.add(&kbdClient{notify: make(chan struct{}, 1), closed: make(chan struct{})})
	}
	if !hub.full() {
		t.Fatalf("hub should report full at %d clients", kbdMaxClients)
	}
}

// A non-publisher (a viewer) must not be able to inject signals to others; a
// publisher (the extension, ?role=pub) must.
func TestKbdHubReadLoopPublisherGate(t *testing.T) {
	for _, tc := range []struct {
		name      string
		publisher bool
		relayed   bool
	}{
		{"viewer is ignored", false, false},
		{"publisher relays", true, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			hub := newKbdHub()

			sub, subReader, subConn := newTestClient()
			defer subConn.Close()
			hub.add(sub)

			srvEnd, cliEnd := net.Pipe()
			defer srvEnd.Close()
			defer cliEnd.Close()
			sender := &kbdClient{conn: srvEnd, publisher: tc.publisher, notify: make(chan struct{}, 1), closed: make(chan struct{})}
			go sender.writeLoop()
			hub.add(sender)
			go hub.readLoop(sender, bufio.NewReader(srvEnd))

			var mu sync.Mutex
			go func() { _ = writeFrameToConn(cliEnd, &mu, 0x1, []byte(`{"editable":true}`), true, true) }()

			_ = subConn.SetReadDeadline(time.Now().Add(300 * time.Millisecond))
			_, opcode, payload, err := readFrame(subReader)
			got := err == nil && opcode == 0x1 && string(payload) == `{"editable":true}`
			if got != tc.relayed {
				t.Fatalf("relayed=%v, want %v (err=%v)", got, tc.relayed, err)
			}
		})
	}
}

// The viewer->server gate is an allowlist keyed on the message name, so a new
// viewer message that isn't added to it is silently dropped. That is exactly how
// the popup close button shipped broken the first time: the frame reached the
// hub and went nowhere. Pin every accepted name, and that unknown ones are dropped.
func TestKbdHubViewerMsgAllowlist(t *testing.T) {
	for _, tc := range []struct {
		name     string
		payload  string
		accepted bool
	}{
		{"dialog reply", `{"dialogReply":{"seq":1,"accept":true}}`, true},
		{"popup close", `{"popupClose":{"seq":1}}`, true},
		// Handled by the hub itself (mirror state), so it must NOT reach onViewerMsg.
		{"mirror opt-in", `{"mirror":{"on":true}}`, false},
		{"unknown control frame", `{"somethingElse":{"seq":1}}`, false},
		{"focus signal from a viewer", `{"editable":true}`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			hub := newKbdHub()
			got := make(chan []byte, 1)
			hub.onViewerMsg = func(p []byte) {
				select {
				case got <- p:
				default:
				}
			}

			srvEnd, cliEnd := net.Pipe()
			defer srvEnd.Close()
			defer cliEnd.Close()
			viewer := &kbdClient{conn: srvEnd, notify: make(chan struct{}, 1), closed: make(chan struct{})}
			go viewer.writeLoop()
			hub.add(viewer)
			go hub.readLoop(viewer, bufio.NewReader(srvEnd))

			var mu sync.Mutex
			go func() { _ = writeFrameToConn(cliEnd, &mu, 0x1, []byte(tc.payload), true, true) }()

			select {
			case p := <-got:
				if !tc.accepted {
					t.Fatalf("frame should have been dropped, but reached onViewerMsg: %s", p)
				}
				if string(p) != tc.payload {
					t.Fatalf("payload = %s, want %s", p, tc.payload)
				}
			case <-time.After(300 * time.Millisecond):
				if tc.accepted {
					t.Fatal("frame never reached onViewerMsg")
				}
			}
		})
	}
}

// Field-value mirroring is OFF unless a viewer asks, and the extension keys its
// value publishing off this flag — so a hub that fails to push it either leaks
// field text by default (flag stuck on) or breaks the iOS mirror seed (stuck off).
func TestMirrorStateIsPushedToPublisherOnly(t *testing.T) {
	hub := newKbdHub()

	pub, pubReader, pubConn := newTestClient()
	pub.publisher = true
	defer pubConn.Close()
	hub.add(pub)
	// A publisher is told the current state as soon as it connects (the MV3 worker
	// restarts constantly and defaults to off).
	if got := readText(t, pubReader, pubConn); got != `{"mirror":false}` {
		t.Fatalf("publisher first frame = %q, want the current mirror state", got)
	}

	viewer, viewerReader, viewerConn := newTestClient()
	defer viewerConn.Close()
	hub.add(viewer)

	hub.setMirror(viewer, []byte(`{"mirror":{"on":true}}`))
	if got := readText(t, pubReader, pubConn); got != `{"mirror":true}` {
		t.Fatalf("publisher got %q, want the mirror opt-in", got)
	}
	// Viewers never see the control frame; it is not a relay.
	_ = viewerConn.SetReadDeadline(time.Now().Add(150 * time.Millisecond))
	if _, opcode, payload, err := readFrame(viewerReader); err == nil && opcode == 0x1 {
		t.Fatalf("viewer received a publisher control frame: %s", payload)
	}

	// The last mirror viewer leaving turns the value stream back off.
	hub.remove(viewer)
	if got := readText(t, pubReader, pubConn); got != `{"mirror":false}` {
		t.Fatalf("publisher got %q after the mirror viewer left", got)
	}
}

func TestMirrorStateOnlyPushedOnChange(t *testing.T) {
	hub := newKbdHub()
	pub, pubReader, pubConn := newTestClient()
	pub.publisher = true
	defer pubConn.Close()
	hub.add(pub)
	readText(t, pubReader, pubConn) // the connect-time state

	viewerA, _, connA := newTestClient()
	viewerB, _, connB := newTestClient()
	defer connA.Close()
	defer connB.Close()
	hub.add(viewerA)
	hub.add(viewerB)

	hub.setMirror(viewerA, []byte(`{"mirror":{"on":true}}`))
	if got := readText(t, pubReader, pubConn); got != `{"mirror":true}` {
		t.Fatalf("got %q", got)
	}
	hub.setMirror(viewerB, []byte(`{"mirror":{"on":true}}`))
	// B leaving must NOT turn mirroring off while A still wants it.
	hub.remove(viewerB)
	_ = pubConn.SetReadDeadline(time.Now().Add(200 * time.Millisecond))
	for {
		_, opcode, payload, err := readFrame(pubReader)
		if err != nil {
			break // nothing but (at most) pings arrived — correct
		}
		if opcode == 0x1 {
			t.Fatalf("redundant mirror push: %s", payload)
		}
	}
}

// role=pub is a trust level (fan-out + the dialog-bridge token), so it must not
// be self-assertable. Remote clients are excluded by the loopback gate; the
// remote page — which CAN reach loopback — by the browser-stamped Origin.
func TestPublisherAllowed(t *testing.T) {
	for _, tc := range []struct {
		name   string
		remote string
		origin string
		pinned string
		want   bool
	}{
		{"extension on loopback", "127.0.0.1:51234", "chrome-extension://abc", "", true},
		{"extension on ipv6 loopback", "[::1]:51234", "chrome-extension://abc", "", true},
		{"no origin on loopback", "127.0.0.1:51234", "", "", true},
		{"page on loopback", "127.0.0.1:51234", "https://evil.example", "", false},
		{"opaque origin on loopback", "127.0.0.1:51234", "null", "", false},
		{"remote viewer forging the origin", "10.1.2.3:44444", "chrome-extension://abc", "", false},
		{"remote viewer", "10.1.2.3:44444", "https://app.example", "", false},
		{"pinned origin matches", "127.0.0.1:51234", "chrome-extension://abc", "chrome-extension://abc", true},
		{"pinned origin mismatch", "127.0.0.1:51234", "chrome-extension://xyz", "chrome-extension://abc", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv(kbdPubOriginEnv, tc.pinned)
			r := httptest.NewRequest(http.MethodGet, "/kbd?role=pub", nil)
			r.RemoteAddr = tc.remote
			if tc.origin != "" {
				r.Header.Set("Origin", tc.origin)
			}
			if got := publisherAllowed(r); got != tc.want {
				t.Fatalf("publisherAllowed = %v, want %v", got, tc.want)
			}
		})
	}
}

// A rejected publisher must be refused outright — never downgraded to a viewer,
// which would leave it silently unable to publish and impossible to diagnose.
func TestKbdServeRejectsUnauthenticatedPublisher(t *testing.T) {
	hub := newKbdHub()
	r := httptest.NewRequest(http.MethodGet, "/kbd?role=pub", nil)
	r.RemoteAddr = "10.1.2.3:44444"
	r.Header.Set("Origin", "chrome-extension://abc")
	r.Header.Set("Connection", "Upgrade")
	r.Header.Set("Upgrade", "websocket")
	r.Header.Set("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
	w := httptest.NewRecorder()
	hub.serve(w, r, readyGate{})
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", w.Code, http.StatusForbidden)
	}
	if len(hub.clients) != 0 {
		t.Fatalf("rejected publisher was still added to the hub")
	}
}

// An oversized frame must be DRAINED, not just refused: /kbd, /input and the RFB bridge continue reading
// after one, so a body left in the buffer would desync every following frame on that connection.
func TestReadFrameLimitDrainsAndStaysFramed(t *testing.T) {
	var buf bytes.Buffer
	var mu sync.Mutex
	// An oversized text frame, then a normal one the caller must still be able to read.
	if err := writeFrameToConn(&nopConn{&buf}, &mu, 0x1, bytes.Repeat([]byte("x"), 5000), true, true); err != nil {
		t.Fatalf("write oversized: %v", err)
	}
	if err := writeFrameToConn(&nopConn{&buf}, &mu, 0x1, []byte(`{"editable":true}`), true, true); err != nil {
		t.Fatalf("write normal: %v", err)
	}

	r := bufio.NewReader(&buf)
	if _, _, _, err := readFrameLimit(r, 1024); !errors.Is(err, errFrameTooLarge) {
		t.Fatalf("first frame: err = %v, want errFrameTooLarge", err)
	}
	_, opcode, payload, err := readFrameLimit(r, 1024)
	if err != nil {
		t.Fatalf("second frame after a skip: %v", err)
	}
	if opcode != 0x1 || string(payload) != `{"editable":true}` {
		t.Fatalf("stream desynced: opcode=%x payload=%q", opcode, payload)
	}
}

// nopConn adapts a buffer to net.Conn so writeFrameToConn can build test frames.
type nopConn struct{ w *bytes.Buffer }

func (c *nopConn) Write(p []byte) (int, error)      { return c.w.Write(p) }
func (c *nopConn) Read([]byte) (int, error)         { return 0, io.EOF }
func (c *nopConn) Close() error                     { return nil }
func (c *nopConn) LocalAddr() net.Addr              { return nil }
func (c *nopConn) RemoteAddr() net.Addr             { return nil }
func (c *nopConn) SetDeadline(time.Time) error      { return nil }
func (c *nopConn) SetReadDeadline(time.Time) error  { return nil }
func (c *nopConn) SetWriteDeadline(time.Time) error { return nil }

// The size cap has to be enforced from the length header: decoding first and
// checking len(payload) afterwards is what let a client force the allocation.
func TestReadFrameLimitRejectsBeforeAllocating(t *testing.T) {
	// Header only: FIN|text, unmasked, 64 KiB claimed, and NO payload follows. A
	// decoder that allocates first would block in io.ReadFull instead of erroring.
	var hdr [4]byte
	hdr[0], hdr[1] = 0x81, 126
	binary.BigEndian.PutUint16(hdr[2:], 65535)
	r := bufio.NewReader(bytes.NewReader(hdr[:]))
	// No body follows, so the drain hits EOF — the point is that it never allocated the claimed 64 KiB.
	if _, _, _, err := readFrameLimit(r, kbdMaxPayload); err == nil {
		t.Fatal("oversized frame was accepted")
	}
	// The same frame is fine under the transport-wide ceiling (it would then block
	// on the missing body), so the rejection is the limit, not a malformed header.
	if _, _, _, err := readFrameLimit(bufio.NewReader(bytes.NewReader(hdr[:])), maxWSFrame); err == nil {
		t.Fatal("expected a short-read error, not a length rejection")
	} else if err == io.ErrUnexpectedEOF || err == io.EOF {
		return
	} else {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestKbdHubCoalescesToLatest(t *testing.T) {
	c, reader, peer := newTestClient()
	defer peer.Close()

	// Two rapid enqueues before the writer drains: the newest wins, the stale
	// intermediate is dropped. Safe because state is absolute/idempotent.
	c.enqueue([]byte("stale"))
	c.enqueue([]byte("fresh"))

	got := readText(t, reader, peer)
	if got != "fresh" && got != "stale" {
		t.Fatalf("unexpected payload %q", got)
	}
	// Whatever drained first, the mailbox must end empty (no duplicate delivery
	// of the coalesced value beyond what was pending).
	if got == "stale" {
		if next := readText(t, reader, peer); next != "fresh" {
			t.Fatalf("expected fresh after stale, got %q", next)
		}
	}
}

// The publisher's control frames (currently the focused document's URL) are for the
// SERVER, not for viewers — a URL routinely carries tokens in its query string. The
// split is "does it look like a focus state", so a page whose placeholder happens to
// contain a keyword can never silence the keyboard by being mistaken for control.
func TestPublisherControlFrameIsNotFannedOut(t *testing.T) {
	for _, tc := range []struct {
		name      string
		payload   string
		toServer  bool
		broadcast bool
	}{
		{"foreground report", `{"foreground":"https://accounts.test/x?token=abc"}`, true, false},
		{"focus state", `{"editable":true,"rects":[]}`, false, true},
		{"focus state mentioning foreground", `{"editable":true,"hints":{"placeholder":"foreground color"}}`, false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			hub := newKbdHub()
			toServer := make(chan []byte, 1)
			hub.onPublisherMsg = func(p []byte) {
				select {
				case toServer <- p:
				default:
				}
			}

			viewer, viewerReader, viewerConn := newTestClient()
			defer viewerConn.Close()
			hub.add(viewer)

			srvEnd, cliEnd := net.Pipe()
			defer srvEnd.Close()
			defer cliEnd.Close()
			pub := &kbdClient{conn: srvEnd, publisher: true, notify: make(chan struct{}, 1), closed: make(chan struct{})}
			go pub.writeLoop()
			hub.add(pub)
			go hub.readLoop(pub, bufio.NewReader(srvEnd))

			var mu sync.Mutex
			go func() { _ = writeFrameToConn(cliEnd, &mu, 0x1, []byte(tc.payload), true, true) }()

			gotServer := false
			select {
			case <-toServer:
				gotServer = true
			case <-time.After(250 * time.Millisecond):
			}
			if gotServer != tc.toServer {
				t.Fatalf("reached the server = %v, want %v", gotServer, tc.toServer)
			}

			_ = viewerConn.SetReadDeadline(time.Now().Add(250 * time.Millisecond))
			gotBroadcast := false
			for {
				_, opcode, payload, err := readFrame(viewerReader)
				if err != nil {
					break
				}
				if opcode == 0x1 {
					if string(payload) != tc.payload {
						t.Fatalf("viewer got an unexpected frame: %s", payload)
					}
					gotBroadcast = true
					break
				}
			}
			if gotBroadcast != tc.broadcast {
				t.Fatalf("fanned out to viewers = %v, want %v", gotBroadcast, tc.broadcast)
			}
		})
	}
}
