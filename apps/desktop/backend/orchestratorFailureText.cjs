'use strict';

// The one catalogue for everything Lina says to the user about a pane. Every
// sentence is "what happened, then what is next": it names the pane the user is
// looking at, states the observed fact in the first person, and never blames the
// user, the model or the provider for something the application did. Nothing
// here exceeds two sentences, so the spoken form is the written form. Status
// enums and error codes keep their own vocabulary; they are never read aloud.
const PROVIDER_LABELS = Object.freeze({ codex: 'Codex', claude: 'Claude', 'claude-custom': 'Claude',
  gemini: 'Gemini', cursor: 'Cursor', kimi: 'Kimi', 'kimi-custom': 'Kimi',
  qwen: 'Qwen', grok: 'Grok Build', opencode: 'OpenCode', fusion: 'Fusion', openfusion: 'Open Fusion' });

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

// The pane as the user names it: its own title, else provider and folder.
function paneLabel(session, fallback = 'The terminal') {
  const name = displayLabel(session?.name) || displayLabel(session?.conversationTitle) || displayLabel(session?.conversation?.title);
  if (name) return name;
  const provider = PROVIDER_LABELS[session?.provider] || PROVIDER_LABELS[session?.kind];
  const project = projectLabel(session?.cwd);
  if (!provider) return fallback;
  return project ? `${provider} in ${project}` : provider;
}

// OpenRouter forwards the upstream envelope verbatim. Its message field is the
// only readable part; one sentence of it is what the user can act on.
function providerSentence(providerMessage) {
  if (typeof providerMessage !== 'string' || !providerMessage.trim()) return '';
  let text = providerMessage.trim();
  const inner = text.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (inner) { try { text = JSON.parse(`"${inner[1]}"`); } catch { text = inner[1]; } }
  return (text.split(/(?<=[.!?])\s/)[0] || text).replace(/\s+/g, ' ').trim().slice(0, 200);
}

