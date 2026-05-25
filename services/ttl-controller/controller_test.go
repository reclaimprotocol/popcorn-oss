package main

import (
	"errors"
	"testing"
	"time"

	agonesv1 "agones.dev/agones/pkg/apis/agones/v1"
)

func TestSessionExpiryUsesExplicitExpiresAt(t *testing.T) {
	gs := agonesv1.GameServer{}
	gs.Annotations = map[string]string{
		AnnotationLastAllocated: "2026-05-26T12:00:00Z",
		AnnotationExpiresAt:     "2026-05-26T12:30:00Z",
	}

	expiry, _, err := sessionExpiry(gs, 10*time.Minute)
	if err != nil {
		t.Fatalf("sessionExpiry returned error: %v", err)
	}

	if got := expiry.Format(time.RFC3339); got != "2026-05-26T12:30:00Z" {
		t.Fatalf("expiry = %s, want explicit expiresAt", got)
	}
}

func TestSessionExpiryFallsBackToLastAllocated(t *testing.T) {
	gs := agonesv1.GameServer{}
	gs.Annotations = map[string]string{
		AnnotationLastAllocated: "2026-05-26T12:00:00Z",
	}

	expiry, _, err := sessionExpiry(gs, 10*time.Minute)
	if err != nil {
		t.Fatalf("sessionExpiry returned error: %v", err)
	}

	if got := expiry.Format(time.RFC3339); got != "2026-05-26T12:10:00Z" {
		t.Fatalf("expiry = %s, want last allocated plus ttl", got)
	}
}

func TestSessionExpiryRejectsInvalidExpiresAt(t *testing.T) {
	gs := agonesv1.GameServer{}
	gs.Annotations = map[string]string{
		AnnotationLastAllocated: "2026-05-26T12:00:00Z",
		AnnotationExpiresAt:     "invalid",
	}

	if _, _, err := sessionExpiry(gs, 10*time.Minute); !errors.Is(err, errInvalidExplicitExpiry) {
		t.Fatalf("sessionExpiry error = %v, want errInvalidExplicitExpiry", err)
	}
}
