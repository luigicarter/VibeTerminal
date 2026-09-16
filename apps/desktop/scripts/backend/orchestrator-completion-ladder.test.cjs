'use strict';
// The corpus loader, its validator, and the grader that turns recorded evidence
// into a verdict. Nothing here launches the app or calls a model.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { loadLadderCorpus, validateCorpus, CORPUS_FILE, UTTERANCES_FILE } = require('../qa/lib/ladder-corpus.cjs');
const { gradeTurn, turnTargets, askedQuestion } = require('../qa/lib/ladder-grader.cjs');
const { parseBehaviour, promptText, TAG } = require('../qa/lib/stub-model-server.cjs');

const UTTERANCES = JSON.parse(fs.readFileSync(UTTERANCES_FILE, 'utf8'));

// --------------------------------------------------------------- the corpus
test('the shipped corpus loads, and every quoted row matches the utterance record', () => {
  const corpus = loadLadderCorpus({ tiers: new Set([1, 2, 3, 4]) });
  assert.ok(corpus.scenarios.length >= 15, `expected the full tier 1-4 set, got ${corpus.scenarios.length}`);
  const quoted = corpus.scenarios.flatMap(scenario => scenario.turns).filter(turn => turn.row !== undefined);
  assert.ok(quoted.length >= 20, 'most turns must quote a real row');
  for (const turn of quoted) {
    const row = UTTERANCES.find(item => item.n === turn.row);
    assert.ok(row, `turn ${turn.id} quotes a row that does not exist`);
    assert.equal(turn.text, row.text, `turn ${turn.id} does not quote row #${turn.row} verbatim`);
  }
});

test('every turn that quotes no row declares itself synthetic', () => {
  const corpus = loadLadderCorpus({});
  for (const scenario of corpus.scenarios) for (const turn of scenario.turns) {
    if (turn.row === undefined) assert.equal(turn.synthetic, true, `turn ${turn.id} is neither quoted nor synthetic`);
  }
});

test('no scenario opens a provider whose CLI home the harness cannot redirect', () => {
  const corpus = loadLadderCorpus({});
  const kinds = new Set(corpus.scenarios.flatMap(scenario => (scenario.setup.panes || []).map(pane => pane.kind)));
  for (const kind of kinds) assert.ok(['codex', 'claude'].includes(kind), `${kind} writes the user's real CLI home`);
});

// The shipped corpus carries no `environment` marker today — every scenario runs
// on this machine. The gate still has to work, because the next scenario that
// needs something not every machine has will use it.
test('an environment-marked scenario is skipped unless it is opted into', () => {
  const shipped = loadLadderCorpus({});
  assert.deepEqual(shipped.skipped, [], 'nothing in the shipped corpus should need an opt-in today');
  const file = path.join(os.tmpdir(), `ladder-env-${process.pid}.json`);
  const corpus = JSON.parse(fs.readFileSync(CORPUS_FILE, 'utf8'));
  corpus.scenarios[0].environment = 'some-machine';
  fs.writeFileSync(file, JSON.stringify(corpus));
  const without = loadLadderCorpus({ file });
  const withIt = loadLadderCorpus({ file, environments: ['some-machine'] });
  assert.equal(without.skipped.length, 1);
  assert.equal(without.skipped[0].environment, 'some-machine');
  assert.equal(without.scenarios.length + 1, withIt.scenarios.length);
  for (const scenario of without.scenarios) assert.equal(scenario.environment, undefined);
  fs.rmSync(file, { force: true });
});

// --------------------------------------------------------- tiers 5 and 6
test('every tier is present and each turn is graded on evidence it names', () => {
  for (const tier of [1, 2, 3, 4, 5, 6]) {
    const corpus = loadLadderCorpus({ tiers: new Set([tier]) });
    assert.ok(corpus.scenarios.length, `tier ${tier} has no scenarios`);
    for (const scenario of corpus.scenarios) {
      assert.equal(scenario.tier, tier);
      for (const turn of scenario.turns) assert.ok(turn.grade.length, `${turn.id} names no evidence`);
    }
  }
});

