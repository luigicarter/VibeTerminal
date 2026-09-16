'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createSparePaneKeeper, IDLE_CLOSE_MS, CREATE_COOLDOWN_MS } = require('../../backend/orchestratorSparePane.cjs');
const { resolveAssignment, idlePaneCandidate } = require('../../backend/orchestratorResolver.cjs');
const { createSettings } = require('../../backend/orchestratorSettings.cjs');
const { installOrchestrator } = require('../../backend/orchestratorIntegration.cjs');
const { interpretTestIntent } = require('./orchestrator-test-intent.cjs');

const PROJECT_A = process.platform === 'win32' ? 'C:\\work\\alpha' : '/work/alpha';
const PROJECT_B = process.platform === 'win32' ? 'C:\\work\\beta' : '/work/beta';
const LAUNCHERS = [{ kind: 'codex', label: 'Codex', available: true, configured: true },
  { kind: 'claude', label: 'Claude Code', available: true, configured: true }];

function harness(options = {}) {
  let time = 1_700_000_000_000, counter = 0;
  const sessions = [], workItems = [], created = [], closed = [], events = [];
  const state = { setting: true, enabled: true, pressure: false, projectFact: options.projectFact ?? null };
  function pane(cwd, kind, extra = {}) {
    counter++;
    const session = { id: `pane-${counter}`, name: `${kind} ${counter}`, generation: 1, launchToken: counter, cwd, kind, provider: kind,
      observation: 'observed', started: true, status: 'idle', turnState: 'idle', processState: 'running', agentProcessState: 'running',
      agentPid: 1000 + counter, visiblePane: true, lastActivityAt: time, ...extra };
    sessions.push(session);
    return session;
  }
  const keeper = createSparePaneKeeper({
    getSessions: () => sessions,
    getWorkItems: () => workItems,
    getLaunchers: () => LAUNCHERS,
    getProjectFact: () => state.projectFact,
    getSetting: () => state.setting,
    isEnabled: () => state.enabled,
    memoryPressure: () => state.pressure,
    createSession: async ({ cwd, kindOfSession, waitForReady }) => {
      created.push({ cwd, kindOfSession, waitForReady });
      if (options.createFails) return { ok: false, status: 'launch-timeout' };
      const session = pane(cwd, kindOfSession);
      return { ok: true, id: session.id, status: 'created', target: { id: session.id, generation: session.generation, launchToken: session.launchToken } };
    },
    closeSession: async target => {
      closed.push(target.id);
      const index = sessions.findIndex(session => session.id === target.id);
      if (index >= 0) sessions.splice(index, 1);
      return { ok: true };
    },
    now: () => time,
    log: event => events.push(event),
  });
  return { keeper, sessions, workItems, created, closed, events, state, pane,
    advance: ms => { time += ms; }, at: () => time,
    own: session => workItems.push({ id: `work-${session.id}`, binding: { target: { id: session.id, generation: session.generation } } }) };
}

test('a start in a project leaves one idle unowned spare of that provider behind', async () => {
  const h = harness();
  await h.keeper.noteStart({ cwd: PROJECT_A, provider: 'codex' });
  assert.deepEqual(h.created, [{ cwd: PROJECT_A, kindOfSession: 'codex', waitForReady: true }]);
  assert.equal(h.sessions.length, 1);
  const [spare] = h.sessions;
  assert.equal(spare.provider, 'codex');
  assert.equal(idlePaneCandidate(spare), true);
  assert.equal(h.workItems.length, 0, 'the keeper reserves no work item for its spare');
  assert.equal(h.keeper.state().spare.id, spare.id);
  assert.deepEqual(h.events, [{ status: 'created', reason: 'warm-spare', provider: 'codex', targetId: spare.id, generation: 1 }]);
  // Nothing new on a plain tick: one spare per project, one app-wide.
  await h.keeper.tick();
  assert.equal(h.created.length, 1);
  assert.equal(h.events.at(-1).reason, 'spare-exists');
});

test('the next start is routed to the spare by the resolver, and the keeper warms another', async () => {
  const h = harness();
  await h.keeper.noteStart({ cwd: PROJECT_A, provider: 'codex' });
  const [spare] = h.sessions;
  // Resolver-visible state: an idle pane nobody owns takes the new work, and no
  // pane is created for it. This is the whole point of the warm spare.
  const routed = resolveAssignment({ instruction: 'start a task on the login page',
    terminals: require('../../backend/orchestratorTerminalModel.cjs').buildTerminalModel({ sessions: h.sessions, workItems: h.workItems }),
    launchers: LAUNCHERS, cwd: PROJECT_A, projectName: 'alpha' });
  assert.equal(routed.decision, 'reuse');
  assert.equal(routed.targetId, spare.id);

  // The task binds it; from that moment it is the user's pane, not a spare.
  h.own(spare);
  h.advance(CREATE_COOLDOWN_MS);
  await h.keeper.noteStart({ cwd: PROJECT_A, provider: 'codex' });
  assert.equal(h.created.length, 2);
  assert.equal(h.sessions.length, 2);
  const next = h.sessions[1];
  assert.notEqual(next.id, spare.id);
  assert.equal(h.keeper.state().spare.id, next.id);
  assert.deepEqual(h.closed, [], 'a pane a task owns is never closed by the keeper');
});

