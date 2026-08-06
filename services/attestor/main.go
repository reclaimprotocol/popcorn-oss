package main

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"time"

	"cloud.google.com/go/compute/metadata"
	confidentialcomputing "cloud.google.com/go/confidentialcomputing/apiv1"
	ccpb "cloud.google.com/go/confidentialcomputing/apiv1/confidentialcomputingpb"
	"github.com/google/go-containerregistry/pkg/authn"
	"github.com/google/go-containerregistry/pkg/name"
	v1 "github.com/google/go-containerregistry/pkg/v1"
	"github.com/google/go-containerregistry/pkg/v1/remote"
	"github.com/google/go-containerregistry/pkg/v1/types"
	gtpmclient "github.com/google/go-tpm-tools/client"
	attestpb "github.com/google/go-tpm-tools/proto/attest"
	"github.com/google/go-tpm/legacy/tpm2"
	"golang.org/x/oauth2/google"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

const (
	Port                          = "8085"
	PubKeyPath                    = "/etc/cosign.pub"
	WorkloadName                  = "browser-runtime"
	AttestorName                  = "browser-runtime-attestor"
	ProofVersion                  = "v3"
	TeeProvider                   = "gcp"
	TeeTechnology                 = "amd-sev"
	DefaultConfidentialLocation   = "global"
	DefaultAttestationAudience    = "popcorn-attestor"
	DefaultAttestationHTTPTimeout = 30 * time.Second
	DefaultTPMEventLogPath        = "/var/run/cc/tpm0/binary_bios_measurements"
)

type proofResponse struct {
	ProofVersion  string             `json:"proof_version"`
	TeeProvider   string             `json:"tee_provider,omitempty"`
	TeeTechnology string             `json:"tee_technology,omitempty"`
	Nonce         string             `json:"nonce,omitempty"`
	Timestamp     string             `json:"timestamp,omitempty"`
	Workload      *proofContainerRef `json:"workload,omitempty"`
	Verifier      *proofContainerRef `json:"verifier,omitempty"`
	Attestation   *proofAttestation  `json:"attestation,omitempty"`
	Error         *proofError        `json:"error,omitempty"`
}

type proofContainerRef struct {
	ContainerName string `json:"container_name"`
	ImageDigest   string `json:"image_digest"`
}

type proofAttestation struct {
	Token string `json:"token"`
}

type proofError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type runtimeState struct {
	Namespace      string
	PodName        string
	PlatformOS     string
	PlatformArch   string
	WorkloadDigest string
	VerifierDigest string
}

type codedError struct {
	Code       string
	Message    string
	HTTPStatus int
	Err        error
}

func (e *codedError) Error() string {
	if e == nil {
		return ""
	}
	if e.Err == nil {
		return e.Message
	}
	return fmt.Sprintf("%s: %v", e.Message, e.Err)
}

func (e *codedError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Err
}

func newCodedError(code string, status int, message string, err error) *codedError {
	return &codedError{Code: code, HTTPStatus: status, Message: message, Err: err}
}

func main() {
	log.Printf("starting attestor service on port %s", Port)

	http.HandleFunc("/proof", handleProof)
	http.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("OK"))
	})

	log.Fatal(http.ListenAndServe(":"+Port, nil))
}

func handleProof(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Content-Type", "application/json")

	nonce, err := normalizeNonce(r.URL.Query().Get("nonce"))
	if err != nil {
		writeProofError(w, err)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), DefaultAttestationHTTPTimeout)
	defer cancel()

	proof, err := generateProof(ctx, nonce)
	if err != nil {
		writeProofError(w, err)
		return
	}

	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(proof)
}

func generateProof(ctx context.Context, nonce string) (*proofResponse, error) {
	state, err := collectRuntimeState(ctx)
	if err != nil {
		return nil, err
	}
	if err := verifyImages(state); err != nil {
		return nil, err
	}

	token, err := generateTEEProof(ctx, state, nonce)
	if err != nil {
		return nil, err
	}

	return buildProof(state, nonce, token), nil
}

