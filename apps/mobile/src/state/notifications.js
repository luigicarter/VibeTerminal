'use strict';

/**
 * What is worth waking somebody's phone for, in one pure module.
 *
 * Three things happen on a desktop that a person who is not looking at it wants
 * to know about:
 *
 * - a terminal starts asking them something (`needsInput` becomes non-null),
 * - a terminal that was working stops (done, exited, or failed),
 * - the Orchestrator answers.
 *
 * Everything else — a snippet changing, a spinner turning, a status going from
 * `idle` to `working` — is the desktop getting on with it, and is not a
 * notification.
 *
 * Deciding that is a *comparison*, so it has to be a function of two snapshots
 * rather than of one state: this module takes the last snapshot the phone saw
 * and the one that just arrived, and returns the notifications that difference
 * earns. Both the foreground long poll in `bridge.tsx` and the background task
 * run exactly this, which is why the phone cannot notify twice for one event or
 * disagree with itself about which path noticed it.
 *
 * Plain CommonJS, like the app's other shared-with-the-tests modules, so Metro
 * and `node --test` run the same code.
 */

/** Statuses that mean the terminal has stopped for good. */
const FINISHED_STATUSES = ['done', 'exited'];
const FAILED_STATUSES = ['failed'];

/**
 * How many individual notifications one comparison may produce. A phone that
 * has been asleep for an hour can come back to twenty changed terminals, and
 * twenty notifications is not information, it is a wall. Past this the rest are
 * collapsed into one line that says how many there were.
 */
const MAX_ITEMS = 4;

/** The channel every one of these is posted on. */
const CHANNEL_ID = 'terminals';
const CHANNEL_NAME = 'Terminals';

/** A body line can only be so long before a notification truncates it anyway. */
const MAX_BODY = 140;

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function firstLine(value) {
  const source = text(value);
  if (!source) return '';
  const line = source.split('\n').find(entry => entry.trim()) || '';
  const trimmed = line.trim();
  return trimmed.length > MAX_BODY ? `${trimmed.slice(0, MAX_BODY - 1)}…` : trimmed;
}

