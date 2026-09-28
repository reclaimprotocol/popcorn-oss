package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

// MOCK launcher, TEST ONLY: no Google token or TEE is used by these tests.
func mockLauncher(t *testing.T, handler http.HandlerFunc) *http.Client {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "popcorn-cs-test-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	socket := filepath.Join(dir, "launcher.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: handler}
	go server.Serve(listener)
	t.Cleanup(func() { server.Close() })
	client := launcherHTTPClient(socket)
	t.Cleanup(client.CloseIdleConnections)
	return client
}

func TestRunBindingPublicVector(t *testing.T) {
	data, err := os.ReadFile("testdata/run-binding.json")
	if err != nil {
		t.Fatal(err)
	}
	var vector struct {
		Challenge string `json:"challenge"`
		Key       string `json:"run_public_key"`
		Audience  string `json:"audience"`
		Canonical string `json:"canonical_hex"`
		Hash      string `json:"sha256"`
	}
	if err := json.Unmarshal(data, &vector); err != nil {
		t.Fatal(err)
	}
	canonical, err := canonicalRunBinding(vector.Challenge, vector.Key, vector.Audience)
	if err != nil {
		t.Fatal(err)
	}
	if hex.EncodeToString(canonical) != vector.Canonical {
		t.Fatal("canonical bytes differ from shared public vector")
	}
	hash := sha256.Sum256(canonical)
	if hex.EncodeToString(hash[:]) != vector.Hash {
		t.Fatal("binding digest mismatch")
	}
	for _, bad := range []string{vector.Key + "=", "bad", " " + vector.Key} {
		if _, err := canonicalRunBinding(vector.Challenge, bad, vector.Audience); err == nil {
			t.Fatal("accepted malformed public key")
		}
	}
}

func TestRunKeyMOCKLauncherAndProcessLifetime(t *testing.T) {
	t.Setenv("RUN_PRIVATE_KEY", "TEST ONLY: must never be imported")
	t.Setenv("RUN_PUBLIC_KEY", "TEST ONLY: must never be imported")
	a, err := newRunAttestor("https://verifier.example")
	if err != nil {
		t.Fatal(err)
	}
	other, err := newRunAttestor(a.audience)
	if err != nil {
		t.Fatal(err)
	}
	if a.publicKey == other.publicKey {
		t.Fatal("new process/run did not get a new key")
	}
	requests := make(chan map[string]any, 2)
	a.client = mockLauncher(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.URL.Path != "/v1/token" || r.Host != "localhost" || r.Header.Get("Content-Type") != "application/json" {
			t.Error("wrong launcher protocol")
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		requests <- body
		w.Write([]byte("MOCK.LAUNCHER.TOKEN"))
	})
	for _, challenge := range []string{strings.Repeat("ab", 32), strings.Repeat("cd", 32)} {
		rec := httptest.NewRecorder()
		a.handleProof(rec, httptest.NewRequest("GET", "http://127.0.0.1:8085/proof?nonce="+challenge+"&audience=https://verifier.example", nil))
		if rec.Code != 200 {
			t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
		}
		var proof runProof
		if err := json.Unmarshal(rec.Body.Bytes(), &proof); err != nil {
			t.Fatal(err)
		}
		if proof.RunPublicKey != a.publicKey || proof.Nonce != challenge || proof.Audience != a.audience || proof.ProofVersion != runProofVersion || proof.Attestation.Token != "MOCK.LAUNCHER.TOKEN" {
			t.Fatal("unexpected proof fields")
		}
		canonical, _ := canonicalRunBinding(challenge, proof.RunPublicKey, proof.Audience)
		hash := sha256.Sum256(canonical)
		request := <-requests
		if len(request) != 3 || request["audience"] != a.audience || request["token_type"] != "OIDC" {
			t.Fatalf("unexpected launcher request: %#v", request)
		}
		nonces, ok := request["nonces"].([]any)
		if !ok || len(nonces) != 1 || nonces[0] != hex.EncodeToString(hash[:]) {
			t.Fatal("launcher did not receive the tuple hash")
		}
		signature, _ := base64.RawURLEncoding.DecodeString(proof.RunSignature)
		public, _ := base64.RawURLEncoding.DecodeString(proof.RunPublicKey)
		if !ed25519.Verify(public, canonical, signature) {
			t.Fatal("run signature invalid")
		}
		if bytes.Contains(rec.Body.Bytes(), []byte(base64.RawURLEncoding.EncodeToString(a.privateKey))) {
			t.Fatal("private key leaked")
		}
		if rec.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("proof must not be cached")
		}
	}
}

