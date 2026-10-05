import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, prepareAct, executePlan } from '../dist/semantic.js';
import { Jev, modelConfig } from '../dist/jev.js';
import { parseArgs } from '../dist/arguments.js';
import { snapshot, candidatesFor } from '../dist/snapshot.js';
import { command, quotedValues } from '../dist/actions.js';
import { JevError } from '../dist/errors.js';
import { sites } from '../dist/sites.js';

const data = () => ({ origin: 'http://localhost/', pageId: 'p1', frameId: null,
  snapshot: '- document\n  - region "Check-in details":\n    - button "Confirm" [ref=e1]\n    - textbox "Name" [ref=e2]\n  - region "Invoice details":\n    - button "Confirm" [ref=e3]',
  refs: { e1: { role: 'button', name: 'confirm', backendNodeId: 1 }, e2: { role: 'textbox', name: 'Name', backendNodeId: 2 }, e3: { role: 'button', name: 'confirm', backendNodeId: 3 } },
});
const options = (extra = {}) => ({ instruction: 'confirm button in check-in details', op: 'click', probability: 0.8, margin: 0.2, ...extra });
function setup(selections, changed) {
  const requests = [], commands = [];
  let snapshots = 0;
  const jev = new Jev(modelConfig({ TYPESAFE_API_KEY: 'test' }), async (_url, init) => {
    const request = JSON.parse(init.body); requests.push(request);
    const answers = Object.fromEntries(Object.entries(request.questions).map(([id, q]) => {
      if (q.type === 'noul') return [id, { type: 'noul', noul: selections[id] ?? (id === 'clear' ? 1 : 0) }];
      const selected = selections[id] ?? (id === 'input_target' ? selections.target : undefined) ?? 'none';
      if (typeof selected === 'object') return [id, { type: 'choice', confidence: 0.5, choice: selected.choice,
        probabilities: { ...Object.fromEntries(Object.keys(q.criteria).map(k => [k, 0])), ...selected.probabilities } }];
      return [id, { type: 'choice', choice: selected, confidence: 1,
        probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, k === selected ? 1 : 0])) }];
    }));
    return new Response(JSON.stringify({ model: 'jev-fixture', answers }));
  });
  const browser = { request: async (args, config) => {
    commands.push({ args, config });
    if (args[0] === 'snapshot') { snapshots++; return snapshots > 1 && changed ? changed : data(); }
    if (args[0] === 'is') return { visible: true, enabled: true };
    return { text: 'Order total 100', value: args.at(-1) };
  } };
  browser.requestBatch = async args => {
    const results = [];
    for (const command of args) results.push(await browser.request(command));
    return results;
  };
  return { jev, browser, requests, commands };
}

test('same-name buttons keep their region; the right target is dispatched once', async () => {
  const s = setup({ target: 'e1' });
  const result = await act(options(), s.browser, s.jev);
  assert.equal(result.data.status, 'executed');
  assert.match(s.requests[0].questions.target.criteria.e1, /Check-in details/);
  assert.match(s.requests[0].questions.target.criteria.e3, /Invoice details/);
  assert.deepEqual(s.commands.filter(c => c.config?.dispatch).map(c => c.args), [['click', '@e1']]);
});

test('dry-run observes and rechecks without dispatching', async () => {
  const s = setup({ target: 'e1' });
  assert.equal((await act(options({ dryRun: true }), s.browser, s.jev)).data.status, 'resolved');
  assert.equal(s.commands.filter(c => c.config?.dispatch).length, 0);
});

test('hidden or disabled targets are refused; reading and scrolling into view only check visibility', async () => {
  for (const state of [{ visible: false, enabled: true }, { visible: true, enabled: false }]) {
    const s = setup({ target: 'e1' });
    const original = s.browser.request;
    s.browser.request = async (args, config) => args[0] === 'is' ? state : original(args, config);
    await assert.rejects(act(options(), s.browser, s.jev), { code: 'STALE_TARGET', dispatched: false });
    assert.equal(s.commands.filter(c => c.config?.dispatch).length, 0);
  }
  for (const op of ['get_text', 'scrollintoview']) {
    const s = setup({ target: 'e1' });
    const original = s.browser.request;
    s.browser.request = async (args, config) => {
      assert.notDeepEqual(args.slice(0, 2), ['is', 'enabled']);
      return original(args, config);
    };
    assert.equal((await act(options({ op }), s.browser, s.jev)).data.status, 'executed');
  }
});