func collectRuntimeState(ctx context.Context) (*runtimeState, error) {
	cfg, err := rest.InClusterConfig()
	if err != nil {
		return nil, newCodedError("KUBERNETES_CONFIG_FAILED", http.StatusInternalServerError, "failed to get in-cluster config", err)
	}

	clientset, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return nil, newCodedError("KUBERNETES_CLIENT_FAILED", http.StatusInternalServerError, "failed to create kubernetes client", err)
	}

	namespaceBytes, err := os.ReadFile("/var/run/secrets/kubernetes.io/serviceaccount/namespace")
	if err != nil {
		return nil, newCodedError("NAMESPACE_READ_FAILED", http.StatusInternalServerError, "failed to read kubernetes namespace", err)
	}
	namespace := strings.TrimSpace(string(namespaceBytes))
	if namespace == "" {
		return nil, newCodedError("NAMESPACE_EMPTY", http.StatusInternalServerError, "kubernetes namespace is empty", nil)
	}

	podName := strings.TrimSpace(os.Getenv("HOSTNAME"))
	if podName == "" {
		return nil, newCodedError("POD_NAME_MISSING", http.StatusInternalServerError, "HOSTNAME env var is empty", nil)
	}

	pod, err := clientset.CoreV1().Pods(namespace).Get(ctx, podName, metav1.GetOptions{})
	if err != nil {
		return nil, newCodedError("POD_LOOKUP_FAILED", http.StatusInternalServerError, "failed to get pod status", err)
	}

	platformOS, platformArch, err := resolvePodPlatform(ctx, clientset, pod)
	if err != nil {
		return nil, err
	}

	specImages := make(map[string]string, len(pod.Spec.Containers))
	for _, container := range pod.Spec.Containers {
		specImages[container.Name] = strings.TrimSpace(container.Image)
	}

	state := &runtimeState{
		Namespace:    namespace,
		PodName:      podName,
		PlatformOS:   platformOS,
		PlatformArch: platformArch,
	}
	for _, status := range pod.Status.ContainerStatuses {
		switch status.Name {
		case WorkloadName:
			state.WorkloadDigest, err = resolveContainerDigest(specImages[status.Name], status.ImageID, platformOS, platformArch)
			if err != nil {
				return nil, newCodedError("WORKLOAD_DIGEST_RESOLUTION_FAILED", http.StatusInternalServerError, fmt.Sprintf("failed to resolve digest for container %q", WorkloadName), err)
			}
		case AttestorName:
			state.VerifierDigest, err = resolveContainerDigest(specImages[status.Name], status.ImageID, platformOS, platformArch)
			if err != nil {
				return nil, newCodedError("VERIFIER_DIGEST_RESOLUTION_FAILED", http.StatusInternalServerError, fmt.Sprintf("failed to resolve digest for container %q", AttestorName), err)
			}
		}
	}

	if state.WorkloadDigest == "" {
		return nil, newCodedError("WORKLOAD_DIGEST_MISSING", http.StatusInternalServerError, fmt.Sprintf("could not find imageID for container %q", WorkloadName), nil)
	}
	if state.VerifierDigest == "" {
		return nil, newCodedError("VERIFIER_DIGEST_MISSING", http.StatusInternalServerError, fmt.Sprintf("could not find imageID for container %q", AttestorName), nil)
	}

	return state, nil
}

func resolvePodPlatform(ctx context.Context, clientset *kubernetes.Clientset, pod *corev1.Pod) (string, string, error) {
	nodeName := strings.TrimSpace(pod.Spec.NodeName)
	if nodeName == "" {
		return "", "", newCodedError("NODE_NAME_MISSING", http.StatusInternalServerError, "pod is not scheduled on a node", nil)
	}

	node, err := clientset.CoreV1().Nodes().Get(ctx, nodeName, metav1.GetOptions{})
	if err != nil {
		return "", "", newCodedError("NODE_LOOKUP_FAILED", http.StatusInternalServerError, fmt.Sprintf("failed to look up node %q", nodeName), err)
	}

	platformOS := strings.TrimSpace(node.Labels["kubernetes.io/os"])
	platformArch := strings.TrimSpace(node.Labels["kubernetes.io/arch"])
	if platformOS == "" || platformArch == "" {
		return "", "", newCodedError("NODE_PLATFORM_MISSING", http.StatusInternalServerError, fmt.Sprintf("node %q is missing kubernetes.io/os or kubernetes.io/arch labels", nodeName), nil)
	}
	return platformOS, platformArch, nil
}

