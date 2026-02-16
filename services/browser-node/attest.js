const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const path = require('path');

const SEV_GUEST_DEVICE = '/dev/sev-guest';
const OUTPUT_FILE = '/var/www/attestation.bin';
const SNP_IOCTL_BIN = '/usr/local/bin/snp_ioctl';

function main() {
    console.log('🔒 Starting SEV-SNP Attestation Check...');

    const isMock = process.env.MOCK_TEE === 'true';

    // 1. Check if running in TEE (unless mocked)
    if (!isMock && !fs.existsSync(SEV_GUEST_DEVICE)) {
        console.warn('⚠️  /dev/sev-guest not found. Running in non-TEE mode.');
        console.warn('⚠️  Skipping attestation generation.');
        return;
    }

    if (isMock) {
        console.log('🎭 MOCK_TEE enabled: Simulating SEV-SNP environment.');
    } else {
        console.log('✅ SEV-SNP device found.');
    }

    // 2. Get Image Digest
    const imageDigest = process.env.IMAGE_DIGEST;
    let reportDataHex;

    if (!imageDigest) {
        console.error('❌ IMAGE_DIGEST environment variable missing!');
        console.error('⚠️  Proceeding with zeroed report data (WEAK PROOF).');
        reportDataHex = Buffer.alloc(64).toString('hex');
    } else {
        console.log(`ℹ️  Binding to Image Digest: ${imageDigest}`);
        // 3. Hash the digest to fit 64 bytes
        const hash = crypto.createHash('sha256').update(imageDigest).digest();
        const finalBuffer = Buffer.alloc(64);
        hash.copy(finalBuffer);
        reportDataHex = finalBuffer.toString('hex');
    }

    // 4. Call C helper (or mock)
    if (isMock) {
        console.log('🔄 [MOCK] Simulating kernel ioctl...');
        // Simulate a 1184-byte report (standard size)
        const mockReport = Buffer.alloc(1184, 'A'); // Fill with dummy data

        // Simulate successful file write
        try {
            fs.writeFileSync(OUTPUT_FILE, mockReport);
            console.log(`✅ [MOCK] Attestation report generated and saved to ${OUTPUT_FILE}`);
            console.log(`📄 [MOCK] Report Size: ${mockReport.length} bytes`);
        } catch (writeErr) {
            console.error(`❌ [MOCK] Failed to write report to ${OUTPUT_FILE}:`, writeErr);
            process.exit(1);
        }
    } else {
        console.log('🔄 Calling kernel ioctl via snp_ioctl...');
        execFile(SNP_IOCTL_BIN, [reportDataHex], { encoding: 'buffer', maxBuffer: 4096 }, (error, stdout, stderr) => {
            if (error) {
                console.error('❌ Failed to generate attestation report:', error);
                if (stderr && stderr.length > 0) console.error('Stderr:', stderr.toString());
                process.exit(1);
            }

            // 5. Save Report
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
}

main();
