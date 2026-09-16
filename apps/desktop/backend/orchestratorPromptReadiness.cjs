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
//
// Three shapes are recorded from the CLIs installed here on 2026-09-13, and the
// pointer glyph and the wording both vary: Codex 0.154 prints "❯ 1. Yes,
// continue", Gemini 0.59 prints "● 1. Trust folder (name)", and Kimi Code 0.42
// prints "❯ Trust this folder" with no number at all. What does not vary is the
// rule: the pointer must rest on the FIRST option, and that option must be the
// affirmative one. Claude's own trust screen rests its pointer on "No, exit",
// which is why it is reported and waited through rather than answered.
const AFFIRMATIVE_DEFAULT = /^[ \t]*[❯>›*●][ \t]*(?:1[.)][ \t]*)?(?:Yes\b|Trust (?:this |the )?folder\b)/im;
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
// The sentence each verdict reads out. The banner each CLI prints once used to
// be an additional gate here ("OpenAI Codex", "Claude Code", "Grok"); it is gone.
// A banner is printed at the top of the session and SCROLLS OFF: in a pane at
// the board's own default tile size (69x10) it is already out of the viewport by
// the time the composer is painted, so requiring it meant a small pane refused
// its first prompt for the whole life of that pane, reporting "the empty Codex
// root composer is not at the current cursor" about a composer that was sitting
// right there. Claude's footer went the same way on 2.1.269/2.1.270, and Qwen's
// version banner scrolls away too.
//
// What is left is the evidence that does not scroll: the composer form itself —
// the rules, box or rail around the input row, the pointer, and the caret in the
// first input cell — plus every startup-screen check above it, which still
// decides sign-in, folder trust, updates and loading composers before this point
// is reached.
const LAUNCH_FORMS = new Map([
  ['shell', { visible: 'The standard PowerShell input prompt is visible at its empty cursor.',
    missing: 'The standard PowerShell input prompt has not been observed.' }],
  ['claude', { visible: 'The Claude root composer is visible at its empty input cursor.',
    missing: 'The empty Claude root composer and its surrounding controls have not been observed.' }],
  ['qwen', { visible: 'The Qwen root composer is visible at its empty input cursor.',
    missing: 'The empty Qwen root composer and its surrounding rules have not been observed.' }],
  ['grok', { visible: 'The Grok Build composer box is visible at its empty input cursor.',
    missing: 'The empty Grok Build composer box has not been observed.' }],
  ['kimi', { visible: 'The Kimi composer box is visible at its empty input cursor.',
    missing: 'The empty Kimi composer box has not been observed.' }],
  ['opencode', { visible: 'The OpenCode composer is visible at its empty input cursor.',
    missing: 'The empty OpenCode composer rail has not been observed.' }],
  ['codex', { visible: 'The loaded Codex root composer is visible at its empty input cursor.',
    missing: 'The empty Codex root composer is not at the current cursor.' }],
]);
// Kimi Code hides the terminal cursor while its composer is focused and ready
// (verified in both the published and the bundled captures, re-recorded on
// 0.42.0 after the vendored fork bundle moved 0.29.0 -> 0.42.0), so
// for that form the composer box and the cursor column are the evidence. Every
// other form still requires a visible cursor.
//
// Claude Code joined it on 2.1.270 when it is authenticated through a custom
// endpoint (ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN — what the app calls Open
// Claude Code, and what a claude-custom pane always runs): the composer is
// painted, the caret sits in its first input cell, and the cursor is simply
// never shown. The recorded screen is claude-hidden-cursor-100x30; its
// subscription-authenticated sibling claude-120x36 still shows the cursor, and
// both must read ready. Requiring the cursor meant no first prompt could ever
// be typed into an Open Claude Code pane. The rules above and below the row,
// the pointer and the caret column stay the evidence, exactly as for kimi.
const HIDDEN_CURSOR_FORMS = new Set(['kimi', 'claude']);

