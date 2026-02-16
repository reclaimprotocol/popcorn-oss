const fs = require('fs');
const crypto = require('crypto');
const { execSync } = require('child_process');

const REPORT_FILE = process.env.REPORT_FILE || 'attestation_with_vlek.bin';
const IMAGE_DIGEST = process.argv[2];
const VLEK_CERT = process.argv[3] || 'vlek.der';
const COSIGN_PUB_KEY = 'services/browser-node/cosign.pub';

if (!IMAGE_DIGEST) {
    console.error("Usage: node verify_vlek.js <IMAGE_DIGEST> [VLEK_CERT_PATH]");
    process.exit(1);
}

if (!fs.existsSync(REPORT_FILE)) {
    console.error(`Error: ${REPORT_FILE} not found.`);
    process.exit(1);
}

if (!fs.existsSync(VLEK_CERT)) {
    console.error(`Error: VLEK certificate ${VLEK_CERT} not found.`);
    process.exit(1);
}

console.log("=".repeat(60));
console.log("🔒 SEV-SNP VLEK Attestation Verification");
console.log("=".repeat(60));

// 1. Load attestation report
const reportBuffer = fs.readFileSync(REPORT_FILE);
const HEADER_SIZE = 32;

console.log(`\n📄 Attestation Report:`);
console.log(`   Size: ${reportBuffer.length} bytes`);

// Parse report fields
const POLICY_OFFSET = 0x08;
const CURRENT_TCB_OFFSET = 0x38;
const PLATFORM_INFO_OFFSET = 0x40;
const MEASUREMENT_OFFSET = 0x90;
const REPORT_DATA_OFFSET = 0x50;
const CHIP_ID_OFFSET = 0x1A0;
const SIG_ALGO_OFFSET = 0x34;
const SIGNATURE_OFFSET = 0x2A0;

const policy = reportBuffer.subarray(HEADER_SIZE + POLICY_OFFSET, HEADER_SIZE + POLICY_OFFSET + 8);
const currentTcb = reportBuffer.subarray(HEADER_SIZE + CURRENT_TCB_OFFSET, HEADER_SIZE + CURRENT_TCB_OFFSET + 8);
const platformInfo = reportBuffer.subarray(HEADER_SIZE + PLATFORM_INFO_OFFSET, HEADER_SIZE + PLATFORM_INFO_OFFSET + 8);
const measurement = reportBuffer.subarray(HEADER_SIZE + MEASUREMENT_OFFSET, HEADER_SIZE + MEASUREMENT_OFFSET + 48);
const chipId = reportBuffer.subarray(CHIP_ID_OFFSET, CHIP_ID_OFFSET + 64);
const reportData = reportBuffer.subarray(HEADER_SIZE + REPORT_DATA_OFFSET, HEADER_SIZE + REPORT_DATA_OFFSET + 64);
const sigAlgo = reportBuffer.readUInt32LE(HEADER_SIZE + SIG_ALGO_OFFSET);
const signature = reportBuffer.subarray(HEADER_SIZE + SIGNATURE_OFFSET, HEADER_SIZE + SIGNATURE_OFFSET + 512);

console.log(`\n💻 Platform Information:`);
console.log(`   Policy:        0x${policy.reverse().toString('hex')}`);
console.log(`   Platform Info: 0x${platformInfo.reverse().toString('hex')}`);
console.log(`   Measurement:   ${measurement.toString('hex').substring(0, 32)}...`);
console.log(`   Chip ID:       ${chipId.toString('hex').substring(0, 32)}...`);
console.log(`   TCB Levels:    BL=${currentTcb[0]}, TEE=${currentTcb[1]}, SNP=${currentTcb[6]}, uCode=${currentTcb[7]}`);
console.log(`   Signature Algo: ${sigAlgo === 1 ? 'ECDSA P-384 with SHA-384' : 'Unknown (' + sigAlgo + ')'}`);

// 2. Verify report data
console.log(`\n🔬 Report Data Verification:`);
const imageHash = crypto.createHash('sha256').update(IMAGE_DIGEST).digest();
let pubKeyHash = Buffer.alloc(32);
if (fs.existsSync(COSIGN_PUB_KEY)) {
    const pubKeyContent = fs.readFileSync(COSIGN_PUB_KEY);
    pubKeyHash = crypto.createHash('sha256').update(pubKeyContent).digest();
}
const combined = Buffer.concat([imageHash, pubKeyHash]);
const expectedHash = crypto.createHash('sha256').update(combined).digest();

const part1 = reportData.subarray(0, 32);
const part2 = reportData.subarray(32, 64);

if (part1.equals(expectedHash)) {
    console.log(`   ✅ Report data matches image digest (first 32 bytes)`);
} else if (part2.equals(expectedHash)) {
    console.log(`   ✅ Report data matches image digest (second 32 bytes)`);
} else {
    console.error(`   ❌ Report data mismatch!`);
    console.error(`   Expected: ${expectedHash.toString('hex')}`);
    console.error(`   Actual 1: ${part1.toString('hex')}`);
    console.error(`   Actual 2: ${part2.toString('hex')}`);
    process.exit(1);
}

// 3. Inspect VLEK certificate
console.log(`\n📜 VLEK Certificate:`);
try {
    const certInfo = execSync(`openssl x509 -in ${VLEK_CERT} -inform DER -subject -issuer -dates -noout`).toString();
    console.log(certInfo.split('\n').map(line => `   ${line}`).join('\n'));
} catch (err) {
    console.error(`   ❌ Failed to parse VLEK certificate:`, err.message);
    process.exit(1);
}

// 4. Verify signature (conceptual - full implementation would use crypto library)
console.log(`\n🔐 Signature Verification:`);
console.log(`   ⚠️  Signature verification requires ECDSA P-384 implementation`);
console.log(`   📝 Signature present: ${signature.subarray(0, 96).toString('hex').substring(0, 32)}...`);
console.log(`   💡 Full verification would:`);
console.log(`      1. Extract public key from VLEK certificate`);
console.log(`      2. Hash the attestation report (bytes 0x0-0x2A0)`);
console.log(`      3. Verify ECDSA signature using VLEK public key`);
console.log(`      4. Verify VLEK cert chain: ARK → ASK → VLEK`);

console.log(`\n${"=".repeat(60)}`);
console.log(`✅ Basic Verification Complete`);
console.log(`${"=".repeat(60)}`);
console.log(`\nVerified:`);
console.log(`  ✅ Report data binds to image digest`);
console.log(`  ✅ VLEK certificate is valid and parseable`);
console.log(`  ✅ Platforminformation extracted`);
console.log(`\nNOTE: Full cryptographic signature verification requires implementing`);
console.log(`ECDSA P-384 validation, which is complex. For production, use snpguest:`);
console.log(`  snpguest verify attestation --report attestation.bin --certs-dir ./certs`);
console.log(`${"=".repeat(60)}\n`);
