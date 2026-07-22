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

async function reclaimProve(
    requestId: string,
    hashType: "oprf-mpc" | "oprf",
    disableProxy?: boolean,
): Promise<ReclaimProveResponse> {
    const config: ReclaimConfig = { requestId };
    if (disableProxy !== undefined) {
        config.disableProxy = disableProxy;
    }
    const request: ReclaimProveRequest = {
        provider_params_json: JSON.stringify(buildProviderParams(hashType)),
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

function assertValidClaim(result: ReclaimProveResponse, expectedHash: string) {
    assert.strictEqual(result.claim.provider, "http");
    assert.match(result.claim.identifier!, /^0x[a-f0-9]{64}$/);
    assert.match(result.claim.owner!, /^0x[a-f0-9]{40}$/);
    assert.ok(result.claim.timestamp_s! > 0, "timestamp should be positive");
    assert.ok(result.claim.epoch! >= 1, "epoch should be >= 1");

    // Verify hash type in parameters
    const parameters = JSON.parse(result.claim.parameters!);
    const redaction = parameters.responseRedactions[0];
    assert.strictEqual(redaction.hash, expectedHash);

    // Verify TEE attestation context
    const context = JSON.parse(result.claim.context!);
    assert.ok(context.pcr0_k, "missing TEE-K attestation (pcr0_k)");
    assert.ok(context.pcr0_t, "missing TEE-T attestation (pcr0_t)");
    assert.ok(context.tee_session_id, "missing tee_session_id");
    assert.ok(context.extractedParameters.addr, "missing extracted addr value");

    // Verify signatures
    assert.match(result.signature.attestor_address!, /^0x[a-f0-9]{40}$/);
    assert.ok(result.signature.claim_signature!.length > 0);
    assert.ok(result.signature.result_signature!.length > 0);
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

    // Proxy toggle: only meaningful when an HTTPS proxy is configured on the
    // runtime. When HTTPS_PROXY_URL is set we prove the same provider twice —
    // once through the proxy (disableProxy=false) and once forcing a direct
    // connection (disableProxy=true) — to confirm both paths yield a valid claim.
    if (process.env.HTTPS_PROXY_URL) {
        console.log("--- Test 3: proxy enabled (disableProxy=false) ---");
        const proxyOn = await reclaimProve("testproxyon", "oprf-mpc", false);
        console.log(proxyOn);
        assertValidClaim(proxyOn, "oprf-mpc");
        console.log("✅ proxy-enabled passed\n");

        console.log("--- Test 4: proxy disabled (disableProxy=true) ---");
        const proxyOff = await reclaimProve("testproxyoff", "oprf-mpc", true);
        console.log(proxyOff);
        assertValidClaim(proxyOff, "oprf-mpc");
        console.log("✅ proxy-disabled passed\n");
    } else {
        console.log("--- Skipping proxy toggle tests: HTTPS_PROXY_URL not set ---\n");
    }

    console.log("✅ All tests passed");
}

main().catch((err) => {
    console.error("❌ Test failed:", err);
    process.exit(1);
});