test('no spare is opened when an idle unowned pane of that provider is already free', async () => {
  const h = harness();
  const free = h.pane(PROJECT_A, 'codex');
  await h.keeper.noteStart({ cwd: PROJECT_A, provider: 'codex' });
  assert.deepEqual(h.created, []);
  assert.equal(h.sessions.length, 1);
  assert.equal(h.events.at(-1).reason, 'idle-pane-available');
  // A busy pane of the same provider is no substitute, and an idle pane of a
  // different provider does not answer for this one.
  free.turnState = 'running';
  h.pane(PROJECT_A, 'claude');
  h.pane(PROJECT_B, 'codex');
  await h.keeper.tick();
  assert.deepEqual(h.created, [{ cwd: PROJECT_A, kindOfSession: 'codex', waitForReady: true }]);
});

// The two reasons the keeper used to open a pane beside an empty one: a pane
// whose native identity is not confirmed until its first prompt, and a work item
// whose prompt was cancelled or failed but kept its binding.
test('a never-prompted pane and a released owner both leave the workspace already spare', async () => {
  const h = harness();
  const provisional = h.pane(PROJECT_A, 'codex', { observation: 'provisional', turnState: 'idle' });
  assert.equal(idlePaneCandidate(provisional), true, 'a pane that has never taken a prompt is idle');
  await h.keeper.noteStart({ cwd: PROJECT_A, provider: 'codex' });
  assert.deepEqual(h.created, []);
  assert.equal(h.events.at(-1).reason, 'idle-pane-available');
  // A cancelled item never delivered its prompt, so its pane is free too.
  h.workItems.push({ id: 'w1', status: 'cancelled', binding: { target: { id: provisional.id, generation: provisional.generation } } });
  await h.keeper.tick();
  assert.deepEqual(h.created, []);
  assert.equal(h.events.at(-1).reason, 'idle-pane-available');
  // A finished item keeps its conversation, so the keeper opens the spare.
  h.workItems[0].status = 'finished';
  h.advance(CREATE_COOLDOWN_MS + 1);
  await h.keeper.tick();
  assert.deepEqual(h.created, [{ cwd: PROJECT_A, kindOfSession: 'codex', waitForReady: true }]);
});

test('memory pressure and the ten-second creation cooldown each stop a speculative pane', async () => {
  const h = harness();
  h.state.pressure = true;
  await h.keeper.noteStart({ cwd: PROJECT_A, provider: 'codex' });
  assert.deepEqual(h.created, []);
  assert.equal(h.events.at(-1).reason, 'memory-pressure');

  h.state.pressure = false;
  await h.keeper.tick();
  assert.equal(h.created.length, 1);
  const [spare] = h.sessions;

  // The spare is consumed, so the keeper wants another one; it may not open it
  // inside ten seconds of the last creation.
  h.own(spare);
  h.advance(CREATE_COOLDOWN_MS - 1);
  await h.keeper.noteStart({ cwd: PROJECT_A, provider: 'codex' });
  assert.equal(h.created.length, 1);
  assert.equal(h.events.at(-1).reason, 'cooldown');

  h.advance(1);
  await h.keeper.tick();
  assert.equal(h.created.length, 2);
});

test('thirty idle minutes close the keeper\'s own spare and nothing else', async () => {
  const h = harness();
  await h.keeper.noteStart({ cwd: PROJECT_A, provider: 'codex' });
  const [spare] = h.sessions;
  const userPane = h.pane(PROJECT_A, 'codex');
  const ownedPane = h.pane(PROJECT_A, 'claude');
  h.own(ownedPane);

  h.advance(IDLE_CLOSE_MS - 1);
  await h.keeper.tick();
  assert.deepEqual(h.closed, []);

  h.advance(1);
  await h.keeper.tick();
  assert.deepEqual(h.closed, [spare.id], 'only the pane the keeper created is closed');
  assert.deepEqual(h.sessions.map(session => session.id), [userPane.id, ownedPane.id]);
  assert.equal(h.keeper.state().spare, null);
  assert.equal(h.events.at(-1).status, 'closed');
  assert.equal(h.events.at(-1).reason, 'idle-timeout');
  // The project has gone quiet: the keeper does not reopen what it just closed.
  await h.keeper.tick();
  assert.equal(h.created.length, 1);
});

