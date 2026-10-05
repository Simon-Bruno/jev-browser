import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publish } from '../scripts/publish.mjs';

const env = { npm_command: 'run-script', npm_execpath: '/npm path/npm-cli.js' };

test('builds and checks before publishing, keeps dry-run and registry options, and blocks recursive scripts', () => {
  const calls = [];
  const args = ['--dry-run', '--tag', 'next', '--registry', 'https://registry.example.test'];
  const status = publish({ env, args }, (command, arguments_, options) => {
    calls.push({ command, args: arguments_, options }); return { status: 0 };
  });
  assert.equal(status, 0);
  assert.equal(calls.length, 5);
  assert.deepEqual(calls[0].args, [env.npm_execpath, 'run', 'build:core']);
  assert.deepEqual(calls[1].args, [env.npm_execpath, 'run', 'build']);
  assert.match(calls[2].args[0], /scripts[/\\]licenses\.mjs$/);
  assert.match(calls[3].args[0], /scripts[/\\]check-package\.mjs$/);
  assert.deepEqual(calls[4].args, [env.npm_execpath, 'publish', '.', ...args, '--ignore-scripts']);
  assert.ok(calls.every(c => c.command === process.execPath && c.options.shell === false));
});

test('any preparation failure stops at once without uploading', () => {
  for (let failureAt = 0; failureAt < 4; failureAt++) {
    let count = 0;
    const status = publish({ env, args: [] }, () => ({ status: count++ === failureAt ? 7 : 0 }));
    assert.equal(status, 7);
    assert.equal(count, failureAt + 1);
  }
});

test('returns non-zero when the publish process fails or is interrupted', () => {
  for (const status of [3, null]) {
    let count = 0;
    assert.equal(publish({ env, args: [] }, () => ({ status: ++count === 5 ? status : 0 })), status ?? 1);
  }
});

test('lifecycle hooks of a direct npm publish do not publish again', () => {
  assert.equal(publish({ env: { ...env, npm_command: 'publish' }, args: [] }, () => {
    throw Error('Lifecycle hook should not start a child process');
  }), 0);
});

test('does not publish without npm context or when a child process cannot start', () => {
  assert.throws(() => publish({ env: {}, args: [] }), /npm run publish/);
  assert.throws(() => publish({ env, args: [] }, () => ({ error: new Error('spawn failed') })), /spawn failed/);
});