func verifyImages(state *runtimeState) error {
	if err := verifyImage(state.WorkloadDigest); err != nil {
		return newCodedError("WORKLOAD_IMAGE_VERIFICATION_FAILED", http.StatusInternalServerError, fmt.Sprintf("failed to verify workload image %s", state.WorkloadDigest), err)
	}
	if err := verifyImage(state.VerifierDigest); err != nil {
		return newCodedError("VERIFIER_IMAGE_VERIFICATION_FAILED", http.StatusInternalServerError, fmt.Sprintf("failed to verify verifier image %s", state.VerifierDigest), err)
	}
	return nil
}

func resolveContainerDigest(specImage, imageID, platformOS, platformArch string) (string, error) {
	specDirect := normalizeImageDigest(specImage)
	imageIDDirect := normalizeImageDigest(imageID)
	if specDirect != "" && imageIDDirect != "" && specDirect == imageIDDirect {
		return imageIDDirect, nil
	}

	specResolved, err := resolveImageRefDigest(specImage, platformOS, platformArch)
	if err != nil {
		return "", fmt.Errorf("resolve spec image %q: %w", specImage, err)
	}

	imageIDResolved, err := resolveImageRefDigest(imageID, platformOS, platformArch)
	if err != nil {
		return "", fmt.Errorf("resolve imageID %q: %w", imageID, err)
	}

	return chooseResolvedDigest(specResolved, imageIDResolved)
}

func chooseResolvedDigest(specResolved, imageIDResolved string) (string, error) {
	switch {
	case specResolved != "" && imageIDResolved != "":
		if specResolved != imageIDResolved {
			return "", fmt.Errorf("spec digest %s does not match runtime digest %s", specResolved, imageIDResolved)
		}
		return imageIDResolved, nil
	case imageIDResolved != "":
		return imageIDResolved, nil
	case specResolved != "":
		return specResolved, nil
	default:
		return "", fmt.Errorf("no digest could be resolved from spec image or runtime imageID")
	}
}

func generateTEEProof(ctx context.Context, state *runtimeState, nonce string) (string, error) {
	projectID, err := resolveProjectID()
	if err != nil {
		return "", newCodedError("PROJECT_RESOLUTION_FAILED", http.StatusInternalServerError, "failed to resolve gcp project id", err)
	}

	client, err := confidentialcomputing.NewClient(ctx)
	if err != nil {
		return "", newCodedError("ATTESTATION_CLIENT_FAILED", http.StatusInternalServerError, "failed to create confidential computing client", err)
	}
	defer client.Close()

	challenge, err := client.CreateChallenge(ctx, &ccpb.CreateChallengeRequest{
		Parent:    fmt.Sprintf("projects/%s/locations/%s", projectID, confidentialLocation()),
		Challenge: &ccpb.Challenge{},
	})
	if err != nil {
		return "", newCodedError("CHALLENGE_CREATION_FAILED", http.StatusInternalServerError, "failed to create confidential computing challenge", err)
	}
	if challenge.GetName() == "" {
		return "", newCodedError("CHALLENGE_EMPTY", http.StatusInternalServerError, "confidential computing challenge name is empty", nil)
	}
	if challenge.GetTpmNonce() == "" {
		return "", newCodedError("CHALLENGE_NONCE_EMPTY", http.StatusInternalServerError, "confidential computing challenge tpm nonce is empty", nil)
	}

	challengeNonce, err := decodeTPMNonce(challenge.GetTpmNonce())
	if err != nil {
		return "", newCodedError("CHALLENGE_NONCE_DECODE_FAILED", http.StatusInternalServerError, "failed to decode confidential computing challenge nonce", err)
	}

	tpmAttestation, err := collectTPMAttestation(challengeNonce)
	if err != nil {
		return "", err
	}

	digestBinding := runtimeDigestBinding(state)

	resp, err := client.VerifyAttestation(ctx, &ccpb.VerifyAttestationRequest{
		Challenge:      challenge.GetName(),
		TpmAttestation: tpmAttestation,
		TokenOptions: &ccpb.TokenOptions{
			Audience:  attestationAudience(),
			Nonce:     []string{nonce, digestBinding},
			TokenType: ccpb.TokenType_TOKEN_TYPE_OIDC,
		},
	})
	if err != nil {
		return "", newCodedError("ATTESTATION_FAILED", http.StatusInternalServerError, "failed to verify confidential compute attestation", err)
	}

	if token := resp.GetOidcClaimsToken(); token != "" {
		return token, nil
	}
	return "", newCodedError("ATTESTATION_TOKEN_EMPTY", http.StatusInternalServerError, "confidential computing response did not include an attestation token", nil)
}

