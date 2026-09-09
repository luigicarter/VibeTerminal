'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildWorkspaceParameters, scopedWorkspaceTool } = require('../../backend/orchestratorToolSchema.cjs');
const { workspaceToolGuide } = require('../../backend/orchestratorToolGuide.cjs');

// Exercise the full schema catalog, including grants unavailable in read-only requests.
const kinds = 'watch_terminal navigate list_roots list_sessions read_session list_conversations read_conversation search_conversation resume_conversation search_files create_project focus_session stage_draft send_prompt interrupt restart close create_session add_project list_setups read_setup launch_setup save_setup list_preferences remember_preference forget_preference ask_user respond list_work answer_question permission terminal_interact finish_terminal'.split(' ');
const names = 'grantId targetId watchUntil view cwd query provider offset limit beforeSequence maxChars reference cursor root parent name stepId observationToken text observationSequence inputRevision editInput keys mouse inputPurpose submit requestId revision answerText answerTexts decision outcome kindOfSession path preferenceId speechText responseTurn'.split(' ');
const flat = { properties: { kind: { type: 'string', enum: kinds }, ...Object.fromEntries(names.map(name => [name, { type: 'string' }])) } };
const tool = { type: 'function', function: { name: 'workspace', description: 'Workspace.', parameters: buildWorkspaceParameters(flat) } };

test('guide covers exactly exposed operations and rejects unclassified future tools', () => {
  for (const grants of [[], [{ kind: 'operate_terminal' }], [{ kind: 'operate_terminal', inspection: true }], kinds.map(kind => ({ kind }))]) {
    const scoped = scopedWorkspaceTool(tool, grants);
    const guide = workspaceToolGuide(scoped);
    const documented = guide.split('\n').slice(2).map(line => line.split(':')[0]);
    assert.deepEqual(documented, scoped.function.parameters.properties.kind.enum);
    assert.ok(Buffer.byteLength(guide) < 4800, 'Keep full tool guidance bounded.');
  }
  assert.throws(() => workspaceToolGuide({ function: { parameters: { properties: { kind: { enum: ['new_tool'] } } } } }), /Missing workspace tool guidance/);
});

test('guide explains existing batching without authorizing guessed evidence or polling', () => {
  const guide = workspaceToolGuide(scopedWorkspaceTool(tool, [{ kind: 'operate_terminal' }]));
  for (const instruction of [/at most 6 workspace calls/i, /executed in order/, /unseen token\/revision\/cursor\/answer dependencies wait/i, /ask_user\/respond alone or last/, /Do not focus merely to read or send/, /do not poll or replay/, /Continue remaining authorized grants/, /delegated judgment within scope/]) assert.match(guide, instruction);
  for (const semantics of [/search_files:.*not file contents/, /list_work:.*limit<=10/, /search_conversation:.*limit<=8/, /read_session:.*maxChars<=4000/, /read_conversation:.*nextCursor/, /retrySamePage\/retrySmallerPage/]) assert.match(guide, semantics);
});

test('read-only guidance reserves space for source excerpts in constrained contexts', () => {
  const guide = workspaceToolGuide(scopedWorkspaceTool(tool));
  assert.ok(Buffer.byteLength(guide) < 1600);
  assert.doesNotMatch(guide, /Batch authorized actions/);
  assert.match(guide, /fresh action evidence/);
  assert.match(guide, /provider navigation guide/);
});
