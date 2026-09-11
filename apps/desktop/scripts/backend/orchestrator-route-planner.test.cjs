'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { planTaskRoute, validateRouteCall, ROUTING_TOOL, ROUTING_CHOOSE_TOOL, deterministicNewTaskRoute, RoutingError } = require('../../backend/orchestratorRoutePlanner.cjs');
const call = (args, id = 'call', name = 'route_workspace_task') => ({ id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } });
const response = (...calls) => ({ choices: [{ message: { tool_calls: calls } }] });
const choose = { kind: 'choose', decision: 'reuse', targetId: 'owner-237', workItemId: 'work-a', reason: 'Observed continuation of task A.' };

test('named agent routing separates record discovery from choices and refuses changed task text', async () => {
  const reads = [], context = { harnessVersion: 'agents-v1', instruction: 'Fix checkout.', launchers: [{ kind: 'codex', available: true, configured: true }] };
  let round = 0;
  const result = await planTaskRoute({ context, read: async input => { reads.push(input); return { ok: true, agents: [{ agentId: 'agent-owner' }] }; },
    complete: async (_messages, tools) => {
      assert(tools.some(t => t.function.name === 'choose_existing_agent'));
      if (round++ === 0) return response(call({ query: 'checkout' }, 'find', 'find_agents'));
      if (round === 2) return response(call({ agentId: 'agent-owner', reason: 'Same task', text: 'Different task.' }, 'bad-choice', 'choose_existing_agent'));
      return response(call({ agentId: 'agent-owner', reason: 'Recorded checkout owner.' }, 'owner', 'choose_existing_agent'));
    } });
  assert.deepEqual(reads, [{ kind: 'find_agents', query: 'checkout' }]);
  assert.equal(result.agentId, 'agent-owner'); assert.equal(result.targetId, undefined);
  assert.equal(round, 3);
  for (const input of [{ kind: 'choose', decision: 'create', kindOfSession: 'codex', agentId: 'mixed', reason: 'create' },
    { kind: 'choose', decision: 'clarify', agentId: 'mixed', text: 'Which task?', reason: 'unclear' }]) assert.throws(() => validateRouteCall(input));
});

test('read-only loop pages beyond 200 initial candidates then reads the selected owner before choosing', async () => {
  const sessions = Array.from({ length: 240 }, (_, i) => ({ id: `owner-${i}`, name: `Candidate ${i}` }));
  const reads = []; let round = 0, resets = 0;
  const result = await planTaskRoute({ context: { sessions: sessions.slice(0, 20), sessionDirectory: { total: 240, truncated: true } },
    resetReadBudget: () => resets++,
    complete: async (messages, tools) => {
      assert.deepEqual(tools, [round === 7 ? ROUTING_CHOOSE_TOOL : ROUTING_TOOL]);
      if (round < 6) return response(call({ kind: 'list_sessions', offset: round++ * 40, limit: 40 }, `page-${round}`));
      if (round++ === 6) { assert.ok(messages.some(m => m.role === 'tool' && m.content.includes('owner-237'))); return response(call({ kind: 'read_session', targetId: 'owner-237' })); }
      assert.match(messages.filter(message => message.role === 'tool').at(-1).content, /task A/); return response(call(choose));
    }, read: async args => { reads.push(args); return args.kind === 'list_sessions' ? { ok: true, sessions: sessions.slice(args.offset, args.offset + args.limit), nextOffset: args.offset < 200 ? args.offset + 40 : null } : { ok: true, text: 'This agent owns task A.' }; } });
  assert.equal(result.targetId, 'owner-237'); assert.equal(reads.length, 7); assert.equal(resets, 8);
});

test('effect tools, extra replay authority and malformed model args never reach adapter', async () => {
  const invalid = [call({ kind: 'send_prompt', text: 'unsafe' }), call({ kind: 'list_sessions' }, 'other-tool', 'workspace'), call({ kind: 'list_sessions', grantId: 'replayed-authority' }), call('{bad'), call({ kind: 'read_session', targetId: 'x', generation: 'replayed-generation' })];
  let round = 0, reads = 0;
  const result = await planTaskRoute({ context: {}, maxRounds: 7, read: async () => { reads++; }, complete: async messages => {
    if (round) assert.equal(JSON.parse(messages.filter(message => message.role === 'tool').at(-1).content).ok, false);
    return response(round < invalid.length ? invalid[round++] : call({ kind: 'choose', decision: 'create', kindOfSession: 'codex', reason: 'No suitable worker.' }));
  } });
  assert.equal(reads, 0); assert.equal(result.decision, 'create');
  assert.ok(!ROUTING_TOOL.function.parameters.properties.kind.enum.some(kind => ['create_session', 'send_prompt', 'interrupt', 'resume_conversation'].includes(kind)));
});

