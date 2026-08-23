package main

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
)

// klogMaxBody caps a single diagnostic POST. The tunnel is unauthenticated, so
// the endpoint only logs (no state change) and the body is bounded.
const klogMaxBody = 64 << 10 // 64 KiB

// The container/runtime already timestamps stdout/stderr. Keep the diagnostic
// payload compact: every client line begins with its elapsed time, so Go's
// second wall-clock prefix only duplicates information in the log viewer.
var diagLog = log.New(os.Stderr, "", 0)

// klogPayload is the batched diagnostic envelope the viewer sends. It carries
// STRUCTURAL keyboard events only — event types, states, lengths, flags — never
// field text (the client never puts typed content on this channel).
type klogPayload struct {
	SID   string   `json:"sid"` // per-page-load id, correlates a session's lines
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
		if !ingestKlog(body) {
			// This endpoint accepts diagnostics only. Never reflect arbitrary request
			// content into production logs.
			w.WriteHeader(http.StatusNoContent)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func ingestKlog(body []byte) bool {
	var p klogPayload
	if json.Unmarshal(body, &p) != nil {
		return false
	}
	sid := klogSanitize(p.SID, 24)
	for _, line := range p.Lines {
		if s := klogSanitize(line, 500); s != "" {
			diagLog.Printf("[popcorn-diag sid=%s] %s", sid, s)
		}
	}
	return true
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
