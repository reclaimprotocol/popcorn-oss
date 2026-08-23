// Trusted-control-plane bootstrap for an E2EE LiveView.
//
// This is intentionally a reusable client asset, not a script injected by the
// gateway.  The control plane (or a native/host application) bundles it from a
// trusted origin, creates the static key before creating a session, and passes
// the resulting authenticated session metadata to a trusted viewer shell.

import { generateClientStaticKeyPair, b64urlToBytes, noisePrologue, openNoiseWebSocket } from './noise.js';

const PROTOCOL = 'Noise_IK_25519_ChaChaPoly_SHA256';
const FRAGMENT_KEY = 'popcorn-e2e';
const STORAGE_PREFIX = 'popcorn.liveview.e2e.v1:';
const ROUTE_INDEX_PREFIX = 'popcorn.liveview.e2e.route.v1:';

export async function createLiveViewSessionKey() {
  return generateClientStaticKeyPair();
}

function validSocketURL(value, field, allowInsecureLoopback = false) {
  let url;
  try { url = new URL(value); } catch (_) { throw new TypeError(`${field} must be an absolute wss URL`); }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'wss:' && !(allowInsecureLoopback && loopback && url.protocol === 'ws:')) {
    throw new TypeError(`${field} must use wss outside a localhost development viewer`);
  }
  return url.href;
}

