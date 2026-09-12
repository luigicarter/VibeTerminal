'use strict';
// Windows-only acceptance for the pseudo-console host Lina's panes run on.
//
// Drives the REAL backend/ptyHost.cjs child over its JSON-line protocol and
// proves, from the live process tree, that:
//   a. a default pane is hosted by node-pty's bundled OpenConsole.exe, with no
//      conhost.exe pane host,
//   b. input still round-trips,
//   c. a natural `exit` leaves no console host behind (the inbox conhost leaks
//      one per exited pane for the life of the host process),
//   d. `kill` terminates the pane and its foreground child and leaves no
//      console host behind,
//   e. LINA_CONPTY_HOST=system still gets the inbox conhost (escape hatch).
//
// See docs/codex-cursor-flicker-2026-09-11.md.

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

if (process.platform !== 'win32') {
  console.log('skipped: Windows only');
  process.exit(0);
}

const DESKTOP_ROOT = path.resolve(__dirname, '../..');
const PTY_HOST = path.join(DESKTOP_ROOT, 'backend', 'ptyHost.cjs');
const WORKSPACE = path.join(DESKTOP_ROOT, '.tmp', `conpty-host-smoke-${process.pid}`);

const summary = [];
const cleanups = [];

function fail(message) {
  const error = new Error(message);
  error.assertion = true;
  throw error;
}

function assert(condition, message) {
  if (!condition) fail(message);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function powershell(script) {
  return execFileSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 }
  ).trim();
}

function queryProcesses(script) {
  const output = powershell(`${script} | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress -Depth 3`);
  if (!output) return [];
  const parsed = JSON.parse(output);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function childProcesses(pid) {
  return queryProcesses(`Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}"`);
}

// The pane's pseudo-console host, as node-pty spawns it: `--headless ... --server <handle>`.
// The ptyHost's own console (`conhost.exe 0x4`) has neither switch and is not a pane host.
function consoleHosts(pid) {
  return childProcesses(pid).filter((row) => {
    const line = String(row.CommandLine || '');
    return line.includes('--headless') && line.includes('--server');
  });
}

function taggedProcesses(tag) {
  return queryProcesses(
    `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*${tag}*' }`
  );
}

function processAlive(pid) {
  return queryProcesses(`Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"`).length > 0;
}

async function waitFor(label, timeoutMs, probe) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = probe();
    if (last.ok) return last;
    if (Date.now() >= deadline) fail(`${label}: timed out after ${timeoutMs}ms (last: ${last.detail})`);
    await sleep(400);
  }
}

function startHost(mode) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  if (mode === 'system') env.LINA_CONPTY_HOST = 'system';
  else delete env.LINA_CONPTY_HOST;

  const child = spawn(process.execPath, [PTY_HOST], {
    cwd: DESKTOP_ROOT,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });

  const host = { child, events: [], stderr: '', mode };
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      try {
        host.events.push(JSON.parse(line));
      } catch {
        host.stderr += `unparsable host line: ${line.slice(0, 200)}\n`;
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { host.stderr += chunk; });

  host.send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  host.data = () => host.events.filter((event) => event.type === 'data').map((event) => event.data).join('');
  host.waitEvent = (label, timeoutMs, predicate) =>
    waitFor(label, timeoutMs, () => {
      const match = host.events.find(predicate);
      return match
        ? { ok: true, event: match }
        : { ok: false, detail: `seen ${JSON.stringify(host.events.map((event) => event.type))}${host.stderr ? ` stderr=${host.stderr.trim()}` : ''}` };
    });

  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      try { host.send({ type: 'shutdown' }); } catch { /* already gone */ }
      await sleep(600);
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
  });
  return host;
}

async function shutdown(host) {
  host.send({ type: 'shutdown' });
  await waitFor('ptyHost shutdown', 6000, () =>
    host.child.exitCode !== null || host.child.signalCode !== null
      ? { ok: true }
      : { ok: false, detail: 'still running' });
}

async function createPane(host, id, extra = {}) {
  host.send({
    type: 'create',
    payload: { id, generation: `${id}-gen`, launchToken: 1, cwd: WORKSPACE, cols: 100, rows: 30, ...extra }
  });
  const { event } = await host.waitEvent(`created(${id})`, 15000, (e) => e.type === 'created' && e.id === id);
  return event;
}

