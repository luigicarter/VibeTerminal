'use strict';
// A pane that has never taken a prompt: no turn has started, ended, or been
// identified. Nothing about it can be attributed to a conversation yet.
const neverPrompted = session => !session?.turnId && !session?.turnStartedAt && !session?.turnEndedAt;

// One answer to "what state is this pane in", for every caller that used to
// decide it privately. Six predicates asked overlapping questions of the same
// snapshot — launcher readiness, creation readiness, delivery classification,
// busy-prompt health, idle-target availability and idle-pane reuse — and where
// they disagreed a pane counted as free or busy depending on which one ran.
//
// Four orthogonal facts, plus the first reason one of them is false:
//   process          — the pane's own processes are up and its launch finished.
//   composerVerified — the input recipient is identified and uncontested.
//   named            — its native conversation is established, so reuse can say
//                      which conversation a pane belongs to.
//   idle             — no turn and no pending decision.
// A caller takes the facts it needs; none of them re-derives the rule. `named`
// is separate from `composerVerified` because the two genuinely differed: the
// delivery queue only ever needed a live recipient, while launch readiness and
// idle-pane reuse also need a conversation they can name.
//
// Deliberate choices where the old predicates disagreed (see
// docs/codex-idle-sparkle-and-input-fence-2026-09-13.md):
//  - A provisional pane that has never taken a turn IS verified. Requiring a
//    confirmed native identity made every never-prompted pane permanently
//    unusable, because for some providers identity only appears after the first
//    prompt. Once a pane has taken any turn, confirmed observation is required
//    again: reuse then means joining a conversation we must be able to name.
//  - `manualInputPending` — the conservative keystroke latch the PTY host sets
//    on any key that is not Enter or Ctrl-C, and never clears on output — still
//    makes a pane un-idle, because that is a question about CHOOSING a pane and
//    another pane costs nothing. It does NOT decide whether to write: that is
//    taken from the decoded composer, at the one place that can see it
//    (backend/orchestratorInputSurface.cjs). Selection stays conservative;
//    writing stopped being.
//  - A pane whose own status or child work says it is waiting or busy is not
//    'ready' for its launch label either, where `sessionReady` used to read only
//    its turn state and call a pane with a child awaiting approval ready.
//  - A turn state nobody recognizes is neither idle nor busy: it reports
//    'unknown-turn', which callers treat as unverified rather than as work in
//    flight, exactly as the delivery classifier always did.
//  - Structured chat panes (Fusion, Open Fusion) have no terminal composer, so
//    their `composerVerified` is their process readiness. Their turn facts are
//    still read, because delivery queues behind a running chat turn.

const STRUCTURED_KINDS = new Set(['fusion', 'openfusion']);
const IDLE_TURN_STATES = new Set(['idle', 'completed', 'response', 'interrupted']);
const STOPPED_STATUSES = new Set(['paused', 'closed', 'exited', 'failed']);
const BUSY_STATUSES = new Set(['running', 'busy']);
// Ordered worst to best: the reason reported is the first one that applies.
const PANE_READINESS_REASONS = Object.freeze(['not-running', 'launch-pending', 'unverified', 'waiting', 'busy', 'unknown-turn', 'unnamed', 'input-owned', 'ready']);

function paneForm(session) {
  const kind = session?.kind || session?.provider;
  if (kind === 'terminal' || session?.provider === 'terminal') return 'shell';
  return STRUCTURED_KINDS.has(kind) ? 'structured' : 'native';
}
// The two turn facts, shared by the readiness ladder and the one-word state.
const isWaiting = s => Boolean(s.pendingInteraction) || s.status === 'waiting' || s.turnState === 'waiting' ||
  ['approval', 'question'].includes(s.attention?.reason);
// `status` is the coarser word (a pane's process reports "running" while its
// agent sits at an idle turn), so it only counts when the turn does not answer.
const isBusy = (s, form) => form !== 'shell' && ((BUSY_STATUSES.has(s.status) && !IDLE_TURN_STATES.has(s.turnState)) ||
  BUSY_STATUSES.has(s.turnState) || Boolean(s.childActivity) || Boolean(s.pendingInput) || Boolean(s.turnActive));

