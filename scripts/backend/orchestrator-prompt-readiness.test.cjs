'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { assessNativePromptReadiness: assess } = require('../../backend/orchestratorPromptReadiness.cjs');
const { createTerminalObservation } = require('../../backend/terminalObservation.cjs');

// Native capture: .tmp/orchestrator-native-submission-1788879964366-55892/startup.txt.
// The placeholder varies; input position and loaded session chrome are evidence.
function fixture() {
  const session = { id: 'pane', generation: 'g1', provider: 'codex', turnState: 'unknown' };
  const observation = { ok: true, id: 'pane', generation: 'g1', sequence: 4, inputRevision: 0,
    text: '│ >_ OpenAI Codex (v0.144.0) │\n│ model: probe /model to change │\n\n› Run /review on my current changes\n\n  probe default · C:\\project',
    cursor: { x: 2, y: 3 }, cursorVisible: true, cols: 110, rows: 35 };
  return { session, observation };
}

test('loaded native Codex composer accepts unknown lifecycle without a delay', () => {
  const { session, observation } = fixture();
  assert.equal(assess(session, observation).ready, true);
  observation.text = observation.text.replace('Run /review on my current changes', 'Ask Codex to do anything');
  assert.equal(assess(session, observation).ready, true);
});

for (const [name, change] of [
  ['empty initial frame', o => { o.sequence = 0; o.text = ''; }],
  ['normal composer while model loads', o => { o.text = o.text.replace('model: probe', 'model: loading'); }],
  ['disabled composer', o => { o.text = o.text.replace('Run /review on my current changes', 'Input disabled.'); }],
  ['hidden cursor', o => { o.cursorVisible = false; }],
  ['missing cursor visibility', o => { delete o.cursorVisible; }],
  ['banner without composer', o => { o.text = o.text.split('\n').slice(0, 2).join('\n'); }],
  ['composer remains in history while cursor is elsewhere', o => { o.cursor.y = 5; }],
  ['input cursor past draft text', o => { o.cursor.x = 12; }],
  ['wrong generation', o => { o.generation = 'g2'; }],
  ['wrong pane', o => { o.id = 'other'; }],
  ['exited decoder', o => { o.exited = true; }],
  ['missing input revision', o => { delete o.inputRevision; }],
  ['clipped current screen', o => { o.screenTruncated = true; }],
  ['invalid geometry', o => { o.cursor.y = o.rows; }]
]) test(`startup stays unsent: ${name}`, () => {
  const { session, observation } = fixture(); change(observation);
  assert.equal(assess(session, observation).ready, false);
});

for (const text of ['Do you trust this directory?', 'Set up the Codex agent sandbox', 'Sign in to ChatGPT'])
  test(`onboarding cannot reuse a retained composer: ${text}`, () => {
    const { session, observation } = fixture(); observation.text += `\n${text}`;
    assert.equal(assess(session, observation).status, 'blocked');
  });

for (const field of ['manualInputPending', 'interactionInputPending']) test(`${field} blocks startup submission`, () => {
  const { session, observation } = fixture(); observation[field] = true;
  assert.equal(assess(session, observation).status, 'blocked');
});

test('initial idle lifecycle is insufficient and a pending request stays blocked', () => {
  const { session, observation } = fixture(); session.turnState = 'idle'; observation.cursorVisible = false;
  assert.equal(assess(session, observation).ready, false);
  observation.cursorVisible = true; session.pendingInteraction = true;
  assert.equal(assess(session, observation).status, 'blocked');
});

test('unknown native forms do not fabricate readiness from a generic prompt', () => {
  const { session, observation } = fixture();
  for (const provider of ['grok', 'gemini', 'custom']) {
    session.provider = provider;
    assert.equal(assess(session, observation).status, 'unsupported');
  }
});

// Static evidence only: installed Claude's bundled YY/Xkt input components
// render pointer + NBSP, horizontal borders, and '? for shortcuts'. These are
// decoder-backed contract fixtures, not recordings of a live Claude startup.
for (const provider of ['claude', 'claude-custom']) for (const glyph of ['❯', '>'])
  test(`${provider} recognizes the bounded ${glyph} root input form`, async t => {
    const decoder = createTerminalObservation(); t.after(() => decoder.dispose());
    const session = { id: 'claude-pane', generation: 'c1', provider, turnState: 'unknown' };
    await decoder.ingest({ type: 'created', id: session.id, generation: session.generation, cols: 80, rows: 12, inputRevision: 0 });
    await decoder.ingest({ type: 'data', id: session.id, generation: session.generation, sequence: 1,
      data: `Claude Code v2\r\n────────────────────\r\n${glyph}\u00a0\r\n────────────────────\r\n? for shortcuts\x1b[3;3H\x1b[?25h` });
    const observation = await decoder.read({ id: session.id, generation: session.generation });
    assert.deepEqual(observation.cursor, { x: 2, y: 2 });
    assert.equal(assess(session, observation).ready, true);
    for (const patch of [
      { text: observation.text.replace('Claude Code', 'Unrelated program') },
      { text: observation.text.replace('? for shortcuts', '') },
      { text: observation.text.replace('────────────────────', '') },
      { text: observation.text + '\nDo you want to proceed?' },
      { text: observation.text + '\nChoose a theme' },
      { text: observation.text + '\nSelect a model' },
      { cursorVisible: false },
      { manualInputPending: true },
      { cursor: { x: 8, y: 2 } },
      { cursor: { x: 2, y: 4 } }
    ]) assert.equal(assess(session, { ...observation, ...patch }).ready, false, JSON.stringify(patch));
    assert.equal(assess(session, { ...observation, text: observation.text + '\nWorking on the current request' }).ready, true,
      'busy prose does not disable an otherwise focused Claude input');
  });

