import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateClientStaticKeyPair, NoiseIKInitiator, NoiseIKResponder, MAX_PLAINTEXT_FRAME, openNoiseWebSocket } from './noise.js';
import { createEmbeddedLiveViewE2EClient, createLiveViewE2EClient, installUnifiedLiveViewE2E, validateLiveViewE2E } from './bootstrap.js';

const ids = { sessionId: 'session-123', podUid: 'pod-uid-456', channel: 'rfb' };
const hex = (value) => Uint8Array.from(value.match(/../g).map((x) => Number.parseInt(x, 16)));
const hexOf = (value) => Array.from(value, (x) => x.toString(16).padStart(2, '0')).join('');

test('matches a deterministic flynn/noise IK + transport vector', async () => {
  // Generated with github.com/flynn/noise v1.1.0, DH25519, ChaChaPoly,
  // SHA256 and deterministic static/ephemeral random readers. This proves the
  // browser state machine against the Go implementation used by the pod.
  const clientPrivate = hex('0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20');
  const clientPublic = hex('07a37cbc142093c8b755dc1b10e86cb426374ad16aa853ed0bdfc0b2b86d1c7c');
  const podPublic = hex('5714769d116bf76436ae74bc793d2c30ad1903c59ac5273805c7e2698b410c36');
  const initiator = new NoiseIKInitiator({ sessionId: 's', podUid: 'p', channel: 'rfb', podPublicKey: podPublic, clientPrivateKey: clientPrivate, clientPublicKey: clientPublic, ephemeralPrivateKey: hex('c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedfe0e1e2e3e4e5e6e7e8') });
  const hello = await initiator.start();
  assert.equal(hexOf(hello), '4c29f4996985e80d247e80b70303824592ff9fbad74904ea7c3d2bda24e51c1249f294e5dd2b346df56595ed43f667ee5c6bd7760ad5bed9643d8d4c1ff2f1548f16b69a3658212da2a2c74a213d805773eb18ad74c1e6abce1b9b28080426d1');
  const keys = await initiator.finish(hex('b5ea2a7bb8a7e7ea8702cdd156d0a3197ff0666232521fcc1a514daa26a6a4602827bd16ff3d9f0fdb16228152d7d3c7'));
  assert.equal(hexOf(keys.send.encrypt(new TextEncoder().encode('abc'))), 'be216a479769d7d64c12c3db20f1c369e5836b');
  assert.deepEqual(Array.from(keys.receive.decrypt(hex('d21cc2d095253206975308bbc5e95a9df7f504'))), Array.from(new TextEncoder().encode('xyz')));
});

test('Noise IK interoperates, authenticates the bound client key, and separates directions', async () => {
  const client = await generateClientStaticKeyPair();
  const pod = await generateClientStaticKeyPair();
  const init = new NoiseIKInitiator({ ...ids, podPublicKey: pod.publicKey, clientPrivateKey: client.privateKey, clientPublicKey: client.publicKey });
  const responder = new NoiseIKResponder({ ...ids, podPrivateKey: pod.privateKey, podPublicKey: pod.publicKey, expectedClientPublicKey: client.publicKey });
  const first = await init.start();
  assert.equal(first.length, 96);
  const server = await responder.respond(first);
  assert.equal(server.response.length, 48);
  const browser = await init.finish(server.response);
  assert.deepEqual(Array.from(server.receive.decrypt(browser.send.encrypt(new TextEncoder().encode('rfb bytes')))), Array.from(new TextEncoder().encode('rfb bytes')));
  assert.deepEqual(Array.from(browser.receive.decrypt(server.send.encrypt(new Uint8Array([1, 2, 3])))), [1, 2, 3]);
});

test('carries first-connect enrollment only inside the encrypted IK payload', async () => {
  const client = await generateClientStaticKeyPair();
  const pod = await generateClientStaticKeyPair();
  const bindingSecret = Buffer.alloc(32, 0x42).toString('base64url');
  const init = new NoiseIKInitiator({ ...ids, podPublicKey: pod.publicKey, clientPrivateKey: client.privateKey, clientPublicKey: client.publicKey, bindingSecret });
  const hello = await init.start();
  assert.equal(hello.length, 128);
  assert.equal(Buffer.from(hello).includes(Buffer.alloc(32, 0x42)), false);
  const responder = new NoiseIKResponder({ ...ids, podPrivateKey: pod.privateKey, podPublicKey: pod.publicKey, expectedClientPublicKey: client.publicKey, expectedBindingSecret: bindingSecret });
  await init.finish((await responder.respond(hello)).response);
});

