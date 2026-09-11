'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { captureProjectRemoval, validateProjectRemoval, prepareProjectPrerequisites } = require('../../backend/orchestratorProjects.cjs');
const { normalizeIntent, authorizeIntentAction, claimGrant } = require('../../backend/orchestratorIntent.cjs');
const projects = [{ id: 'project', path: 'C:/Projects/Example', name: 'Example' }];
const sessions = [{ id: 'pane', projectId: 'project', visiblePane: true, generation: 'g1', launchToken: 1 }];
test('project removal captures only its original panes and rejects additions, restarts and replacement projects', () => {
  const selection = captureProjectRemoval(projects[0].path, projects, [...sessions, { ...sessions[0], id: 'other', projectId: 'other' }]);
  assert.equal(selection.targets.length, 1);
  assert.equal(validateProjectRemoval(selection, projects, sessions).id, 'project');
  for (const panes of [[...sessions, { ...sessions[0], id: 'new' }], [{ ...sessions[0], generation: 'g2' }], [{ ...sessions[0], launchToken: 2 }]]) assert.throws(() => validateProjectRemoval(selection, projects, panes), /gained or restarted/);
  assert.throws(() => validateProjectRemoval(selection, [{ ...projects[0], path: 'C:/Other' }], sessions), /changed/);
});
test('folder opening and project removal retain exact bound paths and private identity evidence', () => {
  const context = { requestId: 'r', instruction: `Open ${projects[0].path} and remove it from Lina only.`, projects, sessions };
  const plan = normalizeIntent({ goal: 'Manage the workspace only.', actions: [{ kind: 'open_folder', path: projects[0].path }, { kind: 'remove_project', path: projects[0].path }] }, context);
  const opened = authorizeIntentAction({ kind: 'open_folder', grantId: plan.grants[0].id }, plan, sessions);
  assert.equal(opened.folderAccess.explicit, true);
  const removed = authorizeIntentAction({ kind: 'remove_project', grantId: plan.grants[1].id }, plan, sessions);
  assert.equal(removed.projectSelection.id, 'project');
  assert.throws(() => authorizeIntentAction({ kind: 'remove_project', grantId: plan.grants[1].id, path: 'C:/Other' }, plan, sessions), /cannot change/);
  assert.throws(() => normalizeIntent({ goal: 'Delete', actions: [{ kind: 'delete_folder', path: projects[0].path }] }, context), /Unsupported/);
});
test('adding an existing folder is a verified prerequisite to work in its new project', async () => {
  const folder = 'C:/New Project', text = 'Review the source without editing files.';
  const plan = normalizeIntent({ goal: 'Add and review.', actions: [{ kind: 'add_project', path: folder }, { kind: 'delegate_task', cwd: folder, text }] },
    { requestId: 'r', instruction: `Add ${folder} and review it.`, projects: [], sessions: [] });
  const effects = [], outcomes = [];
  await prepareProjectPrerequisites({ plan, execute: async action => {
    effects.push(action); claimGrant(authorizeIntentAction(action, plan, []), plan);
    return { ok: true, status: 'added', path: folder };
  }, onOutcome: result => outcomes.push(result) });
  assert.equal(effects.length, 1); assert.equal(outcomes[0].status, 'added');
  assert.equal(plan.grants[1].text, text);
  await prepareProjectPrerequisites({ plan, execute: async () => assert.fail('Cannot add twice'), onOutcome: () => {} });
});
test('a failed project prerequisite stops before assignment and remains visible in outcomes', async () => {
  const folder = 'C:/Missing', plan = normalizeIntent({ goal: 'Add and review.', actions: [{ kind: 'add_project', path: folder }, { kind: 'delegate_task', cwd: folder, text: 'Review only.' }] },
    { requestId: 'r', instruction: `Add ${folder} and review.`, projects: [], sessions: [] });
  const outcomes = [];
  await assert.rejects(() => prepareProjectPrerequisites({ plan, execute: async () => ({ ok: false, error: 'Folder unavailable.' }), onOutcome: result => outcomes.push(result) }), /unavailable/);
  assert.equal(outcomes.length, 1); assert.equal(outcomes[0].ok, false);
});
test('a continuation inherits the folder prerequisite before validating its dependent worker', () => {
  const folder='C:/New Project', previousCommand={requestId:'original',instruction:`Add ${folder} and review it without editing.`,access:'read-only',grants:[
    {kind:'add_project',args:{path:folder},targets:[]},
    {kind:'delegate_task',args:{cwd:folder},text:'Review without editing.',targets:[]},
  ]};
  const plan=normalizeIntent({goal:'Continue the original workflow.',continuationOf:'original',actions:[
    {kind:'add_project',sourceUserId:'original'}, {kind:'delegate_task',sourceUserId:'original'},
  ]},{requestId:'retry',instruction:'Continue.',projects:[],sessions:[],previousCommand});
  assert.equal(plan.grants[0].args.path,folder);assert.equal(plan.grants[1].args.cwd,folder);
  assert.equal(plan.grants[1].text,'Review without editing.');assert.equal(plan.access,'read-only');
});
