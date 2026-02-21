const crypto = require('crypto');
const https = require('https');
const forge = require('node-forge');

// Parse attestation report structure (SEV-SNP spec Table 22)
function parseAttestationReport(buffer) {
    const report = {};
    if (buffer.length < 1000) {
        throw new Error(`Report buffer is too small: ${buffer.length} bytes`);
    }

    // Policy at offset 0x08 (8 bytes)
    report.policy = buffer.readBigUInt64LE(0x08);
    report.isDebugEnabled = (report.policy & (1n << 19n)) !== 0n;

    // Current TCB Version at offset 0x38 (8 bytes total)
    // 0x38: BootLoader (1 byte)
    // 0x39: TEE (1 byte)
    // 0x3A-0x3D: Reserved (4 bytes)
    // 0x3E: SNP (1 byte)
    // 0x3F: Microcode (1 byte)
    report.reported_tcb = {
        bootloader: buffer.readUInt8(0x38),
        tee: buffer.readUInt8(0x39),
        snp: buffer.readUInt8(0x3E),
        microcode: buffer.readUInt8(0x3F)
    };

    report.reportData = buffer.subarray(0x50, 0x90).toString('hex'); // 64 bytes
    return report;
}

// Helper to convert an AMD little-endian integer buffer to ASN.1 DER integer format
function toDerInt(bigIntBEBuffer) {
    let i = 0;
    while (i < bigIntBEBuffer.length && bigIntBEBuffer[i] === 0) i++;
    let val = bigIntBEBuffer.subarray(i);
    if (val.length === 0) return Buffer.from([0x02, 0x01, 0x00]);
    if (val[0] & 0x80) { // If highest bit is 1, prepend a 0x00 byte to keep it positive
        val = Buffer.concat([Buffer.from([0x00]), val]);
    }
    return Buffer.concat([Buffer.from([0x02, val.length]), val]);
}

// Verify the AMD Certificate Chain of Trust (Root of Trust)
async function verifyAMDChain(vlekCertBuffer) {
    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("🔗 AMD ROOT OF TRUST CHAIN VERIFICATION");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    let vlekCert;
    try {
        vlekCert = new crypto.X509Certificate(vlekCertBuffer);
    } catch (e) {
        throw new Error("Failed to parse VLEK certificate: " + e.message);
    }

    const processors = ['Milan', 'Genoa'];
    let chainVerified = false;

    for (const processor of processors) {
        process.stdout.write(`🌐 Fetching AMD cert chain for ${processor}... `);
        const chainUrl = `https://kdsintf.amd.com/vlek/v1/${processor}/cert_chain`;

        let chainPem = null;
        try {
            chainPem = await new Promise((resolve, reject) => {
                https.get(chainUrl, (res) => {
                    if (res.statusCode !== 200) {
                        return reject(new Error(`HTTP Status ${res.statusCode}`));
                    }
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => resolve(data));
                }).on('error', reject);
            });
        } catch (e) {
            console.log(`Skipped (fetch failed)`);
            continue;
        }

        const certs = chainPem.split('-----END CERTIFICATE-----')
            .map(c => c.trim())
            .filter(c => c.length > 0)
            .map(c => c + '\n-----END CERTIFICATE-----\n');

        if (certs.length < 2) {
            console.log(`Skipped (invalid format)`);
            continue;
        }

        try {
            const askCert = new crypto.X509Certificate(certs[0]);
            const arkCert = new crypto.X509Certificate(certs[1]);

            if (!arkCert.verify(arkCert.publicKey)) throw new Error("AMD ARK is not self-signed");
            if (!askCert.verify(arkCert.publicKey)) throw new Error("AMD ASK is not signed by ARK");
            if (!vlekCert.verify(askCert.publicKey)) throw new Error("VLEK is not signed by ASK");

            console.log(`✅ Valid!`);

            // Check CRL
            try {
                const crlUrl = `https://kdsintf.amd.com/vlek/v1/${processor}/crl`;
                const crlBuf = await new Promise((resolve, reject) => {
                    https.get(crlUrl, (res) => {
                        if (res.statusCode !== 200) return reject(new Error(`HTTP Status ${res.statusCode}`));
                        let chunks = [];
                        res.on('data', c => chunks.push(c));
                        res.on('end', () => resolve(Buffer.concat(chunks)));
                    }).on('error', reject);
                });

                // The serial is a long hex string. We convert it to a buffer
                // and search for it verbatim in the DER-encoded CRL payload. 
                // AMD VLEK serials are long enough that accidental collisions are statistically impossible.
                if (vlekCert.serialNumber.length > 8) {
                    const serialBuffer = Buffer.from(vlekCert.serialNumber, 'hex');
                    if (crlBuf.includes(serialBuffer)) {
                        throw new Error("🚨 VLEK Certificate Serial Number found in AMD's Certificate Revocation List (CRL)! This hardware is compromised.");
                    }
                }
            } catch (e) {
                if (e.message.includes("🚨")) throw e;
                console.log(`⚠️  (CRL check failed/skipped: ${e.message})`);
            }

            chainVerified = true;
            break;
        } catch (e) {
            if (e.message.includes("🚨")) {
                console.error(`\n${e.message}`);
                process.exit(1);
            }
            console.log(`❌ Failed (${e.message})`);
        }
    }

    if (!chainVerified) {
        throw new Error("VLEK Certificate failed verification against all known AMD Root of Trust chains! This certificate is forged or invalid.");
    }
    console.log("✅ AMD Root of Trust verified successfully.");
}