test('Noise rejects a wrong static binding, tampering, replay, and a mismatched prologue', async () => {
  const client = await generateClientStaticKeyPair();
  const other = await generateClientStaticKeyPair();
  const pod = await generateClientStaticKeyPair();
  const init = new NoiseIKInitiator({ ...ids, podPublicKey: pod.publicKey, clientPrivateKey: client.privateKey, clientPublicKey: client.publicKey });
  await assert.rejects(new NoiseIKResponder({ ...ids, podPrivateKey: pod.privateKey, podPublicKey: pod.publicKey, expectedClientPublicKey: other.publicKey }).respond(await init.start()), /unbound client/);

  const fresh = new NoiseIKInitiator({ ...ids, podPublicKey: pod.publicKey, clientPrivateKey: client.privateKey, clientPublicKey: client.publicKey });
  const server = await new NoiseIKResponder({ ...ids, podPrivateKey: pod.privateKey, podPublicKey: pod.publicKey, expectedClientPublicKey: client.publicKey }).respond(await fresh.start());
  const browser = await fresh.finish(server.response);
  const frame = browser.send.encrypt(new Uint8Array([7, 8, 9]));
  const corrupted = frame.slice();
  corrupted[0] ^= 1;
  assert.throws(() => server.receive.decrypt(corrupted), /authentication/);
  assert.deepEqual(Array.from(server.receive.decrypt(frame)), [7, 8, 9]);

  const valid = browser.send.encrypt(new Uint8Array([1]));
  assert.deepEqual(Array.from(server.receive.decrypt(valid)), [1]);
  assert.throws(() => server.receive.decrypt(valid), /authentication/);

  const prologueMismatch = new NoiseIKInitiator({ ...ids, podPublicKey: pod.publicKey, clientPrivateKey: client.privateKey, clientPublicKey: client.publicKey });
  await assert.rejects(new NoiseIKResponder({ ...ids, channel: 'control', podPrivateKey: pod.privateKey, podPublicKey: pod.publicKey, expectedClientPublicKey: client.publicKey }).respond(await prologueMismatch.start()), /authentication/);
});

test('an authentication error permanently closes the Noise WebSocket and discards queued records', async () => {
  const originalWebSocket = globalThis.WebSocket;
  const client = await generateClientStaticKeyPair(); const pod = await generateClientStaticKeyPair();
  const responder = new NoiseIKResponder({ ...ids, podPrivateKey: pod.privateKey, podPublicKey: pod.publicKey, expectedClientPublicKey: client.publicKey });
  let createdSocket;
  class FakeWebSocket {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    constructor() { createdSocket = this; this.readyState = FakeWebSocket.CONNECTING; queueMicrotask(() => { this.readyState = FakeWebSocket.OPEN; this.onopen?.({}); }); }
    async send(value) {
      if (this.serverKeys) return;
      this.serverKeys = await responder.respond(value);
      this.onmessage?.({ data: this.serverKeys.response });
      const corrupted = this.serverKeys.send.encrypt(new TextEncoder().encode('discard me'));
      corrupted[0] ^= 1;
      this.onmessage?.({ data: corrupted });
      this.onmessage?.({ data: this.serverKeys.send.encrypt(new TextEncoder().encode('also discard me')) });
    }
    close(code, reason) { this.closeCode = code; this.closeReason = reason; this.readyState = FakeWebSocket.CLOSED; this.onclose?.({ code, reason }); }
  }
  globalThis.WebSocket = FakeWebSocket;
  try {
    await assert.rejects(
      openNoiseWebSocket('wss://gateway.example/e2e', { ...ids, podPublicKey: pod.publicKey, clientPrivateKey: client.privateKey, clientPublicKey: client.publicKey }),
      /authentication/,
    );
    assert.equal(createdSocket.closeCode, 1008);
    assert.equal(createdSocket.readyState, FakeWebSocket.CLOSED);
  } finally {
    globalThis.WebSocket = originalWebSocket;
  }
});

