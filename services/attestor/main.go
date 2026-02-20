package main

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

const (
	Port         = "8085"
	PubKeyPath   = "/etc/cosign.pub"
	ReportFile   = "/tmp/report.bin"
	RequestFile  = "/tmp/snp_request.bin"
	CertsDir     = "/tmp/certs"
	WorkloadName = "neko"
	AttestorName = "attestor"
)

type ProofResponse struct {
	WorkloadDigest string `json:"workload_digest"`
	VerifierDigest string `json:"verifier_digest"`
	Nonce          string `json:"nonce"`
	SnpReport      string `json:"snp_report"` // base64
	VlekCert       string `json:"vlek_cert"`  // base64
	Timestamp      string `json:"timestamp"`
	Error          string `json:"error,omitempty"`
}

func main() {
	log.Printf("Starting Attestor service on port %s", Port)

	http.HandleFunc("/proof", handleProof)
	http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("OK"))
	})

	log.Fatal(http.ListenAndServe(":"+Port, nil))
}

func handleProof(w http.ResponseWriter, r *http.Request) {
	nonce := r.URL.Query().Get("nonce")
	if nonce == "" {
		http.Error(w, "query parameter 'nonce' is required", http.StatusBadRequest)
		return
	}

	resp, err := generateProof(nonce)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(ProofResponse{Error: err.Error()})
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

func generateProof(nonce string) (ProofResponse, error) {
	// 1. Get Kubernetes config
	config, err := rest.InClusterConfig()
	if err != nil {
		return ProofResponse{}, fmt.Errorf("failed to get in-cluster config: %v", err)
	}

	clientset, err := kubernetes.NewForConfig(config)
	if err != nil {
		return ProofResponse{}, fmt.Errorf("failed to create k8s client: %v", err)
	}

	// 2. Determine pod and namespace
	namespaceBytes, err := os.ReadFile("/var/run/secrets/kubernetes.io/serviceaccount/namespace")
	if err != nil {
		return ProofResponse{}, fmt.Errorf("failed to read k8s namespace: %v", err)
	}
	namespace := string(namespaceBytes)

	podName := os.Getenv("HOSTNAME") // k8s sets this to pod name
	if podName == "" {
		return ProofResponse{}, fmt.Errorf("HOSTNAME env var is empty")
	}

	// 3. Fetch Pod status
	pod, err := clientset.CoreV1().Pods(namespace).Get(context.Background(), podName, metav1.GetOptions{})
	if err != nil {
		return ProofResponse{}, fmt.Errorf("failed to get pod status: %v", err)
	}

	var workloadImageID string
	var verifierImageID string

	for _, status := range pod.Status.ContainerStatuses {
		if status.Name == WorkloadName {
			workloadImageID = status.ImageID
		} else if status.Name == AttestorName {
			verifierImageID = status.ImageID
		}
	}

	if workloadImageID == "" || verifierImageID == "" {
		return ProofResponse{}, fmt.Errorf("could not find imageIDs for %s or %s (found: w=%s, v=%s)", WorkloadName, AttestorName, workloadImageID, verifierImageID)
	}

	// Format is often something like: registry.com/repo@sha256:abc...
	// We'll treat the whole string as the digest identifier for Cosign verification.

	// 4. Verify workload & verifier images with Cosign
	if err := verifyImage(workloadImageID); err != nil {
		return ProofResponse{}, fmt.Errorf("failed to verify workload image %s: %v", workloadImageID, err)
	}
	if err := verifyImage(verifierImageID); err != nil {
		return ProofResponse{}, fmt.Errorf("failed to verify verifier image %s: %v", verifierImageID, err)
	}

	// 5. Read Public Key and compute its hash
	pubKeyContent, err := os.ReadFile(PubKeyPath)
	if err != nil {
		return ProofResponse{}, fmt.Errorf("failed to read public key %s: %v", PubKeyPath, err)
	}
	pubKeyHashBytes := sha256.Sum256(pubKeyContent)
	pubKeyHashHex := fmt.Sprintf("%x", pubKeyHashBytes)

	// 6. Compute REPORT_DATA = H(workload_digest || verifier_digest || pubkey_hash || client_nonce)
	combined := workloadImageID + verifierImageID + pubKeyHashHex + nonce
	reportDataHash := sha256.Sum256([]byte(combined))

	// Pad to 64 bytes - duplicate the hash like the previous implementation
	// to handle potential alignment issues in snpguest
	paddedReportData := make([]byte, 64)
	copy(paddedReportData[0:32], reportDataHash[:])
	copy(paddedReportData[32:64], reportDataHash[:])

	if err := os.WriteFile(RequestFile, paddedReportData, 0644); err != nil {
		return ProofResponse{}, fmt.Errorf("failed to write request file: %v", err)
	}

	// 7. Request SNP Report
	cmd := exec.Command("/usr/local/bin/snpguest", "report", ReportFile, RequestFile)
	if out, err := cmd.CombinedOutput(); err != nil {
		return ProofResponse{}, fmt.Errorf("snpguest report failed: %v (%s)", err, out)
	}

	reportBytes, err := os.ReadFile(ReportFile)
	if err != nil {
		return ProofResponse{}, fmt.Errorf("failed to read SNP report: %v", err)
	}

	// 8. Request VLEK certs
	os.MkdirAll(CertsDir, 0755)
	certCmd := exec.Command("/usr/local/bin/snpguest", "certificates", "der", CertsDir)
	if out, err := certCmd.CombinedOutput(); err != nil {
		log.Printf("warning: snpguest certificates failed: %v (%s)", err, out)
		// Don't fail the whole request, maybe we are on mock hardware
	}

	var vlekCert string
	vlekPath := fmt.Sprintf("%s/vlek.der", CertsDir)
	if certBytes, err := os.ReadFile(vlekPath); err == nil {
		vlekCert = base64.StdEncoding.EncodeToString(certBytes)
	}

	// 9. Return Response
	return ProofResponse{
		WorkloadDigest: workloadImageID,
		VerifierDigest: verifierImageID,
		Nonce:          nonce,
		SnpReport:      base64.StdEncoding.EncodeToString(reportBytes),
		VlekCert:       vlekCert,
		Timestamp:      time.Now().UTC().Format(time.RFC3339),
	}, nil
}

func verifyImage(imageID string) error {
	// e.g. docker://XXXXXXXX.dkr.ecr... Remove prefix if present, but K8s usually has `docker-pullable://` prefix
	cleanID := strings.TrimPrefix(imageID, "docker-pullable://")
	cleanID = strings.TrimPrefix(cleanID, "docker://")

	log.Printf("Verifying Cosign signature for: %s", cleanID)
	cmd := exec.Command("/usr/local/bin/cosign", "verify", "--key", PubKeyPath, cleanID)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("cosign failed: %v, output: %s", err, out)
	}
	return nil
}