test('a target disabled after fill or focus still stops the later submit without replay', async () => {
  for (const disableAfter of ['fill', 'focus']) {
    const s = setup({ operation: 'input', input_target: 'e2', clear: 1, submit: 1, value: 'v0' });
    const original = s.browser.request;
    let disabled = false;
    s.browser.request = async (args, config) => {
      if (args[0] === disableAfter) disabled = true;
      if (args[0] === 'is' && args[1] === 'enabled') return { enabled: !disabled };
      return original(args, config);
    };
    await assert.rejects(act(options({ op: undefined, instruction: 'search jev' }), s.browser, s.jev),
      { code: 'STALE_TARGET', dispatched: true });
    assert.deepEqual(s.commands.filter(c => c.config?.dispatch).map(c => c.args[0]),
      disableAfter === 'fill' ? ['fill'] : ['fill', 'focus']);
  }
});

test('preview keeps the session tab title; execution reports the newly bound page', async () => {
  const before = { session: 'demo', tabId: 't1', targetId: 'target1', title: 'Search page', url: 'http://localhost/' };
  const after = { ...before, tabId: 't2', targetId: 'target2', title: 'Details page', url: 'http://localhost/detail' };
  for (const dryRun of [true, false]) {
    const s = setup({ target: 'e1' });
    const original = s.browser.request;
    s.browser.request = async (args, config) => {
      const result = await original(args, config);
      return args[0] === 'snapshot' ? { ...result, pageContext: before } : config?.dispatch ? { ...result, pageContext: after } : result;
    };
    const result = await act(options({ dryRun }), s.browser, s.jev);
    assert.equal(result.data.session, 'demo');
    assert.equal(result.data.plan.tabId, 't1');
    assert.equal(result.data.plan.title, 'Search page');
    assert.deepEqual(result.data.pageContext, dryRun ? before : after);
  }
});

test('none, ambiguous, multi-step and negated instructions do not run', async () => {
  for (const [selections, opts, code] of [
    [{ target: 'none' }, options(), 'NO_MATCH'],
    [{ target: 'ambiguous' }, options(), 'AMBIGUOUS'],
    [{ operation: 'multi_step' }, options({ op: undefined, instruction: 'click confirm and then fill in the name' }), 'MULTI_STEP_UNSUPPORTED'],
    [{ operation: 'unsupported' }, options({ op: undefined, instruction: 'do not click confirm' }), 'UNSUPPORTED_OPERATION'],
  ]) {
    const s = setup(selections);
    await assert.rejects(act(opts, s.browser, s.jev), { code });
    assert.equal(s.commands.filter(c => c.config?.dispatch).length, 0);
  }
});

test('page switches, node replacement and context changes are all refused', async () => {
  for (const mutate of [d => { d.pageId = 'p2'; }, d => { d.refs.e1.backendNodeId = 99; },
    d => { d.snapshot = d.snapshot.replace('Check-in details', 'Payment details'); }, d => { d.frameId = 'other'; }]) {
    const changed = data(); mutate(changed);
    const s = setup({ target: 'e1' }, changed);
    await assert.rejects(act(options(), s.browser, s.jev), { code: 'STALE_TARGET' });
    assert.equal(s.commands.filter(c => c.config?.dispatch).length, 0);
  }
});

test('verbatim value choice is independent of the target; whitespace, newlines and shell characters are kept', async () => {
  const secret = '  x; $(touch nope) `a`\n';
  const s = setup({ target: 'e2' });
  const result = await act(options({ op: 'fill', instruction: 'Name', value: secret, valueStdin: true }), s.browser, s.jev);
  assert.equal(s.commands.at(-1).args[2], secret);
  assert.equal(JSON.stringify(s.requests).includes(secret), false);
  assert.equal(JSON.stringify(result).includes('touch nope'), false);
  const q = setup({ operation: 'input', target: 'e2', value: 'v1' });
  await act(options({ op: undefined, instruction: 'set “Name” to “Jane Doe”' }), q.browser, q.jev);
  assert.deepEqual(q.commands.at(-1).args, ['fill', '@e2', 'Jane Doe']);
  assert.equal(q.requests.length, 1);
  for (const key of ['operation', 'input_target', 'clear', 'submit', 'value']) assert.ok(q.requests[0].questions[key]);
});

