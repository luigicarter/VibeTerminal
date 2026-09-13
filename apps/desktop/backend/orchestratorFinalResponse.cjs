'use strict';

const { outcomeSentence, creationDescription } = require('./orchestratorResponse.cjs');
const { taskWaitSentence } = require('./orchestratorTaskStatus.cjs');
const { sentence } = require('./orchestratorFailureText.cjs');
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
// Every part carries its own spoken form so the voice stays inside two
// sentences however many panes the request touched.
function composeFinalResponse({ outcomes = [], waits = [], deliveryUpdates = [], sessions = [], grants = [] } = {}) {
  const submissions = waits.filter(wait => wait.source !== 'watch');
  const closure = summarizeCloseOutcomes({ outcomes, grants, sessions });
  if (!closure.present && !submissions.length && !outcomes.some(outcome => outcome.kind === 'create_session' || submissionKinds.has(outcome.kind))) return undefined;
  const safeSessions = sessions.map(session => ({ ...session, name: safeName(session), conversationTitle: undefined }));
  const safeGrants = grants.map(grant => ({ ...grant, targets: grant.targets?.map(target => ({ ...target, name: safeName(target) })) }));
  const parts = closure.present ? [{ text: closure.text, speech: closure.text }] : [], consumed = new Set();
  const direct = outcome => outcomeSentence(publicOutcome(outcome), safeSessions, safeGrants.filter(grant => !isClose(grant)));
  // One pane, one failure sentence. Repeating "I couldn't complete the request
  // for X." once per rejected step tells the user nothing the first sentence did
  // not, so the most specific one — the one carrying a reason — stands alone.
  const definiteFailure = outcome => (outcome.ok === false || ['blocked', 'rejected', 'cancelled'].includes(outcome.status)) && !uncertain.has(outcome.status);
  const failures = new Map();
  const pushOutcome = outcome => {
    const item = publicOutcome(outcome);
    const part = direct(item);
    if (!part?.text) return;
    if (!definiteFailure(item)) { parts.push(part); return; }
    const key = targetId(item) ? JSON.stringify(['failure', targetId(item), generation(item)]) : `text:${part.text}`;
    const detailed = Boolean(item.error || item.reason);
    const existing = failures.get(key);
    if (existing) {
      if (detailed && !existing.detailed) { parts[existing.index] = part; existing.detailed = true; }
      return;
    }
    failures.set(key, { index: parts.length, detailed });
    parts.push(part);
  };
  const renderWait = wait => {
    const session = safeSessions.find(session => session.id === targetId(wait) && session.generation === generation(wait));
    const target = safeGrants.flatMap(grant => grant.targets || []).find(target => target.id === targetId(wait) && target.generation === generation(wait));
    return taskWaitSentence(wait, session, session?.name || target?.name || 'the terminal');
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
        pushOutcome(receipt); continue;
      }
      const part = renderWait({ targetId: targetId(receipt), generation: generation(receipt), deliveryStatus: receipt.status || 'unknown',
        delivered: !['queued', 'staged'].includes(receipt.status), staged: receipt.kind === 'stage_draft' || receipt.status === 'staged',
        inputDisposition: receipt.inputDisposition });
      const detail = receipt.ok === false && (receipt.error || receipt.reason);
      parts.push(detail ? { text: `${part.text} ${detail}`, speech: part.speech } : part);
      continue;
    }
    if (outcome.kind === 'finish_terminal') {
      if (nonTaskFinishes.includes(outcome)) parts.push({ text: outcome.text.trim(), speech: outcome.text.trim() });
      else if (outcome.ok === false) pushOutcome(outcome);
      continue;
    }
    // A verified final interaction summary covers successful control steps,
    // but never conceals a separate failed action or another terminal's work.
    if (outcome.ok !== false && nonTaskFinishes.some(finish => finish.grantId === outcome.grantId && sameTarget(finish, outcome))) continue;
    pushOutcome(outcome);
  }
  for (const wait of submissions) if (!consumed.has(wait)) parts.push(renderWait(wait));
  // A pane opened for this request that then refused every action against it is
  // a side effect the user has to clean up. Say so here exactly as the failed
  // request path does, instead of leaving a silent orphan on the board.
  for (const creation of outcomes.filter(outcome => outcome.kind === 'create_session' && outcome.ok === true && outcome.status === 'created' && outcome.processState === 'running')) {
    const others = outcomes.filter(outcome => outcome !== creation && targetId(outcome) && sameTarget(outcome, creation) && !isCloseEvidence(outcome, grants));
    if (!others.length || !others.every(definiteFailure) || submissions.some(wait => sameTarget(wait, creation) && !wait.failed)) continue;
    parts.push(sentence('opened-not-sent', { pane: creationDescription(creation, safeSessions) }));
  }
  const written = parts.filter(part => part?.text);
  if (!written.length) return undefined;
  return { text: written.map(part => part.text).join('\n\n'), speech: speechFor(written) };
}

// The written reply may cover several panes; the spoken one never runs past two
// sentences. One part speaks for itself; more than one leads with the first and
// says where the rest are, so the user knows there is more to read.
function speechFor(parts) {
  if (parts.length === 1) return parts[0].speech || parts[0].text;
  const lead = firstSentence(parts[0].speech || parts[0].text);
  const rest = parts.length - 1;
  return `${lead} ${rest === 1 ? 'One more update is' : `${rest} more updates are`} in the conversation.`;
}
const firstSentence = text => (String(text).match(/^[\s\S]*?[.!?](?=\s|$)/) || [String(text)])[0].trim();

function formatFinalResponse(input) { return composeFinalResponse(input)?.text; }

module.exports = { formatFinalResponse, composeFinalResponse, speechFor, firstSentence };
