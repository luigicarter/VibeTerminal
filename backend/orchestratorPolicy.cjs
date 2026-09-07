'use strict';
const path = require('node:path');
const ACTIONS = new Set(['navigate', 'focus_session', 'create_session', 'stage_draft', 'get_draft', 'send_prompt', 'terminal_interact', 'interrupt', 'restart', 'close', 'answer_question', 'permission', 'open_file', 'open_folder', 'add_project', 'launch_setup', 'save_setup', 'stage_handoff', 'resume_conversation']);
const VERBS = 'navigate to|go to|take me to|focus|show|switch to|create|start|launch|open|reopen|resume|new|draft|stage|prepare|send|tell|ask|prompt|relay|forward|instruct|stop|interrupt|cancel|restart|close|add|make|load|remember|forget|save';
const INTENT = {
  navigate: /^(navigate to|go to|take me to|focus|show|switch to|open)\b/i,
  focus_session: /^(focus|show|switch to|go to|take me to|navigate to)\b/i, create_session: /^(create|start|launch|open|new)\b/i,
  stage_draft: /^(draft|stage|prepare)\b/i, send_prompt: /^(send|tell|ask|prompt|relay|forward|instruct)\b/i,
  interrupt: /^(stop|interrupt|cancel)\b/i, restart: /^restart\b/i, close: /^close\b/i,
  open_file: /^open\b/i, open_folder: /^open\b/i,
  add_project: /^(add|open)\s+(?:a\s+)?project\b/i, create_project: /^(create|new|make)\s+(?:a\s+)?(project|folder|directory)\b/i,
  launch_setup: /^(launch|load|open)\s+(?:the\s+)?setup\b/i,
  save_setup: /^save\s+this\s+setup\s+as\b/i,
  remember_preference: /^remember\b/i,
  forget_preference: /^forget\b/i,
};
// Strip conversational lead-ins only at the start, never search prose for a verb.
const stripPoliteness = text => text.trim().replace(/^(?:(?:yeah|yes|okay|ok|thanks|thank you)[,.!]?\s+)+/i, '').replace(/^(?:please\s+)?(?:(?:(?:can|could|would|will) you|I want you to)\s+)?(?:please\s+)?/i, '');
function stripPlease(text) {
  const cleaned = stripPoliteness(text);
  if (!/^bye[.!]\s+/i.test(cleaned)) return cleaned;
  const afterBye = stripPoliteness(cleaned.replace(/^bye[.!]\s+/i, ''));
  return new RegExp(`^(?:${VERBS})\\b`, 'i').test(afterBye) ? afterBye : cleaned;
}
function commandClauses(text) {
  let quote = '', masked = '';
  for (let i = 0; i < text.length; i++) { const ch = text[i]; if (quote) { if (ch === quote && text[i - 1] !== '\\') quote = ''; masked += ' '; } else if ((ch === '"' || ch === "'") && !(ch === "'" && /\w/.test(text[i - 1] || '') && /\w/.test(text[i + 1] || ''))) { quote = ch; masked += ' '; } else masked += ch; }
  const separators = new RegExp(`(?:\\s+(?:and(?: then)?|then)\\s+|;\\s*)(?=(?:${VERBS})\\b)`, 'ig');
  const result = []; let start = 0, match;
  // Everything after a relay command is opaque payload, not another action grant.
  while ((match = separators.exec(masked))) { const current = stripPlease(masked.slice(start)); if (/^(send|tell|ask|prompt|relay|forward|instruct|draft|stage|prepare|remember|forget)\b/i.test(current) || /\bwith (?:the )?prompt\b/i.test(masked.slice(start, match.index)) || /^(tell|ask) (it|them)\b/i.test(masked.slice(separators.lastIndex))) break; result.push({ text: stripPlease(text.slice(start, match.index)), syntax: stripPlease(masked.slice(start, match.index)) }); start = separators.lastIndex; }
  result.push({ text: stripPlease(text.slice(start)), syntax: stripPlease(masked.slice(start)) }); return result;
}
const aliases = kind => { const value = String(kind || '').toLowerCase(); return value === 'openfusion' ? ['openfusion', 'open fusion'] : value === 'claude' ? ['claude', 'claude code'] : [value]; };
function prefixLength(text, label) {
  if (!label) return 0; const normalized = text.toLowerCase(), wanted = label.toLowerCase();
  for (const candidate of [wanted, `"${wanted}"`, `'${wanted}'`]) if (normalized.startsWith(candidate) && (!normalized[candidate.length] || /[\s:,.!?]/.test(normalized[candidate.length]))) return candidate.length;
  return 0;
}
const locatorKey = text => String(text || '').toLowerCase().replace(/[\s"']/g, '');
function matchesLocator(text, session) {
  const names = [session.id, session.name, session.conversationTitle, ...(session.aliases || [])].filter(Boolean);
  const kinds = [...new Set([...aliases(session.kind), ...aliases(session.provider)])].filter(Boolean);
  const projects = [session.projectName, session.cwd, session.cwd && path.basename(session.cwd)].filter(Boolean);
  const labels = [...names, ...kinds.flatMap(kind => [kind, `${kind} terminal`, `${kind} session`, `${kind} agent`])];
  for (const kind of [...labels]) for (const project of projects) for (const prep of ['in', 'for', 'at']) for (const suffix of ['', ' project']) labels.push(`${kind} ${prep} ${project}${suffix}`);
  if (labels.some(label => locatorKey(label) === locatorKey(text))) return true;
  // Speech often repeats one target as provider, title, and project. Each part
  // must describe the SAME session; a list of different agents stays ambiguous.
  const parts = text.split(/\s*,\s*(?:and\s+)?|\s+and\s+/i).filter(Boolean);
  const descriptors = [...labels, ...projects.flatMap(project => [project, `${project} project`])];
  return parts.length > 1 && parts.every(part => descriptors.some(label => locatorKey(label) === locatorKey(part)));
}
function resolveTarget(clause, intent, sessions) {
  let addressed = clause.text.replace(new RegExp(`^(?:${VERBS})\\s+(?:(?:to|the)\\s+)?`, 'i'), '');
  const projectPronoun = addressed.match(/^(.+?)\s+(in|for|at)\s+(?:that|this|the) project\b/i);
  if (projectPronoun && sessions.some(session => matchesLocator(projectPronoun[1], session))) {
    if (!intent.projectContext?.path) throw new Error('Name the project first.');
    addressed = `${projectPronoun[1]} ${projectPronoun[2]} ${intent.projectContext.path}` + addressed.slice(projectPronoun[0].length);
  }
  const pronoun = addressed.match(/^(it|that terminal|that session|that agent|this terminal|this session)\b/i);
  if (pronoun) {
    const bound = intent.conversationTarget;
    const session = sessions.find(s => s.id === (intent.targetId || bound?.id));
    if (!session || !bound || session.id !== bound.id || session.generation !== bound.generation) throw new Error('The prior target is unavailable or has restarted. Identify the session again.');
    return { session, remainder: addressed.slice(pronoun[0].length), explicit: true };
  }
  const candidates = [];
  for (const session of sessions) {
    const labels = [session.id, session.name, session.conversationTitle, ...(session.aliases || [])];
    for (const kind of new Set([...aliases(session.kind), ...aliases(session.provider)])) { if (!kind) continue; for (const project of [session.projectName, session.cwd, session.cwd && path.basename(session.cwd)].filter(Boolean)) for (const preposition of ['in', 'for', 'at']) labels.push(`${kind} ${preposition} ${project}`); const length = prefixLength(addressed, kind); if (length && !/^\s+(?:in|for|at)\b/i.test(addressed.slice(length))) labels.push(kind); }
    const length = Math.max(0, ...labels.map(label => prefixLength(addressed, label))); if (length) candidates.push({ session, length });
  }
  const longest = Math.max(0, ...candidates.map(c => c.length)); const matched = candidates.filter(c => c.length === longest);
  // An explicit payload separator lets us validate the whole spoken locator,
  // instead of mistaking "terminal, project" for part of the prompt.
  const boundary = /(?:\s*[?.!]\s*)?\s+to\s+|:\s*/ig;
  let delimiter, quote = '', scanned = 0;
  while ((delimiter = boundary.exec(addressed))) {
    // Separators belong to a known longer identity or a quoted locator until
    // that identity ends; only then can they introduce the user's payload.
    for (; scanned < delimiter.index; scanned++) {
      const ch = addressed[scanned];
      if (quote) { if (ch === quote && addressed[scanned - 1] !== '\\') quote = ''; }
      else if ((ch === '"' || ch === "'") && !(ch === "'" && /\w/.test(addressed[scanned - 1] || '') && /\w/.test(addressed[scanned + 1] || ''))) quote = ch;
    }
    if (quote || delimiter.index < longest) continue;
    const locator = addressed.slice(0, delimiter.index).trim();
    const matching = sessions.filter(session => matchesLocator(locator, session));
    if (!matching.length) {
      const parts = locator.split(/\s*,\s*(?:and\s+)?|\s+and\s+/i).filter(Boolean);
      if (parts.length > 1 && parts.every(part => sessions.some(session => matchesLocator(part, session)))) throw new Error('Multiple relay targets were named. Send one instruction per target.');
      continue;
    }
    if (matching.length !== 1) throw new Error('The target is ambiguous or was not identified. Specify one session and project.');
    const session = matching[0];
    if (intent.targetId && intent.targetId !== session.id) throw new Error('The named target conflicts with the selected session or is ambiguous.');
    return { session, remainder: ':' + addressed.slice(boundary.lastIndex), explicit: true };
  }
  if (intent.targetId) { const selected = sessions.find(s => s.id === intent.targetId); if (!selected) throw new Error('Unknown selected session.'); if (matched.length && (matched.length !== 1 || matched[0].session.id !== selected.id)) throw new Error('The named target conflicts with the selected session or is ambiguous.'); const explicit = matched.find(c => c.session.id === selected.id); return { session: selected, remainder: explicit ? addressed.slice(explicit.length) : addressed, explicit: Boolean(explicit) }; }
  if (matched.length !== 1) throw new Error('The target is ambiguous or was not identified. Specify one session and project.'); return { session: matched[0].session, remainder: addressed.slice(longest), explicit: true };
}
function identifyReadTarget(intent, sessions) {
  if (intent.targetId) { const selected = sessions.find(s => s.id === intent.targetId); return selected && (!intent.conversationTarget || selected.generation === intent.conversationTarget.generation) ? selected : null; }
  const explicit = [], generic = [];
  for (const session of sessions) {
    const labels = [session.id?.length >= 3 ? session.id : null, session.name, session.conversationTitle, ...(session.aliases || [])], kinds = [...new Set([...aliases(session.kind), ...aliases(session.provider)])].filter(Boolean);
    for (const kind of kinds) for (const project of [session.projectName, session.cwd, session.cwd && path.basename(session.cwd)].filter(Boolean)) for (const prep of ['in', 'at', 'for']) labels.push(`${kind} ${prep} ${project}`);
    const mentions = label => { const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); return new RegExp(`(?:^|[\\s\"'])${escaped}(?=$|[\\s:,.!?\"'])`, 'i').test(intent.text); };
    if (labels.filter(Boolean).some(mentions)) explicit.push(session); else if (kinds.some(mentions)) generic.push(session);
  }
  const selected = explicit.length ? explicit : generic;
  if (selected.length === 1) return selected[0];
  if (selected.length || !/\b(it|that terminal|that session|that agent)\b/i.test(intent.text)) return null;
  const bound = intent.conversationTarget; return sessions.find(s => s.id === bound?.id && s.generation === bound.generation) || null;
}
function relayPayload(remainder, allowBare = false) {
  let value = remainder.trim();
  if (value.startsWith(':') || value.startsWith(',')) value = value.slice(1).trim(); else if (/^to\s+/i.test(value)) value = value.replace(/^to\s+/i, '');
  if (!allowBare && !/^(?:[:,]|to\s+|[\"'])/i.test(remainder.trim())) throw new Error('Identify the target explicitly or use a colon or quoted payload for the selected session.');
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
  if (!value.trim()) throw new Error('A complete relay payload is required.'); return value;
}
function authorizeModelAction(action, intent, sessions) {
  if (['open_file', 'open_folder'].includes(action.kind)) throw new Error('Use Workspace tools to open files or folders in an external application. Voice controls stay inside vibeTerminal.');
  const clauses = commandClauses(intent.text);
  const candidates = clauses.filter(c => INTENT[action.kind]?.test(c.syntax));
  if (!candidates.length) throw new Error('This action needs an explicit user instruction.');
  let lastError;
  for (const clause of candidates) {
    try {
      const result = { ...action }; let payload;
      if (action.kind === 'navigate') {
        const destination = clause.text.replace(/^(navigate to|go to|take me to|focus|show|switch to|open)\s+(?:the\s+)?/i, '').replace(/[.!?]+$/, '').trim();
        const views = { settings: ['settings', 'workspace settings', 'app settings'], history: ['history', 'conversation history'], orchestrator: ['orchestrator', 'orchestrator dashboard', 'dashboard'], multi: ['multi', 'multi mode', 'all projects'] };
        if (action.view === 'project') {
          const named = destination.replace(/^project\s+/i, '').replace(/\s+project$/i, '');
          const projects = new Map((intent.projects || []).filter(project => [project.name, project.path].some(label => label && locatorKey(label) === locatorKey(named))).map(project => [project.path, project]));
          if (projects.size !== 1) throw new Error('Name one existing project to navigate to.');
          const cwd = [...projects.keys()][0];
          if (action.cwd && action.cwd !== cwd) throw new Error('The model selected a different project.');
          result.cwd = cwd;
        } else if (!views[action.view]?.includes(destination.toLowerCase()) || action.cwd !== undefined) throw new Error('Name the application view to open: settings, history, orchestrator, multi, or a project.');
        // Navigation carries no prompt, settings mutation, or external path.
        if (Object.keys(action).some(key => !['kind', 'view', 'cwd'].includes(key))) throw new Error('Navigation only accepts a view and an existing project.');
        return result;
      }
      if (action.kind === 'remember_preference') {
        if (!/^remember\s+\S/i.test(clause.text)) throw new Error('Specify the complete preference to remember.');
        payload = clause.text.replace(/^remember\s+(?:(?:my\s+)?preference\s*:\s*|that\s+)?/i, '');
        payload = relayPayload(':' + payload);
        if (action.text !== payload) throw new Error('Remembered preference must equal the COMPLETE explicit user payload.');
      }
      if (action.kind === 'forget_preference') {
        if (!/^forget\s+\S/i.test(clause.text)) throw new Error('Specify the stored preference to forget.');
        payload = relayPayload(':' + clause.text.replace(/^forget\s+(?:(?:the\s+|my\s+)?preference\s*:?\s*)?/i, ''));
        const matching = (intent.preferences || []).filter(p => p.id === payload || p.text === payload);
        if (matching.length !== 1) throw new Error('Specify one stored preference by its exact full text or ID.');
        if ((action.preferenceId && action.preferenceId !== matching[0].id) || (action.text !== undefined && action.text !== payload)) throw new Error('The model selected a different preference than the user.');
        result.preferenceId = matching[0].id;
      }
      if (['focus_session', 'stage_draft', 'send_prompt', 'interrupt', 'restart', 'close'].includes(action.kind)) {
        const resolved = resolveTarget(clause, intent, sessions); const session = resolved.session;
        if (action.targetId && action.targetId !== session.id) throw new Error('The model selected a different target than the user.'); result.targetId = session.id; result.target = { id: session.id, generation: session.generation };
        if (['stage_draft', 'send_prompt'].includes(action.kind)) { payload = relayPayload(resolved.remainder, resolved.explicit); if (action.text !== undefined && action.text !== payload) throw new Error('Relay text must equal the COMPLETE user payload, including all qualifiers.'); result.text = payload; }
      }
      // Negation inside the full relayed payload is preserved; negation in action clauses denies effects.
      const controlText = payload === undefined ? (action.kind === 'create_session' ? clause.syntax.split(/\b(?:with (?:the )?prompt|and (?:tell|ask) (?:it|them))\b/i)[0] : clause.syntax) : clause.text.slice(0, clause.text.indexOf(payload));
      if (/\b(don't|do not|never|mustn't|shouldn't|without|unless|if)\b/i.test(controlText)) throw new Error('Conditional or negative action instructions require an explicit workspace control.');
      const allowedPaths = [...(intent.allowedPaths || [])];
      if (action.kind === 'create_session') {
        if (!action.kindOfSession || !aliases(action.kindOfSession).some(kind => new RegExp(`^(?:create|start|launch|open|new)\\s+(?:(?:a|an|new)\\s+)?${kind.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(clause.syntax))) throw new Error('Specify the kind of agent or terminal to create.');
        const promptMatch = clause.text.match(/\s+(?:with (?:the )?prompt|and (?:tell|ask) (?:it|them))\s*:?\s*([\s\S]+)$/i);
        const locationText = promptMatch ? clause.text.slice(0, promptMatch.index) : clause.text;
        if (action.text !== undefined) { if (!promptMatch || action.text !== relayPayload(':' + promptMatch[1])) throw new Error('New-session prompt must equal the complete explicit user prompt.'); } else if (promptMatch) throw new Error('The explicit new-session prompt cannot be omitted.');
        const projects = new Map();
        for (const project of [...(intent.projects || []), ...sessions.map(s => ({ name: s.projectName || (s.cwd && path.basename(s.cwd)), path: s.cwd }))]) { if (!project.name || !project.path) continue; const locator = locationText.match(/\b(?:in|at|for)\s+(.+?)\s*[.!]?$/i)?.[1]; if (locator && [project.name, project.path, `"${project.name}"`, `'${project.name}'`].some(n => n.toLowerCase() === locator.toLowerCase())) projects.set(project.path, project); }
        if (/\bthere\s*[.!]?$/i.test(locationText) && intent.createdProjects?.length === 1) projects.set(intent.createdProjects[0].path, intent.createdProjects[0]);
        if (projects.size === 1) { const cwd = [...projects.keys()][0]; if (action.cwd && action.cwd !== cwd) throw new Error('The model selected a different project.'); result.cwd = cwd; allowedPaths.push(cwd); }
        else if (projects.size > 1) throw new Error('Project name is ambiguous. Specify its exact path.');
        if (!result.cwd) throw new Error('Specify the project for the new session.');
      } else if (action.text !== undefined && payload === undefined) throw new Error('This action does not accept relay text.');
      for (const p of [result.path, result.cwd, result.parent, ...(result.paths || [])].filter(Boolean)) if (typeof p !== 'string' || (!clause.text.includes(p) && !allowedPaths.includes(p))) throw new Error('Paths must be explicitly identified by the user.');
      if (action.name && !clause.text.includes(action.name)) throw new Error('The name must come from the user instruction clause.');
      if (action.kind === 'create_project') {
        let named = clause.text.replace(/^(create|new|make)\s+(?:a\s+)?(project|folder|directory)\s+/i, '').trim();
        const suffixes = ['Documents', 'my Documents', action.parent].filter(Boolean);
        for (const suffix of suffixes) for (const preposition of ['in', 'under']) { const tail = ` ${preposition} ${suffix}`; if (named.toLowerCase().endsWith(tail.toLowerCase())) named = named.slice(0, -tail.length).trim(); }
        if (!action.name || ![action.name, `"${action.name}"`, `'${action.name}'`].includes(named)) throw new Error('Project creation requires the complete exact user-chosen name.');
      }
      if (action.kind === 'launch_setup') { const named = clause.text.replace(/^(launch|load|open)\s+(?:the\s+)?setup\s+/i, '').trim().replace(/[.!]$/, ''); if (!action.name || ![action.name, `"${action.name}"`, `'${action.name}'`].includes(named)) throw new Error('Specify the exact saved setup name.'); }
      if (action.kind === 'save_setup') { const named = clause.text.replace(/^save\s+this\s+setup\s+as\s+/i, '').trim(); if (!action.name || ![action.name, `"${action.name}"`, `'${action.name}'`].includes(named)) throw new Error('Specify the complete exact name for this setup.'); }
      if (action.settings || action.answers || action.recipe || action.decision || action.response) throw new Error('This action requires direct user confirmation in its control.');
      return result;
    } catch (error) { lastError = error; }
  }
  throw lastError;
}
function authorizeConversationResume(action, intent, conversations) {
  // Native titles and transcript content cannot grant an effect. Resolve the
  // user's current command against returned identities, never a model guess.
  let matches = new Map();
  // Exact punctuation belongs to a title. Only try sentence punctuation if
  // the literal command did not identify any candidate.
  for (const trimPunctuation of [false, true]) {
  for (const clause of commandClauses(intent.text)) {
    if (!/^(open|reopen|resume)\b/i.test(clause.syntax)) continue;
    const raw = clause.text.replace(/^(open|reopen|resume)\s+/i, '').trim();
    const command = trimPunctuation ? raw.replace(/[.!]$/, '') : raw;
    for (const conversation of conversations) {
      const providerNames = [...new Set([...aliases(conversation.provider), ...(conversation.fusion ? ['fusion'] : []), ...(conversation.openFusion ? ['open fusion'] : [])])];
      const prefixes = ['', 'the ', 'conversation ', 'chat ', 'session ', 'the conversation ', 'the chat ', 'the session ', 'saved conversation ', 'previous conversation ', 'the saved conversation ', 'the previous conversation '].map(text => ({ text }));
      for (const provider of providerNames) for (const text of [`${provider} `, `${provider} conversation `, `${provider} chat `, `the ${provider} conversation `, `the ${provider} chat `]) prefixes.push({ text, provider: conversation.provider });
      if (['claude', 'claude-custom'].includes(conversation.provider)) {
        const claudeHome = conversation.provider === 'claude-custom' || conversation.claudeHome === 'custom' ? 'custom' : 'global';
        for (const noun of ['', 'conversation ', 'chat ']) for (const article of ['', 'the ']) prefixes.push({ text: `${article}${claudeHome} claude ${noun}`, provider: 'claude', claudeHome });
      }
      const suffixes = [{ text: '' }];
      for (const location of [conversation.cwd, conversation.cwd && path.basename(conversation.cwd)].filter(Boolean)) for (const prep of ['in', 'for', 'at']) for (const quoted of [location, `"${location}"`, `'${location}'`]) suffixes.push({ text: ` ${prep} ${quoted}`, cwd: location });
      for (const kind of ['id', 'title']) {
        const value = conversation[kind]; if (typeof value !== 'string' || !value.trim()) continue;
        for (const named of [value, `"${value}"`, `'${value}'`]) for (const prefix of prefixes) for (const suffix of suffixes) {
          if (`${prefix.text}${named}${suffix.text}`.toLowerCase() !== command.toLowerCase()) continue;
          const selection = { kind, value, ...(prefix.provider ? { provider: prefix.provider } : {}), ...(prefix.claudeHome ? { claudeHome: prefix.claudeHome } : {}), ...(suffix.cwd ? { cwd: suffix.cwd } : {}) };
          if (matches.get(conversation.reference)?.selection.kind !== 'id') matches.set(conversation.reference, { conversation, selection });
        }
      }
    }
  }
  if (matches.size) break;
  }
  if ([...matches.values()].some(match => match.selection.kind === 'id')) matches = new Map([...matches].filter(([, match]) => match.selection.kind === 'id'));
  if (matches.size !== 1) throw new Error('Name one saved conversation by its exact title or ID, including its provider and folder if needed.');
  const { conversation: chosen, selection } = [...matches.values()][0];
  if (chosen.reference !== action.reference) throw new Error('The model selected a different saved conversation than the user.');
  return { kind: 'resume_conversation', reference: chosen.reference, selection };
}
// Directory antecedents come from a complete user query, not model list filters
// or prose. Unsupported subset qualifiers fail closed instead of widening scope.
function identifySessionGroup(intent, sessions) {
  const query = stripPoliteness(intent.text).match(/^(?:how many|list|show(?: me)?|what are|which are)\s+(?:(?:all(?: of)?|the|my)\s+)*((?:[\w-]+\s+){0,2})(terminals?|sessions?|agents?)\b([\s\S]*)$/i);
  if (!query) return null;
  const descriptor = query[1].trim().toLowerCase();
  const providerNames = [...new Set(['codex', 'claude', 'gemini', 'kimi', 'qwen', 'fusion', 'openfusion', 'shell', ...sessions.flatMap(s => [s.kind, s.provider])].filter(Boolean))];
  const provider = providerNames.find(name => aliases(name).includes(descriptor));
  if (descriptor && !provider && !['vyp', 'vibe'].includes(descriptor)) return null;
  let suffix = query[3].trim().replace(/^(?:do I have|are there|are open)\b/i, '').trim().replace(/^[?.!]\s*/, '').replace(/[?.!]+$/, '').trim();
  let project;
  if (suffix) {
    const location = suffix.match(/^(?:in|for|at)\s+(.+)$/i);
    if (!location) return null;
    const named = location[1].replace(/^the\s+/i, '').replace(/\s+project$/i, '');
    const matches = new Map((intent.projects || []).filter(p => [p.name, p.path].some(label => label && locatorKey(label) === locatorKey(named))).map(p => [p.path, p]));
    if (matches.size !== 1) return null;
    project = [...matches.values()][0];
  } else project = intent.projectContext;
  if (!project?.path) return null;
  const candidates = sessions.filter(s => s.cwd === project.path && (!provider || [s.kind, s.provider].some(kind => aliases(kind).some(alias => aliases(provider).includes(alias))))).map(({ id, generation }) => ({ id, generation }));
  return { candidates, projectPath: project.path, ...(provider ? { provider } : {}) };
}
function groupRelay(clause, kind, intent, sessions) {
  const addressed = clause.text.replace(new RegExp(`^(?:${VERBS})\\s+(?:to\\s+)?`, 'i'), '');
  const match = addressed.match(/^((?:(?:any|one|either)(?:\s+one)?(?:\s+of)?|a\s+random|any\s+random)\s+.+?)(?:\s*[?.!]\s*)?(?:\s+to\s+|:\s*)([\s\S]+)$/i);
  if (!match) return null;
  const locator = match[1].trim();
  let group;
  if (/^(?:(?:one|any|either)(?:\s+one)?\s+of\s+(?:them|those|these)|a\s+random\s+one\s+of\s+(?:them|those|these))$/i.test(locator)) group = intent.conversationGroup;
  else {
    const named = locator.replace(/^(?:(?:one|any|either)(?:\s+one)?(?:\s+of)?|a\s+random|any\s+random)\s+(?:the\s+)?/i, '');
    // A fresh group command must name its own project; a remembered project
    // alone cannot turn an unbound pronoun into all of its sessions.
    if (!/\s+(?:in|for|at)\s+/i.test(named)) return null;
    group = identifySessionGroup({ ...intent, text: `list ${named}` }, sessions);
  }
  if (!group || !Array.isArray(group.candidates)) return null;
  const candidates = sessions.filter(s => group.candidates.some(c => c.id === s.id && c.generation === s.generation) && (!group.projectPath || s.cwd === group.projectPath)).map(({ id, generation }) => ({ id, generation }));
  if (!candidates.length) return null;
  return { kind, text: relayPayload(':' + match[2]), candidates, selection: 'any' };
}
// A pending relay is captured from user syntax, never from a model's proposed
// prompt. It is usable only by the immediately following target-only reply.
function captureRelay(intent, sessions) {
  const clauses = commandClauses(intent.text);
  if (clauses.length !== 1) return null;
  const kind = ['send_prompt', 'stage_draft'].find(kind => INTENT[kind].test(clauses[0].syntax));
  if (!kind) return null;
  const group = groupRelay(clauses[0], kind, intent, sessions);
  if (group) return group;
  try { resolveTarget(clauses[0], intent, sessions); } catch (error) { if (error.message.startsWith('Multiple relay targets')) return null; }
  const candidates = [];
  for (const session of sessions) {
    try {
      const action = authorizeModelAction({ kind }, intent, [session]);
      candidates.push({ id: session.id, generation: session.generation, text: action.text });
    } catch {}
  }
  if (!candidates.length || candidates.some(c => c.text !== candidates[0].text)) return null;
  return { kind, text: candidates[0].text, candidates: candidates.map(({ id, generation }) => ({ id, generation })) };
}
function selectRelay(pending, sessions, targetId) {
  if (!pending || !Array.isArray(pending.candidates)) return null;
  const candidates = sessions.filter(session => (!targetId || session.id === targetId) && pending.candidates.some(c => c.id === session.id && c.generation === session.generation));
  if (!candidates.length) return null;
  const selected = candidates[Math.floor(Math.random() * candidates.length)];
  return { kind: pending.kind, text: pending.text, target: { id: selected.id, generation: selected.generation } };
}
function clarifyRelay(text, pending, sessions, targetId) {
  if (!pending) return null;
  // Only a complete selection reply delegates choice. Never find a command
  // inside explanation, quotation, negation, or a conditional instruction.
  const delegated = stripPoliteness(text).replace(/^(?:they're|they are)\s+empty(?:\s+right now)?[,.;]?\s+(?:so\s+)?/i, '').replace(/^just\s+/i, '').replace(/[.!?]+$/, '').trim();
  if (/^(?:(?:pick|choose|select)\s+(?:(?:any|either)(?:\s+(?:one|of them|terminal|session))?|(?:a\s+)?random\s+(?:one|terminal|session)(?:\s+of them)?)|(?:you\s+(?:pick|choose|decide))|(?:any|either)\s+one(?:\s+of them)?)$/i.test(delegated)) return selectRelay(pending, sessions, targetId);
  const locator = stripPlease(text).replace(/[.!?]+$/, '').trim();
  const candidates = sessions.filter(session => pending.candidates.some(c => c.id === session.id && c.generation === session.generation) && matchesLocator(locator, session));
  if (candidates.length !== 1 || (targetId && candidates[0].id !== targetId)) return null;
  return { kind: pending.kind, text: pending.text, target: { id: candidates[0].id, generation: candidates[0].generation } };
}
function identifyProject(text, projects, previous) {
  const matches = new Map();
  for (const project of projects) {
    const labels = [project.name, project.path].filter(label => typeof label === 'string' && label.length >= 3);
    for (const label of labels) {
      const words = label.replace(/([a-z])([A-Z])/g, '$1 $2').split(/\s+/);
      const pattern = words.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*');
      if (new RegExp(`(?:^|[\\s"'])${pattern}(?=$|[\\s"':,.!?])`, 'i').test(text)) matches.set(project.path, project);
    }
  }
  if (matches.size > 1) return null;
  if (matches.size === 1) return [...matches.values()][0];
  return /\b(?:that|this|same)\s+(?:project|repo(?:sitory)?|folder)\b/i.test(text) ? projects.find(project => project.path === previous?.path) || null : null;
}
module.exports = { ACTIONS, authorizeModelAction, authorizeConversationResume, commandClauses, resolveTarget, relayPayload, identifyReadTarget, captureRelay, clarifyRelay, selectRelay, identifySessionGroup, identifyProject };
