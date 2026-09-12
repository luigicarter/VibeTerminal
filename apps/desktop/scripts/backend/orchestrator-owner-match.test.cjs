'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { resolveTitledOwner } = require('../../backend/orchestratorOwnerMatch.cjs');

const project = 'vibeTerminal';
const candidate = (agentId, name, titles = []) => ({ agentId, name, titles });
const chatSection = candidate('agent-chat', 'Add project chat section');
const instruction = 'tell the agent working on project chat section to continue';

test('a uniquely titled agent in the project owns the named continuation', () => {
  const result = resolveTitledOwner({ instruction, projectName: project,
    candidates: [candidate('agent-startup', 'Fix Open Codex startup'), chatSection,
      candidate('agent-colors', 'Overhaul terminal colors'), candidate('agent-perf', 'Investigate terminal performance')] });
  assert.deepEqual({ status: result.status, agentId: result.agentId }, { status: 'matched', agentId: 'agent-chat' });
  assert.ok(result.score >= 0.6, `score ${result.score}`);
});

test('a wake-prefixed spoken instruction still selects the same owner', () => {
  const result = resolveTitledOwner({ projectName: project, candidates: [chatSection, candidate('agent-colors', 'Overhaul terminal colors')],
    instruction: 'Hey Lena. Can you tell the agent working on the project chat section in Vibe terminal to continue its work.' });
  assert.equal(result.status, 'matched');
  assert.equal(result.agentId, 'agent-chat');
});

test('a work-item title identifies an owner whose pane name does not', () => {
  const result = resolveTitledOwner({ instruction, projectName: project,
    candidates: [candidate('agent-two', 'Codex Web 2', ['Add project chat section']), candidate('agent-colors', 'Overhaul terminal colors')] });
  assert.equal(result.status, 'matched');
  assert.equal(result.agentId, 'agent-two');
});

test('two agents sharing the named words are ambiguous', () => {
  const result = resolveTitledOwner({ instruction, projectName: project,
    candidates: [chatSection, candidate('agent-rival', 'Chat section polish'), candidate('agent-colors', 'Overhaul terminal colors')] });
  assert.deepEqual(result, { status: 'ambiguous', candidateCount: 2 });
});

test('an eligible runner-up a clear margin behind still leaves one owner', () => {
  const leader = candidate('agent-chat', 'Chat section'), rival = candidate('agent-rival', 'Chat section rewrite');
  const alone = resolveTitledOwner({ instruction: 'tell the agent working on the chat section to continue', projectName: project, candidates: [rival] });
  assert.equal(alone.status, 'matched', 'the runner-up is eligible on its own');
  const result = resolveTitledOwner({ instruction: 'tell the agent working on the chat section to continue', projectName: project, candidates: [leader, rival] });
  assert.deepEqual({ status: result.status, agentId: result.agentId }, { status: 'matched', agentId: 'agent-chat' });
  assert.ok(result.score - alone.score >= 0.3, `${result.score} vs ${alone.score}`);
});

test('a title that is mostly unmentioned work stays below the threshold', () => {
  const result = resolveTitledOwner({ instruction, projectName: project,
    candidates: [candidate('agent-long', 'Add the project chat section to the sidebar dock with drag handles')] });
  assert.deepEqual(result, { status: 'no-match', candidateCount: 1 });
});

test('one named word is never enough', () => {
  const result = resolveTitledOwner({ instruction: 'tell the agent working on the chat to continue', projectName: project,
    candidates: [candidate('agent-chat', 'Chat rebuild')] });
  assert.deepEqual(result, { status: 'no-match', candidateCount: 1 });
});

test('provider defaults, shell paths and the project name are never eligible', () => {
  for (const name of ['Codex Web 8', 'C:/Users/ahmed/Documents/vibeTerminal', 'powershell.exe', '⠴ vibeTerminal', 'vibeTerminal']) {
    const result = resolveTitledOwner({ projectName: project, candidates: [candidate('agent-default', name)],
      instruction: `tell the agent working on ${name} to continue` });
    assert.deepEqual(result, { status: 'no-match', candidateCount: 1 }, name);
  }
});

test('shared stopwords alone never establish ownership', () => {
  const result = resolveTitledOwner({ projectName: project, candidates: [candidate('agent-generic', 'Codex terminal agent work')],
    instruction: 'tell the codex terminal agent working in this project to continue its work' });
  assert.deepEqual(result, { status: 'no-match', candidateCount: 1 });
});

test('the project name in the instruction cannot select a pane named after the project', () => {
  const result = resolveTitledOwner({ projectName: 'checkout project', instruction: 'tell the agent working on the checkout project to continue',
    candidates: [candidate('agent-project', 'Checkout project maintenance')] });
  assert.equal(result.status, 'no-match');
});

test('malformed input is inert', () => {
  assert.deepEqual(resolveTitledOwner(), { status: 'no-match', candidateCount: 0 });
  assert.deepEqual(resolveTitledOwner({ instruction, candidates: null }), { status: 'no-match', candidateCount: 0 });
  assert.deepEqual(resolveTitledOwner({ instruction, candidates: [null, { name: 'Add project chat section' }, { agentId: '', name: 'Add project chat section' }] }),
    { status: 'no-match', candidateCount: 3 });
  assert.deepEqual(resolveTitledOwner({ instruction: undefined, candidates: [chatSection] }), { status: 'no-match', candidateCount: 1 });
});
