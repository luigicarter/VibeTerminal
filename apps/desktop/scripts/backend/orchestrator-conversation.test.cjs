'use strict';
// The conversation contract: every line the user reads or hears says what Lina
// did, what she is waiting on, and what happens next, in plain first-person
// sentences that name the pane. Nothing blames anyone for what the application
// did, "done" is only said of an effect that was watched happen, and the spoken
// form never runs past two sentences.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createOrchestrator } = require('../../backend/orchestrator.cjs');
const { SENTENCES, sentence, failureSentence, brainRejectionSentence, paneLabel } = require('../../backend/orchestratorFailureText.cjs');
const { composeFinalResponse, speechFor, firstSentence } = require('../../backend/orchestratorFinalResponse.cjs');
const { taskWaitSentence } = require('../../backend/orchestratorTaskStatus.cjs');
const { outcomeSentence } = require('../../backend/orchestratorResponse.cjs');
const { collectTaskReports } = require('../../backend/orchestratorTaskReports.cjs');
const { formatTaskStatus } = require('../../backend/orchestratorTaskStatus.cjs');

// The scheduler owns these two reasons; a status reply repeats them word for
// word, so they are linted beside the sentences Lina composes herself.
const queuedTarget = { id: 'queued-pane', generation: 1, name: 'Codex 2' };
const queuedJob = { task: { requestId: 'queued', sequence: 1, status: 'queued', targets: [queuedTarget],
  waitingReason: 'Waiting for the earlier task in this project to finish first.' }, waits: [] };
const blockingReason = 'Waiting for prerequisite request "Review the checkout": it has not finished yet.';

const sentences = text => String(text).split(/(?<=[.!?])\s+/).filter(part => part.trim()).length;
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status });
const tick = () => new Promise(resolve => setImmediate(resolve));
// A store flush can still hold a handle on Windows for a moment after dispose.
async function remove(root) {
  for (let attempt = 0; ; attempt++) {
    try { return fs.rmSync(root, { recursive: true, force: true }); }
    catch (error) { if (attempt >= 20) throw error; await new Promise(resolve => setTimeout(resolve, 25)); }
  }
}

// Words that describe a defect, or hand the user the blame, never reach a
// sentence Lina says. Statuses, receipt fields and error codes keep them.
const BANNED = [/\bbugs?\b/i, /\bmalformed\b/i, /\breject(ed|s|ion)?\b/i, /\bfaults?\b/i, /\binvalid\b/i,
  /\bunverified\b/i, /you didn't/i, /check your settings/i, /not a settings problem/i,
  /the brain rejected/i, /cannot accept/i];
function banned(text) {
  return BANNED.filter(pattern => pattern.test(String(text))).map(pattern => pattern.source);
}
// A user-facing sentence: prose, not a status token or an object key.
const PROSE = value => typeof value === 'string' && value.length >= 25 && value.includes(' ') && /[a-z]/.test(value);

