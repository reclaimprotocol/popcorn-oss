import assert from 'node:assert/strict';
import test from 'node:test';

import { refuseBusyRuntime } from '../src/runtime-busy.mjs';

const environment = (gatewayOrigin) => ({
  value: { popcorn: { liveview: { gatewayOrigin } } },
});

const responds = (body, ok = true) => async () => ({ ok, json: async () => body });

test('a runtime another run is already driving is refused', async () => {
  await assert.rejects(
    () => refuseBusyRuntime(environment('http://127.0.0.1:18080'), { env: {}, fetchImpl: responds({ viewers: 1 }) }),
    /already has 1 viewer\(s\) attached/,
  );
});

test('an idle runtime is fine', async () => {
  const result = await refuseBusyRuntime(environment('http://127.0.0.1:18080'), { env: {}, fetchImpl: responds({ width: 1920, height: 1080, viewers: 0 }) });
  assert.equal(result.viewers, 0);
});

// The check must never be the reason a run fails: reachability is the preflight
// health checks' job, and an older runtime simply does not report the field.
test('a runtime too old to report viewers is not second-guessed', async () => {
  const result = await refuseBusyRuntime(environment('http://127.0.0.1:18080'), { env: {}, fetchImpl: responds({ width: 1920, height: 1080 }) });
  assert.equal(result.viewers, undefined);
});

test('an unreachable runtime is left to the health checks', async () => {
  const result = await refuseBusyRuntime(environment('http://127.0.0.1:18080'), {
    env: {},
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  });
  assert.equal(result, null);
});

test('a deliberate shared run can opt out', async () => {
  const result = await refuseBusyRuntime(environment('http://127.0.0.1:18080'), {
    env: { POPCORN_HARNESS_ALLOW_SHARED_RUNTIME: '1' },
    fetchImpl: responds({ viewers: 3 }),
  });
  assert.equal(result, null);
});

test('an environment with no liveview gateway is not checked', async () => {
  const result = await refuseBusyRuntime({ value: {} }, { env: {}, fetchImpl: responds({ viewers: 9 }) });
  assert.equal(result, null);
});
