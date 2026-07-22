package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/reclaimprotocol/reclaim-tee/client"
	teeproto "github.com/reclaimprotocol/reclaim-tee/proto"
)

type fakeReclaimClient struct {
	claim       *client.ClaimWithSignatures
	err         error
	execute     func(*client.ProviderRequestData) (*client.ClaimWithSignatures, error)
	closeFn     func() error
	closeCalled bool
}

func (f *fakeReclaimClient) ExecuteCompleteProtocol(providerData *client.ProviderRequestData) (*client.ClaimWithSignatures, error) {
	if f.execute != nil {
		return f.execute(providerData)
	}
	return f.claim, f.err
}

func (f *fakeReclaimClient) Close() error {
	f.closeCalled = true
	if f.closeFn != nil {
		return f.closeFn()
	}
	return nil
}

func TestReclaimProveSuccess(t *testing.T) {
	originalFactory := newReclaimProtocolClient
	defer func() { newReclaimProtocolClient = originalFactory }()
	var logs synchronizedBuffer
	restoreLogOutput := captureReclaimLifecycleLogs(&logs)
	defer restoreLogOutput()

	var gotProviderParams string
	var gotConfig string
	fake := &fakeReclaimClient{
		claim: &client.ClaimWithSignatures{
			Claim: &teeproto.ProviderClaimData{
				Provider:   "http",
				Parameters: `{"url":"https://example.com"}`,
				Owner:      "0x1111111111111111111111111111111111111111",
				TimestampS: 123,
				Context:    `{"purpose":"test"}`,
				Identifier: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				Epoch:      7,
			},
			Signature: &teeproto.ClaimTeeBundleResponse_Signature{
				AttestorAddress: "0x2222222222222222222222222222222222222222",
				ClaimSignature:  []byte{1, 2, 3},
				ResultSignature: []byte{4, 5, 6},
			},
		},
	}
	newReclaimProtocolClient = func(providerParamsJSON, configJSON string) (reclaimProtocolClient, error) {
		gotProviderParams = providerParamsJSON
		gotConfig = configJSON
		return fake, nil
	}

	body := `{"provider_params_json":"{\"name\":\"http\",\"params\":{\"url\":\"https://example.com\"}}","config_json":"{\"requestId\":\"req-1\",\"routerUrl\":\"https://router.example\",\"attestorUrl\":\"wss://attestor.example/ws\"}"}`
	req := httptest.NewRequest(http.MethodPost, "/reclaim/prove", strings.NewReader(body))
	rec := httptest.NewRecorder()
	handleReclaimProve(rec, req, reclaimRuntimeConfig{
		TEEKURL:      "wss://tk.default/ws",
		TEETURL:      "wss://tt.default/ws",
		AttestorURL:  "wss://attestor.default/ws",
		RouterURL:    "https://router.default",
		ProofTimeout: time.Second,
		CleanupGrace: time.Millisecond,
	})

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	if gotProviderParams != `{"name":"http","params":{"url":"https://example.com"}}` {
		t.Fatalf("provider params forwarded as %q", gotProviderParams)
	}
	var forwardedCfg reclaimConfigJSON
	if err := json.Unmarshal([]byte(gotConfig), &forwardedCfg); err != nil {
		t.Fatal(err)
	}
	if forwardedCfg.RequestID != "req-1" || forwardedCfg.RouterURL != "https://router.example" || forwardedCfg.AttestorURL != "wss://attestor.example/ws" {
		t.Fatalf("unexpected forwarded config: %+v", forwardedCfg)
	}
	if !fake.closeCalled {
		t.Fatal("client was not closed")
	}

	var result reclaimProveResult
	if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.SessionID != "req-1" {
		t.Fatalf("session_id = %q, want req-1", result.SessionID)
	}
	if result.Claim.Provider == nil || *result.Claim.Provider != "http" {
		t.Fatalf("unexpected claim provider: %+v", result.Claim.Provider)
	}
	if result.Signature.ClaimSignature == nil || *result.Signature.ClaimSignature != "AQID" {
		t.Fatalf("unexpected claim signature: %+v", result.Signature.ClaimSignature)
	}
	if result.Signature.ResultSignature == nil || *result.Signature.ResultSignature != "BAUG" {
		t.Fatalf("unexpected result signature: %+v", result.Signature.ResultSignature)
	}
	if !strings.Contains(logs.String(), `"msg":"reclaim prove started"`) ||
		!strings.Contains(logs.String(), `"request_id":"req-1"`) {
		t.Fatalf("missing proof start log: %s", logs.String())
	}
	if !strings.Contains(logs.String(), `"msg":"reclaim prove completed"`) ||
		!strings.Contains(logs.String(), `"identifier":"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"`) {
		t.Fatalf("missing proof completion log: %s", logs.String())
	}
}

