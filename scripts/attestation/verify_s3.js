#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const { execSync } = require('child_process');
const path = require('path');

const {
    parseAttestationReport,
    verifyAMDChain,
    verifyTCB,
    verifyHardwareSignature
} = require('./verify_common');

const pubKeyPath = path.join(__dirname, '../../cosign.pub');
const COSIGN_PUBLIC_KEY = fs.readFileSync(pubKeyPath, 'utf8');

function fetchS3Object(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            if (res.statusCode !== 200) {
                return reject(new Error(`HTTP Status ${res.statusCode} for ${url}`));
            }
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks)));
        }).on('error', reject);
    });
}

async function verifyS3Proof(podName, region) {
    console.log("╔══════════════════════════════════════════════════════════════════╗");
    console.log("║       SEV-SNP S3 Asynchronous Attestation Verification           ║");
    console.log("╚══════════════════════════════════════════════════════════════════╝\n");

    const bucketUrl = `https://popcorn-attestations-${region}.s3.${region}.amazonaws.com/${podName}`;
    console.log(`🌐 Fetching proof bundle from: s3://popcorn-attestations-${region}/${podName}/`);

    let manifestBuffer, reportBuffer, certBuffer;
    try {
        manifestBuffer = await fetchS3Object(`${bucketUrl}/manifest.json`);
        console.log(`✅ Fetched manifest.json`);
        reportBuffer = await fetchS3Object(`${bucketUrl}/attestation.bin`);
        console.log(`✅ Fetched attestation.bin`);
        certBuffer = await fetchS3Object(`${bucketUrl}/certs/vlek.der`);
        console.log(`✅ Fetched vlek.der`);
    } catch (e) {
        console.error(`❌ Failed to fetch artifacts from S3: ${e.message}`);
        process.exit(1);
    }

    let manifest;
    try {
        manifest = JSON.parse(manifestBuffer.toString('utf8'));
    } catch (e) {
        console.error(`❌ Failed to parse manifest JSON: ${e.message}`);
        process.exit(1);
    }

    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("📦 RUNNING CONTAINER DIGESTS (FROM S3 MANIFEST)");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(`Workload Image:        ${manifest.workload_digest}`);
    console.log(`Verifier Sidecar:      ${manifest.verifier_digest}`);
    console.log(`Nonce (Pod Name):      ${manifest.nonce}\n`);

    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("🔐 HARDWARE BOUND REPORT_DATA VERIFICATION");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    const pubKeyHash = crypto.createHash('sha256').update(COSIGN_PUBLIC_KEY).digest('hex');

    // H(workload_digest || verifier_digest || pubkey_hash || nonce)
    const combined = manifest.workload_digest + manifest.verifier_digest + pubKeyHash + manifest.nonce;
    const expectedReportDataHash = crypto.createHash('sha256').update(combined).digest();

    const report = parseAttestationReport(reportBuffer);
    const actualReportDataHex = report.reportData;
    const expectedReportDataHex = expectedReportDataHash.toString('hex');
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

    // 4. Validate Policy Extensions
    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("📜 GUEST POLICY VERIFICATION");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    if (report.isDebugEnabled) {
        console.error(`\n❌ POLICY CHECK FAILED: Debug mode is ALLOWED (Bit 19 is 1).`);
        console.error(`   The hypervisor can attach a debugger and read this VM's plaintext memory!`);
        process.exit(1);
    }
    console.log("✅ Guest Policy is secure (Debug Mode is disabled).");

    try {
        await verifyAMDChain(certBuffer);
        verifyTCB(certBuffer, report);
        verifyHardwareSignature(reportBuffer, certBuffer);
        console.log("✅ ECDSA P-384 hardware signature successfully validated against AMD VLEK natively!");
    } catch (e) {
        console.error(`\n❌ Hardware Signature Verification Failed: ${e.message}`);
        process.exit(1);
    }

    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("📁 ARTIFACTS SAVED");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    const tmpDir = `/tmp/s3-proof-${podName}`;
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.mkdirSync(`${tmpDir}/certs`, { recursive: true });

    fs.writeFileSync(`${tmpDir}/manifest.json`, manifestBuffer);
    fs.writeFileSync(`${tmpDir}/attestation.bin`, reportBuffer);
    fs.writeFileSync(`${tmpDir}/certs/vlek.der`, certBuffer);

    console.log(`Raw S3 artifacts saved to ${tmpDir}/`);
    console.log('\n🎉 S3 Asynchronous Verification Complete! The recorded digests are mathematically proven to be accurate and locked into the hardware TEE.');
}

const podNameArg = process.argv[2] ? process.argv[2].replace(/\/+$/, '') : undefined;
const regionArg = process.argv[3] || 'us-east-2';

if (!podNameArg) {
    console.error('Usage: node verify_s3.js <POD_NAME> [AWS_REGION]');
    console.error('Example: node verify_s3.js browser-fleet-v4qln-74z59 us-east-2');
    process.exit(1);
}

verifyS3Proof(podNameArg, regionArg);