test('fresh handshakes produce different transport ciphertexts and enforce the Noise frame limit', async () => {
  const client = await generateClientStaticKeyPair(); const pod = await generateClientStaticKeyPair();
  const handshake = async () => {
    const i = new NoiseIKInitiator({ ...ids, podPublicKey: pod.publicKey, clientPrivateKey: client.privateKey, clientPublicKey: client.publicKey });
    const r = new NoiseIKResponder({ ...ids, podPrivateKey: pod.privateKey, podPublicKey: pod.publicKey, expectedClientPublicKey: client.publicKey });
    return i.finish((await r.respond(await i.start())).response);
  };
  const [a, b] = await Promise.all([handshake(), handshake()]);
  const payload = new Uint8Array(MAX_PLAINTEXT_FRAME);
  assert.notDeepEqual(Array.from(a.send.encrypt(payload)), Array.from(b.send.encrypt(payload)));
  assert.throws(() => a.send.encrypt(new Uint8Array(MAX_PLAINTEXT_FRAME + 1)), /65535/);
});

test('buffers an immediate post-handshake frame without losing Noise nonce order', async () => {
  const originalWebSocket = globalThis.WebSocket;
  const client = await generateClientStaticKeyPair(); const pod = await generateClientStaticKeyPair();
  const responder = new NoiseIKResponder({ ...ids, podPrivateKey: pod.privateKey, podPublicKey: pod.publicKey, expectedClientPublicKey: client.publicKey });
  const banner = new TextEncoder().encode('RFB 003.008\n');
  class FakeWebSocket {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    constructor() { this.readyState = FakeWebSocket.CONNECTING; queueMicrotask(() => { this.readyState = FakeWebSocket.OPEN; this.onopen?.({}); }); }
    async send(value) {
      if (!this.serverKeys) {
        this.serverKeys = await responder.respond(value);
        // Deliberately deliver both frames through the temporary handshake
        // callback before the client has finished deriving transport keys.
        this.onmessage?.({ data: this.serverKeys.response });
        this.onmessage?.({ data: this.serverKeys.send.encrypt(banner) });
      } else {
        this.clientPlaintext = this.serverKeys.receive.decrypt(value);
      }
    }
    close(code, reason) { this.readyState = FakeWebSocket.CLOSED; this.onclose?.({ code, reason }); }
  }
  globalThis.WebSocket = FakeWebSocket;
  try {
    const channel = await openNoiseWebSocket('wss://gateway.example/e2e', { ...ids, podPublicKey: pod.publicKey, clientPrivateKey: client.privateKey, clientPublicKey: client.publicKey });
    const received = await new Promise((resolve) => { channel.onmessage = (event) => resolve(new Uint8Array(event.data)); });
    assert.deepEqual(Array.from(received), Array.from(banner));
    channel.send(new TextEncoder().encode('client bytes'));
    await new Promise((resolve) => queueMicrotask(resolve));
    assert.equal(new TextDecoder().decode(channel._ws.clientPlaintext), 'client bytes');
  } finally {
    globalThis.WebSocket = originalWebSocket;
  }
});

test('bootstrap accepts only explicit authenticated E2EE routes', async () => {
  const client = await generateClientStaticKeyPair(); const pod = await generateClientStaticKeyPair();
  const meta = { sessionId: 's', liveViewE2e: { version: 1, protocol: 'Noise_IK_25519_ChaChaPoly_SHA256', clientPublicKey: client.publicKey, podUid: 'p', podPublicKey: pod.publicKey, e2eRfbUrl: 'wss://gateway.example/liveview-e2e-rfb/s/token', e2eControlUrl: 'wss://gateway.example/liveview-e2e-control/s/token' } };
  assert.equal(createLiveViewE2EClient(meta, client).metadata.e2eRfbUrl, meta.liveViewE2e.e2eRfbUrl);
  assert.throws(() => validateLiveViewE2E({ ...meta, liveViewE2e: { ...meta.liveViewE2e, e2eRfbUrl: 'ws://gateway.example/insecure' } }, client), /wss/);
  assert.equal(
    validateLiveViewE2E({ ...meta, liveViewE2e: { ...meta.liveViewE2e, e2eRfbUrl: 'ws://localhost:8080/rfb', e2eControlUrl: 'ws://127.0.0.1:8080/control' } }, client, { allowInsecureLoopback: true }).e2eRfbUrl,
    'ws://localhost:8080/rfb',
  );
  assert.throws(() => validateLiveViewE2E({ ...meta, liveViewE2e: { ...meta.liveViewE2e, protocol: 'Npsk0' } }, client), /unsupported/);
});

