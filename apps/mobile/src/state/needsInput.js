'use strict';

/**
 * The prompt a terminal is parked on, in one place.
 *
 * `/api/state` sessions carry `needsInput: null | {kind, prompt, options}` when
 * the desktop can see that the agent is waiting for an answer. The app turns
 * that into a card of one-tap chips, a "NEEDS YOU" pill on the terminal's row,
 * and a project tally that counts the terminal as waiting whatever status the
 * desktop gave it.
 *
 * Plain CommonJS so both the app (through Metro) and `node --test` can use the
 * exact same functions.
 */

const NEEDS_INPUT_KINDS = ['menu', 'yesno', 'approval'];

/** More than this many options is a parse gone wrong, not a prompt. */
const MAX_OPTIONS = 8;

/**
 * Read a session's `needsInput` defensively: the desktop parses it out of a
 * terminal screen, so anything can arrive.
 *
 * @param {unknown} value
 * @returns {{kind: 'menu'|'yesno'|'approval', prompt: string, options: Array<{key: string, label: string}>}|null}
 */
function normalizeNeedsInput(value) {
  if (!value || typeof value !== 'object') return null;
  const raw = /** @type {{kind?: unknown, prompt?: unknown, options?: unknown}} */ (value);
  const kind = NEEDS_INPUT_KINDS.includes(/** @type {string} */ (raw.kind))
    ? /** @type {string} */ (raw.kind)
    : 'menu';
  const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : '';
  const options = [];
  if (Array.isArray(raw.options)) {
    for (const entry of raw.options) {
      if (!entry || typeof entry !== 'object') continue;
      const key = typeof entry.key === 'string' ? entry.key.trim() : '';
      if (!key) continue;
      const label = typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim() : key;
      options.push({ key, label });
      if (options.length >= MAX_OPTIONS) break;
    }
  }
  // A prompt with nothing to answer, or answers with nothing asked, is still
  // worth showing; a payload with neither is not a prompt at all.
  if (!prompt && options.length === 0) return null;
  return { kind, prompt, options };
}

/**
 * Is this session holding for a person?
 *
 * @param {{needsInput?: unknown}|null|undefined} session
 * @returns {boolean}
 */
function sessionNeedsInput(session) {
  return normalizeNeedsInput(session && session.needsInput) !== null;
}

/**
 * The project tally, with terminals that are waiting on a prompt counted under
 * waiting. The desktop may still call such a terminal "working" — it has a
 * process alive — but to the person looking at the phone it is waiting for them.
 *
 * @param {{working?: number, waiting?: number, done?: number, failed?: number}|null|undefined} counts
 * @param {Array<{status?: string, needsInput?: unknown}>} sessions the sessions of that project
 */
function countsWithNeedsInput(counts, sessions) {
  const next = {
    working: Number(counts && counts.working) || 0,
    waiting: Number(counts && counts.waiting) || 0,
    done: Number(counts && counts.done) || 0,
    failed: Number(counts && counts.failed) || 0,
  };
  for (const session of sessions || []) {
    if (!sessionNeedsInput(session)) continue;
    if (session.status === 'waiting') continue;
    const bucket = String(session.status);
    // Only the four tallied statuses can give a count back; idle, starting and
    // exited are not counted at all, so nothing is taken from them.
    if (Object.prototype.hasOwnProperty.call(next, bucket) && next[bucket] > 0) next[bucket] -= 1;
    next.waiting += 1;
  }
  return next;
}

/**
 * The inbox on the home screen: every terminal that is holding for the person
 * holding the phone, whether the desktop parsed a prompt out of it or simply
 * called it waiting.
 *
 * The order is the one the phone cares about: a parsed prompt first (there is
 * something to tap), then the rest, most recent first.
 *
 * @template {{status?: string, needsInput?: unknown, lastActivityAt?: unknown}} T
 * @param {readonly T[]} sessions
 * @returns {T[]} the same session objects, filtered and ordered
 */
function waitingForYou(sessions) {
  const wanted = (sessions || []).filter(
    session => session && (sessionNeedsInput(session) || session.status === 'waiting')
  );
  return wanted
    .map((session, index) => ({ session, index }))
    .sort((a, b) => {
      const byPrompt = Number(sessionNeedsInput(b.session)) - Number(sessionNeedsInput(a.session));
      if (byPrompt !== 0) return byPrompt;
      const at = activityMillis(a.session.lastActivityAt);
      const bt = activityMillis(b.session.lastActivityAt);
      if (bt !== at) return bt - at;
      return a.index - b.index;
    })
    .map(entry => entry.session);
}

function activityMillis(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

/**
 * The one line of a prompt an inbox row can show: its first line, or the
 * terminal's own snippet when the desktop saw no prompt at all.
 *
 * @param {{needsInput?: unknown, snippet?: unknown}|null|undefined} session
 * @returns {string}
 */
function promptLine(session) {
  const parsed = normalizeNeedsInput(session && session.needsInput);
  const source = parsed && parsed.prompt ? parsed.prompt : String((session && session.snippet) || '');
  const first = source.split('\n').find(line => line.trim()) || '';
  return first.trim();
}

module.exports = {
  MAX_OPTIONS,
  NEEDS_INPUT_KINDS,
  countsWithNeedsInput,
  normalizeNeedsInput,
  promptLine,
  sessionNeedsInput,
  waitingForYou,
};