// Every catalogue entry, with the fixture context each one needs, and the exact
// sentence it must produce. This table is the contract the composers compile to.
const CASES = {
  'creation-started': [{ pane: 'Codex in vibeTerminal' }, 'Opening Codex in vibeTerminal.'],
  // Start and follow-up echo the typed task on a second written line, so the
  // user can check the words that reached the agent. The spoken form does not.
  'typed': [{ pane: 'Codex in vibeTerminal', task: 'Investigate the orchestrator performance.' },
    'Typed the task into Codex in vibeTerminal; waiting for it to start.\nTask: Investigate the orchestrator performance.'],
  'started': [{ pane: 'Codex' }, 'Codex started working on it.'],
  'startup-screen': [{ pane: 'Codex in vibeTerminal', screen: 'trust prompt', seconds: 20 },
    "Codex in vibeTerminal is still on its startup screen (trust prompt); I'll answer it and keep trying for 20 seconds."],
  'startup-screen-waiting': [{ pane: 'Codex in vibeTerminal', screen: 'sign-in', seconds: 20 },
    "Codex in vibeTerminal is still on its startup screen (sign-in); I'll keep trying for 20 seconds."],
  'startup-answered': [{}, 'Answered the trust prompt; typing the task now.'],
  'still-waiting': [{ pane: 'Codex' }, 'Still waiting for Codex to become ready.'],
  'created': [{ pane: 'Codex in vibeTerminal' }, 'Opened Codex in vibeTerminal.'],
  'created-draft': [{ pane: 'Codex' }, 'Opened Codex; the prompt is saved there as a draft and has not been sent.'],
  'creation-unconfirmed': [{}, "I asked for a new terminal; I haven't seen it finish starting yet."],
  'opened-not-sent': [{ pane: 'Codex in vibeTerminal' }, "I opened Codex in vibeTerminal but couldn't type the task; the pane is still open."],
  'pane-still-open': [{ pane: 'Codex in vibeTerminal' }, 'Codex in vibeTerminal is still open.'],
  'staged': [{ pane: 'Codex' }, 'Saved the prompt as a draft in Codex; nothing was sent. Open the pane to review and send it.'],
  'sent': [{ pane: 'Codex' }, 'Typed the prompt into Codex.'],
  'accepted': [{ pane: 'Codex' }, "Codex took the prompt; I'm waiting for its result."],
  'delivered-unconfirmed': [{ pane: 'Codex' }, "Typed the task into Codex, but I haven't seen it start yet. I'll tell you when it does."],
  'delivered-pending': [{}, "The task is in; I haven't seen a result yet. I'll tell you when one lands."],
  'delivered-while-running': [{ pane: 'Codex', task: 'Also cover expired coupons.' },
    "Typed the follow-up into Codex while it was working; I haven't seen it taken up yet. I'll tell you when it is.\nTask: Also cover expired coupons."],
  'native-shell': [{ pane: 'Terminal' }, "Typed the command into Terminal. It is a plain shell, so I can't tell you when the command finishes."],
  'queued': [{ pane: 'Codex' }, 'The prompt for Codex is queued; nothing has been typed yet.'],
  'queued-busy': [{ pane: 'Codex' }, "Codex is still working, so I queued the follow-up; it'll be typed when Codex is ready."],
  'running': [{ pane: 'Codex' }, 'Codex is working on it.'],
  'turn-started-unknown': [{ pane: 'Codex' }, "Codex started on it; I haven't seen how far it has got."],
  'needs-input': [{ pane: 'Codex' }, 'Codex is waiting on an answer before it can continue. Open the pane to give it one.'],
  'watching': [{ pane: 'Codex' }, "I'm watching Codex and I'll tell you what changes."],
  'watching-ready': [{ pane: 'Codex' }, "I'm watching Codex and I'll tell you when it's ready."],
  'watch-already-ended': [{ pane: 'Codex' }, "Codex had already finished its turn; I'll look at the result."],
  'watch-failed': [{ pane: 'Codex', reason: 'The pane closed.' }, "I couldn't start watching Codex: The pane closed."],
  'ready': [{ pane: 'Codex' }, 'Codex is ready.'],
  'no-tracked-task': [{ pane: 'Codex' }, "I don't have a tracked task for Codex."],
  'turn-ended': [{ pane: 'Codex' }, "Codex finished its turn; I haven't checked what it changed."],
  'turn-ended-elsewhere': [{ pane: 'Codex' }, "That turn ended, but the pane has moved to another conversation since, so I can't check what it changed."],
  'turn-error': [{ pane: 'Codex', reason: 'The agent stopped.' }, 'Codex ended its turn with an error: The agent stopped. Check the pane for what it got through.'],
  'turn-interrupted': [{ pane: 'Codex' }, "Codex's turn was interrupted, so its work is unfinished. Check the pane."],
  'turn-unconfirmed': [{ pane: 'Codex' }, "I couldn't confirm the work in Codex. Check the pane."],
  'result': [{ pane: 'Codex', summary: 'it fixed the parser.' }, 'Codex finished: it fixed the parser.'],
  'all-turns-ended': [{}, 'All the terminal turns I started for this have ended.'],
  'input-surface-unverified': [{ pane: 'Codex in vibeTerminal' },
    "Codex in vibeTerminal was still on its startup screen, so nothing was typed. The pane is still open; say 'try again' when it's ready."],
  'launch-timeout': [{ pane: 'Codex in vibeTerminal', seconds: 20 },
    "Codex in vibeTerminal didn't become ready within 20 seconds, so nothing was typed. The pane is still open; say 'try again' when it's ready."],
  'stale-observation': [{ pane: 'Codex' }, 'Codex changed while I was about to type, so I held off. Nothing was sent.'],
  'conversation-changed': [{ pane: 'Codex' }, 'Codex moved to another conversation while I was about to type, so I held off. Nothing was sent.'],
  'input-buffer-occupied': [{ pane: 'Codex' }, 'Codex already had text waiting in it, so I left it alone and typed nothing.'],
  'recipient-unavailable': [{ pane: 'Codex' }, "Codex wasn't taking input when I tried, so nothing was typed. The pane is still open; say 'try again' when it's ready."],
  'target-unavailable': [{ pane: 'Codex' }, "Codex is no longer free, so nothing was typed. The pane is still open; say 'try again' when it's ready."],
  'not-running': [{ pane: 'Codex' }, 'Codex had stopped by the time I tried to type, so nothing was sent.'],
  'stale-generation': [{ pane: 'Codex' }, 'Codex was restarted before I could type, so nothing was sent.'],
  'generation-changed': [{ pane: 'Codex' }, 'Codex was restarted before I could confirm its result; check the pane.'],
  'delivery-unknown': [{ pane: 'Codex' }, "I couldn't confirm that Codex took the prompt, and I haven't typed it again."],
  'pane-changed': [{ pane: 'Codex' }, "Codex changed, so I can't tell you where this task stands."],
  'conversation-moved': [{ pane: 'Codex' }, "The pane has moved to another conversation, so I can't follow this task there."],
  'attribution-ambiguous': [{ pane: 'Codex' }, "I can't tell yet which of Codex's turns is the one I started, so I'm still watching it."],
  'blocked': [{ pane: 'Codex', reason: 'The pane has a pending question.' }, "I couldn't do that in Codex: The pane has a pending question."],
  // Answers composed from Lina's own memory, with no model call behind them.
  'last-prompt': [{ pane: 'Codex', typedText: 'Review the release checklist.', outcome: 'delivered-started' },
    'The last prompt I put in was “Review the release checklist.”, in Codex. It started working on it.'],
  'last-error': [{ pane: 'Codex', reason: 'The composer was not reachable.' },
    'The last thing that went wrong was in Codex: The composer was not reachable.'],
  'pane-result': [{ pane: 'Codex', summary: 'it found two stale handlers.' }, 'Codex came back with: it found two stale handlers.'],
  'recent-actions': [{ actions: 'started a task in Codex; opened Claude Code 2' },
    'Here is what I did: started a task in Codex; opened Claude Code 2.'],
  'brain-error': [{}, "I couldn't get a plan from the brain for that one, so nothing was typed."],
  'brain-timeout': [{}, 'The brain took too long to answer; nothing was typed. Try once more.'],
  'project-added': [{}, 'Added the folder as a Lina Terminal project.'],
  'project-removed': [{}, 'Removed the project from Lina Terminal. No files or folders were deleted.'],
  'folder-opened': [{}, 'Opened the folder in the file manager.'],
  'navigated': [{ view: 'Settings' }, 'Opened Settings.'],
  'focused': [{ pane: 'Codex' }, 'Switched to Codex.'],
  'stopped': [{ pane: 'Codex' }, 'Codex stopped.'],
  'stop-requested': [{ pane: 'Codex' }, 'Asked Codex to stop.'],
  'accepted-request': [{}, 'I took care of that.'],
};