test('a spare that is used again restarts its idle clock instead of being closed', async () => {
  const h = harness();
  await h.keeper.noteStart({ cwd: PROJECT_A, provider: 'codex' });
  const [spare] = h.sessions;
  h.advance(IDLE_CLOSE_MS - 1000);
  spare.turnState = 'running';
  await h.keeper.tick();
  h.advance(2000);
  spare.turnState = 'idle';
  await h.keeper.tick();
  assert.deepEqual(h.closed, []);
  h.advance(IDLE_CLOSE_MS - 1);
  await h.keeper.tick();
  assert.deepEqual(h.closed, []);
  h.advance(1);
  await h.keeper.tick();
  assert.deepEqual(h.closed, [spare.id]);
});

test('turning the setting off closes the keeper\'s spare and stops creating', async () => {
  const h = harness();
  await h.keeper.noteStart({ cwd: PROJECT_A, provider: 'codex' });
  const [spare] = h.sessions;
  h.state.setting = false;
  await h.keeper.tick();
  assert.deepEqual(h.closed, [spare.id]);
  assert.equal(h.events.at(-1).reason, 'setting-off');
  h.advance(CREATE_COOLDOWN_MS);
  await h.keeper.noteStart({ cwd: PROJECT_A, provider: 'codex' });
  assert.equal(h.created.length, 1);
  assert.equal(h.sessions.length, 0);
  // The disabled Orchestrator itself opens nothing either.
  h.state.setting = true; h.state.enabled = false;
  await h.keeper.noteStart({ cwd: PROJECT_A, provider: 'codex' });
  assert.equal(h.created.length, 1);
  h.state.enabled = true;
  await h.keeper.tick();
  assert.equal(h.created.length, 2);
  // Turning the microphone off again stops creation but takes no pane away:
  // only the setting itself, or thirty unused minutes, close a spare.
  const [warm] = h.sessions;
  h.state.enabled = false;
  h.advance(IDLE_CLOSE_MS - 1);
  await h.keeper.tick();
  assert.deepEqual(h.closed, [spare.id]);
  assert.deepEqual(h.sessions.map(session => session.id), [warm.id]);
});

test('only the last active project is kept warm, and its default provider wins over the one just used', async () => {
  const h = harness({ projectFact: { project: 'alpha', cwd: PROJECT_A, defaultProvider: 'claude' } });
  await h.keeper.noteStart({ cwd: PROJECT_A, provider: 'codex' });
  assert.deepEqual(h.created, [{ cwd: PROJECT_A, kindOfSession: 'claude', waitForReady: true }]);

  h.own(h.sessions[0]);
  h.state.projectFact = null;
  h.advance(CREATE_COOLDOWN_MS);
  await h.keeper.noteStart({ cwd: PROJECT_B, provider: 'codex' });
  assert.equal(h.created.at(-1).cwd, PROJECT_B);
  assert.equal(h.keeper.state().project, PROJECT_B);
});

test('moving to another project closes the spare left behind and warms the new one', async () => {
  const h = harness();
  await h.keeper.noteStart({ cwd: PROJECT_A, provider: 'codex' });
  const [spareA] = h.sessions;
  assert.equal(spareA.cwd, PROJECT_A);

  // Still idle and still unowned, so the keeper takes back what it opened.
  await h.keeper.noteStart({ cwd: PROJECT_B, provider: 'codex' });
  assert.deepEqual(h.closed, [spareA.id]);
  assert.deepEqual(h.sessions, []);
  assert.equal(h.events.at(-2).reason, 'project-changed');
  // One spare app-wide: the new project waits out the creation cooldown.
  assert.equal(h.created.length, 1);
  assert.equal(h.events.at(-1).reason, 'cooldown');

  h.advance(CREATE_COOLDOWN_MS);
  await h.keeper.tick();
  assert.equal(h.created.length, 2);
  assert.equal(h.created.at(-1).cwd, PROJECT_B);
  assert.equal(h.sessions[0].cwd, PROJECT_B);
  assert.equal(h.keeper.state().spare.cwd, PROJECT_B);
});

test('a spare a task has taken over survives the move, and the new project still gets one', async () => {
  const h = harness();
  await h.keeper.noteStart({ cwd: PROJECT_A, provider: 'codex' });
  const [spareA] = h.sessions;
  h.own(spareA);

  h.advance(CREATE_COOLDOWN_MS);
  await h.keeper.noteStart({ cwd: PROJECT_B, provider: 'codex' });
  assert.deepEqual(h.closed, [], 'a pane a work item bound is left alone');
  assert.equal(h.created.length, 2);
  assert.equal(h.created.at(-1).cwd, PROJECT_B);
  assert.deepEqual(h.sessions.map(session => session.cwd), [PROJECT_A, PROJECT_B]);
  assert.equal(h.keeper.state().spare.cwd, PROJECT_B);
});

