'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createPlanningInput } = require('../../backend/orchestratorInterpreter.cjs');
const { plannerTools, decodePlannerCalls } = require('../../backend/orchestratorPlannerTools.cjs');
const { normalizeIntent } = require('../../backend/orchestratorIntent.cjs');
const { targetAvailabilityError } = require('../../backend/orchestratorTargetAvailability.cjs');

// The five-pane fixture of scripts/qa/orchestrator-live-tasks.cjs, reproduced
// exactly: five idle Codex panes in five registered projects, each addressed by
// its own name in its own request. The live probe submits all five at once, so
// the third request is interpreted after the first two have already delivered.
const ROOT = 'C:/Users/ahmed/Documents/vibeTerminal/apps/desktop/.tmp/orchestrator-live-tasks/run';
const PANES = [['Atlas', 'Alpha'], ['Beacon', 'Beta'], ['Cedar', 'Gamma'], ['Delta', 'Delta'], ['Ember', 'Epsilon']];
const projects = PANES.map(([, folder]) => ({ name: folder, path: path.win32.join(ROOT, folder) }));
const sessions = PANES.map(([name, folder], index) => ({
  id: `fixture-${name.toLowerCase()}`, name, title: name, cwd: path.win32.join(ROOT, folder), generation: 1,
  kind: 'codex', provider: 'codex', started: true, launchToken: 1, conversationId: `fixture-conversation-${name.toLowerCase()}`,
  // The probe reports what a live Codex pane reports: a running process with an
  // idle turn. isIdleTarget reads `status`, so none of these panes is "free".
  status: 'running', processState: 'running', agentProcessState: 'running', agentPid: 9000 + index,
  observation: 'observed', turnState: 'idle', revision: 1, sequence: 1, inputRevision: 0, lastActivityAt: 1757000000000 + index }));
const instruction = 'Tell Cedar in the Gamma project to inspect fixture marker CHECK-CEDAR and report its result.';

// Request three, in the state the probe reaches it: requests one and two have
// settled into ledger rows and pane memory, and Cedar has never been touched.
function requestThreeContext(extra = {}) {
  return {
    instruction, requestId: 'request-cedar', sessions, requests: [], projects,
    roots: { documents: ROOT, projects }, projectContext: projects[2],
    recentUserMessages: PANES.slice(0, 2).map(([name, folder], index) => ({ id: `request-${index}`,
      text: `Tell ${name} in the ${folder} project to inspect fixture marker CHECK-${name.toUpperCase()} and report its result.` })),
    memory: { episodes: PANES.slice(0, 2).map(([name, folder], index) => ({ requestId: `request-${index}`, at: 1757000000000 + index,
      verb: 'start', outcome: 'delivered-started', pane: { id: `fixture-${name.toLowerCase()}`, name },
      typedText: `Inspect fixture marker CHECK-${name.toUpperCase()} and report its result.` })) },
    roster: PANES.slice(0, 2).map(([name], index) => ({ id: `fixture-${name.toLowerCase()}`, title: name,
      objective: `Inspect fixture marker CHECK-${name.toUpperCase()}.`, lastPromptAt: 1757000000000 + index })),
    ...extra,
  };
}

const plannerCall = (name, args) => ({ function: { name, arguments: JSON.stringify(args) } });
// The exact plan_operate_terminal arguments the live brain returned for this
// request family, captured with LINA_MODEL_DEBUG_ALL.
// The pane is named by its roster handle: Cedar is the third session, so T3.
const LIVE_ARGUMENTS = { operationMode: 'task', promptMode: 'compose', text: 'Inspect fixture marker CHECK-CEDAR and report its result.',
  handles: ['T3'], permissionMode: 'none', lifecycleMode: 'preserve', answerMode: 'delegated' };

