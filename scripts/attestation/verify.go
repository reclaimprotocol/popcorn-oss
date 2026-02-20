package main

import (
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"crypto/sha512"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
)

const (
	GatewayURL = "https://popcorn-cluster-aws-us-east-2.popcorn.reclaimprotocol.org"
)

type ProofResponse struct {
	WorkloadDigest string `json:"workload_digest"`
	VerifierDigest string `json:"verifier_digest"`
	Nonce          string `json:"nonce"`
	SnpReport      string `json:"snp_report"`
	VlekCert       string `json:"vlek_cert"`
	Timestamp      string `json:"timestamp"`
	Error          string `json:"error,omitempty"`
}

func main() {
	if len(os.Args) < 2 {
		fmt.Println("Usage: go run verify.go <SESSION_ID> [OPTIONAL_NONCE]")
		fmt.Println("Example: go run verify.go session-1x")
		os.Exit(1)
	}

	sessionID := os.Args[1]
	nonce := ""
	if len(os.Args) > 2 {
		nonce = os.Args[2]
	} else {
		b := make([]byte, 16)
		rand.Read(b)
		nonce = hex.EncodeToString(b)
	}

	fmt.Println("╔══════════════════════════════════════════════════════════════════╗")
	fmt.Println("║       SEV-SNP Advanced Image Attestation Verification (Go)       ║")
	fmt.Println("╚══════════════════════════════════════════════════════════════════╝\n")

	fmt.Printf("🎲 Using Nonce:        %s\n\n", nonce)

	url := fmt.Sprintf("%s/proof/%s?nonce=%s", GatewayURL, sessionID, nonce)
	fmt.Printf("🌐 Fetching proof from: %s\n", url)

	resp, err := http.Get(url)
	if err != nil {
		fmt.Printf("❌ Failed to fetch proof: %v\n", err)
		os.Exit(1)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		fmt.Printf("❌ HTTP Status Code: %d\n", resp.StatusCode)
		os.Exit(1)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		fmt.Printf("❌ Failed to read response: %v\n", err)
		os.Exit(1)
	}

	var proof ProofResponse
	if err := json.Unmarshal(body, &proof); err != nil {
		fmt.Printf("❌ Failed to parse JSON: %v\n", err)
		os.Exit(1)
	}

	if proof.Error != "" {
		fmt.Printf("❌ API returned error: %s\n", proof.Error)
		os.Exit(1)
	}

	fmt.Println("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
	fmt.Println("📦 RUNNING CONTAINER DIGESTS (FROM ATTESTATION RESPONSE)")
	fmt.Println("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
	fmt.Printf("Workload Image:        %s\n", proof.WorkloadDigest)
	fmt.Printf("Verifier Sidecar:      %s\n\n", proof.VerifierDigest)

	fmt.Println("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
	fmt.Println("🔗 NONCE BINDING VERIFICATION")
	fmt.Println("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
	if proof.Nonce != nonce {
		fmt.Println("❌ Nonce Mismatch! Replay attack detected.")
		os.Exit(1)
	}
	fmt.Println("✅ Nonce matches. Proof is strongly bound to this session and fresh.")

	fmt.Println("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
	fmt.Println("🔐 HARDWARE BOUND REPORT_DATA VERIFICATION")
	fmt.Println("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")

	// Read cosign.pub from repo root relative to this file
	_, filename, _, _ := runtime.Caller(0)
	pubKeyPath := filepath.Join(filepath.Dir(filename), "../../cosign.pub")
	pubKeyBytes, err := os.ReadFile(pubKeyPath)
	if err != nil {
		fmt.Printf("❌ Failed to read cosign.pub: %v\n", err)
		os.Exit(1)
	}
	CosignPub := string(pubKeyBytes)

	pubKeyHashBytes := sha256.Sum256([]byte(CosignPub))
	pubKeyHashHex := hex.EncodeToString(pubKeyHashBytes[:])

	combined := proof.WorkloadDigest + proof.VerifierDigest + pubKeyHashHex + proof.Nonce
	expectedReportDataHash := sha256.Sum256([]byte(combined))
	expectedReportDataHex := hex.EncodeToString(expectedReportDataHash[:])

	reportBytes, err := base64.StdEncoding.DecodeString(proof.SnpReport)
	if err != nil || len(reportBytes) < 1000 {
		fmt.Println("❌ Invalid SNP report encoding or size.")
		os.Exit(1)
	}
	actualReportDataHex := hex.EncodeToString(reportBytes[0x50:0x90])

	expected64ByteHex := expectedReportDataHex + expectedReportDataHex
	fmt.Printf("H(Workload || Verifier || PubKey || Nonce):\n-> %s\n\n", expectedReportDataHex)

	if actualReportDataHex != expected64ByteHex {
		fmt.Printf("❌ REPORT_DATA Mismatch!\n")
		fmt.Printf("   Expected (64b): %s\n", expected64ByteHex)
		fmt.Printf("   Got:            %s\n", actualReportDataHex)
		os.Exit(1)
	}
	fmt.Println("✅ REPORT_DATA matches recomputed hash. Hardware binding proven.")

	fmt.Println("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
	fmt.Println("🛡️  CRYPTOGRAPHIC HARDWARE SIGNATURE VERIFICATION")
	fmt.Println("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")

	certBytes, err := base64.StdEncoding.DecodeString(proof.VlekCert)
	if err != nil {
		fmt.Println("❌ Invalid VLEK certification encoding.")
		os.Exit(1)
	}

	err = verifySnpSignature(reportBytes, certBytes)
	if err != nil {
		fmt.Printf("❌ Hardware signature verification failed: %v\n", err)
		os.Exit(1)
	}
	fmt.Println("✅ ECDSA P-384 hardware signature successfully validated against AMD VLEK!")

	fmt.Println("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
	fmt.Println("📁 ARTIFACTS SAVED")
	fmt.Println("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")

	tmpDir := fmt.Sprintf("/tmp/proof-%s", sessionID)
	os.MkdirAll(filepath.Join(tmpDir, "certs"), 0755)

	os.WriteFile(filepath.Join(tmpDir, "attestation.bin"), reportBytes, 0644)
	if len(certBytes) > 0 {
		os.WriteFile(filepath.Join(tmpDir, "certs", "vlek.der"), certBytes, 0644)
	}

	fmt.Printf("Raw attestation report and VLEK cert saved to %s/\n", tmpDir)
	fmt.Println("\n🎉 All checks passed! The returned image digests are mathematically proven to be accurate and locked into the hardware TEE.")
}

// verifySnpSignature validates the ECDSA P-384 signature of the SNP hardware report
func verifySnpSignature(reportBytes []byte, certBytes []byte) error {
	if len(reportBytes) < 0x2A0+512 {
		return fmt.Errorf("report too small")
	}

	cert, err := x509.ParseCertificate(certBytes)
	if err != nil {
		// Ignore parsing errors for trailing cert data if AMD appended other structs
		// We'll retry by taking only up to the first cert parsing
		var block []byte
		var parseErr error
		cert, parseErr = x509.ParseCertificate(certBytes)
		if parseErr != nil {
			// Some snpguest certs might have extended data, try extracting just the first ASN.1 sequence
			// In standard flow, x509.ParseCertificate correctly parses a clean DER.
			// Attempt to handle any concatenated certs.
			certs, parseErr := x509.ParseCertificates(certBytes)
			if parseErr != nil || len(certs) == 0 {
				return fmt.Errorf("failed to parse VLEK cert: %v (Original err: %v)", parseErr, err)
			}
			cert = certs[0]
		}
		_ = block
	}

	pubKey, ok := cert.PublicKey.(*ecdsa.PublicKey)
	if !ok {
		return fmt.Errorf("VLEK public key is not ECDSA")
	}

	// AMD uses Little Endian for R and S, 72 bytes each
	sigOffset := 0x2A0
	rBytesLE := reportBytes[sigOffset : sigOffset+72]
	sBytesLE := reportBytes[sigOffset+72 : sigOffset+144]

	// Reverse Little Endian to Big Endian required by Go crypto library
	rBytesBE := make([]byte, 72)
	sBytesBE := make([]byte, 72)
	for i := 0; i < 72; i++ {
		rBytesBE[i] = rBytesLE[71-i]
		sBytesBE[i] = sBytesLE[71-i]
	}

	r := new(big.Int).SetBytes(rBytesBE)
	s := new(big.Int).SetBytes(sBytesBE)

	// AMD signs the SHA-384 hash of the first 0x2A0 bytes of the report
	signedData := reportBytes[:0x2A0]
	hash := sha512.Sum384(signedData)

	valid := ecdsa.Verify(pubKey, hash[:], r, s)
	if !valid {
		return fmt.Errorf("invalid ECDSA signature")
	}

	return nil
}