func TestRunProofHostGuardMOCKLauncher(t *testing.T) {
	a, err := newRunAttestor("https://verifier.example")
	if err != nil {
		t.Fatal(err)
	}
	var minted atomic.Int32
	a.client = mockLauncher(t, func(w http.ResponseWriter, r *http.Request) {
		minted.Add(1)
		w.Write([]byte("MOCK.LAUNCHER.TOKEN"))
	})
	challenge := strings.Repeat("ab", 32)
	for _, tc := range []struct{ name, host string }{
		{"missing", ""},
		{"attacker_domain", "attacker.example:8085"},
		{"loopback_subdomain", "127.0.0.1.attacker.example:8085"},
		{"localhost_subdomain", "localhost.attacker.example:8085"},
		{"alternate_loopback", "127.0.0.2:8085"},
		{"wildcard", "0.0.0.0:8085"},
		{"ipv6_loopback", "[::1]:8085"},
		{"ipv4_mapped_ipv6", "[::ffff:127.0.0.1]:8085"},
		{"short_ipv4", "127.1:8085"},
		{"decimal_ipv4", "2130706433:8085"},
		{"wrong_port", "127.0.0.1:8086"},
		{"localhost_wrong_port", "localhost:8086"},
		{"missing_port", "127.0.0.1"},
		{"localhost_missing_port", "localhost"},
		{"empty_port", "localhost:"},
		{"port_leading_zero", "localhost:08085"},
		{"uppercase", "LOCALHOST:8085"},
		{"trailing_dot", "localhost.:8085"},
		{"leading_space", " localhost:8085"},
		{"trailing_space", "localhost:8085 "},
		{"url", "http://localhost:8085"},
		{"userinfo", "attacker.example@localhost:8085"},
		{"comma_separated", "localhost:8085,attacker.example:8085"},
		{"path", "localhost:8085/proof"},
		{"multiple_ports", "localhost:8085:8085"},
		{"newline", "localhost:8085\r\nHost: attacker.example:8085"},
		{"nul", "localhost:8085\x00"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest("GET", "http://127.0.0.1:8085/proof?nonce="+challenge, nil)
			// Set Host directly to exercise the handler even for malformed values
			// net/http would reject on the wire. URL/header hints must not bypass it.
			req.Host = tc.host
			req.Header.Set("Host", "127.0.0.1:8085")
			req.Header.Set("X-Forwarded-Host", "localhost:8085")
			req.Header.Set("Forwarded", "host=localhost:8085")
			rec := httptest.NewRecorder()
			a.handleProof(rec, req)
			if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "unapproved proof request Host") {
				t.Errorf("expected Host rejection: %d %s", rec.Code, rec.Body.String())
			}
			if minted.Load() != 0 {
				t.Fatal("unapproved Host reached MOCK launcher token minting")
			}
			if strings.Contains(rec.Body.String(), "run_signature") || strings.Contains(rec.Body.String(), "MOCK.LAUNCHER.TOKEN") {
				t.Fatal("Host rejection returned a signature or MOCK token")
			}
		})
	}
	for _, host := range []string{"127.0.0.1:8085", "localhost:8085"} {
		t.Run(host, func(t *testing.T) {
			before := minted.Load()
			rec := httptest.NewRecorder()
			a.handleProof(rec, httptest.NewRequest("GET", "http://"+host+"/proof?nonce="+challenge, nil))
			var proof runProof
			if err := json.Unmarshal(rec.Body.Bytes(), &proof); err != nil {
				t.Fatal(err)
			}
			if rec.Code != http.StatusOK || minted.Load() != before+1 || proof.Attestation.Token != "MOCK.LAUNCHER.TOKEN" {
				t.Fatalf("approved Host did not mint exactly one MOCK token: %d %s", rec.Code, rec.Body.String())
			}
			canonical, _ := canonicalRunBinding(challenge, a.publicKey, a.audience)
			signature, _ := base64.RawURLEncoding.DecodeString(proof.RunSignature)
			if !ed25519.Verify(a.privateKey.Public().(ed25519.PublicKey), canonical, signature) {
				t.Fatal("approved Host did not produce a valid run signature")
			}
		})
	}
}