function millis(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/**
 * @typedef {Object} NotificationSession
 * @property {string} id
 * @property {string} title
 * @property {string} status
 * @property {boolean} needs whether the terminal is parked on a prompt
 * @property {string} prompt the first line of that prompt, when there is one
 * @property {string} snippet the terminal's own last line
 */

/**
 * @typedef {Object} NotificationSnapshot
 * @property {number} at when this snapshot was taken
 * @property {NotificationSession[]} sessions
 * @property {{lastMessageAt: number|null, snippet: string}} orchestrator
 */

/**
 * @typedef {Object} NotificationItem
 * @property {string} key stable per event, so a repeat replaces rather than stacks
 * @property {'needs-input'|'finished'|'failed'|'replied'|'more'} kind
 * @property {string|null} sessionId the terminal to open when it is tapped
 * @property {string} title
 * @property {string} body
 */

/**
 * Reduce a `/api/state` body to the parts a notification decision depends on.
 *
 * @param {any} state the `/api/state` response, or null
 * @param {{orchestratorSnippet?: string, now?: number}} [options]
 * @returns {NotificationSnapshot}
 */
function snapshotFromState(state, options) {
  const opts = options || {};
  const sessions = Array.isArray(state && state.sessions) ? state.sessions : [];
  const orchestrator = (state && state.orchestrator) || {};
  return {
    at: typeof opts.now === 'number' ? opts.now : Date.now(),
    sessions: sessions
      .filter(session => session && typeof session.id === 'string' && session.id)
      .map(session => {
        const prompt = session.needsInput && typeof session.needsInput === 'object'
          ? firstLine(session.needsInput.prompt)
          : '';
        return {
          id: session.id,
          title: text(session.title) || 'Terminal',
          status: text(session.status),
          // A `needsInput` object with neither a prompt nor options is not a
          // prompt; `needsInput.js` reads it the same way for the UI.
          needs: Boolean(
            session.needsInput &&
              typeof session.needsInput === 'object' &&
              (prompt ||
                (Array.isArray(session.needsInput.options) && session.needsInput.options.length > 0))
          ),
          prompt,
          snippet: firstLine(session.snippet),
        };
      }),
    orchestrator: {
      lastMessageAt: millis(orchestrator.lastMessageAt),
      snippet: firstLine(opts.orchestratorSnippet),
    },
  };
}

/**
 * The snapshot as it is persisted between launches.
 *
 * Only what a comparison reads survives — the id, the status and whether the
 * terminal is asking something — because every notification's *words* come from
 * the snapshot that just arrived, never from the stored one. That keeps the
 * stored value small, which matters: it lives in `expo-secure-store`, which
 * warns past two kilobytes.
 *
 * @param {NotificationSnapshot} snapshot
 */
function compactSnapshot(snapshot) {
  return {
    v: 1,
    at: snapshot.at,
    s: snapshot.sessions.map(session => [session.id, session.status, session.needs ? 1 : 0]),
    o: snapshot.orchestrator.lastMessageAt,
  };
}

/**
 * Read a persisted snapshot back. Titles and prompts come back empty, which is
 * correct — nothing reads them from the previous side of a comparison.
 *
 * @param {unknown} value
 * @returns {NotificationSnapshot|null}
 */
function expandSnapshot(value) {
  if (!value || typeof value !== 'object') return null;
  const raw = /** @type {any} */ (value);
  if (raw.v !== 1 || !Array.isArray(raw.s)) return null;
  return {
    at: typeof raw.at === 'number' ? raw.at : 0,
    sessions: raw.s
      .filter(entry => Array.isArray(entry) && typeof entry[0] === 'string')
      .map(entry => ({
        id: entry[0],
        title: '',
        status: typeof entry[1] === 'string' ? entry[1] : '',
        needs: entry[2] === 1 || entry[2] === true,
        prompt: '',
        snippet: '',
      })),
    orchestrator: { lastMessageAt: millis(raw.o), snippet: '' },
  };
}

/**
 * What changed between two snapshots that is worth a notification.
 *
 * Edge-triggered throughout: a terminal that is *still* asking, or that has
 * *stayed* finished, produces nothing, however many times the state is polled.
 * With no previous snapshot nothing is produced at all — the first sight of a
 * desktop is not news, it is the baseline.
 *
 * A terminal the phone has never seen before counts as "was not asking", so a
 * terminal that appears already parked on a prompt does notify; it cannot
 * produce a "finished", because that edge requires a previous `working`.
 *
 * @param {NotificationSnapshot|null|undefined} previous
 * @param {NotificationSnapshot} next
 * @returns {NotificationItem[]}
 */
function diffNotifications(previous, next) {
  if (!previous || !next) return [];
  const before = new Map();
  for (const session of previous.sessions || []) before.set(session.id, session);

  /** @type {NotificationItem[]} */
  const items = [];
  for (const session of next.sessions || []) {
    const was = before.get(session.id);

    // Asking is the more urgent of the two, and a terminal cannot usefully
    // report both in one update, so it wins.
    if (session.needs && !(was && was.needs)) {
      items.push({
        key: `needs:${session.id}:${session.prompt}`,
        kind: 'needs-input',
        sessionId: session.id,
        title: `${session.title} needs you`,
        body: session.prompt || session.snippet || 'Waiting for an answer.',
      });
      continue;
    }

    if (!was || was.status !== 'working') continue;
    if (FAILED_STATUSES.includes(session.status)) {
      items.push({
        key: `end:${session.id}:${session.status}`,
        kind: 'failed',
        sessionId: session.id,
        title: `${session.title} failed`,
        body: session.snippet || 'The terminal stopped with an error.',
      });
    } else if (FINISHED_STATUSES.includes(session.status)) {
      items.push({
        key: `end:${session.id}:${session.status}`,
        kind: 'finished',
        sessionId: session.id,
        title: `${session.title} finished`,
        body: session.snippet || 'The terminal has stopped working.',
      });
    }
  }

  const wasAt = previous.orchestrator ? previous.orchestrator.lastMessageAt : null;
  const nowAt = next.orchestrator ? next.orchestrator.lastMessageAt : null;
  if (typeof nowAt === 'number' && (wasAt === null || nowAt > wasAt)) {
    items.push({
      key: `replied:${nowAt}`,
      kind: 'replied',
      sessionId: null,
      title: 'Lina replied',
      body: (next.orchestrator && next.orchestrator.snippet) || 'The Orchestrator has answered.',
    });
  }

  if (items.length <= MAX_ITEMS) return items;
  const rest = items.length - MAX_ITEMS;
  return items.slice(0, MAX_ITEMS).concat([
    {
      key: `more:${next.at}`,
      kind: 'more',
      sessionId: null,
      title: 'Lina Terminal',
      body: `and ${rest} more update${rest === 1 ? '' : 's'}`,
    },
  ]);
}

module.exports = {
  CHANNEL_ID,
  CHANNEL_NAME,
  FAILED_STATUSES,
  FINISHED_STATUSES,
  MAX_ITEMS,
  compactSnapshot,
  diffNotifications,
  expandSnapshot,
  snapshotFromState,
};