// Each fact is decided on its own, because they are genuinely independent: a
// pane can have an identified recipient and an unknown turn, or a named
// conversation and a turn in flight. `reason` is the first one that is false, in
// the order above, and exists so a caller can say WHY rather than re-deriving.
function paneReadiness(session) {
  const s = session && typeof session === 'object' ? session : {};
  const form = paneForm(s);
  const notRunning = !s.id || s.started === false || s.closed === true || s.engineReady === false ||
    String(s.generation).startsWith('paused:') ||
    STOPPED_STATUSES.has(s.status) || ['exited', 'failed'].includes(s.processState) ||
    (form !== 'structured' && s.processState !== 'running') ||
    (form === 'native' && ['exited', 'failed'].includes(s.agentProcessState));
  const launchPending = s.launchState === 'pending' || s.status === 'starting' || (form === 'structured' && s.engineReady !== true);
  // A pane still reporting a provisional identity that has never taken a turn is
  // a finished launch whose PID the inventory may not have published yet, so its
  // running agent process is the recipient evidence. Every other native pane
  // must name the process that will receive the bytes.
  // A pane that has never taken a turn has no turn to report: the app publishes
  // its turn as unknown (measured on a fresh Codex and Claude pane, 2026-09-14),
  // not as idle. Untouched means exactly that, and it is idle by construction.
  const untouched = neverPrompted(s) && (s.turnState === undefined || s.turnState === 'idle' || s.turnState === 'unknown');
  const freshLaunch = s.observation === 'provisional' && untouched;
  const unverified = s.binding?.status === 'ambiguous' || (s.selection && s.selection.status !== 'confirmed') ||
    (form === 'native' && (s.agentProcessState !== 'running' ||
      (!freshLaunch && (!Number.isSafeInteger(Number(s.agentPid)) || Number(s.agentPid) <= 0))));
  const waiting = isWaiting(s);
  const busy = isBusy(s, form);
  const unknownTurn = form !== 'shell' && !busy && !IDLE_TURN_STATES.has(s.turnState);
  const unnamed = form === 'native' && s.observation !== 'observed' && !freshLaunch;
  // Input somebody else staged, or the conservative keystroke latch. This makes
  // a pane a worse CHOICE for new work — another pane costs nothing — while the
  // decision to WRITE is taken from the decoded composer, at the one place that
  // can see it (backend/orchestratorInputSurface.cjs).
  const inputOwned = Boolean(s.interactionInputPending || s.heldMouseButton || s.manualInputPending);
  const process = !notRunning && !launchPending;
  const composerVerified = process && !unverified;
  // `idle` is a turn the app has seen end; delivery and launch readiness rely
  // on that, and an unknown turn keeps them on the screen-verified startup path.
  // `untouched` is the pane that has no turn yet: it cannot be idle in that
  // sense, but it is exactly the "empty terminal" a person means when they ask
  // for one, so choosing a pane for new work reads it as free.
  const named = composerVerified && !unnamed;
  const idle = composerVerified && !waiting && !busy && !unknownTurn && !inputOwned;
  const untouchedNow = composerVerified && !waiting && !busy && !inputOwned && untouched;
  // `free` is the pane a person means by "an empty terminal": named or never
  // prompted, and idle. A freshly opened pane is idle by construction, but its
  // native identity is not provable until the provider writes a transcript, so
  // a provisional pane counts only while it has never taken a turn; once it
  // has, reuse means joining a conversation we must be able to name.
  return { form, process, composerVerified, named, idle, untouched: untouchedNow, free: named && (idle || untouchedNow),
    reason: notRunning ? 'not-running' : launchPending ? 'launch-pending' : unverified ? 'unverified'
      : waiting ? 'waiting' : busy ? 'busy' : unknownTurn ? 'unknown-turn' : unnamed ? 'unnamed'
      : inputOwned ? 'input-owned' : 'ready' };
}

// One word for what a pane is doing, read off the same facts. The assignment
// resolver ("the terminal that's currently working", "both terminals that are
// done"), the memory fast path ("which one needs me?", "what was the last one
// that finished?") and the Brain's roster all describe panes with it, so none
// of them can disagree about which pane is waiting, working, done or idle.
const PANE_STATES = Object.freeze(['stopped', 'starting', 'waiting', 'working', 'done', 'idle']);
function paneState(session) {
  const s = session && typeof session === 'object' ? session : {};
  const facts = paneReadiness(s);
  if (!facts.process) return facts.reason === 'launch-pending' ? 'starting' : 'stopped';
  // The turn facts are read directly: a pane whose recipient is not yet
  // verified is still working on whatever it is working on.
  if (isWaiting(s)) return 'waiting';
  if (isBusy(s, facts.form)) return 'working';
  if (facts.untouched) return 'idle';
  if (['completed', 'response'].includes(s.turnState) || s.attention?.state === 'completed') return 'done';
  return 'idle';
}

// The name a person sees for a pane. Providers set the terminal title with a
// progress glyph in front ("⠼ vibeTerminal" while Codex works, "✳ Claude Code"),
// and that glyph is not part of the name Lina should say or match on.
const TITLE_GLYPHS = /^[\s⠀-⣿✀-➿■-◿☀-⛿⏩-⏿*·•]+/u;
function paneDisplayName(session) {
  const raw = session?.conversationTitle || session?.conversation?.title || session?.title || session?.name || '';
  // Codex also prefixes an attention banner ("[ ! ] Action Required | vibeTerminal").
  return String(raw).replace(/^\[[^\]]{1,4}\]\s*[^|]{0,40}\|\s*/, '').replace(TITLE_GLYPHS, '').replace(/\s+/g, ' ').trim();
}

module.exports = { paneReadiness, paneState, paneDisplayName, paneForm, neverPrompted, PANE_READINESS_REASONS, PANE_STATES };
