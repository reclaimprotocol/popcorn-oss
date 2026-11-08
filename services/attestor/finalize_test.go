package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Synthetic test credential, never a deployed token.
var testFinalizeToken = strings.Repeat("0123456789abcdef", 4)

var testFinalizeRequest = finalizeRequest{
	ProofHash: strings.Repeat("ab", 32),
	PublicKey: "0x02" + strings.Repeat("11", 32),
	SessionID: "session-123",
}

func finalizeBody(t *testing.T, value any) *bytes.Reader {
	t.Helper()
	body, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal body: %v", err)
	}
	return bytes.NewReader(body)
}

func newFinalizeRequest(t *testing.T, body *bytes.Reader, authorization string) *http.Request {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/finalize", body)
	req.Header.Set("Content-Type", "application/json")
	if authorization != "" {
		req.Header.Set("Authorization", authorization)
	}
	return req
}

func failingProver(t *testing.T) proofGenerator {
	return func(context.Context, string) (*proofResponse, error) {
		t.Fatal("proof generator must not run for a rejected finalize request")
		return nil, nil
	}
}

func decodeProofResponse(t *testing.T, rec *httptest.ResponseRecorder) proofResponse {
	t.Helper()
	var resp proofResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	return resp
}

func TestFinalizeBindingMatchesSpecifiedEncoding(t *testing.T) {
	proofHash, _ := hex.DecodeString(testFinalizeRequest.ProofHash)
	var payload bytes.Buffer
	payload.WriteString("popcorn/attestor/finalize/v1\x00")
	for _, field := range [][]byte{proofHash, []byte(testFinalizeRequest.PublicKey), []byte(testFinalizeRequest.SessionID)} {
		_ = binary.Write(&payload, binary.BigEndian, uint32(len(field)))
		payload.Write(field)
	}
	sum := sha256.Sum256(payload.Bytes())
	want := "finalize:" + hex.EncodeToString(sum[:])

	got := finalizeBinding(testFinalizeRequest)
	if got != want {
		t.Fatalf("finalizeBinding() = %q, want %q", got, want)
	}
	// Shared cross-language vector; same-pod clients assert the same value.
	if vector := "finalize:7ed92c9a6c4d6b006e3be2b70a73eaa62e21858ff550814fe75b87e791a22ec7"; got != vector {
		t.Fatalf("finalizeBinding() = %q, want shared vector %q", got, vector)
	}
	// GCP confidential computing accepts nonces of 10-74 bytes.
	if len(got) < 10 || len(got) > 74 {
		t.Fatalf("finalize nonce length = %d, want 10-74", len(got))
	}
}

func TestFinalizeBindingSeparatesFields(t *testing.T) {
	shifted := testFinalizeRequest
	shifted.PublicKey = testFinalizeRequest.PublicKey + "s"
	shifted.SessionID = strings.TrimPrefix(testFinalizeRequest.SessionID, "s")
	if finalizeBinding(shifted) == finalizeBinding(testFinalizeRequest) {
		t.Fatal("finalizeBinding() collided after moving bytes between fields")
	}
}

func TestProofEndpointCannotMintFinalizeNonce(t *testing.T) {
	if _, err := normalizeNonce(finalizeBinding(testFinalizeRequest)); err == nil {
		t.Fatal("normalizeNonce() accepted a finalize binding")
	}
}

func TestFinalizeRequiresBearerToken(t *testing.T) {
	for _, authorization := range []string{"", "Bearer wrong", testFinalizeToken, "Bearer " + testFinalizeToken + "x"} {
		rec := httptest.NewRecorder()
		finalizeHandler(testFinalizeToken, failingProver(t))(rec, newFinalizeRequest(t, finalizeBody(t, testFinalizeRequest), authorization))

		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("authorization %q: status = %d, want %d", authorization, rec.Code, http.StatusUnauthorized)
		}
		if resp := decodeProofResponse(t, rec); resp.Error == nil || resp.Error.Code != "UNAUTHORIZED" {
			t.Fatalf("authorization %q: error = %+v, want UNAUTHORIZED", authorization, resp.Error)
		}
	}
}

func TestFinalizeRejectsEmptyConfiguredToken(t *testing.T) {
	rec := httptest.NewRecorder()
	finalizeHandler("", failingProver(t))(rec, newFinalizeRequest(t, finalizeBody(t, testFinalizeRequest), "Bearer "))

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

func TestFinalizeRequiresPost(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/finalize", nil)
	req.Header.Set("Authorization", "Bearer "+testFinalizeToken)
	rec := httptest.NewRecorder()

	finalizeHandler(testFinalizeToken, failingProver(t))(rec, req)

	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusMethodNotAllowed)
	}
}

