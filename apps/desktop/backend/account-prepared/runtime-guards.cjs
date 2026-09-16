'use strict';
// Inventory for later integration. No existing handler is registered/replaced.
// Internal launches (restore, warm-spare, queue, orchestration) must call the same
// driver wrapper; admission checks alone do not authorize delayed execution.
const operationFor = {
  'terminal:create': 'terminal.launch',
  'terminal:input': 'terminal.input',
  'terminal:resize': 'resize',
  'terminal:kill': 'stop',
  'terminal:attach': 'view',
  'terminal:get-runtime-snapshots': 'view',
  'workspace:open-terminal': 'terminal.launch',
  'fusion-chat:start': 'fusion.launch',
  'fusion-chat:update-settings': 'fusion.input',
  'fusion-chat:set-mode': 'fusion.input',
  'fusion-chat:answer-question': 'fusion.input',
  'fusion-chat:interrupt': 'stop',
  'fusion-chat:stop': 'stop',
  'fusion-chat:background-cancel': 'stop',
  'fusion-chat:build-cancel': 'stop',
  'openfusion-chat:start': 'openfusion.launch',
  'openfusion-chat:save-models': 'openfusion.input',
  'openfusion-chat:permission': 'openfusion.input',
  'openfusion-chat:question': 'openfusion.input',
  'openfusion-chat:compact': 'openfusion.input',
  'openfusion-chat:interrupt': 'stop',
  'openfusion-chat:stop': 'stop',
  'openfusion-chat:background-cancel': 'stop',
  'orchestrator:submit': 'orchestrator.start',
  'orchestrator:answer': 'orchestrator.input',
  'orchestrator:voice-start': 'voice.start',
  'orchestrator:send': 'orchestrator.start',
  'orchestrator:enqueue': 'orchestrator.start',
  'orchestrator:retry': 'orchestrator.start',
  'orchestrator:cancel': 'stop',
  'orchestrator:configure': 'orchestrator.input',
  'orchestrator:enabled': 'orchestrator.input',
  'orchestrator:preferences': 'orchestrator.input',
  'orchestrator:setups-save': 'orchestrator.input',
  'orchestrator:setups-remove': 'orchestrator.input',
  'orchestrator:get-state': 'view',
  'voice:get-state': 'view',
  'voice:configure': 'voice.start',
  'voice:listening': 'voice.start',
  'voice:send-audio': 'voice.start',
  'voice:cancel-speech': 'stop',
  'orchestrator:history-clear': 'workspace.mutate',
  'orchestrator:terminal-interact': 'terminal.input',
  'orchestrator:ui-launch': 'agent.launch',
  'orchestrator:ui-close': 'stop',
  'restore:terminal': 'terminal.launch',
  'restore:agent': 'agent.launch',
  'restore:fusion': 'fusion.launch',
  'restore:openfusion': 'openfusion.launch',
  'queue:terminal-input': 'terminal.input',
  'queue:agent-input': 'agent.input',
  'queue:orchestrator': 'orchestrator.start',
  'warm-spare:launch': 'agent.launch',
  'orchestrator:dispatch': 'orchestrator.start',
  'model-providers:upsert': 'provider.mutate',
  'model-providers:delete': 'provider.mutate',
  'model-providers:set-default': 'provider.mutate',
  'open-codex-providers:upsert': 'provider.mutate',
  'open-codex-providers:delete': 'provider.mutate',
  'open-codex-providers:set-default': 'provider.mutate',
  'claude-providers:upsert': 'provider.mutate',
  'claude-providers:delete': 'provider.mutate',
  'claude-providers:set-default': 'provider.mutate',
  'openfusion-chat:auth-set': 'provider.mutate',
  'openfusion-chat:auth-remove': 'provider.mutate',
  'openfusion-chat:oauth-authorize': 'provider.mutate',
  'openfusion-chat:oauth-callback': 'provider.mutate',
  'openfusion-chat:custom-provider-set': 'provider.mutate',
  'openfusion-chat:custom-provider-remove': 'provider.mutate',
};
function createRuntimeGuards(policy) {
  function action(channel, payload) {
    if (!Object.hasOwn(operationFor, channel))
      throw Error('unclassified_operation');
    if (
      ['orchestrator:enabled', 'voice:listening'].includes(channel) &&
      payload?.enabled === false
    )
      return 'stop';
    return operationFor[channel];
  }
  return {
    invoke(channel, driver, ...args) {
      policy.assert(action(channel, args[0]));
      return driver(...args);
    },
    queue(channel, driver) {
      return policy.schedule(action(channel), driver);
    },
    guard(channel, driver) {
      return (...args) => {
        policy.assert(action(channel, args[0]));
        return driver(...args);
      };
    },
  };
}
module.exports = { operationFor, createRuntimeGuards };
