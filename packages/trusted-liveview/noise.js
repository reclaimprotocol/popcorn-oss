// Noise_IK_25519_ChaChaPoly_SHA256 for the trusted LiveView client.
//
// This module deliberately has no URL parsing or token handling.  The caller
// supplies a WebSocket URL obtained from the authenticated control-plane API;
// a gateway bearer token is route authorization, never cryptographic input.

import { x25519 } from '@noble/curves/ed25519.js';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';

const te = new TextEncoder();
const MAX_NOISE_MESSAGE = 65535;
export const MAX_PLAINTEXT_FRAME = MAX_NOISE_MESSAGE - 16;

function bytes(v) {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  throw new TypeError('expected bytes');
}
function join(...parts) {
  const n = parts.reduce((sum, p) => sum + bytes(p).length, 0);
  const out = new Uint8Array(n); let at = 0;
  for (const p of parts) { const b = bytes(p); out.set(b, at); at += b.length; }
  return out;
}
function equal(a, b) {
  a = bytes(a); b = bytes(b); if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
function b64urlToBytes(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new TypeError('invalid base64url');
  const raw = atob(value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '='));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}
export function bytesToBase64url(value) {
  let s = ''; for (const c of bytes(value)) s += String.fromCharCode(c);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export { b64urlToBytes };

async function hkdf2(chainingKey, input) {
  const temp = hmac(sha256, chainingKey, input);
  const out1 = hmac(sha256, temp, new Uint8Array([1]));
  return [out1, hmac(sha256, temp, join(out1, new Uint8Array([2])))];
}
function nonceFor(counter) {
  if (!Number.isSafeInteger(counter) || counter < 0 || counter >= 0x100000000000000) throw new Error('Noise nonce exhausted');
  const out = new Uint8Array(12); let n = BigInt(counter);
  for (let i = 4; i < 12; i++) { out[i] = Number(n & 255n); n >>= 8n; }
  return out;
}
function chachaEncrypt(key, nonce, plaintext, aad) { return chacha20poly1305(bytes(key), nonce, bytes(aad)).encrypt(bytes(plaintext)); }
function chachaDecrypt(key, nonce, input, aad) {
  try { return chacha20poly1305(bytes(key), nonce, bytes(aad)).decrypt(bytes(input)); }
  catch (_) { throw new Error('Noise authentication failed'); }
}
async function x25519Pair() { return x25519.keygen(); }
async function importX25519Private(value) { return typeof value === 'string' ? b64urlToBytes(value) : bytes(value); }
async function dh(privateKey, publicKey) { return x25519.getSharedSecret(bytes(privateKey), bytes(publicKey)); }

class CipherState {
  constructor(key) { this.key = key || null; this.nonce = 0; }
  encrypt(plaintext, aad = new Uint8Array()) {
    plaintext = bytes(plaintext);
    if (plaintext.length > MAX_PLAINTEXT_FRAME) throw new Error('Noise message exceeds 65535 bytes');
    if (!this.key) return plaintext;
    const encrypted = chachaEncrypt(this.key, nonceFor(this.nonce), plaintext, aad);
    this.nonce++;
    return encrypted;
  }
  decrypt(ciphertext, aad = new Uint8Array()) {
    ciphertext = bytes(ciphertext);
    if (ciphertext.length > MAX_NOISE_MESSAGE) throw new Error('Noise message exceeds 65535 bytes');
    if (!this.key) return ciphertext;
    const plaintext = chachaDecrypt(this.key, nonceFor(this.nonce), ciphertext, aad);
    this.nonce++;
    return plaintext;
  }
}
class SymmetricState {
  constructor() {
    const name = te.encode('Noise_IK_25519_ChaChaPoly_SHA256');
    this.h = name.length <= 32 ? new Uint8Array(32) : sha256(name);
    if (name.length <= 32) this.h.set(name);
    this.ck = this.h; this.cs = new CipherState();
  }
  async mixHash(data) { this.h = await sha256(join(this.h, data)); }
  async mixKey(input) { const pair = await hkdf2(this.ck, input); this.ck = pair[0]; this.cs = new CipherState(pair[1]); }
  encryptAndHash(data) { const out = this.cs.encrypt(data, this.h); return this.mixHash(out).then(() => out); }
  async decryptAndHash(data) { const out = this.cs.decrypt(data, this.h); await this.mixHash(data); return out; }
  async split() { const pair = await hkdf2(this.ck, new Uint8Array()); return [new CipherState(pair[0]), new CipherState(pair[1])]; }
}

export async function generateClientStaticKeyPair() {
  const pair = await x25519Pair();
  return { publicKey: bytesToBase64url(pair.publicKey), privateKey: bytesToBase64url(pair.secretKey) };
}
export function noisePrologue({ sessionId, podUid, channel }) {
  if (!['rfb', 'control'].includes(channel)) throw new TypeError('invalid LiveView E2EE channel');
  if (typeof sessionId !== 'string' || !sessionId || typeof podUid !== 'string' || !podUid) throw new TypeError('sessionId and podUid are required');
  return te.encode(`popcorn-liveview/v1\0${sessionId}\0${podUid}\0${channel}`);
}
export class NoiseIKInitiator {
  constructor({ sessionId, podUid, channel, podPublicKey, clientPrivateKey, clientPublicKey, bindingSecret = null, ephemeralPrivateKey = null }) {
    this.prologue = noisePrologue({ sessionId, podUid, channel });
    this.podPublicKey = typeof podPublicKey === 'string' ? b64urlToBytes(podPublicKey) : bytes(podPublicKey);
    if (this.podPublicKey.length !== 32) throw new TypeError('podPublicKey must be an X25519 public key');
    this.clientPrivateKey = clientPrivateKey;
    this.ephemeralPrivateKey = ephemeralPrivateKey;
    this.clientPublicKey = typeof clientPublicKey === 'string' ? b64urlToBytes(clientPublicKey) : bytes(clientPublicKey);
    if (this.clientPublicKey.length !== 32) throw new TypeError('clientPublicKey must be an X25519 public key');
    this.bindingSecret = bindingSecret === null ? new Uint8Array() : b64urlToBytes(bindingSecret);
    if (this.bindingSecret.length !== 0 && this.bindingSecret.length !== 32) throw new TypeError('bindingSecret must be 32 bytes');
  }
  async start() {
    const s = new SymmetricState(); await s.mixHash(this.prologue); await s.mixHash(this.podPublicKey);
    const localStatic = await importX25519Private(this.clientPrivateKey);
    const forcedEphemeral = this.ephemeralPrivateKey === null ? null : await importX25519Private(this.ephemeralPrivateKey);
    const eph = forcedEphemeral ? { secretKey: forcedEphemeral, publicKey: x25519.getPublicKey(forcedEphemeral) } : await x25519Pair();
    await s.mixHash(eph.publicKey); await s.mixKey(await dh(eph.secretKey, this.podPublicKey));
    const encStatic = await s.encryptAndHash(this.clientPublicKey);
    await s.mixKey(await dh(localStatic, this.podPublicKey));
    this.state = s; this.localStatic = localStatic; this.eph = eph;
    // A new flag-created session carries its enrollment secret only inside the
    // encrypted IK payload. Pre-bound integrations retain the empty payload.
    return join(eph.publicKey, encStatic, await s.encryptAndHash(this.bindingSecret));
  }
  async finish(response) {
    response = bytes(response);
    if (!this.state || response.length !== 48) throw new Error('invalid Noise IK response');
    const remoteEphemeral = response.slice(0, 32), tag = response.slice(32);
    await this.state.mixHash(remoteEphemeral);
    await this.state.mixKey(await dh(this.eph.secretKey, remoteEphemeral));
    await this.state.mixKey(await dh(this.localStatic, remoteEphemeral));
    const payload = await this.state.decryptAndHash(tag);
    if (payload.length !== 0) throw new Error('unexpected Noise IK response payload');
    const [send, receive] = await this.state.split();
    this.state = null; this.eph = null; this.localStatic = null;
    return { send, receive };
  }
}

// Used by the Node/browser characterization tests and by independently-built
// trusted-client integrations to check their values against a protocol peer.
// Production pods implement the matching responder in Go; keeping this tiny
// reference here prevents a JavaScript-only interpretation of IK from drifting.
export class NoiseIKResponder {
  constructor({ sessionId, podUid, channel, podPrivateKey, podPublicKey, expectedClientPublicKey, expectedBindingSecret = null }) {
    this.prologue = noisePrologue({ sessionId, podUid, channel });
    this.podPrivateKey = podPrivateKey;
    this.podPublicKey = typeof podPublicKey === 'string' ? b64urlToBytes(podPublicKey) : bytes(podPublicKey);
    this.expectedClientPublicKey = typeof expectedClientPublicKey === 'string' ? b64urlToBytes(expectedClientPublicKey) : bytes(expectedClientPublicKey);
    this.expectedBindingSecret = expectedBindingSecret === null ? new Uint8Array() : b64urlToBytes(expectedBindingSecret);
    if (this.podPublicKey.length !== 32 || this.expectedClientPublicKey.length !== 32) throw new TypeError('invalid X25519 public key');
  }
  async respond(message) {
    // IK's first Noise WriteMessage is 96 bytes when pre-bound and 128 bytes
    // when its encrypted payload carries the 32-byte enrollment secret.
    message = bytes(message); if (message.length !== 96 && message.length !== 128) throw new Error('invalid Noise IK initiator message');
    const s = new SymmetricState(); await s.mixHash(this.prologue); await s.mixHash(this.podPublicKey);
    const podPrivate = await importX25519Private(this.podPrivateKey);
    const remoteEphemeral = message.slice(0, 32); await s.mixHash(remoteEphemeral);
    await s.mixKey(await dh(podPrivate, remoteEphemeral));
    const clientStatic = await s.decryptAndHash(message.slice(32, 80));
    if (!equal(clientStatic, this.expectedClientPublicKey)) throw new Error('unbound client static key');
    await s.mixKey(await dh(podPrivate, clientStatic));
    const payload = await s.decryptAndHash(message.slice(80));
    if (!equal(payload, this.expectedBindingSecret)) throw new Error('unexpected Noise IK initiator payload');
    const eph = await x25519Pair(); await s.mixHash(eph.publicKey);
    await s.mixKey(await dh(eph.secretKey, remoteEphemeral));
    await s.mixKey(await dh(eph.secretKey, clientStatic));
    const tag = await s.encryptAndHash(new Uint8Array());
    const [receive, send] = await s.split();
    return { response: join(eph.publicKey, tag), receive, send };
  }
}

class NoiseChannel {
  constructor(ws, send, receive, pendingCiphertexts = []) {
    this._ws = ws; this._send = send; this._receive = receive; this.binaryType = 'arraybuffer';
    // The underlying WebSocket and Noise handshake have already completed, so
    // the channel is immediately writable. Consumers such as noVNC inspect
    // readyState after attach; synthesizing another onopen would make them
    // perform the open transition twice.
    this.protocol = ''; this.readyState = WebSocket.OPEN; this.onopen = null;
    this._onmessage = this._onclose = this._onerror = null;
    this._pendingPlaintexts = []; this._drainScheduled = false; this._receiveChain = Promise.resolve(); this._failed = false;
    this._fail = (error) => {
      if (this._failed) return;
      this._failed = true;
      this._pendingPlaintexts.length = 0;
      this._onerror?.({ error });
      this.close(1008, 'Noise authentication failed');
    };
    this._handleCiphertext = (value) => {
      if (this._failed) return;
      // Blob conversion can be asynchronous. Serialize it with decryption so
      // Noise nonces always follow WebSocket message order.
      this._receiveChain = this._receiveChain.then(async () => {
        if (this._failed) return;
        const plaintext = receive.decrypt(await eventBytes({ data: value }));
        if (this._failed) return;
        this._pendingPlaintexts.push(plaintext.buffer.slice(plaintext.byteOffset, plaintext.byteOffset + plaintext.byteLength));
        this._scheduleDrain();
      });
      // Observe the rejection without replacing _receiveChain. A rejected
      // chain prevents every later record from reaching decryption.
      this._receiveChain.catch((error) => this._fail(error));
    };
    ws.onmessage = (event) => this._handleCiphertext(event.data);
    ws.onerror = (event) => this._onerror?.(event);
    ws.onclose = (event) => { this.readyState = WebSocket.CLOSED; this._onclose?.(event); };
    for (const ciphertext of pendingCiphertexts) this._handleCiphertext(ciphertext);
  }
  get onmessage() { return this._onmessage; }
  set onmessage(fn) { this._onmessage = fn; this._scheduleDrain(); }
  get onclose() { return this._onclose; }
  set onclose(fn) { this._onclose = fn; }
  get onerror() { return this._onerror; }
  set onerror(fn) { this._onerror = fn; }
  _scheduleDrain() {
    if (this._failed || this._drainScheduled || typeof this._onmessage !== 'function' || this._pendingPlaintexts.length === 0) return;
    this._drainScheduled = true;
    queueMicrotask(() => {
      this._drainScheduled = false;
      if (this._failed) {
        this._pendingPlaintexts.length = 0;
        return;
      }
      while (!this._failed && typeof this._onmessage === 'function' && this._pendingPlaintexts.length > 0) {
        this._onmessage({ data: this._pendingPlaintexts.shift() });
      }
    });
  }
  send(value) {
    if (this.readyState !== WebSocket.OPEN) throw new Error('Noise channel is not open');
    const input = typeof value === 'string' ? te.encode(value) : bytes(value);
    for (let at = 0; at < input.length || (input.length === 0 && at === 0); at += MAX_PLAINTEXT_FRAME) {
      const part = input.slice(at, at + MAX_PLAINTEXT_FRAME); this._ws.send(this._send.encrypt(part));
      if (input.length === 0) break;
    }
  }
  close(code, reason) { if (this.readyState < WebSocket.CLOSING) { this.readyState = WebSocket.CLOSING; this._ws.close(code, reason); } }
}
async function eventBytes(event) {
  if (event.data instanceof Blob) return new Uint8Array(await event.data.arrayBuffer());
  return bytes(event.data);
}
export async function openNoiseWebSocket(url, options) {
  let parsed;
  try { parsed = new URL(url); } catch (_) { throw new TypeError('E2EE WebSocket URL must be absolute'); }
  const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
  if (parsed.protocol !== 'wss:' && !(loopback && parsed.protocol === 'ws:')) {
    throw new TypeError('E2EE WebSocket URL must use wss outside localhost development');
  }
  const initiator = new NoiseIKInitiator(options);
  // Prepare the first IK message while DNS/TCP/TLS/WebSocket setup is in
  // flight. This removes client crypto from the connection's critical path.
  const helloPromise = initiator.start();
  const ws = new WebSocket(url); ws.binaryType = 'arraybuffer';
  const opened = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      try { ws.close(1000, 'Noise WebSocket connection timed out'); } catch (_) {}
      reject(new Error('Noise WebSocket connection timed out'));
    }, 8000);
    ws.onopen = () => { clearTimeout(timeout); resolve(); };
    ws.onerror = () => { clearTimeout(timeout); reject(new Error('Noise WebSocket connection failed')); };
  });
  const [, hello] = await Promise.all([opened, helloPromise]);
  ws.send(hello);
  const pendingCiphertexts = [];
  let frameChain = Promise.resolve(); let frameError = null; let responseSeen = false;
  const response = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Noise handshake timed out')), 8000);
    ws.onmessage = (event) => {
      frameChain = frameChain.then(() => eventBytes(event)).then((frame) => {
        if (!responseSeen) { responseSeen = true; clearTimeout(timeout); resolve(frame); }
        else pendingCiphertexts.push(frame);
      }).catch((error) => { frameError = error; clearTimeout(timeout); reject(error); });
    };
    ws.onerror = () => { clearTimeout(timeout); reject(new Error('Noise handshake failed')); };
    ws.onclose = () => { clearTimeout(timeout); reject(new Error('Noise handshake closed')); };
  });
  const keys = await initiator.finish(response);
  // The pod may send an RFB banner or initial control snapshot immediately
  // after its handshake response. Drain conversions queued by the temporary
  // handler before swapping it out, then replay those ciphertexts in order.
  await frameChain;
  if (frameError) throw frameError;
  if (ws.readyState !== WebSocket.OPEN) throw new Error('Noise WebSocket closed after handshake');
  const channel = new NoiseChannel(ws, keys.send, keys.receive, pendingCiphertexts);
  // Authenticate every record received during the handshake before exposing
  // the channel. Plaintexts remain queued until the consumer installs its
  // onmessage handler.
  await channel._receiveChain;
  return channel;
}
