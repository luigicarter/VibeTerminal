'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createPlanningInput } = require('../../backend/orchestratorInterpreter.cjs');
const { plannerTools, decodePlannerCalls, withheldPlannerFields } = require('../../backend/orchestratorPlannerTools.cjs');
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
const LIVE_ARGUMENTS = { operationMode: 'task', promptMode: 'compose', text: 'Inspect fixture marker CHECK-CEDAR and report its result.',
  targetIds: ['fixture-cedar'], permissionMode: 'none', lifecycleMode: 'preserve', answerMode: 'delegated', selection: 'one' };

test('a request naming one existing pane offers that pane, its operation and no availability requirement', () => {
  const context = requestThreeContext();
  const { planningTools, messages } = createPlanningInput(context);
  const payload = JSON.parse(messages[1].content);

  const cedar = payload.roster.find(pane => pane.id === 'fixture-cedar');
  assert.ok(cedar, 'The addressed pane reaches the planner in the roster.');
  assert.equal(cedar.name, 'Cedar');
  assert.equal(cedar.provider, 'codex');
  assert.equal(cedar.cwd, sessions[2].cwd);
  // The pane reports status "running" (its process) and turnState "idle" (its
  // agent). One derived state says the only thing a plan needs: it is free.
  assert.equal(cedar.state, 'free', 'The roster reports the pane as free of a running turn.');
  assert.equal(cedar.status, undefined);
  assert.equal(cedar.turnState, undefined);
  assert.equal(payload.roster[0].id, 'fixture-cedar', 'The addressed project leads the roster.');
  assert.equal(payload.memory.episodes.length, 2, 'The two settled requests reach the planner as memory episodes.');

  const operate = planningTools.find(tool => tool.function.name === 'plan_operate_terminal');
  assert.ok(operate, 'A pane the user named by name is an existing-terminal selection.');
  assert.ok(operate.function.parameters.properties.targetIds, 'The planner can address the named pane by ID.');
  assert.equal(operate.function.parameters.properties.targetAvailability, undefined,
    'A sentence that states no free-terminal requirement is never offered the availability restriction.');
  assert.deepEqual([...withheldPlannerFields(context)], ['targetAvailability']);

  const decoded = decodePlannerCalls([plannerCall('interpret_workspace', { goal: instruction }),
    plannerCall('plan_operate_terminal', LIVE_ARGUMENTS)], planningTools, instruction);
  const plan = normalizeIntent(decoded, context);
  assert.equal(plan.clarification, undefined, JSON.stringify(plan.clarification));
  assert.deepEqual(plan.grants.map(grant => grant.targets.map(target => target.id)), [['fixture-cedar']]);
});

test('an unasked availability restriction is what turned the named pane into a refusal', () => {
  const context = requestThreeContext();
  // The regression this gate removes: one live interpretation in thirteen added
  // targetAvailability:idle to a request that never asked for a free terminal.
  // Normalization drops every busy target, so the addressed pane disappeared and
  // the request answered with a clarification instead of typing the task.
  const plan = normalizeIntent({ goal: instruction, actions: [{ kind: 'operate_terminal', ...LIVE_ARGUMENTS, targetAvailability: 'idle' }] }, context);
  assert.deepEqual(plan.grants, []);
  assert.equal(plan.clarification, targetAvailabilityError().message);
});

test('a stated free-terminal requirement, and only that, still reaches the planner', () => {
  for (const text of ['Send this to a Codex terminal that is not busy in the Gamma project.',
    'Use one of the empty Codex terminals in Gamma to inspect CHECK-CEDAR.',
    'Give this to an idle Codex agent in Gamma.',
    'Put it in any available Codex terminal in Gamma.',
    'Only use Cedar if it is free.']) {
    assert.deepEqual([...withheldPlannerFields(requestThreeContext({ instruction: text }))], [],
      `A stated free-terminal requirement keeps the restriction available: ${text}`);
  }
  const tools = plannerTools(requestThreeContext({ instruction: 'Tell Cedar in Gamma to inspect CHECK-CEDAR, but only while it is idle.' }));
  assert.ok(tools.find(tool => tool.function.name === 'plan_operate_terminal')?.function.parameters.properties.targetAvailability,
    'The offered operation carries the restriction the sentence asked for.');
  // An unfinished grant that already carries the restriction keeps it offered,
  // so a continuation can restate its own frozen requirement.
  const pending = plannerTools(requestThreeContext({ instruction: 'Continue that one.',
    previousCommand: { requestId: 'earlier', instruction: 'Use a free terminal.', grants: [{ kind: 'operate_terminal', targetAvailability: 'idle', targets: [], args: {} }] } }));
  assert.ok(pending.find(tool => tool.function.name === 'plan_operate_terminal')?.function.parameters.properties.targetAvailability);
});