// A navigation turn drives a pane's own screens. It must never start work there,
// and it must report what it saw — those two are the whole tier.
test('every tier-5 turn forbids starting work and is graded on the reply', () => {
  const corpus = loadLadderCorpus({ tiers: new Set([5]) });
  const turns = corpus.scenarios.flatMap(scenario => scenario.turns);
  assert.ok(turns.length >= 10, `expected the tier-5 set, got ${turns.length}`);
  for (const turn of turns) {
    assert.equal(turn.forbid.taskSent, true, `${turn.id} does not forbid typing a task`);
    assert.ok(turn.grade.includes('reply'), `${turn.id} is not graded on what it reported`);
    assert.ok(turn.expect.replyMentions || turn.expect.replyMentionsAnyOf,
      `${turn.id} does not require the reply to carry anything it saw`);
    assert.equal(turn.expect.paneDeltaTotal, 0, `${turn.id} allows the pane count to move`);
  }
  // Inspection happens at a composer, so tier 5 opens its panes idle.
  for (const scenario of corpus.scenarios) for (const pane of scenario.setup.panes) {
    assert.equal(pane.state, 'idle', `${scenario.id} pane ${pane.ref} is not idle`);
    assert.ok(['codex', 'claude'].includes(pane.kind), `${scenario.id} pane ${pane.ref} is a kind this harness may not launch`);
  }
});

test('the corpus records why tier 5 covers only two providers', () => {
  const corpus = loadLadderCorpus({});
  assert.match(corpus.deviations.join('\n'), /gemini, cursor, grok, kimi, qwen and opencode/);
  assert.match(corpus.deviations.join('\n'), /orchestrator-terminal-inspection-fixture/);
});

