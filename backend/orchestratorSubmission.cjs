'use strict';
const { normalizeTerminalKeys } = require('../shared/terminalControls.cjs');

// Operator authority is not stamped on model proposals until claim. Callers
// checking a proposed operator effect may supply it explicitly; transport and
// task tracking otherwise require the actual application-owned operator flag.
function isTaskSubmission(action, { operator = action?.operator === true } = {}) {
  if (action?.kind === 'send_prompt') return true;
  if (!operator || action?.kind !== 'terminal_interact' || action.inputPurpose !== 'task') return false;
  const keys = normalizeTerminalKeys(action.keys);
  return action.submit === true || Array.isArray(keys) && keys.some(key => ['enter', 'ctrl-m', 'ctrl-j'].includes(key))
    || ['click', 'up'].includes(action.mouse?.action);
}

module.exports = { isTaskSubmission };