test('every sentence in the catalogue has a case, and renders exactly what the user reads', () => {
  assert.deepEqual(Object.keys(SENTENCES).filter(key => !CASES[key]), [], 'every catalogue entry needs a case');
  assert.deepEqual(Object.keys(CASES).filter(key => !SENTENCES[key]), [], 'every case needs a catalogue entry');
  for (const [key, [context, expected]] of Object.entries(CASES)) {
    assert.equal(sentence(key, context).text, expected, key);
  }
  assert.equal(sentence('not-a-case', {}), undefined, 'an unknown key invents no wording');
});

test('every spoken form is at most two sentences and names the pane the written one names', () => {
  for (const [key, [context]] of Object.entries(CASES)) {
    const { text, speech } = sentence(key, context);
    assert.ok(sentences(speech) <= 2, `${key} speaks ${sentences(speech)} sentences: ${speech}`);
    if (context.pane && text.includes(context.pane)) assert.ok(speech.includes(context.pane), `${key} drops the pane name when spoken`);
  }
});

test('a missing pane falls back to a phrase, never to an empty subject or an id', () => {
  assert.equal(sentence('typed', {}).text, 'Typed the task into the terminal; waiting for it to start.');
  assert.equal(paneLabel({ provider: 'codex', cwd: 'C:/work/vibeTerminal' }), 'Codex in vibeTerminal');
  assert.equal(sentence('launch-timeout', { pane: 'Codex', seconds: 0 }).text.includes('within 20 seconds'), true,
    'a missing deadline still reads as the default budget, never as zero');
});

