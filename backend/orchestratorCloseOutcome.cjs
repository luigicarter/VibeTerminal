'use strict';

const { remainingCloseScope } = require('./orchestratorCloseScope.cjs');

const isClose = value => value?.kind === 'close';
// A rejected unauthorized tool call did not acquire a lifecycle scope. It is
// still an action failure, but cannot fabricate a close operation or counts.
const isCloseEvidence = (value, grants = []) => isClose(value) && (!value.validationFailure
  || grants.some(grant => isClose(grant) && grant.id !== undefined && grant.id === value.grantId));
const identity = value => value?.close?.target || value?.target || { id: value?.targetId || value?.id, generation: value?.generation, launchToken: value?.launchToken };
const sameIdentity = (a, b) => Boolean(a?.id) && a.id === b?.id && a.generation !== undefined && a.generation === b.generation
  && (a.launchToken === undefined || a.launchToken === b.launchToken);
function confirmedClose(receipt, target = identity(receipt)) {
  const close = receipt?.close;
  return receipt?.ok === true && Boolean(close?.operationId) && sameIdentity(target, close.target)
    && ['removed', 'already-absent'].includes(close.pane) && ['stopped', 'already-absent'].includes(close.process)
    && close.launchSettled === true;
}
function nameFor(target, receipt, sessions) {
  const session = sessions.find(item => sameIdentity(target, item));
  const name = target?.name || target?.conversationTitle || receipt?.close?.target?.name || session?.name || session?.conversationTitle;
  if (typeof name === 'string' && name.trim() && !/[\\/\r\n]|[a-z]:|\.(?:exe|com|bat|cmd|ps1)\b/i.test(name)
      && !/^(?:powershell|pwsh|cmd|bash|zsh|sh)(?:\s|$)/i.test(name.trim())) return name.trim();
  // Generation-scoped fallback never borrows the name of a replacement pane.
  return target?.id ? `terminal ${String(target.id).replace(/[\r\n]/g, ' ')}` : 'the terminal';
}

// Caller must invalidate and refresh inventory before this function. Runtime
// orphan records are excluded by remainingCloseScope's visiblePane predicate.
// Absence updates scope counts; it never manufactures process-stop evidence.
function refreshCloseScopeOutcomes({ outcomes = [], grants = [], sessions = [] } = {}) {
  const refreshed = outcomes.map(outcome => ({ ...outcome, ...(outcome.close && { close: { ...outcome.close } }) }));
  for (const grant of grants.filter(isClose)) {
    if (!grant.closeScope?.scope || !Array.isArray(grant.closeScope.targets)) continue;
    const counts = remainingCloseScope(grant.closeScope, sessions);
    const receipt = refreshed.filter(outcome => isClose(outcome) && outcome.grantId === grant.id).at(-1);
    if (receipt) receipt.close = { ...receipt.close, ...counts };
    else refreshed.push({ kind: 'close', grantId: grant.id, status: 'close-scope-check',
      close: { scopeEmpty: grant.closeScope.targets.length === 0 && grant.closeScope.targetCount === 0, ...counts } });
  }
  return refreshed;
}

