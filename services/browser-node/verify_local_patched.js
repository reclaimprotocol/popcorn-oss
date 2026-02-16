const fs = require('fs');
const crypto = require('crypto');
const https = require('https');

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

console.log("📄 Attestation Report Loaded");
console.log(`   Size: ${reportBuffer.length} bytes`);

console.log("📄 Attestation Report Loaded");
console.log(`   Size: ${reportBuffer.length} bytes`);

// DETECT HEADER: 
// The report size is 1184 bytes. If file is larger (e.g. 1184 + 32 = 1216), or if internal fields make sense shifted.
// Our analysis showed a 32-byte header (Guest Message Header) present.
// SigAlgo (1) was found at offset 0x54 (0x34 + 0x20).
const HEADER_SIZE = 32;

// Parse SEV-SNP Report Fields (based on AMD SEV-SNP Spec)
// Early fields are shifted by HEADER_SIZE.
// Later fields (ChipID) appear to align with standard offsets, implying a 32-byte chunk (HostData?) was stripped.
const POLICY_OFFSET = 0x08;
const POLICY_SIZE = 8;
const CURRENT_TCB_OFFSET = 0x38;
const CURRENT_TCB_SIZE = 8;
const PLATFORM_INFO_OFFSET = 0x40;
const PLATFORM_INFO_SIZE = 8;
const MEASUREMENT_OFFSET = 0x90;
const MEASUREMENT_SIZE = 48;
const REPORT_DATA_OFFSET = 0x50;
const REPORT_DATA_SIZE = 64;

// Chip ID appears to be at standard offset 0x1A0 in the file, implying net shift is 0.
const CHIP_ID_OFFSET = 0x1A0;
const CHIP_ID_SIZE = 64;

const policy = reportBuffer.subarray(HEADER_SIZE + POLICY_OFFSET, HEADER_SIZE + POLICY_OFFSET + POLICY_SIZE);
const currentTcb = reportBuffer.subarray(HEADER_SIZE + CURRENT_TCB_OFFSET, HEADER_SIZE + CURRENT_TCB_OFFSET + CURRENT_TCB_SIZE);
const platformInfo = reportBuffer.subarray(HEADER_SIZE + PLATFORM_INFO_OFFSET, HEADER_SIZE + PLATFORM_INFO_OFFSET + PLATFORM_INFO_SIZE);
const measurement = reportBuffer.subarray(HEADER_SIZE + MEASUREMENT_OFFSET, HEADER_SIZE + MEASUREMENT_OFFSET + MEASUREMENT_SIZE);

// ChipID read from raw offset (no header shift applied)
const chipId = reportBuffer.subarray(CHIP_ID_OFFSET, CHIP_ID_OFFSET + CHIP_ID_SIZE);

// Extract Report Data (With Header Shift)
const reportDataPtr = reportBuffer.subarray(HEADER_SIZE + REPORT_DATA_OFFSET, HEADER_SIZE + REPORT_DATA_OFFSET + REPORT_DATA_SIZE);
const reportDataHex = reportDataPtr.toString('hex');
const reportData = reportDataPtr;

// TCB Structure: [BootLoader, TEE, SNP, Microcode, Reserved...] (Little Endian in report?)
// AMD KDS API Expects: blSPL, teeSPL, snpSPL, ucodeSPL
// Report TCB (64 bits):
//   Bits 0-7:   Boot Loader
//   Bits 8-15:  TEE
//   Bits 16-23: Reserved (SNP?) - Wait, offset in TCB union?
//   Bits 24-31: Microcode
//   Bits 32-39: Reserved
//   Bits 40-47: SNP (Actually check spec order)

// Based on typical TCB Union:
//   uint8_t boot_loader;
//   uint8_t tee;
//   uint8_t reserved[4]; --> Actually snp is usually byte 6?
//   uint8_t snp;
//   uint8_t microcode;

// Let's assume standard byte order from offset 0x38 (Little Endian):
// Byte 0: BootLoader
// Byte 1: TEE
// Byte 2: Reserved
// Byte 3: Reserved
// Byte 4: Reserved
// Byte 5: Reserved
// Byte 6: SNP
// Byte 7: Microcode
// (Need to verify this mapping or just print raw TCB for now)

const chipIdHex = chipId.toString('hex');

console.log("\n💻 Hardware & Platform Info:");
console.log(`   Policy:        0x${policy.reverse().toString('hex')} (Little Endian)`);
console.log(`   Platform Info: 0x${platformInfo.reverse().toString('hex')} (Little Endian)`);
console.log(`   Measurement:   ${measurement.toString('hex')}`);
console.log(`   Chip ID:       ${chipIdHex}`);
console.log(`   Current TCB:   ${currentTcb.toString('hex')} (BL=${currentTcb[0]}, TEE=${currentTcb[1]}, SNP=${currentTcb[6]}, uCode=${currentTcb[7]})`);
console.log(`   Report Data:   ${reportDataHex.substring(0, 64)}...`);

console.log("\n💡 Note: AWS uses VLEK (Versioned Loaded Endorsement Key), not VCEK.");
console.log("   Fetch VLEK certificates with: snpguest certificates der ./certs");



console.log("\n🔒 Verification:");
// ... (existing verification logic) ...
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
    console.error(`❌ Public Key not found at ${COSIGN_PUB_KEY}`);
    process.exit(1);
}

// 3. Expected Report Data Hash: SHA256(ImageHash || KeyHash)
const combined = Buffer.concat([imageHash, pubKeyHash]);
const expectedHash = crypto.createHash('sha256').update(combined).digest();
const expectedHashHex = expectedHash.toString('hex');

console.log(`   Expected Report Data Hash: ${expectedHashHex}`);

// Check if expected hash matches EITHER the first 32 bytes OR the second 32 bytes
const part1 = reportData.subarray(0, 32);
const part2 = reportData.subarray(32, 64);

if (part1.equals(expectedHash)) {
    console.log("\n✅ SUCCESS: Attestation Report matches (First 32 bytes)!");
} else if (part2.equals(expectedHash)) {
    console.log("\n✅ SUCCESS: Attestation Report matches (Second 32 bytes)!");
    console.warn("⚠️  Warning: Hash was found in the second half of ReportData. Standard expectation is first half.");
} else {
    console.error("\n❌ FAILURE: Report Data mismatch.");
    console.error(`   Expected: ${expectedHashHex}`);
    console.error(`   Actual 1: ${part1.toString('hex')}`);
    console.error(`   Actual 2: ${part2.toString('hex')}`);
    process.exit(1);
}