test('no sentence Lina says contains blame or defect vocabulary', () => {
  const rendered = [
    ...Object.entries(CASES).map(([key, [context]]) => [`sentence(${key})`, sentence(key, context).text]),
    ...Object.entries(CASES).map(([key, [context]]) => [`speech(${key})`, sentence(key, context).speech]),
    ['brainRejectionSentence', brainRejectionSentence({ status: 400, providerMessage: 'The conversation transcript is malformed.' })],
    ['failureSentence(launch-timeout)', failureSentence('launch-timeout', { pane: 'Codex', seconds: 20 })],
    ['taskWaitSentence(delivered)', taskWaitSentence({ targetId: 'a', generation: 'g', delivered: true, deliveryStatus: 'written' }, { id: 'a', generation: 'g', name: 'Codex' }).text],
    ['taskWaitSentence(unknown)', taskWaitSentence({ targetId: 'a', generation: 'g', deliveryStatus: 'unknown' }, { id: 'a', generation: 'g', name: 'Codex' }).text],
    ['taskWaitSentence(pane gone)', taskWaitSentence({ targetId: 'a', generation: 'g' }, undefined).text],
    ['outcomeSentence(blocked)', outcomeSentence({ kind: 'send_prompt', targetId: 'a', ok: false, status: 'blocked' }, [{ id: 'a', name: 'Codex' }]).text],
    ['outcomeSentence(created)', outcomeSentence({ kind: 'create_session', ok: true, status: 'created', processState: 'running', name: 'Codex', cwd: '/w/app' }, []).text],
    ['collectTaskReports(failed)', collectTaskReports({ executionDone: true, task: { status: 'failed', targets: [{ id: 'a', generation: 'g', name: 'Codex' }] },
      controller: new AbortController(), waits: [{ targetId: 'a', generation: 'g', done: true, failed: true, observedState: 'failed', delivered: true }] },
      [{ id: 'a', generation: 'g', name: 'Codex' }])[0].text],
    // The scheduler's queue reasons are appended verbatim to a status reply.
    ['formatTaskStatus(queued)', formatTaskStatus({ targets: [queuedTarget], sessions: [queuedTarget], jobs: [queuedJob] })],
    ['blockingReason(prerequisite)', blockingReason],
  ];
  for (const [label, text] of rendered) assert.deepEqual(banned(text), [], `${label}: ${text}`);
});

test('no user-facing string literal in the composers carries blame or defect vocabulary', () => {
  const composers = ['orchestratorFailureText.cjs', 'orchestratorResponse.cjs', 'orchestratorFinalResponse.cjs',
    'orchestratorTaskStatus.cjs', 'orchestratorTaskReports.cjs', 'orchestratorCommandCompletion.cjs'];
  let scanned = 0;
  for (const name of composers) {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'backend', name), 'utf8');
    // Comments explain the code to us, not the pane to the user.
    const code = source.split(/\r?\n/).filter(line => !line.trim().startsWith('//')).join('\n');
    for (const match of code.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)) {
      const value = match[1] ?? match[2] ?? match[3];
      if (!PROSE(value)) continue;
      scanned++;
      assert.deepEqual(banned(value), [], `${name}: ${value}`);
    }
  }
  assert.ok(scanned > 40, `expected the composers' sentences to be scanned, saw ${scanned}`);
});

