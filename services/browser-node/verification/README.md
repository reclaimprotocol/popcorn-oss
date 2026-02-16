# Attestation Verification

Simple tool to verify SEV-SNP attestation reports from S3.

## Quick Start

### Build the Docker image (one time):

```bash
cd services/browser-node/verification
docker build -t attestation-verifier .
```

### Verify any pod:

```bash
docker run --rm attestation-verifier <POD_NAME>
```

**Example:**
```bash
docker run --rm attestation-verifier browser-fleet-9877p-56ddj
```

## What It Shows

The verification displays comprehensive attestation details:

- **Manifest Info**: Pod name, image digest, timestamp
- **Platform Info**: SNP version, VMPL level, SMT/TSME status
- **AMD TCB Levels**: Boot Loader, TEE, SNP Firmware, Microcode versions
- **Cryptographic IDs**: Report Data, Measurement, Chip ID, Report ID
- **VLEK Verification**: Full AMD certificate chain validation

## Understanding AWS SNP Values

### Why Some Values Are Zero

**This is normal and secure for AWS SNP instances:**

#### TCB Values May Be Zero
- **TEE SVN = 0**: AWS-managed firmware, standard implementation
- **SNP Firmware = 0**: AWS-specific firmware versioning
- **Microcode SVN = 0**: Similar to SNP firmware

#### Chip ID Is Always Zero
- **Intentional for privacy**: AWS zeros this to prevent hardware tracking
- **Multi-tenant isolation**: Protects against cross-VM correlation
- **VLEK used instead**: Certificate-based verification, not chip-specific

### What Actually Matters

✅ **Boot Loader SVN** (non-zero) - Shows platform version  
✅ **VLEK Signature Validation** - Confirms cryptographic authenticity  
✅ **Report Data Binding** - Links attestation to specific image digest

When snpguest shows:
```
✅ Reported TCB from certificate matches the attestation report
✅ VEK signed the Attestation Report!
```

This proves the attestation is **cryptographically valid** even with zero values.

## Example Output

```
╔══════════════════════════════════════════════════════════╗
║       SEV-SNP Attestation Verification Report            ║
╚══════════════════════════════════════════════════════════╝

📋 MANIFEST INFORMATION
Pod Name:        browser-fleet-9877p-56ddj
Image Digest:    sha256:98f967be2b87...
Generated:       2026-02-16T19:14:11.612Z

🖥️  PLATFORM INFORMATION
Report Version:  5
VMPL Level:      1
SMT Enabled:     Yes

🔐 AMD TRUSTED COMPUTING BASE (TCB)
Boot Loader SVN: 4
TEE SVN:         0    ← Expected on AWS
SNP Firmware:    0    ← Expected on AWS  
Microcode SVN:   0    ← Expected on AWS

🔑 CRYPTOGRAPHIC IDENTIFIERS
Chip ID:         0000... ← Intentionally zeroed by AWS

✅ CRYPTOGRAPHIC VERIFICATION
Reported TCB Boot Loader from certificate matches
Reported TCB TEE from certificate matches
Reported TCB SNP from certificate matches
Reported TCB Microcode from certificate matches
VEK signed the Attestation Report!
```

## Public S3 Access

All attestations are publicly accessible:

```
https://popcorn-attestations-us-east-2.s3.us-east-2.amazonaws.com/{POD_NAME}/
├── manifest.json
├── attestation.bin
└── certs/vlek.der
```

## Local Development

Without Docker:

```bash
node verify_from_s3.js <POD_NAME>
```

Note: Requires Node.js 20+. VLEK verification will be skipped without snpguest installed.