function isLoopbackViewer(target) {
  const hostname = target?.location?.hostname;
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

// Validate only control-plane supplied E2EE metadata.  In particular this does
// NOT accept the default-mode `vncUrl`: it is not an E2EE transport endpoint.
export function validateLiveViewE2E(metadata, retainedKey, { allowInsecureLoopback = false } = {}) {
  // Session responses deliberately keep `sessionId` at top level while the
  // E2EE fields live under `liveViewE2e`. Accept that authenticated response
  // shape directly; default-mode responses with no `liveViewE2e` are handled by the
  // caller as a default-mode session.
  metadata = metadata && metadata.liveViewE2e ? { ...metadata.liveViewE2e, sessionId: metadata.sessionId } : metadata;
  if (!metadata || metadata.version !== 1 || metadata.protocol !== PROTOCOL) throw new TypeError('unsupported LiveView E2EE metadata');
  if (!retainedKey || typeof retainedKey.privateKey !== 'string' || typeof retainedKey.publicKey !== 'string') throw new TypeError('retained client key is required');
  const podPublicKey = b64urlToBytes(metadata.podPublicKey);
  const clientPublicKey = b64urlToBytes(retainedKey.publicKey);
  if (podPublicKey.length !== 32 || clientPublicKey.length !== 32) throw new TypeError('invalid X25519 key');
  if (typeof metadata.sessionId !== 'string' || !metadata.sessionId || typeof metadata.podUid !== 'string' || !metadata.podUid) throw new TypeError('incomplete LiveView E2EE metadata');
  if (metadata.clientPublicKey !== undefined && metadata.clientPublicKey !== retainedKey.publicKey) throw new TypeError('E2EE response is not bound to the retained client key');
  if (metadata.clientPublicKey === undefined && b64urlToBytes(metadata.bindingSecret).length !== 32) throw new TypeError('E2EE enrollment secret is required');
  // Exercise both prologues during validation: a malformed ID must never get to
  // a handshake where two channels could accidentally share a transcript.
  noisePrologue({ sessionId: metadata.sessionId, podUid: metadata.podUid, channel: 'rfb' });
  noisePrologue({ sessionId: metadata.sessionId, podUid: metadata.podUid, channel: 'control' });
  return Object.freeze({
    version: 1, protocol: PROTOCOL, sessionId: metadata.sessionId, podUid: metadata.podUid,
    podPublicKey: metadata.podPublicKey, e2eRfbUrl: validSocketURL(metadata.e2eRfbUrl, 'e2eRfbUrl', allowInsecureLoopback),
    e2eControlUrl: validSocketURL(metadata.e2eControlUrl, 'e2eControlUrl', allowInsecureLoopback),
    bindingSecret: metadata.bindingSecret ?? null,
    clientPublicKey: retainedKey.publicKey, clientPrivateKey: retainedKey.privateKey,
  });
}

export function createLiveViewE2EClient(metadata, retainedKey, options) {
  const config = validateLiveViewE2E(metadata, retainedKey, options);
  const connect = (channel) => openNoiseWebSocket(channel === 'rfb' ? config.e2eRfbUrl : config.e2eControlUrl, {
    sessionId: config.sessionId, podUid: config.podUid, channel, podPublicKey: config.podPublicKey,
    clientPublicKey: config.clientPublicKey, clientPrivateKey: config.clientPrivateKey, bindingSecret: config.bindingSecret,
  });
  return Object.freeze({ metadata: config, connectRfb: () => connect('rfb'), connectControl: () => connect('control') });
}

// Install the encrypted transport into the one shared LiveView controller.
// Load this bootstrap before viewer.bundle.js and open liveview.html with
// `?encryption=e2e`. Without that explicit flag the viewer uses its default
// transport and never reads this hook.
export function installUnifiedLiveViewE2E(sessionResponse, retainedKey, target = globalThis.window) {
  if (!target || typeof target !== 'object') throw new TypeError('LiveView window is required');
  const client = createLiveViewE2EClient(sessionResponse, retainedKey, { allowInsecureLoopback: isLoopbackViewer(target) });
  Object.defineProperty(target, '__POPCORN_LIVEVIEW_E2E_BOOTSTRAP__', {
    configurable: true,
    value: () => client,
  });
  return client;
}

function sessionIdFromPath(pathname) {
  const match = String(pathname || '').match(/\/liveview\/([^/]+)\/[^/]+\/liveview\.html$/);
  if (!match) throw new TypeError('cannot determine LiveView session ID');
  return decodeURIComponent(match[1]);
}

function readFragmentResponse(target) {
  const hash = String(target.location?.hash || '').replace(/^#/, '');
  if (!hash) return null;
  const encoded = new URLSearchParams(hash).get(FRAGMENT_KEY);
  if (!encoded) return null;
  if (encoded.length > 16_384) throw new TypeError('LiveView E2EE bootstrap fragment is too large');
  try {
    return JSON.parse(new TextDecoder().decode(b64urlToBytes(encoded)));
  } catch (_) {
    throw new TypeError('invalid LiveView E2EE bootstrap fragment');
  }
}

function routeStorageKey(pathname) {
  const route = String(pathname || '');
  if (!route) throw new TypeError('cannot determine LiveView route');
  return route;
}

function readStoredSession(storage, routeKey) {
  let value;
  let sessionKey;
  try {
    sessionKey = storage.getItem(ROUTE_INDEX_PREFIX + routeKey);
    if (!sessionKey) return null;
    if (b64urlToBytes(sessionKey).length !== 32) throw new Error();
    value = storage.getItem(STORAGE_PREFIX + sessionKey);
  }
  catch (_) { throw new Error('LiveView E2EE device storage is unavailable'); }
  if (!value) return null;
  try {
    const record = JSON.parse(value);
    if (!record || record.version !== 1 || record.sessionKey !== sessionKey || !record.response || !record.key) throw new Error();
    return record;
  } catch (_) {
    throw new Error('stored LiveView E2EE device binding is invalid');
  }
}

// Direct create-response URLs carry their one-time bootstrap only in the URL
// fragment, which browsers do not send to the gateway. The viewer validates it,
// generates a per-session device key, persists the binding for refresh, and
// removes the fragment from browser history after durable storage succeeds.
export async function createEmbeddedLiveViewE2EClient(target = globalThis.window) {
  if (!target || typeof target !== 'object' || !target.location) throw new TypeError('LiveView window is required');
  const sessionId = sessionIdFromPath(target.location.pathname);
  const routeKey = routeStorageKey(target.location.pathname);
  const storage = target.localStorage;
  if (!storage) throw new Error('LiveView E2EE device storage is unavailable');
  const stored = readStoredSession(storage, routeKey);
  const fragmentResponse = readFragmentResponse(target);

  let response = stored?.response;
  let key = stored?.key;
  let sessionKey = stored?.sessionKey;
  if (fragmentResponse) {
    if (fragmentResponse.sessionId !== sessionId) throw new Error('LiveView E2EE fragment is for another session');
    sessionKey = fragmentResponse.sessionKey;
    if (typeof sessionKey !== 'string' || b64urlToBytes(sessionKey).length !== 32) throw new Error('LiveView E2EE session key is invalid');
    response = fragmentResponse;
    // Reopening the same create URL must retain its already-enrolled device
    // key. A new allocation always carries a new session key and therefore
    // receives a fresh X25519 identity even when its sessionId is reused.
    key = stored?.sessionKey === sessionKey ? stored.key : await createLiveViewSessionKey();
  }
  if (!response || !key || !sessionKey) throw new Error('LiveView E2EE bootstrap is missing for this device');

  const client = createLiveViewE2EClient(response, key, { allowInsecureLoopback: isLoopbackViewer(target) });
  if (fragmentResponse) {
    try {
      storage.setItem(STORAGE_PREFIX + sessionKey, JSON.stringify({ version: 1, sessionKey, response, key }));
      storage.setItem(ROUTE_INDEX_PREFIX + routeKey, sessionKey);
    } catch (_) {
      throw new Error('LiveView E2EE device binding could not be retained');
    }
    target.history?.replaceState?.(target.history.state, '', `${target.location.pathname}${target.location.search}`);
  }
  return client;
}
