'use strict';
const { workspaceMap } = require('./orchestratorWorkspace.cjs');
const { randomUUID, createHash } = require('node:crypto');
const { sessionIdentity } = require('./orchestratorRouting.cjs');
const { routingBindingMatches } = require('./orchestratorLaunchers.cjs');
const { createOperatorObservations } = require('./orchestratorOperator.cjs');
const { normalizeTerminalKeys } = require('../shared/terminalControls.cjs');
const { formatTaskWait } = require('./orchestratorTaskStatus.cjs');
const { normalizeSpeech } = require('./orchestratorSpeech.cjs');
const { projectIntent, authorizeIntentAction, claimGrant, assertIntentTargetAvailability } = require('./orchestratorIntent.cjs');
const { ACTIONS, authorizeConversationResume, captureConversationResumeCandidate, identifyReadTarget } = require('./orchestratorPolicy.cjs');
const { listSessionSummaries } = require('./orchestratorContext.cjs');
const { terminalNavigationGuide } = require('./orchestratorTerminalGuide.cjs');
const { createInspectionEvidence } = require('./orchestratorInspectionEvidence.cjs');
const { fileReadSource } = require('./orchestratorReadRecovery.cjs');
const { assertCloseEligibility } = require('./orchestratorCloseSafety.cjs');