test('with a known action, target and verbatim value are judged in one request', async () => {
  const s = setup({ target: 'e2', value: 'v1' });
  await act(options({ op: 'fill', instruction: 'set “Name” to “Jane Doe”' }), s.browser, s.jev);
  assert.equal(s.requests.length, 1);
  assert.deepEqual(Object.keys(s.requests[0].questions).sort(), ['target', 'value']);
  assert.deepEqual(s.commands.at(-1).args, ['fill', '@e2', 'Jane Doe']);
});

test('missing arguments stop at once; unknown operations and protocols are refused', async () => {
  const s = setup({ target: 'e2' });
  await assert.rejects(act(options({ op: 'fill' }), s.browser, s.jev), { code: 'NEEDS_INPUT' });
  assert.equal(s.commands.length, 0);
  assert.throws(() => command('open', { value: 'javascript:alert(1)' }), { code: 'INVALID_VALUE' });
  assert.throws(() => command('press', { value: 'invented' }), { code: 'INVALID_VALUE' });
  assert.deepEqual(quotedValues('fill “” and “ A ”'), ['', ' A ']);
});

test('candidates above the per-question limit are all kept and batched by the model layer', () => {
  const observation = snapshot(data());
  observation.candidates = Array.from({ length: 254 }, (_, i) => ({ ...observation.candidates[0], ref: `e${i}` }));
  assert.equal(candidatesFor(observation, 'click').length, 254);
});

test('parses the real upstream ref format with states like checked and expanded', () => {
  const d = data();
  d.snapshot = '- checkbox "Agreement" [checked=false, ref=e1]\n- combobox "Guests" [expanded=false, ref=e2]: 1 guest';
  d.refs.e1.role = 'checkbox'; d.refs.e2.role = 'combobox';
  const parsed = snapshot(d);
  assert.deepEqual(parsed.candidates.map(c => c.ref), ['e1', 'e2']);
  assert.equal(candidatesFor(parsed, 'check')[0].ref, 'e1');
});

test('date fill picks the whole native control, not its inner year, month and day parts', () => {
  const d = data();
  d.snapshot = '- Date "Check-out date" [ref=e1]: 2026-10-12\n  - spinbutton "Year" [ref=e2]: 2026\n- spinbutton "Number of rooms" [ref=e3]: 1';
  d.refs.e1 = { role: 'Date', name: 'Check-out date', backendNodeId: 1 };
  d.refs.e2 = { role: 'spinbutton', name: 'Year', backendNodeId: 2 };
  d.refs.e3 = { role: 'spinbutton', name: 'Number of rooms', backendNodeId: 3 };
  assert.deepEqual(candidatesFor(snapshot(d), 'fill').map(c => c.ref), ['e1', 'e3']);
});

test('argument parsing keeps values and global scope, and does not treat a value of act as a command', () => {
  const p = parseArgs(['page', 'act', 'act', '--op', 'fill', 'Name', '--value', '--json', '--json']);
  assert.equal(p.session, 'act'); assert.equal(p.options.value, '--json'); assert.equal(p.json, true);
  assert.equal(parseArgs(['element', 'fill', 'demo', '#name', 'act']).name, 'fill');
  assert.equal(parseArgs(['--restore', 'saved-login', 'page', 'snapshot', 'demo']).name, 'snapshot');
  assert.equal(parseArgs(['--restore', 'page', 'act', 'demo', '--op', 'click', 'button']).name, 'act');
  assert.throws(() => parseArgs(['page', 'act', 'demo', 'button', '--min-probability', 'oops']), { code: 'INVALID_ARGUMENT' });
});