test('a refused creation is recorded and the pane is not tracked as a spare', async () => {
  const h = harness({ createFails: true });
  await h.keeper.noteStart({ cwd: PROJECT_A, provider: 'codex' });
  assert.equal(h.created.length, 1);
  assert.equal(h.keeper.state().spare, null);
  assert.deepEqual(h.events.at(-1), { status: 'skipped', reason: 'create-failed', provider: 'codex' });
  // A provider with no available launcher is never attempted at all.
  h.advance(CREATE_COOLDOWN_MS);
  await h.keeper.noteStart({ cwd: PROJECT_A, provider: 'gemini' });
  assert.equal(h.created.length, 1);
  assert.equal(h.events.at(-1).reason, 'launcher-unavailable');
});

// The one place the whole integration is assembled: enough Electron shape for
// installOrchestrator to construct, and nothing more.
function integrationFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-spare-integration-'));
  class Window extends EventEmitter {
    static instances = [];
    static getAllWindows() { return this.instances.filter(window => !window.destroyed); }
    constructor(options = {}) {
      super(); this.options = options; this.destroyed = false;
      this.webContents = new EventEmitter();
      this.webContents.send = () => {};
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.session = { setPermissionRequestHandler: () => {} };
      Window.instances.push(this);
    }
    isDestroyed() { return this.destroyed; }
    showInactive() {} hide() {}
    getBounds() { return this.options; }
    setBounds(bounds) { Object.assign(this.options, bounds); }
    loadURL() { return Promise.resolve(); }
    loadFile() { return Promise.resolve(); }
    destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('closed'); } }
  }
  const screen = new EventEmitter();
  screen.getCursorScreenPoint = () => ({ x: 0, y: 0 });
  screen.getDisplayMatching = screen.getDisplayNearestPoint = () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } });
  const ipcMain = new EventEmitter(); ipcMain.handle = () => {};
  const app = new EventEmitter(); app.getPath = () => root; app.isPackaged = false;
  const main = new Window();
  let voiceOptions;
  const integration = installOrchestrator({ app, BrowserWindow: Window, screen, ipcMain, getMainWindow: () => main,
    shell: {}, safeStorage: { isEncryptionAvailable: () => false }, interpretIntent: interpretTestIntent,
    microphonePermission: { isGranted: () => true, ensure: async () => ({ ok: true }), openSettings: async () => ({ ok: true }) },
    getRuntime: () => ({ listSnapshots: () => [] }), sendPty: () => false, sendFusion: () => false, sendOpenFusion: () => false,
    getTelemetry: () => ({}), getChanges: () => ({}),
    fetch: async () => { throw new Error('Unexpected network request.'); },
    // A stub whose only job is to record the options it was built with; every
    // method the integration reaches for is an inert no-op.
    voiceFactory: options => {
      voiceOptions = options;
      return new Proxy({ getState: () => ({}) }, { get: (target, name) => target[name] || (() => ({ ok: true })) });
    },
  });
  t.after(async () => {
    await integration.dispose();
    assert(path.basename(root).startsWith('vibe-spare-integration-'));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  return { integration, voiceOptions: () => voiceOptions, root };
}

test('the transcription vocabulary carries the registered project names', t => {
  const f = integrationFixture(t);
  const getVocabulary = f.voiceOptions().getVocabulary;
  assert.equal(typeof getVocabulary, 'function');
  assert.deepEqual(getVocabulary(), []);
  f.integration.directory.updateUi([], [], [], [
    { id: 'p1', path: PROJECT_A, name: 'vibeTerminal' },
    { id: 'p2', path: PROJECT_B, name: 'Lina Website' },
    { id: 'p3', path: '/work/gamma' },
  ]);
  assert.deepEqual(getVocabulary(), ['vibeTerminal', 'Lina Website'], 'an unnamed project contributes no word');
});

test('the spare setting round-trips through configure and getSettings', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-spare-pane-'));
  t.after(() => { assert(path.resolve(root).startsWith(path.join(os.tmpdir(), 'vibe-spare-pane-'))); fs.rmSync(root, { recursive: true, force: true }); });
  const store = createSettings({ userDataPath: root });
  assert.equal(store.getSettings().spareAgent, true, 'a spare agent is kept by default');
  assert.throws(() => store.configure({ spareAgent: 'no' }), /Invalid spareAgent/);
  assert.equal(store.getSettings().spareAgent, true);
  store.configure({ spareAgent: false });
  assert.equal(store.getSettings().spareAgent, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'orchestrator-settings.json'), 'utf8')).settings.spareAgent, false);
  assert.equal(createSettings({ userDataPath: root }).getSettings().spareAgent, false);
  store.configure({ spareAgent: true });
  assert.equal(createSettings({ userDataPath: root }).getSettings().spareAgent, true);
});
