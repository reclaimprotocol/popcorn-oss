import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Redis } from 'ioredis';
import { createSessionDatabase } from './session-db';

// New private Unix-socket Redis only. No environment endpoints or credentials.
const executable = process.env.POPCORN_TEST_REDIS_SERVER || Bun.which('redis-server');
let directory: string;
let socket: string;
let server: ReturnType<typeof Bun.spawn>;
let primary: Redis;
let secondary: Redis;
describe.skipIf(!executable)('owned local Redis integration', () => {
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'popcorn-termination-'));
  socket = join(directory, 'redis.sock');
  server = Bun.spawn([executable!, '--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no', '--dir', directory], { stdout: 'ignore', stderr: 'pipe' });
  const deadline = Date.now() + 3000;
  while (!existsSync(socket) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  if (!existsSync(socket)) throw new Error('Owned local Redis did not start');
  primary = new Redis({ path: socket, db: 0, lazyConnect: true, retryStrategy: () => null });
  secondary = new Redis({ path: socket, db: 1, lazyConnect: true, retryStrategy: () => null });
  await Promise.all([primary.connect(), secondary.connect()]);
});
afterAll(async () => {
  primary?.disconnect(); secondary?.disconnect(); server?.kill('SIGTERM');
  if (server) await server.exited;
  if (directory) rmSync(directory, { recursive: true, force: true });
});
const original = { name: 'browser-1', namespace: 'default', podUid: 'pod-1', clientId: 'owner', boundAt: '2026-09-24T00:00:00.000Z', url: 'http://10.0.0.1:9222', ports: [{ name: 'novnc', port: 6080 }], expiresAt: new Date(Date.now() + 60_000).toISOString() };

test('real Lua atomically removes only the exact session and all routing keys', async () => {
  const database = createSessionDatabase(primary, secondary);
  await database.createSession('one', original);
  const expected = await database.getSession('one');
  expect(await database.deleteSessionIfCurrent('one', expected!)).toBe(true);
  expect(await primary.hget('sessions', 'one')).toBeNull();
  expect(await primary.keys('*one*')).toEqual([]);
  expect(await secondary.hget('sessions', 'one')).toBeNull();
  expect(await secondary.keys('*one*')).toEqual([]);
});
test('a replacement before the compare-and-delete retains every current route', async () => {
  const database = createSessionDatabase(primary);
  await database.createSession('race', original);
  const expected = await database.getSession('race');
  const replacement = { ...original, podUid: 'pod-2', boundAt: '2026-09-24T01:00:00.000Z', url: 'http://10.0.0.2:9222' };
  await database.updateSession('race', replacement);
  expect(await database.deleteSessionIfCurrent('race', expected!)).toBe(false);
  expect((await database.getSession('race'))?.podUid).toBe('pod-2');
  expect(await primary.get('route:race')).toBe('10.0.0.2:9222');
  expect(await primary.get('route:liveview:race')).toBe('10.0.0.2:6080');
});
test('secondary replacement is never erased and prevents a complete cleanup acknowledgement', async () => {
  const database = createSessionDatabase(primary, secondary);
  await database.createSession('secondary-race', original);
  const replacement = { ...original, podUid: 'replacement' };
  await secondary.hset('sessions', 'secondary-race', JSON.stringify(replacement));
  await secondary.set('route:secondary-race', 'replacement-route');
  await expect(database.deleteSessionIfCurrent('secondary-race', original)).rejects.toThrow('Secondary allocation cleanup is unconfirmed');
  expect(JSON.parse((await secondary.hget('sessions', 'secondary-race'))!).podUid).toBe('replacement');
  expect(await secondary.get('route:secondary-race')).toBe('replacement-route');
});
});