test('the spoken form of a multi-pane reply stays inside two sentences and says where the rest is', () => {
  const parts = [{ text: 'Typed the task into Codex; waiting for it to start.', speech: 'Typed the task into Codex; waiting for it to start.' },
    { text: 'Opened Claude in app.', speech: 'Opened Claude in app.' }];
  assert.equal(speechFor([parts[0]]), parts[0].speech);
  assert.equal(speechFor(parts), 'Typed the task into Codex; waiting for it to start. One more update is in the conversation.');
  assert.equal(speechFor([...parts, parts[1]]), 'Typed the task into Codex; waiting for it to start. 2 more updates are in the conversation.');
  assert.ok(sentences(speechFor([...parts, parts[1]])) <= 2);
  assert.equal(firstSentence('One. Two. Three.'), 'One.');
});

async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-conversation-'));
  const f = { root, sessions: [], effects: [], plans: [], spoken: [] };
  f.relay = createOrchestrator({ userDataPath: root, secureStorage: { isEncryptionAvailable: () => false },
    ...(options.slowWaitMs !== undefined && { slowWaitMs: options.slowWaitMs }),
    getRoots: () => ({ documents: root, projects: [{ name: path.basename(root), path: root }] }),
    // A pane reaches the inventory on the refresh that follows its creation
    // receipt, never before it. registerAfterCreate reproduces that ordering.
    getSessions: () => { if (f.deferred) { f.sessions.push(f.deferred); f.deferred = null; } return f.sessions; },
    getLaunchers: async () => [{ kind: 'codex', label: options.launcherLabel || 'Codex', available: true, configured: true }],
    interpretIntent: async context => ({ goal: context.instruction, actions: [f.plans.shift()] }),
    routeTask: async () => ({ kind: 'choose', decision: 'create', kindOfSession: 'codex', reason: 'A separate agent for this objective.' }),
    readSession: async target => {
      const session = f.sessions.find(item => item.id === target.id);
      return session ? { ok: true, id: session.id, generation: session.generation, text: 'Do you trust the files in this folder?', sequence: 10, inputRevision: 2 }
        : { ok: false, status: 'stale-generation' };
    },
    onSpeak: event => { f.spoken.push(event); return { ok: true }; },
    dispatchAction: async action => {
      f.effects.push(action);
      if (action.kind === 'create_session') {
        const session = { id: 'pane-1', name: 'Codex 1', kind: 'codex', provider: 'codex', cwd: action.cwd, generation: 'g1',
          launchToken: 1, started: true, status: 'idle', observation: 'observed', processState: 'running',
          agentProcessState: 'running', agentPid: 4242, turnState: 'idle', revision: 1 };
        if (options.registerAfterCreate) f.deferred = session; else f.sessions.push(session);
        return { ok: true, status: 'created', id: session.id, launchToken: 1, processState: 'running', cwd: action.cwd,
          ...(options.registerAfterCreate ? {} : { name: session.name }),
          target: { id: session.id, generation: session.generation, launchToken: 1 } };
      }
      if (options.send) return options.send(action, f);
      const session = f.sessions[0];
      Object.assign(session, { turnState: 'running', turnId: action.actionId, actionId: action.actionId, turnStartedAt: Date.now() });
      return { ok: true, status: 'written', turnId: session.turnId };
    },
    fetch: async (url, requestOptions) => {
      if (url.endsWith('/key')) return jsonResponse({ data: {} });
      if (url.endsWith('/models')) return jsonResponse({ data: [{ id: 'scripted', context_length: 128000, supported_parameters: ['tools', 'tool_choice'] }] });
      if (options.brain) return options.brain(JSON.parse(requestOptions.body));
      return jsonResponse({ choices: [{ finish_reason: 'stop', message: { content: 'Acknowledged.' } }] });
    } });
  t.after(async () => { await f.relay.cancel(); await f.relay.dispose(); assert.equal(path.dirname(root), os.tmpdir()); await remove(root); });
  await f.relay.configure({ apiKey: 'test-key', model: 'scripted', sessionOnly: true });
  assert.equal((await f.relay.setEnabled(true)).ok, true);
  f.run = async text => { f.plans.push({ kind: 'delegate_task', text, cwd: root }); return f.relay.send({ text, origin: 'voice' }); };
  f.rows = () => f.relay.getState().messages.filter(message => message.origin === 'task' && !message.status).map(message => message.text);
  f.replies = () => f.relay.getState().messages.filter(message => message.role === 'assistant');
  return f;
}