test('a request naming one existing pane offers that pane, its operation and no availability requirement', () => {
  const context = requestThreeContext();
  const { planningTools, messages } = createPlanningInput(context);
  const payload = JSON.parse(messages[1].content);

  const cedar = payload.roster.find(pane => pane.handle === 'T3');
  assert.ok(cedar, 'The addressed pane reaches the planner in the roster.');
  assert.equal(cedar.name, 'Cedar');
  assert.equal(cedar.provider, 'codex');
  assert.equal(cedar.project, sessions[2].projectName || require('node:path').basename(sessions[2].cwd), 'the pane names its project; the app resolves the folder');
  // The pane reports status "running" (its process) and turnState "idle" (its
  // agent). One derived state says the only thing a plan needs: it is free.
  assert.equal(cedar.state, 'idle', 'The roster reports the pane as free of a running turn.');
  assert.equal(cedar.status, undefined);
  assert.equal(cedar.turnState, undefined);
  assert.equal(payload.roster[0].handle, 'T3', 'The addressed project leads the roster.');
  assert.equal(payload.memory.episodes.length, 2, 'The two settled requests reach the planner as memory episodes.');

  const operate = planningTools.find(tool => tool.function.name === 'plan_operate_terminal');
  assert.ok(operate, 'A pane the user named by name is an existing-terminal selection.');
  assert.ok(operate.function.parameters.properties.handles, 'The planner addresses the named pane by its handle.');
  for (const field of ['targetIds', 'targetAvailability', 'selection', 'assignmentMode']) {
    assert.equal(operate.function.parameters.properties[field], undefined, `${field} is the application's to derive, never the planner's to fill`);
  }

  const decoded = decodePlannerCalls([plannerCall('interpret_workspace', { goal: instruction }),
    plannerCall('plan_operate_terminal', LIVE_ARGUMENTS)], planningTools, instruction, context);
  assert.deepEqual(decoded.actions[0].targetIds, ['fixture-cedar'], 'the handle is turned back into the pane id');
  assert.equal(decoded.actions[0].targetAvailability, undefined, 'a sentence that states no free-terminal requirement gets no availability restriction');
  const plan = normalizeIntent(decoded, context);
  assert.equal(plan.clarification, undefined, JSON.stringify(plan.clarification));
  assert.deepEqual(plan.grants.map(grant => grant.targets.map(target => target.id)), [['fixture-cedar']]);
  // A handle the roster never showed is a pane the model made up.
  assert.throws(() => decodePlannerCalls([plannerCall('plan_operate_terminal', { ...LIVE_ARGUMENTS, handles: ['T9'] })], planningTools, instruction, context), /not a handle in the roster/);
});

test('an unasked availability restriction no longer turns the named pane into a refusal', () => {
  const context = requestThreeContext();
  // The regression this gate removes: one live interpretation in thirteen added
  // targetAvailability:idle to a request that never asked for a free terminal.
  // Normalization used to drop the addressed pane as busy because its process
  // status read "running" while its agent sat at an idle turn, and the request
  // answered with a clarification instead of typing the task. The pane is free
  // by its turn, so the restriction now changes nothing.
  // The normalizer's own contract, with the ids the decoder hands it.
  const { handles, ...action } = LIVE_ARGUMENTS;
  const plan = normalizeIntent({ goal: instruction, actions: [{ kind: 'operate_terminal', ...action, targetIds: ['fixture-cedar'], targetAvailability: 'idle' }] }, context);
  assert.deepEqual(plan.grants.map(grant => grant.targets.map(target => target.id)), [['fixture-cedar']]);
  // A pane that is genuinely busy is still not offered, and the request asks.
  const busy = { ...context, sessions: context.sessions.map(session => session.id === 'fixture-cedar' ? { ...session, turnState: 'running', turnId: 'turn-1' } : session) };
  assert.throws(() => normalizeIntent({ goal: instruction, actions: [{ kind: 'operate_terminal', ...action, targetIds: ['fixture-cedar'], targetAvailability: 'idle' }] }, busy),
    error => error.code === 'ORCHESTRATOR_LAST_TARGET_SELECTION' && error.clarification === targetAvailabilityError().message);
});

test('a stated free-terminal requirement, and only that, is derived from the sentence when the plan is decoded', () => {
  const restricted = text => {
    const context = requestThreeContext({ instruction: text });
    const tools = plannerTools(context);
    return decodePlannerCalls([plannerCall('plan_operate_terminal', { ...LIVE_ARGUMENTS, text: 'Inspect CHECK-CEDAR.' })], tools, text, context).actions[0].targetAvailability;
  };
  for (const text of ['Tell Cedar in Gamma to inspect CHECK-CEDAR, but only while it is idle.',
    'Use the empty Codex terminal in Gamma to inspect CHECK-CEDAR.',
    'Give this to Cedar in Gamma if it is not busy.']) {
    assert.equal(restricted(text), 'idle', `A stated free-terminal requirement restricts the operation: ${text}`);
  }
  assert.equal(restricted(instruction), undefined, 'a sentence that states no requirement gets none, whatever the model writes');
  // Whatever the model writes into the field is dropped: the sentence decides.
  const context = requestThreeContext();
  const written = decodePlannerCalls([plannerCall('plan_operate_terminal', { ...LIVE_ARGUMENTS, targetAvailability: 'idle', selection: 'all' })], plannerTools(context), instruction, context);
  assert.deepEqual([written.actions[0].targetAvailability, written.actions[0].selection], [undefined, undefined]);
});
