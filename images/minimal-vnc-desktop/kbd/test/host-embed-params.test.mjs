// host-embed-params.test.mjs — query parameters must survive EVERY embedding hop.
//
// The failure this locks down is silent by construction. A hop forwards the
// parameters it knows about; one it has never heard of is simply absent from the
// URL it builds, and the viewer then runs with its default. So `quality=9` that
// reaches only the middle frame looks *exactly* like `quality=9` that was applied
// — same page, same stream, no error anywhere — and the first quality=9 device
// test was a no-op for precisely this reason. Same class of bug dropped `magnify`
// on the nested hop, which made the three-level topology impossible to A/B.
//
// The fix is one list and one forwarding function in popcorn-host.js, shared by
// every hop, so "does this parameter survive" is a property with a test rather
// than a convention. These tests assert on the URL a hop would build.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeHostWindow } from './host-stub.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS = readFileSync(join(HERE, '..', '..', 'host', 'test-host.html'), 'utf8');
const MINIMAL = readFileSync(join(HERE, '..', '..', 'host', 'test-min.html'), 'utf8');

const { PopcornHost } = makeHostWindow();

// The full set a device test tunes, in the order the forwarder emits them.
const SEARCH = '?viewer=https%3A%2F%2Fpod.test&nest=1&magnify=1&quality=9&compression=9' +
  '&resize=scale&fill=1&fbcap=411x732&smooth=1&password=p&path=%2Fws&reconnect=0' +
  '&reconnect_delay=900&stateless=1&mirror=1&diag=1&e2e=1&encryption=e2e';

test('every viewer-facing parameter in the URL is forwarded', () => {
  const pass = PopcornHost.forwardParams(SEARCH);
  const got = new Map(pass.map((kv) => kv.split('=')));
  for (const [k, v] of [
    ['magnify', '1'], ['quality', '9'], ['compression', '9'], ['resize', 'scale'],
    ['fill', '1'], ['fbcap', '411x732'], ['smooth', '1'], ['password', 'p'],
    ['reconnect', '0'], ['reconnect_delay', '900'], ['stateless', '1'],
    ['mirror', '1'], ['diag', '1'], ['e2e', '1'], ['encryption', 'e2e'],
  ]) {
    assert.equal(got.get(k), v, k + ' survived');
  }
  assert.equal(got.get('path'), encodeURIComponent('/ws'), 'a value with a slash is re-encoded');
});

test('harness-only parameters are NOT forwarded to the viewer', () => {
  // viewer/nest/relay/forcerelay/noorigin/badlayout drive the harness itself. A
  // viewer that received them would ignore them, but a middle frame that received
  // `relay=1` from the wrong place would change its own mode.
  const pass = PopcornHost.forwardParams(SEARCH + '&relay=1&forcerelay=1&noorigin=1&badlayout=1');
  const keys = pass.map((kv) => kv.split('=')[0]);
  for (const k of ['viewer', 'nest', 'relay', 'forcerelay', 'noorigin', 'badlayout']) {
    assert.ok(!keys.includes(k), k + ' stays with the harness');
  }
});

test('an absent parameter is not invented (the viewer keeps its own default)', () => {
  const pass = PopcornHost.forwardParams('?magnify=1');
  assert.deepEqual(pass, ['magnify=1']);
});

test('a parameter present but EMPTY still survives (?quality= is a real setting)', () => {
  // '' is a value, not an absence — dropping it would silently re-enable a default
  // the operator was deliberately clearing.
  assert.ok(PopcornHost.forwardParams('?path=').includes('path='));
});

test('forwarding is idempotent — hop 2 emits what hop 1 gave it', () => {
  // The property that makes an N-level chain safe: the output of a hop, re-parsed
  // as the input of the next one, forwards to the same set. Without it every extra
  // level is another chance to lose a parameter.
  const hop1 = PopcornHost.forwardParams(SEARCH);
  const hop2 = PopcornHost.forwardParams('?' + hop1.join('&'));
  assert.deepEqual(hop2, hop1);
  const hop3 = PopcornHost.forwardParams('?' + hop2.join('&'));
  assert.deepEqual(hop3, hop1, 'stable at three levels: SDK -> portal -> viewer');
});

test('the quality/compression pair this session depends on cannot be dropped', () => {
  // Named explicitly because these two are the whole point: the reported blur must
  // never be caused by a lost encoder setting, so that possibility is excluded by a
  // test rather than by reading the list.
  for (const k of ['quality', 'compression']) {
    assert.ok(PopcornHost.VIEWER_PARAMS.includes(k), k + ' is in the shared list');
  }
});

test('the harness builds BOTH hops with the shared forwarder', () => {
  // A guard on the harness itself: it is the only three-level reproduction we have,
  // so if it goes back to a private list the nested chain silently stops carrying
  // what the top frame was given.
  assert.ok(/PopcornHost\.forwardParams\(location\.search\)/.test(HARNESS),
    'test-host.html forwards via the shared list');
  assert.ok(!/var PASSTHROUGH = \[/.test(HARNESS), 'and keeps no private copy of it');
  // The nested hop additionally has to carry the harness knobs that decide what the
  // MIDDLE frame builds — magnify was dropped here, so &nest=1&magnify=0 ran the
  // nested chain in magnify mode.
  const nested = HARNESS.match(/childUrl = location\.pathname[\s\S]{0,400}?;/);
  assert.ok(nested, 'found the nested hop');
  for (const k of ['viewerpage', 'magnify', 'noorigin', 'badlayout']) {
    assert.ok(HARNESS.includes("'" + k + "'"), k + ' is carried into the middle frame');
  }
  assert.ok(/nestExtra/.test(nested[0]), 'the nested hop appends the harness knobs');
  assert.ok(/pass\.join\('&'\)/.test(nested[0]), 'and the viewer parameters too');
});

test('the viewer parameters the pod actually reads are all in the list', () => {
  // Cross-check against the consumers, so a NEW parameter added to the viewer is
  // caught here instead of silently failing to reach an embedded session.
  const viewer = readFileSync(join(HERE, '..', '..', 'viewer.js'), 'utf8');
  const env = readFileSync(join(HERE, '..', 'env.js'), 'utf8');
  const src = viewer + env;
  const read = new Set();
  for (const m of src.matchAll(/params\.get\('([a-z_]+)'\)/g)) read.add(m[1]);
  for (const m of src.matchAll(/boolParam\('([a-z_]+)'/g)) read.add(m[1]);
  // Not embed-forwardable by nature: parentOrigin is per-hop (each hop is a
  // different origin) and is built, not copied.
  read.delete('parentorigin');
  read.delete('parentOrigin');
  const missing = [...read].filter((k) => !PopcornHost.VIEWER_PARAMS.includes(k));
  assert.deepEqual(missing, [], 'parameters the viewer reads but no hop forwards: ' + missing.join(','));
});

test('the bare-iframe control page forwards the same set', () => {
  // test-min.html is the reference "this is what sharp looks like" page, so it must
  // not be running a different configuration than the nested harness. It had its
  // own shorter list, which meant a device A/B between the two paths silently
  // compared different viewers (no password, no path, no fbcap, no diag).
  assert.ok(/PopcornHost\.forwardParams\(location\.search\)/.test(MINIMAL),
    'test-min.html forwards via the shared list');
  assert.ok(!/var PASSTHROUGH = \[/.test(MINIMAL), 'and keeps no private copy');
  assert.ok(/PopcornHost\.layer\(/.test(MINIMAL), 'and applies the layout contract in code');
});