test('the Noise connector rejects insecure non-loopback WebSockets', async () => {
  await assert.rejects(openNoiseWebSocket('ws://gateway.example/rfb'), /wss/);
});

test('bootstrap accepts flag-created enrollment metadata without a predeclared client key', async () => {
  const client = await generateClientStaticKeyPair(); const pod = await generateClientStaticKeyPair();
  const bindingSecret = Buffer.alloc(32, 0x42).toString('base64url');
  const meta = { sessionId: 's', liveViewE2e: { version: 1, protocol: 'Noise_IK_25519_ChaChaPoly_SHA256', bindingSecret, podUid: 'p', podPublicKey: pod.publicKey, e2eRfbUrl: 'wss://gateway.example/liveview-e2e-rfb/s/token', e2eControlUrl: 'wss://gateway.example/liveview-e2e-control/s/token' } };
  assert.equal(createLiveViewE2EClient(meta, client).metadata.bindingSecret, bindingSecret);
  assert.throws(() => validateLiveViewE2E({ ...meta, liveViewE2e: { ...meta.liveViewE2e, bindingSecret: undefined } }, client), /base64url|enrollment/);
});

test('installs E2EE into the unified LiveView without creating another viewer', async () => {
  const client = await generateClientStaticKeyPair(); const pod = await generateClientStaticKeyPair();
  const meta = { sessionId: 's', liveViewE2e: { version: 1, protocol: 'Noise_IK_25519_ChaChaPoly_SHA256', clientPublicKey: client.publicKey, podUid: 'p', podPublicKey: pod.publicKey, e2eRfbUrl: 'wss://gateway.example/liveview-e2e-rfb/s/token', e2eControlUrl: 'wss://gateway.example/liveview-e2e-control/s/token' } };
  const target = {};
  const installed = installUnifiedLiveViewE2E(meta, client, target);
  assert.equal(target.__POPCORN_LIVEVIEW_E2E_BOOTSTRAP__(), installed);
  assert.equal(installed.metadata.sessionId, meta.sessionId);
});

