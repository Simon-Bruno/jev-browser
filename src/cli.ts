#!/usr/bin/env node
import { Browser } from './browser.js';
import { parseArgs } from './arguments.js';
import { resourceOverview, browserOptionsHelp, connectionHelp } from './command-tree.js';
import { runAct } from './act-cli.js';
import { JevError, failure } from './errors.js';
import { withSession } from './session.js';
import { ensureLogin, handleAuth } from './auth.js';

const help = `jev-browser 0.2.0-stellar: Jev semantic browser CLI

Usage: jev-browser [global options] <resource> <action> [session name] [target] [options]

  page open <session name> <url>                  Open a page; sets up local Chrome if missing
  page snapshot demo --json                       Read a structured page snapshot
  element click demo @e1                          Deterministic command, no model call
  page act demo "click the check-in confirm"      Choose and run one action
  page act demo "search jev"                      Judge field, value, clearing and submit in parallel
  page act demo --op fill "Name" --value "Jane Doe"
  page act demo --op fill "Password" --value-stdin
  page act demo "click confirm" --dry-run --json
  page act demo --confirm <id>                    Run a plan that was shown
  page act demo --cancel <id>                     Cancel a pending plan
  session close <session name>                    Close a session, e.g. session close demo
  session clear                                   Close all sessions and clear tab bindings, no session name
  session list                                    List running sessions
  auth login                                      Log in
  auth login --with-token                         Log in from stdin
  auth status / auth logout <provider>            Show sources / delete the local key

Resource commands:
${resourceOverview()}

page act: --op, --value, --value-stdin, --scope <CSS>, --dry-run
     --non-interactive (no prompts, no pending plans saved)
     --min-probability <0..1> (default 0.80), --min-margin <0..1> (default 0.20)
page act exit codes: 0 done, previewed or cancelled; 1 error; 2 needs confirmation; 3 outcome unknown or error after dispatch.
${browserOptionsHelp}
Sessions: browser actions need a session name after the action, e.g. page act demo "search jev".
Options: jev-browser <resource> <action> --help
Alias: jevb is the same as jev-browser.
Interactive mode: run jevb in a terminal, or use jevb tui; see jevb tui --help for options.

You will be asked to log in on first use.
`;

const closeHelp = `Usage: jev-browser session close <session name>

  jev-browser session close demo     Close the demo session
  jev-browser session clear          Close all sessions and clear tab bindings

close needs a session name; use session clear to close all sessions. With your own Chrome, only the control connection is closed.
`;

async function stdinValue(): Promise<string> {
  if (process.stdin.isTTY) throw new JevError('NEEDS_INPUT', '--value-stdin requires piped input.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 1_000_000) throw new JevError('INVALID_VALUE', 'Standard input exceeds the 1 MB limit.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === 'tui' || (!args.length && process.stdin.isTTY && process.stdout.isTTY)) {
    const { startInteractive } = await import('./interactive/index.js');
    await startInteractive(args.slice(1));
    return;
  }
  if (!args.length || args[0] === '--help' || args[0] === '-h') {
    process.stdout.write(help); return;
  }
  if (args[0] === '--version' || args[0] === '-V') { process.stdout.write('jev-browser 0.2.0\n'); return; }
  const parsed = parseArgs(args);
  if (parsed.help) { process.stdout.write(parsed.help); return; }
  if (parsed.name === 'close' && parsed.rest.some(arg => ['--help', '-h'].includes(arg))) {
    process.stdout.write(closeHelp); return;
  }
  if (parsed.name === 'auth' && await handleAuth(parsed.rest, parsed.json)) return;
  if (parsed.name === 'help' && parsed.rest[0] === 'auth') { await handleAuth(['--help'], parsed.json); return; }
  const showingHelp = !parsed.name || parsed.name === 'help' || parsed.rest.some(arg => ['--help', '-h'].includes(arg));
  if ((parsed.name === 'help' && !parsed.rest.length) || (parsed.name === 'act' && showingHelp)) {
    process.stdout.write(help); return;
  }
  if (!showingHelp && !parsed.options.confirm && !parsed.options.cancel) await ensureLogin(parsed.options.nonInteractive);
  if (parsed.name === 'upgrade') throw new JevError('UPGRADE_VIA_NPM', 'Update the package with npm install -g jev-browser-cli.');
  if (parsed.name === 'dashboard') throw new JevError('UNSUPPORTED_COMMAND', 'The dashboard is not included in this package.');
  const browser = new Browser(parsed.globals);
  if (showingHelp) {
    const result = await browser.run([parsed.name === 'help' || !parsed.name ? '--help' : parsed.name, ...parsed.rest]);
    const action = parsed.commandPath?.split(' ')[1];
    const nativeCommand = `${parsed.name}${action && parsed.rest[0] === action ? ` ${action}` : ''}`;
    const text = parsed.commandPath ? result.stdout.replaceAll(`agent-browser ${nativeCommand}`, `jev-browser ${parsed.commandPath}${parsed.sessionRequired ? ' <session name>' : ''}`) : result.stdout;
    process.stdout.write(text.replaceAll('agent-browser', 'jev-browser') + connectionHelp(parsed.commandPath?.split(' ')[0] ?? ''));
    process.stderr.write(result.stderr);
    process.exitCode = result.code;
    return;
  }
  await withSession(parsed.session, async () => {
    if (parsed.name === 'act') {
      if (parsed.options.valueStdin) parsed.options.value = await stdinValue();
      await runAct(parsed.options, browser, { session: parsed.session, json: parsed.json });
    } else {
      process.exitCode = await browser.passthrough([parsed.name === 'help' || !parsed.name ? '--help' : parsed.name, ...parsed.rest]);
    }
  });
}

main().catch(error => {
  const result = failure(error);
  if (process.argv.includes('--json')) process.stdout.write(JSON.stringify(result) + '\n');
  else process.stderr.write(`${result.error.code}: ${result.error.message}\n`);
  process.exitCode = result.error.code === 'EXECUTION_UNKNOWN' || result.error.dispatched ? 3 : 1;
});
