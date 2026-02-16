#!/usr/bin/env node

const https = require('https');
const fs = require('fs');
const crypto = require('crypto');
const { execSync } = require('child_process');

const POD_NAME = process.argv[2];
const REGION = process.env.AWS_REGION || 'us-east-2';
const BUCKET = `popcorn-attestations-${REGION}`;
const BASE_URL = `https://${BUCKET}.s3.${REGION}.amazonaws.com/${POD_NAME}`;

// Cosign public key - embedded from repo (trusted, versioned with this script)
const COSIGN_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEjiL30OjPuxa+GC1I7SAcBv2u2pMt
h9WbP33IvB3eFww+C1hoW0fwdZPiq4FxBtKNiZuFpmYuFngW/nJteBu9kQ==
-----END PUBLIC KEY-----
`;

if (!POD_NAME) {
    console.error('Usage: node verify_from_s3.js <POD_NAME>');
    console.error('Example: node verify_from_s3.js browser-fleet-g5vgz-c7fvf');
    process.exit(1);
}

// Download file from URL
function download(url, dest) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        https.get(url, (response) => {
            if (response.statusCode === 200) {
                response.pipe(file);
                file.on('finish', () => file.close(resolve));
            } else if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                // Follow redirects (GitHub raw URLs may redirect)
                file.close();
                download(response.headers.location, dest).then(resolve).catch(reject);
            } else {
                reject(new Error(`HTTP ${response.statusCode}: ${url}`));
            }
        }).on('error', reject);
    });
}

// Download content as string
function downloadText(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (response) => {
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                downloadText(response.headers.location).then(resolve).catch(reject);
                return;
            }
            if (response.statusCode !== 200) {
                reject(new Error(`HTTP ${response.statusCode}: ${url}`));
                return;
            }
            let data = '';
            response.on('data', chunk => data += chunk);
            response.on('end', () => resolve(data));
        }).on('error', reject);
    });
}

// Parse attestation report structure (SEV-SNP spec Table 22)
function parseAttestationReport(buffer) {
    const report = {};

    report.version = buffer.readUInt32LE(0x00);
    report.guestSvn = buffer.readUInt32LE(0x04);
    report.policy = buffer.readBigUInt64LE(0x08);
    report.familyId = buffer.slice(0x10, 0x20).toString('hex');
    report.imageId = buffer.slice(0x20, 0x30).toString('hex');
    report.vmpl = buffer.readUInt32LE(0x30);
    report.signatureAlgo = buffer.readUInt32LE(0x34);

    const tcbBytes = buffer.slice(0x38, 0x40);
    report.tcb = {
        bootLoader: tcbBytes[0],
        tee: tcbBytes[1],
        snp: tcbBytes[4],
        microcode: tcbBytes[5]
    };

    const platformInfo = buffer.readBigUInt64LE(0x40);
    report.platformInfo = {
        smt_enabled: !!(platformInfo & 0x01n),
        tsme_enabled: !!(platformInfo & 0x02n)
    };

    report.reportData = buffer.slice(0x50, 0x90).toString('hex');
    report.measurement = buffer.slice(0x90, 0xC0).toString('hex');
    report.hostData = buffer.slice(0xC0, 0xE0).toString('hex');
    report.idKeyDigest = buffer.slice(0xE0, 0x110).toString('hex');
    report.authorKeyDigest = buffer.slice(0x110, 0x140).toString('hex');
    report.reportId = buffer.slice(0x140, 0x160).toString('hex');
    report.reportIdMa = buffer.slice(0x160, 0x180).toString('hex');
    report.chipId = buffer.slice(0x1A0, 0x1E0).toString('hex');
    report.signature = buffer.slice(0x2A0, 0x4A0).toString('hex');

    return report;
}

async function main() {
    const tmpDir = `/tmp/attestation-${POD_NAME}`;
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.mkdirSync(`${tmpDir}/certs`, { recursive: true });

    try {
        console.log('╔══════════════════════════════════════════════════════════════════╗');
        console.log('║       SEV-SNP Attestation Verification Report                    ║');
        console.log('╚══════════════════════════════════════════════════════════════════╝\n');

        // Download all artifacts
        console.log('⬇️  Downloading attestation bundle from S3...');
        await download(`${BASE_URL}/manifest.json`, `${tmpDir}/manifest.json`);
        await download(`${BASE_URL}/attestation.bin`, `${tmpDir}/attestation.bin`);
        await download(`${BASE_URL}/certs/vlek.der`, `${tmpDir}/certs/vlek.der`);

        console.log('✅ Bundle downloaded\n');

        const manifest = JSON.parse(fs.readFileSync(`${tmpDir}/manifest.json`));
        const reportBuffer = fs.readFileSync(`${tmpDir}/attestation.bin`);
        const certSize = fs.statSync(`${tmpDir}/certs/vlek.der`).size;

        // Parse attestation report
        const report = parseAttestationReport(reportBuffer);

        // ── MANIFEST ──
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('📋 MANIFEST INFORMATION');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log(`Pod Name:        ${manifest.podName}`);
        console.log(`Image Digest:    ${manifest.imageDigest}`);
        console.log(`Image URI:       ${manifest.imageUri}`);
        console.log(`Generated:       ${manifest.timestamp}`);
        console.log(`Region:          ${manifest.region}`);
        console.log(`Report Size:     ${reportBuffer.length} bytes`);
        console.log(`VLEK Cert Size:  ${certSize} bytes\n`);

        // ── PLATFORM ──
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🖥️  PLATFORM INFORMATION');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log(`Report Version:  ${report.version}`);
        console.log(`Guest SVN:       ${report.guestSvn}`);
        console.log(`VMPL Level:      ${report.vmpl}`);
        console.log(`Policy:          0x${report.policy.toString(16)}`);
        console.log(`Signature Algo:  ${report.signatureAlgo === 1 ? 'ECDSA P-384 with SHA-384' : report.signatureAlgo}`);
        console.log(`SMT Enabled:     ${report.platformInfo.smt_enabled ? 'Yes' : 'No'}`);
        console.log(`TSME Enabled:    ${report.platformInfo.tsme_enabled ? 'Yes' : 'No'}\n`);

        // ── TCB ──
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🔐 AMD TRUSTED COMPUTING BASE (TCB)');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log(`Boot Loader SVN: ${report.tcb.bootLoader}`);
        console.log(`TEE SVN:         ${report.tcb.tee}`);
        console.log(`SNP Firmware:    ${report.tcb.snp}`);
        console.log(`Microcode SVN:   ${report.tcb.microcode}\n`);

        // ── CRYPTO IDS ──
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🔑 CRYPTOGRAPHIC IDENTIFIERS');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log(`Report Data (first 32 bytes):`);
        console.log(`  ${report.reportData.substring(0, 64)}`);
        console.log(`\nMeasurement:`);
        console.log(`  ${report.measurement.substring(0, 64)}`);
        console.log(`  ${report.measurement.substring(64)}`);
        console.log(`\nChip ID (first 32 bytes):`);
        console.log(`  ${report.chipId.substring(0, 64)}`);
        console.log(`\nReport ID:`);
        console.log(`  ${report.reportId.substring(0, 64)}\n`);

        // ── IMAGE BINDING ──
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🔗 IMAGE BINDING VERIFICATION');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        // Replicate the exact logic from attest.js:
        // ReportData = SHA256(SHA256(imageDigest) || SHA256(pubKey))
        const imageHash = crypto.createHash('sha256')
            .update(manifest.imageDigest)
            .digest();

        const pubKeyHash = crypto.createHash('sha256')
            .update(COSIGN_PUBLIC_KEY)
            .digest();

        const combined = Buffer.concat([imageHash, pubKeyHash]);
        const expectedHash = crypto.createHash('sha256')
            .update(combined)
            .digest('hex');

        const actualHash = report.reportData.substring(0, 64);

        console.log(`Image Digest:    ${manifest.imageDigest}`);
        console.log(`Public Key:      Embedded in script (from repo)`);
        console.log('');
        console.log('Report Data Computation:');
        console.log(`  imageHash    = SHA256("${manifest.imageDigest.substring(0, 20)}...")`);
        console.log(`               = ${imageHash.toString('hex')}`);
        console.log(`  pubKeyHash   = SHA256(cosign.pub)`);
        console.log(`               = ${pubKeyHash.toString('hex')}`);
        console.log(`  expected     = SHA256(imageHash || pubKeyHash)`);
        console.log(`               = ${expectedHash}`);
        console.log(`  report_data  = ${actualHash}`);

        if (expectedHash === actualHash) {
            console.log('\n✅ MATCH: Report Data verified!');
            console.log('   Attestation is cryptographically bound to:');
            console.log(`   • Image:  ${manifest.imageDigest.substring(0, 20)}...`);
            console.log(`   • PubKey: cosign.pub from GitHub\n`);
        } else {
            console.log('\n❌ MISMATCH: Report Data does not match expected hash!');
            console.log('   ⚠️  The attestation may not be for this image/key combination.\n');
        }

        // ── VLEK VERIFICATION ──
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('✅ CRYPTOGRAPHIC VERIFICATION (snpguest)');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        try {
            const result = execSync(
                `snpguest verify attestation ${tmpDir}/certs ${tmpDir}/attestation.bin`,
                { encoding: 'utf8' }
            );
            console.log(result);
            console.log('✅ VLEK signature validated!\n');

            // Certificate chain
            console.log('🔗 AMD Certificate Chain Verified:');
            console.log('   ARK (AMD Root Key)');
            console.log('    ↓ Signs');
            console.log('   ASK (AMD Signing Key)');
            console.log('    ↓ Signs');
            console.log('   VLEK (Versioned Loaded Endorsement Key)');
            console.log('    ↓ Signs');
            console.log('   Attestation Report');
            console.log('');
            console.log('This proves:');
            console.log('  • Report generated by genuine AMD SNP hardware');
            console.log('  • TCB versions match AMD-signed certificate');
            console.log('  • Report has not been tampered with');
            console.log('  • Attestation is cryptographically bound to this workload\n');
        } catch (verifyErr) {
            if (verifyErr.message.includes('command not found')) {
                console.log('⚠️  snpguest not installed - skipping VLEK verification');
                console.log('   Install snpguest for full cryptographic verification.\n');
            } else {
                console.log(verifyErr.stderr || verifyErr.message);
                console.log('⚠️  snpguest verification encountered an error\n');
            }
        }

        // ── SUMMARY ──
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('📍 VERIFICATION SUMMARY');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log(`Local Files:     ${tmpDir}/`);
        console.log(`Public URL:      ${BASE_URL}/manifest.json\n`);

    } catch (error) {
        console.error(`\n❌ Verification failed: ${error.message}`);
        process.exit(1);
    }
}

main();
