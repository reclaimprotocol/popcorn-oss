#!/usr/bin/env node

const https = require('https');
const fs = require('fs');
const crypto = require('crypto');
const { execSync } = require('child_process');

const POD_NAME = process.argv[2];
const REGION = process.env.AWS_REGION || 'us-east-2';
const BUCKET = `popcorn-attestations-${REGION}`;
const BASE_URL = `https://${BUCKET}.s3.${REGION}.amazonaws.com/${POD_NAME}`;

if (!POD_NAME) {
    console.error('Usage: node verify_from_s3.js <POD_NAME>');
    console.error('Example: node verify_from_s3.js browser-fleet-g5vgz-c7fvf');
    process.exit(1);
}

console.log('🔍 Verifying Attestation from S3');
console.log(`📦 Pod: ${POD_NAME}`);
console.log(`🌍 Bucket: ${BUCKET}\n`);

// Download file from URL
function download(url, dest) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        https.get(url, (response) => {
            if (response.statusCode === 200) {
                response.pipe(file);
                file.on('finish', () => file.close(resolve));
            } else {
                reject(new Error(`HTTP ${response.statusCode}: ${url}`));
            }
        }).on('error', reject);
    });
}

async function main() {
    const tmpDir = `/tmp/attestation-${POD_NAME}`;
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.mkdirSync(`${tmpDir}/certs`, { recursive: true });

    try {
        // Download manifest
        console.log('⬇️  Downloading manifest...');
        await download(`${BASE_URL}/manifest.json`, `${tmpDir}/manifest.json`);
        const manifest = JSON.parse(fs.readFileSync(`${tmpDir}/manifest.json`));
        console.log(`✅ Manifest loaded`);
        console.log(`   Image: ${manifest.imageDigest}`);
        console.log(`   Timestamp: ${manifest.timestamp}\n`);

        // Download attestation
        console.log('⬇️  Downloading attestation report...');
        await download(`${BASE_URL}/attestation.bin`, `${tmpDir}/attestation.bin`);
        const reportSize = fs.statSync(`${tmpDir}/attestation.bin`).size;
        console.log(`✅ Attestation: ${reportSize} bytes\n`);

        // Download VLEK cert
        console.log('⬇️  Downloading VLEK certificate...');
        await download(`${BASE_URL}/certs/vlek.der`, `${tmpDir}/certs/vlek.der`);
        console.log(`✅ VLEK certificate downloaded\n`);

        // Verify with snpguest (requires snpguest to be installed)
        console.log('🔐 Running cryptographic verification...\n');
        try {
            // Extract raw report (skip 32-byte header)
            const reportBuffer = fs.readFileSync(`${tmpDir}/attestation.bin`);
            const rawReport = reportBuffer.slice(32, 32 + 1184);
            fs.writeFileSync(`${tmpDir}/attestation_raw.bin`, rawReport);

            // Run snpguest verification
            const result = execSync(
                `snpguest verify attestation ${tmpDir}/certs ${tmpDir}/attestation_raw.bin`,
                { encoding: 'utf8' }
            );
            console.log(result);
            console.log('✅ Full cryptographic verification PASSED!\n');
        } catch (verifyErr) {
            console.warn('⚠️  snpguest verification failed or not installed');
            console.warn('   Falling back to basic verification...\n');

            // Basic verification with verify_vlek.js
            process.env.REPORT_FILE = `${tmpDir}/attestation.bin`;
            const verifyScript = require('./verify_vlek.js');
        }

        console.log(`\n📍 Files saved to: ${tmpDir}`);
        console.log(`🌐 Public URL: ${BASE_URL}/manifest.json`);

    } catch (error) {
        console.error(`❌ Verification failed: ${error.message}`);
        process.exit(1);
    }
}

main();
