'use strict';

// Tier 1 of the brain's memory: one structured line per settled request, written
// by the application from its own receipts and waits. It replaces the raw window
// of prior conversation prose, so "put in that prompt", "the one you just
// opened", "what was the last prompt?" and "what was that error?" resolve from
// recorded facts. A ledger line is reference data about what Lina did; it never
// carries authority and never restores a grant.
const LEDGER_LIMIT = 200;
const VERBS = Object.freeze(['start', 'follow_up', 'open', 'close', 'answer', 'ask', 'status', 'results', 'inspect', 'cancel', 'failed']);
const OUTCOMES = Object.freeze(['delivered-started', 'delivered-unconfirmed', 'refused', 'created-only', 'answered', 'closed', 'failed', 'cancelled', 'replied']);
const CAPS = Object.freeze({ requestId: 200, project: 120, typedText: 300, error: 200, paneId: 200, paneName: 120, paneProvider: 40, cwd: 1024 });
// Evidence that the prompt actually reached a working agent, as the delivery
// substrate records it on the wait. Anything weaker stays "unconfirmed".
const STARTED_STATES = new Set(['running', 'busy', 'starting', 'submitted-observed']);
const WORK_KINDS = new Set(['delegate_task', 'send_prompt', 'operate_terminal']);
const PROMPT_KINDS = new Set(['delegate_task', 'send_prompt', 'operate_terminal', 'stage_draft']);

const bytes = value => Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');
function text(value, cap) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, cap) : null;
}

function normalizePane(value) {
  if (!value || typeof value !== 'object') return null;
  const id = text(value.id, CAPS.paneId);
  if (!id) return null;
  return { id, name: text(value.name, CAPS.paneName), provider: text(value.provider, CAPS.paneProvider) };
}

// A ledger row is fully typed: strings within their caps, finite numbers, or
// null. Anything else is dropped rather than persisted or shown to a model.
function normalizeEntry(entry, fallbackAt) {
  if (!entry || typeof entry !== 'object') return null;
  const requestId = text(entry.requestId, CAPS.requestId);
  if (!requestId || !VERBS.includes(entry.verb) || !OUTCOMES.includes(entry.outcome)) return null;
  const at = Number.isFinite(Number(entry.at)) ? Number(entry.at) : Number(fallbackAt);
  if (!Number.isFinite(at)) return null;
  return { requestId, at, verb: entry.verb, project: text(entry.project, CAPS.project), pane: normalizePane(entry.pane),
    typedText: text(entry.typedText, CAPS.typedText), outcome: entry.outcome, error: text(entry.error, CAPS.error),
    ...(text(entry.cwd, CAPS.cwd) && { cwd: text(entry.cwd, CAPS.cwd) }) };
}

const sameFolder = (left, right) => {
  const identity = value => String(value).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return typeof left === 'string' && typeof right === 'string' && Boolean(left) && identity(left) === identity(right);
};

function createLedger({ now = Date.now, limit = LEDGER_LIMIT } = {}) {
  const size = Math.max(1, Math.min(LEDGER_LIMIT, Number(limit) || LEDGER_LIMIT));
  let entries = [];
  function trim() { if (entries.length > size) entries = entries.slice(-size); }
  return {
    // One row per request: the settle point writes it, a later resolved wait
    // updates the same row rather than appending a second version of one action.
    record(entry) {
      const normalized = normalizeEntry(entry, now());
      if (!normalized) return null;
      const index = entries.findIndex(item => item.requestId === normalized.requestId);
      if (index >= 0) { normalized.at = entries[index].at; entries[index] = normalized; }
      else entries.push(normalized);
      trim();
      return { ...normalized };
    },
    list({ cwd, limit: count } = {}) {
      const selected = cwd ? entries.filter(entry => sameFolder(entry.cwd, cwd)) : entries;
      const bounded = Number.isFinite(Number(count)) ? selected.slice(-Math.max(0, Math.floor(Number(count)))) : selected;
      return bounded.map(entry => ({ ...entry }));
    },
    last() { const entry = entries.at(-1); return entry ? { ...entry } : null; },
    clear() { entries = []; },
    snapshot() { return entries.map(entry => ({ ...entry })); },
    restore(value) {
      entries = (Array.isArray(value) ? value : []).map(item => normalizeEntry(item, now())).filter(Boolean);
      trim();
      return entries.length;
    },
    get size() { return entries.length; },
  };
}

// The brain-facing projection: the newest rows within a fixed byte budget, with
// the folder path (an execution detail) dropped. Oldest rows go first so the
// most recent action, which every "that one"/"the last prompt" reference means,
// always survives.
function planningLedger(entries, { limit = 8, maxBytes = 2048 } = {}) {
  let rows = (Array.isArray(entries) ? entries : []).slice(-Math.max(0, limit))
    .map(({ cwd, ...entry }) => entry); // eslint-disable-line no-unused-vars
  while (rows.length > 1 && bytes(rows) > maxBytes) rows = rows.slice(1);
  if (rows.length === 1 && bytes(rows) > maxBytes) {
    const [only] = rows;
    rows = [{ ...only, typedText: only.typedText ? only.typedText.slice(0, 120) : null, error: only.error ? only.error.slice(0, 80) : null }];
  }
  return rows;
}

