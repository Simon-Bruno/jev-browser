import { JevError } from './errors.js';

type Group = { description: string; actions: Record<string, string[]> };

function direct(names: string): Record<string, string[]> {
  return Object.fromEntries(names.split(' ').map(name => [name, [name]]));
}

// Translate the public resource/action grammar to the existing executor protocol.
// Browser operations and model decisions keep their existing implementations.
export const commandGroups: Record<string, Group> = {
  session: { description: 'Session management', actions: {
    list: ['session', 'list'], ls: ['session', 'list'], inspect: ['session', 'info'],
    info: ['session', 'info'], current: ['session'], id: ['session', 'id'], close: ['close'], clear: ['close', '--all'],
  } },
  browser: { description: 'Browser connection, install and configuration', actions: {
    ...direct('connect inspect install doctor upgrade'), configure: ['set'],
  } },
  page: { description: 'Page navigation, semantic actions, reading and inspection', actions: {
    ...direct('open act back forward reload read snapshot screenshot pdf eval wait scroll get diff react vitals a11y pushstate batch'),
  } },
  element: { description: 'Deterministic element actions', actions: {
    ...direct('click dblclick fill type hover focus check uncheck select drag upload download scrollintoview get is find highlight'),
  } },
  tab: { description: 'Tab management', actions: {
    list: ['tab', 'list'], ls: ['tab', 'list'], create: ['tab', 'new'],
    switch: ['tab'], close: ['tab', 'close'],
  } },
  window: { description: 'Browser windows', actions: { create: ['window', 'new'] } },
  frame: { description: 'Page frames', actions: { switch: ['frame'], main: ['frame', 'main'] } },
  keyboard: { description: 'Keyboard input', actions: {
    press: ['press'], down: ['keydown'], up: ['keyup'], type: ['keyboard', 'type'], inserttext: ['keyboard', 'inserttext'],
  } },
  touch: { description: 'Touch actions', actions: direct('tap swipe') },
  cookie: { description: 'Cookie management', actions: {
    list: ['cookies', 'get'], get: ['cookies', 'get'], set: ['cookies', 'set'], clear: ['cookies', 'clear'],
  } },
  console: { description: 'Console logs and errors', actions: {
    list: ['console'], clear: ['console', '--clear'], errors: ['errors'],
  } },
  script: { description: 'Init scripts', actions: { remove: ['removeinitscript'] } },
  approval: { description: 'Executor action approval', actions: direct('confirm deny') },
  skill: { description: 'Bundled skills', actions: {
    list: ['skills', 'list'], ls: ['skills', 'list'], get: ['skills', 'get'], path: ['skills', 'path'],
  } },
  profile: { description: 'Local browser profiles', actions: { list: ['profiles'] } },
  server: { description: 'MCP server', actions: { start: ['mcp'] } },
};

export const existingGroups = {
  auth: 'Model and website login', network: 'Requests and network control', storage: 'Local and session storage',
  mouse: 'Mouse actions', dialog: 'Page dialogs', state: 'Login state files', stream: 'Browser screen stream',
  trace: 'Browser tracing', profiler: 'Profiling', record: 'Video recording', clipboard: 'Clipboard',
  device: 'Devices', plugin: 'Executor plugins', webmcp: 'Page-provided tools',
};

// Session names belong to browser operations; account/package utilities stay global.
export function requiresSession(args: string[]): boolean {
  const [resource, action, target] = args;
  if (resource === 'session') return ['close', 'inspect', 'info'].includes(action);
  if (resource === 'browser') return ['connect', 'configure'].includes(action);
  if (resource === 'state') return ['save', 'load'].includes(action);
  if (resource === 'auth') return action === 'login' && !!target && !target.startsWith('-') && !['typesafe', 'openrouter'].includes(target);
  return ['page', 'element', 'tab', 'window', 'frame', 'keyboard', 'touch', 'cookie', 'console', 'script', 'approval',
    'network', 'storage', 'mouse', 'dialog', 'stream', 'trace', 'profiler', 'record', 'clipboard', 'device', 'webmcp'].includes(resource);
}

