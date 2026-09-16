'use strict';
const { createHash } = require('node:crypto');
const { recognizeEmptyComposer, withoutDecoration, COMPOSER_FORMS } = require('./orchestratorPromptReadiness.cjs');

// The input surface is what the user could be typing into: where the caret is,
// what stands to the left of it, which composer the pane is painting, how big
// the screen is, and who owns the pending input. It exists because the old
// freshness fence measured OUTPUT VOLUME — one counter bumped per PTY chunk —
// and an idle Codex 0.154 pane emits a frame every 40-80 ms forever to animate
// a sparkle around its EMPTY composer. Under that counter such a pane is
// permanently "stale" and nothing can ever be typed into it; under this
// projection it is unchanged, because nothing about the input moved.
//
// Deliberately absent, and never to be added: `sequence`, `outputAt`, the screen
// text, anything to the RIGHT of the cursor, and the raw rows above and below —
// that is exactly where ambient animation lives (recorded: 35 of 92 idle frames
// put a sparkle dot in the cell between Codex's '›' and its cursor, which is why
// `beforeCursor` arrives here already normalised). The per-form recognizer
// verdict is the structure check for the surrounding rows.
//
// Runtime facts — lifecycle, turn, binding, pending interactions — stay in
// orchestratorInputAuthority.cjs. The two projections are checked together and
// answer different questions: "is this still the same recipient" and "is this
// still the same input surface".
const FIELDS = Object.freeze(['id', 'generation', 'cursor', 'cursorVisible', 'cols', 'rows', 'alternateScreen',
  'inputRevision', 'manualInputPending', 'interactionInputPending', 'ownerRequestId', 'line', 'composer']);

function canonical(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(canonical));
  if (value && typeof value === 'object') return Object.freeze(Object.fromEntries(
    Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])])
  ));
  return value;
}

function projectInputSurface(session, observation) {
  const s = session && typeof session === 'object' ? session : {};
  const o = observation && typeof observation === 'object' ? observation : {};
  const form = COMPOSER_FORMS.get(s.provider || s.kind);
  const composer = recognizeEmptyComposer(form, o);
  const line = o.cursorLine && typeof o.cursorLine === 'object' ? o.cursorLine : {};
  return canonical({
    id: o.id ?? s.id, generation: o.generation ?? s.generation,
    cursor: { x: o.cursor?.x, y: o.cursor?.y },
    cursorVisible: o.cursorVisible === true,
    cols: o.cols, rows: o.rows, alternateScreen: o.alternateScreen === true,
    inputRevision: o.inputRevision,
    manualInputPending: o.manualInputPending === true,
    interactionInputPending: o.interactionInputPending === true,
    ownerRequestId: typeof o.ownerRequestId === 'string' ? o.ownerRequestId : null,
    // Text up to the cursor only, with ambient decoration normalised out by the
    // recognizer module that owns the glyph list.
    line: { startRow: line.startRow, beforeCursor: withoutDecoration(line.beforeCursor) },
    composer: { form: form ?? null, empty: composer.empty },
  });
}

function sameInputSurface(expected, actual) {
  return JSON.stringify(expected) === JSON.stringify(actual);
}

// A surface is only evidence if the application projected it from a real read.
// This is the admission check for every input action, in place of the two
// counters the model used to copy back.
// Geometry, caret and composer are compared by sameInputSurface whether or not
// the pane had painted them yet, and the host re-fences geometry against its own
// session, so what has to be present here is only what makes this evidence at
// all: it was projected from a real read of this pane, and it carries the input
// revision that read saw.
function validInputSurface(surface) {
  return Boolean(surface) && typeof surface === 'object' &&
    typeof surface.id === 'string' && Boolean(surface.id) && surface.generation !== undefined &&
    Number.isSafeInteger(surface.inputRevision) && surface.inputRevision >= 0 &&
    Boolean(surface.composer) && typeof surface.composer === 'object' &&
    Boolean(surface.line) && typeof surface.line === 'object';
}

// Which named fields moved. Field NAMES only: a diagnostic must never carry a
// fragment of the user's screen.
function changedSurfaceFields(expected, actual) {
  const a = expected && typeof expected === 'object' ? expected : {};
  const b = actual && typeof actual === 'object' ? actual : {};
  return FIELDS.filter(field => JSON.stringify(a[field]) !== JSON.stringify(b[field]));
}

// What travels to the PTY host: a hash it can echo back, and the one fact it
// acts on (whether the composer was recognizably empty). The host cannot
// recompute the projection — it holds no decoder — so this is main's signed
// statement about a screen it just checked, fenced on the host's own side by
// generation, PID, input revision, geometry and ownership.
function surfaceEvidence(surface, sequence) {
  return { verified: true, fingerprint: createHash('sha256').update(JSON.stringify(surface)).digest('hex'),
    composerEmpty: surface?.composer?.empty === true, sequence };
}

// The host's validation of the above. Shape only; the host trusts main for the
// content, exactly as it already does for cols/rows/inputRevision.
function validSurfaceEvidence(value) {
  return Boolean(value) && typeof value === 'object' && value.verified === true &&
    typeof value.fingerprint === 'string' && /^[0-9a-f]{64}$/.test(value.fingerprint) &&
    typeof value.composerEmpty === 'boolean' && Number.isSafeInteger(value.sequence) && value.sequence >= 0;
}

module.exports = { projectInputSurface, sameInputSurface, validInputSurface, changedSurfaceFields, surfaceEvidence, validSurfaceEvidence };