// Verify that the SEV-SNP Hardware TCB matches the TCB signed by AMD in the VLEK Extension
function verifyTCB(vlekCertBuffer, report) {
    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("🧩 TRUSTED COMPUTING BASE (TCB) VERSION VERIFICATION");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    let certAsn1;
    try {
        certAsn1 = forge.asn1.fromDer(forge.util.createBuffer(vlekCertBuffer.toString('binary')));
    } catch (e) {
        throw new Error("Failed to parse VLEK ASN.1 via node-forge: " + e.message);
    }

    // Custom AMD ASN.1 OIDs for the VCEK/VLEK extensions
    const OID_BOOTLOADER = '1.3.6.1.4.1.3704.1.3.1';
    const OID_TEE = '1.3.6.1.4.1.3704.1.3.2';
    const OID_SNP = '1.3.6.1.4.1.3704.1.3.3';
    const OID_MICROCODE = '1.3.6.1.4.1.3704.1.3.8';

    // Helper to extract the integer value from the expected OCTET STRING -> INTEGER representation
    function getExtValue(oidString) {
        // Certificates are SEQUENCE( TBSCertificate, SignatureAlgorithm, SignatureValue )
        const tbsCert = certAsn1.value[0];
        if (!tbsCert || !tbsCert.value) return null;

        // Find the extensions block [3] EXPLICIT
        const extBlockWrapper = tbsCert.value.find(node => node.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC && node.type === 3);
        if (!extBlockWrapper || !extBlockWrapper.value || !extBlockWrapper.value.length) return null;

        const extSequence = extBlockWrapper.value[0];

        for (const ext of extSequence.value) {
            const extIdAsn1 = ext.value[0];
            const extIdStr = forge.asn1.derToOid(extIdAsn1.value);
            if (extIdStr === oidString) {
                const extValueAsn1 = ext.value[ext.value.length - 1]; // usually index 2 or 1
                const rawOctetStringBytes = extValueAsn1.value;

                try {
                    const innerAsn1 = forge.asn1.fromDer(forge.util.createBuffer(rawOctetStringBytes));
                    if (innerAsn1.type === 2) { // INTEGER
                        const bytes = innerAsn1.value;
                        return bytes.charCodeAt(bytes.length - 1);
                    }
                } catch (e) { }

                return rawOctetStringBytes.charCodeAt(rawOctetStringBytes.length - 1);
            }
        }
        return null;
    }

    const certTcb = {
        bootloader: getExtValue(OID_BOOTLOADER),
        tee: getExtValue(OID_TEE),
        snp: getExtValue(OID_SNP),
        microcode: getExtValue(OID_MICROCODE)
    };

    console.log(`[Hardware Report] Bootloader: ${report.reported_tcb.bootloader}  |  [AMD Certificate] Bootloader: ${certTcb.bootloader}`);
    console.log(`[Hardware Report] TEE:        ${report.reported_tcb.tee}  |  [AMD Certificate] TEE:        ${certTcb.tee}`);
    console.log(`[Hardware Report] SNP:        ${report.reported_tcb.snp} |  [AMD Certificate] SNP:        ${certTcb.snp}`);
    console.log(`[Hardware Report] Microcode:  ${report.reported_tcb.microcode} |  [AMD Certificate] Microcode:  ${certTcb.microcode}`);

    if (report.reported_tcb.bootloader < certTcb.bootloader) {
        throw new Error(`TCB Downgrade! Bootloader reported ${report.reported_tcb.bootloader}, but certificate requires ${certTcb.bootloader}`);
    }
    if (report.reported_tcb.tee < certTcb.tee) {
        throw new Error(`TCB Downgrade! TEE reported ${report.reported_tcb.tee}, but certificate requires ${certTcb.tee}`);
    }
    if (report.reported_tcb.snp < certTcb.snp) {
        throw new Error(`TCB Downgrade! SNP reported ${report.reported_tcb.snp}, but certificate requires ${certTcb.snp}`);
    }
    if (report.reported_tcb.microcode < certTcb.microcode) {
        throw new Error(`TCB Downgrade! Microcode reported ${report.reported_tcb.microcode}, but certificate requires ${certTcb.microcode}`);
    }

    console.log("✅ Trusted Computing Base (TCB) satisfies the AMD signed certificate requirements!");
}

// Verify the SEV-SNP raw hardware ECDSA P-384 signature 
function verifyHardwareSignature(reportBytes, certBytes) {
    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("🛡️  CRYPTOGRAPHIC HARDWARE SIGNATURE VERIFICATION");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

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

    console.log("✅ ECDSA P-384 hardware signature successfully validated against AMD VLEK natively!");
}

module.exports = {
    parseAttestationReport,
    verifyAMDChain,
    verifyTCB,
    verifyHardwareSignature
};
