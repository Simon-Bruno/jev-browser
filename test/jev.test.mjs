import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Jev, modelConfig, choice, noul, asChoice, validateEvaluation, accepted } from '../dist/jev.js';
import { coreEnv } from '../dist/browser.js';
import { fileURLToPath } from 'node:url';

const questions = { target: choice('Choose the target', { e1: 'confirm', none: 'Does not exist' }) };
const valid = () => ({ model: 'jev-test', answers: { target: {
  type: 'choice', choice: 'e1', probabilities: { e1: 0.98, none: 0.02 }, confidence: 0.9,
} } });

test('four key combinations and blank values; official provider first', () => {
  assert.throws(() => modelConfig({}), { code: 'MISSING_API_KEY' });
  assert.equal(modelConfig({ TYPESAFE_API_KEY: ' official ' }).key, 'official');
  assert.equal(modelConfig({ OPENROUTER_API_KEY: 'router' }).model, '~typesafe/jev-latest');
  assert.equal(modelConfig({ TYPESAFE_API_KEY: 'official', OPENROUTER_API_KEY: 'router' }).transport, 'typesafe');
  assert.equal(modelConfig({ TYPESAFE_API_KEY: ' ', OPENROUTER_API_KEY: 'router' }).transport, 'openrouter');
});

test('both channels use the real HTTP Decisions protocol; no fallback when official fails', async t => {
  const requests = [];
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    requests.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(text) });
    res.writeHead(req.headers.authorization === 'Bearer bad' ? 401 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(valid()));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const env of [{ TYPESAFE_API_KEY: 'official' }, { OPENROUTER_API_KEY: 'router' }]) {
    const config = modelConfig(env);
    const jev = new Jev(config, (url, init) => fetch(base + new URL(url).pathname, init));
    await jev.evaluate({ instruction: 'click confirm' }, questions);
    assert.equal(jev.evidence[0].transport, config.transport);
  }
  const both = modelConfig({ TYPESAFE_API_KEY: 'bad', OPENROUTER_API_KEY: 'router' });
  await assert.rejects(new Jev(both, (url, init) => fetch(base + new URL(url).pathname, init)).evaluate({}, questions), { code: 'MODEL_HTTP_401' });
  assert.equal(requests.length, 3);
  assert.deepEqual(requests.map(r => r.url), ['/v1/systemone', '/api/alpha/decisions', '/v1/systemone']);
  assert.equal(requests[1].body.model, '~typesafe/jev-latest');
  assert.equal(requests[0].body.questions.target.type, 'choice');
  assert.equal(requests[2].auth, 'Bearer bad');
});

test('rejects unknown IDs, missing or invalid probabilities and non-top choices', () => {
  for (const mutate of [
    r => { r.answers.target.choice = 'e2'; },
    r => { delete r.answers.target.probabilities.none; },
    r => { r.answers.target.probabilities.e1 = NaN; },
    r => { r.answers.target.probabilities.e1 = 0.1; r.answers.target.probabilities.none = 0.9; },
    r => { r.answers.target.confidence = 2; },
    r => { r.answers.target.probabilities.extra = 0; },
  ]) {
    const raw = valid(); mutate(raw);
    assert.throws(() => validateEvaluation(raw, questions), { code: 'INVALID_MODEL_RESPONSE' });
  }
  assert.equal(validateEvaluation(valid(), questions).answers.target.choice, 'e1');
});

test('low probability does not dispatch; oversized model input is not truncated', async () => {
  assert.throws(() => accepted({ ...valid().answers.target, probabilities: { e1: 0.6, none: 0.4 } }), { code: 'AMBIGUOUS' });
  const jev = new Jev(modelConfig({ TYPESAFE_API_KEY: 'test' }), () => { throw Error('Should not send'); });
  await assert.rejects(jev.evaluate('x'.repeat(60000), questions), { code: 'CONTEXT_TOO_LARGE' });
});

test('executor does not inherit model keys or upstream runtime config', () => {
  const env = coreEnv({ TYPESAFE_API_KEY: 'secret1', OPENROUTER_API_KEY: 'secret2',
    AGENT_BROWSER_SOCKET_DIR: '/original', AGENT_BROWSER_DAEMON: '1',
    JEV_BROWSER_RUNTIME_DIR: '/tmp/jev-test', PATH: '/bin' });
  assert.equal(env.TYPESAFE_API_KEY, undefined);
  assert.equal(env.OPENROUTER_API_KEY, undefined);
  assert.equal(env.AGENT_BROWSER_DAEMON, undefined);
  assert.equal(env.AGENT_BROWSER_SOCKET_DIR, '/tmp/jev-test');
  assert.equal(env.AGENT_BROWSER_NAMESPACE, 'jev');
  assert.equal(env.AGENT_BROWSER_NO_REPLAY, '1');
  assert.equal(env.AGENT_BROWSER_SKILLS_DIR, fileURLToPath(new URL('../skills', import.meta.url)));
});

test('parallel Noul and Choice responses are both validated; yes/no handled symmetrically', () => {
  const mixed = { ...questions, clear: noul('Clear it?', { true: 'Clear', false: 'Keep' }) };
  const result = { ...valid(), answers: { ...valid().answers, clear: { type: 'noul', noul: 0.95 } } };
  assert.equal(validateEvaluation(result, mixed).answers.clear.noul, 0.95);
  assert.equal(asChoice(result.answers.clear).choice, 'true');
  assert.equal(accepted(asChoice({ type: 'noul', noul: 0.02 })), 'false');
  assert.throws(() => accepted(asChoice({ type: 'noul', noul: 0.5 })), { code: 'AMBIGUOUS' });
  for (const answer of [{ type: 'noul', noul: 2 }, { type: 'noul' }, { type: 'noul', noul: '0.9' }, valid().answers.target])
    assert.throws(() => validateEvaluation({ ...result, answers: { ...result.answers, clear: answer } }, mixed), { code: 'INVALID_MODEL_RESPONSE' });
});
