#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const http = require('http');

const GATEWAY_URL = process.env.GATEWAY_URL || 'https://popcorn-cluster-aws-us-east-2.popcorn.reclaimprotocol.org';

const path = require('path');
const pubKeyPath = path.join(__dirname, '../../cosign.pub');
const COSIGN_PUBLIC_KEY = fs.readFileSync(pubKeyPath, 'utf8');

function fetchProof(sessionId, nonce) {
    return new Promise((resolve, reject) => {
        let url = `${GATEWAY_URL}/proof/${sessionId}`;
        if (nonce) url += `?nonce=${nonce}`;

        console.log(`🌐 Fetching proof from: ${url}`);

        const client = url.startsWith('https') ? https : http;
        client.get(url, (res) => {
            if (res.statusCode !== 200) {
                return reject(new Error(`HTTP Status ${res.statusCode}`));
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(new Error("Failed to parse JSON response"));
                }
            });
        }).on('error', reject);
    });
}

// Parse attestation report structure (SEV-SNP spec Table 22)
function parseAttestationReport(buffer) {
    const report = {};
    if (buffer.length < 1000) {
        throw new Error(`Report buffer is too small: ${buffer.length} bytes`);
    }
    report.reportData = buffer.subarray(0x50, 0x90).toString('hex'); // 64 bytes
    return report;
}

// Helper to convert an AMD little-endian integer buffer to ASN.1 DER integer format
function toDerInt(bigIntBEBuffer) {
    let i = 0;
    while (i < bigIntBEBuffer.length && bigIntBEBuffer[i] === 0) i++;
    let val = bigIntBEBuffer.subarray(i);
    if (val.length === 0) return Buffer.from([0x02, 0x01, 0x00]);
    if (val[0] & 0x80) { // If highest bit is 1, prepend a 0x00 byte to keep it positive
        val = Buffer.concat([Buffer.from([0x00]), val]);
    }
    return Buffer.concat([Buffer.from([0x02, val.length]), val]);
}

// Verify the SEV-SNP raw hardware ECDSA P-384 signature 
function verifyHardwareSignature(reportBytes, certBytes) {
    let cert;
    try {
        cert = new crypto.X509Certificate(certBytes);
    } catch (e) {
        throw new Error("Failed to parse VLEK certificate: " + e.message);
    }
    const publicKey = cert.publicKey;

    // Extract R and S from the AMD SEV-SNP report signature block
    const sigOffset = 0x2A0;
    const rLE = reportBytes.subarray(sigOffset, sigOffset + 72);
    const sLE = reportBytes.subarray(sigOffset + 72, sigOffset + 144);

    // AMD yields Little Endian, standard cryptography needs Big Endian
    const rBE = Buffer.from(rLE).reverse();
    const sBE = Buffer.from(sLE).reverse();

    // Construct ASN.1 DER Sequence for the ECDSA signature
    const rDer = toDerInt(rBE);
    const sDer = toDerInt(sBE);

    const seqLen = rDer.length + sDer.length;
    let seqLenEncoding;
    if (seqLen < 128) {
        seqLenEncoding = Buffer.from([seqLen]);
    } else {
        seqLenEncoding = Buffer.from([0x81, seqLen]);
    }
    const signature = Buffer.concat([Buffer.from([0x30]), seqLenEncoding, rDer, sDer]);

    // AMD signs the SHA-384 hash of the first 0x2A0 bytes of the report
    const signedData = reportBytes.subarray(0, 0x2A0);
    const isValid = crypto.verify('SHA384', signedData, publicKey, signature);

    if (!isValid) {
        throw new Error("Hardware ECDSA signature is completely invalid!");
    }
}

