import { readFileSync } from 'node:fs';
import { createLiveViewE2EClient, createLiveViewSessionKey } from './bootstrap.js';
const params = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const podKey = process.argv[3];
const Real = globalThis.WebSocket;
globalThis.WebSocket = class extends Real {
  constructor(...a) { super(...a); console.log('WS ->', a[0]);
    this.addEventListener('close', (e) => console.log('WS close code=' + e.code + ' reason=' + JSON.stringify(e.reason))); }
  send(d) { console.log('WS send bytes=' + (d?.byteLength ?? d?.length)); return super.send(d); }
};
const key = await createLiveViewSessionKey();
const client = createLiveViewE2EClient({ sessionId: params.sessionId, liveViewE2e: {
  version: 1, protocol: 'Noise_IK_25519_ChaChaPoly_SHA256', podPublicKey: podKey, podUid: params.podUid,
  e2eRfbUrl: 'ws://127.0.0.1:26080/e2e/rfb', e2eControlUrl: 'ws://127.0.0.1:26080/e2e/control',
  bindingSecret: params.bindingSecret } }, key, { allowInsecureLoopback: true });
try { await client.connectControl(); console.log('HANDSHAKE OK'); } catch (e) { console.log('failed: ' + e.message); }
process.exit(0);
