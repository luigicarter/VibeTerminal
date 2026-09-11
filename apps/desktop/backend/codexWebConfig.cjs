'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const TOML = require('@iarna/toml');
const ROUTE_MARKER = '# Managed by codex-chatgpt-web: Responses use the local bridge; Voice stays on ChatGPT.';
const HOOK_MARKER = '# Managed by codex-chatgpt-web: release the exact Responses request when its Codex turn is interrupted.';

function managedJournal(home) {
  const file = path.join(path.dirname(home), 'bridge/codex/integration-journal.json');
  if (!fs.existsSync(file)) return null;
  const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (journal.version !== 10 || journal.active !== true) return null;
  if (path.resolve(journal.configPath).toLowerCase() !== path.resolve(home, 'config.toml').toLowerCase()) throw new Error('config_invalid');
  return journal;
}

function serializePrivateConfig(config, journal) {
  if (!journal) return TOML.stringify(config);
  // The upstream journal verifies these exact comments and hook text. Preserve
  // them even when shared skills/MCP/project settings need a TOML rewrite.
  // Reconstruct only a hook whose parsed fields still equal the saved record.
  const fragment = journal.interruptHook?.fragment;
  if (typeof fragment !== 'string' || !fragment.includes(HOOK_MARKER)) throw new Error('config_invalid');
  const expected = TOML.parse(fragment).hooks;
  const index = journal.interruptHook.groupIndex, stateKey = journal.interruptHook.stateKey;
  const groups = config.hooks?.Interrupt;
  if (config.openai_base_url !== journal.installed.openai_base_url
    || config.experimental_realtime_webrtc_call_base_url !== journal.installed.experimental_realtime_webrtc_call_base_url
    || !Number.isInteger(index) || index !== groups?.length - 1
    || !isDeepStrictEqual(groups[index], expected.Interrupt[0])
    || !isDeepStrictEqual(config.hooks?.state?.[stateKey], expected.state?.[stateKey])) throw new Error('config_invalid');
  const rest = structuredClone(config);
  rest.hooks.Interrupt.pop();
  if (!rest.hooks.Interrupt.length) delete rest.hooks.Interrupt;
  delete rest.hooks.state[stateKey];
  if (!Object.keys(rest.hooks.state).length) delete rest.hooks.state;
  if (!Object.keys(rest.hooks).length) delete rest.hooks;
  let text = TOML.stringify(rest);
  text = text.replace(/^openai_base_url\s*=/m, ROUTE_MARKER + '\nopenai_base_url =');
  if (journal.installed.subagent_protocol === 'compatibility-v1') {
    const comments = {
      'multi_agent = true': 'enables routed Web subagents.',
      'multi_agent_v2 = false': 'keeps routed Web subagent payloads readable.',
      [`max_depth = ${journal.installedAgentMaxDepth}`]: 'allows nested routed Web subagents in Compatibility V1.',
    };
    text = text.split('\n').map(line => comments[line.trim()] ? `${line} # Managed by codex-chatgpt-web: ${comments[line.trim()]}` : line).join('\n');
  }
  text += fragment;
  // Formatting repair must never change settings, commands, trust or credentials.
  if (!isDeepStrictEqual(TOML.parse(text), config)) throw new Error('config_invalid');
  return text;
}

function privateConfigText(original, before, config, home) {
  const journal = managedJournal(home);
  const lostFormatting = journal && (!original.includes(ROUTE_MARKER) || !original.includes(HOOK_MARKER));
  if (original && isDeepStrictEqual(before, config) && !lostFormatting) return original;
  return serializePrivateConfig(config, journal);
}
module.exports = { privateConfigText, serializePrivateConfig, managedJournal };
