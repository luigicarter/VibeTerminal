'use strict';
// One object per pane: what the user sees, what the Brain is shown, and what
// the app resolves references against. Every fact a sentence can point at
// ("the empty one", "the one you just prompted", "the ones that are done",
// "the terminal working on X", "that new terminal you just opened") is a field
// here, computed once from the runtime session and the app's own records. The
// runtime keeps its fine-grained states; this is their one translation, and
// paneReadiness is the one predicate it reads for `state` and `free`.
// docs/orchestrator-terminal-model-overhaul-2026-09-15.md.
const { paneState, paneReadiness, paneDisplayName } = require('./orchestratorPaneReadiness.cjs');

const PROVIDER_LABELS = Object.freeze({ codex: 'Codex', claude: 'Claude Code', 'claude-custom': 'Claude Code', gemini: 'Gemini',
  kimi: 'Kimi', 'kimi-custom': 'Kimi', qwen: 'Qwen', cursor: 'Cursor', grok: 'Grok Build', opencode: 'OpenCode',
  fusion: 'Fusion', openfusion: 'Open Fusion', terminal: 'Shell', shell: 'Shell' });
// A work item in one of these states no longer owns its pane: a cancelled or
// failed item never delivered its prompt, and keeping it as an owner reserved
// an empty pane for work that will not arrive.
const RELEASED = new Set(['cancelled', 'failed']);
// What a ledger verb did to the pane, in the user's words.
const TOUCH = Object.freeze({ start: 'prompt', follow_up: 'prompt', open: 'opened', close: 'closed', answer: 'answer',
  ask: 'question', status: 'read', results: 'read', inspect: 'read', cancel: 'cancelled', failed: 'failed' });
const DELIVERED = new Set(['delivered-started', 'delivered-unconfirmed']);
const CAPS = Object.freeze({ on: 100, result: 400 });

const tidy = (value, cap) => { const text = String(value ?? '').replace(/\s+/g, ' ').trim(); return text ? Array.from(text).slice(0, cap).join('') : ''; };
const projectOf = session => session.projectName || (typeof session.cwd === 'string' ? session.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : '') || '';
const providerOf = session => session.provider || session.kind || null;
// One folder comparison for every reader of "in this project".
const folderKey = value => String(value).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const sameFolder = (left, right) => typeof left === 'string' && typeof right === 'string' && Boolean(left) && folderKey(left) === folderKey(right);

// Handles are assigned once per pane life, in inventory order, and never
// reused within a workspace: "T3" in the user's mouth must mean the same pane
// tomorrow. They persist with the conversation and survive "clear history".
function createTerminalHandles({ load = () => null, save = () => {} } = {}) {
  const loaded = load();
  const state = { next: Number.isSafeInteger(loaded?.next) && loaded.next > 0 ? loaded.next : 1,
    byId: loaded && typeof loaded.byId === 'object' && loaded.byId ? Object.fromEntries(Object.entries(loaded.byId).filter(([, handle]) => /^T\d{1,6}$/.test(String(handle)))) : {} };
  return {
    of(id) { return state.byId[id] || null; },
    assign(sessions = []) {
      let changed = false;
      for (const session of sessions) {
        if (!session || typeof session.id !== 'string' || state.byId[session.id]) continue;
        state.byId[session.id] = `T${state.next++}`; changed = true;
      }
      if (changed) save(this.snapshot());
      return changed;
    },
    snapshot() { return { next: state.next, byId: { ...state.byId } }; },
  };
}

