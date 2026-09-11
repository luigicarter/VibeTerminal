'use strict';

const supported = new Set(Object.keys(require('../shared/providerCapabilities.json')));
supported.add('claude-custom');

const TERMINAL_NAVIGATION_POLICY = 'For coding-terminal state or usage questions, inspect the requested live terminal and its terminalNavigationGuide first. Read the current screen before input; enter slash commands only at an observed ready composer, and use native keys to navigate an already visible inspection menu. Read again to verify the displayed result. Do not interrupt active work or overwrite pending input merely to inspect usage. Commands vary by installed version; current help and observed menus win. Never select purchase, reset, login, or configuration-changing actions as part of inspection. Report only observed figures, distinguishing used versus remaining, context/token usage versus plan/rate limits, and window/reset time. Context fullness or API spend does not establish subscription quota. If the terminal cannot expose the requested data, explain the concrete limitation before offering an external account/billing page as a fallback.';

// Evidence and version boundaries: docs/orchestrator-terminal-navigation.md.
const profiles = Object.freeze({
  codex: 'Codex native CLI: /status first for session/account/configuration, token usage, and available rate-limit windows. Discover commands by typing / without submission and reading completions; do not assume /help exists. /usage can open a menu with browser/reset actions; it is not the primary quota inspection command. Follow visible dismissal hints only when a menu is open; do not use exit commands. Availability varies by version.',
  claude: 'Claude Code native CLI: /help discovers commands; /usage for available plan limits/cost; /status for session/account/configuration; /context for context usage. Newer versions alias /cost to /usage; older versions may show token cost separately. Read displayed tab/navigation/dismissal hints before keys; closing a menu is different from exiting the CLI. Availability varies by version and authentication.',
  cursor: 'Cursor native CLI: /help [command] discovers commands. Prefer the visible screen or /model picker for model inspection and /usage for activity. /about shows version/model/system/account but copies to clipboard: avoid this side effect for pure inspection. /usage shows AI activity/accepted-code-line analytics, not subscription quota or token cost. /model and /config are editable; do not select changes. In the observed usage pager Escape or q closes it; /quit and /exit terminate the CLI. Installed help wins over version-dependent hints.',
  gemini: 'Gemini native CLI: /help or /? discovers commands; /about shows version. /stats first (or /stats session) refreshes available quota/credits and session/account/model statistics; /stats model gives token/model detail, which may be empty before API calls; /stats tools gives tool metrics. /usage aliases /stats in newer versions. /settings and /model are editable configuration menus. In visible dialogs use arrows to browse, Escape to dismiss; Enter may change settings. Quota depends on authentication/version.',
  opencode: 'OpenCode native TUI: /help or Ctrl+P discovers commands; /status (default Ctrl+X then S) shows MCP/LSP/formatter/plugin health, not plan quota. /models opens the model picker; inspect without changing selection. Shell command opencode stats shows historical token/cost totals, not subscription limits; it is not a TUI /stats command and must not be typed as chat. Escape dismisses an open modal but can interrupt work outside it; /exit terminates the CLI. Follow installed palette/keybindings.',
  kimi: 'Kimi native CLI: /help discovers commands; /status shows version/model/runtime configuration; /usage shows tokens/context and available account quota, with OAuth authentication required for quota data. Custom API-key providers may have no quota to report. Verified status/usage output appends to the transcript without a dismissal step; read it and remain at the composer. Do not send Escape or exit commands merely to close printed output. Installed help/output wins over version-dependent hints.',
  qwen: 'Qwen native CLI: /help discovers commands; /status (alias /about) shows model/authentication/version. /stats (alias /usage) opens token/cost statistics, not subscription quota. In the observed dashboard Tab/Shift+Tab switches views, R changes the displayed date range, and Escape closes it. /stats export writes files; /config can toggle booleans even without an explicit value, so neither is a read-only inspection command. Installed help/output wins over version-dependent hints.',
  grok: 'Grok Build native CLI: /help discovers commands and keyboard shortcuts. /usage (alias /cost) opens a modal with context, usage-limit and session-info tabs; Tab/Right advances, Shift+Tab/Left goes back, Escape closes the visible modal. /session-info shows model/runtime/context; /context inspects context. /usage manage opens billing and is not inspection. External authentication may hide quota; report only displayed limits. Availability and bindings vary by installed version.',
});

// Only application-owned strings enter the guide. Titles, transcripts, profile
// names, and arbitrary provider strings must never become navigation authority.
function terminalNavigationGuide(session = {}) {
  if (session.kind === 'codex-web' || session.provider === 'codex-web') {
    return 'Codex Web terminal: inspect the visible screen/help to discover supported controls. Do not assume native Codex CLI commands or account limits; browser-backed session navigation is provider-specific.';
  }
  if (session.fusion || session.openFusion || ['fusion', 'openfusion'].includes(session.kind) || ['fusion', 'openfusion'].includes(session.provider)) {
    return 'Structured Fusion/Open Fusion pane: inspect structured state/history; native coding CLI slash commands and terminal menu navigation do not apply.';
  }
  if (session.kind === 'terminal' || session.provider === 'terminal') {
    return 'Plain shell: inspect available output/state; do not send coding CLI slash commands to the shell.';
  }
  const provider = session.kind || session.provider;
  const profile = provider === 'claude-custom' ? 'claude' : provider === 'kimi-custom' ? 'kimi' : provider === 'open-codex' ? 'codex' : provider;
  if (Object.hasOwn(profiles, profile)) return profiles[profile];
  if (supported.has(provider)) {
    return 'Supported native coding CLI: inspect the visible screen/help/menu to discover state and usage commands. Do not assume another provider\'s slash-command grammar; use only observed read-only options and verify their output.';
  }
  return 'Unidentified terminal: inspect output and establish the running CLI before sending navigation commands; do not guess slash-command grammar.';
}

module.exports = { terminalNavigationGuide, TERMINAL_NAVIGATION_POLICY };
