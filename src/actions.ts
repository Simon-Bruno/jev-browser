import { JevError } from './errors.js';

export const operations = {
  click: 'Click the target', dblclick: 'Double-click the target', fill: 'Clear and fill the input', type: 'Append text to the input',
  check: 'Set the checkbox to checked', uncheck: 'Uncheck the checkbox', hover: 'Hover over the target', focus: 'Focus the target',
  select: 'Select an explicit value or label in a native dropdown', scrollintoview: 'Scroll the target into view', get_text: 'Read the target text verbatim',
  open: 'Open a website or URL', back: 'Go back one page', forward: 'Go forward one page', reload: 'Reload the current page',
  scroll: 'Scroll the page in the given direction', press: 'Press one explicit key or key combination',
} as const;
export type Operation = keyof typeof operations;
export type ActOptions = {
  instruction: string; op?: Operation; value?: string; valueStdin?: boolean; scope?: string;
  dryRun?: boolean; nonInteractive?: boolean; probability: number; margin: number; confirm?: string; cancel?: string;
  signal?: AbortSignal; interactive?: boolean;
  recent?: Array<{ action: string; target?: string }>;
};
export const targetless = new Set<Operation>(['open', 'back', 'forward', 'reload', 'scroll', 'press']);
export const needsValue = new Set<Operation>(['fill', 'type', 'select', 'open', 'press', 'scroll']);
export const directions = { up: 'Up', down: 'Down', left: 'Left', right: 'Right' };
export const keys = Object.fromEntries(['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown',
  'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Space', 'Control+a', 'Meta+a', 'Shift+Tab'].map(k => [k, k]));

export function operation(value: string): Operation {
  if (!Object.hasOwn(operations, value)) throw new JevError('UNSUPPORTED_OPERATION', `Unsupported semantic action: ${value}.`);
  return value as Operation;
}

export function quotedValues(instruction: string): string[] {
  return [...new Set([...instruction.matchAll(/"([^"\n]*)"|'([^'\n]*)'|“([^”\n]*)”|「([^」\n]*)」|‘([^’\n]*)’/gu)]
    .map(m => m.slice(1).find(v => v !== undefined)!))];
}

export function valueOptions(op: Operation, instruction: string): Record<string, string> {
  if (op === 'press') return keys;
  if (op === 'scroll') return directions;
  let values = quotedValues(instruction);
  if (op === 'open') values = [...new Set([...values.filter(v => /^[a-z][a-z\d+.-]*:/i.test(v)), ...(instruction.match(/https?:\/\/[^\s"'“”「」<>]+/gi) ?? [])])];
  return Object.fromEntries(values.map((v, i) => [`v${i}`, v]));
}

export function command(op: Operation, binding: { ref?: string; value?: string }): string[] {
  const { ref, value } = binding;
  if (!targetless.has(op) && !/^e\d+$/.test(ref ?? '')) throw new JevError('INVALID_TARGET', 'Invalid target reference.');
  if (needsValue.has(op) && value === undefined) throw new JevError('NEEDS_INPUT', 'Missing action value. Use --value or quote the value in the instruction.');
  if (op === 'open') {
    let url: URL;
    try { url = new URL(value!); } catch { throw new JevError('INVALID_VALUE', 'open requires a full HTTP(S) URL.'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new JevError('INVALID_VALUE', 'Semantic open only supports HTTP(S) URLs.');
    return ['open', value!];
  }
  if (op === 'scroll' || op === 'press') {
    const allowed = op === 'scroll' ? directions : keys;
    if (!Object.hasOwn(allowed, value!)) throw new JevError('INVALID_VALUE', 'Unsupported key or scroll direction.');
    return op === 'scroll' ? ['scroll', value!, '500'] : ['press', value!];
  }
  if (targetless.has(op)) return [op];
  if (op === 'get_text') return ['get', 'text', `@${ref}`];
  return value === undefined ? [op, `@${ref}`] : [op, `@${ref}`, value];
}
