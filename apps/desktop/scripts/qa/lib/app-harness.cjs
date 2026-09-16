'use strict';
// Drive the REAL Lina Terminal app from a QA script, on a scratch profile.
//
// Every Electron smoke in scripts/qa inlines its own copy of this: a free port,
// a spawn with VIBE_SCREENSHOT_* set, a WebSocket to the CDP page, a poll loop.
// This is that code in one place, plus the parts a graded harness needs and a
// one-off smoke does not: a profile seeded with the installed Brain key, panes
// whose provider CLIs are pointed at a local stub, and readers for every piece
// of evidence the app writes down (state, receipts, ledger, memory, the
// diagnostics log).
//
// Two isolation rules hold for every run:
//   * userData, documents, the agent shim dir, HOME/USERPROFILE and both CLI
//     homes are inside the run directory, so nothing touches the user's profile
//     or their real ~/.codex and ~/.claude. Discovery follows the same two
//     variables the CLIs do (backend/agentThreads.cjs:188, agentThreadHost.cjs:162),
//     so the app looks for conversations in the scratch homes as well.
//   * PATH is rebuilt from a short allowlist. backend/cliProbe.cjs decides which
//     launchers exist by scanning PATH, so a provider whose CLI is not on the
//     harness PATH cannot be advertised to the Brain, offered as a launcher, or
//     spawned — which is how the kinds that write to the user's real CLI homes
//     (gemini, qwen, grok, cursor, kimi, opencode) are kept out of a run.
//
// The Brain is real: the installed OpenRouter key is decrypted by the app's own
// safeStorage from an os_crypt section copied into the scratch profile before
// launch (the ordering at scripts/qa/orchestrator-fidelity-live.cjs:208 is
// load-bearing — safeStorage reads it at startup). The key is never printed,
// logged, or written anywhere but the scratch settings file, still encrypted.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '../../..');
const INSTALLED_PROFILE = path.join(process.env.APPDATA || os.homedir(), 'vibe-terminal');
// Providers whose CLI may run in a harness. Everything else is left off PATH.
const ALLOWED_CLIS = Object.freeze(['codex', 'claude']);
// git is on PATH for Claude Code's sake: on Windows it runs its hook commands
// through Git Bash, found next to git, and a PATH without it fires no hook at
// all, so the app never hears a Claude turn start or finish. It is not a
// launcher, so the app is not asked whether it can see it.
const PATH_HELPERS = Object.freeze(['git']);

// Outside the repo (see createAppHarness) and outside the system temp folder,
// which Codex refuses to create its PATH helpers under.
const defaultProfileRoot = runId => path.join(process.env.LOCALAPPDATA || os.homedir(), 'lina-terminal-harness', runId);

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, ms = 20000, pollMs = 100) {
  const end = Date.now() + ms;
  let error;
  while (Date.now() < end) {
    try { const value = await fn(); if (value) return value; } catch (caught) { error = caught; }
    await wait(pollMs);
  }
  throw new Error(`Timeout: ${label}${error ? ` (${error.message})` : ''}`);
}
const freePort = () => new Promise(resolve => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
});

class Cdp {
  constructor(url) { this.ws = new WebSocket(url); this.pending = new Map(); this.n = 0; }
  async open() {
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', event => {
      const payload = JSON.parse(String(event.data));
      if (!payload.id) return;
      const request = this.pending.get(payload.id);
      if (!request) return;
      this.pending.delete(payload.id);
      payload.error ? request.reject(new Error(payload.error.message)) : request.resolve(payload.result);
    });
    this.ws.addEventListener('close', () => {
      for (const request of this.pending.values()) request.reject(new Error('The renderer connection closed.'));
      this.pending.clear();
    });
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.n;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression, timeoutMs = 120000) {
    const result = await Promise.race([
      this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
      wait(timeoutMs).then(() => { throw new Error(`Renderer evaluation exceeded ${timeoutMs} ms`); }),
    ]);
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 2000));
    return result.result.value;
  }
  close() { try { this.ws.close(); } catch { /* already gone */ } }
}