test('a delegated start narrates opening, typing and starting once each, then cues done', { timeout: 6000 }, async t => {
  const f = await fixture(t);
  const result = await f.run('Have Codex investigate the orchestrator performance.');
  assert.equal(result.ok, true, JSON.stringify(result));
  await f.relay.refresh(); await tick();
  // In order, once each: what Lina is doing, what she typed, and the agent
  // picking it up. The user is never left guessing between them.
  assert.deepEqual(f.rows(), [
    `Opening Codex 1 in ${path.basename(f.root)}.`,
    'Typed the task into Codex 1; waiting for it to start.\nTask: Have Codex investigate the orchestrator performance.',
    'Codex 1 started working on it.',
  ]);
  await f.relay.refresh(); await tick();
  assert.equal(f.rows().length, 3, 'a fact already said is never said again');
  // The effect was watched happen, so the cue word and the ding are earned.
  const reply = f.replies().at(-1);
  assert.equal(reply.text, 'done');
  assert.equal(reply.completionCue, true);
  assert.ok(f.spoken.some(event => event.completionCue === true && event.speechText === 'done'));
  for (const event of f.spoken) assert.ok(sentences(event.speechText ?? event.text) <= 2, event.speechText ?? event.text);
  for (const text of [...f.rows(), ...f.replies().map(message => message.text)]) assert.deepEqual(banned(text), [], text);
});

test('a pane announced before it reaches the inventory is still named by what was launched', { timeout: 6000 }, async t => {
  const f = await fixture(t, { registerAfterCreate: true, launcherLabel: 'Claude Code' });
  const result = await f.run('Investigate the orchestrator performance.');
  assert.equal(result.ok, true, JSON.stringify(result));
  // The receipt is minted before the pane exists, so the row is named from the
  // launcher the request asked for and the folder it opened in, never "the
  // terminal". Once the pane is registered its own title takes over.
  assert.equal(f.rows()[0], `Opening Claude Code in ${path.basename(f.root)}.`);
  assert.deepEqual(f.rows().slice(1), ['Typed the task into Codex 1; waiting for it to start.\nTask: Investigate the orchestrator performance.',
    'Codex 1 started working on it.']);
  for (const text of f.rows()) assert.deepEqual(banned(text), [], text);
});

