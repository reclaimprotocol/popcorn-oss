package main

import (
	"encoding/json"
	"io"
	"log"
	"net"
	"net/http"
	"strings"
)

// klogMaxBody caps a single diagnostic POST. The tunnel is unauthenticated, so
// the endpoint only logs (no state change) and the body is bounded.
const klogMaxBody = 64 << 10 // 64 KiB

// klogPayload is the batched diagnostic envelope the viewer sends. It carries
// STRUCTURAL keyboard events only — event types, states, lengths, flags — never
// field text (the client never puts typed content on this channel).
type klogPayload struct {
	SID   string   `json:"sid"`          // per-page-load id, correlates a session's lines
	UA    string   `json:"ua,omitempty"` // sent once per session
	Lines []string `json:"lines"`
}

// klogHTTPHandler accepts the viewer's keyboard diagnostics and writes them to
// the proxy log, so mobile keyboard issues can be diagnosed from server logs
// instead of on-device screenshots. Lines are sanitized (control chars stripped,
// truncated) to prevent log injection over the public surface.
func klogHTTPHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", "POST")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, klogMaxBody))
		if err != nil || len(body) == 0 {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		ip := klogClientIP(r)
		var p klogPayload
		if err := json.Unmarshal(body, &p); err != nil {
			// Not JSON — still surface it rather than dropping silently.
			if s := klogSanitize(string(body), 2000); s != "" {
				log.Printf("[kbd-client %s] %s", ip, s)
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}
		sid := klogSanitize(p.SID, 24)
		if p.UA != "" {
			log.Printf("[kbd-client ip=%s sid=%s] ua=%s", ip, sid, klogSanitize(p.UA, 300))
		}
		for _, line := range p.Lines {
			s := klogSanitize(line, 500)
			if s == "" {
				continue
			}
			log.Printf("[kbd-client ip=%s sid=%s] %s", ip, sid, s)
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// klogClientIP prefers the cloudflared / proxy forwarding headers, falling back
// to the socket peer. Best-effort; only used to group a device's log lines.
func klogClientIP(r *http.Request) string {
	if v := strings.TrimSpace(r.Header.Get("CF-Connecting-IP")); v != "" {
		return klogSanitize(v, 64)
	}
	if v := strings.TrimSpace(r.Header.Get("X-Forwarded-For")); v != "" {
		if i := strings.IndexByte(v, ','); i >= 0 {
			v = v[:i]
		}
		return klogSanitize(strings.TrimSpace(v), 64)
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return klogSanitize(r.RemoteAddr, 64)
	}
	return klogSanitize(host, 64)
}

// klogSanitize collapses newlines/tabs to spaces, drops other control chars
// (prevents forged log lines), and truncates. Returns a trimmed string.
func klogSanitize(s string, max int) string {
	s = strings.Map(func(r rune) rune {
		switch {
		case r == '\n' || r == '\r' || r == '\t':
			return ' '
		case r < 0x20 || r == 0x7f:
			return -1
		default:
			return r
		}
	}, s)
	s = strings.TrimSpace(s)
	if len(s) > max {
		s = s[:max] + "…"
	}
	return s
}
