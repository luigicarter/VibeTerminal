'use strict';
const assert = require('node:assert/strict');
const { validateTerminalControls } = require('../../shared/terminalControls.cjs');

// Deliberately synthetic screens: verifies orchestration, not vendor CLI rendering.
const providerScenarios = {
  codex: { command: '/status', facts: 'Codex: 5-hour limit 72% left; resets 18:30. Weekly limit 41% left. Context 12% used.', requiredFacts: ['72', '41', '18:30'] },
  claude: { command: '/usage', facts: 'Claude Code: current session 23% used; resets 19:00. Current week 46% used.', requiredFacts: ['23', '46', '19:00'] },
  'claude-custom': { command: '/usage', facts: 'Custom Claude Code: current session 31% used; resets 20:15. Current week 58% used.', requiredFacts: ['31', '58', '20:15'] },
  gemini: { command: '/stats', facts: 'Gemini CLI: model requests remaining 83%; credits remaining 14. Session input tokens 1200; output tokens 350.', requiredFacts: ['83', '14', '1200', '350'] },
  kimi: { command: '/usage', appendOnly: true, facts: 'Kimi CLI: context 6400 of 128000 tokens; weekly plan usage 17%; resets Friday 21:00.', requiredFacts: ['6400', '128000', '17', '21:00'] },
  'kimi-custom': { command: '/usage', appendOnly: true, facts: 'Custom Kimi CLI: context 8100 of 128000 tokens. Plan quota unavailable for this API authentication method.', requiredFacts: ['8100', '128000'], quotaUnavailable: true },
  qwen: { command: '/stats', facts: 'Qwen Code Session statistics: 9 requests; 2300 input tokens; 710 output tokens; cost USD 0.04. Session/Activity/Efficiency statistics do not show plan quota or reset times.', requiredFacts: ['9', '2300', '710', '0.04'], quotaUnavailable: true },
  grok: { command: '/session-info', facts: 'Grok Build session info: model grok-code-fast-1; 27 messages; context 6800 tokens. Plan quota and credit balance are not shown on this screen.', requiredFacts: ['grok-code-fast-1', '27', '6800'], quotaUnavailable: true },
  cursor: { command: '/usage', facts: 'Cursor Agent activity: 37 accepted code lines on Tuesday; 12 accepted code lines on Wednesday. This activity heatmap does not show token quota, billing balance, or reset times.', requiredFacts: ['37', '12'], quotaUnavailable: true },
  opencode: { command: '/status', facts: 'OpenCode status: 2 MCP servers connected; 1 LSP server active; 3 plugins loaded. Plan quota and reset times are unavailable in this status panel.', requiredFacts: ['2', '1', '3'], quotaUnavailable: true },
};
function createPane(id, kind, cwd, mode = 'usage') {
  const scenario = kind === 'grok' && mode === 'credits-menu'
    ? { command: '/usage', facts: 'Grok Build Usage limit: 64% remaining; resets 22:45. Context usage: 3200 tokens.', requiredFacts: ['64', '22:45', '3200'] }
    : providerScenarios[kind];
  assert.ok(scenario, `No explicit synthetic inspection scenario for ${kind}`);
  const pane = { session: { id, name: id, title: id, kind, provider: kind, cwd, generation: 'fixture-1', status: 'running', turnState: 'idle' }, sequence: 1, inputRevision: 0, reads: [], actions: [], composer: '', phase: 'prompt', done: mode === 'passive' };
  pane.facts = scenario.facts; pane.command = scenario.command; pane.requiredFacts = scenario.requiredFacts; pane.quotaUnavailable = scenario.quotaUnavailable;
  const commands = [...new Set([scenario.command, ...(kind === 'codex' ? [] : ['/help']),
    ...({ claude: ['/status', '/context', '/cost'], gemini: ['/stats', '/stats session', '/stats model', '/usage'],
      kimi: ['/status'], 'kimi-custom': ['/status'], qwen: ['/status', '/usage'], grok: ['/session-info', '/context', '/usage', '/cost'],
      cursor: ['/model'], opencode: ['/models'] }[kind] || [])])];
  const aliases = { claude: '/cost', gemini: '/usage', qwen: '/usage', grok: '/cost' };
  pane.screen = () => mode === 'passive' ? 'Review completed: 2 defects found in parser.js. No changes made.' : pane.phase === 'prompt' ? `${kind} ready. ${pane.composer ? `Input: ${pane.composer} (not submitted). Press Enter to run it.` : "Empty prompt."} No task running.` : pane.phase === 'closed' ? (pane.observedUsage ? `Returned to empty prompt. Last inspected: ${pane.facts}` : 'Returned to empty prompt.') : mode === 'missing' ? 'Usage information unavailable for this authentication method. Esc closes.' : pane.phase === 'discovery' ? 'Local help: Account information is selected. Press Enter to inspect its availability; Esc closes.' : pane.phase === 'menu' ? (mode === 'credits-menu' ? 'Grok Build: Context usage 3200 tokens. Tabs: Context usage | Usage limit | Session info. Tab/Right next; Shift-Tab/Left previous; Esc closes.' : 'Account information. Tabs: Status | Usage. Press right for Usage; Esc closes.') : `${pane.facts}\n${scenario.appendOnly ? 'Informational output appended above empty prompt; no modal is open.' : 'Esc closes.'}`;
  pane.read = () => { pane.reads.push({ sequence: pane.sequence, inputRevision: pane.inputRevision, afterActions: pane.actions.length }); if (pane.phase === 'usage' && mode !== 'missing') pane.observedUsage = true; return { ok: true, id, generation: pane.session.generation, sequence: pane.sequence, observationSequence: pane.sequence, inputRevision: pane.inputRevision, text: pane.screen(), inputState: { kind: pane.composer ? 'text' : 'empty', hasText: Boolean(pane.composer) } }; };
  const originalScreen = pane.screen;
  pane.screen = () => pane.phase === 'info' ? `${kind} informational output. No quota figures on this page. Available read-only commands: ${commands.join(', ')}. Empty prompt ready.` : originalScreen();
  pane.dispatch = action => {
    assert.equal(action.targetId, id); assert.equal(action.generation, pane.session.generation);
    assert.equal(action.kind, 'terminal_interact', 'Inspection must not submit tasks or change lifecycle');
    assert.equal(action.operator, true); assert.equal(validateTerminalControls(action).ok, true);
    assert.ok(pane.reads.some(read => read.afterActions === pane.actions.length), 'A fresh read is required before every input');
    assert.equal(action.observationSequence, pane.sequence); assert.equal(action.inputRevision, pane.inputRevision);
    assert.equal(mode === 'passive', false, 'Passive output inspection must have zero effects');
    // Plan the whole synthetic transition before committing it. A fixture-level
    // unsupported control is proven unsent, not an uncertain native write.
    let phase = pane.phase, composer = pane.composer;
    try {
      if (['prompt', 'closed', 'info'].includes(phase) || scenario.appendOnly && phase === 'usage') {
        const next = composer + (action.text || '');
        assert.ok(commands.some(command => command.startsWith(next)), 'Use an observed read-only command');
        assert.ok((action.keys || []).every(key => key === 'enter'), 'Only Enter submits this prompt fixture');
        composer = next;
        if (action.submit || action.keys?.includes('enter')) {
          assert.ok(commands.includes(composer), 'Complete the observed command before submission');
          phase = mode === 'discovery' && composer === '/help' ? 'discovery'
            : composer === scenario.command || composer === aliases[kind] ? ['menu', 'credits-menu'].includes(mode) ? 'menu' : 'usage' : 'info';
          composer = '';
        } else phase = 'prompt';
      } else {
        assert.ok(!action.text || kind === 'qwen' && action.text.toLowerCase() === 'r', 'Use the observed menu controls');
        for (const key of action.keys || []) {
          if (['right', 'tab', 'left', 'shift-tab'].includes(key)) {
            assert.ok(['menu', 'usage'].includes(phase)); phase = phase === 'menu' ? 'usage' : 'menu';
          } else if (key === 'enter') { assert.equal(phase, 'discovery'); phase = 'usage'; }
          else if (key === 'escape') phase = 'closed';
          else throw Error(`Unexpected inspection key ${key}`);
        }
      }
    } catch (error) { return { ok: false, status: 'rejected', delivery: 'not-dispatched', error: error.message }; }
    pane.phase = phase; pane.composer = composer;
    pane.done = pane.phase === 'usage' || pane.phase === 'closed';
    pane.actions.push({ kind: action.kind, targetId: id, text: action.text, keys: action.keys, submit: action.submit });
    pane.sequence++; pane.inputRevision++;
    return { ok: true, status: 'written' };
  };
  return pane;
}
module.exports = { createPane, providerScenarios };
