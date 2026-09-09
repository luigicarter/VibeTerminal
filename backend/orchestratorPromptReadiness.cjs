'use strict';

// Startup input evidence only. Callers retain ownership of lifecycle, launch
// identity, cancellation and the final generation/PID/sequence write fence.
// A process-start event, idle metadata or elapsed time cannot establish this.
function assessNativePromptReadiness(session, observation) {
  const result = (status, reason) => ({ ready: status === 'ready', status, reason });
  if (!session || !observation?.ok || observation.id !== session.id || observation.generation !== session.generation || observation.exited)
    return result('starting', 'A current decoded screen for this terminal generation is required.');
  if (session.pendingInteraction || session.turnState === 'waiting' || ['approval', 'question'].includes(session.attention?.reason))
    return result('blocked', 'The terminal has a pending question or permission request.');
  if (session.pendingInput || session.manualInputPending || session.interactionInputPending || session.heldMouseButton ||
      observation.manualInputPending || observation.interactionInputPending)
    return result('blocked', 'The terminal may contain pending input; no startup prompt was sent.');
  if (!Number.isSafeInteger(observation.sequence) || observation.sequence <= 0 ||
      !Number.isSafeInteger(observation.inputRevision) || observation.inputRevision < 0 ||
      typeof observation.text !== 'string' || !observation.text.trim())
    return result('starting', 'The terminal has not displayed an input surface yet.');
  if (observation.screenTruncated === true)
    return result('starting', 'The current terminal screen is clipped; a complete screen is required.');
  const kind = session.provider || session.kind;
  const provider = kind === 'claude-custom' ? 'claude' : kind;
  // Codex has a native capture; Claude's form is grounded in its bundled input
  // component; PowerShell uses its standard prompt. Never accept a glyph alone.
  if (!['codex', 'claude', 'terminal'].includes(provider))
    return result('unsupported', 'Startup composer recognition is unavailable for this native provider.');
  const text = observation.text;
  // Agent onboarding prose can also occur in a valid shell directory name or
  // prior command output. Shell readiness is established by its prompt below.
  if (provider !== 'terminal' && /\b(?:Do you trust|Set up the Codex agent sandbox|Sign in to (?:Codex|ChatGPT)|Trust this (?:directory|folder)|Review startup hooks)\b/i.test(text))
    return result('blocked', 'The terminal is displaying startup onboarding or a permission screen.');
  if (provider !== 'terminal' && /\bmodel:\s*loading\b|\bInput disabled\b|\bShutting down\b|\bConnecting to (?:the )?(?:server|agent)\b/i.test(text))
    return result('starting', 'The native composer is still loading or disabled.');
  const cursor = observation.cursor;
  if (observation.cursorVisible !== true || !Number.isSafeInteger(cursor?.x) || !Number.isSafeInteger(cursor?.y) ||
      cursor.x < 0 || cursor.y < 0 || !Number.isSafeInteger(observation.cols) || !Number.isSafeInteger(observation.rows) ||
      cursor.x >= observation.cols || cursor.y >= observation.rows)
    return result('starting', 'A visible native input cursor has not been observed.');
  const lines = text.split('\n');
  const line = lines[cursor.y];
  if (provider === 'terminal') {
    // An empty standard PowerShell prompt ends at the cursor. Customized shell
    // prompts need their own verified recognizer; shell output is not readiness.
    // Use only decoder-proven soft wraps. Joining arbitrary display rows could
    // mistake old shell output for the current prompt. beforeCursor is assembled
    // by terminal cells so wide Unicode path characters cannot shift this check.
    const logical = observation.cursorLine;
    const validLogical = logical && Number.isSafeInteger(logical.startRow) && logical.startRow >= 0 && logical.startRow <= cursor.y &&
      typeof logical.text === 'string' && typeof logical.beforeCursor === 'string' &&
      !/[\r\n]/.test(logical.text + logical.beforeCursor);
    const promptLine = validLogical ? logical.text.trimEnd() : typeof line === 'string' ? line.trimEnd() : '';
    const prompt = /^PS (?:[A-Za-z]:[\\/]|\\\\|\/)[^>\r\n]*>$/.test(promptLine);
    const atEmptyCursor = validLogical
      ? logical.beforeCursor === promptLine || logical.beforeCursor === promptLine + ' '
      : typeof line === 'string' && cursor.x >= promptLine.length && cursor.x <= promptLine.length + 1;
    return prompt && atEmptyCursor
      ? result('ready', 'The standard PowerShell input prompt is visible at its empty cursor.')
      : result('starting', 'The standard PowerShell input prompt has not been observed.');
  }
  if (typeof line !== 'string') return result('starting', 'The current input cursor is outside the decoded screen text.');
  if (provider === 'claude') {
    if (/\b(?:Do you want to proceed|Allow Claude to|Select (?:a |your )?(?:theme|model|login|account)|Choose (?:a |your )?(?:theme|model|login|account)|Enter (?:your )?(?:API key|authentication code)|Trust (?:this|the) (?:folder|workspace))\b/i.test(text))
      return result('blocked', 'Claude is displaying onboarding, a modal, or a permission request.');
    const border = value => /^[╭┌╰└]?[─━-]{3,}[╮┐╯┘]?$/.test((value || '').trim());
    // Claude's main input uses pointer + NBSP (ASCII > fallback), horizontal
    // boundaries, and the shortcut footer. isLoading only dims the pointer:
    // focused input may accept queued work, so busy words are not a blocker.
    const prefix = line.match(/^( *)(?:❯|>)(?:[ \u00a0]|$)/);
    if (!/\bClaude Code\b/.test(text) || !/\?\s+for shortcuts\b/.test(text) ||
        !border(lines[cursor.y - 1]) || !border(lines[cursor.y + 1]) ||
        !prefix || cursor.x !== prefix[1].length + 2)
      return result('starting', 'The empty Claude root composer and its surrounding controls have not been observed.');
    return result('ready', 'The Claude root composer is visible at its empty input cursor.');
  }
  if (!/\bOpenAI Codex\b/.test(text) || !/\bmodel:\s*(?!loading\b)[^\s│]+/i.test(text))
    return result('starting', 'The Codex session header has not finished loading.');
  // The decoder trims trailing blanks, including the empty composer's space.
  // Cursor coordinates still refer to terminal cells, not trimmed text length.
  const prefix = line.match(/^( *)›(?: |$)/);
  if (!prefix || cursor.x !== prefix[1].length + 2)
    return result('starting', 'The empty Codex root composer is not at the current cursor.');
  return result('ready', 'The loaded Codex root composer is visible at its empty input cursor.');
}

module.exports = { assessNativePromptReadiness };
