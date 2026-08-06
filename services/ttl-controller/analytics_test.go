package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestEndSessionWithRetryRecoversFromServerErrors(t *testing.T) {
	var attempts atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer service-token" {
			t.Fatalf("Authorization = %q, want service token", got)
		}
		var body EndSessionRequest
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if body.GameServerName != "browser-1" {
			t.Fatalf("gameServerName = %q, want browser-1", body.GameServerName)
		}
		if attempts.Add(1) < 3 {
			http.Error(w, "temporary failure", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	usedAttempts, err := endSessionWithRetry(
		server.Client(),
		server.URL,
		"service-token",
		"browser-1",
		"session-1",
		"expired",
		3,
		0,
	)
	if err != nil {
		t.Fatalf("endSessionWithRetry returned error: %v", err)
	}
	if usedAttempts != 3 {
		t.Fatalf("attempts = %d, want 3", usedAttempts)
	}
}

func TestEndSessionWithRetryDoesNotRetryPermanentClientError(t *testing.T) {
	var attempts atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		attempts.Add(1)
		http.Error(w, "unauthorized", http.StatusUnauthorized)
	}))
	defer server.Close()

	usedAttempts, err := endSessionWithRetry(
		server.Client(),
		server.URL,
		"bad-token",
		"browser-2",
		"session-2",
		"expired",
		3,
		0,
	)
	if err == nil {
		t.Fatal("endSessionWithRetry returned nil error, want client error")
	}
	if usedAttempts != 1 || attempts.Load() != 1 {
		t.Fatalf("attempts = %d/%d, want 1/1", usedAttempts, attempts.Load())
	}
}