// Only backend lifecycle evidence qualifies a close. Model prose and transport
// statuses deliberately do not participate in this decision.
function summarizeCloseOutcomes({ outcomes = [], grants = [], sessions = [] } = {}) {
  const receipts = outcomes.filter(outcome => isCloseEvidence(outcome, grants)), closeGrants = grants.filter(isClose);
  const groups = closeGrants.map(grant => ({ grant, receipts: receipts.filter(item => item.grantId === grant.id) }));
  for (const receipt of receipts) if (!closeGrants.some(grant => grant.id === receipt.grantId)) {
    let group = groups.find(item => !item.grant && item.key === receipt.grantId);
    if (!group) groups.push(group = { key: receipt.grantId, receipts: [] });
    group.receipts.push(receipt);
  }
  let unresolvedCount = 0, newTargetCount = 0, totalTargetCount = 0, failed = false, pending = false;
  const parts = [];
  for (const { grant, receipts: items } of groups) {
    const frozen = grant?.closeScope?.targets || grant?.targets;
    const targets = frozen ? frozen.map(target => ({ ...grant?.targets?.find(item => sameIdentity(target, item)), ...target }))
      : items.filter(item => !item.close?.scopeEmpty).map(identity).filter((target, index, all) => all.findIndex(other => sameIdentity(target, other)) === index);
    const total = Math.max(targets.length, Number(grant?.closeScope?.targetCount) || 0);
    totalTargetCount += total;
    let verified = 0;
    const details = [];
    for (const target of targets) {
      const matching = items.filter(item => sameIdentity(target, identity(item)));
      const receipt = matching.at(-1), close = receipt?.close;
      if (confirmedClose(receipt, target)) { verified++; continue; }
      const name = nameFor(target, receipt, sessions);
      if (close?.pane === 'superseded' || close?.process === 'superseded' || receipt?.status === 'superseded') {
        details.push(`${name} was replaced; the replacement was left open.`);
      } else if (['removed', 'already-absent'].includes(close?.pane)) {
        details.push(`Removed the pane for ${name}; ${close?.launchSettled !== true ? 'pending launch cancellation' : 'its process stop'} is still unconfirmed.`);
      } else if (receipt?.ok === false || close?.process === 'failed') {
        details.push(`I couldn't confirm closure of ${name}.`);
      } else details.push(`Closure of ${name} is still unconfirmed.`);
      if (receipt?.ok === false || close?.process === 'failed') failed = true;
      else pending = true;
    }
    // A distinct failed attempt remains an effect even if another operation
    // subsequently closed the same target. A refreshed receipt for the same
    // operation, however, supersedes its earlier pending evidence.
    const lastOperations = new Map();
    for (const item of items) {
      const operationId = item.close?.operationId || item.actionId;
      const itemTarget = identity(item);
      lastOperations.set(operationId ? JSON.stringify([operationId, itemTarget.id, itemTarget.generation, itemTarget.launchToken]) : item, item);
    }
    const extraFailures = [...lastOperations.values()].filter(item => item.ok === false && !targets.some(target => items.filter(other => sameIdentity(target, identity(other))).at(-1) === item));
    if (extraFailures.length) { failed = true; details.push(`${extraFailures.length} separate close ${extraFailures.length === 1 ? 'attempt failed' : 'attempts failed'}.`); }
    const scopeEvidence = items.filter(item => Number.isInteger(item.close?.newTargetCount) || Number.isInteger(item.close?.remainingTargetCount)).at(-1)?.close;
    const added = Math.max(0, Number(scopeEvidence?.newTargetCount) || 0);
    const remaining = Math.max(0, Number(scopeEvidence?.remainingTargetCount) || 0);
    newTargetCount += added;
    const unresolved = Math.max(total - verified, remaining);
    unresolvedCount += unresolved;
    if (unresolved > total - verified) { pending = true; details.push('The latest inventory still contains original terminals in this scope.'); }
    if (total > targets.length) { pending = true; details.push(`Closure of ${total - targets.length} other original terminals is still unconfirmed.`); }
    const summary = total ? `Closed ${Math.min(verified, Math.max(0, total - remaining))} of ${total}${added ? ' original' : ''} terminals.` : 'No original terminals were available to close.';
    if (added) details.push(`${added} new ${added === 1 ? 'terminal remains' : 'terminals remain'} open.`);
    parts.push([summary, ...details].join(' '));
  }
  const present = groups.length > 0;
  const ok = present && !failed && unresolvedCount === 0;
  return { present, text: parts.join('\n\n') || undefined, ok, complete: ok && totalTargetCount > 0 && newTargetCount === 0, failed, pending, unresolvedCount, newTargetCount, totalTargetCount };
}

module.exports = { isClose, isCloseEvidence, confirmedClose, summarizeCloseOutcomes, refreshCloseScopeOutcomes };
