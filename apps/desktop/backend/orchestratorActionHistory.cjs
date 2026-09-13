'use strict';

// What Lina herself did recently, expressed as panes rather than as prose.
//
// "That new terminal you just opened", "put it in the one you sent to" and "the
// codex terminal you just created" are questions about the application's own
// actions, and the application already holds the answer in its action receipts.
// This module is the small read-only interface over that evidence: three
// questions, each answered from receipts reconciled against the live session
// list, so a pane that has since closed is never offered.
//
// Phase 2 of the overhaul replaces the receipt scan with the structured action
// ledger (`orchestratorLedger.cjs`). Keep this interface minimal so that swap is
// a reimplementation of three functions and nothing else: no model call, no I/O,
// no mutation, and no knowledge of work items or grants.
//
// createActionHistory({ getReceipts, getTasks, getSessions, now, sameCwd })
//   lastCreatedPane({ cwd, withinMs }) -> the live session Lina most recently
//     created in that project, within the window (default 30 minutes).
//   lastTargetPane({ cwd })            -> the live session Lina most recently
//     typed into (send_prompt or terminal_interact) in that project.
//   recentPanes({ cwd, limit })        -> live sessions Lina touched, most
//     recent action first.

const DEFAULT_WINDOW_MS = 30 * 60 * 1000;
const TARGET_KINDS = new Set(['send_prompt', 'terminal_interact']);
// A receipt that reports its own refusal is not evidence that Lina used a pane.
const REFUSED = new Set(['rejected', 'blocked', 'not-dispatched', 'launch-failed', 'superseded', 'cancelled', 'stale-generation', 'unavailable']);

function normalizePath(value) {
  const text = String(value ?? '');
  if (!text) return '';
  const windows = process.platform === 'win32' || /^[A-Za-z]:[\\/]/.test(text);
  const normalized = (windows ? require('node:path').win32 : require('node:path').posix).normalize(text).replace(/\\/g, '/').replace(/\/+$/, '');
  return windows ? normalized.toLowerCase() : normalized;
}
const defaultSameCwd = (a, b) => Boolean(a && b && normalizePath(a) === normalizePath(b));

function createActionHistory({ getReceipts = () => [], getTasks = () => [], getSessions = () => [], now = Date.now, sameCwd = defaultSameCwd } = {}) {
  const receipts = () => { const value = getReceipts(); return Array.isArray(value) ? value : []; };
  const sessions = () => { const value = getSessions(); return Array.isArray(value) ? value : []; };
  // Cancelled requests never happened from the user's point of view, so their
  // delivery receipts cannot answer "the one you sent to". A pane they created
  // is still open, so creation deliberately ignores this.
  const cancelledRequests = () => {
    const value = getTasks();
    return new Set((Array.isArray(value) ? value : []).filter(task => task && task.status === 'cancelled').map(task => task.requestId));
  };
  // The live pane a receipt names, or undefined when it has closed or been
  // replaced. A receipt without a recorded generation identifies the pane only
  // by id; a receipt with one must still match the running generation.
  function livePane(receipt, cwd) {
    if (!receipt?.targetId) return undefined;
    const session = sessions().find(item => item && item.id === receipt.targetId &&
      (receipt.generation === undefined || receipt.generation === null || item.generation === receipt.generation) &&
      (receipt.launchToken === undefined || item.launchToken === undefined || item.launchToken === receipt.launchToken));
    if (!session || (cwd && !sameCwd(session.cwd, cwd))) return undefined;
    return session;
  }
  function scan(match, { cwd, withinMs } = {}) {
    const list = receipts(), deadline = Number.isFinite(withinMs) ? now() - withinMs : undefined;
    for (let index = list.length - 1; index >= 0; index--) {
      const receipt = list[index];
      if (!receipt || deadline !== undefined && Number(receipt.at) < deadline) continue;
      if (!match(receipt)) continue;
      const session = livePane(receipt, cwd);
      if (session) return { session, receipt };
    }
    return undefined;
  }
  return {
    lastCreatedPane({ cwd, withinMs = DEFAULT_WINDOW_MS } = {}) {
      // Creation records its launch directory on the receipt itself, so a pane
      // whose shell has since changed directory still belongs to its project.
      return scan(receipt => receipt.kind === 'create_session' && receipt.status === 'created' &&
        (!cwd || !receipt.cwd || sameCwd(receipt.cwd, cwd)), { cwd, withinMs })?.session;
    },
    lastTargetPane({ cwd } = {}) {
      const cancelled = cancelledRequests();
      return scan(receipt => TARGET_KINDS.has(receipt.kind) && !REFUSED.has(receipt.status) &&
        !(receipt.requestId && cancelled.has(receipt.requestId)), { cwd })?.session;
    },
    recentPanes({ cwd, limit = 5 } = {}) {
      const bound = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 50) : 5;
      const list = receipts(), seen = new Set(), found = [];
      for (let index = list.length - 1; index >= 0 && found.length < bound; index--) {
        const receipt = list[index];
        if (!receipt || !receipt.targetId || seen.has(receipt.targetId)) continue;
        const session = livePane(receipt, cwd);
        if (!session) continue;
        seen.add(receipt.targetId);
        found.push(session);
      }
      return found;
    },
  };
}

module.exports = { createActionHistory, DEFAULT_WINDOW_MS };
