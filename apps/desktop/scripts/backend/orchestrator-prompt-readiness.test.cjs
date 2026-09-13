'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { assessNativePromptReadiness: assess, startupScreen } = require('../../backend/orchestratorPromptReadiness.cjs');
const { createTerminalObservation } = require('../../backend/terminalObservation.cjs');
const fs = require('node:fs');
const path = require('node:path');

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

// Startup onboarding is transient: never ready, never sent into, but the wait
// keeps polling and reports the screen instead of failing the prompt at once.
for (const [text, prompt] of [['Do you trust this directory?', 'folder-trust'], ['Set up the Codex agent sandbox', 'codex-sandbox'],
  ['Sign in to ChatGPT', 'sign-in'], ['Review startup hooks', 'startup-hooks']])
  test(`onboarding cannot reuse a retained composer: ${text}`, () => {
    const { session, observation } = fixture(); observation.text += `\n${text}`;
    const readiness = assess(session, observation);
    assert.equal(readiness.status, 'transient');
    assert.equal(readiness.ready, false);
    assert.equal(readiness.prompt, prompt);
    assert.equal(readiness.affirmativeDefault, false, 'no highlighted affirmative option is visible in this capture');
  });

test('only a folder trust screen with its affirmative default highlighted is answerable', () => {
  const { session, observation } = fixture();
  const trust = '\nDo you trust the files in this folder?\n\n❯ 1. Yes, proceed\n  2. No, exit';
  observation.text += trust;
  const readiness = assess(session, observation);
  assert.equal(readiness.status, 'transient');
  assert.equal(readiness.prompt, 'folder-trust');
  assert.equal(readiness.affirmativeDefault, true);
  // The pointer resting on the refusal, and a sandbox screen, are never answered.
  assert.equal(assess(session, { ...observation, text: observation.text.replace('❯ 1. Yes, proceed\n  2. No, exit', '  1. Yes, proceed\n❯ 2. No, exit') }).affirmativeDefault, false);
  const sandbox = assess(session, { ...observation, text: `${fixture().observation.text}\nSet up the Codex agent sandbox\n\n❯ 1. Yes, proceed` });
  assert.equal(sandbox.prompt, 'codex-sandbox');
  assert.equal(sandbox.affirmativeDefault, false);
});

