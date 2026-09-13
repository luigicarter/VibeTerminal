'use strict';

// A startup onboarding screen is transient: it is the pane finishing its own
// launch, not the user's pending decision about the task. Such a screen keeps
// the startup wait polling (and, for a folder trust prompt in a registered Lina
// project, may be answered) instead of failing the send at once. A pending
// question, permission request or human draft remains blocked, as before.
//
// The sign-in and auth-method wordings are the ones the installed CLIs actually
// print: Codex/Open Codex ("Finish signing in via your browser", "Sign in with
// Device Code"), Cursor Agent ("Press any key to log in..."), Gemini CLI
// ("Select Auth Method" / "How would you like to authenticate"), Claude Code
// ("Select login method"). A pane parked on one of these is still launching, so
// it is reported and waited on, never typed into and never answered.
const STARTUP_SCREENS = Object.freeze([
  { prompt: 'folder-trust', pattern: /\b(?:Do you trust|Trust (?:this|the) (?:directory|folder|workspace))\b/i,
    reason: 'it is asking whether to trust the files in this folder' },
  { prompt: 'codex-sandbox', pattern: /\bSet up the Codex agent sandbox\b/i,
    reason: 'it is asking to set up the Codex agent sandbox' },
  { prompt: 'sign-in', pattern: /\bSign in to (?:Codex|ChatGPT)\b|\bFinish signing in via your browser\b|\bSign in with Device Code\b|\bPress any key to log in\b|\bSelect login method\b|\bSelect Auth Method\b|\bHow would you like to authenticate\b/i,
    reason: 'it is asking to sign in' },
  { prompt: 'startup-hooks', pattern: /\bReview startup hooks\b|\bHooks need review\b/i, reason: 'it is asking to review its startup hooks' },
  // Claude Code asks this whenever the project's CLAUDE.md imports a file from
  // outside the pane's own folder, which every Lina project with a shared guide
  // does. Observed from Claude Code 2.1.270 on 2026-09-13.
  { prompt: 'external-imports', pattern: /\bAllow external CLAUDE\.md file imports\b/i,
    reason: 'it is asking whether to allow imports from outside this folder' },
  // A modal offering to update the CLI or its model list, seen from Qwen Code on
  // 2026-09-13 ("Built-in Provider Update", options "1. Update all", "2. Skip
  // this version", "3. Remind me later"). Only a numbered menu option counts: the
  // plain "update available" banner Grok and Qwen print beside a ready composer
  // is not a screen anyone has to answer.
  { prompt: 'update-offer', pattern: /^[^\S\n]*[│┃|]?[^\S\n]*[❯>›*]?[^\S\n]*\d[.)][^\S\n]*(?:Skip this version|Remind me later|Update all)\b/im,
    reason: 'it is offering to update itself' },
  { prompt: 'selection', pattern: /\b(?:Select|Choose) (?:a |your )?(?:theme|model|login|account)\b/i,
    reason: 'it is asking to choose a theme, model or login' },
  { prompt: 'credentials', pattern: /\bEnter (?:your )?(?:API key|authentication code)\b/i,
    reason: 'it is asking for an API key or authentication code' },
]);
// The affirmative option must already be the highlighted default. A screen whose
// pointer rests anywhere else is never answered automatically.
const AFFIRMATIVE_DEFAULT = /^[ \t]*[❯>›*][ \t]*1[.)][ \t]*Yes\b/im;
function startupScreen(text) {
  const found = STARTUP_SCREENS.find(screen => screen.pattern.test(text));
  return found && { prompt: found.prompt, reason: found.reason,
    affirmativeDefault: found.prompt === 'folder-trust' && AFFIRMATIVE_DEFAULT.test(text) };
}

// Which composer form each launcher kind paints. Every form below is grounded in
// a screen captured from the CLI installed on this machine on 2026-09-13 and
// retained as a fixture in scripts/backend/fixtures/provider-startup-screens/,
// except the three noted as inferred:
//  - open-codex and codex-web run the Codex TUI (the same binary family and the
//    same header/composer); only their sign-in and startup screens were captured
//    here, so their composer form is inferred, not recorded.
//  - gemini is not installed on this machine. Qwen Code is a Gemini CLI fork and
//    paints the same ruled composer, so gemini reuses that form UNVERIFIED.
// A kind absent from this map has no verified recognizer: it reports
// 'unsupported', which the startup wait treats as "type as before", never as a
// failure. Cursor Agent is deliberately absent — only its login screen was
// captured, never its composer.
const COMPOSER_FORMS = new Map([
  ['terminal', 'shell'],
  ['codex', 'codex'], ['open-codex', 'codex'], ['codex-web', 'codex'],
  ['claude', 'claude'], ['claude-custom', 'claude'],
  ['grok', 'grok'],
  ['kimi', 'kimi'], ['kimi-custom', 'kimi'],
  ['qwen', 'qwen'], ['gemini', 'qwen'],
  ['opencode', 'opencode'],
]);
// Kimi Code hides the terminal cursor while its composer is focused and ready
// (verified in both the published 0.27.0 and the bundled 0.29.0 captures), so
// for that form the composer box and the cursor column are the evidence. Every
// other form still requires a visible cursor.
const HIDDEN_CURSOR_FORMS = new Set(['kimi']);

