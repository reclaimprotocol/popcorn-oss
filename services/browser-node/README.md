# Browser Node

This directory contains the browser runtime image source. Browser startup happens here; attestation is handled by the separate `browser-runtime-attestor` sidecar in `services/attestor`.

## Directory Structure

```text
services/browser-node/
├── entrypoint.sh          # Container entrypoint script
├── Dockerfile             # Browser runtime image definition
└── README.md              # This documentation
```

## Runtime Flow

When a browser pod starts, `entrypoint.sh`:

1. Resolves the pod IP address.
2. Starts Agones health pings.
3. Resolves direct WebRTC networking when Agones exposes a node allocation.
4. Refreshes TURN credentials when configured.
5. Starts the browser wrapper.

## Attestation

The browser pod includes a `browser-runtime-attestor` sidecar when `browserRuntimeAttestor.enabled` is true in the browser-fleet chart. That sidecar exposes `/proof` on port `8085`, verifies the running `browser-runtime` and `browser-runtime-attestor` image signatures, and returns the current GCP AMD SEV v3 attestation proof.

Use the verifier in `scripts/attestation`:

```bash
node scripts/attestation/verify_gcp_proof.js --session <SESSION_ID> --nonce <HEX_NONCE> --gateway-url <GATEWAY_URL>
```

The browser runtime image does not generate attestation proofs or upload attestation artifacts.

## Development

### Building the Image

```bash
make build
```

### Runtime Dependencies

- `curl` and `jq` for Kubernetes, Agones, and TURN setup from the entrypoint
- Browser/runtime dependencies inherited from the pinned base image

### Environment Variables

- `POD_NAME`, `POD_NAMESPACE`, `NODE_NAME` - injected from Kubernetes downward API
- `TURN_KEY_ID`, `TURN_API_TOKEN`, `NEKO_ICESERVERS` - TURN configuration
- `NEKO_*` - browser session runtime settings
