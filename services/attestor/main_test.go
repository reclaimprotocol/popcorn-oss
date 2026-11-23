package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	ccpb "cloud.google.com/go/confidentialcomputing/apiv1/confidentialcomputingpb"
	"github.com/googleapis/gax-go/v2/apierror"
	"google.golang.org/api/googleapi"
)

// restErrors builds the errors the Confidential Computing REST client returns
// for an HTTP status: the raw *googleapi.Error and the *apierror.APIError that
// gax wraps it in.
func restErrors(t *testing.T, code int) map[string]error {
	t.Helper()
	raw := &googleapi.Error{Code: code, Message: "upstream said no"}
	wrapped, ok := apierror.FromError(raw)
	if !ok {
		t.Fatalf("apierror.FromError did not accept a googleapi.Error with code %d", code)
	}
	return map[string]error{
		"googleapi": raw,
		"apierror":  wrapped,
		"wrapped":   fmt.Errorf("attempts=1: %w", wrapped),
	}
}

func TestGoogleRESTErrorsAreClassifiedByStatus(t *testing.T) {
	for _, tc := range []struct {
		code      int
		reason    string
		retryable bool
	}{
		{http.StatusForbidden, "http_403", false},
		{http.StatusTooManyRequests, "http_429", false},
		{http.StatusInternalServerError, "http_500", true},
		{http.StatusServiceUnavailable, "http_503", true},
	} {
		for form, err := range restErrors(t, tc.code) {
			if got := upstreamErrorReason(err); got != tc.reason {
				t.Fatalf("%s %d: reason = %q, want %q", form, tc.code, got, tc.reason)
			}
			if got := retryableChallengeError(err); got != tc.retryable {
				t.Fatalf("%s %d: retryable = %v, want %v", form, tc.code, got, tc.retryable)
			}
		}
	}
}

func TestCreateChallengeDoesNotRetryGoogleQuotaOrPermissionErrors(t *testing.T) {
	for _, code := range []int{http.StatusForbidden, http.StatusTooManyRequests} {
		for form, want := range restErrors(t, code) {
			create, calls := challengeStub(want, nil)
			_, _, err := createChallengeWithRetry(context.Background(), noWait, create)
			if !errors.Is(err, want) || *calls != 1 {
				t.Fatalf("%s %d: error = %v, calls = %d, want the upstream error after 1 call", form, code, err, *calls)
			}
		}
	}
}

// fakeAPIError mimics the HTTPCode method of the Google API error type.
type fakeAPIError struct{ code int }

func (e *fakeAPIError) Error() string { return fmt.Sprintf("googleapi: Error %d", e.code) }
func (e *fakeAPIError) HTTPCode() int { return e.code }

func challengeStub(errs ...error) (func(context.Context) (*ccpb.Challenge, error), *int) {
	calls := 0
	return func(context.Context) (*ccpb.Challenge, error) {
		calls++
		if calls <= len(errs) && errs[calls-1] != nil {
			return nil, errs[calls-1]
		}
		return &ccpb.Challenge{Name: "challenge"}, nil
	}, &calls
}

var noWait = []time.Duration{0, 0}

func TestCreateChallengeRetriesTransientFailures(t *testing.T) {
	for name, first := range map[string]error{
		"http 500":  &fakeAPIError{code: http.StatusInternalServerError},
		"http 502":  &fakeAPIError{code: http.StatusBadGateway},
		"http 504":  &fakeAPIError{code: http.StatusGatewayTimeout},
		"transport": errors.New("dial tcp: connection reset by peer"),
		"wrapped":   fmt.Errorf("invoke: %w", &fakeAPIError{code: http.StatusServiceUnavailable}),
	} {
		t.Run(name, func(t *testing.T) {
			create, calls := challengeStub(first)
			challenge, attempts, err := createChallengeWithRetry(context.Background(), noWait, create)
			if err != nil {
				t.Fatalf("error = %v, want nil", err)
			}
			if challenge.GetName() != "challenge" || attempts != 2 || *calls != 2 {
				t.Fatalf("challenge = %q, attempts = %d, calls = %d, want challenge after 2", challenge.GetName(), attempts, *calls)
			}
		})
	}
}