async function run() {
  fs.mkdirSync(WORKSPACE, { recursive: true });
  cleanups.push(async () => { fs.rmSync(WORKSPACE, { recursive: true, force: true }); });

  // ---- a. default pane is hosted by the bundled OpenConsole -----------------
  const host = startHost('default');
  await host.waitEvent('host ready', 10000, (e) => e.type === 'ready');
  const created = await createPane(host, 'pane-a');
  assert(created.cols === 100 && created.rows === 30, `created reported ${created.cols}x${created.rows}, expected 100x30`);

  const hosted = await waitFor('bundled console host appears', 5000, () => {
    const hosts = consoleHosts(host.child.pid);
    return hosts.length === 1
      ? { ok: true, hosts }
      : { ok: false, detail: JSON.stringify(hosts.map((row) => row.Name)) };
  });
  const paneHost = hosted.hosts[0];
  assert(paneHost.Name === 'OpenConsole.exe',
    `expected OpenConsole.exe as the pane host, got ${paneHost.Name} (${paneHost.CommandLine})`);
  assert(String(paneHost.CommandLine).includes('node-pty'),
    `pane host is not node-pty's bundled copy: ${paneHost.CommandLine}`);
  assert(consoleHosts(host.child.pid).every((row) => row.Name !== 'conhost.exe'),
    'an inbox conhost.exe pane host is present alongside OpenConsole.exe');
  summary.push(`  a. default pane host   ${paneHost.Name} pid=${paneHost.ProcessId} (conhost.exe pane hosts: 0)`);

  // ---- b. input round-trips ------------------------------------------------
  const startedAt = Date.now();
  host.send({ type: 'input', payload: { id: 'pane-a', generation: 'pane-a-gen', data: "Write-Output ('RT:'+'OK')\r" } });
  await waitFor('round-trip output', 8000, () =>
    host.data().includes('RT:OK') ? { ok: true } : { ok: false, detail: `${host.data().length} bytes of output` });
  summary.push(`  b. round-trip          RT:OK after ${Date.now() - startedAt}ms`);

  // ---- c. natural exit leaves no console host ------------------------------
  host.send({ type: 'input', payload: { id: 'pane-a', generation: 'pane-a-gen', data: 'exit\r' } });
  const { event: exitEvent } = await host.waitEvent('pane exit', 10000, (e) => e.type === 'exit' && e.id === 'pane-a');
  assert(exitEvent.exitCode === 0, `natural exit reported exitCode ${exitEvent.exitCode}, expected 0`);
  await sleep(1500);
  const leaked = consoleHosts(host.child.pid);
  assert(leaked.length === 0,
    `natural exit left ${leaked.length} console host(s): ${JSON.stringify(leaked.map((row) => `${row.Name}#${row.ProcessId}`))}`);
  summary.push(`  c. natural exit        exitCode=0, console hosts left behind: 0`);

  // ---- d. kill terminates the pane and its foreground child ----------------
  const tag = `linaconptyprobe${Date.now()}`;
  const secondPane = await createPane(host, 'pane-b');
  cleanups.push(async () => {
    for (const row of taggedProcesses(tag)) { try { process.kill(row.ProcessId); } catch { /* already gone */ } }
  });
  host.send({
    type: 'input',
    payload: { id: 'pane-b', generation: 'pane-b-gen', data: `node -e "setInterval(()=>{},1000)" ${tag}\r` }
  });
  // PowerShell and node start slowly under load: poll for the child instead of
  // sleeping a fixed span, so a busy machine cannot fail this on timing alone.
  await waitFor('tagged foreground child starts', 15000, () => {
    const started = taggedProcesses(tag);
    return started.length === 1 ? { ok: true } : { ok: false, detail: `${started.length} tagged node.exe` };
  });
  const running = taggedProcesses(tag);
  assert(running.length === 1, `expected exactly one tagged foreground child, found ${running.length}`);

  const eventsBeforeKill = host.events.length;
  host.send({ type: 'kill', payload: { id: 'pane-b', generation: 'pane-b-gen' } });
  await waitFor('killed pane shell exits', 5000, () =>
    processAlive(secondPane.pid) ? { ok: false, detail: `shell pid ${secondPane.pid} alive` } : { ok: true });
  await waitFor('killed foreground child exits', 5000, () => {
    const left = taggedProcesses(tag);
    return left.length === 0 ? { ok: true } : { ok: false, detail: `${left.length} tagged process(es) alive` };
  });
  // `kill` detaches the session's listeners before node-pty's onExit fires, so the
  // host deliberately emits no `exit` event for an explicit kill. Pin that shape.
  const afterKill = host.events.slice(eventsBeforeKill).filter((event) => event.type === 'exit' && event.id === 'pane-b');
  assert(afterKill.length === 0, `explicit kill emitted an unexpected exit event: ${JSON.stringify(afterKill)}`);
  const leakedAfterKill = consoleHosts(host.child.pid);
  assert(leakedAfterKill.length === 0,
    `kill left ${leakedAfterKill.length} console host(s): ${JSON.stringify(leakedAfterKill.map((row) => `${row.Name}#${row.ProcessId}`))}`);
  summary.push(`  d. kill                shell pid ${secondPane.pid} and tagged child gone, console hosts left behind: 0`);
  await shutdown(host);

  // ---- e. escape hatch restores the inbox conhost --------------------------
  const legacy = startHost('system');
  await legacy.waitEvent('legacy host ready', 10000, (e) => e.type === 'ready');
  await createPane(legacy, 'pane-c');
  const legacyHosted = await waitFor('inbox console host appears', 5000, () => {
    const hosts = consoleHosts(legacy.child.pid);
    return hosts.length === 1
      ? { ok: true, hosts }
      : { ok: false, detail: JSON.stringify(hosts.map((row) => row.Name)) };
  });
  const legacyHost = legacyHosted.hosts[0];
  assert(legacyHost.Name === 'conhost.exe',
    `LINA_CONPTY_HOST=system should use the inbox conhost.exe, got ${legacyHost.Name} (${legacyHost.CommandLine})`);
  summary.push(`  e. LINA_CONPTY_HOST=system  ${legacyHost.Name} pid=${legacyHost.ProcessId}`);
  legacy.send({ type: 'kill', payload: { id: 'pane-c', generation: 'pane-c-gen' } });
  await sleep(1000);
  await shutdown(legacy);
}

(async () => {
  let failure = null;
  try {
    await run();
  } catch (error) {
    failure = error;
  }
  for (const cleanup of cleanups.reverse()) {
    try { await cleanup(); } catch { /* best effort */ }
  }
  if (failure) {
    console.error(`conpty-host smoke FAILED: ${failure.message}`);
    if (!failure.assertion) console.error(failure.stack);
    process.exit(1);
  }
  console.log('conpty-host smoke: PASS');
  for (const line of summary) console.log(line);
})();