func decodeTPMNonce(raw string) ([]byte, error) {
	nonce := strings.TrimSpace(raw)
	decoded, err := base64.StdEncoding.DecodeString(nonce)
	if err == nil {
		return decoded, nil
	}
	decoded, rawErr := base64.RawStdEncoding.DecodeString(nonce)
	if rawErr == nil {
		return decoded, nil
	}
	return nil, fmt.Errorf("std: %w; raw: %v", err, rawErr)
}

func collectTPMAttestation(challengeNonce []byte) (*ccpb.TpmAttestation, error) {
	rwc, err := tpm2.OpenTPM()
	if err != nil {
		return nil, newCodedError("TPM_OPEN_FAILED", http.StatusInternalServerError, "failed to open TPM device", err)
	}
	defer rwc.Close()

	ak, err := openGCEAttestationKey(rwc)
	if err != nil {
		return nil, newCodedError("TPM_AK_FAILED", http.StatusInternalServerError, "failed to open GCE attestation key", err)
	}
	defer ak.Close()

	eventLog, err := readTPMEventLog()
	if err != nil {
		return nil, newCodedError("TPM_EVENT_LOG_FAILED", http.StatusInternalServerError, "failed to read TPM event log", err)
	}

	attestation, err := ak.Attest(gtpmclient.AttestOpts{
		Nonce:              challengeNonce,
		TCGEventLog:        eventLog,
		CertChainFetcher:   http.DefaultClient,
		SkipTeeAttestation: true,
		CanonicalEventLog:  nil,
	})
	if err != nil {
		return nil, newCodedError("TPM_ATTESTATION_FAILED", http.StatusInternalServerError, "failed to collect TPM attestation", err)
	}

	return convertTPMAttestation(attestation)
}

func readTPMEventLog() ([]byte, error) {
	path := strings.TrimSpace(os.Getenv("TPM_EVENT_LOG_PATH"))
	if path == "" {
		path = DefaultTPMEventLogPath
	}
	return os.ReadFile(path)
}

func openGCEAttestationKey(rwc interface {
	Read([]byte) (int, error)
	Write([]byte) (int, error)
}) (*gtpmclient.Key, error) {
	if ak, err := gtpmclient.GceAttestationKeyECC(rwc); err == nil {
		return ak, nil
	}
	return gtpmclient.GceAttestationKeyRSA(rwc)
}

