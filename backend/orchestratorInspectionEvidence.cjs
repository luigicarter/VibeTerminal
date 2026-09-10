'use strict';
const { boundedString } = require('./orchestratorBudget.cjs');
const identity = target => JSON.stringify([target.id, target.generation, target.launchToken, target.kind || target.provider,
  target.agentPid, target.conversationId || target.conversation?.id || target.threadRef?.id]);
// Bounded, request-local source excerpts. Inspection reports quote observed
// content instead of trusting a model's completion prose or invented figures.
function createInspectionEvidence() {
  const pages = []; let sequence = 0;
  return {
    observe(target, observation) {
      if (!target || observation?.ok === false || observation?.exited || observation?.id !== undefined && observation.id !== target.id ||
          observation?.generation !== undefined && observation.generation !== target.generation || typeof observation?.text !== 'string' || !observation.text.trim()) return;
      const key = identity(target), text = boundedString(observation.text, 3000, true).trim();
      if (pages.at(-1)?.key === key && pages.at(-1).text === text) return;
      pages.push({ id: `inspection-${++sequence}`, key, text });
      if (pages.length > 32) pages.shift();
    },
    pages(target) { return target ? pages.filter(page => page.key === identity(target)).slice(-6).map(({ id, text }) => ({ id, text })) : []; },
    report(target, proposed, evidenceIds) {
      if (!target) throw new Error('The inspected terminal is no longer available.');
      const sources = pages.filter(page => page.key === identity(target) && (!evidenceIds || evidenceIds.includes(page.id)));
      if (!sources.length) throw new Error('No current inspection output was observed for this terminal. Read it before reporting findings.');
      const quote = typeof proposed === 'string' ? proposed.trim() : '';
      if (quote && sources.some(page => page.text.includes(quote))) return quote;
      return `Observed terminal output:\n${(evidenceIds ? sources.map(page => page.text).join('\n\n') : sources.at(-1).text).slice(0, 8000)}`;
    },
  };
}
module.exports = { createInspectionEvidence };
