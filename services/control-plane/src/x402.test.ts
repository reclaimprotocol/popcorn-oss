import { describe, expect, test } from 'bun:test';
import { createAuthenticatedCdpFacilitator, hashCanonicalPaymentPayload, X402PaymentGateway } from './x402-payment';
import {
  decryptX402SettlementRequest,
  deriveSessionCapability,
  encryptX402SettlementRequest,
  hasX402ExtensionActivationWindow,
  isOwnedPublicX402Session,
  publicX402SessionUrl,
  publicX402Endpoints,
  selectTrustedClientAddress,
} from './x402-utils';
import { generateKeyPairSync } from 'node:crypto';
import { withLeaseClaims, X402ClaimBusyError } from './x402-coordination';
import { authorizationSearchRanges, inspectAuthorizationOutcome } from './x402-chain';
import { encodeFunctionData, parseAbi } from 'viem';
import { readBoundedJsonBody } from './http-body';
import { recoverInterruptedExtension, runCleanupAttempt } from './x402-recovery';

describe('x402 safety helpers', () => {
  test('requires enough remaining workload time to settle before extension activation', () => {
    const now = Date.now();
    expect(hasX402ExtensionActivationWindow(new Date(now + 240_001), now)).toBe(true);
    expect(hasX402ExtensionActivationWindow(new Date(now + 240_000), now)).toBe(false);
    expect(hasX402ExtensionActivationWindow(new Date(now + 15_000), now)).toBe(false);
  });

  test('uses a semantic payment-payload replay hash', () => {
    const first = {
      x402Version: 2,
      accepted: { scheme: 'exact', network: 'eip155:8453', asset: '0xasset', amount: '10000', payTo: '0xpay', maxTimeoutSeconds: 60, extra: {} },
      payload: { signature: '0xsig', authorization: { nonce: '0x01', from: '0xpayer', value: '10000' } },
    } as any;
    const equivalent = {
      payload: { authorization: { value: '10000', from: '0xpayer', nonce: '0x01' }, signature: '0xsig' },
      accepted: { extra: { mutable: true }, payTo: '0xother', amount: '99999', asset: '0xasset', network: 'eip155:8453', maxTimeoutSeconds: 30, scheme: 'exact' },
      resource: { url: 'https://different.example/resource' },
      x402Version: 2,
    } as any;
    const differentAuthorization = {
      ...first,
      payload: { ...first.payload, authorization: { ...first.payload.authorization, nonce: '0x02' } },
    } as any;

    expect(hashCanonicalPaymentPayload(first)).toBe(hashCanonicalPaymentPayload(equivalent));
    expect(hashCanonicalPaymentPayload(first)).not.toBe(hashCanonicalPaymentPayload(differentAuthorization));
  });

  test('only exposes restricted URLs on the configured Popcorn gateway', () => {
    const endpoints = publicX402Endpoints({
      url: 'https://popcorn-gateway-gcp-us-central1-x402.reclaimprotocol.org/browser-agent-1/session/token/',
      cdpUrl: 'wss://popcorn-gateway-gcp-us-central1-x402.reclaimprotocol.org/cdp-agent/session/token/',
      cdpInternalUrl: 'wss://popcorn-gateway-gcp-us-central1-x402.reclaimprotocol.org/cdp-internal/session/internal/',
      apiUrl: 'https://popcorn-gateway-gcp-us-central1-x402.reclaimprotocol.org/api/session/internal/',
      restrictedToken: 'secret',
    }, 'https://popcorn-gateway-gcp-us-central1-x402.reclaimprotocol.org', 'session');
    expect(endpoints).toEqual({
      liveViewUrl: 'https://popcorn-gateway-gcp-us-central1-x402.reclaimprotocol.org/browser-agent-1/session/token/',
      connectUrl: 'wss://popcorn-gateway-gcp-us-central1-x402.reclaimprotocol.org/cdp-agent/session/token/',
      vncUrl: 'https://popcorn-gateway-gcp-us-central1-x402.reclaimprotocol.org/liveview/session/token/liveview.html?resize=scale&reconnect=1&reconnect_delay=2000',
      vncWsUrl: 'wss://popcorn-gateway-gcp-us-central1-x402.reclaimprotocol.org/liveview-ws/session/token',
    });
    expect(JSON.stringify(endpoints)).not.toContain('internal');
    expect(JSON.stringify(endpoints)).not.toContain('secret');
  });

  test('rejects arbitrary same-host live and CDP paths', () => {
    expect(publicX402Endpoints({
      url: 'https://popcorn-gateway.example/marketing/session/token/',
      cdpUrl: 'wss://popcorn-gateway.example/cdp-agent/session/token/extra/',
    }, 'https://popcorn-gateway.example', 'session')).toEqual({});
  });

  test('accepts only the canonical VNC live-view route and fixed reconnect options', () => {
    const gateway = 'https://popcorn-gateway.example';
    const canonical = 'https://popcorn-gateway.example/vnc/session/restricted.jwt/liveview.html?resize=scale&reconnect=1&reconnect_delay=2000';
    expect(publicX402Endpoints({
      url: canonical,
      cdpUrl: 'wss://popcorn-gateway.example/cdp-agent/session/automation.jwt/',
    }, gateway, 'session')).toEqual({
      liveViewUrl: canonical,
      connectUrl: 'wss://popcorn-gateway.example/cdp-agent/session/automation.jwt/',
      vncUrl: 'https://popcorn-gateway.example/liveview/session/restricted.jwt/liveview.html?resize=scale&reconnect=1&reconnect_delay=2000',
      vncWsUrl: 'wss://popcorn-gateway.example/liveview-ws/session/restricted.jwt',
    });

    for (const rejected of [
      'https://popcorn-gateway.example/vnc/other/restricted.jwt/liveview.html?resize=scale&reconnect=1&reconnect_delay=2000',
      'https://popcorn-gateway.example/vnc/session/restricted.jwt/liveview.html?resize=fit&reconnect=1&reconnect_delay=2000',
      'https://popcorn-gateway.example/vnc/session/restricted.jwt/liveview.html?resize=scale&reconnect=1&reconnect_delay=2000&next=https://evil.example',
      'https://popcorn-gateway.example/vnc/session/restricted.jwt/liveview.html?resize=scale&reconnect=1',
      'https://popcorn-gateway.example/vnc/session/restricted.jwt/other.html?resize=scale&reconnect=1&reconnect_delay=2000',
    ]) {
      expect(publicX402Endpoints({ url: rejected }, gateway, 'session')).toEqual({});
    }
  });

  test('preserves canonical LiveView and RFB WebSocket fields from the regional response', () => {
    const gateway = 'https://popcorn-gateway.example';
    const vncUrl = `${gateway}/liveview/session/restricted.jwt/liveview.html?resize=scale&reconnect=1&reconnect_delay=2000`;
    const vncWsUrl = 'wss://popcorn-gateway.example/liveview-ws/session/restricted.jwt';
    expect(publicX402Endpoints({
      url: vncUrl,
      cdpUrl: 'wss://popcorn-gateway.example/cdp-agent/session/automation.jwt/',
      vncUrl,
      vncWsUrl,
    }, gateway, 'session')).toEqual({
      liveViewUrl: vncUrl,
      connectUrl: 'wss://popcorn-gateway.example/cdp-agent/session/automation.jwt/',
      vncUrl,
      vncWsUrl,
    });
  });

  test('rejects foreign hosts and derives stable session capabilities without persistence', () => {
    expect(publicX402Endpoints({
      url: 'https://evil.example/liveview',
      cdpUrl: 'ws://popcorn-gateway.example/cdp/session',
    }, 'https://popcorn-gateway.example', 'session')).toEqual({});
    const capability = deriveSessionCapability('a'.repeat(32), 'internal-session');
    expect(capability).toBe(deriveSessionCapability('a'.repeat(32), 'internal-session'));
    expect(capability).not.toBe(deriveSessionCapability('a'.repeat(32), 'other-session'));
    expect(capability).toMatch(/^x402s_[A-Za-z0-9_-]{43}$/);
    expect(publicX402SessionUrl('https://app.popcorn.reclaimprotocol.org', capability))
      .toBe(`https://app.popcorn.reclaimprotocol.org/v1/x402/sessions/${capability}`);
  });

  test('never treats normal-client or foreign-cluster sessions as x402-owned', () => {
    const access = { sessionId: 'internal-x402-session' };
    const expected = {
      clientId: 'x402-public',
      region: 'x402-us-central1',
      clusterName: 'gcp-us-central1-x402-popcorn',
    };
    const owned = { sessionId: access.sessionId, ...expected };

    expect(isOwnedPublicX402Session(owned, access, expected)).toBe(true);
    expect(isOwnedPublicX402Session({ ...owned, clientId: 'existing-client' }, access, expected)).toBe(false);
    expect(isOwnedPublicX402Session({ ...owned, region: 'asia-south1' }, access, expected)).toBe(false);
    expect(isOwnedPublicX402Session({ ...owned, clusterName: 'mumbai-production' }, access, expected)).toBe(false);
    expect(isOwnedPublicX402Session(owned, { sessionId: 'different-session' }, expected)).toBe(false);
    expect(isOwnedPublicX402Session(owned, undefined, expected)).toBe(false);
  });

  test('selects the client address from the trusted right side of X-Forwarded-For', () => {
    expect(selectTrustedClientAddress('spoofed, 198.51.100.4, 10.0.0.2', undefined, 1)).toBe('10.0.0.2');
    expect(selectTrustedClientAddress('spoofed, 198.51.100.4, 10.0.0.2', undefined, 2)).toBe('198.51.100.4');
    expect(selectTrustedClientAddress('spoofed', undefined, 0)).toBe('direct');
  });

  test('encrypts durable settlement requests for reconciliation', () => {
    const secret = 's'.repeat(32);
    const encrypted = encryptX402SettlementRequest(secret, { nonce: '0x01', signature: '0xsigned' });
    expect(encrypted).not.toContain('0xsigned');
    expect(decryptX402SettlementRequest<{ nonce: string; signature: string }>(secret, encrypted))
      .toEqual({ nonce: '0x01', signature: '0xsigned' });
    expect(() => decryptX402SettlementRequest('x'.repeat(32), encrypted)).toThrow();
  });
});

