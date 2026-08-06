package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHandleProofRequiresNonce(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/proof", nil)
	rec := httptest.NewRecorder()

	handleProof(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}

	var resp proofResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if resp.ProofVersion != ProofVersion {
		t.Fatalf("proof_version = %q, want %q", resp.ProofVersion, ProofVersion)
	}
	if resp.Error == nil || resp.Error.Code != "NONCE_REQUIRED" {
		t.Fatalf("error = %+v, want NONCE_REQUIRED", resp.Error)
	}
}

func TestHandleProofRejectsMalformedNonce(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/proof?nonce=not-hex", nil)
	rec := httptest.NewRecorder()

	handleProof(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}

	var resp proofResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if resp.Error == nil || resp.Error.Code != "NONCE_INVALID" {
		t.Fatalf("error = %+v, want NONCE_INVALID", resp.Error)
	}
}

func TestNormalizeImageDigest(t *testing.T) {
	got := normalizeImageDigest("docker-pullable://ghcr.io/reclaimprotocol/image@sha256:abc")
	want := "ghcr.io/reclaimprotocol/image@sha256:abc"
	if got != want {
		t.Fatalf("normalizeImageDigest() = %q, want %q", got, want)
	}
}

func TestChooseResolvedDigestPrefersMatchingRuntimeDigest(t *testing.T) {
	specDigest := "ghcr.io/reclaimprotocol/image@sha256:abc"
	runtimeDigest := "ghcr.io/reclaimprotocol/image@sha256:abc"

	got, err := chooseResolvedDigest(specDigest, runtimeDigest)
	if err != nil {
		t.Fatalf("chooseResolvedDigest() error = %v", err)
	}
	if got != runtimeDigest {
		t.Fatalf("chooseResolvedDigest() = %q, want %q", got, runtimeDigest)
	}
}

func TestChooseResolvedDigestRejectsDigestMismatch(t *testing.T) {
	_, err := chooseResolvedDigest(
		"ghcr.io/reclaimprotocol/image@sha256:abc",
		"ghcr.io/reclaimprotocol/image@sha256:def",
	)
	if err == nil {
		t.Fatal("chooseResolvedDigest() error = nil, want mismatch error")
	}
}

func TestBuildProofIncludesBrowserRuntimeContainerNames(t *testing.T) {
	state := &runtimeState{
		WorkloadDigest: "ghcr.io/reclaimprotocol/browser-runtime@sha256:abc",
		VerifierDigest: "ghcr.io/reclaimprotocol/browser-runtime-attestor@sha256:def",
	}

	proof := buildProof(state, "abcdef1234", "token")

	if proof.ProofVersion != "v3" {
		t.Fatalf("proof_version = %q, want v3", proof.ProofVersion)
	}
	if proof.TeeProvider != "gcp" {
		t.Fatalf("tee_provider = %q, want gcp", proof.TeeProvider)
	}
	if proof.TeeTechnology != "amd-sev" {
		t.Fatalf("tee_technology = %q, want amd-sev", proof.TeeTechnology)
	}
	if proof.Workload == nil || proof.Workload.ContainerName != "browser-runtime" {
		t.Fatalf("workload = %+v, want browser-runtime container", proof.Workload)
	}
	if proof.Verifier == nil || proof.Verifier.ContainerName != "browser-runtime-attestor" {
		t.Fatalf("verifier = %+v, want browser-runtime-attestor container", proof.Verifier)
	}
}

func TestRuntimeDigestBindingIncludesContainerNames(t *testing.T) {
	state := &runtimeState{
		WorkloadDigest: "ghcr.io/reclaimprotocol/browser-runtime@sha256:abc",
		VerifierDigest: "ghcr.io/reclaimprotocol/browser-runtime-attestor@sha256:def",
	}
	payload := strings.Join([]string{
		"v3",
		"workload.container_name=browser-runtime",
		"workload.image_digest=" + state.WorkloadDigest,
		"verifier.container_name=browser-runtime-attestor",
		"verifier.image_digest=" + state.VerifierDigest,
	}, "\n")
	sum := sha256.Sum256([]byte(payload))
	want := hex.EncodeToString(sum[:])

	if got := runtimeDigestBinding(state); got != want {
		t.Fatalf("runtimeDigestBinding() = %q, want %q", got, want)
	}

	digestOnly := sha256.Sum256([]byte(state.WorkloadDigest + "\n" + state.VerifierDigest))
	if got := runtimeDigestBinding(state); got == hex.EncodeToString(digestOnly[:]) {
		t.Fatal("runtimeDigestBinding() matched old digest-only binding")
	}
}