// Verb and outcome come from the compiled plan and the delivery substrate's own
// records, never from model prose. Both enums are closed: an unrecognized shape
// falls back to the conversational verb and the "replied" outcome rather than
// inventing a claim about a terminal.
function ledgerVerb({ plan, status, continuing } = {}) {
  if (status === 'cancelled') return 'cancel';
  if (!plan) return 'failed';
  const kinds = new Set((plan.grants || []).map(grant => grant.kind));
  // A continuation is what the plan itself says it is: an existing-owner
  // assignment, or an explicitly continued pending command.
  const continues = continuing ?? (Boolean(plan.continuationOf) || (plan.grants || []).some(grant => grant.args?.assignmentMode === 'existing'));
  if (plan.responseKind === 'task-status') return 'status';
  if (plan.responseKind === 'terminal-inspection' || kinds.has('inspect_terminal') || (plan.grants || []).some(grant => grant.inspection)) return 'inspect';
  if (kinds.has('close')) return 'close';
  if (kinds.has('answer_question') || kinds.has('permission')) return 'answer';
  if ([...kinds].some(kind => WORK_KINDS.has(kind))) return continues ? 'follow_up' : 'start';
  if (kinds.has('create_session') || kinds.has('stage_draft')) return 'open';
  return 'ask';
}

function ledgerOutcome({ status, waits = [], receipts = [], failed = false } = {}) {
  if (status === 'cancelled') return { outcome: 'cancelled', error: null };
  const submissions = (waits || []).filter(wait => wait && wait.source !== 'watch');
  const refused = submissions.find(wait => wait.failed);
  if (refused) return { outcome: 'refused', error: text(refused.error, CAPS.error) };
  // observedState tracks the pane live, so it reads "completed" once the turn
  // the prompt started has ended. An attributed turn that ran to completion is
  // stronger evidence of a started prompt than catching it mid-run, and losing
  // it would report finished work back as "delivered but unconfirmed".
  const started = submissions.find(wait => wait.delivered &&
    (STARTED_STATES.has(wait.observedState) || (wait.done && !wait.failed && Boolean(wait.turnId))));
  if (started) return { outcome: 'delivered-started', error: null };
  if (submissions.some(wait => wait.delivered)) return { outcome: 'delivered-unconfirmed', error: null };
  if (status === 'needs-answer') return { outcome: 'answered', error: null };
  // Only an acknowledged effect counts. A rejected close or creation receipt is
  // a refusal, not an outcome to report back as done.
  const closed = (receipts || []).find(item => item.kind === 'close' && ['closed', 'close_requested', 'acknowledged', 'stopped', 'already-absent'].includes(item.status));
  if (closed) return { outcome: 'closed', error: null };
  const created = (receipts || []).find(item => item.kind === 'create_session' && ['created', 'acknowledged'].includes(item.status));
  if (created) return { outcome: 'created-only', error: null };
  if (failed || status === 'failed') return { outcome: 'failed', error: null };
  return { outcome: 'replied', error: null };
}

// The single derivation used by the settle point and by its tests.
function deriveLedgerEntry({ requestId, at, plan, status, waits = [], receipts = [], sessions = [], projects = [], project, cwd, continuing, failed = false, error, typedText } = {}) {
  const verb = ledgerVerb({ plan, status, continuing });
  const resolved = ledgerOutcome({ status, waits, receipts, failed });
  const submissions = (waits || []).filter(wait => wait && wait.source !== 'watch');
  const paneId = submissions.find(wait => wait.targetId)?.targetId
    || (receipts || []).find(item => item.targetId)?.targetId
    || (plan?.grants || []).flatMap(grant => grant.targets || []).find(target => target?.id)?.id || null;
  const session = paneId && (sessions || []).find(item => item.id === paneId);
  const prompt = typedText ?? (plan?.grants || []).filter(grant => PROMPT_KINDS.has(grant.kind))
    .map(grant => grant.text).find(value => typeof value === 'string' && value.trim());
  // A request that never named a project still happened somewhere: the pane it
  // touched says where, and a registered project supplies the name the user uses.
  const folder = cwd || session?.cwd || (receipts || []).find(item => item.cwd)?.cwd || null;
  const named = project || (folder && (projects || []).find(entry => sameFolder(entry?.path, folder))?.name)
    || (folder ? require('node:path').basename(folder) : null);
  return normalizeEntry({
    requestId, at, verb, project: named, cwd: folder,
    pane: paneId ? { id: paneId, name: session?.conversationTitle || session?.name, provider: session?.kind || session?.provider } : null,
    typedText: prompt, outcome: resolved.outcome, error: resolved.error ?? error,
  }, at);
}

module.exports = { createLedger, planningLedger, deriveLedgerEntry, ledgerVerb, ledgerOutcome, normalizeEntry, LEDGER_LIMIT, VERBS, OUTCOMES };