describe('CDP facilitator authentication', () => {
  test('signs supported, verify, and settle requests with per-path JWTs', async () => {
    const { privateKey } = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const originalFetch = globalThis.fetch;
    const seen: Array<{ url: string; method: string; authorization: string | null }> = [];
    globalThis.fetch = (async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = String(request);
      const headers = new Headers(init?.headers);
      seen.push({ url, method: init?.method || 'GET', authorization: headers.get('Authorization') });
      if (url.endsWith('/supported')) {
        return Response.json({ kinds: [], extensions: [], signers: {} });
      }
      if (url.endsWith('/verify')) {
        return Response.json({ isValid: true, payer: '0xpayer' });
      }
      return Response.json({ success: true, transaction: '0xtx', network: 'eip155:8453', payer: '0xpayer' });
    }) as typeof fetch;
    try {
      const facilitator = createAuthenticatedCdpFacilitator({
        apiKeyId: 'organizations/test/apiKeys/test',
        apiKeySecret: privateKey,
        baseUrl: 'https://api.cdp.coinbase.com/platform/v2/x402',
      });
      const requirements = {
        scheme: 'exact', network: 'eip155:8453', asset: '0xasset', amount: '10000', payTo: '0xpay', maxTimeoutSeconds: 60, extra: {},
      } as any;
      const payload = { x402Version: 2, accepted: requirements, payload: {} } as any;
      await facilitator.getSupported();
      await facilitator.verify(payload, requirements);
      await facilitator.settle(payload, requirements);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(seen.map((request) => request.method)).toEqual(['GET', 'POST', 'POST']);
    expect(seen.every((request) => request.authorization?.startsWith('Bearer '))).toBe(true);
    expect(seen.map((request) => new URL(request.url).pathname)).toEqual([
      '/platform/v2/x402/supported',
      '/platform/v2/x402/verify',
      '/platform/v2/x402/settle',
    ]);
  });
});

