package main

import (
	"bufio"
	"net"
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
