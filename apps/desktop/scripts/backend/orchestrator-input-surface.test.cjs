'use strict';
// The input surface is what the old freshness fence was standing in for. These
// cases are built on the recorded Codex 0.154 ready screen, because that is the
// pane the sequence counter was wrong about: it repaints an ambient sparkle
// around its EMPTY composer several times a second, forever, and 35 of the 92
// recorded idle frames put one of those dots in the cell between the '›' pointer
// and the input cursor.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { projectInputSurface, sameInputSurface, changedSurfaceFields, surfaceEvidence, validSurfaceEvidence } =
  require('../../backend/orchestratorInputSurface.cjs');
const { createTerminalObservation } = require('../../backend/terminalObservation.cjs');

const FIXTURES = path.join(__dirname, 'fixtures/provider-startup-screens');
// Codex's sparkle alphabet, recorded from the installed 0.154 on 2026-09-13.
const DOTS = ['⠁', '⠂', '⠄', '⠈', '⠐', '⠠', '⡀', '⢀'];
async function codexPane(t) {
  const recorded = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'codex-ready.json'), 'utf8'));
  const decoder = createTerminalObservation(); t.after(() => decoder.dispose());
  const session = { id: 'p', generation: 'g1', provider: 'codex', kind: 'codex' };
  await decoder.ingest({ type: 'created', id: 'p', generation: 'g1', cols: recorded.cols, rows: recorded.rows, inputRevision: 0 });
  await decoder.ingest({ type: 'data', id: 'p', generation: 'g1', sequence: 1,
    data: fs.readFileSync(path.join(FIXTURES, 'codex-ready.bin'), 'utf8') });
  let sequence = 1;
  return { session, decoder, recorded,
    read: () => decoder.read({ id: 'p', generation: 'g1' }),
    write: data => decoder.ingest({ type: 'data', id: 'p', generation: 'g1', sequence: ++sequence, data }),
    state: (inputRevision, extra = {}) => decoder.ingest({ type: 'input-state', id: 'p', generation: 'g1', inputRevision, ...extra }) };
}

test('an idle sparkling composer advances the output sequence without moving its input surface', async t => {
  const pane = await codexPane(t);
  const first = await pane.read();
  const baseline = projectInputSurface(pane.session, first);
  assert.equal(baseline.composer.empty, true);
  assert.equal(baseline.line.beforeCursor, '› ');
  // Twenty synthesized frames of the recorded shape: repaint the three composer
  // rows with dots in different cells, including the separator cell the real
  // recording flapped, and repair the cursor style exactly as Codex does.
  for (let frame = 0; frame < 20; frame++) {
    const separator = DOTS[frame % DOTS.length];
    await pane.write('\x1b[?2026h' +
      `\x1b[13;1H${DOTS[(frame + 1) % DOTS.length]}\x1b[13;40H${DOTS[(frame + 3) % DOTS.length]}` +
      `\x1b[14;2H${frame % 2 ? separator : ' '}` +
      `\x1b[15;7H${DOTS[(frame + 5) % DOTS.length]}` +
      '\x1b[14;3H\x1b[0 q\x1b[?2026l');
    const sample = await pane.read();
    assert.ok(sample.sequence > first.sequence, 'the output counter keeps moving');
    assert.ok(sameInputSurface(baseline, projectInputSurface(pane.session, sample)),
      `frame ${frame} changed the input surface: ${changedSurfaceFields(baseline, projectInputSurface(pane.session, sample))}`);
  }
  const last = await pane.read();
  assert.equal(last.sequence, first.sequence + 20, 'twenty frames, twenty sequence bumps, one surface');
});

test('each surface field is compared, and a changed one is named without quoting the screen', async t => {
  const pane = await codexPane(t);
  const observation = await pane.read();
  const baseline = projectInputSurface(pane.session, observation);
  const cases = {
    cursor: { cursor: { x: 9, y: 13 } },
    cursorVisible: { cursorVisible: false },
    cols: { cols: 120 },
    rows: { rows: 40 },
    alternateScreen: { alternateScreen: true },
    inputRevision: { inputRevision: 4 },
    manualInputPending: { manualInputPending: true },
    interactionInputPending: { interactionInputPending: true },
    ownerRequestId: { ownerRequestId: 'another-request' },
    id: { id: 'other' },
    generation: { generation: 'g2' },
  };
  for (const [field, patch] of Object.entries(cases)) {
    const changed = projectInputSurface(pane.session, { ...observation, ...patch });
    assert.equal(sameInputSurface(baseline, changed), false, field);
    assert.ok(changedSurfaceFields(baseline, changed).includes(field), `${field}: ${changedSurfaceFields(baseline, changed)}`);
  }
  // The logical cursor line and the composer verdict are their own fields.
  const typed = projectInputSurface(pane.session, { ...observation,
    cursorLine: { ...observation.cursorLine, beforeCursor: '› dra' }, cursor: { x: 7, y: 13 } });
  assert.deepEqual(changedSurfaceFields(baseline, typed).sort(), ['composer', 'cursor', 'line']);
  assert.equal(typed.composer.empty, false);
  // Nothing a diagnostic carries may be a fragment of the user's screen.
  for (const field of changedSurfaceFields(baseline, typed)) assert.match(field, /^[a-zA-Z]+$/);
  assert.equal(JSON.stringify(baseline).includes('Ask Codex'), false, 'the surface never carries the screen text');
  assert.equal(JSON.stringify(baseline).includes('sequence'), false, 'the surface never carries the output counter');
});

