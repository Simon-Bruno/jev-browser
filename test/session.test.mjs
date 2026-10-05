import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withSession } from '../dist/session.js';

test('same session is exclusive, different sessions work; lock is released after errors', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'jev-lock-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await withSession('a', async () => {
    await assert.rejects(withSession('a', async () => {}, dir), { code: 'SESSION_BUSY' });
    await withSession('b', async () => {}, dir);
  }, dir);
  await assert.rejects(withSession('a', async () => { throw Error('failed'); }, dir));
  assert.equal(await withSession('a', async () => 42, dir), 42);
});
