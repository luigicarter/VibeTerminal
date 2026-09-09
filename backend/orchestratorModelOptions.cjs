'use strict';

const ENABLED_EFFORTS = ['low', 'minimal', 'medium', 'high', 'xhigh', 'max'];

function outputTokensFor(model, ceiling) {
  const requested = Math.min(ceiling, Math.max(1200, Math.floor((Number(model?.contextLength) || 16384) / 16)));
  const maximum = Math.floor(Number(model?.maxCompletionTokens));
  return Number.isFinite(maximum) && maximum > 0 ? Math.min(requested, maximum) : requested;
}

function completionOptions(model) {
  const options = {};
  if (model?.supportedParameters?.includes('temperature')) options.temperature = 0;
  if (model?.reasoning) {
    const supported = model.reasoningConfig?.supported_efforts;
    // Missing effort metadata retains the existing hint. An explicit list must
    // not produce an unsupported effort or silently opt out of reasoning.
    const effort = Array.isArray(supported) ? ENABLED_EFFORTS.find(value => supported.includes(value)) : 'low';
    if (effort) options.reasoning = { effort };
  }
  return options;
}

module.exports = { outputTokensFor, completionOptions };
