package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"

	"github.com/reclaimprotocol/popcorn-oss/images/minimal-vnc-desktop/proxy/circuits"
	"github.com/reclaimprotocol/reclaim-tee/client"
)

const reclaimMaxRequestBytes = 10 * 1024 * 1024

type reclaimProveRequest struct {
	ProviderParamsJSON string  `json:"provider_params_json"`
	ConfigJSON         *string `json:"config_json,omitempty"`
}

type reclaimConfigJSON struct {
	TEEKURL     string `json:"teekUrl,omitempty"`
	TEETURL     string `json:"teetUrl,omitempty"`
	AttestorURL string `json:"attestorUrl,omitempty"`
	RouterURL   string `json:"routerUrl,omitempty"`
	RequestID   string `json:"requestId,omitempty"`
}

type reclaimProveResult struct {
	SessionID string           `json:"session_id"`
	Claim     reclaimClaim     `json:"claim"`
	Signature reclaimSignature `json:"signature"`
}

type reclaimClaim struct {
	Provider   *string `json:"provider,omitempty"`
	Parameters *string `json:"parameters,omitempty"`
	Owner      *string `json:"owner,omitempty"`
	TimestampS *int    `json:"timestamp_s,omitempty"`
	Context    *string `json:"context,omitempty"`
	Identifier *string `json:"identifier,omitempty"`
	Epoch      *int    `json:"epoch,omitempty"`
}

type reclaimSignature struct {
	AttestorAddress *string `json:"attestor_address,omitempty"`
	ClaimSignature  *string `json:"claim_signature,omitempty"`
	ResultSignature *string `json:"result_signature,omitempty"`
}

type reclaimRuntimeConfig struct {
	TEEKURL      string
	TEETURL      string
	AttestorURL  string
	RouterURL    string
	ProofTimeout time.Duration
	CleanupGrace time.Duration
}

type reclaimProtocolClient interface {
	ExecuteCompleteProtocol(*client.ProviderRequestData) (*client.ClaimWithSignatures, error)
	Close() error
}

var newReclaimProtocolClient = func(providerParamsJSON, configJSON string) (reclaimProtocolClient, error) {
	return client.NewReclaimClientFromJSON(providerParamsJSON, configJSON)
}

func reclaimProveHTTPHandler(w http.ResponseWriter, r *http.Request) {
	handleReclaimProve(w, r, reclaimConfigFromEnv())
}

func reclaimConfigFromEnv() reclaimRuntimeConfig {
	proofTimeout := durationEnvDefault("RECLAIM_PROVE_TIMEOUT", 5*time.Minute)
	cleanupGrace := durationEnvDefault("RECLAIM_PROVE_CLEANUP_GRACE", 10*time.Second)
	return reclaimRuntimeConfig{
		TEEKURL:      envDefault("TEE_K_URL", "wss://tk.reclaimprotocol.org/ws"),
		TEETURL:      envDefault("TEE_T_URL", "wss://tt.reclaimprotocol.org/ws"),
		AttestorURL:  envDefault("ATTESTOR_URL", client.DefaultAttestorURL),
		RouterURL:    envDefault("RECLAIM_ROUTER_URL", envDefault("ROUTER_URL", client.DefaultRouterURL)),
		ProofTimeout: proofTimeout,
		CleanupGrace: cleanupGrace,
	}
}

func durationEnvDefault(name string, fallback time.Duration) time.Duration {
	value := os.Getenv(name)
	if value == "" {
		return fallback
	}
	parsed, err := time.ParseDuration(value)
	if err != nil || parsed <= 0 {
		return fallback
	}
	return parsed
}

func handleReclaimProve(w http.ResponseWriter, r *http.Request, cfg reclaimRuntimeConfig) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method == http.MethodOptions {
		w.Header().Set("Allow", "POST, OPTIONS")
		w.WriteHeader(http.StatusOK)
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST, OPTIONS")
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	defer r.Body.Close()
	body := http.MaxBytesReader(w, r.Body, reclaimMaxRequestBytes)
	var req reclaimProveRequest
	decoder := json.NewDecoder(body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil {
		writeJSONError(w, http.StatusBadRequest, fmt.Sprintf("invalid request JSON: %v", err))
		return
	}
	if err := ensureEOF(decoder); err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.ProviderParamsJSON == "" {
		writeJSONError(w, http.StatusBadRequest, "provider_params_json is required")
		return
	}

	requestID := ""
	if req.ConfigJSON != nil && *req.ConfigJSON != "" {
		var requestCfg reclaimConfigJSON
		if err := json.Unmarshal([]byte(*req.ConfigJSON), &requestCfg); err == nil {
			if requestCfg.TEEKURL != "" {
				cfg.TEEKURL = requestCfg.TEEKURL
			}
			if requestCfg.TEETURL != "" {
				cfg.TEETURL = requestCfg.TEETURL
			}
			if requestCfg.AttestorURL != "" {
				cfg.AttestorURL = requestCfg.AttestorURL
			}
			if requestCfg.RouterURL != "" {
				cfg.RouterURL = requestCfg.RouterURL
			}
			if requestCfg.RequestID != "" {
				requestID = requestCfg.RequestID
			}
		}
	}

	if requestID == "" {
		generated, err := newUUID()
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "failed to generate request ID")
			return
		}
		requestID = generated
	} else if len(requestID) > 100 {
		writeJSONError(w, http.StatusBadRequest, "requestId exceeds maximum length of 100 characters")
		return
	}

	var providerData client.ProviderRequestData
	if err := json.Unmarshal([]byte(req.ProviderParamsJSON), &providerData); err != nil {
		writeJSONError(w, http.StatusBadRequest, fmt.Sprintf("invalid provider parameters JSON: %v", err))
		return
	}

	clientConfigJSON, err := json.Marshal(reclaimConfigJSON{
		TEEKURL:     cfg.TEEKURL,
		TEETURL:     cfg.TEETURL,
		AttestorURL: cfg.AttestorURL,
		RouterURL:   cfg.RouterURL,
		RequestID:   requestID,
	})
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to prepare client configuration")
		return
	}

	protocolClient, err := newReclaimProtocolClient(req.ProviderParamsJSON, string(clientConfigJSON))
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, fmt.Sprintf("invalid provider parameters: %v", err))
		return
	}

	circuits.SetupZKCallback()
	result, err := executeReclaimProtocol(r.Context(), protocolClient, &providerData, cfg.ProofTimeout, cfg.CleanupGrace)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}

	_ = json.NewEncoder(w).Encode(reclaimProveResult{
		SessionID: requestID,
		Claim:     mapReclaimClaim(result.Claim),
		Signature: mapReclaimSignature(result.Signature),
	})
}