// Codex 0.154 paints an ambient "sparkle" of single-dot braille cells around its
// EMPTY composer, several frames a second, for as long as the pane is idle.
// Those cells land on the composer rows and — in 35 of the 92 frames of the
// recorded idle stream — in the one separator cell between the '›' pointer and
// the input cursor, turning the composer prefix '› ' into '›⠁' and back. The
// eight glyphs below are that sparkle's whole alphabet, so they are normalised
// to a space before any composer or input-surface comparison. No other braille
// is touched: Codex's startup spinner uses ⠙⠹⠸⠼⠴⠦⠧⠇ and never occupies a
// composer cell, and text the user typed moves the cursor past it regardless.
const AMBIENT_DECORATION = /[⠁⠂⠄⠈⠐⠠⡀⢀]/g;
const withoutDecoration = value => typeof value === 'string' ? value.replace(AMBIENT_DECORATION, ' ') : value;

// A plain horizontal rule above and below the input row (Claude Code, Qwen Code,
// Gemini CLI).
const rule = value => /^[╭┌╰└]?[─━-]{3,}[╮┐╯┘]?$/.test((value || '').trim());
// A boxed composer's own frame. The label a provider prints inside the closing
// rule ("Grok 4.6 (high)") is part of the frame, not content.
const boxTop = value => /^\s*╭[─━]{3,}[^╮]*╮\s*$/.test(value || '');
const boxBottom = value => /^\s*╰[─━]{3,}[^╯]*╯\s*$/.test(value || '');
// Pointer + one separator cell + the input cursor. A dim placeholder may follow
// the cursor; anything the user has typed would move the cursor past it.
function ruledPointer(row, cursor, pointers) {
  const match = new RegExp(`^( *)(?:${pointers})(?:[ \\u00a0]|$)`).exec(row(cursor.y) || '');
  return Boolean(match) && cursor.x === match[1].length + 2 && rule(row(cursor.y - 1)) && rule(row(cursor.y + 1));
}
function boxedPointer(row, cursor) {
  const match = /^(\s*│[  ])>(?:[  ]|$)/.exec(row(cursor.y) || '');
  return Boolean(match) && cursor.x === match[1].length + 2 && boxTop(row(cursor.y - 1)) && boxBottom(row(cursor.y + 1));
}
// OpenCode draws a left rail instead of a box: three or more '┃' rows in one
// column, a two-cell gutter before the text, and a '╹▀▀▀' row closing it.
function railComposer(row, cursor) {
  const rail = y => /^(\s*)┃/.exec(row(y) || '');
  const here = rail(cursor.y);
  if (!here) return false;
  const column = here[1].length;
  const aligned = y => rail(y)?.[1].length === column;
  let closed = false;
  for (let y = cursor.y + 1; y <= cursor.y + 6 && !closed; y++) closed = new RegExp(`^ {${column}}╹[▀─]{3,}`).test(row(y) || '');
  return cursor.x === column + 3 && aligned(cursor.y - 1) && aligned(cursor.y + 1) && closed;
}
// The rows a composer recognizer may index. `cursorContext` is the decoder's own
// unclipped window around the cursor (terminalObservation.read); the screen text
// a caller passes may have been clipped to a character budget, which silently
// shifts the rows these checks depend on. Fall back to the text when a caller
// supplies an observation without that window.
function rowReader(observation) {
  const context = observation.cursorContext;
  const rows = Array.isArray(context?.rows) ? context.rows : undefined;
  const start = context?.startRow;
  if (rows && Number.isSafeInteger(start) && start >= 0)
    return y => (y >= start && y < start + rows.length ? rows[y - start] : undefined);
  const lines = typeof observation.text === 'string' ? observation.text.split('\n') : [];
  return y => lines[y];
}