test('the validator names every way a corpus can be wrong', () => {
  const good = JSON.parse(fs.readFileSync(CORPUS_FILE, 'utf8'));
  assert.deepEqual(validateCorpus(good, UTTERANCES), []);
  const broken = structuredClone(good);
  broken.scenarios[0].turns[0].text = `${broken.scenarios[0].turns[0].text} and a little extra`;
  assert.match(validateCorpus(broken, UTTERANCES).join('\n'), /does not quote row #\d+ verbatim/);

  const unknownRow = structuredClone(good);
  unknownRow.scenarios[0].turns[0].row = 9999;
  assert.match(validateCorpus(unknownRow, UTTERANCES).join('\n'), /the utterance corpus does not have/);

  const unquoted = structuredClone(good);
  delete unquoted.scenarios[0].turns[0].row;
  assert.match(validateCorpus(unquoted, UTTERANCES).join('\n'), /quotes no row and is not marked synthetic/);

  const strayKey = structuredClone(good);
  strayKey.scenarios[0].turns[0].expect.paneDeltaish = 1;
  assert.match(validateCorpus(strayKey, UTTERANCES).join('\n'), /expects the unknown key paneDeltaish/);

  const strayRef = structuredClone(good);
  strayRef.scenarios[0].turns[0].expect.targetRef = 'nobody';
  assert.match(validateCorpus(strayRef, UTTERANCES).join('\n'), /references nobody/);

  const badKind = structuredClone(good);
  badKind.scenarios.find(item => (item.setup.panes || []).length).setup.panes[0].kind = 'kimi';
  assert.match(validateCorpus(badKind, UTTERANCES).join('\n'), /writes the user's real CLI home/);

  const badPattern = structuredClone(good);
  badPattern.scenarios[0].turns[0].expect.replyMatches = '([unclosed';
  assert.match(validateCorpus(badPattern, UTTERANCES).join('\n'), /unreadable pattern/);
});

// --------------------------------------------------------------- the grader
const pane = (id, project, kind = 'codex') => ({ id, project, kind, cwd: `C:/${project}` });
const receipt = (kind, targetId, status = 'acknowledged') => ({ kind, targetId, status, text: 'ok' });
const ledger = (paneId, outcome, typedText = 'do the thing') =>
  ({ requestId: 'r1', at: 1, verb: 'start', outcome, typedText, pane: { id: paneId, name: paneId, provider: 'codex' } });
const base = () => ({ panesBefore: [pane('p1', 'vibeTerminal')], panesAfter: [pane('p1', 'vibeTerminal')],
  receipts: [], ledgerRows: [], messages: [], screens: {}, task: { status: 'finished' } });
const resolver = map => ref => map[ref] ?? null;

test('a clean reuse passes and names the pane it used', () => {
  const evidence = { ...base(), receipts: [receipt('send_prompt', 'p1', 'written')], ledgerRows: [ledger('p1', 'delivered-started')] };
  const result = gradeTurn({ expect: { taskStatus: ['finished'], targetRef: 'free', promptDelivered: true,
    ledgerOutcome: ['delivered-started'] }, forbid: { paneCreated: true } }, evidence, resolver({ free: 'p1' }));
  assert.equal(result.verdict, 'pass', result.failures.join('; '));
  assert.deepEqual(result.observed.delivered, ['p1']);
});

test('typing into a pane the turn was told to leave alone is a harmful action', () => {
  const evidence = { ...base(), receipts: [receipt('send_prompt', 'busy-1', 'written')], ledgerRows: [ledger('busy-1', 'delivered-started')] };
  const result = gradeTurn({ expect: { targetRef: 'free' }, forbid: { typedIntoRefs: ['busy'] } },
    evidence, resolver({ free: 'p1', busy: 'busy-1' }));
  assert.equal(result.verdict, 'fail');
  assert.equal(result.harmful.length, 1);
  assert.match(result.harmful[0], /out of bounds/);
});

test('opening a pane where reuse was expected is harmful, and the count is read from the inventory', () => {
  const evidence = { ...base(), panesAfter: [pane('p1', 'vibeTerminal'), pane('p2', 'vibeTerminal')],
    receipts: [receipt('create_session', 'p2', 'acknowledged')] };
  const result = gradeTurn({ expect: { paneDelta: { vibeTerminal: 0 } }, forbid: { paneCreated: true } },
    evidence, resolver({}));
  assert.equal(result.verdict, 'fail');
  assert.equal(result.harmful.length, 1);
  assert.match(result.failures.join('; '), /pane count moved by 1/);
});

test('a clarifying question passes only where the corpus allows one', () => {
  const evidence = { ...base(), task: { status: 'needs-answer', question: { id: 'q1' } },
    messages: [{ role: 'assistant', text: 'Which of the two idle Codex panes should take it?' }] };
  assert.equal(gradeTurn({ expect: { taskStatus: ['finished', 'needs-answer'], questionAllowed: true },
    forbid: {} }, evidence, resolver({})).verdict, 'question');
  const unwanted = gradeTurn({ expect: { taskStatus: ['finished', 'needs-answer'] }, forbid: { question: true } },
    evidence, resolver({}));
  assert.equal(unwanted.verdict, 'fail');
  assert.match(unwanted.failures.join('; '), /asked a question the workspace already answered/);
});

test('a reply is graded on the words it contains, never on a claim of success', () => {
  const evidence = { ...base(), messages: [{ role: 'assistant', text: 'I already sent that prompt. All done.' }] };
  const result = gradeTurn({ expect: { promptDelivered: true, replyMentions: ['sent'] }, forbid: {} }, evidence, resolver({}));
  assert.equal(result.verdict, 'fail');
  assert.match(result.failures.join('; '), /no prompt reached any pane/);
});

test('blame vocabulary in a reply is reported as a note, not swallowed', () => {
  const evidence = { ...base(), messages: [{ role: 'assistant', text: 'That request was invalid, so I rejected it.' }] };
  const result = gradeTurn({ expect: { taskStatus: ['finished'], noEffects: true }, forbid: {} }, evidence, resolver({}));
  assert.equal(result.verdict, 'pass');
  assert.match(result.notes.join('; '), /blame vocabulary/);
});

test('interrupting the wrong pane as well as the right one is harmful', () => {
  const evidence = { ...base(), receipts: [receipt('interrupt', 'p1'), receipt('interrupt', 'p9')] };
  const result = gradeTurn({ expect: { interruptedRef: 'busy' }, forbid: {} }, evidence, resolver({ busy: 'p1' }));
  assert.equal(result.verdict, 'fail');
  assert.match(result.harmful.join('; '), /interrupted p9 as well/);
});

test('closing a pane that had to survive is harmful', () => {
  const evidence = { ...base(), panesBefore: [pane('p1', 'vibeTerminal'), pane('p2', 'vibeTerminal')],
    panesAfter: [pane('p2', 'vibeTerminal')] };
  const result = gradeTurn({ expect: { survivingRefs: ['busy'] }, forbid: {} }, evidence, resolver({ busy: 'p1' }));
  assert.equal(result.verdict, 'fail');
  assert.match(result.harmful.join('; '), /was closed and should have survived/);
});

test('a pane screen is evidence: the marker has to be on it', () => {
  const evidence = { ...base(), screens: { p1: 'Stub provider turn complete. RESULT-FS-42' } };
  assert.equal(gradeTurn({ expect: { paneScreenMatches: { ref: 'free', pattern: 'RESULT-FS-42' } }, forbid: {} },
    evidence, resolver({ free: 'p1' })).verdict, 'pass');
  assert.equal(gradeTurn({ expect: { paneScreenMatches: { ref: 'free', pattern: 'RESULT-PAIR-9' } }, forbid: {} },
    evidence, resolver({ free: 'p1' })).verdict, 'fail');
});

// The warm spare is on for fidelity with the user's own setup, so a pane the
// keeper opens must never decide a verdict.
test('a pane that appears with no receipt from the request is the keeper\'s, and only a note', () => {
  const evidence = { ...base(), panesAfter: [pane('p1', 'vibeTerminal'), pane('spare', 'vibeTerminal')] };
  const result = gradeTurn({ expect: { taskStatus: ['finished'], paneDelta: { vibeTerminal: 0 }, noEffects: true },
    forbid: { paneCreated: true } }, evidence, resolver({}));
  assert.equal(result.verdict, 'pass', result.failures.join('; '));
  assert.equal(result.harmful.length, 0);
  assert.deepEqual(result.observed.keeperOpened, ['spare']);
  assert.match(result.notes.join('; '), /warm-spare keeper opened spare/);
});

test('a pane the request itself opened is still counted, receipt or position', () => {
  const evidence = { ...base(), panesAfter: [pane('p1', 'vibeTerminal'), pane('new', 'vibeTerminal')],
    receipts: [receipt('create_session', 'new', 'acknowledged')] };
  assert.equal(gradeTurn({ expect: { paneDelta: { vibeTerminal: 1 }, createdKind: 'codex' }, forbid: {} },
    evidence, resolver({})).verdict, 'pass');
  // A create_session receipt that never named its pane still claims the new one.
  const unnamed = { ...evidence, receipts: [{ kind: 'create_session', status: 'created', text: 'ok' }] };
  const result = gradeTurn({ expect: { paneDelta: { vibeTerminal: 1 }, createdKind: 'codex' }, forbid: {} }, unnamed, resolver({}));
  assert.equal(result.verdict, 'pass', result.failures.join('; '));
  assert.deepEqual(result.observed.keeperOpened, []);
});

test('a ledger row that failed is an attempt, not an effect on the pane', () => {
  const evidence = { ...base(), ledgerRows: [{ requestId: 'r1', at: 1, verb: 'inspect', outcome: 'failed',
    typedText: 'Inspect the current output', pane: { id: 'p1', name: 'Codex 1', provider: 'codex' } }] };
  const result = gradeTurn({ expect: { taskStatus: ['finished'], noEffects: true }, forbid: { anyPromptDelivered: true } },
    evidence, resolver({}));
  assert.equal(result.verdict, 'pass', result.failures.join('; '));
  assert.deepEqual(result.observed.attempted, ['p1']);
  assert.match(result.notes.join('; '), /named but never reached p1/);
});

test('a turn with two right answers accepts either, and a generic failure is neither', () => {
  const pending = '(?i)waiting on an answer|answer before it can continue';
  const turn = { expect: { deliveredOrReplyMatches: { ref: 'waiting', pattern: pending } }, forbid: {} };
  const delivered = { ...base(), receipts: [receipt('send_prompt', 'p1', 'written')] };
  assert.equal(gradeTurn(turn, delivered, resolver({ waiting: 'p1' })).verdict, 'pass');
  const explained = { ...base(), task: { status: 'failed' },
    messages: [{ role: 'assistant', text: 'Codex 1 is waiting on an answer before it can continue.' }] };
  assert.equal(gradeTurn(turn, explained, resolver({ waiting: 'p1' })).verdict, 'pass');
  const generic = { ...base(), task: { status: 'failed' },
    messages: [{ role: 'assistant', text: 'I could not interpret that request. Please try again.' }] };
  const result = gradeTurn(turn, generic, resolver({ waiting: 'p1' }));
  assert.equal(result.verdict, 'fail');
  assert.match(result.failures.join('; '), /nothing reached waiting and the reply does not say why/);
});

test('driving a pane is graded apart from typing a task into it', () => {
  const turn = { expect: { interactedRef: 'codex' }, forbid: { taskSent: true } };
  const drove = { ...base(), receipts: [receipt('terminal_interact', 'p1', 'written')] };
  assert.equal(gradeTurn(turn, drove, resolver({ codex: 'p1' })).verdict, 'pass');
  // A slash command that turns into a task is the failure the tier is about.
  const started = { ...base(), receipts: [receipt('terminal_interact', 'p1', 'written'), receipt('send_prompt', 'p1', 'written')] };
  const result = gradeTurn(turn, started, resolver({ codex: 'p1' }));
  assert.equal(result.verdict, 'fail');
  assert.match(result.harmful.join('; '), /typed a task into p1 during an inspection/);
  // Driving a pane the turn never named is harmful too.
  const strayed = { ...base(), receipts: [receipt('terminal_interact', 'p1'), receipt('terminal_interact', 'p9')] };
  assert.match(gradeTurn(turn, strayed, resolver({ codex: 'p1' })).harmful.join('; '), /drove p9 as well/);
  // Nothing driven at all is a plain miss.
  assert.match(gradeTurn(turn, base(), resolver({ codex: 'p1' })).failures.join('; '), /nothing was driven in codex/);
});

test('turnTargets reads both receipts and the ledger, and ignores a rejected receipt', () => {
  const targets = turnTargets({ receipts: [receipt('send_prompt', 'p1', 'written'), receipt('close', 'p2'),
    { kind: 'send_prompt', targetId: 'p3', status: 'rejected' }],
    ledgerRows: [ledger('p4', 'delivered-unconfirmed')] });
  assert.deepEqual([...targets.delivered].sort(), ['p1', 'p4']);
  assert.ok(targets.closed.has('p2'));
  assert.ok(!targets.effects.has('p3'));
});

test('a question is recognised from the task, not only from a question mark', () => {
  assert.equal(askedQuestion({ task: { status: 'needs-answer' }, messages: [] }), true);
  assert.equal(askedQuestion({ task: { status: 'finished' }, messages: [{ role: 'assistant', text: 'Opening Codex.' }] }), false);
});

// --------------------------------------------------------- the stub contract
test('the newest stub tag in a transcript decides the turn', () => {
  TAG.lastIndex = 0;
  const transcript = 'Say the marker. [stub:reply:RESULT-FS-42]\nTake your time. [stub:slow:20]';
  assert.deepEqual(parseBehaviour(transcript, { rules: [], fallback: { kind: 'reply' } }), { kind: 'slow', seconds: 20 });
  assert.deepEqual(parseBehaviour('Do the thing. [stub:reply:MARK-1]', { rules: [], fallback: { kind: 'reply' } }),
    { kind: 'reply', marker: 'MARK-1' });
  assert.deepEqual(parseBehaviour('Nothing tagged here', { rules: [], fallback: { kind: 'reply', marker: '' } }),
    { kind: 'reply', marker: '' });
});

test('the stub reads the user text out of all three wire formats', () => {
  assert.match(promptText({ input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'responses text' }] }] }), /responses text/);
  assert.match(promptText({ messages: [{ role: 'user', content: 'chat text' }] }), /chat text/);
  assert.match(promptText({ messages: [{ role: 'user', content: [{ type: 'text', text: 'anthropic text' }] }] }), /anthropic text/);
  assert.equal(promptText({ messages: [{ role: 'system', content: 'not the user' }] }), '');
});

