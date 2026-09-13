'use strict';
// Pure assembly of the read-only phone view. No I/O, no clocks of its own: the
// caller supplies already-read records, projects, orchestrator state and screen
// text so the shape can be tested without an app or a server.

const CHAT_KINDS = new Set(['fusion', 'openfusion']);
const KIND_LABELS = {
  terminal: 'Terminal', codex: 'Codex', 'open-codex': 'Open Codex', 'codex-web': 'Codex Web',
  claude: 'Claude', 'claude-custom': 'Claude', cursor: 'Cursor', gemini: 'Gemini', opencode: 'OpenCode',
  kimi: 'Kimi', 'kimi-custom': 'Kimi', qwen: 'Qwen', grok: 'Grok', fusion: 'Fusion', openfusion: 'Open Fusion'
};
// Normalized buckets the phone renders. Raw provider wording stays in statusLabel
// so a new backend string degrades to "idle" rather than inventing a state.
const STATUS_MAP = new Map([
  ['running', 'working'], ['interrupt requested', 'working'],
  ['waiting', 'waiting'], ['needs input', 'waiting'],
  ['done', 'done'], ['completed', 'done'],
  ['failed', 'failed'],
  ['exited', 'exited'], ['interrupted', 'exited'],
  ['starting', 'starting'], ['awaiting activity', 'starting']
]);
// Eighty characters is a phone-width line. The rest was never drawn.
const SNIPPET_CHARS = 80;
const PROMPT_CHARS = 200;
// A TUI menu is drawn inside a frame, so the option text is the interior of the
// line. Strip the frame before matching; never strip anything that could be an
// option marker or a digit.
const LEADING_FRAME = new RegExp(`^[\\s${'│┃┆┇┊┋╎╏|'}]+`);
const TRAILING_FRAME = new RegExp(`[\\s${'│┃┆┇┊┋╎╏|'}]+$`);
// A rule, border or separator carries no prompt text.
const RULE_ONLY = /^[\s─-▟=_~*-]*$/;
// The menu row a provider actually draws: an optional selection marker, one
// digit, a separator, then the label.
const MENU_ROW = /^\s*[❯›>]?\s*(\d)[.)]\s+(.+)$/;
const YES_NO = /\((y|yes)\/(n|no)\)/i;
const MENU_WINDOW_LINES = 20;
const MIN_MENU_OPTIONS = 2;
const MAX_MENU_OPTIONS = 9;

function kindLabel(kind) { return KIND_LABELS[kind] || (typeof kind === 'string' && kind ? kind : 'Session'); }
function normalizeStatus(value) {
  return STATUS_MAP.get(String(value == null ? '' : value).trim().toLowerCase()) || 'idle';
}
function sessionTitle(record) {
  const candidates = [record?.conversationTitle, record?.conversation?.title, record?.terminalTitle, record?.name];
  const found = candidates.find(value => typeof value === 'string' && value.trim());
  return found ? found.trim() : kindLabel(record?.kind);
}
// The last line a person would actually be looking at. Blank tails are common
// while a TUI repaints, so the newest non-empty line is the truthful one.
function snippetFrom(text) {
  if (typeof text !== 'string' || !text) return '';
  const line = text.split('\n').map(value => value.replace(/\s+$/, '')).reverse().find(value => value.trim());
  return line ? line.trim().slice(-SNIPPET_CHARS) : '';
}
const text = value => (typeof value === 'string' ? value : '');
const time = value => (Number.isFinite(value) ? value : null);
// The terminal runtime publishes attention as an object — `{id, state, reason,
// updatedAt}`, the head of its approval ledger or the latest agent-attention
// event — while a hand-built or legacy record may still carry a bare boolean.
// Only `waiting` means a person is needed: `completed` and `failed` are turn
// outcomes, and `status` already carries those.
function needsAttention(value) {
  if (value === true) return true;
  return Boolean(value && typeof value === 'object' && value.state === 'waiting');
}

// -------------------------------------------------------------- needsInput ---
// What the pane is visibly waiting for, read off the screen the bridge already
// sampled. Evidence only: a menu that is drawn is reported, nothing is inferred
// from status, and an unrecognised screen is null rather than a guess.