func TestFinalizeRejectsMalformedRequests(t *testing.T) {
	valid := map[string]any{
		"proof_hash": testFinalizeRequest.ProofHash,
		"public_key": testFinalizeRequest.PublicKey,
		"session_id": testFinalizeRequest.SessionID,
	}
	with := func(key string, value any) map[string]any {
		body := map[string]any{}
		for k, v := range valid {
			body[k] = v
		}
		if value == nil {
			delete(body, key)
		} else {
			body[key] = value
		}
		return body
	}

	cases := map[string]string{
		"uppercase hash":    mustJSON(t, with("proof_hash", strings.ToUpper(testFinalizeRequest.ProofHash))),
		"short hash":        mustJSON(t, with("proof_hash", "abcd")),
		"prefixed hash":     mustJSON(t, with("proof_hash", "0x"+testFinalizeRequest.ProofHash[2:])),
		"missing key":       mustJSON(t, with("public_key", nil)),
		"key whitespace":    mustJSON(t, with("public_key", "abc def")),
		"oversized key":     mustJSON(t, with("public_key", strings.Repeat("a", maxFinalizePublicKey+1))),
		"empty session":     mustJSON(t, with("session_id", "")),
		"non-ascii session": mustJSON(t, with("session_id", "séssion")),
		"unknown field":     mustJSON(t, with("nonce", "abcdef1234")),
		"trailing object":   mustJSON(t, valid) + "{}",
		"not an object":     `"finalize"`,
		"oversized body":    mustJSON(t, with("session_id", strings.Repeat("a", maxFinalizeBodyBytes))),
	}
	for name, body := range cases {
		rec := httptest.NewRecorder()
		finalizeHandler(testFinalizeToken, failingProver(t))(rec,
			newFinalizeRequest(t, bytes.NewReader([]byte(body)), "Bearer "+testFinalizeToken))

		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%s: status = %d, want %d", name, rec.Code, http.StatusBadRequest)
		}
		if resp := decodeProofResponse(t, rec); resp.Error == nil || resp.Error.Code != "FINALIZE_REQUEST_INVALID" {
			t.Fatalf("%s: error = %+v, want FINALIZE_REQUEST_INVALID", name, resp.Error)
		}
	}
}

func TestFinalizeRequiresJSONContentType(t *testing.T) {
	req := newFinalizeRequest(t, finalizeBody(t, testFinalizeRequest), "Bearer "+testFinalizeToken)
	req.Header.Set("Content-Type", "text/plain")
	rec := httptest.NewRecorder()

	finalizeHandler(testFinalizeToken, failingProver(t))(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestFinalizeBindsRequestIntoRuntimeAttestation(t *testing.T) {
	state := &runtimeState{
		WorkloadDigest: "ghcr.io/reclaimprotocol/browser-runtime@sha256:abc",
		VerifierDigest: "ghcr.io/reclaimprotocol/browser-runtime-attestor@sha256:def",
	}
	var attestedNonce string
	prove := func(_ context.Context, nonce string) (*proofResponse, error) {
		attestedNonce = nonce
		return buildProof(state, nonce, "token"), nil
	}
	rec := httptest.NewRecorder()

	finalizeHandler(testFinalizeToken, prove)(rec, newFinalizeRequest(t, finalizeBody(t, testFinalizeRequest), "Bearer "+testFinalizeToken))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d: %s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", got)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("Access-Control-Allow-Origin = %q, want unset", got)
	}
	resp := decodeProofResponse(t, rec)
	if attestedNonce != finalizeBinding(testFinalizeRequest) || resp.Nonce != attestedNonce {
		t.Fatalf("nonce = %q (attested %q), want %q", resp.Nonce, attestedNonce, finalizeBinding(testFinalizeRequest))
	}
	want := proofFinalization{
		Version:   "v1",
		ProofHash: testFinalizeRequest.ProofHash,
		PublicKey: testFinalizeRequest.PublicKey,
		SessionID: testFinalizeRequest.SessionID,
	}
	if resp.Finalization == nil || *resp.Finalization != want {
		t.Fatalf("finalization = %+v, want %+v", resp.Finalization, want)
	}
	if resp.Attestation == nil || resp.Attestation.Token != "token" {
		t.Fatalf("attestation = %+v, want generated token", resp.Attestation)
	}
}

func TestProofResponseOmitsFinalization(t *testing.T) {
	body, err := json.Marshal(buildProof(&runtimeState{}, "abcdef1234", "token"))
	if err != nil {
		t.Fatalf("marshal proof: %v", err)
	}
	if bytes.Contains(body, []byte("finalization")) {
		t.Fatalf("/proof response unexpectedly contains finalization: %s", body)
	}
}

func TestInitFinalizeTokenDisabledWithoutPath(t *testing.T) {
	token, err := initFinalizeToken("  ")
	if err != nil || token != "" {
		t.Fatalf("initFinalizeToken() = %q, %v; want disabled", token, err)
	}
}

func TestInitFinalizeTokenWritesFreshReadableToken(t *testing.T) {
	path := filepath.Join(t.TempDir(), "token")

	first, err := initFinalizeToken(path)
	if err != nil {
		t.Fatalf("initFinalizeToken() error = %v", err)
	}
	if len(first) != 64 {
		t.Fatalf("token length = %d, want 64", len(first))
	}
	written, err := os.ReadFile(path)
	if err != nil || string(written) != first {
		t.Fatalf("token file = %q, %v; want %q", written, err, first)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0o644 {
		t.Fatalf("token file mode = %v, %v; want 0644", info.Mode().Perm(), err)
	}

	second, err := initFinalizeToken(path)
	if err != nil {
		t.Fatalf("initFinalizeToken() second error = %v", err)
	}
	if second == first {
		t.Fatal("initFinalizeToken() reused the previous token")
	}
	if entries, _ := os.ReadDir(filepath.Dir(path)); len(entries) != 1 {
		t.Fatalf("token directory has %d entries, want only the token", len(entries))
	}
}

func TestInitFinalizeTokenDisabledWithoutSharedDirectory(t *testing.T) {
	if token, err := initFinalizeToken(filepath.Join(t.TempDir(), "missing", "token")); err != nil || token != "" {
		t.Fatalf("initFinalizeToken() = %q, %v; want disabled", token, err)
	}
}

func TestInitFinalizeTokenRejectsInvalidSharedDirectory(t *testing.T) {
	path := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(path, []byte("synthetic"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := initFinalizeToken(filepath.Join(path, "token")); err == nil {
		t.Fatal("initFinalizeToken() accepted a regular file as the shared directory")
	}
}

func mustJSON(t *testing.T, value any) string {
	t.Helper()
	body, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return string(body)
}