// A PATH with the system directories plus exactly the CLIs a harness may run.
// Resolved from the REAL environment before the scratch HOME is applied, so the
// binaries are found where the user actually installed them.
function harnessPath(extraDirectories = []) {
  const system = process.platform === 'win32'
    ? [path.join(process.env.SystemRoot || 'C:/Windows', 'system32'), process.env.SystemRoot || 'C:/Windows',
       path.join(process.env.SystemRoot || 'C:/Windows', 'system32', 'Wbem'),
       path.join(process.env.SystemRoot || 'C:/Windows', 'system32', 'WindowsPowerShell', 'v1.0')]
    : ['/usr/bin', '/bin', '/usr/local/bin'];
  const directories = [...system, path.dirname(process.execPath), ...extraDirectories];
  for (const cli of [...ALLOWED_CLIS, ...PATH_HELPERS]) {
    const found = whichDirectory(cli);
    if (found) directories.push(found);
  }
  return [...new Set(directories.filter(Boolean))].join(path.delimiter);
}
function whichDirectory(command) {
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', '.ps1', ''] : [''];
  for (const directory of String(process.env.PATH || '').split(path.delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      try { if (fs.statSync(path.join(directory, command + extension)).isFile()) return directory; } catch { /* next */ }
    }
  }
  return null;
}

// Everything the scratch profile needs on disk BEFORE Electron starts.
function seedProfile({ userData, model, spendingLimit, installedProfile, providers, sessionKey }) {
  fs.mkdirSync(userData, { recursive: true });
  // safeStorage takes its os_crypt from userData at startup: a key copied in
  // afterwards cannot be decrypted, and the account reads as unconfigured.
  const localState = path.join(installedProfile, 'Local State');
  let osCryptCopied = false;
  if (fs.existsSync(localState)) {
    const { os_crypt } = JSON.parse(fs.readFileSync(localState, 'utf8'));
    if (os_crypt) { fs.writeFileSync(path.join(userData, 'Local State'), JSON.stringify({ os_crypt })); osCryptCopied = true; }
  }
  const installedSettings = path.join(installedProfile, 'orchestrator-settings.json');
  let encryptedKey = '';
  // A run pointed at a local brain gets a session-only key instead: the installed
  // OpenRouter credential has no business reaching a server on this machine.
  if (!sessionKey && fs.existsSync(installedSettings)) encryptedKey = JSON.parse(fs.readFileSync(installedSettings, 'utf8')).encryptedKey || '';
  // No warm spare pane: a scenario describes its workspace exactly, and a pane
  // the app adds on its own is one the grader cannot name.
  const settings = { settings: { model, enabledOnLaunch: true, spareAgent: false, handsFreeEnabled: false,
    monitoringEnabled: false, spendingLimit }, preferences: [], encryptedKey };
  fs.writeFileSync(path.join(userData, 'orchestrator-settings.json'), JSON.stringify(settings, null, 2), { mode: 0o600 });
  if (providers) fs.writeFileSync(path.join(userData, 'model-providers.json'), JSON.stringify(providers, null, 2), { mode: 0o600 });
  // Turning the relay on validates the voice models too, and that path asks for
  // microphone consent first (backend/microphonePermission.cjs). Without a
  // foreground window there is nobody to ask, so setEnabled fails
  // 'permission-required' and no request can ever be submitted. The consent this
  // records belongs to the scratch profile and nothing else: the harness holds
  // the microphone open never, records nothing, and the user's own consent file
  // is only ever read for its os_crypt-independent shape.
  fs.writeFileSync(path.join(userData, 'microphone-consent.json'), `${JSON.stringify({ version: 1, granted: true })}\n`, { mode: 0o600 });
  return { osCryptCopied, hasEncryptedKey: Boolean(encryptedKey) };
}

