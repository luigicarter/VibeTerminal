#!/usr/bin/env node
'use strict';
// Provider startup probe.
//
// Opens one pane of every launchable PTY kind exactly the way the app opens it —
// the same shim directory, the same launch command from
// frontend/sessionLaunch.ts, the same ConPTY host — decodes it with
// backend/terminalObservation.cjs, and polls
// backend/orchestratorPromptReadiness.cjs the way
// orchestratorLaunchers.waitForNativePromptReady does. When the composer is
// ready it types one short line and confirms acceptance with the app's own
// composerAcceptedPrompt evidence.
//
// It exists because the Claude recognizer went stale against the shipped Claude
// Code layout and nothing in the repository noticed: every send to a Claude pane
// waited sixty seconds and then reported a launch timeout. A recognizer that is
// only checked against a recorded fixture can go stale the same way, so this
// probe checks them against the CLIs actually installed here.
//
//   node scripts/qa/provider-startup-probe.cjs [--only <kind,kind>] [--timeout 60]
//                                              [--no-type] [--save <dir>]
//                                              [--save-name <suffix>] [--cols 69] [--rows 10]
//
// --save writes each observed screen as a <kind>.bin / <kind>.json pair in the
// format scripts/backend/fixtures/provider-startup-screens uses, so a fixture
// can be re-recorded after a CLI upgrade.
//
// It costs one tiny model turn per kind that reaches its composer: the typed
// line is "Reply with exactly OK and nothing else." and nothing else is ever
// sent. Use --no-type to check readiness without spending anything.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const pty = require('node-pty');
const root = path.resolve(__dirname, '../..');
const { createTerminalObservation } = require(path.join(root, 'backend/terminalObservation.cjs'));
const { assessNativePromptReadiness, COMPOSER_FORMS } = require(path.join(root, 'backend/orchestratorPromptReadiness.cjs'));
const { composerAcceptedPrompt } = require(path.join(root, 'backend/orchestratorTasks.cjs'));
const { spawnPty, windowsPtyHostOptions } = require(path.join(root, 'backend/ptyHostOptions.cjs'));
const { createAgentTelemetryManager } = require(path.join(root, 'backend/agentTelemetry.cjs'));

const PROMPT = 'Reply with exactly OK and nothing else.';
// The pane size the probe opens at. The default is the size the fixtures in
// scripts/backend/fixtures/provider-startup-screens were recorded at; --cols and
// --rows record the same CLI at another size, which is how the small-tile
// captures (69x10, the board's own default tile) were taken. A recording made at
// one width cannot be replayed at another - the CLI's own cursor addressing is
// width-dependent - so a size that matters gets its own recording.
const DEFAULT_COLS = 100, DEFAULT_ROWS = 30;

const argv = process.argv.slice(2);
const flag = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const only = (flag('--only') || '').split(',').map(value => value.trim()).filter(Boolean);
const readyTimeoutMs = Number(flag('--timeout') || 60) * 1000;
const saveDir = flag('--save');
const saveName = flag('--save-name') || null;
const typePrompt = !argv.includes('--no-type');
const COLS = Number(flag('--cols') || DEFAULT_COLS);
const ROWS = Number(flag('--rows') || DEFAULT_ROWS);
if (!Number.isSafeInteger(COLS) || COLS < 20 || !Number.isSafeInteger(ROWS) || ROWS < 4) {
  throw new Error(`Unusable pane size ${COLS}x${ROWS}: at least 20x4 is required.`);
}

