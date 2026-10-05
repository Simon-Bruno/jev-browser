import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildQuestions } from '../dist/questions.js';
import { snapshot } from '../dist/snapshot.js';

const page = snapshot({ origin: 'https://example.com', pageId: 'p1', frameId: null,
  snapshot: '- heading "Example Domain" [ref=e1]\n- StaticText "Example text" [ref=e2]\n- link "Learn more" [ref=e3]',
  refs: { e1: { role: 'heading', name: 'Example Domain' }, e2: { role: 'StaticText', name: 'Example text' },
    e3: { role: 'link', name: 'Learn more' } } });

test('minimal link pages expose targets without a conflicting partial page inventory', () => {
  for (const op of [undefined, 'click']) {
    for (const instruction of ['Click Learn more link', 'click the Learn more link']) {
      const built = buildQuestions({ instruction, op, probability: .8, margin: .2 }, page);
      assert.match(built.questions.target.criteria.e3, /Learn more/);
      assert.deepEqual(built.state.page, { url: 'https://example.com' });
      assert.match(built.questions.target.instructions, /candidate list gives all selectable targets/);
    }
  }
});

test('search buttons remain auxiliary input context and never gate other target roles', () => {
  const roles = ['button', 'searchbox', 'checkbox', 'radio', 'listbox'];
  const before = { ...page, candidates: [...page.candidates, ...roles.map((role, i) => ({
    ref: `e${i + 4}`, role, name: role === 'button' ? 'Search' : role, context: '', backendNodeId: null, frameId: null,
  }))] };
  const built = buildQuestions({ instruction: 'search jev', probability: .8, margin: .2 }, before);
  assert.deepEqual(built.state.page.buttons, [{ name: 'Search', context: '' }]);
  assert.deepEqual(built.state.page.inputs, [{ ref: 'e5', role: 'searchbox', name: 'searchbox', context: '' }]);
  assert.equal(built.state.page.controls, undefined);
  for (const ref of ['e3', 'e6', 'e7', 'e8']) assert.ok(built.questions.target.criteria[ref]);
  assert.ok(built.questions.input_target.criteria.e5);
  const click = buildQuestions({ instruction: 'click Learn more', op: 'click', probability: .8, margin: .2 }, before);
  assert.deepEqual(click.state.page, { url: 'https://example.com' });
});

test('search inputs with suggested query names remain explicit page evidence', () => {
  const before = snapshot({ origin: 'https://www.baidu.com/', pageId: 'p1',
    snapshot: '- textbox "Trending celebrity news" [ref=e1]\n- button "Baidu Search" [ref=e2]',
    refs: { e1: { role: 'textbox', name: 'Trending celebrity news' }, e2: { role: 'button', name: 'Baidu Search' } } });
  for (const op of [undefined, 'fill']) {
    const built = buildQuestions({ instruction: 'search jev', op, probability: .8, margin: .2 }, before);
    assert.deepEqual(built.state.page.inputs, [{ ref: 'e1', role: 'textbox', name: 'Trending celebrity news', context: '' }]);
    assert.deepEqual(built.state.page.buttons, [{ name: 'Baidu Search', context: '' }]);
    const question = built.questions[op ? 'target' : 'input_target'];
    assert.equal(question.criteria.e1, 'Text box "Trending celebrity news"');
    assert.ok(question.criteria.none);
    assert.ok(question.criteria.ambiguous);
    assert.deepEqual(built.values, { v0: 'jev' });
  }
});
