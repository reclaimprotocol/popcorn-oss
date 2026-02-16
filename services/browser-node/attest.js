const fs = require('fs');
const crypto = require('crypto');
const { execFile, execFileSync } = require('child_process');
const path = require('path');

const SEV_GUEST_DEVICE = '/dev/sev-guest';
const OUTPUT_FILE = process.env.OUTPUT_FILE || '/var/www/attestation.bin';
const SNP_IOCTL_BIN = '/usr/local/bin/snp_ioctl';
const COSIGN_PUB_KEY = process.env.COSIGN_PUB_KEY || '/etc/cosign.pub';

function main() {
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
    let reportDataHex;

    if (!imageDigest) {
        console.error('❌ IMAGE_DIGEST environment variable missing!');
        console.error('⚠️  Proceeding with zeroed report data (WEAK PROOF).');
        reportDataHex = Buffer.alloc(64).toString('hex');
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

        // Pad to 64 bytes
        const finalBuffer = Buffer.alloc(64);
        reportDataHash.copy(finalBuffer);
        reportDataHex = finalBuffer.toString('hex');

        console.log(`LOCKING Report Data to: ${reportDataHex}`);
    }

    // 5. Call C helper
    console.log('🔄 Calling kernel ioctl via snp_ioctl...');
    execFile(SNP_IOCTL_BIN, [reportDataHex], { encoding: 'buffer', maxBuffer: 4096 }, (error, stdout, stderr) => {
        if (error) {
            console.error('❌ Failed to generate attestation report:', error);
            if (stderr && stderr.length > 0) console.error('Stderr:', stderr.toString());
            process.exit(1);
        }

        // 6. Save Report
        try {
            fs.writeFileSync(OUTPUT_FILE, stdout);
            console.log(`✅ Attestation report generated and saved to ${OUTPUT_FILE}`);
            console.log(`📄 Report Size: ${stdout.length} bytes`);
        } catch (writeErr) {
            console.error(`❌ Failed to write report to ${OUTPUT_FILE}:`, writeErr);
            process.exit(1);
        }
    });
}

main();