function frameless(line) {
  return String(line == null ? '' : line).replace(LEADING_FRAME, '').replace(TRAILING_FRAME, '');
}
const blankLine = line => !line || RULE_ONLY.test(line);
// The question a menu answers is the closest line above it that is not another
// option, a frame rule or blank.
function promptAbove(lines, index) {
  for (let row = index - 1; row >= 0; row--) {
    const line = frameless(lines[row]);
    if (blankLine(line) || MENU_ROW.test(line)) continue;
    return line.trim().slice(0, PROMPT_CHARS);
  }
  return '';
}
function detectMenu(lines) {
  const start = Math.max(0, lines.length - MENU_WINDOW_LINES);
  let run = [];
  let best = null;
  for (let row = start; row <= lines.length; row++) {
    const match = row < lines.length ? MENU_ROW.exec(frameless(lines[row])) : null;
    if (match) { run.push({ row, key: match[1], label: match[2].trim().slice(0, PROMPT_CHARS) }); continue; }
    if (run.length >= MIN_MENU_OPTIONS && run.length <= MAX_MENU_OPTIONS) best = run;
    run = [];
  }
  if (!best) return null;
  // Repeated digits are a numbered listing, not a set of choices to tap.
  if (new Set(best.map(option => option.key)).size !== best.length) return null;
  return { kind: 'menu', prompt: promptAbove(lines, best[0].row),
    options: best.map(option => ({ key: option.key, label: option.label })) };
}
function detectYesNo(lines) {
  const line = lines.map(frameless).reverse().find(value => !blankLine(value));
  if (!line || !YES_NO.test(line)) return null;
  return { kind: 'yesno', prompt: line.trim().slice(0, PROMPT_CHARS),
    options: [{ key: 'y', label: 'Yes' }, { key: 'n', label: 'No' }] };
}
// The runtime's own approval evidence, for a screen this parser cannot read.
// `pendingInput` is deliberately not consulted: on a runtime snapshot it marks
// text the Orchestrator has dispatched and not yet observed, which is the
// opposite of the pane waiting on a person.
function detectApproval(record, lines) {
  const waiting = Array.isArray(record?.approvals) && record.approvals.length
    ? record.approvals[0]
    : record?.attention?.state === 'waiting' && record.attention.reason === 'approval' ? record.attention : null;
  if (!waiting) return null;
  const line = lines.map(frameless).reverse().find(value => !blankLine(value));
  return { kind: 'approval', prompt: (line ? line.trim() : 'Waiting for approval').slice(0, PROMPT_CHARS), options: [] };
}
// A drawn menu is the most useful answer, then an explicit (y/n), then the
// runtime's approval evidence.
function detectNeedsInput(screenText, record = null) {
  const lines = (typeof screenText === 'string' ? screenText : '').split('\n').map(line => line.replace(/\s+$/, ''));
  return detectMenu(lines) || detectYesNo(lines) || detectApproval(record, lines) || null;
}

// Same path, written two ways. A pane's cwd is almost always its project's
// path, and repeating it once per session is the single biggest thing the
// phone view used to carry for nothing.
function samePath(left, right) {
  const clean = value => String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return Boolean(left) && clean(left) === clean(right);
}
function buildSession(record, { projects, screens }) {
  const project = projects.find(item => item.id === record.projectId);
  const status = normalizeStatus(record.status);
  const statusLabel = text(record.status);
  const cwd = text(record.cwd);
  const session = {
    id: text(record.id), generation: record.generation ?? null,
    projectId: project ? project.id : null,
    projectName: project ? text(project.name) : '',
    title: sessionTitle(record),
    kind: text(record.kind) || 'terminal',
    provider: text(record.provider) || text(record.kind) || 'terminal',
    isChat: CHAT_KINDS.has(record.kind),
    status,
    lastActivityAt: time(record.lastActivityAt) ?? time(record.lastOutputAt),
    attention: needsAttention(record.attention),
    snippet: snippetFrom(screens?.[text(record.id)]),
    // Computed here, from the screen text the caller already sampled, so an
    // idle workspace with no phone polling pays nothing for it.
    needsInput: detectNeedsInput(screens?.[text(record.id)], record)
  };
  // Only what the phone cannot already work out: the raw provider wording when
  // it says more than the normalized bucket, and the working directory when it
  // is not simply the project's path.
  if (statusLabel && statusLabel !== status) session.statusLabel = statusLabel;
  if (cwd && !samePath(cwd, project?.path)) session.cwd = cwd;
  return session;
}

function buildState({ records = [], projects = [], orchestrator = null, screens = {}, now = Date.now() } = {}) {
  const cleanProjects = projects.filter(project => project && typeof project.id === 'string')
    .map(project => ({ id: project.id, name: text(project.name) || text(project.path), path: text(project.path) }));
  const sessions = records.filter(record => record && typeof record.id === 'string' && record.id)
    .map(record => buildSession(record, { projects: cleanProjects, screens }));
  const counted = cleanProjects.map(project => {
    const counts = { working: 0, waiting: 0, done: 0, failed: 0 };
    for (const session of sessions) {
      if (session.projectId !== project.id) continue;
      if (counts[session.status] !== undefined) counts[session.status]++;
    }
    return { ...project, counts };
  });
  const messages = Array.isArray(orchestrator?.messages) ? orchestrator.messages : [];
  return {
    at: now,
    projects: counted,
    sessions,
    orchestrator: {
      enabled: orchestrator?.enabled === true,
      ready: orchestrator?.ready === true,
      // Targets the relay currently considers in flight; not a task total.
      activeCount: Array.isArray(orchestrator?.activeTargets) ? orchestrator.activeTargets.length : 0,
      lastMessageAt: time(messages.at(-1)?.at)
    }
  };
}

// Everything a phone would repaint for, and nothing that ticks on its own: `at`
// is excluded so an idle workspace does not burn a long poll every rebuild.
function fingerprint(state) {
  return JSON.stringify([
    (state?.projects || []).map(project => [project.id, project.name, project.path, project.counts.working, project.counts.waiting, project.counts.done, project.counts.failed]),
    // An omitted statusLabel/cwd still has to move the fingerprint when it
    // starts or stops being omitted, so they are read as null rather than skipped.
    (state?.sessions || []).map(session => [session.id, session.generation, session.projectId, session.projectName, session.title,
      session.kind, session.provider, session.isChat, session.status, session.statusLabel ?? null, session.cwd ?? null,
      session.lastActivityAt, session.attention, session.snippet, session.needsInput]),
    [state?.orchestrator?.enabled, state?.orchestrator?.ready, state?.orchestrator?.activeCount, state?.orchestrator?.lastMessageAt]
  ]);
}

module.exports = { buildState, fingerprint, normalizeStatus, sessionTitle, snippetFrom, kindLabel,
  detectNeedsInput, needsAttention, samePath, CHAT_KINDS, SNIPPET_CHARS, PROMPT_CHARS };