// The placeholder hint each form prints to the RIGHT of its caret while its
// composer holds nothing. Recorded from the CLI installed on this machine on
// 2026-09-13 and retained in scripts/backend/fixtures/provider-startup-screens.
// Kimi and Grok print none: their box is blank to the frame. Anything else to
// the right of the caret is text the user typed and walked the caret back
// through, so it is a draft and the composer is NOT empty.
//
// Codex rotates this copy between starts (0.144 printed 'Run /review on my
// current changes'; 0.154 prints the line below). An unrecognized hint therefore
// reads as a draft — which refuses a send rather than typing over one, the safe
// direction — so this list is evidence, and every entry has a capture behind it.
const COMPOSER_PLACEHOLDERS = new Map([
  ['codex', /^Ask Codex to do anything$/],
  ['claude', /^Try "[^"]*"$/],
  ['qwen', /^Type your message or @path\/to\/file$/],
  ['opencode', /^Ask anything\.\.\.(?:\s+"[^"]*")?$/],
]);
// What stands right of the caret, once the ambient sparkle is normalised away
// and the composer's own right border and padding are dropped. This text decides
// one thing only — placeholder or draft — and never enters the input-surface
// fingerprint, because that is where a repaint would flap.
function rightOfCursor(row, cursor) {
  return withoutDecoration(String(row ?? '').slice(cursor.x)).replace(/[│┃]\s*$/, '').trim();
}

// Whether the pane is showing its own empty input cell right now. This is the
// structural half of assessNativePromptReadiness — the same cursor and composer
// frame evidence — WITHOUT the launch-time banner gates ('OpenAI Codex',
// 'Claude Code', 'Grok', the model line), which scroll off in an established
// session and say nothing about whether the user is part-way through typing.
//
// Two verdicts, because two questions are being asked:
//   atComposerCell — the form's composer is painted and the caret sits in its
//     first input cell. This is LAUNCH readiness, and it must tolerate whatever
//     hint copy the provider happens to rotate in.
//   empty — that, and nothing but a recognized placeholder to the right of the
//     caret. This is INPUT readiness: it is what overrides the keystroke latch
//     and what the freshness fence compares, so a draft the user walked the
//     caret back through still reads as occupied.
// Both are undefined — never false — for a kind with no verified recognizer, so
// a caller can tell "the composer is occupied" from "nothing is known".
function recognizeEmptyComposer(form, observation) {
  const verdict = (atComposerCell, reason, placeholder) => ({
    atComposerCell, placeholder, reason, ...(form ? { form } : {}),
    empty: atComposerCell === undefined ? undefined : Boolean(atComposerCell && placeholder !== false) });
  if (!form) return verdict(undefined, 'Composer recognition is unavailable for this native provider.');
  const o = observation && typeof observation === 'object' ? observation : {};
  const cursor = o.cursor;
  if ((o.cursorVisible !== true && !HIDDEN_CURSOR_FORMS.has(form)) ||
      !Number.isSafeInteger(cursor?.x) || !Number.isSafeInteger(cursor?.y) || cursor.x < 0 || cursor.y < 0 ||
      !Number.isSafeInteger(o.cols) || !Number.isSafeInteger(o.rows) || cursor.x >= o.cols || cursor.y >= o.rows)
    return verdict(false, 'A visible native input cursor has not been observed.');
  const row = rowReader(o);
  if (typeof row(cursor.y) !== 'string') return verdict(false, 'The current input cursor is outside the decoded screen.');
  // A shell prompt's own recognizer already proves the whole logical line ends
  // at the caret, so there is nothing to its right to classify.
  const rest = form === 'shell' ? '' : rightOfCursor(row(cursor.y), cursor);
  const placeholder = rest === '' || Boolean(COMPOSER_PLACEHOLDERS.get(form)?.test(rest));
  if (form === 'shell') {
    // An empty standard PowerShell prompt ends at the cursor. Customized shell
    // prompts need their own verified recognizer; shell output is not readiness.
    // Use only decoder-proven soft wraps. Joining arbitrary display rows could
    // mistake old shell output for the current prompt. beforeCursor is assembled
    // by terminal cells so wide Unicode path characters cannot shift this check.
    const logical = o.cursorLine;
    const validLogical = logical && Number.isSafeInteger(logical.startRow) && logical.startRow >= 0 && logical.startRow <= cursor.y &&
      typeof logical.text === 'string' && typeof logical.beforeCursor === 'string' &&
      !/[\r\n]/.test(logical.text + logical.beforeCursor);
    const promptLine = validLogical ? logical.text.trimEnd() : row(cursor.y).trimEnd();
    const prompt = /^PS (?:[A-Za-z]:[\\/]|\\\\|\/)[^>\r\n]*>$/.test(promptLine);
    const atEmptyCursor = validLogical
      ? logical.beforeCursor === promptLine || logical.beforeCursor === promptLine + ' '
      : cursor.x >= promptLine.length && cursor.x <= promptLine.length + 1;
    return prompt && atEmptyCursor
      ? verdict(true, 'The standard PowerShell input prompt is visible at its empty cursor.', true)
      : verdict(false, 'The standard PowerShell input prompt has not been observed.');
  }
  const draft = 'The composer holds text the caret was moved back through.';
  if (form === 'claude') return ruledPointer(row, cursor, '❯|>')
    ? verdict(true, placeholder ? 'The Claude root composer is at its empty input cursor.' : draft, placeholder)
    : verdict(false, 'The empty Claude root composer and its surrounding rules have not been observed.');
  if (form === 'qwen') return ruledPointer(row, cursor, '>')
    ? verdict(true, placeholder ? 'The Qwen root composer is at its empty input cursor.' : draft, placeholder)
    : verdict(false, 'The empty Qwen root composer and its surrounding rules have not been observed.');
  if (form === 'grok') return boxedPointer(row, cursor)
    ? verdict(true, placeholder ? 'The Grok Build composer box is at its empty input cursor.' : draft, placeholder)
    : verdict(false, 'The empty Grok Build composer box has not been observed.');
  if (form === 'kimi') return boxedPointer(row, cursor)
    ? verdict(true, placeholder ? 'The Kimi composer box is at its empty input cursor.' : draft, placeholder)
    : verdict(false, 'The empty Kimi composer box has not been observed.');
  if (form === 'opencode') return railComposer(row, cursor)
    ? verdict(true, placeholder ? 'The OpenCode composer rail is at its empty input cursor.' : draft, placeholder)
    : verdict(false, 'The empty OpenCode composer rail has not been observed.');
  // Codex: pointer, one separator cell, then the cursor. The decoder trims
  // trailing blanks, including the empty composer's space; cursor coordinates
  // still refer to terminal cells, not trimmed text length. The sparkle may own
  // the separator cell, so the row is read without its decoration.
  const prefix = withoutDecoration(row(cursor.y)).match(/^( *)›(?: |$)/);
  return prefix && cursor.x === prefix[1].length + 2
    ? verdict(true, placeholder ? 'The Codex root composer is at its empty input cursor.' : draft, placeholder)
    : verdict(false, 'The empty Codex root composer is not at the current cursor.');
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
  const kind = session.provider || session.kind;
  const form = COMPOSER_FORMS.get(kind);
  if (session.pendingInput || session.interactionInputPending || session.heldMouseButton || observation.interactionInputPending)
    return result('blocked', 'The terminal may contain pending input; no startup prompt was sent.');
  // The keystroke latch is a conservative marker set by any key that is not
  // Enter or Ctrl-C — an arrow, Escape, or typing then deleting all of it. It is
  // never cleared by output, so on its own it locks a pane out for the rest of
  // its life. A composer the decoder can see is empty is the evidence that
  // overrides it; anything the recognizer cannot vouch for still blocks.
  if ((session.manualInputPending || observation.manualInputPending) &&
      recognizeEmptyComposer(form, observation).empty !== true)
    return result('blocked', 'The terminal may contain pending input; no startup prompt was sent.');
  if (!Number.isSafeInteger(observation.sequence) || observation.sequence <= 0 ||
      !Number.isSafeInteger(observation.inputRevision) || observation.inputRevision < 0 ||
      typeof observation.text !== 'string' || !observation.text.trim())
    return result('starting', 'The terminal has not displayed an input surface yet.');
  if (observation.screenTruncated === true)
    return result('starting', 'The current terminal screen is clipped; a complete screen is required.');
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
  // The composer itself is recognized in one place, shared with the input-surface
  // fence. What stays here is the launch banner each CLI prints once — the thing
  // an established session scrolls away, which is why the fence does not use it —
  // and the wording for each verdict.
  if (form === 'claude' && /\b(?:Do you want to proceed|Allow Claude to)\b/i.test(text))
    return result('blocked', 'Claude is displaying a modal or a permission request.');
  // Codex's session header names the model it loaded. A header that is ON SCREEN
  // but has not filled that slot in is a session still starting; a header that
  // has scrolled off the top of a small pane says nothing either way, and is not
  // allowed to hold the composer back.
  if (form === 'codex' && /\bmodel:/i.test(text) && !/\bmodel:[^\S\n]*(?!loading\b)[^\s\u2502]+/i.test(text))
    return result('starting', 'The Codex session header has not finished loading.');
  const launch = LAUNCH_FORMS.get(form);
  return recognizeEmptyComposer(form, observation).atComposerCell === true
    ? result('ready', launch.visible) : result('starting', launch.missing);
}

module.exports = { assessNativePromptReadiness, startupScreen, recognizeEmptyComposer, withoutDecoration,
  COMPOSER_FORMS, HIDDEN_CURSOR_FORMS };