func TestRunProofRejectsSuppliedKeysAndInvalidRequests(t *testing.T) {
	a, _ := newRunAttestor("https://verifier.example")
	// No launcher is available. Invalid requests must fail before any IPC.
	a.client = launcherHTTPClient(filepath.Join(t.TempDir(), "missing.sock"))
	base := "/proof?nonce=" + strings.Repeat("ab", 32)
	for _, query := range []string{
		base + "&run_public_key=supplied", base + "&run_private_key=supplied", base + "&key=supplied",
		base + "&nonce=" + strings.Repeat("cd", 32), base + "&audience=https://other.example",
		base + "&audience=", base + "&audience=x&audience=y", base + "&%xx=invalid",
		"/proof", "/proof?nonce=" + strings.Repeat("AB", 32), "/proof?nonce=ab",
	} {
		t.Run(query, func(t *testing.T) {
			rec := httptest.NewRecorder()
			a.handleProof(rec, httptest.NewRequest("GET", "http://127.0.0.1:8085"+query, nil))
			if rec.Code != 400 {
				t.Fatalf("accepted bad query: %d %s", rec.Code, rec.Body.String())
			}
		})
	}
	for _, method := range []string{"GET", "POST"} {
		rec := httptest.NewRecorder()
		a.handleProof(rec, httptest.NewRequest(method, "http://127.0.0.1:8085"+base, strings.NewReader(`{"run_private_key":"supplied"}`)))
		if rec.Code != 400 && rec.Code != 405 {
			t.Fatal("accepted a request body")
		}
	}
}

func TestRunProofMOCKLauncherFailuresAreClosed(t *testing.T) {
	for _, kind := range []string{"missing", "error", "redirect", "empty", "oversize"} {
		t.Run(kind, func(t *testing.T) {
			a, _ := newRunAttestor("https://verifier.example")
			a.client = launcherHTTPClient(filepath.Join(t.TempDir(), "missing.sock"))
			if kind != "missing" {
				a.client = mockLauncher(t, func(w http.ResponseWriter, r *http.Request) {
					switch kind {
					case "error":
						http.Error(w, "MOCK launcher failure", 500)
					case "redirect":
						http.Redirect(w, r, "http://other.example/token", 307)
					case "empty":
						w.Write([]byte("  "))
					case "oversize":
						w.Write(bytes.Repeat([]byte("x"), maxLauncherTokenBytes+1))
					}
				})
			}
			rec := httptest.NewRecorder()
			a.handleProof(rec, httptest.NewRequest("GET", "http://127.0.0.1:8085/proof?nonce="+strings.Repeat("ab", 32), nil))
			if rec.Code != 502 || strings.Contains(rec.Body.String(), "run_signature") {
				t.Fatalf("expected closed failure: %d %s", rec.Code, rec.Body.String())
			}
		})
	}
}

func TestConfidentialSpaceStartupIsExplicit(t *testing.T) {
	t.Setenv("POPCORN_CONFIDENTIAL_SPACE", "")
	if server, err := confidentialSpaceServer(); server != nil || err != nil {
		t.Fatal("legacy runtime unexpectedly enabled CS")
	}
	t.Setenv("POPCORN_CONFIDENTIAL_SPACE", "true")
	for _, audience := range []string{"", "https://sts.google.com", "https://sts.googleapis.com", "a\nb", "é", strings.Repeat("a", 513)} {
		t.Setenv("ATTESTATION_TOKEN_AUDIENCE", audience)
		if _, err := confidentialSpaceServer(); err == nil {
			t.Fatal("accepted invalid configured audience")
		}
	}
	t.Setenv("ATTESTATION_TOKEN_AUDIENCE", "https://verifier.example")
	server, err := confidentialSpaceServer()
	if err != nil || server == nil || server.Addr != "127.0.0.1:8085" {
		t.Fatal("CS proof server missing")
	}
}
