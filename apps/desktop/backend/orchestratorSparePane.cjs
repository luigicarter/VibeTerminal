'use strict';

// One warm spare pane.
//
// Creating a pane costs about a second and a half before a prompt can be typed
// into it, and that cost lands in the middle of every "open Codex here" and
// "start a task in this project". The resolver already prefers an idle pane
// nobody owns over creating a new one, so the cost disappears entirely if such
// a pane happens to exist when the request arrives. This keeper makes exactly
// one exist: after a start in a project it opens a single idle pane of that
// project's default provider and otherwise leaves the workspace alone.
//
// The spare is an ordinary pane. Nothing routes to it specially, no work item
// is reserved for it, and the moment a task binds it the keeper forgets it and
// will never touch it again. Only a pane this keeper created, still idle and
// still unowned, is ever closed by it: when the work moves to another project,
// after thirty unused minutes, or when the setting is turned off.
//
// Pure apart from the readers and two effects handed in: no model call, no
// store writes, no direct terminal access.

const { idlePaneCandidate, ownsPaneForReuse } = require('./orchestratorResolver.cjs');
const { providerFamily } = require('./orchestratorVocabulary.cjs');
const { rememberedProvider } = require('./orchestratorMemory.cjs');
const { neverPrompted } = require('./orchestratorPaneReadiness.cjs');
const path = require('node:path');

const TICK_MS = 30000;
// A start that fans out into several panes must not each leave a spare behind.
const CREATE_COOLDOWN_MS = 10000;
const IDLE_CLOSE_MS = 30 * 60 * 1000;
// The September 10 memory audit measured retention; it published no live
// pressure gauge, so the guard here is the system's own free memory. Below this
// fraction a speculative pane is exactly the allocation that audit asks us not
// to make. Callers supply the reading; this is the documented default.
const MEMORY_FREE_FRACTION = 0.15;

// Panes without a coding agent are not what "start" and "open" mean here.
const NON_AGENT = new Set(['terminal', 'shell']);

function projectKey(value) {
  const text = String(value || '');
  if (!text) return '';
  const windows = process.platform === 'win32' || /^[A-Za-z]:[\\/]/.test(text);
  const normalized = (windows ? path.win32 : path.posix).normalize(text).replace(/\\/g, '/').replace(/\/+$/, '');
  return windows ? normalized.toLowerCase() : normalized;
}