test('a pending decision stays blocked and never becomes a transient startup screen', () => {
  const { session, observation } = fixture(); session.provider = 'claude';
  for (const text of ['Do you want to proceed?', 'Allow Claude to edit files?']) {
    const readiness = assess(session, { ...observation, cursor: { x: 0, y: 2 }, text: `Claude Code\n? for shortcuts\n${text}` });
    assert.equal(readiness.status, 'blocked');
    assert.equal(readiness.ready, false);
  }
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

test('a kind with no captured composer never fabricates readiness from a generic prompt', () => {
  const { session, observation } = fixture();
  // Cursor Agent's composer was never captured (this machine is not signed in)
  // and an unknown launcher has no form at all. Neither may be called ready; the
  // startup wait types into them exactly as it did before, and that wait — not
  // this detector — decides it.
  for (const provider of ['cursor', 'custom']) {
    session.provider = provider;
    assert.equal(assess(session, observation).status, 'unsupported');
  }
});

// ---------------------------------------------------------------------------
// Real recordings. Every fixture below is the raw PTY output of the CLI
// installed on a developer machine on 2026-09-13, replayed through the app's own
// decoder. See scripts/backend/fixtures/provider-startup-screens/README.md.
// The synthetic Claude fixture these replaced asserted a '? for shortcuts'
// footer that Claude Code 2.1.269 removed, which is why every send to a Claude
// pane waited the full startup timeout on 0.1.121.
// ---------------------------------------------------------------------------
const FIXTURES = path.join(__dirname, 'fixtures/provider-startup-screens');
const capture = name => JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8'));
async function replay(t, name, overrides = {}) {
  const recorded = capture(name);
  const decoder = createTerminalObservation(); t.after(() => decoder.dispose());
  const session = { id: 'pane', generation: 'g1', provider: recorded.kind, kind: recorded.kind, turnState: 'unknown', ...overrides };
  await decoder.ingest({ type: 'created', id: 'pane', generation: 'g1', cols: recorded.cols, rows: recorded.rows, inputRevision: 0 });
  await decoder.ingest({ type: 'data', id: 'pane', generation: 'g1', sequence: 1,
    data: fs.readFileSync(path.join(FIXTURES, `${name}.bin`), 'utf8') });
  return { recorded, session, observation: await decoder.read({ id: 'pane', generation: 'g1' }) };
}

for (const [name, expected] of [
  ['claude-120x36', { status: 'ready', cursor: { x: 2, y: 6 } }],
  ['claude-100x20', { status: 'ready', cursor: { x: 2, y: 16 } }],
  ['codex-ready', { status: 'ready', cursor: { x: 2, y: 13 } }],
  ['grok-ready', { status: 'ready', cursor: { x: 6, y: 25 } }],
  ['kimi-ready', { status: 'ready', cursor: { x: 5, y: 21 } }],
  ['kimi-custom-ready', { status: 'ready', cursor: { x: 5, y: 22 } }],
  ['qwen-ready', { status: 'ready', cursor: { x: 2, y: 17 } }],
  ['opencode-ready', { status: 'ready', cursor: { x: 16, y: 15 } }],
  ['codex-folder-trust', { status: 'transient', prompt: 'folder-trust', affirmativeDefault: true, cursor: { x: 25, y: 9 } }],
  ['open-codex-sign-in', { status: 'transient', prompt: 'sign-in', affirmativeDefault: false, cursor: { x: 21, y: 14 } }],
  ['cursor-sign-in', { status: 'transient', prompt: 'sign-in', affirmativeDefault: false, cursor: { x: 0, y: 29 } }],
]) test(`captured ${name} startup screen decodes to ${expected.status}`, async t => {
  const { recorded, session, observation } = await replay(t, name);
  assert.deepEqual(observation.cursor, expected.cursor);
  assert.deepEqual(observation.cursor, recorded.observation.cursor, 'the recording still decodes to the cursor it was stored with');
  assert.equal(observation.text, recorded.observation.text, 'the recording still decodes to the screen it was stored with');
  const readiness = assess(session, observation);
  assert.equal(readiness.status, expected.status, readiness.reason);
  assert.equal(readiness.ready, expected.status === 'ready');
  if (expected.prompt !== undefined) assert.equal(readiness.prompt, expected.prompt);
  if (expected.affirmativeDefault !== undefined) assert.equal(readiness.affirmativeDefault, expected.affirmativeDefault);
});

// Kimi Code hides the terminal cursor while its composer is focused. That is a
// concession to one provider's rendering, not a general relaxation.
test('a hidden cursor is accepted for Kimi only', async t => {
  const kimi = await replay(t, 'kimi-ready');
  assert.equal(kimi.observation.cursorVisible, false);
  assert.equal(assess(kimi.session, kimi.observation).ready, true);
  const qwen = await replay(t, 'qwen-ready');
  assert.equal(qwen.observation.cursorVisible, true);
  assert.equal(assess(qwen.session, { ...qwen.observation, cursorVisible: false }).ready, false);
  const grok = await replay(t, 'grok-ready');
  assert.equal(assess(grok.session, { ...grok.observation, cursorVisible: false }).ready, false);
});

for (const kind of ['claude', 'claude-custom'])
  test(`${kind} accepts the recorded 2.1.270 composer whatever its footer says`, async t => {
    const { session, observation } = await replay(t, 'claude-120x36', { provider: kind, kind });
    const footer = '⏵⏵ auto mode on (shift+tab to cycle) · ← for agents';
    assert.ok(observation.text.includes(footer), 'the recording carries the 2.1.270 auto-mode footer');
    assert.ok(!/\?\s+for shortcuts/.test(observation.text), 'Claude Code 2.1.270 prints no shortcut hint');
    assert.equal(assess(session, observation).ready, true);
    // The footer is evidence the composer may carry, never evidence it must.
    for (const text of [observation.text.replace(footer, ''), observation.text.replace(footer, '? for shortcuts'),
      observation.text.replace(footer, '⏸ manual mode on · ← for agents'),
      observation.text.replace('❯', '>'), observation.text + '\nWorking on the current request'])
      assert.equal(assess(session, { ...observation, text }).ready, true, JSON.stringify(text.slice(-90)));
    // What the composer must still be: named, ruled above and below, pointer and
    // cursor in their exact cells, with no pending decision or human draft.
    for (const patch of [
      { text: observation.text.replace('Claude Code', 'Unrelated program') },
      { text: observation.text.split('\n').filter(line => !/^─+$/.test(line)).join('\n') },
      { text: observation.text.replace(/^❯/m, ' ❯') },
      { text: observation.text + '\nDo you want to proceed?' },
      { text: observation.text + '\nAllow Claude to edit files?' },
      { text: observation.text + '\nChoose a theme' },
      { text: observation.text + '\nSelect a model' },
      { text: observation.text + '\nSelect login method' },
      { cursorVisible: false },
      { manualInputPending: true },
      { interactionInputPending: true },
      { cursor: { x: 8, y: 6 } },
      { cursor: { x: 2, y: 4 } },
      { screenTruncated: true },
    ]) assert.equal(assess(session, { ...observation, ...patch }).ready, false, JSON.stringify(patch).slice(0, 120));
  });

test('a recorded composer is refused once its own pane reports a pending decision', async t => {
  for (const name of ['claude-120x36', 'codex-ready', 'grok-ready', 'kimi-ready', 'qwen-ready', 'opencode-ready']) {
    const { session, observation } = await replay(t, name);
    assert.equal(assess(session, observation).ready, true, name);
    assert.equal(assess({ ...session, pendingInteraction: true }, observation).status, 'blocked', name);
    assert.equal(assess({ ...session, turnState: 'waiting' }, observation).status, 'blocked', name);
    assert.equal(assess(session, { ...observation, manualInputPending: true }).status, 'blocked', name);
  }
});

// Startup screens the provider-startup probe walked into on 2026-09-13 that the
// 0.1.121 detector did not know. Only the decoded screen text survived for these
// three (the probe overwrote its own raw recording on the next run), and the
// transient classification is a text-only decision, so the text is the fixture.
for (const [file, prompt] of [
  ['qwen-update-offer', 'update-offer'],
  ['claude-external-imports', 'external-imports'],
  ['claude-folder-trust', 'folder-trust'],
]) test(`the recorded ${prompt} screen is a startup screen, not a composer`, () => {
  const text = fs.readFileSync(path.join(FIXTURES, `${file}.screen.txt`), 'utf8');
  const screen = startupScreen(text);
  assert.equal(screen?.prompt, prompt);
  // Claude's trust screen rests its pointer on "No, exit", so it is reported and
  // waited through and never answered. Codex's rests on "1. Yes, continue".
  assert.equal(screen.affirmativeDefault, false);
});

test('an update banner beside a ready composer is not an update offer', async t => {
  for (const name of ['qwen-ready', 'grok-ready']) {
    const { observation } = await replay(t, name);
    assert.match(observation.text, /[Uu]pdate/, `${name} carries an update banner`);
    assert.equal(startupScreen(observation.text), undefined, name);
  }
});

// Gemini CLI is not installed here. Qwen Code is a Gemini CLI fork and paints
// the same ruled composer, so the Qwen recording is the only evidence the gemini
// recognizer has. This is recorded as unverified in the docs, and this test says
// exactly what is and is not proven.
test('gemini reuses the Qwen form, unverified against a real Gemini CLI', async t => {
  const { observation } = await replay(t, 'qwen-ready');
  const gemini = { id: 'pane', generation: 'g1', provider: 'gemini', kind: 'gemini', turnState: 'unknown' };
  assert.equal(assess(gemini, observation).ready, true);
  assert.equal(assess(gemini, { ...observation, text: observation.text + '\nSelect Auth Method' }).status, 'transient');
  assert.equal(assess(gemini, { ...observation, text: observation.text + '\nHow would you like to authenticate' }).prompt, 'sign-in');
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