test('unknown execution is not retried automatically', async () => {
  const s = setup({ target: 'e1' }); let dispatched = 0;
  const original = s.browser.request;
  s.browser.request = async (args, config) => {
    if (config?.dispatch) { dispatched++; throw Object.assign(new Error('unknown'), { code: 'EXECUTION_UNKNOWN' }); }
    return original(args, config);
  };
  await assert.rejects(act(options(), s.browser, s.jev), { code: 'EXECUTION_UNKNOWN' });
  assert.equal(dispatched, 1);
});

test('search judges action, input, clearing, Enter and value together; irrelevant branches do not block', async () => {
  const s = setup({ operation: 'input', input_target: 'e2', clear: 0.99, submit: 0.99, value: 'v0', target: 'ambiguous' });
  const result = await act(options({ op: undefined, instruction: 'search jev' }), s.browser, s.jev);
  assert.equal(s.requests.length, 1);
  assert.equal(s.requests[0].questions.clear.type, 'noul');
  assert.equal(s.requests[0].questions.submit.type, 'noul');
  assert.equal(result.data.plan.value, 'jev');
  assert.equal(result.data.plan.clear, true);
  assert.equal(result.data.plan.submit, true);
  assert.deepEqual(s.commands.filter(c => c.config?.dispatch).map(c => c.args), [
    ['fill', '@e2', 'jev'], ['focus', '@e2'], ['press', 'Enter'],
  ]);
});

test('model decides to keep old value and not submit; explicit fill/type keep atomic behaviour', async () => {
  const s = setup({ operation: 'input', input_target: 'e2', clear: 0.01, submit: 0.01, value: 'v0' });
  const result = await act(options({ op: undefined, instruction: 'append “jev” but do not submit' }), s.browser, s.jev);
  assert.equal(result.data.plan.clear, false);
  assert.equal(result.data.plan.submit, false);
  assert.deepEqual(s.commands.filter(c => c.config?.dispatch).map(c => c.args), [['type', '@e2', 'jev']]);
  for (const op of ['fill', 'type']) {
    const explicit = setup({ target: 'e2' });
    await act(options({ op, instruction: 'Search box', value: 'jev' }), explicit.browser, explicit.jev);
    assert.equal(explicit.requests[0].questions.clear, undefined);
    assert.equal(explicit.requests[0].questions.submit, undefined);
    assert.deepEqual(explicit.commands.filter(c => c.config?.dispatch).map(c => c.args), [[op, '@e2', 'jev']]);
  }
});

test('any relevant judgment under threshold returns a pending plan, not run yet', async () => {
  const uncertain = choice => ({ choice, probabilities: { [choice]: 0.65, none: 0.35 } });
  for (const override of [
    { operation: { choice: 'input', probabilities: { input: 0.65, click: 0.35 } } },
    { input_target: uncertain('e2') }, { value: uncertain('v0') }, { clear: 0.6 }, { submit: 0.6 },
  ]) {
    const s = setup({ operation: 'input', input_target: 'e2', clear: 0.99, submit: 0.99, value: 'v0', ...override });
    const plan = await prepareAct(options({ op: undefined, instruction: 'search jev' }), s.browser, s.jev);
    const result = await executePlan(plan, s.browser);
    assert.equal(result.data.status, 'needs_confirmation');
    assert.equal(result.data.uncertainties.length, 1);
    assert.equal(result.data.plan.value, 'jev');
    assert.equal(result.data.plan.submit, true);
    assert.equal(s.commands.filter(c => c.config?.dispatch).length, 0);
    assert.equal((await executePlan(plan, s.browser, true)).data.status, 'executed');
    assert.equal(s.requests.length, 1);
  }
});

test('page changes are refused even after confirmation; dry-run never runs even when confirmed', async () => {
  const s = setup({ target: { choice: 'e1', probabilities: { e1: 0.55, e3: 0.45 } } });
  const plan = await prepareAct(options(), s.browser, s.jev);
  const original = s.browser.request;
  s.browser.request = async (args, config) => args[0] === 'snapshot' ? { ...data(), pageId: 'different' } : original(args, config);
  await assert.rejects(executePlan(plan, s.browser, true), { code: 'STALE_TARGET' });
  assert.equal(s.commands.filter(c => c.config?.dispatch).length, 0);
  const d = setup({ target: 'e1' });
  const preview = await prepareAct(options({ dryRun: true }), d.browser, d.jev);
  assert.equal((await executePlan(preview, d.browser, true)).data.status, 'resolved');
  assert.equal(d.commands.filter(c => c.config?.dispatch).length, 0);
});