func ensureEOF(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); err == nil {
		return errors.New("request body must contain a single JSON object")
	} else if !errors.Is(err, io.EOF) {
		return fmt.Errorf("invalid request JSON: %v", err)
	}
	return nil
}

func executeReclaimProtocol(ctx context.Context, c reclaimProtocolClient, providerData *client.ProviderRequestData, timeout, cleanupGrace time.Duration) (*client.ClaimWithSignatures, error) {
	proofCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	type result struct {
		claim *client.ClaimWithSignatures
		err   error
	}
	resultCh := make(chan result, 1)
	go func() {
		defer func() {
			if r := recover(); r != nil {
				resultCh <- result{err: fmt.Errorf("internal error: protocol execution panicked")}
			}
		}()
		claim, err := c.ExecuteCompleteProtocol(providerData)
		resultCh <- result{claim: claim, err: err}
	}()

	select {
	case <-proofCtx.Done():
		select {
		case <-resultCh:
		case <-time.After(cleanupGrace):
		}
		_ = c.Close()
		if errors.Is(proofCtx.Err(), context.DeadlineExceeded) {
			return nil, fmt.Errorf("proof execution timed out")
		}
		return nil, fmt.Errorf("proof execution canceled")
	case res := <-resultCh:
		_ = c.Close()
		if res.err != nil {
			return nil, fmt.Errorf("proof execution failed: %v", res.err)
		}
		if res.claim == nil {
			return nil, fmt.Errorf("proof execution returned no claim")
		}
		return res.claim, nil
	}
}

func mapReclaimClaim(claim interface{}) reclaimClaim {
	type providerClaimData interface {
		GetProvider() string
		GetParameters() string
		GetOwner() string
		GetTimestampS() uint32
		GetContext() string
		GetIdentifier() string
		GetEpoch() uint32
	}

	if c, ok := claim.(providerClaimData); ok {
		provider := c.GetProvider()
		parameters := c.GetParameters()
		owner := c.GetOwner()
		timestampS := int(c.GetTimestampS())
		context := c.GetContext()
		identifier := c.GetIdentifier()
		epoch := int(c.GetEpoch())

		return reclaimClaim{
			Provider:   &provider,
			Parameters: &parameters,
			Owner:      &owner,
			TimestampS: &timestampS,
			Context:    &context,
			Identifier: &identifier,
			Epoch:      &epoch,
		}
	}
	return reclaimClaim{}
}

func mapReclaimSignature(sig interface{}) reclaimSignature {
	type claimSignature interface {
		GetAttestorAddress() string
		GetClaimSignature() []byte
		GetResultSignature() []byte
	}

	if s, ok := sig.(claimSignature); ok {
		attestorAddress := s.GetAttestorAddress()
		claimSignature := base64.StdEncoding.EncodeToString(s.GetClaimSignature())
		resultSignature := base64.StdEncoding.EncodeToString(s.GetResultSignature())

		return reclaimSignature{
			AttestorAddress: &attestorAddress,
			ClaimSignature:  &claimSignature,
			ResultSignature: &resultSignature,
		}
	}
	return reclaimSignature{}
}

func writeJSONError(w http.ResponseWriter, status int, message string) {
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"message": message})
}

func newUUID() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	raw[6] = (raw[6] & 0x0f) | 0x40
	raw[8] = (raw[8] & 0x3f) | 0x80

	var dst [36]byte
	hex.Encode(dst[0:8], raw[0:4])
	dst[8] = '-'
	hex.Encode(dst[9:13], raw[4:6])
	dst[13] = '-'
	hex.Encode(dst[14:18], raw[6:8])
	dst[18] = '-'
	hex.Encode(dst[19:23], raw[8:10])
	dst[23] = '-'
	hex.Encode(dst[24:36], raw[10:16])
	return string(dst[:]), nil
}
