# Popcorn SEV-SNP Attestation Verification

This directory contains standalone scripts to independently verify cryptographic hardware attestation proofs from the Popcorn SEV-SNP instances.

## Installation

Ensure you have Node.js installed, then install the required dependencies:

```bash
npm install
```

## How to Run Attestation

### Method 1: Live Verification (Node.js)
Verifies the proof being served actively by the gateway for a given session.

```bash
# Usage:
node scripts/attestation/verify_proof.js <SESSION_ID> [OPTIONAL_NONCE]

# Example:
node scripts/attestation/verify_proof.js test
```

### Method 2: S3 Asynchronous Verification (Node.js)
Verifies a proof bundle that was uploaded to S3. This allows you to verify the integrity of a session even after the cluster node shuts down.

```bash
# Usage:
node scripts/attestation/verify_s3.js <POD_NAME> [AWS_REGION]

# Example:
node scripts/attestation/verify_s3.js browser-fleet-v4qln-74z59 us-east-2
```

## Understanding the Logs

The scripts perform mathematical proofs in stages. Here is what each log check represents:

1. **RUNNING CONTAINER DIGESTS**
   Retrieves the signed SHA-256 image hashes for both the workload and the verifier container payloads.

2. **NONCE BINDING VERIFICATION**
   Ensures the randomly generated `nonce` perfectly matches what was included in the report, preventing replay attacks.

3. **HARDWARE BOUND REPORT_DATA VERIFICATION**
   We calculate a SHA-384 hash combining the digests, public key, and nonce, and verify it perfectly matches the 64-byte `REPORT_DATA` field physically injected into the AMD SEV-SNP report.

4. **GUEST POLICY VERIFICATION**
   Parses the `POLICY` byte of the report to assert that debug mode (Bit 19) is firmly disabled (`0`). If debug mode is enabled, the hypervisor can peek into memory, rendering the system insecure.

5. **AMD ROOT OF TRUST CHAIN VERIFICATION**
   Validates the X.509 certificate chain. It ensures the reported VLEK certificate is authentically signed by the AMD ARK and ASK. It additionally downloads AMD's latest **Certificate Revocation List (CRL)** to guarantee the processor has not been explicitly revoked due to known silicon vulnerabilities.

6. **TRUSTED COMPUTING BASE (TCB) VERSION VERIFICATION**
   Using `node-forge`, we strictly traverse the ASN.1 structure of the AMD VLEK certificate to extract AMD's custom PKI extensions (Bootloader, TEE, SNP, Microcode). We mathematically prove that the physical hardware version reported in the SEV-SNP attestation buffer exceeds or satisfies the minimum trusted threshold signed mathematically within the AMD certificate.

7. **CRYPTOGRAPHIC HARDWARE SIGNATURE VERIFICATION**
   The ultimate proof. We take the ECDSA P-384 signature attached to the raw SEV-SNP report, format it to standard cryptography, and use the AMD hardware public key to ensure that the signature perfectly signs the SHA-384 hash of the `report_data` block.

If all checks print `✅`, you have absolute cryptographic certainty that the session is running the exact container images stated inside a fully isolated and trusted AMD SEV-SNP Trusted Execution Environment (TEE)!
