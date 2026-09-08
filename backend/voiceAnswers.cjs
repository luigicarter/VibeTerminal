function normalized(text) { return String(text || '').toLowerCase().replace(/[.,!?]/g, '').trim().replace(/\s+/g, ' '); }
const NUMBERS = new Map(['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'].map((word, index) => [word, index]));
['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'].forEach((word, index) => NUMBERS.set(word, index));
function choiceText(text) {
  return normalized(text).replace(/^please\s+/, '')
    .replace(/^(?:i(?:'|’)d like|i would like|i(?:'|’)ll take|i will take|let(?:'|’)s go with|go with|choose|pick|use)\s+/, '')
    .replace(/\s+please$/, '').trim();
}
function optionIndex(text, options) {
  const input = normalized(text);
  const matches = options.flatMap((option, index) => normalized(option.label) === input ? [index] : []);
  if (matches.length) return matches.length === 1 ? matches[0] : undefined;
  const ordinalWords = 'first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth';
  const numberWords = 'one|two|three|four|five|six|seven|eight|nine|ten';
  const ordinal = input.match(new RegExp(`^(?:the\\s+)?(${ordinalWords})(?:\\s+(?:one|option|choice))?$`))
    || input.match(new RegExp(`^(?:(?:the\\s+)?(?:option|choice|number)\\s+)(${numberWords}|${ordinalWords}|\\d+)$`))
    || input.match(new RegExp(`^(${numberWords}|\\d+)$`));
  if (!ordinal) return undefined;
  return /^\d+$/.test(ordinal[1]) ? Number(ordinal[1]) - 1 : NUMBERS.get(ordinal[1]);
}
function matchAnswer(text, question, kind) {
  const input = normalized(text), options = question.options || [];
  if (kind === 'permission') {
    const permission = new Map([['allow once', 'once'], ['once', 'once'], ['allow always', 'always'], ['always', 'always'], ['reject', 'reject'], ['deny', 'reject']]);
    return permission.has(input) ? { ok: true, value: permission.get(input) } : { ok: false };
  }
  const exact = options.filter(option => normalized(option.label) === input);
  if (exact.length > 1) return { ok: false };
  if (exact.length === 1) return { ok: true, value: question.multiple ? [exact[0].label] : exact[0].label };
  const choice = choiceText(text);
  const wrapped = options.filter(option => normalized(option.label) === choice);
  if (wrapped.length > 1) return { ok: false };
  if (wrapped.length === 1) return { ok: true, value: question.multiple ? [wrapped[0].label] : wrapped[0].label };
  // Only complete choice phrases use the local shortcut. Qualifications, topic
  // changes and ambiguous replies stay available to the semantic answer router.
  const parts = String(text).toLowerCase().replace(/[.!?]/g, '').trim().split(/\s+and\s+|\s*,\s*/);
  const indices = parts.map(part => optionIndex(choiceText(part), options));
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
  const custom = question.custom && question.options?.length ? ' You can also give your own answer.' : '';
  return `${index === 0 && source ? `${source}. ` : ''}${question.question} ${labels}${question.multiple ? ' You may name more than one option.' : ''}${custom}`;
}
module.exports = { matchAnswer, questionSpeech };
