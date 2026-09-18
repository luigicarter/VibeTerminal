'use strict';
// Speech recognition, not the user, wrote "cloud code", "codec", "cortex",
// "Vybe terminal" and "Hey Alina" into 131 saved utterances. Every one of those
// reached the brain and the resolvers verbatim. These cases are taken from that
// corpus: the normalizer must produce the registered names, drop the wake
// greeting in any spelling, and leave everything else byte-identical.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { normalizeInstruction, providerAliases, projectAliases } = require('../../backend/orchestratorVocabulary.cjs');
const { WAKE_PREFIX } = require('../../shared/wakePhraseVariants.cjs');
const { createOrchestrator } = require('../../backend/orchestrator.cjs');
const corpus = require('./fixtures/orchestrator-utterances.json');

const PROJECTS = ['vibeTerminal', 'vibeTerminalwebsite', 'lina web app', 'lina mobile', 'SLT runtime', 'solyra', 'ask Uthaymin', 'Ternary model dev', 'kimi'];
const LAUNCHERS = [{ kind: 'codex', label: 'Codex' }, { kind: 'claude', label: 'Claude' }, { kind: 'codex-web', label: 'Codex Web' },
  { kind: 'open-codex', label: 'Open Codex' }, { kind: 'gemini', label: 'Gemini' }, { kind: 'cursor', label: 'Cursor' },
  { kind: 'grok', label: 'Grok Build' }, { kind: 'kimi', label: 'Kimi' }, { kind: 'qwen', label: 'Qwen' },
  { kind: 'opencode', label: 'OpenCode' }, { kind: 'terminal', label: 'Terminal' }];
const normalize = text => normalizeInstruction(text, { projects: PROJECTS, launchers: LAUNCHERS });