// A plain horizontal rule above and below the input row (Claude Code, Qwen Code,
// Gemini CLI).
const rule = value => /^[╭┌╰└]?[─━-]{3,}[╮┐╯┘]?$/.test((value || '').trim());
// A boxed composer's own frame. The label a provider prints inside the closing
// rule ("Grok 4.6 (high)") is part of the frame, not content.
const boxTop = value => /^\s*╭[─━]{3,}[^╮]*╮\s*$/.test(value || '');
const boxBottom = value => /^\s*╰[─━]{3,}[^╯]*╯\s*$/.test(value || '');
// Pointer + one separator cell + the input cursor. A dim placeholder may follow
// the cursor; anything the user has typed would move the cursor past it.
function ruledPointer(lines, cursor, pointers) {
  const match = new RegExp(`^( *)(?:${pointers})(?:[ \\u00a0]|$)`).exec(lines[cursor.y] || '');
  return Boolean(match) && cursor.x === match[1].length + 2 && rule(lines[cursor.y - 1]) && rule(lines[cursor.y + 1]);
}
function boxedPointer(lines, cursor) {
  const match = /^(\s*│[  ])>(?:[  ]|$)/.exec(lines[cursor.y] || '');
  return Boolean(match) && cursor.x === match[1].length + 2 && boxTop(lines[cursor.y - 1]) && boxBottom(lines[cursor.y + 1]);
}
// OpenCode draws a left rail instead of a box: three or more '┃' rows in one
// column, a two-cell gutter before the text, and a '╹▀▀▀' row closing it.
function railComposer(lines, cursor) {
  const rail = row => /^(\s*)┃/.exec(lines[row] || '');
  const here = rail(cursor.y);
  if (!here) return false;
  const column = here[1].length;
  const aligned = row => rail(row)?.[1].length === column;
  const closed = lines.slice(cursor.y + 1, cursor.y + 7).some(row => new RegExp(`^ {${column}}╹[▀─]{3,}`).test(row || ''));
  return cursor.x === column + 3 && aligned(cursor.y - 1) && aligned(cursor.y + 1) && closed;
}

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
  const form = COMPOSER_FORMS.get(kind);
  const text = observation.text;
  // Agent onboarding prose can also occur in a valid shell directory name or
  // prior command output. Shell readiness is established by its prompt below.
  // Every other kind is checked for a startup screen first, including the kinds
  // with no composer recognizer: a pane parked on a login screen must never be
  // typed into merely because nothing else recognizes its screen.
  const startup = form !== 'shell' ? startupScreen(text) : undefined;
  if (startup) return { ...result('transient', `The terminal is showing a startup screen: ${startup.reason}.`),
    prompt: startup.prompt, detail: startup.reason, affirmativeDefault: startup.affirmativeDefault };
  if (form !== 'shell' && /\bmodel:\s*loading\b|\bInput disabled\b|\bShutting down\b|\bConnecting to (?:the )?(?:server|agent)\b/i.test(text))
    return result('starting', 'The native composer is still loading or disabled.');
  if (!form) return result('unsupported', 'Startup composer recognition is unavailable for this native provider.');
  const cursor = observation.cursor;
  if ((observation.cursorVisible !== true && !HIDDEN_CURSOR_FORMS.has(form)) ||
      !Number.isSafeInteger(cursor?.x) || !Number.isSafeInteger(cursor?.y) ||
      cursor.x < 0 || cursor.y < 0 || !Number.isSafeInteger(observation.cols) || !Number.isSafeInteger(observation.rows) ||
      cursor.x >= observation.cols || cursor.y >= observation.rows)
    return result('starting', 'A visible native input cursor has not been observed.');
  const lines = text.split('\n');
  const line = lines[cursor.y];
  if (form === 'shell') {
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
  if (form === 'claude') {
    // Onboarding forms are classified as transient above; what remains here is
    // an actual decision the user owns, which no startup wait may sit through.
    if (/\b(?:Do you want to proceed|Allow Claude to)\b/i.test(text))
      return result('blocked', 'Claude is displaying a modal or a permission request.');
    // Claude's main input uses pointer + NBSP (ASCII > fallback) between two
    // horizontal rules. The shortcut footer is optional evidence: Claude Code
    // 2.1.269 dropped "? for shortcuts" for "auto mode on (shift+tab to cycle)
    // · ← for agents", and 2.1.270 prints no shortcut hint at all in some
    // layouts. isLoading only dims the pointer: focused input may accept queued
    // work, so busy words are not a blocker.
    if (!/\bClaude Code\b/.test(text) || !ruledPointer(lines, cursor, '❯|>'))
      return result('starting', 'The empty Claude root composer and its surrounding controls have not been observed.');
    return result('ready', 'The Claude root composer is visible at its empty input cursor.');
  }
  if (form === 'qwen') {
    // Qwen Code (and the Gemini CLI it forks) place '>' plus a dim placeholder
    // between two rules. The version banner is not required: it scrolls away.
    if (!ruledPointer(lines, cursor, '>'))
      return result('starting', 'The empty Qwen root composer and its surrounding rules have not been observed.');
    return result('ready', 'The Qwen root composer is visible at its empty input cursor.');
  }
  if (form === 'grok') {
    if (!/\bGrok\b/.test(text) || !boxedPointer(lines, cursor))
      return result('starting', 'The empty Grok Build composer box has not been observed.');
    return result('ready', 'The Grok Build composer box is visible at its empty input cursor.');
  }
  if (form === 'kimi') {
    if (!boxedPointer(lines, cursor))
      return result('starting', 'The empty Kimi composer box has not been observed.');
    return result('ready', 'The Kimi composer box is visible at its empty input cursor.');
  }
  if (form === 'opencode') {
    if (!railComposer(lines, cursor))
      return result('starting', 'The empty OpenCode composer rail has not been observed.');
    return result('ready', 'The OpenCode composer is visible at its empty input cursor.');
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

module.exports = { assessNativePromptReadiness, startupScreen, COMPOSER_FORMS };
