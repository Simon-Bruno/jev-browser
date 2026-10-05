import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToString } from 'ink';
import { stripVTControlCharacters } from 'node:util';
import { Footer, Menu } from '../dist/interactive/Layout.js';

const state = { model: 'TypeSafe / jev-latest', connection: 'Connected · CDP', mode: 'Unknown',
  tabs: [{ active: true, tabId: 't7', title: 'カナテストページノナガイタイトル'.repeat(8) }] };

test('footer stays on one line and retains provider, tab ID and connection at narrow widths', () => {
  for (const width of [30, 60, 100, 120]) {
    for (const model of ['TypeSafe / jev-latest', 'OpenRouter / ~typesafe/jev-latest']) {
      const text = stripVTControlCharacters(renderToString(h(Footer, { state: { ...state, model }, session: 'tui-test', width }), { columns: width })).trim();
      assert.equal(text.split('\n').length, 1, text);
      assert.match(text, model.startsWith('TypeSafe') ? /TypeSafe/ : /OpenRouter/);
      assert.match(text, /t7/); assert.match(text, /CDP/);
    }
  }
});

test('footer clears closed tab titles and never interprets terminal control sequences', () => {
  const text = stripVTControlCharacters(renderToString(h(Footer, { state: { ...state, tabs: [] }, session: 'test', width: 100 })));
  assert.match(text, /\/tab Select a tab/); assert.doesNotMatch(text, /カナテスト/);
  const dirty = renderToString(h(Footer, { state: { ...state, model: 'TypeSafe\x1b[2J' }, session: 'test', width: 100 }));
  assert.ok(!dirty.includes('\x1b[2J'));
});

test('menu keeps the selected item visible with more than six choices', () => {
  const text = stripVTControlCharacters(renderToString(h(Menu, {
    title: 'Connection', selected: 9, items: Array.from({ length: 12 }, (_, i) => [`Option${i}`, `Note${i}`]),
  })));
  assert.match(text, /› Option9/); assert.doesNotMatch(text, /Option0/);
});
