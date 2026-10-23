import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decidePull } from '../src/sync-logic.ts';
import {
  celAnd,
  celString,
  isBlockedByHost,
  MemosClient,
  memoUid,
  memoUrl,
  normalizeBaseUrl,
  normalizeSpace,
  normalizeTag,
} from '../src/memos-client.ts';
import type { Transport } from '../src/memos-client.ts';

const base = {
  remoteHash: 'r1',
  syncedHash: 'r1',
  localHash: 'l1',
  syncedLocalHash: 'l1',
  remoteUpdated: 2000,
  localUpdated: 1000,
};

test('decidePull', () => {
  assert.equal(decidePull(base), 'none');
  assert.equal(decidePull({ ...base, remoteHash: 'r2' }), 'pull');
  assert.equal(
    decidePull({ ...base, remoteHash: 'r2', localHash: 'l2' }),
    'pullKeepLocal',
  );
  assert.equal(
    decidePull({ ...base, remoteHash: 'r2', localHash: 'l2', localUpdated: 3000 }),
    'pushKeepRemote',
  );
  // Local-only change is the push path's job.
  assert.equal(decidePull({ ...base, localHash: 'l2' }), 'none');
});

test('url, space and tag normalization', () => {
  assert.equal(
    normalizeBaseUrl(' https://m.example.com/api/v1/ '),
    'https://m.example.com',
  );
  assert.equal(normalizeBaseUrl('https://m.example.com//'), 'https://m.example.com');
  assert.equal(normalizeSpace('team'), 'spaces/team');
  assert.equal(normalizeSpace('spaces/team/'), 'spaces/team');
  assert.equal(normalizeSpace(''), '');
  assert.equal(normalizeTag('#work '), 'work');
  assert.equal(memoUid({ name: 'memos/abc' }), 'abc');
  assert.equal(memoUrl('https://m/', 'abc'), 'https://m/memos/abc');
});

test('isBlockedByHost mirrors SP plugin http checks', () => {
  for (const url of [
    'http://localhost:5230',
    'http://127.0.0.1',
    'http://192.168.1.5:5230',
    'http://10.0.0.2',
    'http://172.20.1.1',
    'http://[::1]',
    'http://[fd00::1]',
  ]) {
    assert.equal(isBlockedByHost(url), true, url);
  }
  for (const url of [
    'https://memos.home.lan',
    'https://usememos.com',
    'http://172.32.0.1',
  ]) {
    assert.equal(isBlockedByHost(url), false, url);
  }
});

test('CEL helpers', () => {
  assert.equal(celString('a "b" \\'), '"a \\"b\\" \\\\"');
  assert.equal(celAnd('a', false, '', undefined, 'b'), 'a && b');
});

test('MemosClient builds the expected requests', async () => {
  const calls: [string, string, unknown][] = [];
  const pages = [
    { memos: [{ name: 'memos/a' }], nextPageToken: 'p2' },
    { memos: [{ name: 'memos/b' }] },
  ];
  const transport: Transport = {
    request: async <T>(method: string, url: string, body?: unknown): Promise<T> => {
      calls.push([method, url, body]);
      return (method === 'GET' && url.includes('/memos?') ? pages.shift() : {}) as T;
    },
  };
  const client = new MemosClient('https://m/', transport);

  const memos = await client.listMemos('has_task_list == true', 10);
  assert.deepEqual(
    memos.map((m) => m.name),
    ['memos/a', 'memos/b'],
  );
  assert.match(
    calls[0][1],
    /^https:\/\/m\/api\/v1\/memos\?pageSize=10&filter=has_task_list\+%3D%3D\+true$/,
  );
  assert.match(calls[1][1], /pageToken=p2/);

  await client.updateMemo('a', { content: 'x' });
  assert.deepEqual(calls[2], [
    'PATCH',
    'https://m/api/v1/memos/a?updateMask=content%2Cupdate_time',
    { content: 'x', name: 'memos/a' },
  ]);

  await client.updateMemo('a', { state: 'ARCHIVED' });
  assert.equal(calls[3][1], 'https://m/api/v1/memos/a?updateMask=state');

  await client.createComment('a', 'c');
  assert.deepEqual(calls[4], [
    'POST',
    'https://m/api/v1/memos/a/comments',
    { content: 'c' },
  ]);
});
