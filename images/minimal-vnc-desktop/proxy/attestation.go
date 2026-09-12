package main

// Confidential Space attestation runs in the browser workload itself. The
// legacy GKE attestor sidecar cannot attest to this process's run key.
import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"
)

const (
	runProofVersion       = "cs-v1"
	runBindingDomain      = "popcorn/confidential-space/run-key/v1\x00"
	launcherSocket        = "/run/container_launcher/teeserver.sock"
	launcherTokenURL      = "http://localhost/v1/token"
	maxLauncherTokenBytes = 262144
)

var runChallengePattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

// A run is one browser proxy process lifetime. There is no private-key import,
// persistence, export, environment variable, or caller-selected signing key.
type runAttestor struct {
	privateKey ed25519.PrivateKey
	publicKey  string
	audience   string
	client     *http.Client
}

type runProof struct {
	ProofVersion string `json:"proof_version"`
	Nonce        string `json:"nonce"`
	Audience     string `json:"audience"`
	RunPublicKey string `json:"run_public_key"`
	RunSignature string `json:"run_signature"`
	Attestation  struct {
		Token string `json:"token"`
	} `json:"attestation"`
}

func validRunAudience(audience string) bool {
	if len(audience) == 0 || len(audience) > 512 || audience == "https://sts.google.com" || audience == "https://sts.googleapis.com" {
		return false
	}
	for _, c := range []byte(audience) {
		if c < 0x21 || c > 0x7e {
			return false
		}
	}
	return true
}

func newRunAttestor(audience string) (*runAttestor, error) {
	if !validRunAudience(audience) {
		return nil, fmt.Errorf("Confidential Space requires a configured custom audience (1-512 printable ASCII bytes, no spaces)")
	}
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("generate ephemeral run key: %w", err)
	}
	return &runAttestor{privateKey: private, publicKey: base64.RawURLEncoding.EncodeToString(public), audience: audience, client: launcherHTTPClient(launcherSocket)}, nil
}

func launcherHTTPClient(socket string) *http.Client {
	return &http.Client{
		Timeout:       30 * time.Second,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return fmt.Errorf("launcher redirects are forbidden") },
		Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", socket)
		}},
	}
}

func confidentialSpaceServer() (*http.Server, error) {
	switch os.Getenv("POPCORN_CONFIDENTIAL_SPACE") {
	case "", "false":
		return nil, nil
	case "true":
	default:
		return nil, fmt.Errorf("POPCORN_CONFIDENTIAL_SPACE must be true or false")
	}
	a, err := newRunAttestor(os.Getenv("ATTESTATION_TOKEN_AUDIENCE"))
	if err != nil {
		return nil, err
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/proof", a.handleProof)
	// Proof tokens must not become a public bearer-token mint. Future deployment
	// wiring must authorize retrieval through a local gateway/protected channel.
	return &http.Server{Addr: "127.0.0.1:8085", Handler: mux, ReadHeaderTimeout: 5 * time.Second}, nil
}

// Canonical bytes: ASCII domain including NUL, followed by each tuple field
// prefixed by its unsigned 32-bit big-endian byte length. Order: decoded
// challenge (32 bytes), raw Ed25519 public key (32 bytes), audience (ASCII).
func canonicalRunBinding(challenge, publicKey, audience string) ([]byte, error) {
	if !runChallengePattern.MatchString(challenge) {
		return nil, fmt.Errorf("challenge must be 64 lowercase hex characters")
	}
	if !validRunAudience(audience) {
		return nil, fmt.Errorf("invalid audience")
	}
	key, err := base64.RawURLEncoding.DecodeString(publicKey)
	if err != nil || len(key) != ed25519.PublicKeySize || base64.RawURLEncoding.EncodeToString(key) != publicKey {
		return nil, fmt.Errorf("run public key must be canonical base64url Ed25519")
	}
	nonce, _ := hex.DecodeString(challenge)
	canonical := []byte(runBindingDomain)
	for _, field := range [][]byte{nonce, key, []byte(audience)} {
		canonical = binary.BigEndian.AppendUint32(canonical, uint32(len(field)))
		canonical = append(canonical, field...)
	}
	return canonical, nil
}

func (a *runAttestor) handleProof(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	reject := func(status int, reason string) {
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(map[string]any{"proof_version": runProofVersion, "error": map[string]string{"message": reason}})
	}
	if r.Method != http.MethodGet {
		reject(http.StatusMethodNotAllowed, "only GET is supported")
		return
	}
	if r.ContentLength != 0 {
		reject(http.StatusBadRequest, "proof request bodies are forbidden")
		return
	}
	query, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		reject(http.StatusBadRequest, "invalid proof query")
		return
	}
	for key, values := range query {
		if (key != "nonce" && key != "audience") || len(values) != 1 {
			reject(http.StatusBadRequest, "unsupported or duplicate proof parameter; run keys are never accepted")
			return
		}
	}
	// The workload chooses its configured audience, as required by the launcher
	// API. An optional caller hint can only confirm that same audience.
	if values, ok := query["audience"]; ok && values[0] != a.audience {
		reject(http.StatusBadRequest, "audience mismatch")
		return
	}
	challenge := query.Get("nonce")
	canonical, err := canonicalRunBinding(challenge, a.publicKey, a.audience)
	if err != nil {
		reject(http.StatusBadRequest, err.Error())
		return
	}
	digest := sha256.Sum256(canonical)
	body, _ := json.Marshal(struct {
		Audience  string   `json:"audience"`
		TokenType string   `json:"token_type"`
		Nonces    []string `json:"nonces"`
	}{a.audience, "OIDC", []string{hex.EncodeToString(digest[:])}})
	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, launcherTokenURL, bytes.NewReader(body))
	if err != nil {
		reject(http.StatusInternalServerError, "cannot construct launcher request")
		return
	}
	req.Header.Set("Content-Type", "application/json")
	response, err := a.client.Do(req)
	if err != nil {
		reject(http.StatusBadGateway, "Confidential Space launcher unavailable")
		return
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		reject(http.StatusBadGateway, "Confidential Space launcher rejected request")
		return
	}
	token, err := io.ReadAll(io.LimitReader(response.Body, maxLauncherTokenBytes+1))
	if err != nil || len(token) == 0 || len(token) > maxLauncherTokenBytes {
		reject(http.StatusBadGateway, "invalid launcher token response")
		return
	}
	// Return opaque evidence, never a local 'verified' flag. The independent
	// verifier must check the Google signature and all required policy claims.
	proof := runProof{ProofVersion: runProofVersion, Nonce: challenge, Audience: a.audience, RunPublicKey: a.publicKey,
		RunSignature: base64.RawURLEncoding.EncodeToString(ed25519.Sign(a.privateKey, canonical))}
	proof.Attestation.Token = strings.TrimSpace(string(token))
	if proof.Attestation.Token == "" {
		reject(http.StatusBadGateway, "empty launcher token")
		return
	}
	_ = json.NewEncoder(w).Encode(proof)
}