test('page change after fill or failed submit reports partial execution without retry', async () => {
  for (const failure of ['navigation', 'submit']) {
    const s = setup({ operation: 'input', input_target: 'e2', clear: 1, submit: 1, value: 'v0' });
    let filled = false;
    const dispatched = [];
    const original = s.browser.request;
    s.browser.request = async (args, config) => {
      if (config?.dispatch) dispatched.push(args);
      if (args[0] === 'fill') filled = true;
      if (filled && args[0] === 'snapshot' && failure === 'navigation') return { ...data(), pageId: 'other' };
      if (args[0] === 'press' && failure === 'submit') throw new JevError('EXECUTION_UNKNOWN', 'timeout', true);
      return original(args, config);
    };
    await assert.rejects(act(options({ op: undefined, instruction: 'search jev' }), s.browser, s.jev),
      { code: failure === 'navigation' ? 'STALE_TARGET' : 'EXECUTION_UNKNOWN', dispatched: true });
    assert.equal(dispatched.filter(args => args[0] === 'fill').length, 1);
    assert.equal(dispatched.filter(args => args[0] === 'press').length, failure === 'navigation' ? 0 : 1);
  }
});

test('a confirmation id cannot be combined with plan or threshold changes', () => {
  assert.equal(parseArgs(['page', 'act', 'demo', '--confirm', 'jev-id']).options.confirm, 'jev-id');
  assert.equal(parseArgs(['page', 'act', 'demo', '--cancel', 'jev-id']).options.cancel, 'jev-id');
  for (const extra of [['search something else'], ['--value', 'other'], ['--dry-run'], ['--scope', '#other'], ['--min-probability', '0'], ['--cancel', 'id']])
    assert.throws(() => parseArgs(['page', 'act', 'demo', '--confirm', 'jev-id', ...extra]), { code: 'INVALID_ARGUMENT' });
});

test('common site names map to runnable URLs, also with explicit open', async () => {
  for (const op of [undefined, 'open']) {
    const s = setup({ operation: 'open', [op ? 'value' : 'url']: 'google' });
    const result = await act(options({ op, instruction: 'open “Google”' }), s.browser, s.jev);
    assert.equal(result.data.plan.value, 'https://www.google.com');
    assert.deepEqual(s.commands.filter(c => c.config?.dispatch).map(c => c.args), [['open', 'https://www.google.com']]);
    assert.equal(s.requests.length, 1);
    assert.match(s.requests[0].questions[op ? 'value' : 'url'].criteria.google, /Google/);
  }
});

test('all 30 built-in sites form valid navigation plans; preview does not run', async () => {
  assert.equal(Object.keys(sites).length, 30);
  assert.equal(new Set(Object.values(sites).map(site => site.url)).size, 30);
  for (const [id, site] of Object.entries(sites)) {
    const s = setup({ operation: 'open', url: id });
    const result = await act(options({ op: undefined, instruction: `open ${site.label}`, dryRun: true }), s.browser, s.jev);
    assert.equal(result.data.status, 'resolved');
    assert.equal(result.data.plan.value, site.url);
    assert.equal(s.commands.filter(c => c.config?.dispatch).length, 0);
  }
});

test('a full URL wins over common sites; original path and query are kept', async () => {
  const s = setup({ operation: 'open', url: 'v0' });
  const url = 'https://www.google.com/maps?q=hello';
  await act(options({ op: undefined, instruction: `open Google Maps ${url}` }), s.browser, s.jev);
  assert.equal(s.requests[0].questions.url.criteria.google, undefined);
  assert.deepEqual(s.commands.at(-1).args, ['open', url]);
});