func TestReclaimProveDisableProxyWithholdsProxyEnv(t *testing.T) {
	originalFactory := newReclaimProtocolClient
	defer func() { newReclaimProtocolClient = originalFactory }()

	t.Setenv(proxyEnvKey, "https://user-{{geoLocation}}:pass@proxy.example:22225")

	var seenProxyEnv string
	var seenPresent bool
	newReclaimProtocolClient = func(providerParamsJSON, configJSON string) (reclaimProtocolClient, error) {
		seenProxyEnv, seenPresent = os.LookupEnv(proxyEnvKey)
		return &fakeReclaimClient{
			claim: &client.ClaimWithSignatures{
				Claim:     &teeproto.ProviderClaimData{Provider: "http"},
				Signature: &teeproto.ClaimTeeBundleResponse_Signature{},
			},
		}, nil
	}

	body := `{"provider_params_json":"{\"name\":\"http\",\"params\":{\"url\":\"https://example.com\"}}","config_json":"{\"requestId\":\"req-1\",\"disableProxy\":true}"}`
	req := httptest.NewRequest(http.MethodPost, "/reclaim/prove", strings.NewReader(body))
	rec := httptest.NewRecorder()
	handleReclaimProve(rec, req, reclaimRuntimeConfig{
		ProofTimeout: time.Second,
		CleanupGrace: time.Millisecond,
	})

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	if seenPresent {
		t.Fatalf("HTTPS_PROXY_URL was visible to client construction (=%q), want withheld", seenProxyEnv)
	}
	if got, ok := os.LookupEnv(proxyEnvKey); !ok || got != "https://user-{{geoLocation}}:pass@proxy.example:22225" {
		t.Fatalf("HTTPS_PROXY_URL not restored after request: got %q present=%v", got, ok)
	}
}

func TestReclaimProveKeepsProxyEnvByDefault(t *testing.T) {
	originalFactory := newReclaimProtocolClient
	defer func() { newReclaimProtocolClient = originalFactory }()

	t.Setenv(proxyEnvKey, "https://user-{{geoLocation}}:pass@proxy.example:22225")

	var seenPresent bool
	newReclaimProtocolClient = func(providerParamsJSON, configJSON string) (reclaimProtocolClient, error) {
		_, seenPresent = os.LookupEnv(proxyEnvKey)
		return &fakeReclaimClient{
			claim: &client.ClaimWithSignatures{
				Claim:     &teeproto.ProviderClaimData{Provider: "http"},
				Signature: &teeproto.ClaimTeeBundleResponse_Signature{},
			},
		}, nil
	}

	body := `{"provider_params_json":"{\"name\":\"http\",\"params\":{\"url\":\"https://example.com\"}}","config_json":"{\"requestId\":\"req-1\"}"}`
	req := httptest.NewRequest(http.MethodPost, "/reclaim/prove", strings.NewReader(body))
	rec := httptest.NewRecorder()
	handleReclaimProve(rec, req, reclaimRuntimeConfig{
		ProofTimeout: time.Second,
		CleanupGrace: time.Millisecond,
	})

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	if !seenPresent {
		t.Fatal("HTTPS_PROXY_URL was withheld from client construction, want visible by default")
	}
}

