import assert from "node:assert";

const BASE_URL = process.env.BASE_URL || "http://localhost:6080";

interface ReclaimProveRequest {
    provider_params_json: string;
    config_json?: string;
}

interface ReclaimConfig {
    requestId: string;
    disableProxy?: boolean;
}

interface ReclaimProveResponse {
    session_id: string;
    claim: {
        provider?: string;
        parameters?: string;
        owner?: string;
        timestamp_s?: number;
        context?: string;
        identifier?: string;
        epoch?: number;
    };
    signature: {
        attestor_address?: string;
        claim_signature?: string;
        result_signature?: string;
    };
}

// buildProviderParams is the oprf/oprf-mpc example — it exercises the ZK hash
// modes, so the redacted value is proven as a commitment rather than plaintext.
function buildProviderParams(hashType: "oprf-mpc" | "oprf") {
    return {
        name: "http",
        params: {
            url: "https://vpic.nhtsa.dot.gov/",
            method: "GET",
            geoLocation: "US",
            responseMatches: [
                {
                    value: "{{addr}}",
                    type: "contains",
                },
            ],
            responseRedactions: [
                {
                    xPath: "/html/body/footer/div[2]/div/div[1]/ul[3]/li[2]/a",
                    regex: 'href="https://(?<addr>www.trafficsafetymarketing.gov)/"',
                    hash: hashType,
                },
            ],
            paramValues: {
                addr: "www.trafficsafetymarketing.gov",
            },
        },
        secretParams: {
            headers: {
                accept: "application/json, text/plain, */*",
            },
        },
        context: JSON.stringify({ purpose: "test", source: "integration-tests" }),
    };
}

// buildIpProviderParams proves against api.ipify.org, which echoes the caller's
// public IP as JSON. No hash — the extraction returns the plaintext egress IP,
// so it can be shape-checked and compared across direct vs proxied connections.
// A named capture group keeps the IP dynamic (no {{template}}/paramValues).
function buildIpProviderParams() {
    return {
        name: "http",
        params: {
            url: "https://api.ipify.org?format=json",
            method: "GET",
            geoLocation: "IN",
            responseMatches: [
                {
                    value: '"ip":"(?<internetProtocolAddress>[^"]+)"',
                    type: "regex",
                },
            ],
            responseRedactions: [
                {
                    jsonPath: "$.ip",
                    regex: '"ip":"(?<internetProtocolAddress>[^"]+)"',
                },
            ],
        },
        secretParams: {
            headers: {
                accept: "application/json, text/plain, */*",
            },
        },
        context: JSON.stringify({ purpose: "ip-check", source: "integration-tests" }),
    };
}

async function proveWith(
    requestId: string,
    providerParams: object,
    disableProxy?: boolean,
): Promise<ReclaimProveResponse> {
    const config: ReclaimConfig = { requestId };
    if (disableProxy !== undefined) {
        config.disableProxy = disableProxy;
    }
    const request: ReclaimProveRequest = {
        provider_params_json: JSON.stringify(providerParams),
        config_json: JSON.stringify(config),
    };

    const response = await fetch(`${BASE_URL}/reclaim/prove`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`POST /reclaim/prove returned ${response.status}: ${body}`);
    }

    return response.json();
}

function reclaimProve(
    requestId: string,
    hashType: "oprf-mpc" | "oprf",
    disableProxy?: boolean,
): Promise<ReclaimProveResponse> {
    return proveWith(requestId, buildProviderParams(hashType), disableProxy);
}

function assertAttestedClaim(result: ReclaimProveResponse) {
    assert.strictEqual(result.claim.provider, "http");
    assert.match(result.claim.identifier!, /^0x[a-f0-9]{64}$/);
    assert.match(result.claim.owner!, /^0x[a-f0-9]{40}$/);
    assert.ok(result.claim.timestamp_s! > 0, "timestamp should be positive");
    assert.ok(result.claim.epoch! >= 1, "epoch should be >= 1");

    // Verify TEE attestation context
    const context = JSON.parse(result.claim.context!);
    assert.ok(context.pcr0_k, "missing TEE-K attestation (pcr0_k)");
    assert.ok(context.pcr0_t, "missing TEE-T attestation (pcr0_t)");
    assert.ok(context.tee_session_id, "missing tee_session_id");

    // Verify signatures
    assert.match(result.signature.attestor_address!, /^0x[a-f0-9]{40}$/);
    assert.ok(result.signature.claim_signature!.length > 0);
    assert.ok(result.signature.result_signature!.length > 0);

    return context;
}

function assertValidClaim(result: ReclaimProveResponse, expectedHash: string) {
    const context = assertAttestedClaim(result);

    // Verify hash type in parameters
    const parameters = JSON.parse(result.claim.parameters!);
    const redaction = parameters.responseRedactions[0];
    assert.strictEqual(redaction.hash, expectedHash);

    assert.ok(context.extractedParameters.addr, "missing extracted addr value");
}

// assertValidIpClaim validates the ipify claim and returns the plaintext egress
// IP (no hash on that provider, so extractedParameters holds the raw value).
function assertValidIpClaim(result: ReclaimProveResponse): string {
    const context = assertAttestedClaim(result);
    const ip = context.extractedParameters?.internetProtocolAddress;
    assert.ok(typeof ip === "string" && ip.length > 0, "missing extracted internetProtocolAddress value");
    assert.match(ip, /^[0-9a-fA-F:.]+$/, `extracted value is not IP-shaped: ${ip}`);
    return ip;
}

async function main() {
    console.log("--- Test 1: oprf-mpc ---");
    const result1 = await reclaimProve("testoprfmpc", "oprf-mpc");
    console.log(result1);
    assertValidClaim(result1, "oprf-mpc");
    console.log("✅ oprf-mpc passed\n");

    console.log("--- Test 2: oprf ---");
    const result2 = await reclaimProve("testoprf", "oprf");
    console.log(result2);
    assertValidClaim(result2, "oprf");
    console.log("✅ oprf passed\n");

    console.log("--- Test 3: ip check ---");
    const ipResult = await proveWith("testipcheck", buildIpProviderParams());
    console.log(ipResult);
    const ip = assertValidIpClaim(ipResult);
    console.log(`✅ ip check passed (egress IP: ${ip})\n`);

    // Proxy toggle: only meaningful when an HTTPS proxy is configured on the
    // runtime. When HTTPS_PROXY_URL is set we prove the IP provider twice — once
    // through the proxy (disableProxy=false) and once forcing a direct connection
    // (disableProxy=true) — to confirm both paths yield a valid claim.
    if (process.env.HTTPS_PROXY_URL) {
        console.log("--- Test 4: proxy enabled (disableProxy=false) ---");
        const proxyOn = await proveWith("testproxyon", buildIpProviderParams(), false);
        console.log(proxyOn);
        const ipProxyOn = assertValidIpClaim(proxyOn);
        console.log(`✅ proxy-enabled passed (egress IP: ${ipProxyOn})\n`);

        console.log("--- Test 5: proxy disabled (disableProxy=true) ---");
        const proxyOff = await proveWith("testproxyoff", buildIpProviderParams(), true);
        console.log(proxyOff);
        const ipProxyOff = assertValidIpClaim(proxyOff);
        console.log(`✅ proxy-disabled passed (egress IP: ${ipProxyOff})\n`);
    } else {
        console.log("--- Skipping proxy toggle tests: HTTPS_PROXY_URL not set ---\n");
    }

    console.log("✅ All tests passed");
}

main().catch((err) => {
    console.error("❌ Test failed:", err);
    process.exit(1);
});
