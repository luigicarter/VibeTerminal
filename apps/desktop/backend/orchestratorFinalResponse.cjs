'use strict';

const { formatDirectOutcomes } = require('./orchestratorResponse.cjs');
const { formatTaskWait } = require('./orchestratorTaskStatus.cjs');
const { isClose, isCloseEvidence, summarizeCloseOutcomes } = require('./orchestratorCloseOutcome.cjs');
const submissionKinds = new Set(['send_prompt', 'stage_draft']);
const uncertain = new Set(['unknown', 'unconfirmed', 'uncertain', 'write-failed']);
const labels = { codex: 'Codex', claude: 'Claude', 'claude-custom': 'Claude', gemini: 'Gemini',
  cursor: 'Cursor', kimi: 'Kimi', qwen: 'Qwen', grok: 'Grok Build', opencode: 'OpenCode', fusion: 'Fusion', openfusion: 'Open Fusion' };

function safeName(item) {
  const value = item?.name || item?.conversationTitle;
  return typeof value === 'string' && value.trim() && !/[\\/\r\n]|[a-z]:|\.(?:exe|com|bat|cmd|ps1)\b/i.test(value)
    && !/^(?:powershell|pwsh|cmd|bash|zsh|sh)(?:\s|$)/i.test(value.trim()) ? value.trim() : labels[item?.kind] || 'the terminal';
}
const targetId = item => item.targetId || item.target?.id || item.id;
const generation = item => item.generation ?? item.target?.generation;
const sameTarget = (a, b) => targetId(a) === targetId(b) && generation(a) === generation(b);
// Missing action identity never permits a same-pane delivery to stand in for
// another write. In particular a rejected second write must remain visible.
const sameAction = (a, b) => Boolean(a.actionId) && a.actionId === b.actionId
  && generation(a) !== undefined && sameTarget(a, b);
function publicOutcome(outcome) {
  if (!outcome.validationFailure) return outcome;
  const { error, reason, ...rest } = outcome;
  return rest;
}

// Caller refreshes scheduler/session evidence before publication. No model
// reply is accepted here: compose independent effects without losing failures.
function formatFinalResponse({ outcomes = [], waits = [], deliveryUpdates = [], sessions = [], grants = [] } = {}) {
  const submissions = waits.filter(wait => wait.source !== 'watch');
  const closure = summarizeCloseOutcomes({ outcomes, grants, sessions });
  if (!closure.present && !submissions.length && !outcomes.some(outcome => outcome.kind === 'create_session' || submissionKinds.has(outcome.kind))) return undefined;
  const safeSessions = sessions.map(session => ({ ...session, name: safeName(session), conversationTitle: undefined }));
  const safeGrants = grants.map(grant => ({ ...grant, targets: grant.targets?.map(target => ({ ...target, name: safeName(target) })) }));
  const parts = closure.present ? [closure.text] : [], consumed = new Set();
  const direct = outcome => formatDirectOutcomes([publicOutcome(outcome)], safeSessions, safeGrants.filter(grant => !isClose(grant)));
  const renderWait = wait => {
    const session = safeSessions.find(session => session.id === targetId(wait) && session.generation === generation(wait));
    const target = safeGrants.flatMap(grant => grant.targets || []).find(target => target.id === targetId(wait) && target.generation === generation(wait));
    return formatTaskWait(wait, session, session?.name || target?.name || 'the terminal');
  };
  const nonTaskFinishes = outcomes.filter(outcome => outcome.kind === 'finish_terminal' && outcome.ok
    && outcome.status === 'interaction-complete' && outcome.text?.trim()
    && !outcomes.some(other => other.kind === 'create_session' && sameTarget(other, outcome))
    && !outcomes.some(other => isCloseEvidence(other, grants) && sameTarget(other, outcome))
    && !grants.some(grant => isClose(grant) && grant.id === outcome.grantId)
    && !submissions.some(wait => sameTarget(wait, outcome))
    && !outcomes.some(other => submissionKinds.has(other.kind) && sameTarget(other, outcome)));
  for (const outcome of outcomes) {
    if (isCloseEvidence(outcome, grants)) continue;
    if (outcome.kind === 'create_session') { parts.push(direct(outcome)); continue; }
    const wait = submissions.find(wait => sameAction(wait, outcome));
    if (submissionKinds.has(outcome.kind) || wait) {
      if (wait) { if (!consumed.has(wait)) parts.push(renderWait(wait)); consumed.add(wait); continue; }
      const update = deliveryUpdates.filter(update => sameAction(update, outcome)).at(-1);
      const receipt = publicOutcome({ ...outcome, ...update });
      // A rejected pre-write action is an independent outcome, not a failed
      // completion of the other task already running in this pane.
      if (receipt.ok === false && !uncertain.has(receipt.status) || ['blocked', 'rejected', 'cancelled'].includes(receipt.status)) {
        parts.push(direct(receipt)); continue;
      }
      const text = renderWait({ targetId: targetId(receipt), generation: generation(receipt), deliveryStatus: receipt.status || 'unknown',
        delivered: !['queued', 'staged'].includes(receipt.status), staged: receipt.kind === 'stage_draft' || receipt.status === 'staged',
        inputDisposition: receipt.inputDisposition });
      const detail = receipt.ok === false && (receipt.error || receipt.reason);
      parts.push(`${text}${detail ? ` ${detail}` : ''}`);
      continue;
    }
    if (outcome.kind === 'finish_terminal') {
      if (nonTaskFinishes.includes(outcome)) parts.push(outcome.text.trim());
      else if (outcome.ok === false) parts.push(direct(outcome));
      continue;
    }
    // A verified final interaction summary covers successful control steps,
    // but never conceals a separate failed action or another terminal's work.
    if (outcome.ok !== false && nonTaskFinishes.some(finish => finish.grantId === outcome.grantId && sameTarget(finish, outcome))) continue;
    parts.push(direct(outcome));
  }
  for (const wait of submissions) if (!consumed.has(wait)) parts.push(renderWait(wait));
  return parts.filter(Boolean).join('\n\n') || undefined;
}

module.exports = { formatFinalResponse };
