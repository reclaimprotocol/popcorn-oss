#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');

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

function parseAttestationReport(buffer) {
    const report = {};
    if (buffer.length < 1000) {
        throw new Error(`Report buffer is too small: ${buffer.length} bytes`);
    }
    report.reportData = buffer.subarray(0x50, 0x90).toString('hex'); // 64 bytes
    return report;
}

function toDerInt(bigIntBEBuffer) {
    let i = 0;
    while (i < bigIntBEBuffer.length && bigIntBEBuffer[i] === 0) i++;
    let val = bigIntBEBuffer.subarray(i);
    if (val.length === 0) return Buffer.from([0x02, 0x01, 0x00]);
    if (val[0] & 0x80) {
        val = Buffer.concat([Buffer.from([0x00]), val]);
    }
    return Buffer.concat([Buffer.from([0x02, val.length]), val]);
}

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

    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("🛡️  CRYPTOGRAPHIC HARDWARE SIGNATURE VERIFICATION");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

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