// input, expected text, expected replacement kinds in order.
const CASES = [
  // Providers.
  ['Can you use one of the empty cloud code terminals in the vibe terminal project?',
    'Can you use one of the empty Claude Code terminals in the vibeTerminal project?', ['provider', 'project']],
  ['the Cloud Code Terminal in the Lenaweb app.', 'the Claude Code Terminal in the lina web app.', ['provider', 'project']],
  ['Open a claud code terminal for me.', 'Open a Claude Code terminal for me.', ['provider']],
  ['Thank you. put in another codec terminal within Vibe terminal, to identify a bug',
    'Thank you. put in another Codex terminal within vibeTerminal, to identify a bug', ['provider', 'project']],
  ['Can you get codecs in VIBE terminal to investigate the performance issues?',
    'Can you get Codex in vibeTerminal to investigate the performance issues?', ['provider', 'project']],
  ['Can you close the Cortex terminals and Vibe terminal? project.',
    'Can you close the Codex terminals and vibeTerminal? project.', ['provider', 'project']],
  ['Can you open a codex terminal for me?', 'Can you open a Codex terminal for me?', ['provider']],
  ['Ask the codex web pane what it found.', 'Ask the Codex Web pane what it found.', ['provider']],
  // A launcher this build does not have is never named back to the user.
  ['Is there a gemeni terminal running?', 'Is there a gemeni terminal running?', [], { launchers: [{ kind: 'codex' }] }],
  ['Is there a gemeni terminal running?', 'Is there a Gemini terminal running?', ['provider']],
  // Projects.
  ['He\'ll be. Can you open a new Codex terminal and Vibe terminal?',
    'Can you open a new Codex terminal and vibeTerminal?', ['wake', 'project']],
  ['Hey, Alina. Can you clear the terminals in Vibeturnal project that are not working?',
    'Can you clear the terminals in vibeTerminal project that are not working?', ['wake', 'project']],
  ['Hey Alina. There\'s an agent working on a chat section in a Vybe terminal project.',
    'There\'s an agent working on a chat section in a vibeTerminal project.', ['wake', 'project']],
  ['Hey, Alina. Can you prompt a codex terminal in Vib terminal project?',
    'Can you prompt a Codex terminal in vibeTerminal project?', ['wake', 'provider', 'project']],
  ['I want you to create a new codex terminal in Vibre terminal.',
    'I want you to create a new Codex terminal in vibeTerminal.', ['provider', 'project']],
  ['Can you tell me what\'s going on in the Vibe terminals and tell me the progress?',
    'Can you tell me what\'s going on in the vibeTerminal and tell me the progress?', ['project']],
  ['open a open a cloud code terminal and lean a web app.',
    'open a open a Claude Code terminal and lina web app.', ['provider', 'project']],
  ['Are you able to go in the Cloud Code terminal and lean on a web app and change the model?',
    'Are you able to go in the Claude Code terminal and lina web app and change the model?', ['provider', 'project']],
  ['Can you open? five terminals and Lena web app project.',
    'Can you open? five terminals and lina web app project.', ['project']],
  ['open a codex agent in Alina web app and have it do a deep dive on the file viewer.',
    'open a Codex agent in lina web app and have it do a deep dive on the file viewer.', ['provider', 'project']],
  ['Can you open a cloud code instance or terminal and Lina Mobile - Thank you.',
    'Can you open a Claude Code instance or terminal and lina mobile - Thank you.', ['provider', 'project']],
  ['Can you look for a conversation I had in the Terranium model dev cloud code session? Okay.',
    'Can you look for a conversation I had in the Ternary model dev Claude Code session? Okay.', ['project', 'provider']],
  // A near-miss with no project noun beside it is ordinary speech.
  ['Can you open a new codex terminal and a web terminal?', 'Can you open a new Codex terminal and a web terminal?', ['provider']],
  ['What kind of investigation do you want?', 'What kind of investigation do you want?', []],
  // The product is not the project.
  ['investigate the escalating RAM usage of LENA terminal',
    'investigate the escalating RAM usage of Lina Terminal', ['product']],
  ['Are you able to open a project for me and... in Lunar Terminal.',
    'Are you able to open a project for me and... in Lina Terminal.', ['product']],
  ['change the name of the application to a Lina terminal',
    'change the name of the application to a Lina Terminal', ['product']],
  ['Hey Lena. Can you get codecs in VIBE terminal to look at the RAM usage of LENA terminal?',
    'Can you get Codex in vibeTerminal to look at the RAM usage of Lina Terminal?', ['wake', 'provider', 'project', 'product']],
  // Wake greetings.
  ['Hey Lena. Hey Lena.  Can you tell the...', 'Can you tell the...', ['wake']],
  ['Hey, bye. Can you put in the prompt in the new codex terminal and Vibre terminal?',
    'Can you put in the prompt in the new Codex terminal and vibeTerminal?', ['wake', 'provider', 'project']],
  ['and all. Hey, Lena. Yeah, go ahead and spawn the agent with that prompt.',
    'Yeah, go ahead and spawn the agent with that prompt.', ['wake']],
  ['Hey, vote. Thank you. Are you able to queue prompts?', 'Thank you. Are you able to queue prompts?', ['wake']],
  // Nothing to normalize, and text the pass must not touch.
  ['Please summarize the last commit for me.', 'Please summarize the last commit for me.', []],
  ['And another terminal that is not working. Can you put on the issue of speed?',
    'And another terminal that is not working. Can you put on the issue of speed?', []],
  ['Tell it: "the cloud code pane in vibe terminal is stuck" and wait.',
    'Tell it: "the cloud code pane in vibe terminal is stuck" and wait.', []],
  ['Show Hey Lina in the terminal', 'Show Hey Lina in the terminal', []],
  // Speech fuses a word it repeats and spells Codex several ways. The garble is
  // normalization's to undo; the launcher rule downstream only reads grammar.
  // The one-token "open-codex" alias is gone, so only the bare name is rewritten
  // and the split verb stays a verb: the reader settles which "open" is which.
  ['openopen codex in vibe terminal', 'open open Codex in vibeTerminal', ['speech', 'provider', 'project']],
  ['open-codex in vibeTerminal', 'open-Codex in vibeTerminal', ['provider']],
  ['openfusion terminal', 'openfusion terminal', []],
  ['OpenOpen Codex', 'Open Open Codex', ['speech']],
  ['start start a codex terminal', 'start start a Codex terminal', ['provider']],
  ['open open code x in vibe terminal', 'open open Codex in vibeTerminal', ['provider', 'project']],
  ['the code x pane is stuck', 'the Codex pane is stuck', ['provider']],
  // Quoted words are the user's own; the split stands down inside them.
  ['say "openopen codex" out loud', 'say "openopen codex" out loud', []],
];

test('every speech variant in the saved corpus normalizes to the registered name', () => {
  assert.ok(CASES.length >= 25, `${CASES.length} table cases`);
  for (const [text, expected, kinds, options] of CASES) {
    const result = options ? normalizeInstruction(text, { projects: PROJECTS, launchers: LAUNCHERS, ...options }) : normalize(text);
    assert.equal(result.text, expected, text);
    assert.deepEqual(result.replacements.map(item => item.kind), kinds, text);
    assert.equal(result.changed, text !== expected, text);
  }
});

