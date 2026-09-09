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
  const pane = { session: { id, name: id, title: id, kind, provider: kind, cwd, generation: 'fixture-1', status: 'running', turnState: 'idle' }, sequence: 1, inputRevision: 0, reads: [], actions: [], phase: 'prompt', done: mode === 'passive' };
  pane.facts = scenario.facts; pane.command = scenario.command; pane.requiredFacts = scenario.requiredFacts; pane.quotaUnavailable = scenario.quotaUnavailable;
  pane.screen = () => mode === 'passive' ? 'Review completed: 2 defects found in parser.js. No changes made.' : pane.phase === 'prompt' ? `${kind} ready. Empty prompt. No task running.` : pane.phase === 'closed' ? (pane.observedUsage ? `Returned to empty prompt. Last inspected: ${pane.facts}` : 'Returned to empty prompt.') : mode === 'missing' ? 'Usage information unavailable for this authentication method. Esc closes.' : pane.phase === 'discovery' ? 'Local help: Account information is selected. Press Enter to inspect its availability; Esc closes.' : pane.phase === 'menu' ? (mode === 'credits-menu' ? 'Grok Build: Context usage 3200 tokens. Tabs: Context usage | Usage limit | Session info. Tab/Right next; Shift-Tab/Left previous; Esc closes.' : 'Account information. Tabs: Status | Usage. Press right for Usage; Esc closes.') : `${pane.facts}\n${scenario.appendOnly ? 'Informational output appended above empty prompt; no modal is open.' : 'Esc closes.'}`;
  pane.read = () => { pane.reads.push({ sequence: pane.sequence, inputRevision: pane.inputRevision, afterActions: pane.actions.length }); if (pane.phase === 'usage' && mode !== 'missing') pane.observedUsage = true; return { ok: true, id, generation: pane.session.generation, sequence: pane.sequence, observationSequence: pane.sequence, inputRevision: pane.inputRevision, text: pane.screen(), inputState: { kind: 'empty', hasText: false } }; };
  pane.dispatch = action => {
    assert.equal(action.targetId, id); assert.equal(action.generation, pane.session.generation);
    assert.equal(action.kind, 'terminal_interact', 'Inspection must not submit tasks or change lifecycle');
    assert.equal(action.operator, true); assert.equal(validateTerminalControls(action).ok, true);
    assert.ok(pane.reads.some(read => read.afterActions === pane.actions.length), 'A fresh read is required before every input');
    assert.equal(action.observationSequence, pane.sequence); assert.equal(action.inputRevision, pane.inputRevision);
    assert.equal(mode === 'passive', false, 'Passive output inspection must have zero effects');
    if (pane.phase === 'prompt') {
      assert.equal(action.text, mode === 'discovery' ? '/help' : scenario.command);
      assert.ok(action.submit || action.keys?.includes('enter'));
      pane.phase = ['menu', 'credits-menu'].includes(mode) ? 'menu' : mode === 'discovery' ? 'discovery' : 'usage';
    } else {
      assert.ok(!action.text, 'Informational navigation must not enter arbitrary text');
      assert.equal(Boolean(scenario.appendOnly), false, 'Append-only informational output has no modal to navigate');
      for (const key of action.keys || []) {
        if (key === 'right' || key === 'tab') { assert.equal(pane.phase, 'menu'); pane.phase = 'usage'; }
        else if (key === 'enter') { assert.equal(pane.phase, 'discovery'); pane.phase = 'usage'; }
        else if (key === 'escape') pane.phase = 'closed';
        else throw Error(`Unexpected inspection key ${key}`);
      }
    }
    pane.done = pane.phase === 'usage' || pane.phase === 'closed';
    pane.actions.push({ kind: action.kind, targetId: id, text: action.text, keys: action.keys, submit: action.submit });
    pane.sequence++; pane.inputRevision++;
    return { ok: true, status: 'written' };
  };
  return pane;
}
module.exports = { createPane, providerScenarios };