// Every launchable PTY kind, with the command the pane runs. `shim` is the shim
// the app puts on PATH; the arguments are the ones buildLaunchCommand produces
// for a fresh (non-resume) launch.
//
// A `codex` pane runs the bare `codex` from the user's PATH through that shim
// (frontend/sessionLaunch.ts). The bundled vendor/codex-bin is not what a pane
// runs: it backs Fusion, the model catalog and Codex Web.
const KINDS = [
  { kind: 'codex', shim: 'codex', args: [], note: 'bare `codex` from PATH; vendor/codex-bin backs Fusion and Codex Web only' },
  { kind: 'claude', shim: 'claude', args: [] },
  { kind: 'grok', shim: 'grok', args: [] },
  { kind: 'kimi', shim: 'kimi', args: [] },
  { kind: 'kimi-custom', shim: 'kimi-custom', args: [], note: 'bundled Kimi Code' },
  { kind: 'qwen', shim: 'qwen', args: [] },
  { kind: 'opencode', shim: 'opencode', args: ['--auto'] },
  { kind: 'gemini', shim: 'gemini', args: [] },
  { kind: 'cursor', shim: 'cursor-agent', args: [] },
  // Open Codex and Codex Web do not run from a PATH shim: the app launches its
  // own bundled runtime for each, and both need an account this machine has not
  // signed in to. Their composer form is inferred from the Codex TUI they run.
  { kind: 'open-codex', skip: 'not signed in here (its captured startup screen is "Finish signing in via your browser")' },
  { kind: 'codex-web', skip: 'needs a signed-in ChatGPT Codex session; its pane runs the bundled Codex TUI' },
];
// Kinds whose composer recognizer has a captured screen from this machine. The
// probe fails if one of these does not reach its composer.
const VERIFIED = new Set(['codex', 'claude', 'grok', 'kimi', 'kimi-custom', 'qwen', 'opencode']);

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const outDir = path.join(root, '.tmp', 'provider-startup-probe');
const workspace = path.join(outDir, 'workspace');
fs.mkdirSync(workspace, { recursive: true });
try { execFileSync('git', ['init', '--quiet', workspace], { timeout: 15000, stdio: 'ignore' }); } catch { /* a probe cwd without git still launches */ }
if (saveDir) fs.mkdirSync(saveDir, { recursive: true });

// The app's own environment for a pane, minus anything this harness inherited
// from the Claude Code session running it: a nested CLI must not be told it is
// already inside one.
// backend/main.cjs puts the vendored kimi-custom bin directory on the pane's
// PATH (after the shim dir) and on the shim runner's ORIGINAL_PATH, so the shim
// still wins resolution and the runner still finds the real launcher.
function withKimiCustomBundle(prepared) {
  const dir = path.join(root, 'vendor', 'kimi-custom');
  if (!fs.existsSync(path.join(dir, 'dist', 'main.mjs'))) return { prepared, missing: true };
  const bin = path.join(dir, 'bin');
  const key = Object.keys(prepared.env).find(name => name.toLowerCase() === 'path');
  if (!key) return { prepared, missing: false };
  const prefix = `${prepared.shimDir}${path.delimiter}`;
  const rest = prepared.env[key].startsWith(prefix) ? prepared.env[key].slice(prefix.length) : prepared.env[key];
  return { missing: false, prepared: { ...prepared, env: { ...prepared.env,
    [key]: `${prepared.shimDir}${path.delimiter}${bin}${path.delimiter}${rest}`,
    VIBE_TERMINAL_ORIGINAL_PATH: `${bin}${path.delimiter}${prepared.env.VIBE_TERMINAL_ORIGINAL_PATH || ''}` } } };
}

function paneEnv(prepared) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID|CLAUDE_EFFORT|VIBE_TERMINAL_|LINA_)/.test(key)) continue;
    env[key] = value;
  }
  return { ...env, ...prepared.env, TERM: 'xterm-256color' };
}

function cliVersion(shimPath, env) {
  for (const args of [['--version'], ['-v']]) {
    try {
      const out = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', shimPath, ...args],
        { encoding: 'utf8', timeout: 20000, env, cwd: workspace, windowsHide: true });
      const line = String(out).split('\n').map(value => value.trim()).filter(Boolean).at(-1);
      if (line) return line.slice(0, 40);
    } catch { /* not every CLI answers --version; the screen still identifies it */ }
  }
  return 'unknown';
}

