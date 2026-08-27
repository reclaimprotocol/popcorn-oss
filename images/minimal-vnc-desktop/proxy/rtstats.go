package main

import (
	"encoding/json"
	"io"
	"net/http"
	"sort"
	"sync"
	"time"
)

// rtstatsMaxBody caps a single RTT telemetry POST. The endpoint is unauthenticated
// (same surface as /kbd), accepts diagnostics only, and mutates no session state,
// so the body is bounded like /klog's.
const rtstatsMaxBody = 64 << 10 // 64 KiB

// rtstatsSample is one viewer-measured tunnel round trip: `at` is an offset in ms
// from the batch anchor (t0), `rtt` the measured round trip in ms.
type rtstatsSample struct {
	At  int64 `json:"at"`
	RTT int64 `json:"rtt"`
}

// rtstatsPayload is the batched envelope the viewer posts (see kbd/rtt-report.js).
// Sid is the gateway path segment (/liveview/<sid>/<token>/...) when present.
type rtstatsPayload struct {
	SID     string          `json:"sid"`
	T0      int64           `json:"t0"`
	Samples []rtstatsSample `json:"samples"`
}

// rtstatsSession accumulates one viewer connection's samples so each batch line
// reports CUMULATIVE link quality (n/avg/p50/p95/max), not just the delta —
// a log tail then shows convergence without re-reducing earlier lines.
type rtstatsSession struct {
	samples []int64 // bounded ring, newest at the end
	firstAt time.Time
	lastAt  time.Time
}

const (
	rtstatsRingCap     = 256 // mirrors the viewer's own ring bound
	rtstatsMaxSessions = 32  // one pod normally serves one session; slack for reloads
	rtstatsIdleExpiry  = 30 * time.Minute
)

// rtstatsStore holds per-viewer aggregates for the life of the pod. Entries are
// expired when idle and the map is capped (oldest update evicted) so a hostile
// or reloading client cannot grow it without bound.
type rtstatsStore struct {
	mu       sync.Mutex
	sessions map[string]*rtstatsSession
	logf     func(format string, args ...interface{})
}

func newRtstatsStore(logf func(format string, args ...interface{})) *rtstatsStore {
	return &rtstatsStore{sessions: make(map[string]*rtstatsSession), logf: logf}
}

func percentileSorted(sorted []int64, pct float64) int64 {
	if len(sorted) == 0 {
		return 0
	}
	idx := int(pct * float64(len(sorted)))
	if idx >= len(sorted) {
		idx = len(sorted) - 1
	}
	if idx < 0 {
		idx = 0
	}
	return sorted[idx]
}

// ingest merges one validated batch and returns cumulative stats for logging.
func (st *rtstatsStore) ingest(sid string, samples []rtstatsSample) (count int, avg, p50, p95, maxv int64) {
	st.mu.Lock()
	defer st.mu.Unlock()

	now := time.Now()
	// Expire idle sessions first so the cap evicts by recency, not insertion order.
	for id, s := range st.sessions {
		if now.Sub(s.lastAt) > rtstatsIdleExpiry {
			delete(st.sessions, id)
		}
	}
	sess := st.sessions[sid]
	if sess == nil {
		if len(st.sessions) >= rtstatsMaxSessions {
			var oldestID string
			var oldest time.Time
			for id, s := range st.sessions {
				if oldestID == "" || s.lastAt.Before(oldest) {
					oldestID, oldest = id, s.lastAt
				}
			}
			delete(st.sessions, oldestID)
		}
		sess = &rtstatsSession{firstAt: now}
		st.sessions[sid] = sess
	}
	sess.lastAt = now

	valid := 0
	for _, s := range samples {
		if s.RTT < 0 || s.RTT >= 20000 || s.At < 0 {
			continue // mirror the client's sanity window; drop garbage quietly
		}
		sess.samples = append(sess.samples, s.RTT)
		valid++
	}
	if len(sess.samples) > rtstatsRingCap {
		drop := len(sess.samples) - rtstatsRingCap
		sess.samples = sess.samples[drop:]
	}
	if valid == 0 && len(sess.samples) == 0 {
		return 0, 0, 0, 0, 0
	}
	return reduceSamples(sess.samples)
}

// reduceSamples computes cumulative stats over one session's ring. Caller holds st.mu.
func reduceSamples(samples []int64) (count int, avg, p50, p95, maxv int64) {
	total := int64(0)
	for _, v := range samples {
		total += v
		if v > maxv {
			maxv = v
		}
	}
	n := len(samples)
	sorted := make([]int64, n)
	copy(sorted, samples)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
	return n, total / int64(n), percentileSorted(sorted, 0.50), percentileSorted(sorted, 0.95), maxv
}

// rtstatsSummary is the read-side wire shape (GET /rtstats?sid=...). Field
// names match the control plane's normalizeViewerRttSummary contract so the
// ttl-controller can forward the body to /sessions/:id/viewer-stats verbatim.
type rtstatsSummary struct {
	SID         string `json:"sid"`
	SampleCount int    `json:"sampleCount"`
	AvgMs       int64  `json:"avgMs"`
	P50Ms       int64  `json:"p50Ms"`
	P95Ms       int64  `json:"p95Ms"`
	MaxMs       int64  `json:"maxMs"`
}

// summary returns the cumulative aggregate for one session id, false when the
// session is unknown or has no valid samples yet.
func (st *rtstatsStore) summary(sid string) (rtstatsSummary, bool) {
	st.mu.Lock()
	defer st.mu.Unlock()
	sess := st.sessions[sid]
	if sess == nil || len(sess.samples) == 0 {
		return rtstatsSummary{}, false
	}
	n, avg, p50, p95, maxv := reduceSamples(sess.samples)
	return rtstatsSummary{SID: sid, SampleCount: n, AvgMs: avg, P50Ms: p50, P95Ms: p95, MaxMs: maxv}, true
}

// rtstatsSanitizeSID normalizes a session id for use as the store key. The key
// keeps the full id (GET lookups match exactly; only the log line shortens it).
func rtstatsSanitizeSID(raw string) string {
	sid := klogSanitize(raw, 64)
	if sid == "" {
		return "anon"
	}
	return sid
}

// rtstatsHTTPHandler accepts the viewer's RTT samples (POST) and logs a
// cumulative per-session summary per batch, so live tunnel quality shows up in
// the proxy log instead of only on the device. GET ?sid= returns the same
// aggregate as JSON for the teardown readers (ttl-controller, pool-manager).
func rtstatsHTTPHandler(store *rtstatsStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			sum, ok := store.summary(rtstatsSanitizeSID(r.URL.Query().Get("sid")))
			if !ok {
				http.Error(w, "unknown sid", http.StatusNotFound)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(sum)
			return
		case http.MethodPost:
		default:
			w.Header().Set("Allow", "GET, POST")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, rtstatsMaxBody))
		if err != nil || len(body) == 0 {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if _, ok := ingestRTStats(store, body); !ok {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func ingestRTStats(store *rtstatsStore, body []byte) (string, bool) {
	var p rtstatsPayload
	if json.Unmarshal(body, &p) != nil || len(p.Samples) == 0 {
		return "", false
	}
	if len(p.Samples) > 128 {
		p.Samples = p.Samples[:128]
	}
	sid := rtstatsSanitizeSID(p.SID)
	n, avg, p50, p95, maxv := store.ingest(sid, p.Samples)
	if n > 0 {
		store.logf("[popcorn-rtt sid=%s] n=%d avg=%dms p50=%dms p95=%dms max=%dms", klogSanitize(sid, 24), n, avg, p50, p95, maxv)
	}
	return sid, true
}
