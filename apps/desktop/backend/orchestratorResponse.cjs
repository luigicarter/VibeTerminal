'use strict';

const { isCloseEvidence, summarizeCloseOutcomes } = require('./orchestratorCloseOutcome.cjs');

function displayLabel(value) {
  if (typeof value !== 'string') return undefined;
  const label = value.trim();
  // Shell titles may contain quotes or a command around the executable path.
  if (!label || /[\\/\r\n]|[a-z]:|\.(?:exe|com|bat|cmd|ps1)\b/i.test(label) ||
      /^(?:powershell|pwsh|cmd|bash|zsh|sh)(?:\s|$)/i.test(label)) return undefined;
  return label;
}

function projectLabel(value) {
  if (typeof value !== 'string') return undefined;
  const cwd = value.trim().replace(/^(["'])(.*)\1$/, '$2').replace(/[\\/]+$/, '');
  const leaf = cwd.split(/[\\/]/).pop();
  return leaf && leaf !== '.' && leaf !== '..' ? displayLabel(leaf) : undefined;
}

function creationDescription(outcome, sessions) {
  // A pane id survives restart. Only the acknowledged launch can supply any
  // metadata missing from the receipt; neither grant arguments nor titles prove cwd.
  const identity = outcome.target;
  const session = identity?.id && identity.generation !== undefined
    ? sessions.find(item => item.id === identity.id && item.generation === identity.generation &&
      (identity.launchToken === undefined || item.launchToken === identity.launchToken)) : undefined;
  const providers = { codex: 'Codex', claude: 'Claude', 'claude-custom': 'Claude',
    gemini: 'Gemini', cursor: 'Cursor', kimi: 'Kimi', 'kimi-custom': 'Kimi',
    qwen: 'Qwen', grok: 'Grok Build', opencode: 'OpenCode', fusion: 'Fusion', openfusion: 'Open Fusion' };
  const name = displayLabel(outcome.name) || displayLabel(session?.name) ||
    displayLabel(session?.conversationTitle) || providers[session?.kind] || 'the terminal';
  const project = projectLabel(outcome.cwd ?? session?.cwd);
  return `${name}${project && project !== name ? ` in ${project}` : ''}`;
}

// Direct execution has no model-written reply. Describe only receipt evidence.
function formatDirectOutcomes(outcomes, sessions = [], grants = []) {
  const closure = summarizeCloseOutcomes({ outcomes, sessions, grants });
  return [closure.text, ...outcomes.filter(outcome => !isCloseEvidence(outcome, grants)).map(outcome => {
    const grant = grants.find(item => item.id === outcome.grantId);
    const id = outcome.targetId || outcome.id;
    const target = sessions.find(item => item.id === id) || grant?.targets?.find(item => item.id === id);
    const name = outcome.kind === 'create_session' ? 'the terminal'
      : target?.name || target?.conversationTitle || 'the terminal';
    const status = outcome.status;
    if (outcome.kind === 'watch_terminal') {
      if (status === 'watching') return `I'm watching ${name}. I'll report status changes and ${grant?.args?.watchUntil === 'ready' ? 'when it is ready' : 'what the agent reports when this task ends'}.`;
      if (status === 'ready') return `${name} is ready.`;
      if (status === 'already-completed') return `${name}'s current agent turn has already ended. I'll check the available result.`;
      return `I couldn't start a reliable watch for ${name}.${outcome.error || outcome.reason ? ` ${outcome.error || outcome.reason}` : ''}`;
    }
    if (['unknown', 'unconfirmed'].includes(status)) return `I couldn't confirm whether ${name} received the request. I haven't sent it again.`;
    if (outcome.ok === false || ['blocked', 'rejected', 'cancelled'].includes(status)) {
      const detail = outcome.error || outcome.reason;
      return `I couldn't complete the request${id ? ` for ${name}` : ''}.${detail ? ` ${detail}` : ''}`;
    }
    if (outcome.kind === 'remove_project') return 'Removed the project from Lina Terminal. No files or folders were deleted.';
    if (outcome.kind === 'add_project') return 'Added the folder as a Lina Terminal project.';
    if (outcome.kind === 'open_folder') return 'Opened the folder in the file manager.';
    if (outcome.kind === 'stage_draft' || status === 'staged') return `Saved the prompt as a draft in ${name}; it hasn't been sent.${outcome.reason ? ` ${outcome.reason}` : ''}${outcome.kind === 'send_prompt' ? ' Open the terminal to review and send it.' : ''}`;
    if (status === 'queued') return `Queued the request for ${name}; it hasn't been sent yet.`;
    if (outcome.kind === 'send_prompt') {
      if (['written', 'submitted', 'delivered', 'sent', 'acknowledged'].includes(status)) return `Sent the prompt to ${name}.`;
      return `The prompt request for ${name} was accepted; delivery isn't confirmed yet.`;
    }
    if (outcome.kind === 'create_session') {
      return outcome.status === 'created' && outcome.processState === 'running'
        ? `Opened ${creationDescription(outcome, sessions)}.${outcome.draftStaged ? ' The prompt is saved as an unsent draft.' : ''}`
        : 'The terminal was requested; startup is not confirmed yet.';
    }
    if (outcome.kind === 'interrupt') return status === 'stopped' ? `${name} stopped.` : `Requested a stop in ${name}.`;
    if (outcome.kind === 'focus_session') return `Switched to ${name}.`;
    if (outcome.kind === 'navigate') {
      const views = { settings: 'Settings', history: 'History', orchestrator: 'Orchestrator', multi: 'the workspace', project: 'the project' };
      return `Opened ${views[grant?.args?.view] || 'the requested view'}.`;
    }
    return 'The request was accepted.';
  })].filter(Boolean).join(' ');
}

module.exports = { formatDirectOutcomes };