test('a real draft, and a real keystroke, both move the surface the sparkle cannot', async t => {
  const pane = await codexPane(t);
  const baseline = projectInputSurface(pane.session, await pane.read());
  await pane.write('draft');
  const drafted = projectInputSurface(pane.session, await pane.read());
  assert.equal(sameInputSurface(baseline, drafted), false);
  assert.equal(drafted.composer.empty, false);
  assert.equal(drafted.line.beforeCursor, '› draft');
  await pane.state(1, { manualInputPending: true });
  const latched = projectInputSurface(pane.session, await pane.read());
  assert.ok(changedSurfaceFields(drafted, latched).includes('inputRevision'));
  assert.ok(changedSurfaceFields(drafted, latched).includes('manualInputPending'));
});

test('a kind with no verified recognizer reports an unknown composer rather than an empty one', async t => {
  const pane = await codexPane(t);
  const observation = await pane.read();
  const surface = projectInputSurface({ ...pane.session, provider: 'cursor', kind: 'cursor' }, observation);
  assert.equal(surface.composer.form, null);
  assert.equal(Object.hasOwn(surface.composer, 'empty'), false, 'unknown is not the same as occupied');
  assert.equal(surfaceEvidence(surface, observation.sequence).composerEmpty, false);
});

test('surface evidence is a hash and one fact, and the host validates its shape', async t => {
  const pane = await codexPane(t);
  const observation = await pane.read();
  const surface = projectInputSurface(pane.session, observation);
  const evidence = surfaceEvidence(surface, observation.sequence);
  assert.deepEqual(Object.keys(evidence).sort(), ['composerEmpty', 'fingerprint', 'sequence', 'verified']);
  assert.match(evidence.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(evidence.composerEmpty, true);
  assert.equal(evidence.sequence, observation.sequence);
  assert.equal(validSurfaceEvidence(evidence), true);
  // The same surface always hashes the same; a moved cursor does not.
  assert.equal(surfaceEvidence(projectInputSurface(pane.session, observation), observation.sequence).fingerprint, evidence.fingerprint);
  assert.notEqual(surfaceEvidence(projectInputSurface(pane.session, { ...observation, cursor: { x: 3, y: 13 } }), observation.sequence).fingerprint, evidence.fingerprint);
  for (const malformed of [undefined, null, 'x', {}, { ...evidence, verified: false }, { ...evidence, fingerprint: 'short' },
    { ...evidence, fingerprint: evidence.fingerprint.toUpperCase() }, { ...evidence, composerEmpty: 'yes' },
    { ...evidence, sequence: -1 }, { ...evidence, sequence: 1.5 }])
    assert.equal(validSurfaceEvidence(malformed), false, JSON.stringify(malformed));
});

test('a clipped model read cannot change the composer verdict a full read gives', async t => {
  const pane = await codexPane(t);
  const full = await pane.read();
  const clipped = await pane.decoder.read({ id: 'p', generation: 'g1', maxChars: 60 });
  assert.equal(clipped.screenTruncated, true, 'the excerpt really is clipped');
  assert.equal(clipped.text.includes('OpenAI Codex'), false);
  assert.deepEqual(clipped.cursorContext, full.cursorContext, 'the unclipped window around the cursor survives clipping');
  assert.equal(projectInputSurface(pane.session, clipped).composer.empty, true);
  assert.ok(sameInputSurface(projectInputSurface(pane.session, full), projectInputSurface(pane.session, clipped)));
});

test('every recorded ready composer projects an empty surface, and every startup screen does not', async t => {
  for (const [name, kind] of [['claude-120x36', 'claude'], ['claude-100x20', 'claude'], ['codex-ready', 'codex'],
    ['grok-ready', 'grok'], ['kimi-ready', 'kimi'], ['kimi-custom-ready', 'kimi-custom'], ['qwen-ready', 'qwen'],
    ['opencode-ready', 'opencode']]) {
    const recorded = JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8'));
    const decoder = createTerminalObservation(); t.after(() => decoder.dispose());
    await decoder.ingest({ type: 'created', id: 'p', generation: 'g1', cols: recorded.cols, rows: recorded.rows, inputRevision: 0 });
    await decoder.ingest({ type: 'data', id: 'p', generation: 'g1', sequence: 1, data: fs.readFileSync(path.join(FIXTURES, `${name}.bin`), 'utf8') });
    const observation = await decoder.read({ id: 'p', generation: 'g1' });
    const surface = projectInputSurface({ id: 'p', generation: 'g1', provider: kind, kind }, observation);
    assert.equal(surface.composer.empty, true, name);
  }
  for (const [name, kind] of [['codex-folder-trust', 'codex'], ['open-codex-sign-in', 'open-codex'], ['cursor-sign-in', 'codex']]) {
    const recorded = JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8'));
    const decoder = createTerminalObservation(); t.after(() => decoder.dispose());
    await decoder.ingest({ type: 'created', id: 'p', generation: 'g1', cols: recorded.cols, rows: recorded.rows, inputRevision: 0 });
    await decoder.ingest({ type: 'data', id: 'p', generation: 'g1', sequence: 1, data: fs.readFileSync(path.join(FIXTURES, `${name}.bin`), 'utf8') });
    const observation = await decoder.read({ id: 'p', generation: 'g1' });
    const surface = projectInputSurface({ id: 'p', generation: 'g1', provider: kind, kind }, observation);
    assert.equal(surface.composer.empty, false, name);
  }
});