test('text with no known variant is returned byte-identical', () => {
  for (const text of ['', 'Please summarize the last commit for me.', 'What was that error?',
    'No, close the three that are inactive.', 'did you enter that prompt?']) {
    const result = normalize(text);
    assert.equal(result.text, text);
    assert.equal(result.changed, false);
    assert.deepEqual(result.replacements, []);
  }
  assert.equal(normalize(undefined).text, '');
  assert.equal(normalize(null).text, '');
});

test('replacements name what was rewritten and to what', () => {
  const result = normalize('Hey, Lena. put the codec prompt in Vibeturnal project.');
  assert.deepEqual(result.replacements.map(({ kind, from, to }) => ({ kind, from, to })), [
    { kind: 'wake', from: 'Hey, Lena. ', to: '' },
    { kind: 'provider', from: 'codec', to: 'Codex' },
    { kind: 'project', from: 'Vibeturnal', to: 'vibeTerminal' },
  ]);
});

test('the catalogs describe only the launchers and projects this build has', () => {
  const aliases = providerAliases([{ kind: 'codex' }, { kind: 'claude' }]);
  assert.deepEqual(aliases.map(entry => entry.canonical), ['Claude Code', 'Codex']);
  assert.ok(aliases.find(entry => entry.kind === 'claude').aliases.includes('cloud code'));
  assert.ok(providerAliases().length > aliases.length, 'no catalog falls back to the built-in table');
  const projects = projectAliases(['vibeTerminal', { name: 'lina web app' }]);
  assert.deepEqual(projects.map(entry => entry.name), ['vibeTerminal', 'lina web app']);
  assert.deepEqual(projects[0].words, ['vibe', 'terminal']);
  assert.ok(projects[0].variants.includes('vibe terminal'));
  assert.ok(projects[1].variants.includes('lena web app'));
});

// The eight rows below carry a project label that comes from the conversation,
// not from the sentence: the speaker never named a project ("No, close the
// three that are inactive"), named the product instead ("a Lina terminal"), or
// used "vibe" as the wake word. No deterministic pass can supply a name that
// was never spoken, so they are excluded from the naming ratio and asserted
// separately to stay unchanged in that respect.
const UNSPOKEN_PROJECT_ROWS = new Set([18, 20, 24, 95, 103, 115, 120, 125]);

test('the 131 saved utterances lose every provider variant and wake greeting', () => {
  const offenders = [];
  for (const row of corpus) {
    const result = normalizeInstruction(row.text, { projects: PROJECTS, launchers: LAUNCHERS });
    if (/cloud\s*code|\bcodecs?\b|\bcortex\b/i.test(result.text)) offenders.push(['provider', row.n, result.text]);
    if (WAKE_PREFIX.test(result.text)) offenders.push(['wake', row.n, result.text]);
    // Nothing outside the replacements may move.
    let rebuilt = row.text;
    for (const item of result.replacements) {
      const at = rebuilt.indexOf(item.from);
      assert.ok(at >= 0, `replacement ${item.from} is literal text of ${row.n}`);
      rebuilt = rebuilt.slice(0, at) + item.to + rebuilt.slice(at + item.from.length);
    }
    assert.equal(rebuilt, result.text, `row ${row.n} changed only where it reported`);
  }
  assert.deepEqual(offenders, []);
});

test('the saved utterances that name a project all reach its registered name', () => {
  const labelled = corpus.filter(row => row.project);
  const named = labelled.filter(row => !UNSPOKEN_PROJECT_ROWS.has(row.n));
  const resolved = labelled.filter(row => normalizeInstruction(row.text, { projects: PROJECTS, launchers: LAUNCHERS })
    .text.toLowerCase().includes(String(row.project).toLowerCase()));
  const missed = named.filter(row => !resolved.includes(row));
  const ratio = resolved.length / labelled.length;
  assert.deepEqual(missed.map(row => row.n), [],
    `every utterance that speaks its project reaches the registered name; overall ${resolved.length}/${labelled.length}`);
  assert.ok(ratio >= 0.85, `project naming ratio over all labelled rows is ${(ratio * 100).toFixed(1)}% (${resolved.length}/${labelled.length}), expected at least 85%`);
  assert.equal(resolved.length, named.length, `spoken-project rows resolved: ${resolved.length}/${named.length}`);
});

