const fs = require('fs');
const crypto = require('crypto');
const { execFile, execFileSync } = require('child_process');
const path = require('path');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { hostname } = require('os');

const SEV_GUEST_DEVICE = '/dev/sev-guest';
const OUTPUT_FILE = process.env.OUTPUT_FILE || '/var/www/attestation.bin';
const SNP_IOCTL_BIN = '/usr/local/bin/snp_ioctl';
const COSIGN_PUB_KEY = process.env.COSIGN_PUB_KEY || '/etc/cosign.pub';

async function main() {
    console.log('🔒 Starting SEV-SNP Attestation Check...');

    // 1. Check if running in TEE
    if (!fs.existsSync(SEV_GUEST_DEVICE)) {
        console.warn('⚠️  /dev/sev-guest not found. Running in non-TEE mode.');
        console.warn('⚠️  Skipping attestation generation.');
        return;
    }

    console.log('✅ SEV-SNP device found.');

    // 2. Get Image Digest
    const imageDigest = process.env.IMAGE_DIGEST;
    let finalBuffer;

    if (!imageDigest) {
        console.error('❌ IMAGE_DIGEST environment variable missing!');
        console.error('⚠️  Proceeding with zeroed report data (WEAK PROOF).');
        finalBuffer = Buffer.alloc(64);
    } else {
        console.log(`ℹ️  Binding to Image Digest: ${imageDigest}`);

        // 3. Verify Signature (Cosign)
        if (!fs.existsSync(COSIGN_PUB_KEY)) {
            console.error(`❌ Public Key not found at ${COSIGN_PUB_KEY}`);
            process.exit(1);
        } else {
            console.log('🔍 Verifying Image Signature with Cosign...');
            try {
                // Cosign needs the full image reference (repo + digest) to verify.
                const imageUri = process.env.IMAGE_URI || process.env.IMAGE_DIGEST;

                execFileSync('/usr/local/bin/cosign', ['verify', '--key', COSIGN_PUB_KEY, imageUri], { stdio: 'inherit' });
                console.log('✅ Signature Verification Passed');
            } catch (err) {
                console.error('❌ Signature Verification FAILED!');
                process.exit(1);
            }
        }

        // 4. Calculate Report Data: SHA256(SHA256(ImageDigest) + SHA256(PublicKey))
        const imageHash = crypto.createHash('sha256').update(imageDigest).digest();

        let pubKeyHash = Buffer.alloc(32);
        if (fs.existsSync(COSIGN_PUB_KEY)) {
            const pubKeyContent = fs.readFileSync(COSIGN_PUB_KEY);
            pubKeyHash = crypto.createHash('sha256').update(pubKeyContent).digest();
        }

        // Combine: ReportData = SHA256(ImageHash || PubKeyHash)
        const combined = Buffer.concat([imageHash, pubKeyHash]);
        const reportDataHash = crypto.createHash('sha256').update(combined).digest();

        // Pad to 64 bytes (Duplicate hash to fill both halves to handle potential alignment/shift issues)
        finalBuffer = Buffer.alloc(64);
        reportDataHash.copy(finalBuffer, 0);
        reportDataHash.copy(finalBuffer, 32);

        console.log(`LOCKING Report Data to: ${reportDataHash.toString('hex')}`);
    }

    // 5. Generate attestation using snpguest
    console.log('🔄 Generating SEV-SNP attestation report with snpguest...');

    const requestFile = '/tmp/snp_request.bin';
    const SNPGUEST_BIN = '/usr/local/bin/snpguest';

    try {
        // Write 64-byte report data to binary file
        fs.writeFileSync(requestFile, finalBuffer);

        // Generate attestation report
        execFileSync(SNPGUEST_BIN, ['report', OUTPUT_FILE, requestFile], { stdio: 'inherit' });
        console.log(`✅ Attestation report saved to ${OUTPUT_FILE}`);

        const reportSize = fs.statSync(OUTPUT_FILE).size;
        console.log(`📄 Report Size: ${reportSize} bytes`);

        // 6. Fetch VLEK certificates
        console.log('📜 Fetching VLEK certificates...');
        const certsDir = '/var/www/certs';

        try {
            if (!fs.existsSync(certsDir)) {
                fs.mkdirSync(certsDir, { recursive: true });
            }
            execFileSync(SNPGUEST_BIN, ['certificates', 'der', certsDir], { stdio: 'inherit' });
            console.log(`✅ VLEK certificates saved to ${certsDir}`);
        } catch (certErr) {
            console.warn('⚠️  Failed to fetch VLEK certificates:', certErr.message);
            console.warn('   Attestation report generated, but certificate extraction failed.');
        }

        // 7. Upload attestation bundle to S3
        console.log('☁️  Uploading attestation bundle to S3...');

        const podName = hostname(); // Kubernetes sets hostname to pod name
        const awsRegion = process.env.AWS_REGION || 'us-east-2';
        const bucketName = `popcorn-attestations-${awsRegion}`;
        const s3Client = new S3Client({ region: awsRegion });

        try {
            // Upload attestation report
            await s3Client.send(new PutObjectCommand({
                Bucket: bucketName,
                Key: `${podName}/attestation.bin`,
                Body: fs.readFileSync(OUTPUT_FILE),
                ContentType: 'application/octet-stream'
            }));

            // Upload VLEK certificate
            const vlekPath = `${certsDir}/vlek.der`;
            if (fs.existsSync(vlekPath)) {
                await s3Client.send(new PutObjectCommand({
                    Bucket: bucketName,
                    Key: `${podName}/certs/vlek.der`,
                    Body: fs.readFileSync(vlekPath),
                    ContentType: 'application/x-x509-ca-cert'
                }));
            }

            // Upload manifest
            const manifest = {
                podName,
                imageDigest,
                imageUri: process.env.IMAGE_URI,
                timestamp: new Date().toISOString(),
                region: awsRegion
            };

            await s3Client.send(new PutObjectCommand({
                Bucket: bucketName,
                Key: `${podName}/manifest.json`,
                Body: JSON.stringify(manifest, null, 2),
                ContentType: 'application/json'
            }));

            const baseUrl = `https://${bucketName}.s3.${awsRegion}.amazonaws.com/${podName}`;
            console.log(`✅ Attestation bundle uploaded:`);
            console.log(`   📍 ${baseUrl}/manifest.json`);
            console.log(`   📍 ${baseUrl}/attestation.bin`);
            console.log(`   📍 ${baseUrl}/certs/vlek.der`);

        } catch (uploadErr) {
            console.warn('⚠️  Failed to upload to S3:', uploadErr.message);
            console.warn('   Attestation generated locally but not uploaded.');
        }

    } catch (error) {
        console.error('❌ Failed to generate attestation report:', error);
        process.exit(1);
    }
}

main();