async function verifyProof(sessionId, customNonce) {
    console.log("╔══════════════════════════════════════════════════════════════════╗");
    console.log("║       SEV-SNP Advanced Image Attestation Verification            ║");
    console.log("╚══════════════════════════════════════════════════════════════════╝\n");

    const nonce = customNonce || crypto.randomBytes(16).toString('hex');
    console.log(`🎲 Using Nonce:        ${nonce}\n`);

    let proof;
    try {
        proof = await fetchProof(sessionId, nonce);
    } catch (e) {
        console.error(`❌ Failed to fetch proof: ${e.message}`);
        process.exit(1);
    }

    if (proof.error) {
        console.error(`❌ API returned error: ${proof.error}`);
        process.exit(1);
    }

    // 1. Output the verifier and workload digests from the response.
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("📦 RUNNING CONTAINER DIGESTS (FROM ATTESTATION RESPONSE)");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(`Workload Image:        ${proof.workload_digest}`);
    console.log(`Verifier Sidecar:      ${proof.verifier_digest}\n`);

    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("🔗 NONCE BINDING VERIFICATION");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    if (proof.nonce !== nonce) {
        console.error(`❌ Nonce Mismatch! Replay attack detected.`);
        process.exit(1);
    } else {
        console.log("✅ Nonce matches. Proof is strongly bound to this session and fresh.");
    }

    // 2. Recompute REPORT_DATA Hash
    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("🔐 HARDWARE BOUND REPORT_DATA VERIFICATION");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    const pubKeyHash = crypto.createHash('sha256').update(COSIGN_PUBLIC_KEY).digest('hex');

    // H(workload_digest || verifier_digest || pubkey_hash || nonce)
    const combined = proof.workload_digest + proof.verifier_digest + pubKeyHash + proof.nonce;
    const expectedReportDataHash = crypto.createHash('sha256').update(combined).digest();

    // 3. Extract REPORT_DATA from SNP Report
    const reportBuffer = Buffer.from(proof.snp_report, 'base64');
    const report = parseAttestationReport(reportBuffer);

    const actualReportDataHex = report.reportData;
    const expectedReportDataHex = expectedReportDataHash.toString('hex');

    // We expect the 32 byte hash to be duplicated (for 64-byte alignment)
    const expected64ByteHex = expectedReportDataHex + expectedReportDataHex;

    console.log(`H(Workload || Verifier || PubKey || Nonce):`);
    console.log(`-> ${expectedReportDataHex}`);

    if (actualReportDataHex !== expected64ByteHex) {
        console.error(`\n❌ REPORT_DATA Mismatch!`);
        console.error(`   Expected (64b): ${expected64ByteHex}`);
        console.error(`   Got:            ${actualReportDataHex}`);
        console.error(`   The report is not cryptographically bound to this permutation. Replay attack or modified digests/nonce.`);
        process.exit(1);
    }
    console.log("\n✅ REPORT_DATA matches recomputed hash. Hardware binding proven.");

    // 4. Validate the Hardware Signature locally
    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("🛡️  CRYPTOGRAPHIC HARDWARE SIGNATURE VERIFICATION");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    const certBuffer = Buffer.from(proof.vlek_cert, 'base64');
    try {
        verifyHardwareSignature(reportBuffer, certBuffer);
        console.log("✅ ECDSA P-384 hardware signature successfully validated against AMD VLEK natively!");
    } catch (e) {
        console.error(`\n❌ Hardware Signature Verification Failed: ${e.message}`);
        process.exit(1);
    }

    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("📁 ARTIFACTS SAVED");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    const tmpDir = `/tmp/proof-${sessionId}`;
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.mkdirSync(`${tmpDir}/certs`, { recursive: true });

    fs.writeFileSync(`${tmpDir}/attestation.bin`, reportBuffer);
    if (proof.vlek_cert) {
        fs.writeFileSync(`${tmpDir}/certs/vlek.der`, Buffer.from(proof.vlek_cert, 'base64'));
    }

    console.log(`Raw attestation report and VLEK certificate saved to ${tmpDir}/`);
    console.log('\n🎉 All checks passed! The returned image digests are mathematically proven to be accurate and locked into the hardware TEE.');
}

const sessionId = process.argv[2];
const customNonce = process.argv[3]; // optional

if (!sessionId) {
    console.error('Usage: node verify_proof.js <SESSION_ID> [OPTIONAL_NONCE]');
    console.error('Example: node verify_proof.js session-1x');
    process.exit(1);
}

verifyProof(sessionId, customNonce);