// Executes a scoped plan through workspace capabilities. It has no model API,
// credential storage, conversation ownership or ambient request context. The
// caller passes the active request explicitly; live identity getters are reread
// after awaits. Only this executor owns its cross-request effect deduplication.
function createWorkspaceExecutor({ getSessions, getRequests, getEpoch, isDisposed, active,
  getCurrentSession = id => getSessions().find(session => session.id === id), getConfiguration = () => undefined,
  getRoots, getWorkspaceState, readSession, dispatchAction, requireFreshSessions, refresh,
  files, preferences: preferenceStore, tasks, activity, historyCandidates, deliveryDiagnostics,
  workHistory, workItems, operationState, userAnswer, trackManagedTaskOwnership,
  bindCreatedTarget, bindTarget, commitContext, receipt, recordDiagnostic, emit, redact, cleanError, now, reviewInspection }) {
  const executed = new Map();
  async function doAction(raw, { intent, scope, diagnosticContext = {}, requestContext, token = getEpoch(), signal = requestContext?.controller?.signal } = {}) {
    if (!raw || typeof raw !== 'object' || typeof raw.kind !== 'string') throw new Error('Invalid action.');
    let action = structuredClone(raw);
    if (action.keys !== undefined) action.keys = normalizeTerminalKeys(action.keys);
    let effectReceiptKey;
    if (intent && Object.keys(action).some(k => !['kind', 'view', 'targetId', 'text', 'path', 'cwd', 'root', 'query', 'parent', 'name', 'kindOfSession', 'preferenceId', 'provider', 'reference', 'limit', 'offset', 'cursor', 'beforeSequence', 'maxChars', 'grantId', 'requestId', 'revision', 'observationSequence', 'keys', 'mouse', 'inputPurpose', 'submit', 'stepId', 'observationToken', 'inputRevision', 'editInput', 'answerText', 'answerTexts', 'decision', 'outcome', 'responseTurn', 'speechText', 'watchUntil'].includes(k))) throw new Error('Unexpected tool argument.');
    let observationToken = action.observationToken;
    delete action.observationToken;
    let operatorGrant, operatorObservation, operatorState;
    action.kind = ({ send: 'send_prompt', kill: 'close', respond_permission: 'permission' })[action.kind] || action.kind;
    if (intent && action.kind === 'open_file') throw new Error('Use Workspace tools to open files or folders in an external application. Voice controls stay inside Lina Terminal.');
    const check = () => { if (intent) active(token); else if (isDisposed() || token !== getEpoch() || signal?.aborted) throw new Error('Cancelled.'); };
    check();
    if (intent && action.kind === 'respond') {
      if (Object.keys(raw).some(key => !['kind', 'text', 'speechText', 'responseTurn'].includes(key)) || typeof action.text !== 'string' || !action.text.trim() || action.text.length > 16000 || (action.speechText !== undefined && !normalizeSpeech(action.speechText)) || !['listen', 'complete', 'dismiss'].includes(action.responseTurn)) throw new Error('Respond requires text and responseTurn: listen, complete, or dismiss.');
      intent.response = { text: action.text, ...(action.speechText !== undefined && { speechText: action.speechText }), responseTurn: action.responseTurn };
      if (action.responseTurn === 'listen') {
        intent.question = { id: randomUUID(), requestId: requestContext.job.task.requestId, text: action.text };
        intent.responseQuestionId = intent.question.id;
      }
      return { ok: true, status: action.responseTurn === 'listen' ? 'needs-answer' : 'response-ready' };
    }
    if (intent && action.kind === 'ask_user') {
      if (typeof action.text !== 'string' || !action.text.trim()) throw new Error('A clarification question is required.');
      const question = { id: randomUUID(), requestId: requestContext.job.task.requestId, text: action.text.slice(0, 2000) };
      if (action.reference !== undefined) {
        const progress = projectIntent(intent.commandPlan);
        const grants = intent.commandPlan.grants.filter(grant => grant.kind === 'resume_conversation' && (!action.grantId || grant.id === action.grantId) && !progress.grants.find(item => item.id === grant.id)?.dispatched);
        if (grants.length !== 1) throw new Error('Identify one unfinished saved conversation request before asking which chat to resume.');
        const candidate = captureConversationResumeCandidate(action.reference, grants[0], [...historyCandidates.values()]);
        const project = intent.projects?.find(item => item.path === candidate.identity.cwd)?.name || candidate.identity.cwd;
        question.text = `Do you mean “${candidate.identity.title}” in ${project} (${candidate.identity.provider}${candidate.identity.claudeHome ? `, ${candidate.identity.claudeHome} home` : ''})?`;
        requestContext.job.resumeConfirmation = { questionId: question.id, candidate, sourceUserId: grants[0].sourceUserId, args: grants[0].args };
      }
      intent.question = question;
      return { ok: true, status: 'needs-answer', question };
    }
    if (action.kind === 'read_workspace') {
      await requireFreshSessions(); check();
      const ui = await getWorkspaceState(signal); check();
      const roots = await getRoots(); check();
      return redact(workspaceMap({ ui, roots, sessions: getSessions(), tasks: tasks.snapshot(), interactions: getRequests(), configuration: getConfiguration() }));
    }
    if (action.kind === 'list_work') { await requireFreshSessions(); check(); return redact(workHistory.list({ ...action, limit: Math.min(Number(action.limit) || 10, 10) })); }
    if (action.kind === 'list_sessions') { await requireFreshSessions(); check(); return redact(listSessionSummaries(getSessions(), { ...action, includeNavigationGuide: !intent })); }
    if (action.kind === 'read_session') {
      const id = action.targetId || action.target?.id;
      if (intent) {
        intent.operatorObservations ||= createOperatorObservations({ now });
        intent.operatorObservations.invalidate(id);
        const previousTarget = getSessions().find(session => session.id === id);
        if (previousTarget) intent.operatorObservations.beginRead(previousTarget, diagnosticContext.modelRound);
      }
      await requireFreshSessions(); check();
      const target = getSessions().find(s => s.id === id);
      if (!target) throw new Error('Unknown target session.');
      const binding = { target: { id, generation: target.generation, launchToken: target.launchToken }, nativeIdentity: sessionIdentity(target) };
      const readId = intent?.operatorObservations.beginRead(target, diagnosticContext.modelRound);
      const requestedGeneration = action.target?.generation ?? action.generation;
      if (requestedGeneration != null && requestedGeneration !== target.generation) throw new Error('This source session changed. Select it again.');
      if (intent && intent.readBudget.remainingBytes < 512) return { ok: true, status: 'read-step-limit', contextNote: 'Process the excerpts already read, then fetch more in the next tool step.' };
      check(); if (activity.touch(scope, target, action.kind)) emit();
      const readSource = require('./orchestratorReadRecovery.cjs').readSource(target, true);
      let data;
      try { data = await readSession({ id, generation: target.generation, maxChars: intent ? Math.min(Number(action.maxChars) || 4000, 4000) : Number(action.maxChars) || 16000, beforeSequence: action.beforeSequence }); }
      catch (error) { check(); return { ok: false, status: 'unavailable', error: cleanError(error), readSource }; }
      check();
      if (data?.ok === false) return { ok: false, status: data.status || 'unavailable', error: data.error || 'The terminal observation is unavailable.', readSource };
      const current = await getCurrentSession(id); check();
      if (!current || current.generation !== binding.target.generation || current.launchToken !== binding.target.launchToken ||
          data?.id !== undefined && data.id !== id || data?.generation !== undefined && data.generation !== binding.target.generation) {
        return { ok: false, status: 'stale-generation', error: 'The terminal changed during this read. Read its current generation again.', readSource };
      }
      if (!routingBindingMatches(binding, current)) return { ok: false, status: 'conversation-changed',
        error: 'The native conversation changed during this read. Read the current conversation again.', readSource };
      if (action.beforeSequence === undefined && intent?.commandPlan.grants.some(grant => grant.inspection && grant.targets.some(item => item.id === target.id && item.generation === target.generation))) {
        intent.inspectionEvidence ||= createInspectionEvidence();
        intent.inspectionEvidence.observe(target, redact(data));
      }
      if (data?.completedResult && workHistory.enrich(target, data.completedResult)) emit();
      if (intent && identifyReadTarget(intent, getSessions())?.id === id) bindTarget(target, intent);
      const result = { ok: true, readSource, terminalNavigationGuide: terminalNavigationGuide(target), observation: redact(data), pendingInteractions: redact(getRequests().filter(r => r.sessionId === id && r.state === 'pending' && (r.generation === undefined || r.generation === target.generation))) };
      if (intent && action.beforeSequence === undefined) {
        intent.operatorObservations ||= createOperatorObservations({ now });
        result.observationToken = intent.operatorObservations.observe(target, data, result.pendingInteractions, { readId, modelRound: diagnosticContext.modelRound });
        intent.observedInteractions = [...(intent.observedInteractions || []).filter(request => request.sessionId !== id),
          ...result.pendingInteractions.map(request => ({ ...structuredClone(request), requestId: request.id }))];
      }
      return intent ? intent.readBudget.projectRead(result) : result;
    }
    if (['list_conversations', 'read_conversation', 'search_conversation'].includes(action.kind)) {
      if (intent && action.kind !== 'list_conversations' && intent.readBudget.remainingBytes < 512) return { ok: true, status: 'read-step-limit', reference: action.reference, contextNote: 'Process these excerpts first, then continue the same source cursor in the next tool step.' };
      const requestedIdentity = historyCandidates.get(action.reference);
      let result;
      try { result = await dispatchAction({ kind: action.kind, provider: action.provider, cwd: action.cwd, query: action.query, reference: action.reference, cursor: action.cursor, maxChars: intent ? Math.min(Number(action.maxChars) || 4000, 4000) : action.maxChars,
        maxBytes: intent && action.kind !== 'list_conversations' ? Math.max(1, Math.min(3500, intent.readBudget.remainingBytes) - 256) : undefined,
        limit: intent ? Math.min(Number(action.limit) || (action.kind === 'search_conversation' ? 5 : action.kind === 'read_conversation' ? 30 : 50), action.kind === 'search_conversation' ? 8 : 200) : action.limit,
        offset: action.offset, signal, epoch: token }); }
      catch (error) { check(); result = { ok: false, status: 'failed', error: cleanError(error) }; }
      check();
      for (const item of result?.conversations || []) if (item.reference) {
        for (const [key, old] of historyCandidates) if (old.provider === item.provider && old.cwd === item.cwd && old.id === item.id && old.claudeHome === item.claudeHome && old.openFusion === item.openFusion && old.plannerProvider === item.plannerProvider) historyCandidates.delete(key);
        historyCandidates.set(item.reference, item);
      }
      while (historyCandidates.size > 500) historyCandidates.delete(historyCandidates.keys().next().value);
      const projected = intent && action.kind !== 'list_conversations' ? intent.readBudget.projectRead({ ...result,
        readSource: require('./orchestratorReadRecovery.cjs').readSource(result?.identity || requestedIdentity),
        reference: action.reference, cursor: JSON.stringify([action.kind, action.query || '', action.cursor || 'start']) }, { tail: false }) : result;
      if (intent && result?.ok && action.reference && !projected.retrySamePage && action.kind !== 'list_conversations') {
        intent.pendingReadBookmarks ||= new Map();
        intent.pendingReadBookmarks.set(action.reference, { requestId: requestContext.job?.task.requestId, reference: action.reference, title: result.identity?.title, kind: action.kind, query: action.query, cursor: result.nextCursor, range: result.range, hasMore: result.hasMore, coverage: result.coverage });
      }
      return redact(projected);
    }
    if (action.kind === 'read_file') {
      if (intent?.readBudget.remainingBytes < 256) return { ok: false, status: 'read-step-limit', error: 'Continue file reads in the next model round.' };
      if (action.cursor !== undefined && (typeof action.cursor !== 'string' || !/^\d+$/.test(action.cursor))) throw new Error('Use the file page cursor returned by the previous read.');
      let result;
      try { result = await files.read({ ...action, offset: action.cursor === undefined ? action.offset : Number(action.cursor), limit: Math.min(Number(action.maxChars) || 4000, intent?.readBudget.remainingBytes ?? 4000, 4000) }, signal); }
      catch (error) { check(); return { ok: false, status: 'unavailable', error: cleanError(error), readSource: fileReadSource(action.path) }; }
      result.readSource = fileReadSource(action.path, result.path);
      result.nextCursor = result.nextOffset === null ? null : String(result.nextOffset);
      if (!intent) return result;
      const projected = intent.readBudget.projectRead({ ...result, sourceVersion: result.reference, range: { start: result.offset, end: result.nextOffset } }, { tail: false });
      if (projected.retrySamePage) { delete projected.nextOffset; delete projected.nextCursor; projected.contextWarning = 'This file page was clipped for model context. Re-read the same cursor and reference with smaller maxChars before advancing.'; }
      else {
        intent.pendingReadBookmarks ||= new Map();
        intent.pendingReadBookmarks.set(result.reference, { requestId: requestContext.job?.task.requestId, kind: 'read_file', path: result.path,
          reference: result.reference, cursor: result.nextCursor, complete: result.nextCursor === null });
      }
      return redact(projected);
    }
    if (action.kind === 'search_files') return files.search(action, signal);
    if (action.kind === 'list_roots') return { ok: true, roots: await files.roots() };
    if (action.kind === 'list_preferences') return redact({ ok: true, preferences: preferenceStore.get() });
    if (['list_setups', 'read_setup'].includes(action.kind)) { check(); return redact(await dispatchAction({ kind: action.kind, name: action.name, signal, epoch: token })); }
    if (intent) {
      const roots = await getRoots();
      active(token);
      if (intent.commandPlan.grants.some(grant => ['operate_terminal', 'watch_terminal', 'close'].includes(grant.kind))) { await requireFreshSessions(); check(); }
      const taskSubmission = require('./orchestratorSubmission.cjs').isTaskSubmission(action, { operator: true });
      if (taskSubmission) {
        const grant = intent.commandPlan.grants.find(grant => grant.kind === 'operate_terminal' && (!action.grantId || action.grantId === grant.id)
          && grant.targets.some(target => target.id === action.targetId));
        const route = requestContext.job.routeItems?.find(item => item.grantId === grant?.id && item.binding?.target.id === action.targetId);
        const target = grant && getSessions().find(session => session.id === action.targetId);
        const managed = target && !['terminal', 'shell'].includes(target.kind || target.provider);
        const existing = managed && workItems.list({ cwd: target.cwd, limit: 100 }).find(item => item.binding && routingBindingMatches(item.binding, target));
        const workItemId = grant?.routing?.workItemId || route?.workItemId || existing?.id;
        const identity = managed && requestContext.job.workspaceIdentities?.get(action.targetId);
        if (managed && await tasks.waitForAssignmentSubmission(requestContext.job, { targetId: action.targetId, workItemId,
          ...(identity && { workspaceKey: `workspace:${identity}` }), readOnly: intent.commandPlan.access === 'read-only' })) {
          await requireFreshSessions(); check();
          // Keep the original token. Existing authority checks below require a
          // fresh read if another operator or the user changed the input state.
        }
      }
      const fallbackStepId = typeof diagnosticContext.toolCallId === 'string' && diagnosticContext.toolCallId.length
        ? `call-${createHash('sha256').update(diagnosticContext.toolCallId).digest('hex')}` : undefined;
      action = authorizeIntentAction(action, intent.commandPlan, getSessions(), { allowConsumed: true, fallbackStepId, requests: getRequests(), observedInteractions: intent.observedInteractions || [] });
      diagnosticContext.grantId = action.grantId;
      operatorGrant = intent.commandPlan.grants.find(grant => grant.id === action.grantId && grant.kind === 'operate_terminal');
      if (operatorGrant?.routing || requestContext.job.input.internalBindings) {
        const route = requestContext.job.routeItems?.find(item => item.grantId === operatorGrant?.id && item.binding?.target.id === action.targetId);
        const historical = workItems.get(route?.workItemId || operatorGrant?.routing?.workItemId)?.binding;
        const binding = historical?.nativeIdentity?.id ? historical : route?.binding || historical || requestContext.job.input.internalBindings?.find(item => item.binding.target.id === action.targetId)?.binding;
        const live = getSessions().find(session => session.id === action.targetId && session.generation === action.generation);
        if (!binding || !routingBindingMatches(binding, live)) throw new Error('The assigned conversation changed. Read and identify it again before acting.');
        action.routingBinding = structuredClone(binding);
      }
      effectReceiptKey = JSON.stringify(action);
      if (intent.effectReceipts.has(effectReceiptKey)) return intent.effectReceipts.get(effectReceiptKey);
      if (operatorGrant) {
        operatorState = operationState(operatorGrant, action.targetId);
        if (action.kind !== 'finish_terminal' && operatorState.steps >= 128) throw new Error('The terminal operation reached its step limit, including earlier clarification steps.');
        const target = getSessions().find(session => session.id === action.targetId && session.generation === action.generation);
        if (!target || !intent.operatorObservations) throw new Error('Read this terminal before operating it.');
        if (action.kind !== 'finish_terminal' && operatorState.uncertain) throw new Error('An earlier write in this operation is unconfirmed. Inspect its outcome; do not send more input.');
        if (action.kind === 'finish_terminal' && action.outcome === 'completed' && operatorState.uncertain) throw new Error('The earlier write remains unconfirmed. Report this operation as blocked, not completed.');
        const nativeAgent = !['terminal', 'shell', 'fusion', 'openfusion'].includes(target.kind || target.provider);
        const lifecycleMode = operatorGrant.lifecycleMode || 'preserve';
        if (nativeAgent && lifecycleMode !== 'exit' && action.kind === 'finish_terminal' && action.outcome === 'completed') {
          if (target.started === false || ['exited', 'failed'].includes(target.processState) || ['exited', 'failed'].includes(target.agentProcessState)
            || ['closed', 'exited', 'paused'].includes(target.status)) throw new Error('The coding agent exited before this operation could be verified. Report the operation as blocked; a shell prompt does not prove its input was cleared.');
          if (operatorState.nativeRecipient && (target.agentProcessState !== 'running' || target.agentPid !== operatorState.nativeRecipient.pid)) throw new Error('The coding agent changed or its liveness is unverified after the input operation. Report this operation as blocked.');
        }
        const interrupting = action.kind === 'interrupt' || action.kind === 'terminal_interact' && action.keys?.includes('ctrl-c');
        if (nativeAgent && lifecycleMode === 'interrupt' && interrupting) {
          if (!['running', 'busy', 'waiting', 'starting'].includes(target.turnState)) throw new Error('No active agent turn is observed to interrupt. Do not send Ctrl-C to an idle composer; it can quit the agent.');
          if (operatorState.interruptedTurn && operatorState.interruptedTurn.id === target.turnId && operatorState.interruptedTurn.startedAt === target.turnStartedAt) throw new Error('An interrupt was already sent for this turn. Observe its outcome; repeated Ctrl-C can quit the agent.');
        }
        if (action.kind === 'send_prompt' && operatorState.sentTasks.has(action.text)) throw new Error('This task was already submitted by this operation. Inspect its result instead of repeating it.');
        if (action.kind === 'terminal_interact' && operatorGrant.permissionMode === 'none' && getRequests().some(request => request.sessionId === action.targetId && request.generation === action.generation && request.state === 'pending' && request.kind === 'permission') &&
            (action.text || action.submit || action.mouse || action.keys?.some(key => !['up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown', 'tab', 'shift-tab', 'escape'].includes(key)))) throw new Error('The terminal is asking for permission. This request does not delegate that decision.');
        if (!Object.hasOwn(raw, 'observationToken')) observationToken = intent.operatorObservations.latest(target, diagnosticContext.modelRound);
        operatorObservation = intent.operatorObservations.authorize(observationToken, target, action,
          getRequests().filter(request => request.sessionId === target.id && (request.generation === undefined || request.generation === target.generation) && request.state === 'pending'));
      }
      if (action.kind === 'resume_conversation') {
        const authorized = authorizeConversationResume(action, intent, [...historyCandidates.values()]);
        action = { ...action, ...authorized };
      }
      if (['answer_question', 'permission'].includes(action.kind)) action = userAnswer(action, intent);
      if (action.kind === 'create_project' && action.parent !== roots?.documents) throw new Error('Relay project creation is restricted to your Documents folder.');
      if (action.kind === 'launch_setup') { const list = await dispatchAction({ kind: 'list_setups', signal, epoch: token }); check(); if (!list?.ok || list.setups?.filter(s => s.name === action.name).length !== 1) throw new Error('Specify one existing setup by its exact unique name.'); }
    }
    if (action.kind === 'finish_terminal') {
      if (!operatorGrant || !operatorObservation) throw new Error('Only an observed terminal operation can be finished.');
      const inspectedSession = getSessions().find(item => item.id === action.targetId && item.generation === action.generation);
      let inspectionText;
      if (operatorGrant.inspection && action.outcome === 'completed') {
        const reviewed = await reviewInspection({ owner: intent, goal: operatorGrant.text,
          evidence: intent.inspectionEvidence?.pages(inspectedSession) || [], model: intent.model, target: inspectedSession, signal, diagnosticContext });
        check();
        const current = getSessions().find(item => item.id === action.targetId && item.generation === action.generation);
        if (!current || !routingBindingMatches({ target: { id: inspectedSession.id, generation: inspectedSession.generation }, nativeIdentity: sessionIdentity(inspectedSession) }, current)) throw new Error('The inspected conversation changed during result verification. Read its current state again.');
        intent.operatorObservations.authorize(observationToken, current, action, getRequests().filter(request => request.sessionId === current.id && request.state === 'pending'));
        if (reviewed.decision !== 'complete') throw new Error(reviewed.decision === 'continue'
          ? 'The observed evidence does not yet answer this inspection objective. Continue the relevant read-only navigation; do not replace it with a promise or unrelated information.'
          : 'The inspection result could not be verified. Inspect the missing evidence or finish blocked with the concrete limitation.');
        inspectionText = intent.inspectionEvidence.report(current, action.text, reviewed.evidenceIds);
      }
      if (operatorGrant.inspection && action.outcome === 'completed' && !inspectionText) throw new Error('Read current terminal output before completing its inspection.');
      check(); claimGrant(action, intent.commandPlan);
      intent.operatorObservations.consume(operatorObservation, action.target, action);
      const blocked = action.outcome === 'blocked';
      if (blocked) requestContext.job.operatorBlocked = action.text;
      intent.operatorResults ||= new Map();
      intent.operatorResults.set(JSON.stringify([action.grantId, action.targetId]), action.outcome);
      const submitted = requestContext.job.waits.filter(wait => wait.targetId === action.targetId && wait.generation === action.generation);
      const session = getSessions().find(item => item.id === action.targetId && item.generation === action.generation);
      const finishText = inspectionText || (!blocked && submitted.length ? [...new Set(submitted.map(wait => formatTaskWait(wait, session)))].join(' ') : action.text);
      const result = { ok: !blocked, status: blocked ? 'blocked' : 'interaction-complete', text: finishText, targetId: action.targetId, generation: action.generation };
      intent.effectReceipts.set(effectReceiptKey, result); receipt(action, result, diagnosticContext);
      return result;
    }
    if (['remember_preference', 'forget_preference'].includes(action.kind)) {
      const dedupKey = action.actionId || `${requestContext.job?.task.requestId || token}:${JSON.stringify(action)}`;
      if (executed.has(dedupKey)) return executed.get(dedupKey);
      check(); if (intent) { claimGrant(action, intent.commandPlan); intent.commandDispatched = true; requestContext.pendingCommand = null; } const preferences = preferenceStore.update(action.kind === 'remember_preference' ? { operation: 'remember', text: action.text } : { operation: 'forget', id: action.preferenceId });
      const result = redact({ ok: true, status: action.kind === 'remember_preference' ? 'remembered' : 'forgotten', preferences }); executed.set(dedupKey, result); if (intent) intent.effectReceipts.set(effectReceiptKey, result); if (executed.size > 300) executed.delete(executed.keys().next().value); receipt(action, result); return result;
    }
    if (action.kind === 'create_project') {
      if (!action.parent) { const roots = await getRoots(); action.parent = Array.isArray(roots) ? roots[0] : roots.documents; }
      const dedupKey = action.actionId || `${requestContext.job?.task.requestId || token}:${JSON.stringify(action)}`;
      if (executed.has(dedupKey)) return executed.get(dedupKey);
      const work = (async () => {
        check(); if (intent) { claimGrant(action, intent.commandPlan); intent.commandDispatched = true; requestContext.pendingCommand = null; } const result = await files.createProject(action, signal); receipt(action, { ok: true, status: 'created', text: `Created folder: ${result.path}` });
        let added;
        try { check(); added = await dispatchAction({ kind: 'add_project', path: result.path, signal, epoch: token }); }
        catch (error) { added = { ok: false, error: cleanError(error) }; }
        const outcome = { ...added, ok: added?.ok === true, path: result.path, directoryCreated: true }; if (intent && outcome.ok) { intent.createdProjects ||= []; intent.createdProjects.push({ name: action.name, path: result.path }); } receipt({ kind: 'add_project' }, outcome, diagnosticContext); return outcome;
      })(); executed.set(dedupKey, work); if (intent) intent.effectReceipts.set(effectReceiptKey, work); return work;
    }
    if (action.kind === 'watch_terminal') {
      if (!intent || !requestContext.job) throw new Error('Submit a watch as an Orchestrator request.');
      check(); claimGrant(action, intent.commandPlan);
      intent.commandDispatched = true; requestContext.pendingCommand = null;
      action.actionId ||= randomUUID();
      const result = tasks.watch(requestContext.job, action, getSessions().find(session => session.id === action.targetId));
      intent.effectReceipts.set(effectReceiptKey, result);
      receipt(action, result, diagnosticContext);
      tasks.reconcile(getSessions());
      return result;
    }
    if (!ACTIONS.has(action.kind)) throw new Error('Unsupported workspace action.');
    const targetId = action.target?.id || action.targetId || action.id;
    if (action.kind === 'create_session' && action.text !== undefined) action.prompt = action.text;
    let activityTarget;
    const scopedClose = action.kind === 'close' && intent && action.closeScope;
    if (scopedClose) {
      // The close adapter reconciles the frozen pane, including an absent or
      // restarted target. Never substitute a replacement generation here.
      action.targetId = targetId;
      action.generation = action.target?.generation;
      activityTarget = action.target;
    } else if (['focus_session', 'stage_draft', 'get_draft', 'send_prompt', 'terminal_interact', 'interrupt', 'restart', 'close', 'answer_question', 'permission', 'stage_handoff'].includes(action.kind)) {
      const target = getSessions().find(s => s.id === targetId); if (!target) throw new Error('Unknown target session.');
      const generation = action.target?.generation ?? action.generation;
      if (generation !== undefined && generation !== target.generation) throw new Error('Stale session generation.');
      action.target = { id: targetId, generation: target.generation }; action.targetId = targetId; action.generation = target.generation;
      if (['send_prompt', 'stage_draft'].includes(action.kind) && (typeof action.text !== 'string' || !action.text.trim() || action.text.length > 100000)) throw new Error('A nonempty prompt is required.');
      if (action.kind === 'send_prompt' && getRequests().some(r => r.sessionId === targetId && r.state === 'pending' && (r.generation === undefined || r.generation === target.generation))) throw new Error('Answer the pending interaction before sending a new task.');
      if (['answer_question', 'permission'].includes(action.kind)) { const pending = getRequests().find(r => r.id === action.requestId && r.sessionId === targetId && r.state === 'pending' && (r.generation === undefined || r.generation === target.generation)); if (!pending || (action.revision !== undefined && action.revision !== pending.revision)) throw new Error('This interaction is no longer current.'); action.revision = pending.revision; }
      activityTarget = action.target;
    }
    const dedupKey = action.actionId || (intent ? `${requestContext.job?.task.requestId || token}:${JSON.stringify(action)}` : null);
    if (dedupKey && executed.has(dedupKey)) return executed.get(dedupKey);
    check();
    if (['resume_conversation', 'create_session'].includes(action.kind)) { requestContext.conversationTarget = null; requestContext.pendingConversationTarget = null; commitContext(); }
    const baseline = activityTarget && { ...structuredClone(getSessions().find(session => session.id === targetId)), submittedAt: now() };
    const work = Promise.resolve().then(() => {
      check();
      if (scopedClose) assertCloseEligibility(action.closeScope, getSessions(), getRequests());
      if (intent && action.grantId) assertIntentTargetAvailability(intent.commandPlan, action, getSessions());
      if (intent) { claimGrant(action, intent.commandPlan); intent.commandDispatched = true; requestContext.pendingCommand = null; }
      if (operatorGrant) {
        intent.operatorObservations.consume(operatorObservation, action.target, action);
        operatorState.steps++;
        action.operator = true;
        // Structured requestId identifies a provider question. Native requestId
        // identifies the request that owns input; never accept it from the model.
        if (['terminal_interact', 'send_prompt', 'interrupt'].includes(action.kind)) action.requestId = operatorState.ownerId;
        if (['terminal_interact', 'send_prompt', 'interrupt'].includes(action.kind)) {
          const recipient = getSessions().find(session => session.id === action.targetId && session.generation === action.generation);
          if (recipient && !['terminal', 'shell', 'fusion', 'openfusion'].includes(recipient.kind || recipient.provider) && recipient.agentProcessState === 'running' && Number.isSafeInteger(recipient.agentPid)) operatorState.nativeRecipient ||= { pid: recipient.agentPid };
          if (action.kind === 'interrupt' || action.kind === 'terminal_interact' && action.keys?.includes('ctrl-c')) operatorState.interruptedTurn = { id: recipient?.turnId, startedAt: recipient?.turnStartedAt };
        }
      }
      // Once dispatched, an uncertain acknowledgment must never leave a prompt
      // available for a later clarification to send again.
      if (intent && ['send_prompt', 'stage_draft'].includes(action.kind)) { requestContext.pendingRelay = null; intent.relayDispatched = true; }
      if (activityTarget && activity.touch(scope, activityTarget, action.kind)) emit();
      action.actionId ||= randomUUID();
      Object.assign(diagnosticContext, { actionId: action.actionId, targetId: action.target?.id || action.targetId, generation: action.target?.generation ?? action.generation });
      if (action.kind === 'send_prompt') {
        deliveryDiagnostics.set(action.actionId, diagnosticContext);
        if (deliveryDiagnostics.size > 100) deliveryDiagnostics.delete(deliveryDiagnostics.keys().next().value);
      }
      const activeBaseline = baseline?.turnId && !['terminal', 'shell'].includes(baseline.kind || baseline.provider)
        && (['running', 'busy'].includes(baseline.turnState) || baseline.childActivity || baseline.pendingInput);
      if (requestContext.job) trackManagedTaskOwnership(requestContext.job, action, baseline, operatorGrant);
      if (requestContext.job) tasks.track(requestContext.job, action, { ok: true, status: 'unconfirmed',
        ...(activeBaseline && { inputDisposition: 'submitted-while-running', deliveryBaseline: {
          submittedAt: baseline.submittedAt, kind: baseline.kind || baseline.provider, turnId: baseline.turnId, turnState: baseline.turnState } }) }, baseline);
      // The validated opaque token already binds native counters. Supply omitted
      // transport metadata after claiming the original immutable model action;
      // never alter its fingerprint or replace explicitly supplied values.
      const observedInput = operatorGrant && ['send_prompt', 'terminal_interact', 'interrupt'].includes(action.kind) && !['fusion', 'openfusion'].includes(action.target.kind || action.target.provider)
        ? { observationSequence: action.observationSequence === undefined ? operatorObservation.sequence : action.observationSequence,
          inputRevision: action.inputRevision === undefined ? operatorObservation.inputRevision : action.inputRevision,
          inputAuthority: operatorObservation.authority,
          ...(action.kind === 'send_prompt' && { promptObservation: { agentPid: operatorObservation.runtime.agentPid,
            turnId: operatorObservation.runtime.turnId, turnStartedAt: operatorObservation.runtime.turnStartedAt } }) } : {};
      // Explicit managed sends have the same conversation boundary as routed
      // work. Capture it before a busy prompt enters the asynchronous delivery
      // queue, without changing the model action claimed above.
      const baselineBinding = action.kind === 'send_prompt' && !action.routingBinding && baseline
        && !['terminal', 'shell'].includes(baseline.kind || baseline.provider)
        ? { target: { id: baseline.id, generation: baseline.generation, ...(baseline.launchToken !== undefined && { launchToken: baseline.launchToken }) }, nativeIdentity: sessionIdentity(baseline) } : undefined;
      if (scopedClose && action.closeScope.targetCount === 0) return { ok: true, status: 'closed',
        close: { operationId: action.actionId, scopeEmpty: true, pane: 'already-absent', process: 'already-absent', launchSettled: true,
          verifiedAt: now(), remainingTargetCount: 0, newTargetCount: 0 } };
      return dispatchAction({ ...action, ...observedInput, ...(baselineBinding && { routingBinding: baselineBinding }), signal, epoch: token });
    }).then(async result => {
      const verified = result && typeof result.ok === 'boolean' ? result : { ok: false, status: 'unknown', error: 'Action adapter returned no acknowledgment.' };
      if (action.kind === 'terminal_interact' || action.kind === 'interrupt') {
        const recipient = getSessions().find(session => session.id === action.targetId && session.generation === action.generation);
        recordDiagnostic({ ...diagnosticContext, event: 'terminal_control', stage: 'action', actionKind: action.kind,
          actionId: action.actionId, targetId: action.targetId, generation: action.generation, status: verified.status,
          nativeKeys: action.kind === 'interrupt' ? ['ctrl-c'] : action.keys, editInput: action.editInput,
          lifecycleMode: operatorGrant?.lifecycleMode || (action.kind === 'interrupt' ? 'interrupt' : undefined),
          processState: recipient?.processState, agentProcessState: recipient?.agentProcessState });
      }
      if (operatorState) {
        if (verified.delivery === 'not-dispatched' && (action.kind === 'interrupt' || action.kind === 'terminal_interact' && action.keys?.includes('ctrl-c'))) operatorState.interruptedTurn = null;
        if (['unknown', 'unconfirmed', 'uncertain'].includes(verified.status)) operatorState.uncertain = true;
        if (action.kind === 'send_prompt' && verified.delivery !== 'not-dispatched' && (verified.ok || operatorState.uncertain)) operatorState.sentTasks.add(action.text);
        operatorState.history.push({ kind: action.kind, stepId: action.stepId, status: verified.status, text: (action.text || verified.error || '').slice(0, 500) });
        if (operatorState.history.length > 12) operatorState.history.shift();
      }
      if (verified.ok && token === getEpoch() && !signal?.aborted) {
        if (['resume_conversation', 'create_session'].includes(action.kind)) {
          await refresh();
          if (token === getEpoch() && !signal?.aborted) {
            bindCreatedTarget(verified, intent);
            // Creation receipts must identify the actual live generation. A
            // provisional pane/launch is not evidence of an active target yet.
            const created = getSessions().find(s => s.id === (verified.target?.id || verified.id) && s.generation === verified.target?.generation && s.launchToken === (verified.launchToken ?? verified.target?.launchToken));
            if (created && !String(created.generation).startsWith('paused:') && activity.touch(scope, created, action.kind)) emit();
          }
        }
        if (['focus_session', 'send_prompt'].includes(action.kind)) bindTarget(getSessions().find(s => s.id === action.targetId && s.generation === action.target.generation), intent);
        if (['restart', 'close'].includes(action.kind) && requestContext.conversationTarget?.id === action.targetId) { requestContext.conversationTarget = null; commitContext(); }
      }
      if (requestContext.job) tasks.track(requestContext.job, action, verified, baseline);
      receipt(action, verified, diagnosticContext);
      if (verified.status !== 'queued') deliveryDiagnostics.delete(action.actionId);
      return verified;
    }).catch(error => {
      deliveryDiagnostics.delete(action.actionId);
      if (!operatorGrant) throw error;
      operatorState.uncertain = true;
      const result = { ok: false, status: 'unknown', error: cleanError(error), targetId: action.targetId, generation: action.generation };
      receipt(action, result, diagnosticContext); return result;
    });
    if (dedupKey) { executed.set(dedupKey, work); if (executed.size > 300) executed.delete(executed.keys().next().value); }
    if (intent) intent.effectReceipts.set(effectReceiptKey, work);
    return work;
  }
  return { execute: doAction, clear: () => executed.clear() };
}

module.exports = { createWorkspaceExecutor };