test('choose cannot share a batch with reads or another decision', async () => {
  let round = 0;
  const result = await planTaskRoute({ context: {}, read: async () => ({ ok: true }), complete: async messages => {
    if (!round++) return response(call({ kind: 'list_sessions' }, 'read'), call(choose, 'choose'));
    assert.match(messages.at(-1).content, /own single tool call/); return response(call(choose));
  } });
  assert.equal(result.decision, 'reuse');
});

test('independent routing reads share one model round before the evidence-based choice', async () => {
  let rounds = 0;
  const reads = [];
  const result = await planTaskRoute({ context: { sessions: [{ id: 'owner-237' }] },
    read: async args => { reads.push(args.kind); return { ok: true, text: args.kind === 'read_session' ? 'Owns task A.' : 'Recorded task A.' }; },
    complete: async messages => {
      if (++rounds === 1) return response(call({ kind: 'list_work_items', query: 'task A' }, 'work'), call({ kind: 'read_session', targetId: 'owner-237' }, 'pane'));
      assert.deepEqual(messages.filter(message => message.role === 'tool').map(message => message.tool_call_id), ['work', 'pane']);
      assert.match(messages.at(-1).content, /Owns task A/);
      return response(call(choose));
    } });
  assert.equal(result.targetId, 'owner-237');
  assert.equal(rounds, 2);
  assert.deepEqual(reads, ['list_work_items', 'read_session']);
});

test('opaque reasoning blocks and original tool call IDs survive the next model round unchanged', async () => {
  const reasoning = [{ type: 'reasoning.encrypted', data: 'opaque-do-not-edit', signature: 'sig' }];
  let round = 0;
  await planTaskRoute({ context: { instruction: 'original task' }, read: async () => ({ ok: true }), complete: async messages => {
    if (!round++) return { choices: [{ message: { content: null, reasoning_details: reasoning, tool_calls: [call({ kind: 'list_work_items' }, 'stable-id')] } }] };
    const assistant = messages.find(m => m.role === 'assistant');
    assert.deepEqual(assistant.reasoning_details, reasoning); assert.notEqual(assistant.reasoning_details, reasoning);
    assert.equal(messages.at(-1).tool_call_id, 'stable-id'); assert.equal(assistant.tool_calls[0].id, 'stable-id');
    assert.equal(JSON.parse(messages[1].content).instruction, 'original task'); return response(call(choose));
  } });
});

test('bounded rounds, incomplete output and cancellation stop discovery without decisions', async () => {
  let rounds = 0;
  await assert.rejects(planTaskRoute({ context: {}, maxRounds: 2, complete: async () => { rounds++; return response(call({ kind: 'list_sessions' })); }, read: async () => ({ ok: true }) }), /reached its limit/);
  assert.equal(rounds, 2);
  await assert.rejects(planTaskRoute({ context: {}, complete: async () => ({ choices: [{ finish_reason: 'length', message: { tool_calls: [call(choose)] } }] }), read: async () => assert.fail() }), /incomplete/);
  let cancelled = false;
  await assert.rejects(planTaskRoute({ context: {}, check: () => { if (cancelled) throw Error('cancelled'); }, complete: async () => { cancelled = true; return response(call(choose)); }, read: async () => assert.fail() }), /cancelled/);
});

test('incomplete provider responses cannot authorize routing decisions or evidence reads', async () => {
  for (const finishReason of ['length', 'content_filter', 'error', 'cancelled', 'unknown-provider-reason']) {
    for (const args of [choose, { kind: 'choose', decision: 'create', kindOfSession: 'codex', reason: 'New worker needed.' }, { kind: 'list_sessions' }]) {
      let rounds = 0, reads = 0;
      await assert.rejects(planTaskRoute({ context: {}, complete: async () => {
        rounds++;
        return { choices: [{ finish_reason: finishReason, message: { tool_calls: [call(args)] } }] };
      }, read: async () => { reads++; return { ok: true }; } }), /incomplete.*no terminal was assigned/i,
      `${finishReason}: ${args.decision || args.kind}`);
      assert.equal(rounds, 1, 'a stopped provider response must not enter another routing round');
      assert.equal(reads, 0, 'do not consume tools from an incomplete response');
    }
  }
});