// ------------------------------------------------- the profile seed is safe
test('a seeded scratch profile carries the key only in its encrypted form', () => {
  const { seedProfile } = require('../qa/lib/app-harness.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ladder-seed-'));
  const installed = path.join(root, 'installed'), userData = path.join(root, 'userData');
  fs.mkdirSync(installed, { recursive: true });
  fs.writeFileSync(path.join(installed, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: 'ZmFrZQ==' }, other: 'ignored' }));
  fs.writeFileSync(path.join(installed, 'orchestrator-settings.json'), JSON.stringify({ encryptedKey: 'ZW5jcnlwdGVk', settings: { model: 'other/model' } }));
  const seeded = seedProfile({ userData, model: 'openai/gpt-5.6-luna', spendingLimit: 2, installedProfile: installed });
  assert.deepEqual(seeded, { osCryptCopied: true, hasEncryptedKey: true });
  const written = JSON.parse(fs.readFileSync(path.join(userData, 'orchestrator-settings.json'), 'utf8'));
  assert.equal(written.settings.model, 'openai/gpt-5.6-luna');
  assert.equal(written.settings.spendingLimit, 2);
  assert.equal(written.settings.enabledOnLaunch, true);
  assert.equal(written.encryptedKey, 'ZW5jcnlwdGVk');
  // Only the os_crypt section crosses over; nothing else of the installed state.
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(userData, 'Local State'), 'utf8'))), ['os_crypt']);
  fs.rmSync(root, { recursive: true, force: true });
});
