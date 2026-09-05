function normalized(text) { return String(text || '').toLowerCase().replace(/[.,!?]/g, '').trim().replace(/\s+/g, ' '); }
const NUMBERS = new Map(['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'].map((word, index) => [word, index]));
['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'].forEach((word, index) => NUMBERS.set(word, index));
function matchAnswer(text, question, kind) {
  const input = normalized(text), options = question.options || [];
  if (kind === 'permission') {
    const permission = new Map([['allow once', 'once'], ['once', 'once'], ['allow always', 'always'], ['always', 'always'], ['reject', 'reject'], ['deny', 'reject']]);
    return permission.has(input) ? { ok: true, value: permission.get(input) } : { ok: false };
  }
  const exact = options.find(option => normalized(option.label) === input);
  if (exact) return { ok: true, value: question.multiple ? [exact.label] : exact.label };
  const parts = String(text).toLowerCase().replace(/[.!?]/g, '').trim().split(/\s+and\s+|\s*,\s*/).map(part => part.replace(/^(?:option|choice|number) /, '').trim());
  const indices = parts.map(part => /^\d+$/.test(part) ? Number(part) - 1 : NUMBERS.get(part));
  if (indices.length && indices.every(index => Number.isInteger(index) && index >= 0 && index < options.length) && (question.multiple || indices.length === 1)) {
    const values = [...new Set(indices)].map(index => options[index].label);
    return { ok: true, value: question.multiple ? values : values[0] };
  }
  if (question.custom && /^custom(?: answer)?\s+\S/i.test(text)) {
    const custom = text.replace(/^custom(?: answer)?\s+/i, '').trim();
    return { ok: true, value: question.multiple ? [custom] : custom };
  }
  if (!options.length && question.custom !== false && input) return { ok: true, value: String(text).trim() };
  return { ok: false };
}
function questionSpeech(interaction, index) {
  const question = interaction.questions?.[index];
  const source = [interaction.projectName, interaction.sessionName].filter(Boolean).join(', ');
  if (interaction.kind === 'permission') return `${source ? `${source}. ` : ''}${interaction.detail || question?.question || 'An agent needs permission.'} Say allow once, allow always, or reject.`;
  if (!question) return '';
  const labels = (question.options || []).map((option, i) => `Option ${i + 1}: ${option.label}.`).join(' ');
  const custom = question.custom ? ' For a custom answer, say custom answer followed by your answer.' : '';
  return `${index === 0 && source ? `${source}. ` : ''}${question.question} ${labels}${question.multiple ? ' You may name more than one option.' : ''}${custom}`;
}
module.exports = { matchAnswer, questionSpeech };
