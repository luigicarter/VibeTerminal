'use strict';
const { randomUUID } = require('node:crypto');
const { ACTIONS } = require('./orchestratorPolicy.cjs');
const { handoffTargets } = require('./orchestratorHandoff.cjs');
const { projectIntent } = require('./orchestratorIntent.cjs');
const { routingBindingMatches } = require('./orchestratorLaunchers.cjs');
const { delegatedSubmissionFinishes } = require('./orchestratorFastPath.cjs');

const DELIVERED = new Set(['written', 'submitted', 'delivered', 'sent', 'acknowledged']);
// Mirrors the model tool batch: only these kinds become outcomes on success.
const OUTCOME_KINDS = ['finish_terminal', 'watch_terminal', 'create_project', 'remember_preference', 'forget_preference'];
const SCREEN_LIMIT = 600;

function screenExcerpt(read) {
  const text = read?.observation?.text ?? read?.observation?.output;
  return typeof text === 'string' && text.trim() ? text.slice(-SCREEN_LIMIT) : undefined;
}
function plainReason(result, fallbackText) {
  const text = result?.error || result?.reason;
  return typeof text === 'string' && text.trim() ? text.trim().slice(0, 600) : fallbackText;
}

// The application performs a bound task handoff itself: read, send, read, finish
// through the ordinary action validators. It authors no assistant or tool
// message, so every assistant turn in a model transcript stays the model's own.
// A refused or uncertain delivery hands control back with a plain report; no
// write is ever retried here.
function createDispatcher({ doAction, observations, getSessions = () => [], getRequests = () => [],
  getOperation, getWaits = () => [], requireFreshSessions = async () => {}, resetReadBudget = () => {},
  checkActive = () => {}, recordDiagnostic = () => {}, actionDiagnostic = () => {}, receipt = () => {},
  outcomes = [], readRecovery, diagnosticContext = {}, elapsed = () => 0, now = Date.now } = {}) {
  const currentObservations = () => typeof observations === 'function' ? observations() : observations;
  const nextStepId = () => `dispatch-${randomUUID()}`;

  // One action, executed and recorded exactly as the model tool batch records
  // its own: the same diagnostics, receipt, outcome and read-recovery hooks.
  async function perform(action, { modelRound } = {}) {
    const stepId = action.stepId || nextStepId();
    const toolContext = { ...diagnosticContext, toolCallId: stepId, modelRound };
    recordDiagnostic({ ...toolContext, event: 'request_stage', stage: 'tool_started', actionKind: action.kind, targetId: action.targetId, elapsedMs: 0 });
    const startedAt = now();
    let result, error;
    if (action.kind === 'read_session') resetReadBudget();
    try { result = await doAction(action, toolContext); }
    catch (failure) {
      checkActive();
      error = failure;
      result = { ok: false, status: 'rejected', validationFailure: true, error: String(failure?.message || 'Tool execution failed.').slice(0, 1000) };
    }
    checkActive();
    if (error) receipt({ kind: action.kind, targetId: action.targetId }, result, { ...toolContext, error });
    recordDiagnostic({ ...toolContext, event: 'request_stage', stage: 'tool_complete', actionKind: action.kind, targetId: action.targetId,
      status: result?.status || (result?.ok ? 'complete' : 'failed'), elapsedMs: now() - startedAt, totalMs: elapsed() });
    actionDiagnostic(action, result, toolContext);
    if (result?.ok === false || ACTIONS.has(action.kind) || OUTCOME_KINDS.includes(action.kind)) {
      outcomes.push({ kind: action.kind, grantId: toolContext.grantId || action.grantId, targetId: action.targetId, stepId: action.stepId,
        actionId: toolContext.actionId, generation: toolContext.generation, ...result });
    }
    readRecovery?.observe(action, result, result?.ok === false ? outcomes.at(-1) : undefined, false);
    return result;
  }

  function liveSession(handoff) {
    const target = handoff.target, binding = handoff.binding;
    const session = getSessions().find(item => item.id === target.id && item.generation === target.generation);
    if (!session || !binding || binding.id !== target.id || binding.generation !== target.generation) return;
    return routingBindingMatches({ target: binding, nativeIdentity: { workspace: handoff.cwd, id: binding.conversationId } }, session) ? session : undefined;
  }
  function pendingFor(target) {
    return getRequests().some(request => request.sessionId === target.id && request.state === 'pending' &&
      (request.generation === undefined || request.generation === target.generation));
  }

  // The delegated-finish contract is unchanged: prefer the validated submission
  // finish, and otherwise report the handoff's own certified wording.
  function finishAction({ plan, grant, handoff, token, send, modelRound }) {
    const target = handoff.target;
    const validated = delegatedSubmissionFinishes({ plan, outcomes, waits: getWaits(), sessions: getSessions(),
      observations: { latest: () => token, authorize: (...args) => currentObservations().authorize(...args) },
      modelRound, getOperation, pendingRequests: getRequests() })
      .find(action => action.grantId === grant.id && action.targetId === target.id);
    if (validated) return { ...validated, stepId: nextStepId(), observationToken: token };
    return { kind: 'finish_terminal', grantId: grant.id, targetId: target.id, stepId: nextStepId(), observationToken: token,
      outcome: send?.ok === false ? 'blocked' : 'completed',
      text: send?.status === 'queued' ? 'The prompt is queued; task start and result are pending.'
        : send?.ok === false ? 'Prompt delivery is unconfirmed. It has not been replayed.'
          : 'The task prompt was submitted. Its attributed result remains pending.' };
  }

  async function deliver({ plan, grant, handoff, modelRound }) {
    const target = handoff.target;
    const refuse = (reason, status, read) => ({ ok: false, reason, status, screen: screenExcerpt(read) });
    await requireFreshSessions(); checkActive();
    if (!liveSession(handoff)) return refuse('The assigned conversation changed before delivery.', 'conversation-changed');
    // An operation the model already stepped through, or one whose earlier write
    // is unconfirmed, stays the model's to resolve.
    const operation = getOperation(grant, target.id);
    if (operation?.steps || operation?.uncertain) return refuse('An earlier step of this operation is unresolved.', 'operation-in-progress');

    const read = await perform({ kind: 'read_session', targetId: target.id }, { modelRound });
    if (!read?.ok || typeof read.observationToken !== 'string') {
      return refuse(plainReason(read, 'The terminal could not be read before delivery.'), read?.status || 'unavailable', read);
    }
    await requireFreshSessions(); checkActive();
    const session = liveSession(handoff);
    if (!session) return refuse('The assigned conversation changed before delivery.', 'conversation-changed', read);
    if (pendingFor(target) || session.status === 'waiting' || session.pendingInteraction ||
        session.composer?.dirty || session.composer?.reserved) {
      return refuse('The terminal is waiting on input that is not this task.', 'pending-interaction', read);
    }

    const send = await perform({ kind: 'send_prompt', grantId: grant.id, targetId: target.id, stepId: nextStepId(),
      observationToken: read.observationToken, text: grant.text }, { modelRound });
    // Never retry a write. A proven-unsent or refused attempt returns to model
    // judgment; an uncertain one keeps its receipt and stops here.
    if (send?.delivery === 'not-dispatched' || send?.validationFailure) {
      return refuse(plainReason(send, 'The prompt was refused before it was typed.'), send?.status || 'rejected', read);
    }
    const uncertain = send?.ok !== true || !DELIVERED.has(send.status) && send.status !== 'queued';

    const postRead = await perform({ kind: 'read_session', targetId: target.id }, { modelRound });
    if (!postRead?.ok || typeof postRead.observationToken !== 'string') {
      return refuse(plainReason(postRead, 'The terminal could not be read after delivery.'), postRead?.status || 'unavailable', postRead);
    }
    await requireFreshSessions(); checkActive();
    if (!liveSession(handoff)) return refuse('The assigned conversation changed after delivery.', 'conversation-changed', postRead);

    const finish = finishAction({ plan, grant, handoff, token: postRead.observationToken, send, modelRound });
    const finished = await perform(finish, { modelRound });
    if (finished?.ok !== true || finish.outcome !== 'completed') {
      return refuse(plainReason(finished, uncertain ? 'Prompt delivery is unconfirmed. It has not been replayed.'
        : 'The delivered task could not be certified as complete.'), finished?.status || 'blocked', postRead);
    }
    return { ok: true };
  }

  return {
    perform,
    async run({ plan, grants, signal, modelRound } = {}) {
      const handled = [], fallback = [];
      if (!plan || plan.clarification) return { handled, fallback };
      const progress = projectIntent(plan);
      // Grants keep the user's stated order: the first grant the application
      // does not own hands the rest of the plan back to the model, so a bound
      // delivery can never overtake an earlier instruction.
      for (const grant of grants || plan.grants || []) {
        if (signal?.aborted) break;
        const state = progress.grants.find(item => item.id === grant.id);
        if (state?.dispatched) continue;
        // Bound task delivery only. Native menus, inspections, interrupts and
        // exits keep their own model-authored judgment. A fan-out ("on both
        // terminals that are done, push the fixes") is the same handoff once
        // per bound pane, in the plan's order; on the ladder the model loop
        // spent five rounds and fifty seconds stepping through exactly that.
        if (grant.kind !== 'operate_terminal' || grant.inspection || grant.operationMode !== 'task' ||
            (grant.lifecycleMode || 'preserve') !== 'preserve') break;
        const targets = handoffTargets(grant);
        if (!targets.length || targets.length !== (grant.targets || []).length) break;
        if (targets.some(handoff => typeof handoff.cwd !== 'string' || !handoff.cwd || !state?.availableTargetIds?.includes(handoff.target.id))) break;
        let refused;
        for (const handoff of targets) {
          if (signal?.aborted) break;
          const result = await deliver({ plan, grant, handoff, modelRound });
          if (result.ok) continue;
          refused = { grantId: grant.id, targetId: handoff.target.id, status: result.status, reason: result.reason, ...(result.screen && { screen: result.screen }) };
          break;
        }
        if (!refused && !signal?.aborted) { handled.push(grant.id); continue; }
        if (refused) fallback.push(refused);
        break;
      }
      if (handled.length || fallback.length) {
        recordDiagnostic({ ...diagnosticContext, event: 'request_stage', stage: 'dispatch', elapsedMs: elapsed(),
          handledCount: handled.length, fallbackCount: fallback.length, status: fallback.length ? 'fallback' : 'complete' });
      }
      return { handled, fallback };
    },
  };
}

module.exports = { createDispatcher };
