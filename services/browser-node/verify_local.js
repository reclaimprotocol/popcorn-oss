const fs = require('fs');
const crypto = require('crypto');

const REPORT_FILE = process.env.REPORT_FILE || 'attestation.bin';
const IMAGE_DIGEST = process.argv[2];
const COSIGN_PUB_KEY = process.argv[3] || 'services/browser-node/cosign.pub';

if (!IMAGE_DIGEST) {
    console.error("Usage: node verify_local.js <IMAGE_DIGEST> [PATH_TO_PUBLIC_KEY]");
    process.exit(1);
}

if (!fs.existsSync(REPORT_FILE)) {
    console.error(`Error: ${REPORT_FILE} not found.`);
    process.exit(1);
}

// Read the report
const reportBuffer = fs.readFileSync(REPORT_FILE);

// SEV-SNP Report Structure (simplified)
// ...
// report_data (64 bytes) -> Offset 0x050 (80 decimal)

const REPORT_DATA_OFFSET = 0x050; // 80 decimal
const REPORT_DATA_SIZE = 64;

const reportData = reportBuffer.subarray(REPORT_DATA_OFFSET, REPORT_DATA_OFFSET + REPORT_DATA_SIZE);

console.log("📄 Attestation Report Loaded");
console.log(`   Size: ${reportBuffer.length} bytes`);
console.log(`   Report Data (Hex): ${reportData.toString('hex')}`);

console.log("\n🔒 Verification:");
console.log(`   Input Digest: ${IMAGE_DIGEST}`);

// 1. Calculate Image Hash
const imageHash = crypto.createHash('sha256').update(IMAGE_DIGEST).digest();
console.log(`   Image Hash:   ${imageHash.toString('hex')}`);

// 2. Calculate Key Hash
let pubKeyHash = Buffer.alloc(32);
if (fs.existsSync(COSIGN_PUB_KEY)) {
    console.log(`   Public Key:   ${COSIGN_PUB_KEY}`);
    const pubKeyContent = fs.readFileSync(COSIGN_PUB_KEY);
    pubKeyHash = crypto.createHash('sha256').update(pubKeyContent).digest();
    console.log(`   Key Hash:     ${pubKeyHash.toString('hex')}`);
} else {
    console.warn(`⚠️  Public Key not found at ${COSIGN_PUB_KEY}. Assuming Zero Key Hash (Match Mock behavior if key missing).`);
}

// 3. Expected Report Data: SHA256(ImageHash || KeyHash)
const combined = Buffer.concat([imageHash, pubKeyHash]);
const expectedHash = crypto.createHash('sha256').update(combined).digest();
const expectedHashHex = expectedHash.toString('hex');

console.log(`   Expected Report Data Hash: ${expectedHashHex} (...padded)`);

// Check if expected hash matches the first 32 bytes of report data
// or if it's somewhere else? attest.js produces 32 byte hash and converts to hex, so it's 64 chars.
// Wait, attest.js: "reportDataHex = reportDataHash.toString('hex')" -> This is a 64-char string (32 bytes data).
// But snp_ioctl takes HEX STRING.
// And `snp_ioctl.c` converts hex string to bytes: `hex_to_bytes(hex_data, req.user_data, 64);`
// So `req.user_data` will contain the 32 bytes of our hash, followed by 32 bytes of zeros (if we passed 64 chars = 32 bytes).
// Wait, `snp_ioctl.c` checks: "if (strlen(hex_data) != 128) { ... Error }"
// `attest.js` produces `reportDataHex` which is `reportDataHash` (32 bytes) -> 64 hex chars.
// It relies on padding?
// Let's check `attest.js` again.
// `const finalBuffer = Buffer.alloc(64); hash.copy(finalBuffer); reportDataHex = finalBuffer.toString('hex');` <- OLD CODE.
// NEW CODE in attest.js:
// `reportDataHex = reportDataHash.toString('hex');`
// `reportDataHash` is 32 bytes. `toString('hex')` is 64 chars.
// `snp_ioctl` expects 128 chars (64 bytes).
// BUG ALERT: usage of `snp_ioctl` in `attest.js` might fail if I didn't pad it.

// checking attest.js details in my memory/output...
// I wrote: `reportDataHex = reportDataHash.toString('hex');`
// I did NOT pad it to 64 bytes (128 hex chars).
// I need to fix `attest.js` to pad the result to 64 bytes.

// FIXING VERIFY_LOCAL.JS FIRST to be correct logic, assuming attest is fixed.
// If valid is 32-byte hash, we expect report_data[0..31] == expectedHash.

if (reportData.subarray(0, 32).equals(expectedHash)) {
    console.log("\n✅ SUCCESS: Attestation Report matches Image Digest + Public Key!");
} else {
    console.error("\n❌ FAILURE: Report Data mismatch.");
    console.error(`   Expected: ${expectedHashHex}`);
    console.error(`   Actual:   ${reportData.subarray(0, 32).toString('hex')}`);
    process.exit(1);
}
