import assert from 'node:assert/strict';
import test from 'node:test';

import { e2eBootstrap, liveviewHostUrl, readEncryption } from '../src/liveview-url.mjs';

const PLAINTEXT = 'https://pod.example/liveview/s1/tok/liveview.html';
const ENROLLED = `${PLAINTEXT}?resize=scale&encryption=e2e#popcorn-e2e=eyJzZXNzaW9uSWQiOiJzMSJ9`;
const base = {
  gatewayOrigin: 'http://gateway.example:8080',
  hostPage: 'http://fixture.example/host/test-host.html',
  hostParams: { nest: 1, magnify: 1 },
};

test('a plaintext session builds the same URL it always did', () => {
  const url = new URL(liveviewHostUrl({ ...base, vncUrl: PLAINTEXT }));
  assert.equal(url.searchParams.get('viewer'), 'http://gateway.example:8080/liveview/s1/tok');
  assert.equal(url.searchParams.get('magnify'), '1');
  assert.equal(url.searchParams.get('encryption'), null);
  assert.equal(url.hash, '');
});

// The enrollment travels in the fragment, which is never sent to the gateway. Drop
// it and the viewer selects the encrypted transport with no key material.
test('an e2e session carries the transport flag AND its bootstrap fragment', () => {
  const url = new URL(liveviewHostUrl({ ...base, vncUrl: ENROLLED, encryption: 'e2e' }));
  assert.equal(url.searchParams.get('encryption'), 'e2e');
  assert.equal(url.hash, '#popcorn-e2e=eyJzZXNzaW9uSWQiOiJzMSJ9');
  // The viewer target is still the directory: the host page appends the page.
  assert.equal(url.searchParams.get('viewer'), 'http://gateway.example:8080/liveview/s1/tok');
  assert.equal(url.searchParams.get('magnify'), '1', 'shared LiveView flags survive');
});

// Both halves of the decision live in different places (the session is provisioned
// by one call, the URL assembled by another). Disagreeing silently is what would
// run the plaintext transport under an e2e-labelled result.
test('asking for e2e against a plaintext session is an error, not a fallback', () => {
  assert.throws(
    () => liveviewHostUrl({ ...base, vncUrl: PLAINTEXT, encryption: 'e2e' }),
    /no #popcorn-e2e bootstrap/,
  );
});

test('an enrolled session run without the flag is an error too', () => {
  assert.throws(() => liveviewHostUrl({ ...base, vncUrl: ENROLLED }), /liveview\.encryption is not set/);
});

test('only "e2e" is a transport', () => {
  assert.equal(readEncryption(undefined), null);
  assert.equal(readEncryption(''), null);
  assert.equal(readEncryption('e2e'), 'e2e');
  assert.throws(() => readEncryption('true'), /must be "e2e"/);
  assert.throws(() => readEncryption(1), /must be "e2e"/);
});

test('a fragment that is not the enrollment is not treated as one', () => {
  assert.equal(e2eBootstrap(`${PLAINTEXT}#scroll`), null);
  assert.equal(e2eBootstrap(ENROLLED), 'popcorn-e2e=eyJzZXNzaW9uSWQiOiJzMSJ9');
});