test('unknown or ambiguous sites ask for a full URL; low-confidence matches still need confirmation', async () => {
  for (const choice of ['none', 'ambiguous']) {
    const s = setup({ operation: 'open', url: choice });
    await assert.rejects(act(options({ op: undefined, instruction: 'open an unknown website' }), s.browser, s.jev), { code: 'NEEDS_URL' });
    assert.equal(s.commands.filter(c => c.config?.dispatch).length, 0);
  }
  const s = setup({ operation: 'open', url: { choice: 'google', probabilities: { google: 0.6, none: 0.4 } } });
  const plan = await prepareAct(options({ op: undefined, instruction: 'open Google' }), s.browser, s.jev);
  assert.equal((await executePlan(plan, s.browser)).data.status, 'needs_confirmation');
  assert.equal(s.commands.filter(c => c.config?.dispatch).length, 0);
  await executePlan(plan, s.browser, true);
  assert.deepEqual(s.commands.at(-1).args, ['open', 'https://www.google.com']);
});

function missingTab(selections, failure) {
  const s = setup(selections);
  const original = s.browser.request;
  s.browser.request = async (args, config) => {
    if (args[0] === 'snapshot') throw new JevError('BROWSER_ERROR', 'tab_gone: bound tab is gone');
    const result = await original(args, config);
    if (failure) throw failure;
    return { ...result, pageContext: { session: 'demo', tabId: 't2', targetId: 'new-target',
      title: 'Baidu', url: 'https://www.baidu.com' } };
  };
  return s;
}

test('opening a page after the bound tab closes creates one tab only; preview creates none', async () => {
  for (const dryRun of [false, true]) {
    const s = missingTab({ operation: 'open', url: 'baidu' });
    const result = await act(options({ op: undefined, instruction: 'open baidu', dryRun }), s.browser, s.jev);
    assert.equal(result.data.status, dryRun ? 'resolved' : 'executed');
    assert.equal(result.data.plan.newTab, true);
    assert.equal(result.data.plan.page, 'New tab');
    assert.deepEqual(s.commands.map(c => c.args), dryRun ? [] : [['tab', 'new', 'https://www.baidu.com']]);
    if (!dryRun) assert.equal(result.data.pageContext.tabId, 't2');
  }
});

test('click, fill and other page actions still fail after the bound tab closes', async () => {
  for (const [op, selected] of [['click', 'click'], ['fill', 'input'], [undefined, 'click'], [undefined, 'input']]) {
    const s = missingTab({ operation: selected });
    await assert.rejects(act(options({ op, value: op === 'fill' ? 'hello' : undefined }), s.browser, s.jev),
      error => error.code === 'BROWSER_ERROR' && error.message.startsWith('tab_gone:'));
    assert.deepEqual(s.commands, []);
  }
});

test('new-tab plans still confirm low-confidence URLs; once saved, confirmation runs only once', async () => {
  const s = missingTab({ operation: 'open', url: { choice: 'baidu', probabilities: { baidu: .6, none: .4 } } });
  const plan = await prepareAct(options({ op: undefined, instruction: 'open Baidu' }), s.browser, s.jev);
  assert.equal((await executePlan(plan, s.browser)).data.status, 'needs_confirmation');
  assert.deepEqual(s.commands, []);
  await executePlan(JSON.parse(JSON.stringify(plan)), s.browser, true);
  assert.deepEqual(s.commands.map(c => c.args), [['tab', 'new', 'https://www.baidu.com']]);
});

test('failed new-tab recovery is not replayed; other connection errors and invalid URLs do not create a tab', async () => {
  const s = missingTab({ operation: 'open', url: 'baidu' }, new JevError('EXECUTION_UNKNOWN', 'connection closed', true));
  await assert.rejects(act(options({ op: undefined, instruction: 'open Baidu' }), s.browser, s.jev), { code: 'EXECUTION_UNKNOWN' });
  assert.equal(s.commands.length, 1);
  const invalid = missingTab({});
  await assert.rejects(act(options({ op: 'open', value: 'javascript:alert(1)' }), invalid.browser, invalid.jev), { code: 'INVALID_VALUE' });
  assert.deepEqual(invalid.commands, []);
  const failed = setup({ operation: 'open', url: 'baidu' });
  failed.browser.request = async () => { throw new JevError('BROWSER_ERROR', 'Chrome rejected the connection'); };
  await assert.rejects(act(options({ op: undefined, instruction: 'open Baidu' }), failed.browser, failed.jev), /Chrome rejected/);
  assert.equal(failed.requests.length, 0);
});