test('standard PowerShell startup requires its current empty shell cursor', () => {
  const { session, observation } = fixture(); session.provider = 'terminal';
  observation.text = 'Windows PowerShell\nPS C:\\project> '; observation.cursor = { x: 15, y: 1 };
  assert.equal(assess(session, observation).ready, true);
  observation.text += 'echo task'; observation.cursor.x += 9;
  assert.equal(assess(session, observation).ready, false);
});

for (const directory of ['Input disabled', 'Do you trust', 'Connecting to server'])
  test(`PowerShell path text is not native agent onboarding: ${directory}`, async t => {
    const decoder = createTerminalObservation(); t.after(() => decoder.dispose());
    const session = { id: 'shell', generation: 's1', provider: 'terminal' };
    await decoder.ingest({ type: 'created', id: session.id, generation: session.generation, cols: 80, rows: 12, inputRevision: 0 });
    await decoder.ingest({ type: 'data', id: session.id, generation: session.generation, sequence: 1,
      data: `PS C:\\${directory}> ` });
    const observation = await decoder.read({ id: session.id, generation: session.generation });
    assert.equal(assess(session, observation).ready, true);
  });

for (const directory of ['long-project\\'.repeat(6), '项目\\'.repeat(16)])
  test(`real decoder recognizes a soft-wrapped PowerShell prompt (${directory.startsWith('项目') ? 'wide Unicode' : 'long path'})`, async t => {
    const decoder = createTerminalObservation(); t.after(() => decoder.dispose());
    const session = { id: 'shell', generation: 's1', provider: 'terminal' };
    await decoder.ingest({ type: 'created', id: session.id, generation: session.generation, cols: 40, rows: 12, inputRevision: 0 });
    const read = () => decoder.read({ id: session.id, generation: session.generation });
    const prompt = `PS C:\\${directory}> `;
    await decoder.ingest({ type: 'data', id: session.id, generation: session.generation, sequence: 1, data: prompt });
    const ready = await read();
    assert.ok(ready.cursor.y > 0, 'the physical input cursor is on a wrapped continuation row');
    assert.equal(ready.cursorLine.startRow, 0);
    assert.equal(ready.cursorLine.text.trimEnd(), prompt.trimEnd());
    assert.equal(ready.cursorLine.beforeCursor, prompt);
    assert.equal(assess(session, ready).ready, true);
    await decoder.ingest({ type: 'data', id: session.id, generation: session.generation, sequence: 2, data: 'draft' });
    assert.equal(assess(session, await read()).ready, false, 'visible draft is not an empty input prompt');
    await decoder.ingest({ type: 'data', id: session.id, generation: session.generation, sequence: 3, data: '\x1b[5D' });
    assert.equal(assess(session, await read()).ready, false, 'moving the cursor before a draft must not hide its text');
  });

test('independent PowerShell-looking output rows never combine into a ready prompt', async t => {
  const decoder = createTerminalObservation(); t.after(() => decoder.dispose());
  const session = { id: 'shell', generation: 's1', provider: 'terminal' };
  await decoder.ingest({ type: 'created', id: session.id, generation: session.generation, cols: 40, rows: 12, inputRevision: 0 });
  await decoder.ingest({ type: 'data', id: session.id, generation: session.generation, sequence: 1, data: 'PS C:\\previous\r\ncurrent> ' });
  const observation = await decoder.read({ id: session.id, generation: session.generation });
  assert.equal(observation.cursorLine.startRow, 1);
  assert.equal(observation.cursorLine.text.trimEnd(), 'current>');
  assert.equal(assess(session, observation).ready, false);
});

test('real decoder accepts the trimmed empty composer and preserves cursor and draft guards', async t => {
  const decoder = createTerminalObservation({ maxHistoryBytes: 1 });
  t.after(() => decoder.dispose());
  const { session } = fixture();
  await decoder.ingest({ type: 'created', id: session.id, generation: session.generation, cols: 80, rows: 10, inputRevision: 0 });
  const read = () => decoder.read({ id: session.id, generation: session.generation });
  await decoder.ingest({ type: 'data', id: session.id, generation: session.generation, sequence: 1,
    data: 'OpenAI Codex (v0.144.0)\r\nmodel: probe\r\n\r\n› ' });
  const empty = await read();
  assert.equal(empty.text.split('\n').at(-1), '›', 'real xterm screen text trims the composer space');
  assert.deepEqual(empty.cursor, { x: 2, y: 3 });
  assert.equal(empty.truncated, true, 'retained history truncation does not clip the current screen');
  assert.equal(empty.screenTruncated, false);
  assert.equal(assess(session, empty).ready, true);
  const clipped = await decoder.read({ id: session.id, generation: session.generation, maxChars: 10 });
  assert.equal(clipped.screenTruncated, true);
  assert.equal(assess(session, clipped).ready, false, 'tail clipping cannot be mistaken for current cursor row evidence');
  await decoder.ingest({ type: 'data', id: session.id, generation: session.generation, sequence: 2, data: '\x1b[?25l' });
  assert.equal(assess(session, await read()).ready, false);
  await decoder.ingest({ type: 'data', id: session.id, generation: session.generation, sequence: 3, data: '\x1b[?25hdraft' });
  assert.equal(assess(session, await read()).ready, false, 'cursor past visible draft is not empty');
  await decoder.ingest({ type: 'data', id: session.id, generation: session.generation, sequence: 4, data: '\x1b[5D' });
  await decoder.ingest({ type: 'input-state', id: session.id, generation: session.generation, inputRevision: 1, manualInputPending: true });
  assert.equal(assess(session, await read()).status, 'blocked', 'moving cursor to draft start cannot defeat pending human input');
});
