'use strict';
// The one place a test builds terminal input evidence.
//
// Production has exactly one freshness contract: the input surface the
// application projected from its own last read of the pane. There are no
// model-echoed counters left to hand-roll, so a test that invents an
// `observationSequence` is testing something that no longer exists. Every test
// that needs an input action gets its surface from here, off the same
// `projectInputSurface` the executor, the startup wait and the busy promotion
// all use.
const { projectInputSurface } = require('../../backend/orchestratorInputSurface.cjs');

// What the app's decoder reports for an empty Codex composer, in the shape
// `terminalObservation.read` returns. Anything a test wants to move — the caret,
// the geometry, the input revision, the composer row — it overrides here, so the
// surface it gets is the surface production would compute for that screen.
function composerScreen(overrides = {}) {
  const { id = 'p', generation = 'g', composer = '› Ask Codex to do anything', banner = 'OpenAI Codex\nmodel: gpt-6-astra\n', ...rest } = overrides;
  const lines = `${banner}\n${composer}`.split('\n');
  const y = lines.length - 1;
  return { ok: true, id, generation, sequence: 7, inputRevision: 0, cols: 100, rows: 28,
    text: lines.join('\n'), cursor: { x: 2, y }, cursorVisible: true, alternateScreen: false,
    cursorLine: { startRow: y, text: lines[y], beforeCursor: lines[y].slice(0, 2) },
    cursorContext: { startRow: Math.max(0, y - 2), rows: lines.slice(Math.max(0, y - 2), y + 7) },
    manualInputPending: false, interactionInputPending: false, ...rest };
}

// The surface for a pane and the screen it is showing.
const surfaceOf = (session, observation) => projectInputSurface(session, observation);

// A terminal input action bound to that surface. `session` and `observation` are
// whatever the calling fixture already has; the target defaults to the session.
function inputAction(session, observation, action = {}) {
  return { target: { id: session.id, generation: session.generation }, ...action,
    inputSurface: action.inputSurface ?? projectInputSurface(session, observation) };
}

module.exports = { composerScreen, surfaceOf, inputAction };