func TestCreateChallengeDoesNotRetryPermissionOrQuotaErrors(t *testing.T) {
	for _, code := range []int{http.StatusBadRequest, http.StatusForbidden, http.StatusTooManyRequests} {
		t.Run(fmt.Sprint(code), func(t *testing.T) {
			want := &fakeAPIError{code: code}
			create, calls := challengeStub(want, nil)
			_, attempts, err := createChallengeWithRetry(context.Background(), noWait, create)
			if !errors.Is(err, want) {
				t.Fatalf("error = %v, want %v", err, want)
			}
			if attempts != 1 || *calls != 1 {
				t.Fatalf("attempts = %d, calls = %d, want 1", attempts, *calls)
			}
		})
	}
}

func TestCreateChallengeDoesNotRetryContextErrors(t *testing.T) {
	for _, want := range []error{context.Canceled, context.DeadlineExceeded} {
		create, calls := challengeStub(fmt.Errorf("post: %w", want), nil)
		_, _, err := createChallengeWithRetry(context.Background(), noWait, create)
		if !errors.Is(err, want) || *calls != 1 {
			t.Fatalf("error = %v, calls = %d, want %v after 1 call", err, *calls, want)
		}
	}
}

func TestCreateChallengeStopsAfterBoundedAttempts(t *testing.T) {
	last := &fakeAPIError{code: http.StatusInternalServerError}
	create, calls := challengeStub(errors.New("first"), errors.New("second"), last, nil)
	_, attempts, err := createChallengeWithRetry(context.Background(), noWait, create)
	if !errors.Is(err, last) {
		t.Fatalf("error = %v, want the last attempt's error", err)
	}
	if attempts != 3 || *calls != 3 {
		t.Fatalf("attempts = %d, calls = %d, want 3", attempts, *calls)
	}
}

func TestCreateChallengeStopsWaitingWhenContextEnds(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	want := &fakeAPIError{code: http.StatusInternalServerError}
	calls := 0
	create := func(context.Context) (*ccpb.Challenge, error) {
		calls++
		cancel()
		return nil, want
	}
	_, _, err := createChallengeWithRetry(ctx, []time.Duration{time.Hour, time.Hour}, create)
	if !errors.Is(err, want) || calls != 1 {
		t.Fatalf("error = %v, calls = %d, want upstream error after 1 call", err, calls)
	}
}

func TestUpstreamErrorReason(t *testing.T) {
	for _, tc := range []struct {
		err  error
		want string
	}{
		{&fakeAPIError{code: http.StatusForbidden}, "http_403"},
		{fmt.Errorf("attempts=1: %w", &fakeAPIError{code: http.StatusTooManyRequests}), "http_429"},
		{fmt.Errorf("post: %w", context.DeadlineExceeded), "deadline_exceeded"},
		{context.Canceled, "canceled"},
		{errors.New("dial tcp: i/o timeout"), "transport"},
		// The Google error type reports -1 when it holds no HTTP response.
		{&fakeAPIError{code: -1}, "transport"},
		{nil, ""},
	} {
		if got := upstreamErrorReason(tc.err); got != tc.want {
			t.Fatalf("upstreamErrorReason(%v) = %q, want %q", tc.err, got, tc.want)
		}
	}
}

func TestWriteProofErrorReportsReasonAndLogsCause(t *testing.T) {
	var logs bytes.Buffer
	previous := log.Writer()
	log.SetOutput(&logs)
	t.Cleanup(func() { log.SetOutput(previous) })

	cause := fmt.Errorf("attempts=1: %w", &fakeAPIError{code: http.StatusForbidden})
	rec := httptest.NewRecorder()
	writeProofError(rec, newUpstreamError("CHALLENGE_CREATION_FAILED", "failed to create confidential computing challenge", cause))

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusInternalServerError)
	}
	var resp proofResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if resp.Error == nil || resp.Error.Code != "CHALLENGE_CREATION_FAILED" || resp.Error.Reason != "http_403" {
		t.Fatalf("error = %+v, want CHALLENGE_CREATION_FAILED with reason http_403", resp.Error)
	}
	if strings.Contains(rec.Body.String(), "googleapi") {
		t.Fatalf("response leaked the underlying error: %s", rec.Body.String())
	}
	if got := logs.String(); !strings.Contains(got, "CHALLENGE_CREATION_FAILED: reason=http_403: attempts=1: googleapi: Error 403") {
		t.Fatalf("log = %q, want code, reason, attempts and cause", got)
	}
}

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