async function probe(entry, manager) {
  const row = { kind: entry.kind, version: '-', verdict: '-', seconds: '-', typed: 'no', accepted: 'no', notes: entry.note || '' };
  if (entry.skip) { row.verdict = `skipped:${entry.skip}`; return row; }

  let prepared = await manager.prepareSession(`probe-${entry.kind}`, { provider: entry.shim, generation: 'probe' });
  if (entry.kind === 'kimi-custom') {
    const bundled = withKimiCustomBundle(prepared);
    if (bundled.missing) { row.verdict = 'skipped:vendor/kimi-custom is not built in this checkout'; return row; }
    prepared = bundled.prepared;
  }
  const shimPath = path.join(prepared.shimDir, `${entry.shim}.ps1`);
  if (!fs.existsSync(shimPath)) { row.verdict = `skipped:no launcher shim for ${entry.shim}`; return row; }
  const env = paneEnv(prepared);
  row.version = cliVersion(shimPath, env);
  if (row.version === 'unknown' && entry.kind === 'gemini') {
    row.verdict = 'skipped:Gemini CLI is not installed on this machine';
    return row;
  }

  const id = `probe-${entry.kind}`, generation = 'probe-generation';
  const decoder = createTerminalObservation();
  await decoder.ingest({ type: 'created', id, generation, cols: COLS, rows: ROWS, inputRevision: 0 });
  const raw = [];
  let sequence = 0, exited = false, exitEvent;
  const spawned = spawnPty(pty, 'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', shimPath, ...entry.args],
    { cols: COLS, rows: ROWS, cwd: workspace, env, name: 'xterm-256color' }, windowsPtyHostOptions());
  const terminal = spawned.terminal;
  if (spawned.fallbackError) row.notes = [row.notes, 'bundled ConPTY unavailable; used the inbox host'].filter(Boolean).join('; ');
  terminal.onData(data => { raw.push(data); void decoder.ingest({ type: 'data', id, generation, sequence: ++sequence, data }); });
  terminal.onExit(event => { exited = true; exitEvent = event; });

  const session = { id, generation, provider: entry.kind, kind: entry.kind, started: true, processState: 'running',
    launchState: 'ready', agentProcessState: 'running', agentPid: terminal.pid, turnState: 'unknown' };
  const startedAt = Date.now();
  let readiness, observation, answeredTrust = false, dismissedUpdate = false, trustMoves = 0, screens = new Set();
  const clearedScreens = new Set();
  let signIn = false;
  const probeOnly = [];

  // Exactly the loop waitForNativePromptReady runs: poll the decoded screen,
  // answer only a folder-trust prompt whose affirmative option is already the
  // highlighted default, and never type anything until the composer is ready.
  while (Date.now() - startedAt < readyTimeoutMs) {
    observation = await decoder.read({ id, generation });
    readiness = assessNativePromptReadiness(session, observation);
    if (readiness.status === 'transient') {
      screens.add(readiness.prompt);
      // A pane parked on a login screen cannot be probed at all, and waiting out
      // the deadline proves nothing. Report it and move on.
      if (readiness.prompt === 'sign-in') { signIn = true; break; }
      if (!answeredTrust && readiness.prompt === 'folder-trust' && readiness.affirmativeDefault === true) {
        answeredTrust = true;
        terminal.write('\r');
        await wait(1200);
        continue;
      }
      // Everything below is the probe getting itself past a screen the app
      // deliberately leaves alone, so that the composer behind it can still be
      // checked. The app reports these and waits; it never answers them.
      if (!answeredTrust && readiness.prompt === 'folder-trust' && /Yes, I trust this folder/.test(observation.text)) {
        // Move onto the affirmative row and confirm only once the screen shows
        // the pointer resting there. Confirming blind on a two-item list that
        // wraps is how this probe answered "No, exit" and killed the pane.
        if (/^[^\S\n]*[\u276f>\u203a*][^\S\n]*Yes, I trust this folder/m.test(observation.text)) {
          answeredTrust = true;
          probeOnly.push('chose "Yes, I trust this folder" (the app never answers a trust screen whose affirmative option is not the highlighted default)');
          terminal.write('\r');
          await wait(1500);
        } else if (trustMoves++ < 4) {
          terminal.write('\x1b[B');
          await wait(600);
        }
        continue;
      }
      // Claude asks about CLAUDE.md imports from outside the pane's folder in
      // every Lina project with a shared guide. Its highlighted default is the
      // conservative "No, disable external imports", so the probe confirms that.
      if (!clearedScreens.has('external-imports') && readiness.prompt === 'external-imports') {
        clearedScreens.add('external-imports');
        probeOnly.push('confirmed the highlighted "No, disable external imports" default');
        terminal.write('\r');
        await wait(1500);
        continue;
      }
      if (!clearedScreens.has('startup-hooks') && readiness.prompt === 'startup-hooks') {
        clearedScreens.add('startup-hooks');
        probeOnly.push('accepted the generated startup hooks');
        terminal.write('\x1b[B'); await wait(400); terminal.write('\r');
        await wait(1500);
        continue;
      }
      if (!dismissedUpdate && readiness.prompt === 'update-offer') {
        dismissedUpdate = true;
        probeOnly.push('dismissed the update offer with Escape (the app reports it and waits)');
        terminal.write('\x1b');
        await wait(1200);
        continue;
      }
    }
    if (readiness.ready || readiness.status === 'unsupported') break;
    if (exited) break;
    await wait(100);
  }
  row.seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  row.verdict = signIn ? `skipped:not signed in here (${readiness.detail})`
    : exited && !readiness?.ready ? `exited:${exitEvent?.exitCode}`
    : readiness?.ready ? 'ready'
    : readiness?.status === 'transient' ? `transient:${readiness.prompt}`
    : readiness?.status === 'unsupported' ? 'unsupported' : `not-ready:${readiness?.status || 'none'}`;
  if (answeredTrust && !probeOnly.length) row.notes = [row.notes, 'answered the folder trust prompt'].filter(Boolean).join('; ');
  for (const note of probeOnly) row.notes = [row.notes, `probe-only: ${note}`].filter(Boolean).join('; ');
  if (screens.size) row.notes = [row.notes, `startup screens: ${[...screens].join(', ')}`].filter(Boolean).join('; ');

  if (typePrompt && (readiness?.ready || readiness?.status === 'unsupported') && !exited) {
    const before = String(observation?.text ?? '');
    const probeText = PROMPT.replace(/\s+/g, '');
    // The composer still holds the prompt while it is only typed, not sent.
    const composerHolds = view => {
      const lines = String(view.text ?? '').split('\n');
      const y = Number.isSafeInteger(view.cursor?.y) ? view.cursor.y : lines.length - 1;
      return lines.slice(Math.max(0, y - 8), y + 1).join('').replace(/\s+/g, '').includes(probeText);
    };
    terminal.write(PROMPT);
    await wait(400);
    terminal.write('\r');
    row.typed = 'yes';
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      await wait(120);
      const after = await decoder.read({ id, generation });
      // The app's own in-flight evidence first; otherwise the same two facts it
      // rests on - the prompt is no longer in the composer and the pane has
      // drawn something new since it was sitting empty and ready.
      if (composerAcceptedPrompt(session, after, PROMPT)) { row.accepted = 'composer'; break; }
      // Otherwise the two facts that evidence rests on: the composer is sitting
      // empty and ready again (so the line is no longer in it) and the pane has
      // drawn something it had not drawn when it was waiting for input. A line
      // still sitting unsent in the composer moves the cursor, so it can never
      // read as ready here.
      const changed = String(after.text ?? '') !== before;
      const emptyAgain = assessNativePromptReadiness(session, after).ready === true;
      if (changed && (emptyAgain || !composerHolds(after) && readiness.status === 'unsupported')) { row.accepted = 'screen-change'; break; }
      if (exited) break;
    }
    observation = await decoder.read({ id, generation });
  }

  fs.writeFileSync(path.join(outDir, `${entry.kind}.screen.txt`), String(observation?.text ?? ''));
  fs.writeFileSync(path.join(outDir, `${entry.kind}.raw.bin`), Buffer.from(raw.join(''), 'utf8'));
  if (saveDir && readiness?.ready) {
    const base = saveName ? `${entry.kind}${saveName}` : entry.kind;
    fs.writeFileSync(path.join(saveDir, `${base}.bin`), Buffer.from(raw.join(''), 'utf8'));
    fs.writeFileSync(path.join(saveDir, `${base}.json`), JSON.stringify({ kind: entry.kind, cols: COLS, rows: ROWS,
      observation: { ok: true, id: 'pane', generation: 'g1', exited: false, sequence: observation.sequence,
        inputRevision: observation.inputRevision, text: observation.text, cols: observation.cols, rows: observation.rows,
        cursor: observation.cursor, cursorVisible: observation.cursorVisible, alternateScreen: observation.alternateScreen,
        screenTruncated: observation.screenTruncated }, readiness }, null, 1) + '\n');
  }

  // Leave nothing running: escape any menu, interrupt twice, then close.
  try {
    terminal.write('\x1b'); await wait(200);
    terminal.write('\x03'); await wait(300);
    terminal.write('\x03'); await wait(300);
    if (!exited) terminal.kill();
  } catch { /* a probe that cannot close a pane still reports its row */ }
  decoder.dispose();
  await wait(300);
  return row;
}