test('complete routing tool responses retain supported provider finish reasons', async () => {
  for (const finishReason of [undefined, null, '', 'stop', 'tool_calls']) {
    const result = await planTaskRoute({ context: {}, complete: async () => ({ choices: [{ finish_reason: finishReason, message: { tool_calls: [call(choose)] } }] }),
      read: async () => assert.fail('a standalone choice needs no additional read') });
    assert.deepEqual(result, choose);
  }
});

test('strict routing shape refuses forged replay fields and invalid paging, preserving valid cursors', () => {
  for (const input of [{ kind: 'list_sessions', offset: -1 }, { kind: 'list_sessions', limit: 201 }, { ...choose, observationToken: 'old' }, { ...choose, kindOfSession: 'codex' }, { kind: 'choose', decision: 'clarify', reason: 'Scope missing', text: 'Which project?', workItemId: 'old' }, { kind: 'read_conversation', reference: 'x', cursor: 1 }]) assert.throws(() => validateRouteCall(input));
  assert.deepEqual(validateRouteCall({ kind: 'read_conversation', reference: 'opaque-ref', cursor: 'opaque-page' }), { kind: 'read_conversation', reference: 'opaque-ref', cursor: 'opaque-page' });
});

test('bound new chooses only its configured exact launcher without discovery', () => {
  const launchers = [{ kind: 'codex', available: true, configured: true }, { kind: 'claude', available: true, configured: true }];
  assert.equal(deterministicNewTaskRoute({ scope: { assignmentMode: 'auto' }, launchers }), null);
  assert.equal(deterministicNewTaskRoute({ scope: { assignmentMode: 'new', kindOfSession: 'codex' }, launchers }).kindOfSession, 'codex');
  assert.equal(deterministicNewTaskRoute({ scope: { assignmentMode: 'new' }, launchers }).decision, 'clarify');
  assert.equal(deterministicNewTaskRoute({ scope: { assignmentMode: 'new' }, launchers: launchers.slice(0, 1) }).kindOfSession, 'codex');
  const unavailable = deterministicNewTaskRoute({ scope: { assignmentMode: 'new', kindOfSession: 'codex' }, launchers: [launchers[1]] });
  assert.equal(unavailable.decision, 'clarify'); assert.match(unavailable.text, /codex/);
});

test('timestamp-only repeated reads trigger correction and final call cannot read', async () => {
  let rounds = 0, reads = 0; const events = [];
  await assert.rejects(planTaskRoute({ context: {}, grantId: 'grant-only', onEvent: event => events.push(event),
    complete: async (messages, tools) => {
      rounds++;
      if (rounds === 4) assert.match(messages.at(-1).content, /no new usable evidence/);
      if (rounds === 8) assert.deepEqual(tools, [ROUTING_CHOOSE_TOOL]);
      return response(call({ kind: 'read_session', targetId: 'same' }));
    }, read: async () => ({ ok: true, text: 'same output', timestamp: ++reads, observation: { sequence: reads, revision: reads } })
  }), error => error instanceof RoutingError && error.code === 'ROUTING_EXHAUSTED' && error.grantId === 'grant-only' && error.delivery === 'not-dispatched');
  assert.equal(rounds, 8); assert.equal(reads, 7);
  assert.equal(events.find(event => event.stage === 'routing_round' && event.round === 3).stagnantRounds, 2);
  assert.equal(events.at(-1).stage, 'routing_exhausted');
});

test('changed output restores progress and final standalone choice remains valid', async () => {
  let round = 0; const events = [];
  const result = await planTaskRoute({ context: {}, maxRounds: 5, onEvent: event => events.push(event),
    complete: async () => ++round === 5 ? response(call(choose)) : response(call({ kind: 'read_session', targetId: 'same' })),
    read: async () => ({ ok: true, text: round === 4 ? 'changed output' : 'same output' }) });
  assert.equal(result.targetId, choose.targetId);
  assert.equal(events.find(event => event.stage === 'routing_round' && event.round === 4).stagnantRounds, 0);
});

test('repeated invalid calls count as stagnation and telemetry failures cannot alter routing', async () => {
  let round = 0;
  const result = await planTaskRoute({ context: {}, maxRounds: 3, onEvent: () => { throw Error('logging failed'); },
    complete: async messages => {
      if (++round === 3) { assert.ok(messages.some(message => /no new usable evidence/.test(message.content))); return response(call(choose)); }
      return response(call('{bad'));
    }, read: async () => assert.fail('invalid calls cannot read') });
  assert.equal(result.targetId, choose.targetId);
});
