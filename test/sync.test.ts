import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { decryptRecord, deriveKeys, encryptRecord, generateCredentials, isNewer, pairingLink, parsePairingLink, type SyncRecord } from '../sync/core/protocol.ts';
import { createSyncServer } from '../sync/server/server.ts';

const rec = (id: string, data: unknown, updatedAt = 1): SyncRecord => ({ v: 1, id, collection: 'tab', updatedAt, deviceId: 'dev_a', deleted: false, data });

test('pairing link round-trips', () => {
  const c = generateCredentials('https://sync.example.com/');
  assert.equal(c.server, 'https://sync.example.com');
  assert.deepEqual(parsePairingLink(pairingLink(c)), c);
  assert.throws(() => parsePairingLink('https://example.com'));
});

test('encrypt/decrypt binds the record id and rejects tampering', () => {
  const { encKey } = deriveKeys(generateCredentials('http://localhost:1'));
  const r = rec('tab:abc', { url: 'https://example.com' });
  const blob = encryptRecord(r, encKey);
  assert.deepEqual(decryptRecord({ id: r.id, blob }, encKey), r);
  assert.throws(() => decryptRecord({ id: 'tab:other', blob }, encKey));
  const other = deriveKeys(generateCredentials('http://localhost:1')).encKey;
  assert.throws(() => decryptRecord({ id: r.id, blob }, other));
});

test('known-answer vector (shared with the iOS client)', () => {
  const keys = deriveKeys({ account: 'AAAAAAAAAAAAAAAAAAAAAA', key: Buffer.alloc(32, 7).toString('base64url') });
  assert.equal(keys.authToken, 'pHEZK2Zc2Wg6SHa84zocsFXvOvJV1ItMbumKv6fe4C4');
  const r = rec('tab:vector', { hello: 'world' }, 1700000000000);
  const blob = encryptRecord(r, keys.encKey, Buffer.alloc(12, 1));
  assert.equal(blob, 'AQEBAQEBAQEBAQEBr+lOMtZZCMzUnTArNx0+8ZZuZebpgy8SWw+J8C0L1QC053PNmVAnS7SPvbyVeSZcfHcnnJq3sShdT01SYYeOR9ApZeM6EoZePrAabh59jwitzuVSsOU+J8xtOLoGbmVnt0HGE3e7bOypOs2W+0x1NnEiTghRtX8EQiZhNMlwrXRZ9OQA/c7i8PC4eh0HC9tAO3M=');
});

test('last-writer-wins ordering', () => {
  assert.ok(isNewer({ updatedAt: 2, deviceId: 'a' }, { updatedAt: 1, deviceId: 'b' }));
  assert.ok(!isNewer({ updatedAt: 1, deviceId: 'a' }, { updatedAt: 2, deviceId: 'b' }));
  assert.ok(isNewer({ updatedAt: 1, deviceId: 'b' }, { updatedAt: 1, deviceId: 'a' }));
  assert.ok(isNewer({ updatedAt: 1, deviceId: 'a' }, undefined));
});

test('server stores, pages, authenticates and expires records', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'marigold-sync-'));
  const server = createSyncServer({ dataDir });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const c = generateCredentials(base);
  const { authToken } = deriveKeys(c);
  const url = `${base}/v1/accounts/${c.account}/records`;
  const h = { authorization: `Bearer ${authToken}`, 'content-type': 'application/json' };
  try {
    assert.equal((await fetch(`${base}/v1/health`)).status, 200);
    let res = await fetch(url, { method: 'POST', headers: h, body: JSON.stringify({ records: [{ id: 'tab:a', blob: 'x' }, { id: 'tab:b', blob: 'y' }, { id: 'aireq:c', blob: 'z', expiresAt: Date.now() - 1 }] }) });
    assert.deepEqual(await res.json(), { seq: 3 });
    res = await fetch(`${url}?since=0`, { headers: h });
    const all = (await res.json()) as any;
    assert.deepEqual(all.records.map((r: any) => r.id), ['tab:a', 'tab:b']);
    assert.equal(all.seq, 3);
    await fetch(url, { method: 'POST', headers: h, body: JSON.stringify({ records: [{ id: 'tab:a', blob: 'x2' }] }) });
    res = await fetch(`${url}?since=3`, { headers: h });
    const delta = (await res.json()) as any;
    assert.deepEqual(delta.records, [{ id: 'tab:a', blob: 'x2', seq: 4 }]);
    res = await fetch(`${url}?since=0&limit=1`, { headers: h });
    const page = (await res.json()) as any;
    assert.equal(page.more, true);
    assert.equal(page.seq, page.records[0].seq);
    // Wrong token and malformed ids are rejected.
    assert.equal((await fetch(url, { headers: { authorization: `Bearer ${'A'.repeat(43)}` } })).status, 401);
    assert.equal((await fetch(url, { method: 'POST', headers: h, body: JSON.stringify({ records: [{ id: '../x', blob: 'x' }] }) })).status, 400);
    // Persistence across restart.
    server.flush();
    const again = createSyncServer({ dataDir });
    await new Promise<void>((r) => again.listen(0, '127.0.0.1', r));
    const base2 = `http://127.0.0.1:${(again.address() as any).port}`;
    res = await fetch(`${base2}/v1/accounts/${c.account}/records?since=0`, { headers: h });
    assert.equal(((await res.json()) as any).seq, 4);
    again.close();
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
