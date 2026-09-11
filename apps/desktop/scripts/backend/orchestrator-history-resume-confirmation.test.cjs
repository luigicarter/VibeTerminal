'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { authorizeConversationResume, captureConversationResumeCandidate, isConversationResumeConfirmation } = require('../../backend/orchestratorPolicy.cjs');
const { createOrchestratorHistory } = require('../../backend/orchestratorHistory.cjs');
const item = { reference: 'ref', id: 'native-id', provider: 'codex', cwd: process.cwd(), title: 'Mix 21 last attempt' };
const action = { kind: 'resume_conversation', reference: 'ref' };
const grant = { kind: 'resume_conversation', args: {} };

test('resume allows sentence wrappers without silently correcting spoken titles', () => {
  for (const text of ['Can you resume the Mix 21 last attempt conversation?', 'Resume Mix 21 last attempt chat.', 'Resume Mix 21 last attempt?']) {
    assert.equal(authorizeConversationResume(action, { text }, [item]).reference, item.reference);
  }
  assert.throws(() => authorizeConversationResume(action, { text: 'Can you resume the mix to one last attempt conversation?' }, [item]), /Name one/);
  const literal = { ...item, reference: 'literal', title: 'Mix 21 last attempt conversation?' };
  assert.equal(authorizeConversationResume({ ...action, reference: 'literal' }, { text: 'Resume Mix 21 last attempt conversation?' }, [item, literal]).reference, 'literal');
  for (const text of ['Do not resume Mix 21 last attempt conversation?', 'If ready resume Mix 21 last attempt', 'Explain "resume Mix 21 last attempt"']) assert.throws(() => authorizeConversationResume(action, { text }, [item]));
});

test('resume confirmation classifier accepts only complete affirmative answers', () => {
  for (const text of ['yes', 'Yeah.', 'yes, please', 'okay, go ahead', "that's the one!", 'yes resume it', 'resume that conversation', 'that is it']) assert.equal(isConversationResumeConfirmation(text), true, text);
  for (const text of ['no', 'not that one', 'yes but do not resume it', 'yes if it is safe', 'yes and delete the other one', 'I said yes yesterday', 'is that the one?', '"yes"', '', null]) assert.equal(isConversationResumeConfirmation(text), false, String(text));
});

test('candidate capture respects frozen resume scope and rejects invented identity', () => {
  assert.throws(() => captureConversationResumeCandidate('ref', { kind: 'send_prompt' }, [item]), /resume grant/);
  assert.throws(() => captureConversationResumeCandidate('unknown', grant, [item]), /one saved/);
  assert.throws(() => captureConversationResumeCandidate('ref', grant, [item, item]), /one saved/);
  for (const key of ['provider', 'cwd', 'reference']) assert.throws(() => captureConversationResumeCandidate('ref', { ...grant, args: { [key]: 'different' } }, [item]), /outside/);
  const candidate = captureConversationResumeCandidate('ref', grant, [item]);
  assert.ok(Object.isFrozen(candidate)); assert.ok(Object.isFrozen(candidate.identity)); assert.ok(Object.isFrozen(candidate.selection));
  assert.deepEqual(authorizeConversationResume(action, { text: 'yes', confirmedResume: candidate }, [item]).selection, { kind: 'title', value: item.title, provider: item.provider, cwd: item.cwd });
  assert.throws(() => authorizeConversationResume(action, { text: 'yes', confirmedResume: structuredClone(candidate) }, [item]), /application-owned/);
  assert.throws(() => authorizeConversationResume(action, { text: 'yes' }, [item]), /Name one/);
  assert.throws(() => authorizeConversationResume({ ...action, reference: 'other' }, { confirmedResume: candidate }, [item]), /different saved/);
  for (const key of ['title', 'id', 'cwd', 'provider', 'claudeHome', 'providerProfileId', 'openFusion', 'plannerProvider']) assert.throws(() => authorizeConversationResume(action, { confirmedResume: candidate }, [{ ...item, [key]: 'changed' }]), /candidate changed/);
  assert.throws(() => authorizeConversationResume(action, { confirmedResume: candidate }, []), /candidate changed/);
});

test('confirmed candidate still rechecks native title, uniqueness and complete discovery', async () => {
  let complete = true;
  let threads = [{ id: 'native-id', title: item.title }];
  const service = createOrchestratorHistory({ getKnownScopes: () => [{ provider: 'codex', cwd: item.cwd }], lookupThreads: async () => ({ status: 'found', complete, threads }) });
  const history = (await service.list({})).conversations;
  const reference = history[0].reference;
  const candidate = captureConversationResumeCandidate(reference, grant, history);
  const authorized = authorizeConversationResume({ kind: 'resume_conversation', reference }, { text: 'yes', confirmedResume: candidate }, history);
  assert.equal((await service.resolve(authorized)).id, item.id);
  threads.push({ id: 'duplicate', title: item.title });
  await assert.rejects(service.resolve(authorized), /ambiguous/);
  threads = [{ id: 'native-id', title: 'Renamed' }];
  await assert.rejects(service.resolve(authorized), /changed/);
  threads = [{ id: 'native-id', title: item.title }]; complete = false;
  await assert.rejects(service.resolve(authorized), /incomplete/);
});
