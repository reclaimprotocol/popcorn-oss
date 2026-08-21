package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func rtstatsPost(t *testing.T, store *rtstatsStore, payload interface{}) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/rtstats", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	rtstatsHTTPHandler(store)(rec, req)
	return rec
}

func TestRtstatsAcceptsBatchAndReturnsNoContent(t *testing.T) {
	var lines []string
	store := newRtstatsStore(func(f string, args ...interface{}) {
		lines = append(lines, fmt.Sprintf(f, args...))
	})
	rec := rtstatsPost(t, store, rtstatsPayload{
		SID: "browser-42",
		T0:  1000,
		Samples: []rtstatsSample{
			{At: 0, RTT: 40},
			{At: 5000, RTT: 60},
			{At: 11000, RTT: 200},
		},
	})
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusNoContent)
	}
	if len(lines) != 1 {
		t.Fatalf("logged lines = %d, want 1 (%v)", len(lines), lines)
	}
	for _, want := range []string{"sid=browser-42", "n=3", "avg=", "p50=", "p95=", "max=200ms"} {
		if !strings.Contains(lines[0], want) {
			t.Errorf("line %q missing %q", lines[0], want)
		}
	}
}

func TestRtstatsAggregatesCumulativelyAcrossBatches(t *testing.T) {
	var last string
	store := newRtstatsStore(func(f string, args ...interface{}) { last = fmt.Sprintf(f, args...) })
	rtstatsPost(t, store, rtstatsPayload{SID: "s1", Samples: []rtstatsSample{{At: 0, RTT: 50}}})
	rtstatsPost(t, store, rtstatsPayload{SID: "s1", Samples: []rtstatsSample{{At: 0, RTT: 150}}})
	// Cumulative across both batches: n=2, max=150.
	if !strings.Contains(last, "n=2") || !strings.Contains(last, "max=150ms") {
		t.Fatalf("cumulative line = %q, want n=2 max=150ms", last)
	}
}

func TestRtstatsRejectsUnknownMethod(t *testing.T) {
	req := httptest.NewRequest(http.MethodDelete, "/rtstats", nil)
	rec := httptest.NewRecorder()
	rtstatsHTTPHandler(newRtstatsStore(func(string, ...interface{}) {}))(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("DELETE status = %d, want %d", rec.Code, http.StatusMethodNotAllowed)
	}
}

func TestRtstatsGetReturnsCumulativeSummary(t *testing.T) {
	store := newRtstatsStore(func(string, ...interface{}) {})
	// Full-length UUID sid: the store must key by the FULL id so the teardown
	// reader can look it up exactly.
	sid := "0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0"
	rtstatsPost(t, store, rtstatsPayload{SID: sid, Samples: []rtstatsSample{
		{At: 0, RTT: 40}, {At: 5000, RTT: 60}, {At: 11000, RTT: 200},
	}})

	req := httptest.NewRequest(http.MethodGet, "/rtstats?sid="+sid, nil)
	rec := httptest.NewRecorder()
	rtstatsHTTPHandler(store)(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET status = %d, want %d (body %q)", rec.Code, http.StatusOK, rec.Body.String())
	}
	var sum rtstatsSummary
	if err := json.Unmarshal(rec.Body.Bytes(), &sum); err != nil {
		t.Fatalf("unmarshal summary: %v", err)
	}
	if sum.SID != sid || sum.SampleCount != 3 || sum.AvgMs != 100 || sum.MaxMs != 200 {
		t.Fatalf("summary = %+v, want sid=%s n=3 avg=100 max=200", sum, sid)
	}
	if sum.P50Ms == 0 || sum.P95Ms == 0 {
		t.Fatalf("summary percentiles missing: %+v", sum)
	}
}

func TestRtstatsGetUnknownSidReturns404(t *testing.T) {
	store := newRtstatsStore(func(string, ...interface{}) {})
	req := httptest.NewRequest(http.MethodGet, "/rtstats?sid=nope", nil)
	rec := httptest.NewRecorder()
	rtstatsHTTPHandler(store)(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("GET unknown sid status = %d, want %d", rec.Code, http.StatusNotFound)
	}
}

