import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { Controller } from '../dist/interactive/controller.js';
import { Models } from '../dist/interactive/models.js';
import { parseInteractive } from '../dist/interactive/options.js';
import { Browser } from '../dist/browser.js';

const cdp = process.env.JEV_TEST_CDP;
if (!cdp) throw Error('JEV_TEST_CDP must point to a dedicated browser.');
const html = await readFile(new URL('./fixtures/page.html', import.meta.url));
const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const session = `tui-live-${process.pid}`;
const models = new Models();
const controller = new Controller(parseInteractive(['--session', session, '--cdp', cdp]), { models });
const browser = new Browser(['--session', session, '--cdp', cdp]);
const report = { provider: models.config('auto').transport, cases: [], transport: [] };
function check(condition, message) { assert.ok(condition, message + '\n' + JSON.stringify(controller.state.tabs) + '\n' + controller.state.transcript.map(x => x.text).join('\n')); report.cases.push(message); }
try {
  await controller.start();
  check(controller.state.connection.includes('CDP'), 'real CDP connection');
  check(controller.state.mode === 'Unknown', 'attached display mode is not guessed');
  await controller.submit(`/open http://127.0.0.1:${server.address().port}`);
  for (let i = 0; i < 20 && !controller.state.tabs.some(t => t.active && t.title === 'Jev browser test page'); i++) {
    await new Promise(resolve => setTimeout(resolve, 100)); await controller.poll();
  }
  check(controller.state.tabs.some(t => t.active && t.title === 'Jev browser test page'), 'tab metadata');
  await controller.submit('fill “Interactive test” in the Name input');
  if (controller.state.pending) await controller.submit('confirm');
  check((await browser.request(['get', 'value', '#name'])).value === 'Interactive test', 'natural language fill');
  await controller.submit('click the confirm button in the check-in details region');
  check(!!controller.state.pending, 'confirmation before submit button');
  check((await browser.request(['get', 'text', '#result'])).text === 'Waiting for action', 'no dispatch before confirmation');
  const before = models.status()[0].requests;
  await controller.submit('confirm');
  check((await browser.request(['get', 'text', '#result'])).text === 'Check-in confirmed', 'confirmed action');
  check(models.status()[0].requests === before, 'confirmation needs zero extra model calls');
  for (const command of ['/down', '/up', '/reload', '/new', '/tabs', '/tab t1', '/back', '/forward']) await controller.submit(command);
  check(models.status()[0].requests === before, 'all shortcuts need zero model calls');
  await controller.submit('/provider openrouter'); await controller.submit('/provider auto');
  check(models.status().length === 1, 'provider selection does not eagerly create clients');
  report.transport = models.status();
  await controller.shutdown();
  check((await browser.request(['session', 'info'])).active, 'quit preserves browser session');
  await mkdir('.cache', { recursive: true });
  await writeFile('.cache/interactive-live.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await controller.shutdown(); await browser.request(['close']).catch(() => {});
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
