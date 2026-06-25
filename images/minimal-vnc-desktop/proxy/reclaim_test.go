package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/reclaimprotocol/reclaim-tee/client"
	teeproto "github.com/reclaimprotocol/reclaim-tee/proto"
)

type fakeReclaimClient struct {
	claim       *client.ClaimWithSignatures
	err         error
	closeCalled bool
}

func (f *fakeReclaimClient) ExecuteCompleteProtocol(*client.ProviderRequestData) (*client.ClaimWithSignatures, error) {
	return f.claim, f.err
}

func (f *fakeReclaimClient) Close() error {
	f.closeCalled = true
	return nil
}

func TestReclaimProveSuccess(t *testing.T) {
	originalFactory := newReclaimProtocolClient
	defer func() { newReclaimProtocolClient = originalFactory }()

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