func convertTPMAttestation(attestation *attestpb.Attestation) (*ccpb.TpmAttestation, error) {
	if attestation == nil {
		return nil, newCodedError("TPM_ATTESTATION_EMPTY", http.StatusInternalServerError, "TPM attestation is empty", nil)
	}

	quotes := make([]*ccpb.TpmAttestation_Quote, 0, len(attestation.GetQuotes()))
	for _, quote := range attestation.GetQuotes() {
		if quote == nil || quote.GetPcrs() == nil {
			continue
		}
		pcrValues := make(map[int32][]byte, len(quote.GetPcrs().GetPcrs()))
		for idx, value := range quote.GetPcrs().GetPcrs() {
			pcrValues[int32(idx)] = value
		}
		quotes = append(quotes, &ccpb.TpmAttestation_Quote{
			HashAlgo:     int32(quote.GetPcrs().GetHash()),
			PcrValues:    pcrValues,
			RawQuote:     quote.GetQuote(),
			RawSignature: quote.GetRawSig(),
		})
	}

	if len(quotes) == 0 {
		return nil, newCodedError("TPM_QUOTES_EMPTY", http.StatusInternalServerError, "TPM attestation did not contain any quotes", nil)
	}
	if len(attestation.GetAkCert()) == 0 {
		return nil, newCodedError("TPM_AK_CERT_MISSING", http.StatusInternalServerError, "TPM attestation did not contain an AK certificate", nil)
	}

	return &ccpb.TpmAttestation{
		Quotes:            quotes,
		TcgEventLog:       attestation.GetEventLog(),
		CanonicalEventLog: attestation.GetCanonicalEventLog(),
		AkCert:            attestation.GetAkCert(),
		CertChain:         attestation.GetIntermediateCerts(),
	}, nil
}

func buildProof(state *runtimeState, nonce, token string) *proofResponse {
	return &proofResponse{
		ProofVersion:  ProofVersion,
		TeeProvider:   TeeProvider,
		TeeTechnology: TeeTechnology,
		Nonce:         nonce,
		Timestamp:     time.Now().UTC().Format(time.RFC3339),
		Workload: &proofContainerRef{
			ContainerName: WorkloadName,
			ImageDigest:   state.WorkloadDigest,
		},
		Verifier: &proofContainerRef{
			ContainerName: AttestorName,
			ImageDigest:   state.VerifierDigest,
		},
		Attestation: &proofAttestation{Token: token},
	}
}

func writeProofError(w http.ResponseWriter, err error) {
	status := http.StatusInternalServerError
	code := "INTERNAL_ERROR"
	message := err.Error()
	var coded *codedError
	if errors.As(err, &coded) {
		status = coded.HTTPStatus
		code = coded.Code
		message = coded.Message
		if coded.Err != nil {
			log.Printf("%s: %v", coded.Code, coded.Err)
		}
	} else {
		log.Printf("unexpected proof error: %v", err)
	}

	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(&proofResponse{
		ProofVersion: ProofVersion,
		Error: &proofError{
			Code:    code,
			Message: message,
		},
	})
}