const usages: Record<string, string> = {
  'session clear': '[--json] (close all sessions and clear saved tab bindings, no session name)',
  'session list': '[--json]', 'session ls': '[--json]', 'session current': '[--json]',
  'session inspect': '[--json]', 'session info': '[--json]',
  'session id': '[--scope worktree|cwd|git-root] [--prefix <prefix>]',
  'tab list': '[--json]', 'tab ls': '[--json]', 'tab create': '[URL] [--label <name>]',
  'tab switch': '<tab ID or name>', 'tab close': '[tab ID or name]',
  'window create': '', 'frame switch': '<selector>', 'frame main': '',
  'keyboard type': '<text>', 'keyboard inserttext': '<text>',
  'cookie list': '[--json]', 'cookie get': '[--json]',
  'cookie set': '<name> <value> [--url <URL>] [--domain <domain>]', 'cookie clear': '',
  'console list': '[--json]', 'console clear': '', 'console errors': '[--clear] [--json]',
  'skill list': '[--json]', 'skill ls': '[--json]', 'skill get': '<name> [--full] [--json]',
  'skill path': '<name>', 'profile list': '[--json]', 'server start': '[--tools <profiles>]',
};

export const browserOptionsHelp = `Browser connection options:
  --auto-connect       Connect to local Chrome with remote debugging on, reusing tabs and logins
  --cdp <port|url>     Connect to a debugging port or CDP URL; use instead of --auto-connect
  --pin-tab            Bind the current tab and follow tabs it opens, so other pages cannot take the binding
  --no-pin-tab         Unpin the tab
  --headed             Show the window when launching a local browser; not needed when connecting
  --json               Print results as JSON for scripts

Connect your everyday Chrome (144+):
  First enable remote debugging at chrome://inspect/#remote-debugging, then allow the connection in Chrome.
  jevb tab list mychrome --auto-connect
  jevb tab switch mychrome t2 --auto-connect
  jevb page snapshot mychrome --auto-connect --pin-tab
  jevb page act mychrome "search jev" --auto-connect --pin-tab
  Replace t2 with a tab ID from tab list; keep using the same session name.
  With a fixed debugging port: jevb browser connect mychrome 9222
`;

export function connectionHelp(resource: string): string {
  return ['browser', 'page', 'tab'].includes(resource) ? `\n${browserOptionsHelp}` : '';
}

export function groupHelp(name: string): string {
  const group = commandGroups[name];
  return `Usage: jev-browser ${name} <action> [session name] [target] [options]\n\n${group.description}\n\nActions:\n` +
    Object.keys(group.actions).map(action => `  ${action}`).join('\n') +
    `\n\nActions that need a browser session use: jev-browser ${name} <action> <session name> [target] [options].\nUse jev-browser ${name} <action> --help to see options.\n` + connectionHelp(name);
}

export function normalizeCommand(args: string[]): { args: string[]; path?: string; help?: string } {
  // Both "help page open" and "page open --help" follow the same route.
  if (args[0] === 'help' && args[1]) return normalizeCommand([...args.slice(1), '--help']);
  const [resource, action, ...rest] = args;
  if (!resource || resource === 'help') return { args };
  if (Object.hasOwn(existingGroups, resource)) return { args: action ? args : [resource, '--help'], path: action ? `${resource} ${action}` : resource };
  if (!Object.hasOwn(commandGroups, resource)) {
    const replacement = Object.entries(commandGroups).flatMap(([group, spec]) =>
      Object.entries(spec.actions).filter(([, target]) => target[0] === resource).map(([verb]) => `${group} ${verb}`))[0];
    throw new JevError('INVALID_ARGUMENT', replacement
      ? `Top-level command "${resource}" has been removed. Use jevb ${replacement}.`
      : `Unknown resource: ${resource}. Run jevb --help for available commands.`);
  }
  const group = commandGroups[resource];
  if (action === '--help' || action === '-h' || !action)
    return { args: ['help'], help: groupHelp(resource) };
  const target = Object.hasOwn(group.actions, action) ? group.actions[action] : undefined;
  if (!target) {
    throw new JevError('INVALID_ARGUMENT', `Unknown ${resource} action: ${action}. Available actions: ${Object.keys(group.actions).join(', ')}. Run jevb ${resource} --help for usage.`);
  }
  const path = `${resource} ${action}`;
  if (Object.hasOwn(usages, path) && rest.some(arg => ['--help', '-h'].includes(arg)))
    return { args: ['help'], help: `Usage: jev-browser ${path} ${requiresSession(args) ? '<session name> ' : ''}${usages[path]}\n\n${group.description}.\n` + connectionHelp(resource) };
  if (((resource === 'tab' || resource === 'frame') && action === 'switch') &&
    (!rest.length || rest[0].startsWith('-')) && !rest.some(arg => ['--help', '-h'].includes(arg)))
    throw new JevError('NEEDS_INPUT', `Missing target. Usage: jevb ${resource} switch <session> <target>.`);
  return { args: [...target, ...rest], path };
}

export function resourceOverview(): string {
  return [...Object.entries(commandGroups).map(([name, group]) => [name, group.description]),
    ...Object.entries(existingGroups)].map(([name, description]) => `  ${name.padEnd(12)} ${description}`).join('\n');
}