test('direct URL fragment scopes retained device keys to a fresh allocation session key', async () => {
  const pod = await generateClientStaticKeyPair();
  const bindingSecret = Buffer.alloc(32, 0x42).toString('base64url');
  const sessionKey = Buffer.alloc(32, 0x24).toString('base64url');
  const response = { sessionId: 'demo', sessionKey, liveViewE2e: {
    version: 1,
    protocol: 'Noise_IK_25519_ChaChaPoly_SHA256',
    bindingSecret,
    podUid: 'pod-demo',
    podPublicKey: pod.publicKey,
    e2eRfbUrl: 'ws://localhost:8080/liveview-e2e-rfb/demo/token',
    e2eControlUrl: 'ws://localhost:8080/liveview-e2e-control/demo/token',
  } };
  const encoded = Buffer.from(JSON.stringify(response)).toString('base64url');
  const values = new Map();
  const localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  let replaced = null;
  const firstWindow = {
    location: { hostname: 'localhost', pathname: '/liveview/demo/token/liveview.html', search: '?encryption=e2e', hash: `#popcorn-e2e=${encoded}` },
    localStorage,
    history: { state: null, replaceState: (_state, _title, url) => { replaced = url; } },
  };
  const first = await createEmbeddedLiveViewE2EClient(firstWindow);
  assert.equal(first.metadata.sessionId, 'demo');
  assert.equal(replaced, '/liveview/demo/token/liveview.html?encryption=e2e');
  assert.equal(values.get('popcorn.liveview.e2e.route.v1:/liveview/demo/token/liveview.html'), sessionKey);
  assert.equal(values.size, 2);

  const originalWebSocket = globalThis.WebSocket;
  const responder = new NoiseIKResponder({
    sessionId: 'demo', podUid: 'pod-demo', channel: 'rfb', podPrivateKey: pod.privateKey,
    podPublicKey: pod.publicKey, expectedClientPublicKey: first.metadata.clientPublicKey,
    expectedBindingSecret: bindingSecret,
  });
  class FakeWebSocket {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    constructor() { this.readyState = FakeWebSocket.CONNECTING; queueMicrotask(() => { this.readyState = FakeWebSocket.OPEN; this.onopen?.({}); }); }
    async send(value) {
      if (this.serverKeys) return;
      this.serverKeys = await responder.respond(value);
      this.onmessage?.({ data: this.serverKeys.response });
    }
    close(code, reason) { this.readyState = FakeWebSocket.CLOSED; this.onclose?.({ code, reason }); }
  }
  globalThis.WebSocket = FakeWebSocket;
  try {
    const channel = await first.connectRfb();
    channel.close(1000, 'test complete');
  } finally {
    globalThis.WebSocket = originalWebSocket;
  }
  assert.equal(first.metadata.bindingSecret, null);
  const retained = JSON.parse(values.get(`popcorn.liveview.e2e.v1:${sessionKey}`));
  assert.equal(retained.response.liveViewE2e.bindingSecret, undefined);
  assert.equal(retained.response.liveViewE2e.clientPublicKey, first.metadata.clientPublicKey);

  const refreshedWindow = {
    location: { hostname: 'localhost', pathname: '/liveview/demo/token/liveview.html', search: '?encryption=e2e', hash: '' },
    localStorage,
    history: { state: null, replaceState: () => assert.fail('refresh must not rewrite history') },
  };
  const refreshed = await createEmbeddedLiveViewE2EClient(refreshedWindow);
  assert.equal(refreshed.metadata.clientPublicKey, first.metadata.clientPublicKey);
  assert.equal(refreshed.metadata.bindingSecret, null);

  const nextSessionKey = Buffer.alloc(32, 0x25).toString('base64url');
  const nextResponse = { sessionId: 'demo', sessionKey: nextSessionKey, liveViewE2e: {
    ...response.liveViewE2e,
    podUid: 'pod-demo-next',
    e2eRfbUrl: 'ws://localhost:8080/liveview-e2e-rfb/demo/token-next',
    e2eControlUrl: 'ws://localhost:8080/liveview-e2e-control/demo/token-next',
  } };
  const nextEncoded = Buffer.from(JSON.stringify(nextResponse)).toString('base64url');
  const recreatedWindow = {
    location: { hostname: 'localhost', pathname: '/liveview/demo/token-next/liveview.html', search: '?encryption=e2e', hash: `#popcorn-e2e=${nextEncoded}` },
    localStorage,
    history: { state: null, replaceState: () => {} },
  };
  const recreated = await createEmbeddedLiveViewE2EClient(recreatedWindow);
  assert.notEqual(recreated.metadata.clientPublicKey, first.metadata.clientPublicKey);
  assert.equal(values.size, 4);
});

test('embedded bootstrap rejects fragments without an allocation session key', async () => {
  const pod = await generateClientStaticKeyPair();
  const response = { sessionId: 'old', liveViewE2e: {
    version: 1,
    protocol: 'Noise_IK_25519_ChaChaPoly_SHA256',
    bindingSecret: Buffer.alloc(32, 0x42).toString('base64url'),
    podUid: 'pod-old',
    podPublicKey: pod.publicKey,
    e2eRfbUrl: 'ws://localhost:8080/liveview-e2e-rfb/old/token',
    e2eControlUrl: 'ws://localhost:8080/liveview-e2e-control/old/token',
  } };
  const encoded = Buffer.from(JSON.stringify(response)).toString('base64url');
  await assert.rejects(createEmbeddedLiveViewE2EClient({
    location: { hostname: 'localhost', pathname: '/liveview/old/token/liveview.html', search: '?encryption=e2e', hash: `#popcorn-e2e=${encoded}` },
    localStorage: { getItem: () => null, setItem: () => assert.fail('invalid bootstrap must not be stored') },
    history: { state: null, replaceState: () => assert.fail('invalid bootstrap must not rewrite history') },
  }), /session key/);
});
