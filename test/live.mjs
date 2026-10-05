import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { Browser } from '../dist/browser.js';
import { Jev, modelConfig, choice } from '../dist/jev.js';
import { readCredentials } from '../dist/credentials.js';
import { act } from '../dist/semantic.js';
import { withSession } from '../dist/session.js';

const config = modelConfig(process.env, readCredentials());
const cdp = process.env.JEV_TEST_CDP;
if (!cdp) throw Error('JEV_TEST_CDP must point at a separate test browser.');
const html = await readFile(new URL('./fixtures/page.html', import.meta.url));
const linkHtml = await readFile(new URL('./fixtures/link.html', import.meta.url));
const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(req.url === '/link' ? linkHtml : req.url === '/learn-more' ? '<h1 id="destination">Link destination reached</h1>' : html);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const session = `live-${process.pid}`;
const browser = new Browser(['--session', session, '--cdp', cdp]);
const report = { startedAt: new Date().toISOString(), transport: config.transport, requestedModel: config.model, probe: null, cases: [] };
const cases = [
  ...[undefined, 'click'].flatMap(op => ['Click Learn more link', 'click the Learn more link'].map(instruction => ({
    name: `small page link ${op ? '--op click' : 'automatic action'} ${instruction}`, path: '/link', options: { op, instruction },
    assertion: async () => assert.equal((await browser.request(['get', 'text', '#destination'])).text, 'Link destination reached'),
  }))),
  { name: 'dry-run', options: { op: 'click', instruction: 'confirm button in the check-in details region', dryRun: true },
    assertion: async result => { assert.equal(result.data.status, 'resolved'); assert.equal((await browser.request(['get', 'text', '#result'])).text, 'Waiting for action'); } },
  { name: 'same-name buttons', options: { instruction: 'click the confirm button in the check-in details region' },
    assertion: async () => assert.equal((await browser.request(['get', 'text', '#result'])).text, 'Check-in confirmed') },
  { name: 'explicit fill', options: { op: 'fill', instruction: 'Name input', value: ' Jane Doe $() ' },
    assertion: async () => assert.equal((await browser.request(['get', 'value', '#name'])).value, ' Jane Doe $() ') },
  { name: 'quoted verbatim binding', options: { instruction: 'fill “John Smith” in the “Name” input' },
    assertion: async () => assert.equal((await browser.request(['get', 'value', '#name'])).value, 'John Smith') },
  { name: 'check a checkbox', options: { instruction: 'check I agree to the user agreement' },
    assertion: async () => assert.equal((await browser.request(['is', 'checked', '#agreement'])).checked, true) },
  { name: 'dropdown label', options: { op: 'select', instruction: 'Guests dropdown', value: '2 guests' },
    assertion: async () => assert.equal((await browser.request(['get', 'value', '#people'])).value, '2') },
  { name: 'read region text', options: { op: 'get_text', instruction: 'Action result region', scope: '#result' },
    assertion: async result => assert.equal(result.data.result.text, 'Waiting for action') },
  { name: 'target missing', options: { op: 'click', instruction: 'delete order button' }, error: 'NO_MATCH' },
  { name: 'same-name ambiguity', options: { op: 'click', instruction: 'confirm button' }, error: 'AMBIGUOUS' },
  { name: 'multi-step refused', options: { instruction: 'first fill “Alex Lee” in the Name input, then click the confirm button in check-in details' }, error: 'MULTI_STEP_UNSUPPORTED' },
  { name: 'negated instruction', options: { instruction: 'do not click any confirm button' }, error: 'UNSUPPORTED_OPERATION' },
];

try {
  const probe = new Jev(config);
  const result = await probe.evaluate({ instruction: 'choose Beijing' }, { city: choice('Choose the city in the instruction', { beijing: 'Beijing', shanghai: 'Shanghai' }) });
  assert.equal(result.answers.city.choice, 'beijing');
  report.probe = probe.evidence;
  console.log(`API probe passed: ${result.model}`);
  await withSession(session, async () => {
    for (const item of process.argv.includes('--cli-only') ? [] : cases) {
      const start = performance.now();
      const jev = new Jev(config);
      const record = { name: item.name, passed: false };
      await browser.request(['open', `http://127.0.0.1:${server.address().port}${item.path ?? '/'}`]);
      try {
        const result = await act({ probability: 0.8, margin: 0.2, ...item.options }, browser, jev);
        record.result = result;
        assert.equal(item.error, undefined, `Should have refused to run: ${item.error}`);
        assert.equal(result.data.status, item.options.dryRun ? 'resolved' : 'executed');
        await item.assertion(result);
        record.passed = true;
      } catch (error) {
        record.error = { code: error.code, message: error.message };
        record.passed = !!item.error && error.code === item.error;
        if (record.passed) {
          assert.equal((await browser.request(['get', 'text', '#result'])).text, 'Waiting for action');
          assert.equal((await browser.request(['get', 'value', '#name'])).value, '');
          assert.equal((await browser.request(['is', 'checked', '#agreement'])).checked, false);
        }
      }
      record.decisions = jev.evidence;
      record.durationMs = Math.round(performance.now() - start);
      report.cases.push(record);
      console.log(`${record.passed ? 'PASS' : 'FAIL'} ${item.name}: ${record.error?.code ?? record.result?.data.status} (${record.durationMs} ms)`);
    }
  });
  await browser.request(['open', `http://127.0.0.1:${server.address().port}`]);
  const cliStart = performance.now();
  const cliRecord = { name: 'real CLI and stdin', passed: false };
  report.cases.push(cliRecord);
  const cliResult = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/cli.js', import.meta.url)),
      '--cdp', cdp, '--json', 'page', 'act', session, '--non-interactive', '--op', 'fill', 'Name input', '--value-stdin'], {
      env: process.env, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => {
      cliRecord.exitCode = code;
      cliRecord.durationMs = Math.round(performance.now() - cliStart);
      try {
        cliRecord.result = JSON.parse(stdout);
        cliRecord.decisions = cliRecord.result.meta?.decisions ?? [];
        assert.equal(code, 0, stdout + stderr);
        resolve(cliRecord.result);
      } catch (error) { reject(error); }
    });
    child.stdin.end('CLI live check');
  });
  assert.equal(cliResult.success, true);
  assert.equal(cliResult.data.status, 'executed');
  assert.equal((await browser.request(['get', 'value', '#name'])).value, 'CLI live check');
  cliRecord.passed = true;
  console.log('PASS real CLI and stdin');
} catch (error) {
  report.fatal = { code: error.code, message: error.message };
  console.error(`Live validation stopped: ${error.code || error.name} ${error.message}`);
} finally {
  await browser.request(['close']).catch(() => {});
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await mkdir('.cache', { recursive: true });
  const path = `.cache/live-validation-${Date.now()}.json`;
  await writeFile(path, JSON.stringify(report, null, 2));
  console.log(`Report: ${path}`);
  if (report.fatal || report.cases.some(c => !c.passed)) process.exitCode = 1;
}
