# Browser Node - SEV-SNP Attestation Service

This directory contains the browser node service with integrated SEV-SNP attestation that automatically generates and uploads attestation reports to S3.

## Directory Structure

```
services/browser-node/
├── attest.js              # Attestation generation (runs on pod startup)
├── entrypoint.sh          # Container entrypoint script
├── Dockerfile             # Container image definition
├── package.json           # Node.js dependencies (AWS SDK)
├── cosign.pub             # Public key for image signature verification  
├── cosign.key             # Private key (for signing)
├── README.md              # This documentation
└── verification/          # Attestation verification tools
    ├── Dockerfile              # Verification container image
    ├── verify_from_s3.js       # S3 verification script
    └── README.md               # Verification guide
```

## Attestation Flow

### 1. Pod Startup (Automatic)
When a browser pod starts, `attest.js` runs automatically:

1. ✅ Verifies image signature with Cosign
2. ✅ Generates SEV-SNP attestation report with snpguest  
3. ✅ Fetches VLEK certificates from AMD KDS
4. ✅ Uploads to S3:
   - `attestation.bin` (1184 bytes)
   - `certs/vlek.der` (VLEK certificate)
   - `manifest.json` (metadata)

### 2. Public Verification
Anyone can verify attestations from the public S3 bucket:

```
https://popcorn-attestations-us-east-2.s3.us-east-2.amazonaws.com/{POD_NAME}/manifest.json
```

## Verification

### Docker Verification (Recommended)

**Build once:**
```bash
cd services/browser-node/verification
docker build -t attestation-verifier .
```

**Verify any pod:**
```bash
docker run --rm attestation-verifier <POD_NAME>
```

**Example:**
```bash
docker run --rm attestation-verifier browser-fleet-9877p-56ddj
```

**Shows:**
- Manifest info (pod, image digest, timestamp)
- Platform details (SNP version, VMPL, SMT/TSME)
- AMD TCB levels (Boot Loader, TEE, SNP, Microcode)
- Cryptographic identifiers and VLEK verification

### Quick Node.js Verification

Without Docker:
```bash
node services/browser-node/verification/verify_from_s3.js <POD_NAME>
```

Note: VLEK cryptographic verification requires snpguest (included in Docker image).

### Detailed Output

The verification displays:
- **Manifest**: Pod name, image digest, URI, timestamp
- **Platform**: Report version, Guest SVN, VMPL, Policy flags, SMT/TSME status
- **AMD TCB**: Boot Loader, TEE, SNP Firmware, Microcode SVNs
- **Cryptographic IDs**: Report Data (bound to image), Measurement, Chip ID, Report ID
- **VLEK Verification**: Full certificate chain validation

**Note**: Some TCB values and Chip ID may be zero - this is **intentional by AWS** for privacy. See AWS-Specific Behavior section below.

## Development

### Building the Image

```bash
# Local build
make build

# Push to ECR (production)
make push
```

### Dependencies

- **Node.js 20** - Runtime
- **@aws-sdk/client-s3** - S3 uploads
- **snpguest v0.10.0** - Attestation generation & verification
- **cosign v2.2.3** - Image signature verification

### Environment Variables

- `IMAGE_DIGEST` - Container image digest
- `IMAGE_URI` - Full image URI with digest
- `AWS_REGION` - AWS region (default: us-east-2)
- `OUTPUT_FILE` - Attestation output path (default: /var/www/attestation.bin)

## S3 Bucket Structure

Public bucket: `popcorn-attestations-{region}`

```
popcorn-attestations-us-east-2/
└── {pod-name}/
    ├── manifest.json       # Metadata (pod, image, timestamp)
    ├── attestation.bin     # 1184-byte SEV-SNP report
    └── certs/
        └── vlek.der        # VLEK certificate
```

## Security

- ✅ Image signature verified with Cosign before attestation
- ✅ Attestation bound to specific image digest
- ✅ VLEK certificates fetched directly from AMD
- ✅ Full cryptographic chain: ARK → ASK → VLEK → Report
- ✅ Public verification - anyone can validate attestations

### AWS-Specific Behavior

AWS SNP instances have some intentional differences:

- **Chip ID = Zero**: AWS zeros this for privacy/multi-tenancy isolation
- **Some TCB values may be zero**: AWS-managed firmware approach
- **VLEK is used instead**: Certificate-based verification (not chip-specific)

This is **secure and expected** - the VLEK signature validation confirms authenticity.

## References

- [SEV-SNP Specification](https://www.amd.com/system/files/TechDocs/56860.pdf)
- [snpguest Documentation](https://github.com/virtee/snpguest)
- [AWS SNP Documentation](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/sev-snp.html)
