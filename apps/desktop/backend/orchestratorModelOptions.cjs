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

// A strict JSON schema keeps the reviewer reply in message.content, so the
// existing parse and validation path is unchanged. Only a model that advertises
// structured outputs receives it; every other model keeps today's prose reply.
function structuredOutput(model, name, schema) {
  if (!Array.isArray(model?.supportedParameters) || !model.supportedParameters.includes('structured_outputs')) return {};
  return { response_format: { type: 'json_schema', json_schema: { name, strict: true, schema } } };
}

// A reasoning model can exhaust its output budget before producing a tool call.
const exhaustedReply = response => response?.choices?.[0]?.finish_reason === 'length'
  && !String(response.choices[0].message?.content || '').trim() && !response.choices[0].message?.tool_calls?.length;

module.exports = { outputTokensFor, completionOptions, structuredOutput, exhaustedReply };