// A Codex home whose only provider is the stub, and a Claude home that has
// already been onboarded. Both are inside the run directory.
//
// `default_mode_request_user_input` is the one non-obvious line. Codex 0.154
// gates its `request_user_input` tool on the collaboration mode, and in the
// TUI's default mode the call comes straight back to the model as "unavailable"
// instead of drawing a question — so without this feature a stub can put a codex
// pane into working or done, but never into needs-input. With it on, the same
// call paints the real question screen the app then has to recognise. (Verified
// on 0.154.0: codex-rs/tools/src/tool_config.rs:38 and features/src/lib.rs:1212.)
function seedCliHomes({ codexHome, claudeHome, stubBaseUrl, codexModel, sandboxMode = 'read-only' }) {
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'config.toml'),
    `model = "${codexModel}"\nmodel_provider = "stub"\nsandbox_mode = "${sandboxMode}"\n`
    + 'suppress_unstable_features_warning = true\n'
    + `[model_providers.stub]\nname = "Stub"\nbase_url = "${stubBaseUrl}"\nwire_api = "responses"\n`
    + 'requires_openai_auth = false\nrequest_max_retries = 0\nstream_max_retries = 0\n'
    + '[features]\ndefault_mode_request_user_input = true\n');
  fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'stub-key' }), { mode: 0o600 });
  fs.mkdirSync(claudeHome, { recursive: true });
  writeClaudeConfig(claudeHome, []);
  fs.writeFileSync(path.join(claudeHome, 'settings.json'), JSON.stringify({ includeCoAuthoredBy: false }));
}

// Codex asks the same folder-trust question, and records the answer in its own
// config. The app WILL answer that one for a registered project, but only while
// it is delivering a startup prompt — a pane opened with no prompt sits on the
// screen. A harness that needs a pane at its composer records the trust the way
// `codex` itself does (config/mod.rs:2054).
function trustCodexProject(codexHome, cwd) {
  const file = path.join(codexHome, 'config.toml');
  const section = `\n[projects.'${String(cwd).replace(/'/g, "''")}']\ntrust_level = "trusted"\n`;
  const existing = fs.readFileSync(file, 'utf8');
  if (!existing.includes(section)) fs.appendFileSync(file, section);
}