const RETRY = "The pane is still open; say 'try again' when it's ready.";
// What Lina typed, echoed back on its own line so the user can check that the
// words that reached the agent are the words they meant. It belongs to the
// written form only: reading the task back aloud is the repetition the voice
// conversation was built to stop.
const TASK_ECHO_LIMIT = 80;
function taskEcho(task) {
  const text = String(task ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return `\nTask: ${text.length > TASK_ECHO_LIMIT ? `${text.slice(0, TASK_ECHO_LIMIT - 1).trimEnd()}…` : text}`;
}
const withEcho = (line, task) => { const echo = taskEcho(task); return echo ? { text: line + echo, speech: line } : line; };
// Reasons arrive from transports as whole sentences; one trailing stop is enough.
const clause = value => String(value ?? '').trim().replace(/[.\s]+$/, '');
const SENTENCES = Object.freeze({
  // Progress, published the moment the application observes the event.
  'creation-started': ({ pane }) => `Opening ${pane}.`,
  'typed': ({ pane, task }) => withEcho(`Typed the task into ${pane}; waiting for it to start.`, task),
  'started': ({ pane }) => `${pane} started working on it.`,
  'startup-screen': ({ pane, screen, seconds }) => `${pane} is still on its startup screen (${screen}); I'll answer it and keep trying for ${seconds} seconds.`,
  'startup-screen-waiting': ({ pane, screen, seconds }) => `${pane} is still on its startup screen (${screen}); I'll keep trying for ${seconds} seconds.`,
  'startup-answered': () => 'Answered the trust prompt; typing the task now.',
  'still-waiting': ({ pane }) => `Still waiting for ${pane} to become ready.`,

  // Openings and drafts.
  'created': ({ pane }) => `Opened ${pane}.`,
  'created-draft': ({ pane }) => `Opened ${pane}; the prompt is saved there as a draft and has not been sent.`,
  'creation-unconfirmed': () => "I asked for a new terminal; I haven't seen it finish starting yet.",
  'opened-not-sent': ({ pane }) => `I opened ${pane} but couldn't type the task; the pane is still open.`,
  'pane-still-open': ({ pane }) => `${pane} is still open.`,
  'staged': ({ pane, reason }) => `Saved the prompt as a draft in ${pane}; nothing was sent.${reason ? ` ${reason}` : ''} Open the pane to review and send it.`,

  // Deliveries that happened.
  'sent': ({ pane }) => `Typed the prompt into ${pane}.`,
  'accepted': ({ pane }) => `${pane} took the prompt; I'm waiting for its result.`,
  'delivered-unconfirmed': ({ pane }) => `Typed the task into ${pane}, but I haven't seen it start yet. I'll tell you when it does.`,
  'delivered-pending': () => "The task is in; I haven't seen a result yet. I'll tell you when one lands.",
  'delivered-while-running': ({ pane, task }) => withEcho(`Typed the follow-up into ${pane} while it was working; I haven't seen it taken up yet. I'll tell you when it is.`, task),
  'native-shell': ({ pane }) => `Typed the command into ${pane}. It is a plain shell, so I can't tell you when the command finishes.`,
  'queued': ({ pane }) => `The prompt for ${pane} is queued; nothing has been typed yet.`,
  'queued-busy': ({ pane }) => `${pane} is still working, so I queued the follow-up; it'll be typed when ${pane} is ready.`,

  // Live states.
  'running': ({ pane }) => `${pane} is working on it.`,
  'turn-started-unknown': ({ pane }) => `${pane} started on it; I haven't seen how far it has got.`,
  'needs-input': ({ pane }) => `${pane} is waiting on an answer before it can continue. Open the pane to give it one.`,
  'watching': ({ pane }) => `I'm watching ${pane} and I'll tell you what changes.`,
  'watching-ready': ({ pane }) => `I'm watching ${pane} and I'll tell you when it's ready.`,
  'watch-already-ended': ({ pane }) => `${pane} had already finished its turn; I'll look at the result.`,
  'watch-failed': ({ pane, reason }) => `I couldn't start watching ${pane}${reason ? `: ${clause(reason)}` : ''}.`,
  'ready': ({ pane }) => `${pane} is ready.`,
  'no-tracked-task': ({ pane }) => `I don't have a tracked task for ${pane}.`,

  // Endings.
  'turn-ended': ({ pane }) => `${pane} finished its turn; I haven't checked what it changed.`,
  // The pane's live title belongs to whatever it moved on to, so naming it here
  // would point the user at the wrong conversation. These two stay unnamed.
  'turn-ended-elsewhere': () => "That turn ended, but the pane has moved to another conversation since, so I can't check what it changed.",
  'turn-error': ({ pane, reason }) => `${pane} ended its turn with an error${reason ? `: ${clause(reason)}` : ''}. Check the pane for what it got through.`,
  'turn-interrupted': ({ pane, reason }) => `${pane}'s turn was interrupted${reason ? `: ${clause(reason)}` : ''}, so its work is unfinished. Check the pane.`,
  'turn-unconfirmed': ({ pane, reason }) => `I couldn't confirm the work in ${pane}${reason ? `: ${clause(reason)}` : ''}. Check the pane.`,
  'result': ({ pane, summary }) => `${pane} finished: ${summary}`,
  'all-turns-ended': () => 'All the terminal turns I started for this have ended.',

  // Nothing was typed, and why.
  'input-surface-unverified': ({ pane }) => `${pane} was still on its startup screen, so nothing was typed. ${RETRY}`,
  'launch-timeout': ({ pane, seconds }) => `${pane} didn't become ready within ${seconds} seconds, so nothing was typed. ${RETRY}`,
  'stale-observation': ({ pane }) => `${pane} changed while I was about to type, so I held off. Nothing was sent.`,
  'conversation-changed': ({ pane }) => `${pane} moved to another conversation while I was about to type, so I held off. Nothing was sent.`,
  'input-buffer-occupied': ({ pane }) => `${pane} already had text waiting in it, so I left it alone and typed nothing.`,
  'recipient-unavailable': ({ pane }) => `${pane} wasn't taking input when I tried, so nothing was typed. ${RETRY}`,
  'target-unavailable': ({ pane }) => `${pane} is no longer free, so nothing was typed. ${RETRY}`,
  'not-running': ({ pane }) => `${pane} had stopped by the time I tried to type, so nothing was sent.`,
  'stale-generation': ({ pane }) => `${pane} was restarted before I could type, so nothing was sent.`,
  'generation-changed': ({ pane }) => `${pane} was restarted before I could confirm its result; check the pane.`,
  'delivery-unknown': ({ pane }) => `I couldn't confirm that ${pane} took the prompt, and I haven't typed it again.`,
  'pane-changed': ({ pane }) => `${pane} changed, so I can't tell you where this task stands.`,
  'conversation-moved': () => "The pane has moved to another conversation, so I can't follow this task there.",
  'attribution-ambiguous': ({ pane }) => `I can't tell yet which of ${pane}'s turns is the one I started, so I'm still watching it.`,
  'blocked': ({ pane, reason }) => `I couldn't do that in ${pane}${reason ? `: ${clause(reason)}` : ''}.`,

  // The brain, when it could not answer. The provider's own sentence belongs in
  // the receipt and the diagnostics record, never in what the user hears.
  'brain-error': () => "I couldn't get a plan from the brain for that one, so nothing was typed.",
  'brain-timeout': () => 'The brain took too long to answer; nothing was typed. Try once more.',

  // Answers Lina composes from its own memory, with no model call: what it last
  // typed, what last went wrong, what a pane came back with, and what it has been
  // doing. Each states the recorded fact and nothing beyond it.
  'last-prompt': ({ pane, typedText, outcome }) => `The last prompt I put in was “${typedText}”, in ${pane}.` +
    (outcome === 'delivered-started' ? ' It started working on it.'
      : outcome === 'delivered-unconfirmed' ? " I haven't seen it start yet."
      : ['refused', 'created-only', 'failed', 'cancelled'].includes(outcome) ? ' It was not sent.' : ''),
  'last-error': ({ pane, reason }) => `The last thing that went wrong was in ${pane}: ${clause(reason)}.`,
  'pane-result': ({ pane, summary }) => `${pane} came back with: ${summary}`,
  'recent-actions': ({ actions }) => `Here is what I did: ${actions}.`,

  // Workspace effects with no pane of their own.
  'project-added': () => 'Added the folder as a Lina Terminal project.',
  'project-removed': () => 'Removed the project from Lina Terminal. No files or folders were deleted.',
  'folder-opened': () => 'Opened the folder in the file manager.',
  'navigated': ({ view }) => `Opened ${view}.`,
  'focused': ({ pane }) => `Switched to ${pane}.`,
  'stopped': ({ pane }) => `${pane} stopped.`,
  'stop-requested': ({ pane }) => `Asked ${pane} to stop.`,
  'accepted-request': () => 'I took care of that.',
});

const seconds = value => Math.max(1, Math.round(Number(value) || 0) || 20);
// Renders one catalogue entry. `speech` is what the voice says: the same words
// unless an entry supplies a shorter form, and always at most two sentences.
function sentence(key, context = {}) {
  const build = SENTENCES[key];
  if (!build) return undefined;
  const value = build({ ...context, pane: context.pane || 'the terminal', seconds: seconds(context.seconds) });
  const text = typeof value === 'string' ? value : value.text;
  return { text, speech: (typeof value === 'string' ? undefined : value.speech) || text };
}
function sentenceText(key, context) { return sentence(key, context)?.text; }

// Returns undefined for any status without an agreed sentence, so callers keep
// their existing wording rather than inventing one.
const FAILURE_STATUSES = Object.freeze(['input-surface-unverified', 'launch-timeout', 'stale-observation', 'generation-changed',
  'conversation-changed', 'input-buffer-occupied', 'recipient-unavailable', 'target-unavailable', 'not-running', 'stale-generation']);
function failureSentence(status, options = {}) {
  return FAILURE_STATUSES.includes(status) ? sentenceText(status, options) : undefined;
}

// A 4xx from the brain is the application's problem, not the user's model
// choice. Say what it means for their request; the provider's wording is kept
// for the receipt and the diagnostics record.
function brainRejectionSentence() { return sentenceText('brain-error'); }

module.exports = { PROVIDER_LABELS, displayLabel, projectLabel, paneLabel, providerSentence,
  SENTENCES, FAILURE_STATUSES, sentence, sentenceText, failureSentence, brainRejectionSentence, taskEcho, TASK_ECHO_LIMIT };