(async () => {
  const manager = createAgentTelemetryManager({ baseDir: path.join(outDir, 'shims'), openCodeHome: path.join(outDir, 'opencode'), emit: () => {} });
  const rows = [];
  try {
    for (const entry of KINDS) {
      if (only.length && !only.includes(entry.kind)) continue;
      let row;
      try { row = await probe(entry, manager); }
      catch (error) { row = { kind: entry.kind, version: '-', verdict: `error:${String(error?.message || error).slice(0, 60)}`, seconds: '-', typed: 'no', accepted: 'no', notes: '' }; }
      rows.push(row);
      console.log(`  ... ${row.kind}: ${row.verdict}`);
    }
  } finally { try { manager.cleanup(); } catch { /* the report matters more than the cleanup */ } }

  const columns = ['kind', 'version', 'verdict', 'seconds', 'typed', 'accepted', 'notes'];
  const header = { kind: 'KIND', version: 'CLI VERSION', verdict: 'VERDICT', seconds: 'SECS', typed: 'TYPED', accepted: 'ACCEPTED', notes: 'NOTES' };
  const width = key => Math.max(...[header, ...rows].map(row => String(row[key] ?? '').length));
  const line = row => columns.map(key => String(row[key] ?? '').padEnd(key === 'notes' ? 0 : width(key))).join('  ').trimEnd();
  console.log(`\nProvider startup probe — ${os.platform()} ${os.release()}, cwd ${workspace}`);
  console.log(line(header));
  console.log(columns.map(key => '-'.repeat(key === 'notes' ? Math.max(5, width(key)) : width(key))).join('  '));
  for (const row of rows) console.log(line(row));
  console.log(`\nScreens and raw recordings: ${outDir}`);

  const failed = rows.filter(row => VERIFIED.has(row.kind) && row.verdict !== 'ready');
  if (failed.length) {
    console.error(`\nFAILED: ${failed.map(row => `${row.kind} (${row.verdict})`).join(', ')}`);
    process.exitCode = 1;
  } else console.log('\nEvery kind with a verified composer recognizer reached its composer.');
  // The telemetry manager's callback server keeps the event loop alive.
  process.exit(process.exitCode || 0);
})().catch(error => { console.error(error); process.exit(1); });