describe('configurable x402 payment contract', () => {
  test('uses configured price, asset metadata, and static facilitator headers', async () => {
    const originalFetch = globalThis.fetch;
    let authorization: string | null = null;
    globalThis.fetch = (async (_request: RequestInfo | URL, init?: RequestInit) => {
      authorization = new Headers(init?.headers).get('X-Facilitator-Key');
      return Response.json({
        kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:84532' }],
        extensions: [],
        signers: {},
      });
    }) as typeof fetch;
    try {
      const gateway = new X402PaymentGateway({
        network: 'eip155:84532',
        facilitatorUrl: 'https://facilitator.example/x402',
        facilitatorAuthMode: 'headers',
        facilitatorAuthHeaders: { 'X-Facilitator-Key': 'secret' },
        payTo: '0x1111111111111111111111111111111111111111',
        pricePerBlockAtomic: 37,
        paymentAssetAddress: '0x2222222222222222222222222222222222222222',
        paymentAssetName: 'Example Token',
        paymentAssetVersion: '7',
      } as any);
      const offer = await gateway.createOffer({
        blocks: 3,
        resourceUrl: 'https://control-plane.example/v1/x402/sessions',
        description: 'Test session',
      });
      expect(authorization).toBe('secret');
      expect(offer.requirements).toMatchObject({
        network: 'eip155:84532',
        asset: '0x2222222222222222222222222222222222222222',
        amount: '111',
        extra: { name: 'Example Token', version: '7' },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('reads custom payment and facilitator settings from the environment', async () => {
    const child = Bun.spawn([
      'bun',
      '-e',
      `const {ControlPlaneConfig}=await import('./src/config.ts'); console.log(JSON.stringify(ControlPlaneConfig.x402));`,
    ], {
      cwd: import.meta.dir + '/..',
      env: {
        ...process.env,
        CONTROL_PLANE_SERVICE_AUTH_TOKEN: 'test-service-token',
        CONTROL_PLANE_REGIONS: '[]',
        X402_ENABLED: 'false',
        X402_BLOCK_SECONDS: '90',
        X402_PRICE_PER_BLOCK_ATOMIC: '321',
        X402_PAYMENT_ASSET_ADDRESS: '0x2222222222222222222222222222222222222222',
        X402_PAYMENT_ASSET_NAME: 'Example Token',
        X402_PAYMENT_ASSET_VERSION: '7',
        X402_FACILITATOR_URL: 'https://facilitator.example/x402',
        X402_FACILITATOR_AUTH_MODE: 'headers',
        X402_FACILITATOR_AUTH_HEADERS: '{"X-API-Key":"secret"}',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode, stderr).toBe(0);
    expect(JSON.parse(stdout.trim())).toMatchObject({
      blockSeconds: 90,
      pricePerBlockAtomic: 321,
      paymentAssetAddress: '0x2222222222222222222222222222222222222222',
      paymentAssetName: 'Example Token',
      paymentAssetVersion: '7',
      facilitatorUrl: 'https://facilitator.example/x402',
      facilitatorAuthMode: 'headers',
      facilitatorAuthHeaders: { 'X-API-Key': 'secret' },
    });
  });
});

describe('EIP-3009 settlement reconciliation', () => {
  const payer = '0x1111111111111111111111111111111111111111' as `0x${string}`;
  const asset = '0x2222222222222222222222222222222222222222' as `0x${string}`;
  const nonce = `0x${'ab'.repeat(32)}` as `0x${string}`;
  const payTo = '0x3333333333333333333333333333333333333333' as `0x${string}`;
  const transactionHash = `0x${'cd'.repeat(32)}`;
  const executionAbi = parseAbi([
    'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)',
  ]);
  const evidence = (to: `0x${string}` = payTo, value = 10000n) => ({
    hash: transactionHash as `0x${string}`,
    to: asset as `0x${string}`,
    receiptStatus: 'success' as const,
    input: encodeFunctionData({
      abi: executionAbi,
      functionName: 'transferWithAuthorization',
      args: [payer, to, value, 0n, 2000000000n, nonce, 27, `0x${'01'.repeat(32)}`, `0x${'02'.repeat(32)}`],
    }),
  });
  const payload = {
    x402Version: 2,
    accepted: { scheme: 'exact', network: 'eip155:8453', asset, amount: '10000', payTo, maxTimeoutSeconds: 600, extra: {} },
    payload: { signature: '0xsig', authorization: { from: payer, to: payTo, value: '10000', nonce, validAfter: '0', validBefore: '2000000000' } },
  } as any;

  test('recovers the original transaction for a consumed authorization', async () => {
    const result = await inspectAuthorizationOutcome(payload, payload.accepted, 123n, {
      currentBlock: async () => 456n,
      chainId: async () => 8453,
      authorizationUsed: async () => true,
      authorizationTransaction: async (_asset, _payer, _nonce, startBlock) => {
        expect(startBlock).toBe(123n);
        return evidence();
      },
    });
    expect(result).toEqual({
      status: 'settled',
      transactionHash,
      payer,
    });
  });

  test('only retries a provably unspent, unexpired authorization', async () => {
    const result = await inspectAuthorizationOutcome(payload, payload.accepted, 123n, {
      currentBlock: async () => 456n,
      chainId: async () => 8453,
      authorizationUsed: async () => false,
      authorizationTransaction: async () => { throw new Error('must not query logs'); },
    });
    expect(result).toEqual({ status: 'unused', validBefore: 2000000000 });
  });

  test('fails closed when a used authorization transaction cannot be proven', async () => {
    const result = await inspectAuthorizationOutcome(payload, payload.accepted, 123n, {
      currentBlock: async () => 456n,
      chainId: async () => 8453,
      authorizationUsed: async () => true,
      authorizationTransaction: async () => undefined,
    });
    expect(result.status).toBe('unknown');
  });

  test('rejects a consumed nonce whose transaction paid a different recipient', async () => {
    const result = await inspectAuthorizationOutcome(payload, payload.accepted, 123n, {
      currentBlock: async () => 456n,
      chainId: async () => 8453,
      authorizationUsed: async () => true,
      authorizationTransaction: async () => evidence('0x4444444444444444444444444444444444444444'),
    });
    expect(result.status).toBe('unknown');
  });

  test('rejects a consumed nonce whose transaction paid a different amount', async () => {
    const result = await inspectAuthorizationOutcome(payload, payload.accepted, 123n, {
      currentBlock: async () => 456n,
      chainId: async () => 8453,
      authorizationUsed: async () => true,
      authorizationTransaction: async () => evidence(payTo, 9999n),
    });
    expect(result.status).toBe('unknown');
  });

  test('searches from the durable preparation block after a long outage', () => {
    expect(authorizationSearchRanges(10_000n, 1_000_000n)).toEqual([
      { fromBlock: 10_000n, toBlock: 10_999n },
      { fromBlock: 11_000n, toBlock: 11_999n },
    ]);
  });
});

describe('x402 cross-replica claim lifecycle', () => {
  test('acquires in stable order and releases after network-shaped async work', async () => {
    const held = new Set<string>();
    const released: string[] = [];
    const adapter = {
      acquire: async (key: string) => !held.has(key) && !!held.add(key),
      renew: async (key: string) => held.has(key),
      release: async (key: string) => { held.delete(key); released.push(key); },
    };
    const result = await withLeaseClaims(['session:b', 'idempotency:a'], adapter, async (guard) => {
      expect([...held]).toEqual(['idempotency:a', 'session:b']);
      await guard.assertOwned();
      await Promise.resolve();
      return 'done';
    }, 'owner');
    expect(result).toBe('done');
    expect(held.size).toBe(0);
    expect(released).toEqual(['session:b', 'idempotency:a']);
  });

  test('releases partial acquisition on contention and can quarantine ambiguity', async () => {
    const held = new Set<string>();
    const adapter = {
      acquire: async (key: string) => key !== 'session:b' && !held.has(key) && !!held.add(key),
      renew: async (key: string) => held.has(key),
      release: async (key: string) => { held.delete(key); },
    };
    await expect(withLeaseClaims(['idempotency:a', 'session:b'], adapter, async () => 'never', 'owner'))
      .rejects.toBeInstanceOf(X402ClaimBusyError);
    expect(held.size).toBe(0);

    const quarantineAdapter = {
      acquire: async (key: string) => !held.has(key) && !!held.add(key),
      renew: async (key: string) => held.has(key),
      release: async (key: string) => { held.delete(key); },
    };
    await withLeaseClaims(['payment:ambiguous'], quarantineAdapter, async (guard) => {
      guard.retain();
    }, 'owner');
    expect(held.has('payment:ambiguous')).toBe(true);
  });
});

describe('x402 crash recovery', () => {
  test('requires regional, metadata, and paid-access rollback before closing an extension intent', async () => {
    const calls: string[] = [];
    expect(await recoverInterruptedExtension({
      rollbackRegional: async () => { calls.push('regional'); return true; },
      rollbackMetadata: async () => { calls.push('metadata'); return true; },
      rollbackAccess: async () => { calls.push('access'); return true; },
    })).toBe(true);
    expect(calls.sort()).toEqual(['access', 'metadata', 'regional']);
    expect(await recoverInterruptedExtension({
      rollbackRegional: async () => false,
      rollbackMetadata: async () => true,
      rollbackAccess: async () => true,
    })).toBe(false);
  });

  test('cleanup only completes after remote and local containment', async () => {
    let localCalled = false;
    expect(await runCleanupAttempt({
      deleteRegional: async () => false,
      endLocal: async () => { localCalled = true; return true; },
    })).toBe(false);
    expect(localCalled).toBe(false);
    expect(await runCleanupAttempt({
      deleteRegional: async () => true,
      endLocal: async () => true,
    })).toBe(true);
  });
});

describe('x402 bounded request bodies', () => {
  test('rejects oversized bodies without Content-Length', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"blocks":1,"padding":"0123456789"}'));
        controller.close();
      },
    });
    const result = await readBoundedJsonBody(new Request('https://example.test', {
      method: 'POST', body: stream, duplex: 'half',
    } as RequestInit), 16);
    expect(result.error).toBe('too_large');
  });

  test('does not trust a misleading small Content-Length', async () => {
    const result = await readBoundedJsonBody(new Request('https://example.test', {
      method: 'POST',
      headers: { 'Content-Length': '1' },
      body: '{"blocks":1,"padding":"0123456789"}',
    }), 16);
    expect(result.error).toBe('too_large');
  });
});

describe('control-plane import smoke', () => {
  test('starts on Hono 4 with x402 disabled', async () => {
    const child = Bun.spawn([
      'bun',
      '-e',
      `const app=(await import('./index.ts')).default; const response=await app.fetch(new Request('http://localhost/v1/x402/sessions',{method:'POST'})); console.log(response.status);`,
    ], {
      cwd: import.meta.dir + '/..',
      env: {
        ...process.env,
        DATABASE_URL: 'postgresql://user:pass@127.0.0.1:5432/popcorn',
        CONTROL_PLANE_SERVICE_AUTH_TOKEN: 'test-service-token',
        CONTROL_PLANE_REGIONS: '[]',
        X402_ENABLED: 'false',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode, stderr).toBe(0);
    expect(stdout.trim().split('\n').at(-1)).toBe('404');
  });

  test('mounts the enabled public x402 route', async () => {
    const child = Bun.spawn([
      'bun',
      '-e',
      `const app=(await import('./index.ts')).default; console.log(typeof app.fetch);`,
    ], {
      cwd: import.meta.dir + '/..',
      env: {
        ...process.env,
        DATABASE_URL: 'postgresql://user:pass@127.0.0.1:5432/popcorn',
        CONTROL_PLANE_SERVICE_AUTH_TOKEN: 'test-service-token',
        CONTROL_PLANE_REGIONS: JSON.stringify([{
          name: 'x402-us-central1',
          clusterName: 'gcp-us-central1-x402-popcorn',
          poolManagerUrl: 'http://pool-manager.local',
          publicGatewayUrl: 'https://popcorn-gateway-gcp-us-central1-x402.reclaimprotocol.org',
          enabled: true,
          x402Only: true,
        }]),
        X402_ENABLED: 'true',
        X402_REGION_NAME: 'x402-us-central1',
        X402_PUBLIC_BASE_URL: 'https://app.popcorn.reclaimprotocol.org',
        X402_BASE_RPC_URL: 'https://base-rpc.example.com',
        X402_PAY_TO: '0x1111111111111111111111111111111111111111',
        X402_SERVER_SECRET: 'test-x402-server-secret-at-least-32-bytes',
        CDP_API_KEY_ID: 'test-key-id',
        CDP_API_KEY_SECRET: 'test-key-secret',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode, stderr).toBe(0);
    expect(stdout.trim().split('\n').at(-1)).toBe('function');
  });

  test('keeps the existing credentialed API outside the x402 payment flow', async () => {
    const child = Bun.spawn([
      'bun',
      '-e',
      `const app=(await import('./index.ts')).default; const response=await app.fetch(new Request('http://localhost/v1/sessions',{method:'POST'})); console.log(JSON.stringify({status:response.status,paymentRequired:response.headers.get('PAYMENT-REQUIRED')}));`,
    ], {
      cwd: import.meta.dir + '/..',
      env: {
        ...process.env,
        DATABASE_URL: 'postgresql://user:pass@127.0.0.1:5432/popcorn',
        CONTROL_PLANE_SERVICE_AUTH_TOKEN: 'test-service-token',
        CONTROL_PLANE_REGIONS: JSON.stringify([
          {
            name: 'asia-south1',
            clusterName: 'existing-client-cluster',
            poolManagerUrl: 'http://existing-pool-manager.local',
            publicGatewayUrl: 'https://existing-gateway.example',
            enabled: true,
          },
          {
            name: 'x402-us-central1',
            clusterName: 'gcp-us-central1-x402-popcorn',
            poolManagerUrl: 'http://pool-manager.local',
            publicGatewayUrl: 'https://popcorn-gateway-gcp-us-central1-x402.reclaimprotocol.org',
            enabled: true,
            x402Only: true,
          },
        ]),
        X402_ENABLED: 'true',
        X402_REGION_NAME: 'x402-us-central1',
        X402_PUBLIC_BASE_URL: 'https://app.popcorn.reclaimprotocol.org',
        X402_BASE_RPC_URL: 'https://base-rpc.example.com',
        X402_PAY_TO: '0x1111111111111111111111111111111111111111',
        X402_SERVER_SECRET: 'test-x402-server-secret-at-least-32-bytes',
        CDP_API_KEY_ID: 'test-key-id',
        CDP_API_KEY_SECRET: 'test-key-secret',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode, stderr).toBe(0);
    expect(JSON.parse(stdout.trim().split('\n').at(-1)!)).toEqual({
      status: 401,
      paymentRequired: null,
    });
  });

  test('allocates with valid client credentials while x402 is enabled', async () => {
    const child = Bun.spawn([
      'bun',
      '-e',
      `const {ClientService}=await import('./src/clients.ts');
       const {SessionService}=await import('./src/sessions.ts');
       ClientService.validateCredentials=async(id,secret)=>id==='client-test'&&secret==='secret-test';
       ClientService.getClient=async(id)=>({id,name:'Credentialed client',active:true,allowedClusters:null,createdAt:new Date()});
       SessionService.getSession=async()=>[];
       SessionService.createSession=async()=>{};
       let regionalRequest;
       let regionalUrl;
       globalThis.fetch=async(input,init)=>{
         regionalUrl=String(input);
         regionalRequest=JSON.parse(String(init?.body));
         return Response.json({success:true,sessionId:regionalRequest.sessionId,url:'https://existing-gateway.example/liveview/credentialed-session/restricted.jwt/liveview.html?resize=scale&reconnect=1&reconnect_delay=2000',cdpUrl:'wss://existing-gateway.example/cdp/credentialed-session/restricted.jwt/',apiUrl:'https://existing-gateway.example/api',vncUrl:'https://existing-gateway.example/liveview/credentialed-session/restricted.jwt/liveview.html?resize=scale&reconnect=1&reconnect_delay=2000',vncWsUrl:'wss://existing-gateway.example/liveview-ws/credentialed-session/restricted.jwt'});
       };
       const app=(await import('./index.ts')).default;
       const response=await app.fetch(new Request('http://localhost/v1/sessions',{method:'POST',headers:{Authorization:'Bearer client-test:secret-test','Content-Type':'application/json'},body:JSON.stringify({sessionId:'credentialed-session'})}));
       console.log(JSON.stringify({status:response.status,paymentRequired:response.headers.get('PAYMENT-REQUIRED'),body:await response.json(),regionalUrl,regionalRequest}));`,
    ], {
      cwd: import.meta.dir + '/..',
      env: {
        ...process.env,
        DATABASE_URL: 'postgresql://user:pass@127.0.0.1:5432/popcorn',
        CONTROL_PLANE_SERVICE_AUTH_TOKEN: 'test-service-token',
        CONTROL_PLANE_REGIONS: JSON.stringify([
          {
            name: 'asia-south1',
            clusterName: 'existing-client-cluster',
            poolManagerUrl: 'http://existing-pool-manager.local',
            publicGatewayUrl: 'https://existing-gateway.example',
            enabled: true,
          },
          {
            name: 'x402-us-central1',
            clusterName: 'x402-cluster',
            poolManagerUrl: 'http://x402-pool-manager.local',
            publicGatewayUrl: 'https://x402-gateway.example',
            enabled: true,
            x402Only: true,
          },
        ]),
        X402_ENABLED: 'true',
        X402_REGION_NAME: 'x402-us-central1',
        X402_PUBLIC_BASE_URL: 'https://x402-api.example',
        X402_BASE_RPC_URL: 'https://base-rpc.example',
        X402_PAY_TO: '0x1111111111111111111111111111111111111111',
        X402_SERVER_SECRET: 'test-x402-server-secret-at-least-32-bytes',
        CDP_API_KEY_ID: 'test-key-id',
        CDP_API_KEY_SECRET: 'test-key-secret',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode, stderr).toBe(0);
    const result = JSON.parse(stdout.trim().split('\n').at(-1)!);
    expect(result).toMatchObject({
      status: 200,
      paymentRequired: null,
      regionalUrl: 'http://existing-pool-manager.local/internal/sessions',
      body: {
        sessionId: 'credentialed-session',
        region: 'asia-south1',
        clusterName: 'existing-client-cluster',
        vncUrl: 'https://existing-gateway.example/liveview/credentialed-session/restricted.jwt/liveview.html?resize=scale&reconnect=1&reconnect_delay=2000',
        vncWsUrl: 'wss://existing-gateway.example/liveview-ws/credentialed-session/restricted.jwt',
      },
      regionalRequest: {
        sessionId: 'credentialed-session',
        clientId: 'client-test',
        clientName: 'Credentialed client',
        publicGatewayUrl: 'https://existing-gateway.example',
      },
    });
    expect(result.regionalRequest).not.toHaveProperty('tokenExpiresAt');
    expect(result.regionalRequest).not.toHaveProperty('accessPolicy');
  });

  test('fails startup when the paid region is not explicitly x402-only', async () => {
    const child = Bun.spawn(['bun', '-e', `await import('./index.ts')`], {
      cwd: import.meta.dir + '/..',
      env: {
        ...process.env,
        DATABASE_URL: 'postgresql://user:pass@127.0.0.1:5432/popcorn',
        CONTROL_PLANE_SERVICE_AUTH_TOKEN: 'test-service-token',
        CONTROL_PLANE_REGIONS: JSON.stringify([{
          name: 'x402-us-central1', clusterName: 'customer-cluster',
          poolManagerUrl: 'http://pool-manager.local', publicGatewayUrl: 'https://gateway.example',
          enabled: true, x402Only: false,
        }]),
        X402_ENABLED: 'true',
        X402_REGION_NAME: 'x402-us-central1',
        X402_PUBLIC_BASE_URL: 'https://app.popcorn.reclaimprotocol.org',
        X402_BASE_RPC_URL: 'https://base-rpc.example.com',
        X402_PAY_TO: '0x1111111111111111111111111111111111111111',
        X402_SERVER_SECRET: 'test-x402-server-secret-at-least-32-bytes',
        CDP_API_KEY_ID: 'test-key-id', CDP_API_KEY_SECRET: 'test-key-secret',
      },
      stdout: 'pipe', stderr: 'pipe',
    });
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('explicitly marked x402Only');
  });
});