func TestRtstatsDropsGarbageSamplesButKeepsValid(t *testing.T) {
	var last string
	store := newRtstatsStore(func(f string, args ...interface{}) { last = fmt.Sprintf(f, args...) })
	rtstatsPost(t, store, rtstatsPayload{SID: "s2", Samples: []rtstatsSample{
		{At: 0, RTT: -5},     // negative — dropped
		{At: 0, RTT: 999999}, // beyond sanity window — dropped
		{At: -3, RTT: 50},    // negative offset — dropped
		{At: 10, RTT: 70},    // valid
	}})
	if !strings.Contains(last, "n=1") || !strings.Contains(last, "avg=70ms") {
		t.Fatalf("line = %q, want only the one valid sample counted", last)
	}
}

func TestRtstatsSanitizesSidAndHandlesAnon(t *testing.T) {
	var lines []string
	store := newRtstatsStore(func(f string, args ...interface{}) {
		lines = append(lines, fmt.Sprintf(f, args...))
	})
	rtstatsPost(t, store, rtstatsPayload{SID: "bad\nsid\tx", Samples: []rtstatsSample{{At: 0, RTT: 30}}})
	rtstatsPost(t, store, rtstatsPayload{Samples: []rtstatsSample{{At: 0, RTT: 30}}})
	if len(lines) != 2 {
		t.Fatalf("lines = %v, want 2", lines)
	}
	if strings.ContainsAny(lines[0], "\n\t") {
		t.Errorf("sid was not sanitized: %q", lines[0])
	}
	if !strings.Contains(lines[1], "sid=anon") {
		t.Errorf("empty sid should log as anon: %q", lines[1])
	}
}

func TestRtstatsRingAndSessionCapStayBounded(t *testing.T) {
	store := newRtstatsStore(func(string, ...interface{}) {})
	// Overwhelm one session's ring with repeated max-size batches (the handler
	// truncates any single batch to 128, so the ring bound matters ACROSS batches).
	for round := 0; round < 4; round++ {
		big := make([]rtstatsSample, 128)
		for i := range big {
			big[i] = rtstatsSample{At: int64(round*128 + i), RTT: 10}
		}
		rtstatsPost(t, store, rtstatsPayload{SID: "ringy", Samples: big})
	}
	store.mu.Lock()
	n := len(store.sessions["ringy"].samples)
	store.mu.Unlock()
	if n != rtstatsRingCap {
		t.Fatalf("ring size = %d, want cap %d", n, rtstatsRingCap)
	}
	// Overwhelm the session map.
	for i := 0; i < rtstatsMaxSessions+8; i++ {
		rtstatsPost(t, store, rtstatsPayload{SID: sidN(i), Samples: []rtstatsSample{{At: 0, RTT: 10}}})
	}
	store.mu.Lock()
	total := len(store.sessions)
	store.mu.Unlock()
	if total > rtstatsMaxSessions {
		t.Fatalf("sessions = %d, want <= cap %d", total, rtstatsMaxSessions)
	}
}

func sidN(i int) string {
	return "sess-" + string(rune('a'+i%26)) + "-" + jsonNumber(i)
}

func jsonNumber(i int) string {
	b, _ := json.Marshal(i)
	return string(b)
}

// BenchmarkRtstatsHandler substantiates the "no pod impact" claim: a full
// max-size batch (the worst case the client can send) must stay far below
// anything noticeable against the video stream.
func BenchmarkRtstatsHandler(b *testing.B) {
	store := newRtstatsStore(func(string, ...interface{}) {})
	samples := make([]rtstatsSample, 128)
	for i := range samples {
		samples[i] = rtstatsSample{At: int64(i * 5000), RTT: int64(20 + i%300)}
	}
	body, _ := json.Marshal(rtstatsPayload{SID: "bench", Samples: samples})
	handler := rtstatsHTTPHandler(store)

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		// Fresh request per iteration: a request body is consumed once.
		req := httptest.NewRequest(http.MethodPost, "/rtstats", bytes.NewReader(body))
		rec := httptest.NewRecorder()
		handler(rec, req)
	}
}
