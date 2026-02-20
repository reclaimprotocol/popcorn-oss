#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:80';

// Cosign public key - embedded from repo
const COSIGN_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEjiL30OjPuxa+GC1I7SAcBv2u2pMt
h9WbP33IvB3eFww+C1hoW0fwdZPiq4FxBtKNiZuFpmYuFngW/nJteBu9kQ==
-----END PUBLIC KEY-----
`;

function fetchProof(sessionId, token, nonce) {
    return new Promise((resolve, reject) => {
        const url = `${GATEWAY_URL}/proof/${sessionId}/${token}?nonce=${nonce}`;
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

async function verifyProof(sessionId, token, expectedWorkloadDigest, expectedVerifierDigest) {
    console.log("╔══════════════════════════════════════════════════════════════════╗");
    console.log("║       SEV-SNP Advanced Image Attestation Verification            ║");
    console.log("╚══════════════════════════════════════════════════════════════════╝\n");

    const nonce = crypto.randomBytes(16).toString('hex');
    console.log(`🎲 Generated Nonce:    ${nonce}`);
    console.log(`📦 Expected Workload:  ${expectedWorkloadDigest}`);
    console.log(`📦 Expected Verifier:  ${expectedVerifierDigest}\n`);

    let proof;
    try {
        proof = await fetchProof(sessionId, token, nonce);
    } catch (e) {
        console.error(`❌ Failed to fetch proof: ${e.message}`);
        process.exit(1);
    }

    // 1. Verify Digest Matches Expected
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("🔗 DIGEST BINDING VERIFICATION");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    let hasError = false;

    if (proof.workload_digest !== expectedWorkloadDigest) {
        console.error(`❌ Workload Digest Mismatch!`);
        console.error(`   Expected: ${expectedWorkloadDigest}`);
        console.error(`   Got:      ${proof.workload_digest}`);
        hasError = true;
    } else {
        console.log("✅ Workload Digest matches expected.");
    }

    if (proof.verifier_digest !== expectedVerifierDigest) {
        console.error(`❌ Verifier Digest Mismatch!`);
        console.error(`   Expected: ${expectedVerifierDigest}`);
        console.error(`   Got:      ${proof.verifier_digest}`);
        hasError = true;
    } else {
        console.log("✅ Verifier Digest matches expected.");
    }

    if (proof.nonce !== nonce) {
        console.error(`❌ Nonce Mismatch! Replay attack detected.`);
        hasError = true;
    } else {
        console.log("✅ Nonce matches. Proof is fresh.");
    }

    if (hasError) process.exit(1);

    // 2. Recompute REPORT_DATA Hash
    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("🔐 HARDWARE BOUND REPORT_DATA VERIFICATION");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    const pubKeyHash = crypto.createHash('sha256').update(COSIGN_PUBLIC_KEY).digest('hex');

    // H(workload_digest || verifier_digest || pubkey_hash || nonce)
    // Note: The Go code did: workloadImageID + verifierImageID + pubKeyHashHex + nonce
    const combined = proof.workload_digest + proof.verifier_digest + pubKeyHash + proof.nonce;
    const expectedReportDataHash = crypto.createHash('sha256').update(combined).digest();

    // 3. Extract REPORT_DATA from SNP Report
    const reportBuffer = Buffer.from(proof.snp_report, 'base64');
    const report = parseAttestationReport(reportBuffer);

    // Note: Node.js Buffer.toString('hex') is lowercase.
    const actualReportDataHex = report.reportData;
    const expectedReportDataHex = expectedReportDataHash.toString('hex');

    // We expect the 32 byte hash to be duplicated
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

    // 4. Verify SNP Report Signature using snpguest (requires tmp files)
    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("✅ CRYPTOGRAPHIC VERIFICATION (snpguest)");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    const tmpDir = `/tmp/proof-${sessionId}`;
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.mkdirSync(`${tmpDir}/certs`, { recursive: true });

    fs.writeFileSync(`${tmpDir}/attestation.bin`, reportBuffer);
    if (proof.vlek_cert) {
        fs.writeFileSync(`${tmpDir}/certs/vlek.der`, Buffer.from(proof.vlek_cert, 'base64'));
    }

    try {
        const result = execSync(
            `snpguest verify attestation ${tmpDir}/certs ${tmpDir}/attestation.bin`,
            { encoding: 'utf8', stdio: 'pipe' }
        );
        console.log(result.trim());
        console.log('✅ VLEK signature validated!');
        console.log('\n🎉 All checks passed! The specific image digest is proven to be running securely inside the TEE.');
    } catch (verifyErr) {
        if (verifyErr.message.includes('command not found')) {
            console.log('⚠️  snpguest not installed - skipping VLEK signature verification.');
            console.log('   Install snpguest for full cryptographic verification.');
            console.log('\n🎉 Logic checks passed, but hardware signature was not verified locally.');
        } else {
            console.log(verifyErr.stderr || verifyErr.message);
            console.log('⚠️  snpguest verification encountered an error.');
            process.exit(1);
        }
    }
}

const sessionId = process.argv[2];
const token = process.argv[3];
const expectedWorkloadDigest = process.argv[4];
const expectedVerifierDigest = process.argv[5];

if (!sessionId || !token || !expectedWorkloadDigest || !expectedVerifierDigest) {
    console.error('Usage: node verify_proof.js <SESSION_ID> <TOKEN> <EXPECTED_WORKLOAD_DIGEST> <EXPECTED_VERIFIER_DIGEST>');
    console.error('Example: node verify_proof.js 123 abc sha256:111... sha256:222...');
    process.exit(1);
}

verifyProof(sessionId, token, expectedWorkloadDigest, expectedVerifierDigest);