test('a send refused by a startup screen reports the screen, the answer, and what is next, with no cue', { timeout: 6000 }, async t => {
  const f = await fixture(t, {
    send: async (action, fixtureState) => {
      fixtureState.relay.recordStartupScreen({ id: 'pane-1', generation: 'g1', actionId: action.actionId, requestId: action.requestId,
        prompt: 'folder-trust', text: 'Codex 1 is showing a startup screen.' });
      return { ok: false, status: 'input-surface-unverified', delivery: 'not-dispatched', startupAnswered: 'folder-trust',
        error: failureSentence('input-surface-unverified', { pane: 'Codex 1' }) };
    } });
  const result = await f.run('Have Codex investigate the orchestrator performance.');
  await f.relay.refresh(); await tick();
  assert.deepEqual(f.rows(), [
    `Opening Codex 1 in ${path.basename(f.root)}.`,
    "Codex 1 is still on its startup screen (trust prompt); I'll answer it and keep trying for 20 seconds.",
    'Answered the trust prompt; typing the task now.',
  ]);
  // The reply names the pane, says nothing was typed, and says what to do next.
  const text = result.text || result.error;
  assert.match(text, /Codex 1 was still on its startup screen, so nothing was typed/);
  assert.match(text, /say 'try again' when it's ready/);
  assert.equal(f.replies().some(message => message.completionCue), false, 'nothing was observed, so nothing is cued');
  assert.equal(f.spoken.some(event => event.completionCue), false);
  for (const line of [...f.rows(), text]) assert.deepEqual(banned(line), [], line);
});

test('a brain failure after a pane was opened says what it meant and names the open pane', { timeout: 6000 }, async t => {
  const f = await fixture(t, {
    send: async () => ({ ok: false, status: 'input-surface-unverified', delivery: 'not-dispatched',
      error: failureSentence('input-surface-unverified', { pane: 'Codex 1' }) }),
    brain: () => jsonResponse({ error: { code: 400, message: 'Provider returned error: the conversation transcript is malformed.',
      metadata: { provider_name: 'Google' } } }, 400) });
  const result = await f.run('Have Codex investigate the orchestrator performance.');
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.match(result.error, /^I couldn't get a plan from the brain for that one, so nothing was typed\./);
  assert.match(result.error, /Codex 1 in .+ is still open\.$/);
  assert.deepEqual(banned(result.error), [], result.error);
  // The provider's own wording is still available privately, on the receipt.
  assert.ok(f.relay.getState().receipts.some(receipt => /startup screen/.test(receipt.text || '')));
  for (const event of f.spoken) assert.ok(sentences(event.speechText ?? event.text) <= 2, event.speechText ?? event.text);
});

test('a pane that stays slow to become ready is spoken about once, and only once', { timeout: 6000 }, async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { slowWaitMs: 20, send: async (action, fixtureState) => {
    await held;
    const session = fixtureState.sessions[0];
    Object.assign(session, { turnState: 'running', turnId: action.actionId, actionId: action.actionId, turnStartedAt: Date.now() });
    return { ok: true, status: 'written', turnId: session.turnId };
  } });
  const running = f.run('Have Codex investigate the orchestrator performance.');
  await new Promise(resolve => setTimeout(resolve, 80));
  // Progress rows are written, never spoken. This one line is the exception: a
  // wait the user cannot see is worth a sentence out loud.
  const expected = `Still waiting for Codex 1 in ${path.basename(f.root)} to become ready.`;
  const waiting = f.relay.getState().messages.filter(message => message.speak === true);
  assert.deepEqual(waiting.map(message => message.text), [expected]);
  assert.deepEqual(f.spoken.filter(event => event.kind === 'task-report').map(event => event.text), [expected]);
  release();
  await running;
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(f.relay.getState().messages.filter(message => message.speak === true).length, 1, 'said once per request');
  for (const event of f.spoken) assert.ok(sentences(event.speechText ?? event.text) <= 2, event.speechText ?? event.text);
});

test('a reply about two panes reads in full and speaks in two sentences', () => {
  const sessions = [{ id: 'a', generation: 'g', name: 'Codex 1' }, { id: 'b', generation: 'g', name: 'Codex 2' }];
  const composed = composeFinalResponse({ sessions,
    outcomes: [{ kind: 'send_prompt', actionId: 'one', targetId: 'a', generation: 'g', ok: true, status: 'written' },
      { kind: 'send_prompt', actionId: 'two', targetId: 'b', generation: 'g', ok: true, status: 'written' }],
    waits: [{ actionId: 'one', targetId: 'a', generation: 'g', delivered: true, deliveryStatus: 'written' },
      { actionId: 'two', targetId: 'b', generation: 'g', delivered: true, deliveryStatus: 'written' }] });
  assert.equal(composed.text, "Typed the task into Codex 1, but I haven't seen it start yet. I'll tell you when it does.\n\n"
    + "Typed the task into Codex 2, but I haven't seen it start yet. I'll tell you when it does.");
  assert.equal(composed.speech, 'Typed the task into Codex 1, but I haven\'t seen it start yet. One more update is in the conversation.');
  assert.ok(sentences(composed.speech) <= 2);
  assert.deepEqual(banned(composed.text), []);
});
