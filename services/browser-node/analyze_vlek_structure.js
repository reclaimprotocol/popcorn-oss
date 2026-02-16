const fs = require('fs');

const REPORT_FILE = process.env.REPORT_FILE || 'attestation.bin';

if (!fs.existsSync(REPORT_FILE)) {
    console.error(`Error: ${REPORT_FILE} not found.`);
    process.exit(1);
}

// Read the full report
const reportBuffer = fs.readFileSync(REPORT_FILE);

console.log("📄 Attestation Report Analysis");
console.log(`   Total Size: ${reportBuffer.length} bytes\n`);

// Standard SEV-SNP report is 1184 bytes (0x4A0)
const STANDARD_REPORT_SIZE = 1184;
const extraDataSize = reportBuffer.length - STANDARD_REPORT_SIZE;

console.log(`   Standard Report: ${STANDARD_REPORT_SIZE} bytes`);
console.log(`   Extra Data:      ${extraDataSize} bytes\n`);

if (extraDataSize > 0) {
    console.log("🔍 Analyzing Extra Data for Certificates...\n");

    const extraData = reportBuffer.subarray(STANDARD_REPORT_SIZE);

    // Look for DER certificate markers
    // Certificates in DER format start with 0x30 (SEQUENCE tag)
    // Common patterns:
    // - 0x30 0x82 (SEQUENCE with 2-byte length)
    // - 0x30 0x820x03 for certificates > 255 bytes

    let certCount = 0;
    const certificates = [];

    for (let i = 0; i < extraData.length - 4; i++) {
        // Look for DER SEQUENCE marker with 2-byte length encoding
        if (extraData[i] === 0x30 && extraData[i + 1] === 0x82) {
            const lengthHigh = extraData[i + 2];
            const lengthLow = extraData[i + 3];
            const certLength = (lengthHigh << 8) | lengthLow;

            // DER encoded certificates are typically 1KB-3KB
            if (certLength > 100 && certLength < 5000 && i + 4 + certLength <= extraData.length) {
                certCount++;
                const certStart = i;
                const certEnd = i + 4 + certLength;

                console.log(`📜 Certificate ${certCount}:`);
                console.log(`   Offset: 0x${(STANDARD_REPORT_SIZE + certStart).toString(16)} (${STANDARD_REPORT_SIZE + certStart})`);
                console.log(`   Length: ${4 + certLength} bytes`);
                console.log(`   Data starts with: ${extraData.subarray(i, i + 20).toString('hex')}...`);

                certificates.push({
                    index: certCount,
                    offset: STANDARD_REPORT_SIZE + certStart,
                    length: 4 + certLength,
                    data: reportBuffer.subarray(STANDARD_REPORT_SIZE + certStart, STANDARD_REPORT_SIZE + certEnd)
                });

                // Skip past this certificate
                i += 4 + certLength - 1;
            }
        }
    }

    console.log(`\n✅ Found ${certCount} potential certificate(s)\n`);

    // Save certificates to files
    if (certCount > 0) {
        console.log("💾 Saving certificates...\n");

        certificates.forEach(cert => {
            const filename = `vlek_cert_${cert.index}.der`;
            fs.writeFileSync(filename, cert.data);
            console.log(`   Saved: ${filename} (${cert.length} bytes)`);
        });

        console.log("\n🔬 Inspect certificates with:");
        certificates.forEach(cert => {
            console.log(`   openssl x509 -in vlek_cert_${cert.index}.der -inform DER -text -noout`);
        });
    }

} else {
    console.log("⚠️  No extra data found beyond standard report size");
}

// Dump report structure overview
console.log("\n📊 Report Structure Overview:");
console.log(`   Bytes 0-${STANDARD_REPORT_SIZE}: SEV-SNP Attestation Report`);
if (extraDataSize > 0) {
    console.log(`   Bytes ${STANDARD_REPORT_SIZE}-${reportBuffer.length}: Certificate Chain (VLEK)`);
}