// The request path: the brain and the resolvers read the normalized sentence,
// the conversation keeps what the user said, and the log keeps only counts.
const jsonResponse = body => new Response(JSON.stringify(body));
let serial = 0;
const toolCall = action => ({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [
  { id: `vocabulary-${++serial}`, type: 'function', function: { name: 'workspace', arguments: JSON.stringify(action) } }] } }] });
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-vocabulary-'));
  const project = path.join(root, 'vibeTerminal');
  fs.mkdirSync(project);
  const f = { root, project, sessions: [], effects: [], interpretations: [], plans: [], phases: new Map() };
  f.session = (id, overrides = {}) => {
    const session = { id, name: id, cwd: project, kind: 'claude', provider: 'claude', generation: `generation-${id}`,
      launchToken: f.sessions.length + 1, conversationId: `conversation-${id}`, started: true, status: 'idle', observation: 'observed',
      processState: 'running', agentProcessState: 'running', agentPid: 200 + f.sessions.length, turnState: 'idle', revision: 1, ...overrides };
    f.sessions.push(session);
    return session;
  };
  f.relay = createOrchestrator({ userDataPath: root, secureStorage: { isEncryptionAvailable: () => false },
    getRoots: () => ({ documents: root, projects: [{ name: 'vibeTerminal', path: project }] }),
    getSessions: () => f.sessions,
    getLaunchers: async () => [{ kind: 'codex', label: 'Codex', available: true, configured: true },
      { kind: 'claude', label: 'Claude', available: true, configured: true }],
    interpretIntent: async context => {
      f.interpretations.push(context);
      const plan = f.plans.shift();
      return plan ? (typeof plan === 'function' ? plan(context) : plan) : { goal: 'Answer the user.', actions: [] };
    },
    readSession: async target => {
      const session = f.sessions.find(item => item.id === target.id);
      if (!session) return { ok: false, status: 'stale-generation' };
      return { ok: true, id: session.id, generation: session.generation, text: 'Composer ready.', sequence: 10, inputRevision: 2 };
    },
    dispatchAction: async action => { f.effects.push(action); return { ok: true, status: 'written' }; },
    fetch: async (url, options) => {
      if (url.endsWith('/key')) return jsonResponse({ data: {} });
      if (url.endsWith('/models')) return jsonResponse({ data: [{ id: 'scripted', context_length: 128000, supported_parameters: ['tools', 'tool_choice'] }] });
      const body = JSON.parse(options.body);
      const metadata = JSON.parse(body.messages.find(message => message.role === 'user').content);
      const grant = metadata.authorizedCommands?.grants.find(item => item.kind === 'operate_terminal');
      if (!grant) return jsonResponse({ choices: [{ message: { content: 'Noted.' }, finish_reason: 'stop' }] });
      // The ordinary executor loop: observe, type the authorized text, observe, finish.
      const phase = f.phases.get(grant.id) || 0; f.phases.set(grant.id, phase + 1);
      const targetId = grant.targets[0].id;
      if (phase === 0 || phase === 2) return jsonResponse(toolCall({ kind: 'read_session', targetId }));
      const observed = JSON.parse(body.messages.filter(message => message.role === 'tool').at(-1).content);
      const base = { targetId, grantId: grant.id, stepId: `${grant.id}-${phase}`, observationToken: observed.observationToken };
      if (phase === 1) return jsonResponse(toolCall({ ...base, kind: 'send_prompt', text: grant.text,
        }));
      if (phase === 3) return jsonResponse(toolCall({ ...base, kind: 'finish_terminal', outcome: 'completed', text: 'Prompt delivered.' }));
      return jsonResponse(toolCall({ kind: 'respond', text: 'Done.', responseTurn: 'complete' }));
    } });
  t.after(async () => { await f.relay.cancel(); await f.relay.dispose(); assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  await f.relay.configure({ apiKey: 'test-key', model: 'scripted', sessionOnly: true });
  assert.equal((await f.relay.setEnabled(true)).ok, true);
  f.diagnostics = async stage => {
    await f.relay.flushDiagnostics();
    const file = path.join(root, 'logs', 'orchestrator-errors.jsonl');
    const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
    return lines.filter(entry => entry.stage === stage);
  };
  return f;
}

test('the interpretation reads the normalized instruction and the conversation keeps the original', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const spoken = 'Hey Lena. use one of the empty cloud code terminals in Vibe terminal project to review the last commit.';
  const result = await f.relay.send({ text: spoken, origin: 'voice' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.interpretations.length, 1);
  assert.equal(f.interpretations[0].instruction,
    'use one of the empty Claude Code terminals in vibeTerminal project to review the last commit.');
  const messages = f.relay.getState().messages.filter(message => message.role === 'user');
  assert.equal(messages.at(-1).text, spoken, 'the transcript shows what the user said');
  const task = f.relay.getState().tasks.find(item => item.requestId === result.requestId);
  assert.equal(task.text, spoken);
  const [record, ...rest] = await f.diagnostics('normalized');
  assert.deepEqual(rest, []);
  assert.equal(record.wakeCount, 1);
  assert.equal(record.providerCount, 1);
  assert.equal(record.projectCount, 1);
  assert.equal(record.productCount, 0);
  assert.deepEqual(Object.keys(record).filter(key => /cloud|claude|vibe|terminal|text|instruction/i.test(key)), [],
    'the diagnostic records counts, never the words');
});

// The grants of a request are compiled from the normalized sentence, and a
// literal prompt must be text the user supplied. What is preserved for the next
// turn is therefore that same sentence: a continuation or retry that quotes the
// plan would otherwise be refused for words the rewrite itself introduced.
const SPOKEN = 'tell the cloud code terminal: rerun the tests';
const QUOTED = 'the Claude Code terminal: rerun the tests';

test('a literal prompt quoting the normalized sentence survives the continuation that replays it', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const pane = f.session('claude-pane');
  f.plans.push({ goal: 'Identify the pane.', clarification: 'Which Claude Code pane do you mean?', actions: [] });
  const first = await f.relay.send({ text: SPOKEN, origin: 'voice' });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(f.relay.getState().tasks.find(item => item.requestId === first.requestId).status, 'needs-answer');
  // The literal text exists only in the normalized sentence: the user said
  // "cloud code". Validating it against what was heard would refuse this.
  assert.ok(!SPOKEN.includes(QUOTED) && f.interpretations[0].instruction.includes(QUOTED));
  f.plans.push(context => {
    assert.equal(context.previousCommand.instruction, f.interpretations[0].instruction,
      'the preserved instruction is the sentence the first request was compiled from');
    return { goal: 'Relay the prompt.', actions: [{ kind: 'operate_terminal', sourceUserId: context.previousCommand.requestId,
      targetIds: [pane.id], promptMode: 'literal', text: QUOTED }] };
  });
  const second = await f.relay.send({ text: 'that one', origin: 'voice', replyToRequestId: first.requestId });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.ok(!JSON.stringify(second).includes('literal text supplied'), JSON.stringify(second));
});

