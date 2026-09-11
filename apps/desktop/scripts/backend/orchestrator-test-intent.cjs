'use strict';
// Deterministic model stand-in for existing engine tests. Interpret only the
// user's instruction and app-owned context; queued executor calls are never
// consulted. Production still normalizes and authorizes every returned plan.
const path = require('node:path');
const { authorizeModelAction, commandClauses, captureRelay, clarifyRelay, selectRelay } = require('../../backend/orchestratorPolicy.cjs');

function interpretTestIntent(context) {
  const instruction = context.instruction ?? context.text ?? '';
  const sessions = context.sessions || [];
  const roots = context.roots || {};
  const projects = roots.projects || context.projects || [];
  const intent = { ...context, text: instruction, projects, allowedPaths: [roots.documents, ...projects.map(p => p.path)].filter(Boolean) };
  const actions = [];
  const plan = () => ({ goal: instruction.length > 160 ? 'Handle the user request with its complete stated constraints.' : instruction, actions });
  const append = action => {
    const { target, targetId, generation, ...fields } = action;
    actions.push({ ...fields, ...(target || targetId ? { targetIds: [target?.id || targetId], selection: 'one' } : {}) });
  };
  const clarified = clarifyRelay(instruction, context.pendingRelay, sessions, context.targetId);
  if (clarified) { append({ ...clarified, ...(context.previousCommand?.requestId ? { sourceUserId: context.previousCommand.requestId } : {}) }); return plan(); }
  const pending = captureRelay(intent, sessions);
  if (pending) {
    if (pending.candidates.length === 1 || pending.selection === 'any') {
      const relay = selectRelay(pending, sessions, context.targetId);
      if (relay) append(relay);
    } else return { ...plan(), clarification: 'Which session should receive the instruction?' };
    return plan();
  }
  const tryAction = proposed => {
    try { const action = authorizeModelAction(proposed, intent, sessions); append(action); return action; } catch { return null; }
  };
  for (const kind of ['send_prompt', 'stage_draft']) if (tryAction({ kind })) return plan();
  for (const clause of commandClauses(instruction)) {
    const text = clause.text;
    if (/^(?:open|reopen|resume)\s+(?:(?:Codex|Claude|Gemini)\s+)?(?:conversation|chat|saved conversation)\b/i.test(clause.syntax)) {
      actions.push({ kind: 'resume_conversation' });
      continue;
    }
    if (/^(?:create|new|make)\s+(?:a\s+)?(?:project|folder|directory)\s+/i.test(clause.syntax)) {
      const named = text.replace(/^(?:create|new|make)\s+(?:a\s+)?(?:project|folder|directory)\s+/i, '').replace(/\s+(?:in|under)\s+(?:my\s+)?Documents[.!]?$/i, '').trim();
      const name = named.replace(/^(["'])(.*)\1$/, '$2');
      const created = tryAction({ kind: 'create_project', name, parent: roots.documents });
      if (created) intent.createdProjects = [{ name, path: path.join(created.parent, name) }];
      continue;
    }
    if (/^(?:create|start|launch|open|new)\b/i.test(clause.syntax)) {
      let created;
      for (const kindOfSession of [...new Set(['codex', 'claude', 'gemini', 'terminal', 'fusion', 'openfusion', ...sessions.map(s => s.kind)].filter(Boolean))]) {
        created = tryAction({ kind: 'create_session', kindOfSession });
        if (created) break;
      }
      if (created) continue;
    }
    if (/^remember\b/i.test(clause.syntax)) {
      const value = text.replace(/^remember\s+(?:(?:my\s+)?preference\s*:\s*|that\s+)?/i, '');
      tryAction({ kind: 'remember_preference', text: value });
      continue;
    }
    if (/^forget\b/i.test(clause.syntax)) {
      const value = text.replace(/^forget\s+(?:(?:the\s+|my\s+)?preference\s*:?\s*)?/i, '');
      tryAction({ kind: 'forget_preference', text: value });
      continue;
    }
    const setup = text.match(/^(?:launch|load|open)\s+(?:the\s+)?setup\s+(.+)$/i);
    if (setup) { tryAction({ kind: 'launch_setup', name: setup[1].replace(/[.!]$/, '') }); continue; }
    const saved = text.match(/^save\s+this\s+setup\s+as\s+(.+)$/i);
    if (saved) { tryAction({ kind: 'save_setup', name: saved[1] }); continue; }
    let navigated;
    for (const view of ['settings', 'history', 'orchestrator', 'multi', 'project']) {
      navigated = tryAction({ kind: 'navigate', view });
      if (navigated) break;
    }
    if (navigated) continue;
    for (const kind of ['focus_session', 'interrupt', 'restart', 'close']) if (tryAction({ kind })) break;
  }
  return plan();
}

module.exports = { interpretTestIntent };
