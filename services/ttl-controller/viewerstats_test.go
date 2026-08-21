package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	agonesv1 "agones.dev/agones/pkg/apis/agones/v1"
)

func TestViewerStatsPortPrefersNovnc(t *testing.T) {
	gs := &agonesv1.GameServer{}
	gs.Status.Ports = []agonesv1.GameServerStatusPort{
		{Name: "other", Port: 1234},
		{Name: "novnc", Port: 6091},
	}
	if got := viewerStatsPort(gs); got != 6091 {
		t.Fatalf("port = %d, want 6091", got)
	}
	if got := viewerStatsPort(&agonesv1.GameServer{}); got != 6080 {
		t.Fatalf("fallback port = %d, want 6080", got)
	}
}

func TestFetchViewerRttParsesSummary(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/rtstats" || r.URL.Query().Get("sid") != "sess-1" {
			t.Errorf("unexpected request %s?%s", r.URL.Path, r.URL.RawQuery)
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"sid": "sess-1", "sampleCount": 12, "avgMs": 80, "p50Ms": 70, "p95Ms": 190, "maxMs": 240,
		})
	}))
	defer srv.Close()

	sum, err := fetchViewerRtt(srv.Client(), srv.URL, "sess-1")
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if sum == nil || sum.SampleCount != 12 || sum.AvgMs != 80 || sum.MaxMs != 240 {
		t.Fatalf("summary = %+v, want n=12 avg=80 max=240", sum)
	}
}

// 404 (unknown sid or pre-endpoint pod image) is "nothing to record", not an error.
func TestFetchViewerRttTreats404AsNoData(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "unknown sid", http.StatusNotFound)
	}))
	defer srv.Close()

	sum, err := fetchViewerRtt(srv.Client(), srv.URL, "sess-1")
	if err != nil || sum != nil {
		t.Fatalf("got (%+v, %v), want (nil, nil)", sum, err)
	}
}

func TestPostViewerStatsSendsAuthorizedSummary(t *testing.T) {
	var gotPath, gotAuth string
	var gotBody viewerRttSummary
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		_ = json.NewEncoder(w).Encode(map[string]bool{"success": true})
	}))
	defer srv.Close()

	sum := &viewerRttSummary{SampleCount: 5, AvgMs: 90, P50Ms: 85, P95Ms: 180, MaxMs: 220}
	if err := postViewerStats(srv.Client(), srv.URL, "tok-123", "sess-9", sum); err != nil {
		t.Fatalf("post: %v", err)
	}
	if gotPath != "/sessions/sess-9/viewer-stats" {
		t.Errorf("path = %q", gotPath)
	}
	if gotAuth != "Bearer tok-123" {
		t.Errorf("auth = %q", gotAuth)
	}
	if gotBody.SampleCount != 5 || gotBody.P95Ms != 180 {
		t.Errorf("body = %+v", gotBody)
	}
}

func TestPostViewerStatsRejectsNon200(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "nope", http.StatusUnauthorized)
	}))
	defer srv.Close()

	err := postViewerStats(srv.Client(), srv.URL, "", "sess-9", &viewerRttSummary{SampleCount: 1, AvgMs: 10})
	if err == nil || !strings.Contains(err.Error(), "401") {
		t.Fatalf("err = %v, want status 401 error", err)
	}
}

func TestForwardViewerRttSkipsWithoutSessionOrAddress(t *testing.T) {
	// Must not panic or dial anywhere when there is nothing to correlate.
	forwardViewerRtt(context.Background(), &agonesv1.GameServer{}, "")
	gs := &agonesv1.GameServer{}
	forwardViewerRtt(context.Background(), gs, "sess-1") // no Status.Address
}
