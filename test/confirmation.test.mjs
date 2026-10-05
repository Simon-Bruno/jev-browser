import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { savePending, takePending } from '../dist/confirmation.js';
import { planResult } from '../dist/semantic.js';
import { formatAct } from '../dist/act-cli.js';

function plan() {
  return { operation: 'fill', target: { name: 'Trending suggestion', role: 'textbox', context: 'generic', ref: 'e1' },
    before: { origin: 'https://example.com', pageId: 'p1' }, value: 'jev', hiddenValue: false, submit: true,
    uncertainties: [{ subject: 'Text box', message: 'Not sure which input to use yet. Please confirm.', probability: 0.8, margin: 0.6,
      alternatives: [{ label: 'Text box "Trending suggestion"', probability: 0.8 }, { label: 'No match', probability: 0.2 }] }], meta: {} };
}

test('pending plans are limited to the current session, private permissions, expiry, single use and cancellation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'jev-confirm-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const original = plan();
  const pending = await savePending(original, 'demo', directory);
  const path = join(directory, pending.id + '.json');
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await assert.rejects(takePending(pending.id, 'other', directory), { code: 'INVALID_CONFIRMATION' });
  assert.deepEqual(await takePending(pending.id, 'demo', directory), original);
  await assert.rejects(takePending(pending.id, 'demo', directory), { code: 'CONFIRMATION_NOT_FOUND' });
  const expired = await savePending(original, 'demo', directory);
  const expiredPath = join(directory, expired.id + '.json');
  const data = JSON.parse(await readFile(expiredPath, 'utf8'));
  data.expiresAt = Date.now() - 1;
  await writeFile(expiredPath, JSON.stringify(data));
  await assert.rejects(takePending(expired.id, 'demo', directory), { code: 'CONFIRMATION_EXPIRED' });
  await assert.rejects(readFile(expiredPath), { code: 'ENOENT' });
  await assert.rejects(takePending('../credentials', 'demo', directory), { code: 'INVALID_CONFIRMATION' });
  const cancel = await savePending(original, 'demo', directory);
  assert.equal(planResult(await takePending(cancel.id, 'demo', directory), 'cancelled').data.status, 'cancelled');
  await assert.rejects(takePending(cancel.id, 'demo', directory), { code: 'CONFIRMATION_NOT_FOUND' });
});

test('users see page, input, value, clearing and submit; sensitive values are not echoed', () => {
  const result = planResult(plan(), 'needs_confirmation');
  const text = formatAct({ ...result, confirmation: { id: 'example', confirmCommand: 'run command', cancelCommand: 'cancel command' } });
  for (const snippet of ['not run yet', 'https://example.com', 'Text box "Trending suggestion"', 'jev', 'clear, then fill', 'press Enter to submit', 'run command', 'cancel command']) assert.ok(text.includes(snippet));
  const sensitive = plan(); sensitive.hiddenValue = true; sensitive.value = 'secret-token';
  assert.equal(JSON.stringify(planResult(sensitive, 'needs_confirmation')).includes('secret-token'), false);
});

test('text output shows session, acted tab and the page after navigation', () => {
  const p = plan();
  p.before.pageContext = { session: 'demo', tabId: 't1', targetId: 'target1', title: 'Baidu Search', url: p.before.origin };
  const preview = formatAct(planResult(p, 'needs_confirmation'));
  for (const text of ['Session: demo', 'Tab: t1', 'Title: Baidu Search']) assert.ok(preview.includes(text));
  assert.equal(preview.includes('Current tab'), false);
  p.afterPage = { session: 'demo', tabId: 't2', targetId: 'target2', title: 'Encyclopedia details', url: 'https://example.com/detail' };
  const executed = formatAct(planResult(p, 'executed'));
  for (const text of ['Current tab: t2', 'Current title: Encyclopedia details', 'Current page: https://example.com/detail']) assert.ok(executed.includes(text));
});
