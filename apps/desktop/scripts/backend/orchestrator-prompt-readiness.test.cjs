'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { assessNativePromptReadiness: assess, startupScreen, recognizeEmptyComposer,
  COMPOSER_FORMS } = require('../../backend/orchestratorPromptReadiness.cjs');
const composerOf = (session, observation) => recognizeEmptyComposer(COMPOSER_FORMS.get(session.provider || session.kind), observation);
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

// The keystroke latch is set by any key that is not Enter or Ctrl-C - an arrow,
// Escape, typing then deleting - and output never clears it, so on its own it
// locked a pane out permanently. A composer showing nothing but its own hint is
// the evidence that overrides it; a composer holding anything else still blocks,
// which is why the fixture above stays blocked: its hint copy is the 0.144
// wording, and only what a capture actually recorded counts as a hint.
test('the keystroke latch yields only to a composer showing nothing but its own hint', () => {
  const { session, observation } = fixture(); observation.manualInputPending = true;
  let hintNow = 'Run /review on my current changes';
  const show = hint => { observation.text = observation.text.replace(hintNow, hint); hintNow = hint; };
  show('Ask Codex to do anything');
  assert.equal(assess(session, observation).ready, true, 'the recorded 0.154 hint overrides the latch');
  assert.equal(assess({ ...session, manualInputPending: true }, observation).ready, true, 'the runtime copy of the latch behaves the same');
  show('review the checkout flow');
  assert.equal(assess(session, observation).status, 'blocked', 'text that is not the hint is a draft the caret was moved back through');
  show('Ask Codex to do anything');
  observation.cursor = { x: 12, y: 3 };
  assert.equal(assess(session, observation).status, 'blocked', 'a cursor away from the composer cell still blocks');
  const unknown = fixture(); unknown.session.provider = 'cursor'; unknown.observation.manualInputPending = true;
  assert.equal(assess(unknown.session, unknown.observation).status, 'blocked', 'a kind with no recognizer keeps the hard block');
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
  // Claude Code 2.1.270 on a custom endpoint — an Open Claude Code pane — paints
  // the same composer and never shows the cursor. Recorded 2026-09-14 from a
  // claude pane whose ANTHROPIC_BASE_URL pointed at a local server.
  ['claude-hidden-cursor-100x30', { status: 'ready', cursor: { x: 2, y: 6 } }],
  ['codex-ready', { status: 'ready', cursor: { x: 2, y: 13 } }],
  // The board's own default tile is 69x10. Codex prints its session header,
  // "OpenAI Codex" banner and model line above the composer, and all three have
  // scrolled off before the composer is painted at that size - so requiring the
  // banner refused the first prompt into every default-sized Codex pane.
  // Recorded 2026-09-14 with scripts/qa/provider-startup-probe.cjs --cols 69
  // --rows 10 against Codex 0.154.0 installed on this machine.
  ['codex-small-tile-69x10', { status: 'ready', cursor: { x: 2, y: 7 } }],
  // Claude Code 2.1.270 paints a compact header that still fits at 69x10, so
  // this capture locks the composer form at a small width rather than a missing
  // banner. Recorded the same way, the same day.
  ['claude-small-tile-69x10', { status: 'ready', cursor: { x: 2, y: 7 } }],
  ['grok-ready', { status: 'ready', cursor: { x: 6, y: 25 } }],
  ['kimi-ready', { status: 'ready', cursor: { x: 5, y: 16 } }],
  ['kimi-custom-ready', { status: 'ready', cursor: { x: 5, y: 17 } }],
  ['qwen-ready', { status: 'ready', cursor: { x: 2, y: 17 } }],
  ['opencode-ready', { status: 'ready', cursor: { x: 16, y: 15 } }],
  ['codex-folder-trust', { status: 'transient', prompt: 'folder-trust', affirmativeDefault: true, cursor: { x: 25, y: 9 } }],
  // Kimi Code 0.42 opens on its own trust dialog, whose first option is worded
  // "Trust this folder" with no number: a shape the 0.1.123 pattern, which
  // required "1. Yes", never matched, so the pane waited out its whole startup.
  ['kimi-folder-trust', { status: 'transient', prompt: 'folder-trust', affirmativeDefault: true, cursor: { x: 99, y: 15 } }],
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

// The recorded small-tile screen, stated as the rule it proves: at the board's
// own default tile size a Codex pane has NO banner and NO model line on screen
// when its composer is ready, and the first prompt must still go in.
test('a default-sized Codex tile is ready with its banner already scrolled off', async t => {
  const { observation, session } = await replay(t, 'codex-small-tile-69x10');
  assert.equal(observation.cols, 69);
  assert.equal(observation.rows, 10);
  assert.equal(/OpenAI Codex/.test(observation.text), false, 'the recorded 69x10 screen carries no launch banner');
  assert.equal(/\bmodel:/i.test(observation.text), false, 'and no model line');
  assert.match(observation.text, /^› Ask Codex to do anything$/m, 'the composer itself is on screen');
  const readiness = assess(session, observation);
  assert.equal(readiness.ready, true, readiness.reason);
  assert.equal(composerOf(session, observation).empty, true);
});

// The composer recognizer is the half of the assessment that survives an
// established session: a header scrolls away, an empty input cell does not. It
// is what the input-surface fence uses, and what overrides the keystroke latch,
// so it is checked against every recording in its own right.
test('every recorded ready composer is recognized empty, and no startup screen is', async t => {
  for (const name of ['claude-120x36', 'claude-100x20', 'codex-ready', 'grok-ready', 'kimi-ready',
    'kimi-custom-ready', 'qwen-ready', 'opencode-ready']) {
    const { session, observation } = await replay(t, name);
    const composer = composerOf(session, observation);
    assert.equal(composer.empty, true, `${name}: ${composer.reason}`);
    assert.equal(composer.atComposerCell, true, name);
    // Whatever stands right of the caret in these recordings is the provider's
    // own hint. Replace it with words a user would type, leave the caret where a
    // recalled draft leaves it, and the same screen is no longer empty — while
    // the launch verdict, which must tolerate rotating hint copy, is unchanged.
    const window = observation.cursorContext;
    const row = window.rows[observation.cursor.y - window.startRow];
    const drafted = row.slice(0, observation.cursor.x) + 'review the checkout flow';
    const draft = { ...observation, cursorContext: { ...window,
      rows: window.rows.map((value, index) => index === observation.cursor.y - window.startRow ? drafted : value) } };
    const verdict = composerOf(session, draft);
    assert.equal(verdict.empty, false, name);
    assert.equal(verdict.atComposerCell, true, `${name}: the composer is still painted and the caret still in its cell`);
  }
  for (const name of ['codex-folder-trust', 'open-codex-sign-in']) {
    const { session, observation } = await replay(t, name);
    assert.equal(composerOf(session, observation).empty, false, name);
  }
  // Cursor Agent's composer was never captured, so nothing is known either way.
  const cursor = await replay(t, 'cursor-sign-in');
  assert.equal(composerOf(cursor.session, cursor.observation).empty, undefined);
});

// The session header each CLI prints once is not launch evidence: it scrolls
// off. A pane at the board's own default tile size (69x10) has lost it before
// the composer is even painted, and requiring it refused that pane's first
// prompt for the whole life of the pane — reporting "the empty Codex root
// composer is not at the current cursor" about a composer that was on screen.
test('a session whose banner has scrolled off is still ready at its composer', async t => {
  const { session, observation } = await replay(t, 'codex-ready');
  // What an established, or simply short, Codex pane looks like: the header
  // gone, other rows above it, the same empty composer at the same cell.
  const rows = observation.text.split('\n');
  const text = rows.map((row, index) => index < 11 ? `output line ${index}` : row).join('\n');
  const scrolled = { ...observation, text };
  assert.equal(/OpenAI Codex/.test(text), false, 'the session header really is gone');
  assert.equal(/\bmodel:/i.test(text), false, 'the model line went with it');
  assert.equal(composerOf(session, scrolled).empty, true);
  assert.equal(assess(session, scrolled).ready, true, assess(session, scrolled).reason);
  // A header that is still ON SCREEN and has not named its model is a session
  // that really is still starting, and still holds the first prompt back.
  const loading = { ...observation, text: rows.map((row, index) => index < 11 ? 'model:' : row).join('\n') };
  assert.equal(assess(session, loading).status, 'starting');
  // And the launch verdict is unchanged for the screen that has the whole header.
  assert.equal(assess(session, observation).ready, true);
});

// Kimi Code hides the terminal cursor while its composer is focused. That is a
// concession to one provider's rendering, not a general relaxation.
// Kimi and Claude are the two forms whose composer may be painted with no
// cursor showing; for them the rules, the pointer and the caret column are the
// evidence. Every other form still has to show its cursor.
test('a hidden cursor is accepted for Kimi and Claude only', async t => {
  const kimi = await replay(t, 'kimi-ready');
  assert.equal(kimi.observation.cursorVisible, false);
  assert.equal(assess(kimi.session, kimi.observation).ready, true);
  // Claude Code 2.1.270 on a custom endpoint: same composer, no cursor.
  const hidden = await replay(t, 'claude-hidden-cursor-100x30');
  assert.equal(hidden.observation.cursorVisible, false);
  assert.equal(assess(hidden.session, hidden.observation).ready, true);
  // Its structure is still load-bearing: without the rules it is not a composer.
  const unruled = hidden.observation.text.split('\n').filter(line => !/^─+$/.test(line)).join('\n');
  assert.equal(assess(hidden.session, { ...hidden.observation, text: unruled,
    cursorContext: { startRow: hidden.observation.cursorContext.startRow,
      rows: unruled.split('\n').slice(hidden.observation.cursorContext.startRow,
        hidden.observation.cursorContext.startRow + hidden.observation.cursorContext.rows.length) } }).ready, false);
  const qwen = await replay(t, 'qwen-ready');
  assert.equal(qwen.observation.cursorVisible, true);
  assert.equal(assess(qwen.session, { ...qwen.observation, cursorVisible: false }).ready, false);
  const grok = await replay(t, 'grok-ready');
  assert.equal(assess(grok.session, { ...grok.observation, cursorVisible: false }).ready, false);
  const codex = await replay(t, 'codex-ready');
  assert.equal(assess(codex.session, { ...codex.observation, cursorVisible: false }).ready, false);
});

for (const kind of ['claude', 'claude-custom'])
  test(`${kind} accepts the recorded 2.1.270 composer whatever its footer says`, async t => {
    const { session, observation } = await replay(t, 'claude-120x36', { provider: kind, kind });
    const footer = '⏵⏵ auto mode on (shift+tab to cycle) · ← for agents';
    assert.ok(observation.text.includes(footer), 'the recording carries the 2.1.270 auto-mode footer');
    assert.ok(!/\?\s+for shortcuts/.test(observation.text), 'Claude Code 2.1.270 prints no shortcut hint');
    assert.equal(assess(session, observation).ready, true);
    // A screen is its text AND the decoder's unclipped rows around the cursor.
    // Patching one without the other would describe a screen no terminal can
    // paint, so every text patch below re-derives that window from its own text.
    const screen = text => ({ ...observation, text, cursorContext: { startRow: observation.cursorContext.startRow,
      rows: text.split('\n').slice(observation.cursorContext.startRow,
        observation.cursorContext.startRow + observation.cursorContext.rows.length) } });
    // The footer is evidence the composer may carry, never evidence it must.
    for (const text of [observation.text.replace(footer, ''), observation.text.replace(footer, '? for shortcuts'),
      observation.text.replace(footer, '⏸ manual mode on · ← for agents'),
      observation.text.replace('❯', '>'), observation.text + '\nWorking on the current request',
      // The launch banner scrolls off a small pane before the composer appears,
      // so it is no longer evidence either way. The composer form is.
      observation.text.replace('Claude Code', 'Unrelated program')])
      assert.equal(assess(session, screen(text)).ready, true, JSON.stringify(text.slice(-90)));
    // What the composer must still be: ruled above and below, pointer and
    // cursor in their exact cells, with no pending decision or human draft.
    for (const patch of [
      screen(observation.text.split('\n').filter(line => !/^─+$/.test(line)).join('\n')),
      screen(observation.text.replace(/^❯/m, ' ❯')),
      screen(observation.text + '\nDo you want to proceed?'),
      screen(observation.text + '\nAllow Claude to edit files?'),
      screen(observation.text + '\nChoose a theme'),
      screen(observation.text + '\nSelect a model'),
      screen(observation.text + '\nSelect login method'),
      // `cursorVisible: false` is deliberately NOT in this list: Claude Code
      // 2.1.270 on a custom endpoint paints this exact composer with no cursor
      // (claude-hidden-cursor-100x30), so a hidden cursor alone no longer
      // refuses a Claude composer. Everything structural below still does.
      { interactionInputPending: true },
      { cursor: { x: 8, y: 6 } },
      { cursor: { x: 2, y: 4 } },
      { screenTruncated: true },
    ]) assert.equal(assess(session, { ...observation, ...patch }).ready, false, JSON.stringify(patch).slice(0, 120));
    // The keystroke latch alone no longer holds a composer the recognizer can
    // see is empty; over any other cursor position it still blocks.
    assert.equal(assess(session, { ...observation, manualInputPending: true }).ready, true);
    assert.equal(assess(session, { ...observation, manualInputPending: true, cursor: { x: 8, y: 6 } }).status, 'blocked');
  });

test('a recorded composer is refused once its own pane reports a pending decision', async t => {
  for (const name of ['claude-120x36', 'codex-ready', 'grok-ready', 'kimi-ready', 'qwen-ready', 'opencode-ready']) {
    const { session, observation } = await replay(t, name);
    assert.equal(assess(session, observation).ready, true, name);
    assert.equal(assess({ ...session, pendingInteraction: true }, observation).status, 'blocked', name);
    assert.equal(assess({ ...session, turnState: 'waiting' }, observation).status, 'blocked', name);
    assert.equal(assess(session, { ...observation, interactionInputPending: true }).status, 'blocked', name);
    // The keystroke latch yields to the recognized empty composer and returns
    // the moment the cursor sits anywhere else on the screen.
    assert.equal(assess(session, { ...observation, manualInputPending: true }).ready, true, name);
    assert.equal(assess(session, { ...observation, manualInputPending: true,
      cursor: { x: observation.cursor.x + 3, y: observation.cursor.y } }).status, 'blocked', name);
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

// Three recorded trust dialogs, three pointer glyphs, three wordings. What is
// common is the rule: the pointer rests on the FIRST option and that option is
// the affirmative one. Anything else is reported and waited through.
test('a trust screen is answerable only while its pointer rests on the affirmative first option', () => {
  const screens = {
    'codex 0.154': '\nDo you trust the files in this folder?\n\n❯ 1. Yes, continue\n  2. No, exit',
    'kimi 0.42': '\nTrust this folder?\n\n   ❯ Trust this folder\n     Don\'t trust',
    'gemini 0.59': '\nDo you trust this folder?\n\n ● 1. Trust folder (vibeTerminal)\n   2. Do not trust',
  };
  for (const [label, text] of Object.entries(screens)) {
    const screen = startupScreen(text);
    assert.equal(screen?.prompt, 'folder-trust', label);
    assert.equal(screen.affirmativeDefault, true, label);
  }
  for (const [label, text] of Object.entries({
    'pointer on the refusal': '\nTrust this folder?\n\n   Trust this folder\n ❯ Don\'t trust',
    'pointer on the second option': '\nDo you trust this folder?\n\n  1. Yes, continue\n❯ 2. No, exit',
    'no pointer at all': '\nDo you trust this folder?\n\n  1. Yes, continue\n  2. No, exit',
  })) assert.equal(startupScreen(text).affirmativeDefault, false, label);
  // A sandbox or sign-in screen is never answered, however its options read.
  assert.equal(startupScreen('\nSet up the Codex agent sandbox\n\n❯ 1. Yes, proceed').affirmativeDefault, false);
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
  // And the same draft still blocks with the caret back at its end, where a
  // composer holding text actually leaves it.
  await decoder.ingest({ type: 'data', id: session.id, generation: session.generation, sequence: 5, data: '\x1b[5C' });
  assert.equal(assess(session, await read()).status, 'blocked', 'a draft the cursor sits after still blocks a latched pane');
});

// The sparkle Codex 0.154 paints around its empty composer takes the separator
// cell between the pointer and the cursor several times a second. Recorded from
// the installed 0.154 on 2026-09-13: 35 of 92 idle frames carried it.
test('an ambient sparkle dot in the composer separator is decoration, not a draft', async t => {
  const decoder = createTerminalObservation(); t.after(() => decoder.dispose());
  const session = { id: 'pane', generation: 'g1', provider: 'codex', kind: 'codex', turnState: 'unknown' };
  await decoder.ingest({ type: 'created', id: 'pane', generation: 'g1', cols: 80, rows: 10, inputRevision: 0 });
  await decoder.ingest({ type: 'data', id: 'pane', generation: 'g1', sequence: 1,
    data: 'OpenAI Codex (v0.154.0)\r\nmodel: gpt-6-astra\r\n\r\n› Ask Codex to do anything\x1b[4;3H' });
  assert.equal(assess(session, await decoder.read({ id: 'pane', generation: 'g1' })).ready, true);
  // One frame later the sparkle owns the separator cell; the cursor has not moved.
  await decoder.ingest({ type: 'data', id: 'pane', generation: 'g1', sequence: 2, data: '\x1b[4;2H⠁\x1b[4;3H' });
  const sparkled = await decoder.read({ id: 'pane', generation: 'g1' });
  assert.equal(sparkled.cursorLine.beforeCursor, '›⠁', 'the decoder still reports what the cells actually hold');
  assert.equal(assess(session, sparkled).ready, true);
  // A character the user typed in that cell moves the cursor past it.
  await decoder.ingest({ type: 'data', id: 'pane', generation: 'g1', sequence: 3, data: '\x1b[4;2Hx' });
  assert.equal(assess(session, await decoder.read({ id: 'pane', generation: 'g1' })).ready, false);
});