// The model for the panes in view. `records` are pane-memory records by pane
// id; `workItems` the app's work items; `ledgerRows` the recent action ledger;
// `receipts` Lina's own action receipts, which say which panes she opened.
function buildTerminalModel({ sessions = [], handles, records = {}, workItems = [], ledgerRows = [], receipts = [] } = {}) {
  const live = (Array.isArray(sessions) ? sessions : []).filter(session => session && typeof session === 'object' && typeof session.id === 'string');
  handles?.assign(live);
  // Live owners first, so a pane whose cancelled item still carries a binding is
  // attributed to whatever is actually working in it. A released item remains
  // the task the user can still name when asking to continue it.
  const items = (Array.isArray(workItems) ? workItems : []).filter(item => item?.binding?.target?.id);
  const tasks = new Map();
  for (const item of [...items.filter(item => !RELEASED.has(item.status)), ...items.filter(item => RELEASED.has(item.status))]) {
    if (!tasks.has(item.binding.target.id)) tasks.set(item.binding.target.id, item);
  }
  // Lina's own creations, from her receipts: "that new terminal you just opened".
  const opened = new Map();
  for (const receipt of Array.isArray(receipts) ? receipts : []) {
    if (receipt?.kind === 'create_session' && receipt.status === 'created' && receipt.targetId) opened.set(receipt.targetId, Number(receipt.at) || 0);
  }
  const allRows = (Array.isArray(ledgerRows) ? ledgerRows : []).filter(row => row && typeof row === 'object');
  const rows = allRows.filter(row => row.pane?.id);
  const at = row => Number(row.at) || 0;
  // The newest delivery in the ledger: "the one you just prompted", and what
  // "the other one" is other than. Two panes delivered in the same moment tie.
  // The delivery is fresh while nothing from another request came after it;
  // right after a question or an answer there is no "one" to be other than.
  const deliveries = rows.filter(row => DELIVERED.has(row.outcome));
  const newest = deliveries.reduce((best, row) => at(row) > at(best) ? row : best, deliveries[0]);
  const lastWorked = newest ? { ids: new Set(deliveries.filter(row => at(row) === at(newest)).map(row => row.pane.id)), at: at(newest),
    fresh: !allRows.some(row => at(row) > at(newest) && row.requestId !== newest.requestId) } : null;
  return live.map(session => {
    const record = records?.[session.id] || {};
    const task = tasks.get(session.id);
    const owner = task && !RELEASED.has(task.status) ? task : undefined;
    const state = paneState(session);
    const mine = rows.filter(row => row.pane.id === session.id).sort((a, b) => at(b) - at(a));
    const latest = mine[0];
    const lastTouched = latest
      ? { by: 'lina', at: at(latest) || null, what: TOUCH[latest.verb] || String(latest.verb || 'touched'), delivered: DELIVERED.has(latest.outcome) }
      : session.turnId || session.turnStartedAt ? { by: 'user', at: Number(session.turnStartedAt) || null, what: 'prompt', delivered: true } : null;
    const on = tidy(owner?.objective || owner?.title || record.objective || record.lastPromptText, CAPS.on) || null;
    return {
      id: session.id, generation: session.generation, handle: handles?.of(session.id) || null,
      project: projectOf(session), cwd: typeof session.cwd === 'string' ? session.cwd : null,
      provider: providerOf(session), providerLabel: PROVIDER_LABELS[providerOf(session)] || providerOf(session) || 'terminal',
      name: paneDisplayName(session) || null,
      state, on,
      owner: owner ? 'lina' : lastTouched?.by === 'user' ? 'user' : null,
      // The task bound to the pane, live or released: its id is what a reuse
      // continues, its words are what the user may still name the pane by.
      task: task ? { id: task.id, status: task.status || null, title: task.title || null, objective: task.objective || task.text || null,
        ...(task.retriable === true && { retriable: true }) } : null,
      // Free for new work: verified, idle or never prompted, and nobody's.
      free: paneReadiness(session).free && !owner,
      lastTouched,
      opened: opened.has(session.id) ? { by: 'lina', at: opened.get(session.id) } : null,
      lastWorked: lastWorked?.ids.has(session.id) ? { at: lastWorked.at, fresh: lastWorked.fresh } : null,
      result: tidy(record.lastResultSummary, CAPS.result) || null,
      endedAt: Number(session.turnEndedAt) || Number(session.lastActivityAt) || null,
      activeAt: Math.max(Number(session.lastActivityAt) || 0, Number(session.turnEndedAt) || 0, Number(session.turnStartedAt) || 0) || null,
      needs: state === 'waiting' ? (session.attention?.reason === 'approval' ? 'approval' : 'answer') : null,
      observation: session.observation || null,
    };
  });
}

// What the pane is called when Lina speaks or writes about it: its handle,
// and its task when the sentence wants one. A pane with no handle yet (a
// directly built payload) is named by what it runs.
const spokenName = terminal => terminal?.handle || (terminal ? `${terminal.providerLabel} terminal` : 'the terminal');

// The Brain's only view of the panes: identity, state, task, ownership, the
// last touch and the last result. No board, launch, process or capability
// fields — those are execution and display metadata, not planning facts.
function rosterRows(terminals, { cwd, limit = 24 } = {}) {
  const inView = (Array.isArray(terminals) ? terminals : []).filter(terminal => !cwd || sameFolder(terminal.cwd, cwd));
  const recency = terminal => terminal.lastTouched?.at || 0;
  return inView.slice().sort((a, b) => recency(b) - recency(a)).slice(0, Math.max(0, limit)).map(terminal => {
    // Recency is the row order; a verified observation is the normal case and
    // goes unsaid; a pane with a task is known by it, not by its title. All
    // three keep the roster inside its four-kilobyte budget.
    const row = { id: terminal.id, handle: terminal.handle, name: terminal.on ? undefined : terminal.name, project: terminal.project,
      provider: terminal.provider, state: terminal.state, on: terminal.on, owner: terminal.owner,
      result: terminal.result ? terminal.result.slice(0, 200) : undefined,
      needs: terminal.needs, observation: terminal.observation === 'observed' ? undefined : terminal.observation };
    for (const key of Object.keys(row)) if (row[key] === undefined || row[key] === null || row[key] === '') delete row[key];
    return row;
  });
}

module.exports = { createTerminalHandles, buildTerminalModel, rosterRows, spokenName, sameFolder, PROVIDER_LABELS };
