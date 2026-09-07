'use strict';

// Direct execution has no model-written reply. Describe only receipt evidence.
function formatDirectOutcomes(outcomes, sessions = [], grants = []) {
  return outcomes.map(outcome => {
    const grant = grants.find(item => item.id === outcome.grantId);
    const id = outcome.targetId || outcome.id;
    const target = sessions.find(item => item.id === id) || grant?.targets?.find(item => item.id === id);
    const name = target?.name || target?.conversationTitle || 'the terminal';
    const status = outcome.status;
    if (['unknown', 'unconfirmed'].includes(status)) return `I couldn't confirm whether ${name} received the request. I haven't sent it again.`;
    if (outcome.ok === false || ['blocked', 'rejected', 'cancelled'].includes(status)) {
      const detail = outcome.error || outcome.reason;
      return `I couldn't complete the request${id ? ` for ${name}` : ''}.${detail ? ` ${detail}` : ''}`;
    }
    if (outcome.kind === 'stage_draft' || status === 'staged') return `Saved the prompt as a draft in ${name}; it hasn't been sent.${outcome.reason ? ` ${outcome.reason}` : ''}${outcome.kind === 'send_prompt' ? ' Open the terminal to review and send it.' : ''}`;
    if (status === 'queued') return `Queued the request for ${name}; it hasn't been sent yet.`;
    if (outcome.kind === 'send_prompt') {
      if (['written', 'submitted', 'delivered', 'sent', 'acknowledged'].includes(status)) return `Sent the prompt to ${name}.`;
      return `The prompt request for ${name} was accepted; delivery isn't confirmed yet.`;
    }
    if (outcome.kind === 'interrupt') return status === 'stopped' ? `${name} stopped.` : `Requested a stop in ${name}.`;
    if (outcome.kind === 'focus_session') return `Switched to ${name}.`;
    if (outcome.kind === 'navigate') {
      const views = { settings: 'Settings', history: 'History', orchestrator: 'Orchestrator', multi: 'the workspace', project: 'the project' };
      return `Opened ${views[grant?.args?.view] || 'the requested view'}.`;
    }
    return 'The request was accepted.';
  }).join(' ');
}

module.exports = { formatDirectOutcomes };