// Claude Code's folder-trust screen rests its pointer on "No, exit", so the app
// deliberately never answers it (backend/orchestratorPromptReadiness.cjs:50) and
// a claude pane in a fresh folder would sit on it forever. Trust is recorded per
// project in the config file, so the harness records it for the folders it made
// itself — the same decision a person makes once, not a screen answered blind.
function writeClaudeConfig(claudeHome, projectPaths) {
  const file = path.join(claudeHome, '.claude.json');
  let data = { hasCompletedOnboarding: true, projects: {} };
  try { data = { ...data, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* first write */ }
  data.projects ||= {};
  for (const cwd of projectPaths) {
    data.projects[String(cwd).replace(/\\/g, '/')] = { allowedTools: [], hasTrustDialogAccepted: true,
      hasClaudeMdExternalIncludesApproved: true, hasClaudeMdExternalIncludesWarningShown: true };
  }
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

/**
 * Launch the real app on a scratch profile and return a driver for it.
 *
 * `runRoot` holds the run's evidence and lives in the repo's .tmp. `profileRoot`
 * holds the scratch profile and deliberately does NOT: Claude Code walks up from
 * a pane's folder looking for a project CLAUDE.md, and this repo's imports an
 * outside file, which parks every claude pane on an "Allow external CLAUDE.md
 * file imports?" screen the app is right to refuse to answer. A profile outside
 * any checkout has no such ancestor.
 *
 * @param {{ runRoot: string, profileRoot?: string, model: string, budget: number, stubBaseUrl: string,
 *           codexModel?: string, claudeModel?: string, hidden?: boolean,
 *           installedProfile?: string, launchTimeoutMs?: number, extraEnv?: object }} options
 */
async function createAppHarness(options) {
  const { runRoot, model, budget, stubBaseUrl } = options;
  const profileRoot = options.profileRoot || defaultProfileRoot(path.basename(runRoot));
  const userData = path.join(profileRoot, 'userData');
  const documents = path.join(userData, 'Documents');
  const home = path.join(profileRoot, 'home');
  const codexHome = path.join(home, '.codex');
  const claudeHome = path.join(home, '.claude');
  const codexModel = options.codexModel || 'stub-standard';
  const claudeModel = options.claudeModel || 'stub-standard';
  fs.mkdirSync(documents, { recursive: true });
  // Chromium resolves its roaming-data directory from the user profile, so a
  // scratch HOME without an AppData tree fails Electron's very first
  // app.getPath('userData') (verified: "Failed to get 'userData' path"). Build
  // the tree, and point APPDATA/LOCALAPPDATA at it as well, so anything that
  // reads %APPDATA% writes into the scratch profile too.
  const appData = path.join(home, 'AppData', 'Roaming');
  const localAppData = path.join(home, 'AppData', 'Local');
  for (const directory of [appData, localAppData, path.join(home, 'AppData', 'LocalLow')]) fs.mkdirSync(directory, { recursive: true });
  const seeded = seedProfile({ userData, model, spendingLimit: budget, sessionKey: options.sessionKey,
    installedProfile: options.installedProfile || INSTALLED_PROFILE, providers: options.providers });
  seedCliHomes({ codexHome, claudeHome, stubBaseUrl, codexModel, sandboxMode: options.sandboxMode });

  const port = await freePort();
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/API_KEY|AUTH_TOKEN|ANTHROPIC_|OPENAI_|CODEX_|CLAUDE_/i.test(key)) delete env[key];
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VITE_DEV_SERVER_URL;
  Object.assign(env, {
    VIBE_SCREENSHOT_MODE: '1', VIBE_INTERNAL_SCREENSHOT: '0', VIBE_SCREENSHOT_USER_DATA: userData,
    ...(options.hidden === false ? {} : { VIBE_SCREENSHOT_HIDDEN: '1' }),
    VIBE_AGENT_SHIM_BASE_DIR: path.join(profileRoot, 'shims'),
    HOME: home, USERPROFILE: home, APPDATA: appData, LOCALAPPDATA: localAppData,
    XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data'),
    CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeHome,
    ANTHROPIC_BASE_URL: stubBaseUrl.replace(/\/v1$/, ''), ANTHROPIC_AUTH_TOKEN: 'stub-token',
    ANTHROPIC_MODEL: claudeModel, ANTHROPIC_SMALL_FAST_MODEL: claudeModel, ANTHROPIC_DEFAULT_HAIKU_MODEL: claudeModel,
    DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: '1',
    PATH: harnessPath(options.pathDirectories), Path: undefined,
    ...(options.extraEnv || {}),
  });
  delete env.Path; // Windows PATH is case-insensitive; one spelling only.

  const executable = path.join(REPO, 'node_modules/electron/dist/electron.exe');
  const child = spawn(executable, ['.', `--remote-debugging-port=${port}`,
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
    { cwd: REPO, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = fs.createWriteStream(path.join(runRoot, 'electron.log'));
  child.stdout.pipe(log); child.stderr.pipe(log);

  const pages = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const startedAt = Date.now();
  let main;
  try {
    const page = await until(async () => (await pages()).find(item =>
      item.type === 'page' && item.url.startsWith('file:') && !item.url.includes('surface=')),
      'main renderer', options.launchTimeoutMs || 60000);
    main = new Cdp(page.webSocketDebuggerUrl);
    await main.open();
    await main.send('Page.enable');
    // The board gives each pane a fraction of the viewport, and a pane too short
    // to hold a CLI's launch banner is never recognised as ready: Codex's
    // "OpenAI Codex" header is a launch gate (orchestratorPromptReadiness.cjs:97)
    // and at 1600x1000 the tile decodes 69x10, which scrolls the header away. A
    // viewport this size gives every tile a pane a person would recognise.
    await main.send('Emulation.setDeviceMetricsOverride', { mobile: false, deviceScaleFactor: 1,
      width: options.viewport?.width || 2400, height: options.viewport?.height || 1700 });
    await until(() => main.eval("Boolean(window.vibe?.orchestrator && document.querySelector('.orchestrator-mic'))"),
      'orchestrator UI', options.launchTimeoutMs || 60000);
  } catch (error) {
    try { main?.close(); } catch { /* not open */ }
    if (child.pid) spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    throw error;
  }
  const coldStartMs = Date.now() - startedAt;

  const json = value => JSON.stringify(value);
  const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

  const harness = {
    runRoot, profileRoot, userData, documents, home, codexHome, claudeHome, port, coldStartMs, seeded, model, budget,
    evaluate: (expression, timeoutMs) => main.eval(expression, timeoutMs),
    until,
    /**
     * The Brain's own switch. The key comes from the seeded profile.
     *
     * The wait is on `enabled`, not on the `ready` the renderer publishes:
     * orchestratorIntegration reports `ready: state.ready && voiceReady`
     * (integration.cjs:914), and voiceReady only turns true once the speech and
     * transcription models have been validated — which a headless run neither
     * needs nor always gets. setEnabled resolving ok IS the relay validating the
     * key and model (orchestrator.cjs:2502).
     */
    async enableBrain() {
      if (options.sessionKey) {
        const configured = await main.eval(`window.vibe.orchestrator.configure(${json({ apiKey: options.sessionKey, sessionOnly: true, model, spendingLimit: budget,
          ...(options.interpretationModel && { interpretationModel: options.interpretationModel }) })})`, 30000);
        if (configured?.ok === false) throw new Error(`configure refused the session key: ${json(configured)}`);
      }
      const before = await harness.state();
      if (!before.settings.hasKey) throw new Error('The scratch profile has no decryptable Brain key.');
      const result = await main.eval('window.vibe.orchestrator.setEnabled(true)', 60000);
      if (result?.ok !== true) throw new Error(`The Brain could not be enabled: ${json(result)}`);
      let last = null;
      const state = await until(async () => {
        const current = await harness.state();
        last = { enabled: current.enabled, ready: current.ready, voiceReady: current.voiceReady,
          phase: current.phase, error: current.error, hasKey: current.settings?.hasKey, model: current.settings?.model };
        return current.enabled ? current : false;
      }, 'Brain enabled', 30000).catch(error => { throw new Error(`${error.message}; last state ${json(last)}`); });
      return { enabled: state.enabled, ready: state.ready, voiceReady: state.voiceReady, model: state.settings.model };
    },
    state: () => main.eval('window.vibe.orchestrator.getState()'),
    dispatch: (action, timeoutMs) => main.eval(`window.vibe.orchestrator.dispatch(${json(action)})`, timeoutMs),
    /** What the scratch app believes is installed — the fidelity check for a run. */
    installedClis: (refresh = false) => main.eval(`window.vibe.app.getInstalledClis(${json({ refresh })})`, 30000),
    /**
     * Wait until the renderer's inventory has actually been applied.
     *
     * This matters more than it looks. The relay PREFETCHES the launcher
     * catalog when a request is submitted (orchestrator.cjs:1471), and a
     * just-launched app can still be holding an empty one — in which case the
     * deterministic compiler declines every sentence with `unknown-provider`
     * and the request takes a model round it would never take on a machine that
     * has been open for a minute. A project the app has registered can only have
     * come back through that same inventory, so seeing them all is the proof.
     */
    async waitForInventory(projectPaths, timeoutMs = 60000) {
      const wanted = projectPaths.map(item => String(item).toLowerCase());
      const workspace = await until(async () => {
        const result = await harness.dispatch({ kind: 'read_workspace' }, 30000);
        const known = (result?.projects || []).map(project => String(project.path).toLowerCase());
        return wanted.every(path => known.includes(path)) ? result : false;
      }, `inventory listing ${projectPaths.length} project(s)`, timeoutMs, 500);
      // The catalog itself is not on any read surface, so this checks the thing
      // it is built from: a run is only comparable with the user's machine when
      // the same coding agents are on PATH.
      const clis = (await harness.installedClis().catch(() => null))?.clis || {};
      const missing = ALLOWED_CLIS.filter(kind => clis[kind]?.available !== true);
      if (missing.length) throw new Error(`The scratch app cannot see ${missing.join(' and ')} on PATH; a run without them is not comparable.`);
      return { workspace, clis };
    },
    /** Registers a project under the scratch Documents folder with an exact name. */
    async createProject(name) {
      const result = await harness.dispatch({ kind: 'create_project', parent: documents, name,
        actionId: `harness-project-${name.replace(/\W+/g, '-')}` }, 60000);
      if (!result?.ok) throw new Error(`create_project ${name} failed: ${json(result)}`);
      writeClaudeConfig(claudeHome, [result.path]);
      trustCodexProject(codexHome, result.path);
      return { name, path: result.path };
    },
    /** One pane, through the Orchestrator's own create_session path. */
    async createPane({ cwd, kind, waitForReady = true, timeoutMs = 120000 }) {
      const result = await harness.dispatch({ kind: 'create_session', kindOfSession: kind, cwd, waitForReady,
        actionId: `harness-pane-${Math.random().toString(36).slice(2, 10)}` }, timeoutMs);
      if (!result?.ok) throw new Error(`create_session ${kind} in ${cwd} failed: ${json(result)}`);
      const id = result.target?.id || result.id;
      const session = await until(async () => (await harness.state()).sessions.find(item => item.id === id && item.generation),
        `pane ${kind} in state`, 30000);
      return { id, kind, cwd, generation: session.generation, launchToken: session.launchToken, result };
    },
    /**
     * Drag one pane's south-east corner until its decoded screen is at least
     * `cols` x `rows`.
     *
     * Why a harness has to do this at all: a newly opened pane is laid out at
     * the board's default 560x260 (frontend/components/tiledBoardGeometry.ts:1124),
     * which decodes to about 69 columns by 10 rows — too short to hold the launch
     * banner every provider prints once, and the banner is a hard gate on the
     * FIRST prompt into a pane (orchestratorPromptReadiness.cjs:97,320). So a
     * default-sized pane refuses its first prompt with "The empty Codex root
     * composer is not at the current cursor" no matter how ready it is. A person
     * would drag the corner; this does the same through the board's own pointer
     * handlers, so nothing about the app is bypassed.
     */
    async resizePane(target, { cols = 100, rows = 28 } = {}, timeoutMs = 20000) {
      const current = await harness.readPane(target, 200);
      if (current.ok && current.observation?.cols >= cols && current.observation?.rows >= rows) return current.observation;
      // Committing a resize re-normalises the tile's width, so one drag can end
      // narrower than it started. Measure and drag again until both dimensions
      // are big enough (or nothing moves).
      let dragged;
      for (let attempt = 0; attempt < 3; attempt++) {
        dragged = await harness.dragPaneCorner(target, cols, rows);
        if (dragged.skipped) break;
      }
      if (!dragged || dragged.after[1] <= 260 && !dragged.skipped) throw new Error(`Pane ${target.id} did not resize: ${json(dragged)}`);
      let seen = null;
      return until(async () => {
        const screen = await harness.readPane(target, 200);
        seen = screen.observation ? [screen.observation.cols, screen.observation.rows] : null;
        return screen.ok && screen.observation?.cols >= cols && screen.observation?.rows >= rows ? screen.observation : false;
      }, `pane ${target.id} resized to ${cols}x${rows} (frame ${json(dragged)})`, timeoutMs, 200)
        .catch(error => { throw new Error(`${error.message}; decoded ${json(seen)}`); });
    },
    /** One south-east drag through the board's own pointer handlers. */
    async dragPaneCorner(target, cols, rows) {
      return main.eval(`(async () => {
        const frame = document.querySelector('.pane-frame[data-session-id=${json(target.id)}]');
        if (!frame) throw new Error('pane frame not found');
        const handle = frame.querySelector('.pane-resize-edge-se');
        if (!handle) throw new Error('resize handle not found');
        const paint = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const before = frame.getBoundingClientRect();
        const box = handle.getBoundingClientRect();
        const start = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
        const point = (node, type, x, y) => node.dispatchEvent(new PointerEvent(type, {
          bubbles: true, cancelable: true, pointerId: 77, isPrimary: true, button: 0,
          buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y }));
        const wanted = { width: ${cols * 9 + 120}, height: ${rows * 19 + 140} };
        // Only ever grow: a tile already wider than the target must not be
        // dragged back to the board's minimum width.
        const delta = { x: Math.max(0, wanted.width - before.width), y: Math.max(0, wanted.height - before.height) };
        if (!delta.x && !delta.y) return { before: [Math.round(before.width), Math.round(before.height)], after: [Math.round(before.width), Math.round(before.height)], skipped: true };
        point(handle, 'pointerdown', start.x, start.y);
        await paint();
        for (let step = 1; step <= 6; step++) {
          point(window, 'pointermove', start.x + delta.x * step / 6, start.y + delta.y * step / 6);
          await paint();
        }
        point(window, 'pointerup', start.x + delta.x, start.y + delta.y);
        await paint();
        const after = frame.getBoundingClientRect();
        return { before: [Math.round(before.width), Math.round(before.height)], after: [Math.round(after.width), Math.round(after.height)] };
      })()`);
    },
    /** The pane's decoded screen, read through the app's own observation path. */
    async readPane(target, maxChars = 6000) {
      const result = await harness.dispatch({ kind: 'read_session', target: { id: target.id, generation: target.generation }, maxChars }, 60000);
      return result?.ok ? { ok: true, text: String(result.observation?.text || ''), observation: result.observation } : { ok: false, result };
    },
    /**
     * Waits until the application's OWN startup predicate calls the pane ready.
     * The harness deliberately re-uses backend/orchestratorPromptReadiness.cjs
     * rather than matching a screen of its own: what a scenario needs to know is
     * "would the app type into this pane", and that is the only thing that
     * answers it. A kind with no verified recognizer reports 'unsupported',
     * which the app treats as typeable, so it counts as ready here too.
     */
    async waitForPaneReady(target, timeoutMs = 120000) {
      const { assessNativePromptReadiness } = require('../../../backend/orchestratorPromptReadiness.cjs');
      let last = null;
      return until(async () => {
        const [screen, state] = await Promise.all([harness.readPane(target, 4000), harness.state()]);
        const session = state.sessions.find(item => item.id === target.id);
        if (!session || !screen.ok) return false;
        const verdict = assessNativePromptReadiness({ ...session, provider: session.provider || session.kind },
          { ...screen.observation, ok: true, id: target.id, generation: session.generation });
        last = verdict;
        return verdict.ready || verdict.status === 'unsupported' ? verdict : false;
      }, `pane ${target.id} ready`, timeoutMs, 500)
        .catch(error => { throw new Error(`${error.message}; last readiness ${json(last)}`); });
    },
    async closePane(target) {
      const state = await harness.state();
      const session = state.sessions.find(item => item.id === target.id);
      if (!session) return { ok: true, status: 'already-absent' };
      return harness.dispatch({ kind: 'close', actionId: `harness-close-${target.id}`,
        target: { id: session.id, generation: session.generation, launchToken: session.launchToken },
        targetId: session.id, generation: session.generation }, 120000);
    },
    /**
     * Puts the workspace back to empty between scenarios.
     *
     * A pane in the middle of a turn does not always go on the first ask — the
     * close is acknowledged and the process takes its time — and one pane left
     * behind would make the next scenario's pane counts meaningless. So this
     * asks again, up to `rounds` times, and only then gives up with the names of
     * what survived.
     */
    async resetWorkspace(rounds = 4) {
      const results = [];
      for (let round = 0; round < rounds; round++) {
        const sessions = (await harness.state()).sessions;
        if (!sessions.length) break;
        for (const session of sessions) results.push({ round, id: session.id, ...(await harness.closePane(session)) });
        try { await until(async () => (await harness.state()).sessions.length === 0, 'workspace emptied', 20000, 500); break; }
        catch { /* ask the survivors again */ }
      }
      const left = (await harness.state()).sessions;
      if (left.length) throw new Error(`${left.length} pane(s) would not close: ${left.map(item => `${item.id}(${item.kind}/${item.status})`).join(', ')}`);
      // Scenarios are independent: a question the previous one left unanswered
      // must not reach the next one's Brain as a pending command.
      await main.eval('window.vibe.orchestrator.cancel()');
      await main.eval('window.vibe.orchestrator.clearHistory()');
      return results;
    },
    /** Waits until a pane's screen matches, so pane state is read as evidence. */
    waitForPane: (target, pattern, label, ms = 90000) => until(async () => {
      const screen = await harness.readPane(target);
      return screen.ok && pattern.test(screen.text) ? screen : false;
    }, label, ms, 400),
    /** Types into a pane directly, for scenario SETUP only — never for a graded turn. */
    async sendToPane(target, text) {
      return harness.dispatch({ kind: 'send_prompt', target: { id: target.id, generation: target.generation }, text }, 120000);
    },
    panesIn: async cwd => (await harness.state()).sessions.filter(session =>
      String(session.cwd || '').toLowerCase() === String(cwd).toLowerCase()),
    /**
     * Submit one request the way the user does and wait for its task to settle.
     * Never `send`: `enqueue` returns at once, which is the acceptance gate the
     * app promises, and leaves this loop free to time out a wedged turn without
     * losing the run.
     */
    async submit({ text, projectPath, origin = 'text', replyToRequestId, questionId, targetId, timeoutMs = 240000 }) {
      const payload = { text, origin, ...(projectPath && { projectPath }), ...(targetId && { targetId }),
        ...(replyToRequestId && { replyToRequestId }), ...(questionId && { questionId }) };
      const acceptedAt = Date.now();
      const ack = await main.eval(`window.vibe.orchestrator.enqueue(${json(payload)})`, 30000);
      const acceptanceMs = Date.now() - acceptedAt;
      if (!ack?.ok) return { ok: false, ack, acceptanceMs, error: ack?.error || 'enqueue refused' };
      const settled = new Set(['finished', 'failed', 'paused', 'cancelled', 'needs-answer']);
      let task = null, timedOut = false;
      try {
        task = await until(async () => {
          const state = await harness.state();
          const found = state.tasks.find(item => item.requestId === ack.requestId);
          return found && settled.has(found.status) ? found : false;
        }, `task ${ack.requestId}`, timeoutMs, 250);
      } catch { timedOut = true; }
      const state = await harness.state();
      if (!task) task = state.tasks.find(item => item.requestId === ack.requestId) || null;
      return { ok: true, requestId: ack.requestId, acceptanceMs, timedOut, task,
        elapsedMs: Date.now() - acceptedAt,
        messages: state.messages.filter(message => message.requestId === ack.requestId),
        receipts: state.receipts.filter(receipt => receipt.requestId === ack.requestId) };
    },
    /** Every recorded fact the app keeps outside its state snapshot. */
    ledger: () => readJson(path.join(userData, 'orchestrator-conversation.json'))?.ledger || [],
    memory: () => readJson(path.join(userData, 'orchestrator-memory-v1.json')) || null,
    diagnostics() {
      const file = path.join(userData, 'logs', 'orchestrator-errors.jsonl');
      if (!fs.existsSync(file)) return [];
      return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
        .map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
    },
    /** Model calls and first effect for one request, from the diagnostics log. */
    requestMetrics(requestId) {
      const rows = harness.diagnostics().filter(row => row.requestId === requestId);
      const firstEffect = rows.find(row => row.stage === 'first_effect');
      return { modelCalls: rows.filter(row => row.stage === 'model_started').length,
        modelFailures: rows.filter(row => row.stage === 'model_complete' && row.status !== 'complete').length,
        firstEffectMs: firstEffect ? firstEffect.elapsedMs ?? null : null,
        errors: rows.filter(row => row.event === 'orchestrator_error').map(row => String(row.error).slice(0, 300)) };
    },
    async spend() { return (await harness.state()).usage || {}; },
    async screenshot(file) {
      const shot = await main.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
      return file;
    },
    /** Copies the profile's own recorded files next to the run's scoreboard. */
    collectEvidence(into) {
      fs.mkdirSync(into, { recursive: true });
      const copied = [];
      for (const [from, name] of [[path.join(userData, 'orchestrator-conversation.json'), 'orchestrator-conversation.json'],
        [path.join(userData, 'orchestrator-memory-v1.json'), 'orchestrator-memory-v1.json'],
        [path.join(userData, 'orchestrator-settings.json'), 'orchestrator-settings.json'],
        [path.join(userData, 'logs', 'orchestrator-errors.jsonl'), 'orchestrator-errors.jsonl'],
        [path.join(runRoot, 'electron.log'), 'electron.log']]) {
        try { fs.copyFileSync(from, path.join(into, name)); copied.push(name); } catch { /* not written this run */ }
      }
      // The settings copy still holds the encrypted key; it is unreadable without
      // the os_crypt section, but there is no reason to keep it beside a report.
      try {
        const file = path.join(into, 'orchestrator-settings.json');
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        fs.writeFileSync(file, JSON.stringify({ ...data, encryptedKey: data.encryptedKey ? '[redacted]' : '' }, null, 2));
      } catch { /* nothing to redact */ }
      return copied;
    },
    async close() {
      try { main.close(); } catch { /* already closed */ }
      if (child.pid) spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
      await wait(300);
      try { log.end(); } catch { /* already ended */ }
    },
  };
  return harness;
}

module.exports = { createAppHarness, until, wait, freePort, Cdp, harnessPath, seedProfile, seedCliHomes,
  writeClaudeConfig, trustCodexProject, defaultProfileRoot, ALLOWED_CLIS, REPO, INSTALLED_PROFILE };