func TestReclaimProveLogsCancellation(t *testing.T) {
	originalFactory := newReclaimProtocolClient
	defer func() { newReclaimProtocolClient = originalFactory }()
	var logs synchronizedBuffer
	restoreLogOutput := captureReclaimLifecycleLogs(&logs)
	defer restoreLogOutput()

	started := make(chan struct{})
	release := make(chan struct{})
	closed := make(chan struct{})
	fake := &fakeReclaimClient{
		execute: func(*client.ProviderRequestData) (*client.ClaimWithSignatures, error) {
			close(started)
			<-release
			return nil, errors.New("released after cancellation")
		},
		closeFn: func() error {
			close(closed)
			return nil
		},
	}
	newReclaimProtocolClient = func(string, string) (reclaimProtocolClient, error) {
		return fake, nil
	}

	ctx, cancel := context.WithCancel(context.Background())
	body := `{"provider_params_json":"{\"name\":\"http\"}","config_json":"{\"requestId\":\"req-cancelled\"}"}`
	req := httptest.NewRequest(http.MethodPost, "/reclaim/prove", strings.NewReader(body)).WithContext(ctx)
	rec := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		handleReclaimProve(rec, req, reclaimRuntimeConfig{ProofTimeout: time.Second, CleanupGrace: time.Second})
		close(done)
	}()

	<-started
	cancel()
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("client was not closed promptly after cancellation")
	}
	if !strings.Contains(logs.String(), `"msg":"reclaim prove failed"`) ||
		!strings.Contains(logs.String(), `"request_id":"req-cancelled"`) ||
		!strings.Contains(logs.String(), `"outcome":"canceled"`) {
		t.Fatalf("missing immediate proof cancellation log: %s", logs.String())
	}
	select {
	case <-done:
		t.Fatal("handler returned before protocol cleanup completed")
	default:
	}
	close(release)
	<-done

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "proof execution canceled") {
		t.Fatalf("unexpected body: %s", rec.Body.String())
	}
	if strings.Contains(logs.String(), "released after cancellation") {
		t.Fatalf("exported dependency error details: %s", logs.String())
	}
}

func TestReclaimProveValidation(t *testing.T) {
	tests := []struct {
		name   string
		method string
		body   string
		status int
		match  string
	}{
		{
			name:   "wrong method",
			method: http.MethodGet,
			status: http.StatusMethodNotAllowed,
			match:  "method not allowed",
		},
		{
			name:   "bad request json",
			method: http.MethodPost,
			body:   `{`,
			status: http.StatusBadRequest,
			match:  "invalid request JSON",
		},
		{
			name:   "missing provider params",
			method: http.MethodPost,
			body:   `{}`,
			status: http.StatusBadRequest,
			match:  "provider_params_json is required",
		},
		{
			name:   "bad provider params json",
			method: http.MethodPost,
			body:   `{"provider_params_json":"{"}`,
			status: http.StatusBadRequest,
			match:  "invalid provider parameters JSON",
		},
		{
			name:   "long request id",
			method: http.MethodPost,
			body:   `{"provider_params_json":"{\"name\":\"http\"}","config_json":"{\"requestId\":\"` + strings.Repeat("a", 101) + `\"}"}`,
			status: http.StatusBadRequest,
			match:  "requestId exceeds maximum length",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(tt.method, "/reclaim/prove", strings.NewReader(tt.body))
			rec := httptest.NewRecorder()
			handleReclaimProve(rec, req, reclaimRuntimeConfig{ProofTimeout: time.Second, CleanupGrace: time.Millisecond})
			if rec.Code != tt.status {
				t.Fatalf("status = %d, want %d: %s", rec.Code, tt.status, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), tt.match) {
				t.Fatalf("body %q does not contain %q", rec.Body.String(), tt.match)
			}
		})
	}
}

func TestReclaimProveClientErrors(t *testing.T) {
	originalFactory := newReclaimProtocolClient
	defer func() { newReclaimProtocolClient = originalFactory }()

	newReclaimProtocolClient = func(string, string) (reclaimProtocolClient, error) {
		return nil, errors.New("bad params")
	}

	req := httptest.NewRequest(http.MethodPost, "/reclaim/prove", bytes.NewBufferString(`{"provider_params_json":"{\"name\":\"http\"}"}`))
	rec := httptest.NewRecorder()
	handleReclaimProve(rec, req, reclaimRuntimeConfig{ProofTimeout: time.Second, CleanupGrace: time.Millisecond})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "invalid provider parameters") {
		t.Fatalf("unexpected body: %s", rec.Body.String())
	}
}

func captureReclaimLifecycleLogs(dst *synchronizedBuffer) func() {
	originalLogger := reclaimLogger
	reclaimLogger = newReclaimLogger(dst)
	return func() {
		reclaimLogger = originalLogger
	}
}

type synchronizedBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (b *synchronizedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.b.Write(p)
}

func (b *synchronizedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.b.String()
}
