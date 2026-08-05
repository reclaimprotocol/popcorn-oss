# Browser Runtime Attestor

The attestor is an optional same-pod service for confidential browser
workloads. It verifies the deployed browser-runtime and attestor image digests,
collects GCP confidential-computing evidence, and returns a nonce-bound proof.

## HTTP Interface

- `GET /health` returns `200 OK` when the service is running.
- `GET /proof?nonce=<hex>` returns the versioned attestation response.

The service listens on TCP port `8085`. The browser-fleet chart exposes it only
when `browserRuntimeAttestor.enabled=true`.

## Runtime Requirements

- A GCP Confidential GKE node with the TPM event log mounted.
- In-cluster Kubernetes access to inspect the current Pod and Node.
- A workload identity allowed to request GCP attestation tokens.
- `/etc/cosign.pub`, used to verify both deployed image signatures.

Configuration is supplied through `ATTESTATION_TOKEN_AUDIENCE`,
`CONFIDENTIAL_COMPUTING_LOCATION`, `TPM_EVENT_LOG_PATH`, and the Pod-provided
`HOSTNAME` value. See [Attestation](../../docs/attestation.md) for the complete
cluster, IAM, signing, and Helm setup.

## Develop

```bash
go test ./...
```

The Docker build context must contain the deployment's `cosign.pub`. Release
automation supplies that key before building the image.