function createSparePaneKeeper({
  getSessions = () => [],
  // Work items as the store holds them; only their bound pane id is read.
  getWorkItems = () => [],
  getLaunchers = () => [],
  // recallProject-shaped facts for one project: { defaultProvider } or null.
  getProjectFact = () => null,
  // The spareAgent setting.
  getSetting = () => false,
  // The Orchestrator itself. A disabled app opens nothing on its own.
  isEnabled = () => true,
  memoryPressure = () => false,
  createSession,
  closeSession,
  now = Date.now,
  log = () => {},
} = {}) {
  // The project of the last start, and the provider that start used.
  let active = null;
  // The single pane this keeper created: { id, generation, launchToken, cwd, provider, idleSince }.
  let spare = null;
  let lastCreatedAt = 0, lastSkip = null, creating = false, stopped = false;
  let chain = Promise.resolve();

  const list = () => { const value = getSessions(); return (Array.isArray(value) ? value : []).filter(Boolean); };
  // A cancelled or failed item never delivered its prompt, so the pane it named
  // is free; the resolver treats it the same way. A finished item keeps its pane.
  const ownedIds = () => {
    const value = getWorkItems();
    return new Set((Array.isArray(value) ? value : []).filter(ownsPaneForReuse).map(item => item?.binding?.target?.id).filter(Boolean));
  };
  const kindOf = session => String(session?.provider || session?.kind || '');
  const live = sessions => spare && sessions.find(session => session.id === spare.id && session.generation === spare.generation);
  const reusable = (session, owned) => idlePaneCandidate(session) && !owned.has(session.id) && !NON_AGENT.has(kindOf(session));

  // Repeating one steady-state reason every thirty seconds would bury the real
  // records; only a change of reason is worth a line.
  function skip(reason, provider) {
    if (lastSkip !== reason) { lastSkip = reason; log({ status: 'skipped', reason, ...(provider && { provider }) }); }
  }

  async function close(reason) {
    const target = spare;
    // Released before the await: a refused or failed close leaves the pane to
    // the user rather than to a second attempt by this keeper.
    spare = null;
    const detail = { targetId: target.id, generation: target.generation, provider: target.provider };
    try {
      const result = await closeSession({ id: target.id, generation: target.generation, launchToken: target.launchToken, cwd: target.cwd });
      if (result?.ok) log({ status: 'closed', reason, ...detail });
      else log({ status: 'skipped', reason: 'close-refused', ...detail });
    } catch { log({ status: 'skipped', reason: 'close-failed', ...detail }); }
  }

  async function run() {
    if (stopped || typeof createSession !== 'function') return;
    // The setting is what the spare belongs to. Turning the Orchestrator's
    // microphone off stops it opening more panes; it does not take away a pane
    // the user already has.
    const wanted = getSetting() !== false, allowed = wanted && isEnabled() !== false;
    let sessions = list(), owned = ownedIds();

    // 1. Reconcile what the keeper still owns. A pane that is gone, replaced,
    //    or bound to a task is no longer a spare and is never closed here.
    if (spare) {
      const current = live(sessions);
      if (!current || owned.has(current.id) || !neverPrompted(current)) spare = null;
      else if (!idlePaneCandidate(current)) spare.idleSince = null;
      else spare.idleSince ||= now();
    }

    // 2. Close its own spare: when the user turns the setting off, when the
    //    work moved to another project, or after thirty unbroken minutes of
    //    nobody wanting it. Only a still-idle, still-unowned pane reaches here;
    //    step 1 has already let go of anything a task took over.
    if (spare && spare.idleSince) {
      const moved = active?.cwd && projectKey(spare.cwd) !== projectKey(active.cwd);
      const reason = !wanted ? 'setting-off' : moved ? 'project-changed' : now() - spare.idleSince >= IDLE_CLOSE_MS ? 'idle-timeout' : null;
      if (reason) {
        await close(reason);
        // Half an hour without anyone wanting it is the project going quiet.
        // Forget it, so the keeper neither reopens what it just closed nor
        // keeps a stale project warm; the next start names the project again.
        if (reason === 'idle-timeout') active = null;
        sessions = list(); owned = ownedIds();
      }
    }

    // 3. Create at most one, in the last project a start landed in.
    if (!allowed || !active?.cwd) return;
    const project = active.cwd, key = projectKey(project);
    const provider = rememberedProvider(getProjectFact(project)) || String(active.provider || '').trim();
    if (!provider || NON_AGENT.has(provider)) return skip('no-provider');
    if (spare) return skip('spare-exists', provider);
    const family = providerFamily(provider);
    if (sessions.some(session => projectKey(session.cwd) === key && reusable(session, owned) && providerFamily(kindOf(session)) === family)) return skip('idle-pane-available', provider);
    if (memoryPressure() === true) return skip('memory-pressure', provider);
    if (now() - lastCreatedAt < CREATE_COOLDOWN_MS) return skip('cooldown', provider);
    if (creating) return skip('in-flight', provider);
    const catalog = getLaunchers();
    if (Array.isArray(catalog) && catalog.length && !catalog.some(item => item?.kind === provider && item.available === true && item.configured === true)) return skip('launcher-unavailable', provider);

    creating = true; lastCreatedAt = now(); lastSkip = null;
    try {
      const result = await createSession({ cwd: project, kindOfSession: provider, waitForReady: true });
      const id = result?.ok ? result.id || result.target?.id : null;
      if (!id) { log({ status: 'skipped', reason: 'create-failed', provider }); return; }
      const created = list().find(session => session.id === id);
      spare = { id, cwd: project, provider, idleSince: now(),
        generation: result.target?.generation ?? created?.generation,
        launchToken: result.target?.launchToken ?? created?.launchToken };
      log({ status: 'created', reason: 'warm-spare', provider, targetId: id, generation: spare.generation });
    } catch { log({ status: 'skipped', reason: 'create-failed', provider }); }
    // Counted from when the pane actually appeared, not from when it was asked
    // for: waiting for readiness can take most of the launch timeout.
    finally { creating = false; lastCreatedAt = now(); }
  }

  function tick() {
    chain = chain.then(run, run).catch(() => {});
    return chain;
  }

  return {
    // Called after a delegated start or an open completes in a project. The
    // provider is the one that start used; a project fact overrides it.
    noteStart({ cwd, provider } = {}) {
      const project = typeof cwd === 'string' && cwd.trim() ? cwd : '';
      if (project) {
        const same = active && projectKey(active.cwd) === projectKey(project);
        active = { cwd: project, provider: typeof provider === 'string' && provider.trim() ? provider.trim() : same ? active.provider : undefined };
      }
      return tick();
    },
    tick,
    // Diagnostics and tests only: no authority crosses this boundary.
    state: () => ({ project: active?.cwd, provider: active?.provider,
      spare: spare && { id: spare.id, generation: spare.generation, cwd: spare.cwd, provider: spare.provider, idleSince: spare.idleSince } }),
    dispose() { stopped = true; return chain; },
  };
}

module.exports = { createSparePaneKeeper, TICK_MS, CREATE_COOLDOWN_MS, IDLE_CLOSE_MS, MEMORY_FREE_FRACTION };