func verifyImage(imageID string) error {
	cleanID := normalizeImageDigest(imageID)
	if cleanID == "" {
		return fmt.Errorf("image digest is empty")
	}

	args := []string{"verify", "--key", PubKeyPath}
	if token, err := registryTokenForImage(cleanID); err != nil {
		return err
	} else if token != "" {
		args = append(args, "--registry-token", token)
	}
	args = append(args, cleanID)

	log.Printf("verifying cosign signature for %s", cleanID)
	cmd := exec.Command("/usr/local/bin/cosign", args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("cosign verify failed: %v (%s)", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func resolveImageRefDigest(imageRef, platformOS, platformArch string) (string, error) {
	cleanRef := normalizeImageDigest(imageRef)
	if cleanRef == "" {
		return "", nil
	}

	ref, err := name.ParseReference(cleanRef, name.WeakValidation)
	if err != nil {
		return "", fmt.Errorf("parse image reference: %w", err)
	}

	opts := []remote.Option{}
	if token, err := registryTokenForImage(cleanRef); err != nil {
		return "", err
	} else if token != "" {
		opts = append(opts, remote.WithAuth(authn.FromConfig(authn.AuthConfig{
			RegistryToken: token,
		})))
	}

	desc, err := remote.Get(ref, opts...)
	if err != nil {
		return "", fmt.Errorf("fetch image descriptor: %w", err)
	}

	switch desc.MediaType {
	case types.OCIImageIndex, types.DockerManifestList:
		index, err := desc.ImageIndex()
		if err != nil {
			return "", fmt.Errorf("load image index: %w", err)
		}
		indexManifest, err := index.IndexManifest()
		if err != nil {
			return "", fmt.Errorf("read image index manifest: %w", err)
		}
		childDigest, err := selectChildDigest(indexManifest.Manifests, platformOS, platformArch)
		if err != nil {
			return "", err
		}
		return ref.Context().Digest(childDigest.String()).String(), nil
	case types.OCIManifestSchema1, types.DockerManifestSchema2:
		return ref.Context().Digest(desc.Digest.String()).String(), nil
	default:
		return "", fmt.Errorf("unsupported image media type %q for %s", desc.MediaType, cleanRef)
	}
}

func selectChildDigest(manifests []v1.Descriptor, platformOS, platformArch string) (v1.Hash, error) {
	for _, manifest := range manifests {
		if manifest.Platform == nil {
			continue
		}
		if manifest.Platform.OS == platformOS && manifest.Platform.Architecture == platformArch {
			return manifest.Digest, nil
		}
	}
	return v1.Hash{}, fmt.Errorf("no child manifest found for platform %s/%s", platformOS, platformArch)
}

func registryTokenForImage(imageID string) (string, error) {
	if !strings.Contains(imageID, ".pkg.dev/") {
		return "", nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	creds, err := google.FindDefaultCredentials(ctx, "https://www.googleapis.com/auth/cloud-platform")
	if err != nil {
		return "", fmt.Errorf("failed to load Google application default credentials: %w", err)
	}
	token, err := creds.TokenSource.Token()
	if err != nil {
		return "", fmt.Errorf("failed to mint Artifact Registry access token from application default credentials: %w", err)
	}
	if token.AccessToken == "" {
		return "", fmt.Errorf("application default credentials did not return an access token")
	}
	return token.AccessToken, nil
}

func runtimeDigestBinding(state *runtimeState) string {
	payload := strings.Join([]string{
		ProofVersion,
		"workload.container_name=" + WorkloadName,
		"workload.image_digest=" + state.WorkloadDigest,
		"verifier.container_name=" + AttestorName,
		"verifier.image_digest=" + state.VerifierDigest,
	}, "\n")
	sum := sha256.Sum256([]byte(payload))
	return hex.EncodeToString(sum[:])
}

func normalizeImageDigest(imageID string) string {
	cleanID := strings.TrimSpace(imageID)
	cleanID = strings.TrimPrefix(cleanID, "docker-pullable://")
	cleanID = strings.TrimPrefix(cleanID, "docker://")
	return cleanID
}

func normalizeNonce(raw string) (string, error) {
	nonce := strings.TrimSpace(raw)
	if nonce == "" {
		return "", newCodedError("NONCE_REQUIRED", http.StatusBadRequest, "query parameter 'nonce' is required", nil)
	}
	nonce = strings.TrimPrefix(nonce, "0x")
	nonce = strings.TrimPrefix(nonce, "0X")
	if len(nonce) < 10 || len(nonce) > 74 {
		return "", newCodedError("NONCE_INVALID", http.StatusBadRequest, "nonce must be between 10 and 74 hex characters", nil)
	}
	if _, err := hex.DecodeString(nonce); err != nil {
		return "", newCodedError("NONCE_INVALID", http.StatusBadRequest, "nonce must be a valid hex string", err)
	}
	return nonce, nil
}

func resolveProjectID() (string, error) {
	for _, envKey := range []string{"GOOGLE_CLOUD_PROJECT", "GCP_PROJECT", "PROJECT_ID"} {
		if value := strings.TrimSpace(os.Getenv(envKey)); value != "" {
			return value, nil
		}
	}
	if metadata.OnGCE() {
		projectID, err := metadata.ProjectID()
		if err == nil && strings.TrimSpace(projectID) != "" {
			return projectID, nil
		}
		return "", err
	}
	return "", fmt.Errorf("project id not configured and metadata server unavailable")
}

func confidentialLocation() string {
	if value := strings.TrimSpace(os.Getenv("CONFIDENTIAL_COMPUTING_LOCATION")); value != "" {
		return value
	}
	return DefaultConfidentialLocation
}

func attestationAudience() string {
	if value := strings.TrimSpace(os.Getenv("ATTESTATION_TOKEN_AUDIENCE")); value != "" {
		return value
	}
	return DefaultAttestationAudience
}