test('the prompt typed for a literal grant is the plan text, never re-derived from what was heard', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const pane = f.session('claude-pane');
  f.plans.push({ goal: 'Identify the pane.', clarification: 'Which Claude Code pane do you mean?', actions: [] });
  const first = await f.relay.send({ text: SPOKEN, origin: 'voice' });
  assert.equal(first.ok, true, JSON.stringify(first));
  f.plans.push(context => ({ goal: 'Relay the prompt.', actions: [{ kind: 'operate_terminal', sourceUserId: context.previousCommand.requestId,
    targetIds: [pane.id], promptMode: 'literal', text: QUOTED }] }));
  const second = await f.relay.send({ text: 'that one', origin: 'voice', replyToRequestId: first.requestId });
  assert.equal(second.ok, true, JSON.stringify(second));
  const sends = f.effects.filter(effect => effect.kind === 'send_prompt');
  assert.equal(sends.length, 1, JSON.stringify(f.effects.map(effect => effect.kind)));
  assert.equal(sends[0].text, QUOTED, 'the authorized grant text reaches the terminal byte for byte');
  assert.equal(sends[0].target.id, pane.id);
  // Both user turns are still shown and stored exactly as they were spoken.
  assert.deepEqual(f.relay.getState().messages.filter(message => message.role === 'user').map(message => message.text), [SPOKEN, 'that one']);
});

test('an instruction with nothing to normalize records no vocabulary diagnostic', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const result = await f.relay.send({ text: 'What was that error?', origin: 'text' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.interpretations[0].instruction, 'What was that error?');
  assert.deepEqual(await f.diagnostics('normalized'), []);
});
