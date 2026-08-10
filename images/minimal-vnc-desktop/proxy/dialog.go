package main

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"sync"
	"time"
)

// dialogBridge answers alert()/confirm()/prompt() for the extension.
//
// WHY a second path when emulate.go already intercepts dialogs over CDP: CDP's
// Page.javascriptDialogOpening notifies but does NOT suppress Chromium's own
// dialog, so a forwarded dialog is drawn twice — the native one (laid out against
// the real window, so clipped on a narrow emulated viewport) plus the viewer's
// sheet. The only way to accept the native one early is to answer it, and for
// confirm/prompt that means guessing the answer.
//
// Worse, answering alert() immediately makes it return in ~18ms where a human
// takes 1-3s, and `t=now(); alert(x); now()-t` is a real anti-automation probe.
//
// So the extension overrides the three page-level dialog functions instead
// (injected.js), and Chromium never opens a dialog at all: no duplicate, no
// clipping, and the call blocks for exactly as long as the user takes to answer —
// real human timing rather than a simulated delay. The blocking is a SYNCHRONOUS
// XHR from the extension's isolated world to this endpoint, which we hold open
// until a viewer replies.
//
// beforeunload is NOT covered: the browser raises it, not page script, so there
// is nothing to override. It stays on the CDP path in emulate.go.
//
// TOKEN: this endpoint is reachable by the remote page too (it can fetch
// 127.0.0.1:6080 like anything else). Without a gate, a hostile page could make
// the viewer render arbitrary chrome OUTSIDE the page area — a convincing
// "enter your password" sheet that looks like it came from us rather than from
// the site. The token is issued to the extension over its publisher socket and
// lives only in the extension's isolated world, which page script cannot read.
type dialogBridge struct {
	hub   *kbdHub
	token string

	mu      sync.Mutex
	seq     uint64
	waiting map[uint64]chan dialogAnswer
}

type dialogAnswer struct {
	Accept bool   `json:"accept"`
	Text   string `json:"text"`
}

// dialogWait bounds how long a blocked page waits for a viewer. A synchronous
// XHR in a window context cannot set its own timeout (it throws), so the ceiling
// has to live here — otherwise a session with no viewer attached, or one whose
// viewer went away mid-dialog, leaves the page wedged forever with no recovery.
//
// Deliberately SHORT. This was 3 minutes ("a real user reading a dialog is
// slow"), and during bring-up a stuck request froze the renderer for that whole
// window — every subsequent evaluation, including location.href, timed out. A
// frozen page is a worse failure than the clipped dialog this replaces, so the
// ceiling is now sized to bound the damage rather than to indulge a slow reader.
// A user who takes longer gets a dismissed dialog and a live page, and can retry.
const dialogWait = 20 * time.Second

func newDialogBridge(hub *kbdHub) *dialogBridge {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		// A predictable token would defeat the point, so fail closed: with an empty
		// token the handler rejects everything and the extension falls back to the
		// native dialog (clipped, but correct).
		return &dialogBridge{hub: hub, waiting: make(map[uint64]chan dialogAnswer)}
	}
	return &dialogBridge{hub: hub, token: hex.EncodeToString(b), waiting: make(map[uint64]chan dialogAnswer)}
}

// answer resolves a waiting dialog. Reports whether it matched: a reply for a
// dialog that already timed out (or was never ours) is dropped rather than
// applied to whatever is open now — on a slow link a stale tap must not answer a
// dialog the user never saw.
func (b *dialogBridge) answer(seq uint64, accept bool, text string) bool {
	b.mu.Lock()
	ch, ok := b.waiting[seq]
	if ok {
		delete(b.waiting, seq)
	}
	b.mu.Unlock()
	if !ok {
		return false
	}
	// Buffered on create, and removed from the map above, so this never blocks and
	// never double-sends.
	ch <- dialogAnswer{Accept: accept, Text: text}
	return true
}

func (b *dialogBridge) closeSheet() {
	if payload, err := json.Marshal(map[string]any{"dialog": map[string]any{"open": false}}); err == nil {
		b.hub.broadcastDialog(payload, false)
	}
}

func dialogBridgeHandler(b *dialogBridge, ready readyGate) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// The caller is a page in the container's own browser, so this is
		// cross-origin. Kept a SIMPLE request (text/plain, no custom headers) on the
		// client side so no preflight is needed — a preflight would add a round trip
		// to a call that is already blocking the page's main thread.
		w.Header().Set("Access-Control-Allow-Origin", "*")
		if r.Method == http.MethodOptions {
			w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.Method != http.MethodPost {
			http.Error(w, "POST required", http.StatusMethodNotAllowed)
			return
		}
		if !ready.ready() {
			http.Error(w, "not ready", http.StatusServiceUnavailable)
			return
		}
		var req struct {
			Token         string `json:"token"`
			Type          string `json:"type"`
			Message       string `json:"message"`
			DefaultPrompt string `json:"defaultPrompt"`
			URL           string `json:"url"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024)).Decode(&req); err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		// Constant-time, and an empty configured token rejects everything (see
		// newDialogBridge) rather than accepting an empty one.
		if b.token == "" || subtle.ConstantTimeCompare([]byte(req.Token), []byte(b.token)) != 1 {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		switch req.Type {
		case "alert", "confirm", "prompt":
		default:
			http.Error(w, "unsupported dialog type", http.StatusBadRequest)
			return
		}

		ch := make(chan dialogAnswer, 1)
		b.mu.Lock()
		b.seq++
		seq := b.seq
		b.waiting[seq] = ch
		b.mu.Unlock()

		payload, err := json.Marshal(map[string]any{
			"dialog": map[string]any{
				"open": true, "seq": seq, "type": req.Type,
				"message": req.Message, "url": req.URL, "defaultPrompt": req.DefaultPrompt,
				// Every bridge dialog is a real question: the page is genuinely blocked
				// on this HTTP request, so the sheet must be answered (unlike the CDP
				// alert path, which is only a notification).
				"notify": false,
				// Tells the viewer to route its reply here rather than to CDP.
				"bridge": true,
			},
		})
		if err != nil {
			b.mu.Lock()
			delete(b.waiting, seq)
			b.mu.Unlock()
			http.Error(w, "encode failed", http.StatusInternalServerError)
			return
		}
		// Cached for resync: a viewer that reconnects mid-dialog has to learn the
		// page is blocked, or the session looks hung with no way to recover.
		b.hub.broadcastDialog(payload, true)

		var out dialogAnswer
		select {
		case out = <-ch:
		case <-r.Context().Done():
			// The page navigated or the renderer went away — nothing to answer.
			b.mu.Lock()
			delete(b.waiting, seq)
			b.mu.Unlock()
			b.closeSheet()
			return
		case <-time.After(dialogWait):
			b.mu.Lock()
			delete(b.waiting, seq)
			b.mu.Unlock()
			// Dismiss on timeout. For confirm() that is the safe default (false =
			// "don't do the thing"), and it matches what a browser does when a dialog
			// is discarded: the page resumes rather than hanging forever.
			out = dialogAnswer{Accept: false}
		}
		b.closeSheet()

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(out)
	}
}
