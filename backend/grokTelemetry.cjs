const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { readHookInput } = require('./providerHookMetadata.cjs');

// Native contract: xai-org/grok-build 72a61251, hooks/event.rs.
// Only passive metadata leaves the observer. Stop is a gate, never final proof.
function grokHookEvents(hook) {
  if (!hook || typeof hook !== 'object') return [];
  const text = (...values) => values.find(value => typeof value === 'string' && value.length > 0 && value.length <= 4096);
  const name = text(hook.hook_event_name, hook.hookEventName);
  const canonical = String(name || '').replace(/_/g, '').toLowerCase();
  const thread = text(hook.sessionId, hook.session_id);
  if (!thread) return [];
  const nativeChild = canonical === 'subagentstart' || canonical === 'subagentstop';
  const childType = text(hook.subagentType, hook.subagent_type);
  const taskId = nativeChild ? text(hook.subagentId, hook.subagent_id) : childType ? thread : undefined;
  const common = {
    provider: 'grok', providerThreadId: thread,
    providerTurnId: text(hook.promptId, hook.prompt_id),
    transcriptPath: text(hook.transcriptPath, hook.transcript_path), cwd: text(hook.cwd),
    toolId: text(hook.toolUseId, hook.tool_use_id), toolName: text(hook.toolName, hook.tool_name),
    taskId, taskLabel: childType,
    ...(childType && !nativeChild ? { transcriptKind: 'subagent' } : {})
  };
  const nativeTime = Date.parse(hook.timestamp);
  if (Number.isFinite(nativeTime) && nativeTime > 0 && nativeTime <= Date.now() + 5000) common.timestamp = nativeTime;
  const make = fields => ({ ...common, ...fields });
  switch (canonical) {
    case 'sessionstart': return [make({ type: 'agent.session', phase: 'start', source: text(hook.source) })];
    // SessionEnd is explicit lifetime evidence, distinct from a provisional
    // SubagentStop hook gate. Preserve that distinction through shared telemetry.
    case 'sessionend': return [make({ type: 'agent.session', phase: 'end', reason: text(hook.reason) })];
    case 'userpromptsubmit': return [make({ type: 'agent.running', detail: 'turn-start' })];
    case 'pretooluse': case 'posttooluse': case 'posttoolusefailure': {
      const start = canonical === 'pretooluse';
      const question = start && ['ask_user_question', 'AskUserQuestion'].includes(common.toolName);
      return [...(question ? [make({ type: 'agent.activity', kind: 'tool', phase: 'start' })] : []),
        make({ type: question ? 'agent.waiting' : 'agent.running', detail: question ? 'question' : 'tool',
          kind: 'tool', phase: start ? 'start' : 'stop' })];
    }
    case 'notification': return text(hook.notificationType, hook.notification_type) === 'permission_prompt'
      ? [make({ type: 'agent.waiting', detail: 'approval' })] : [];
    case 'stop': return [make({ type: 'agent.response', provisional: true, retry: hook.stopHookActive === true || hook.stop_hook_active === true })];
    case 'stopfailure': return [make({ type: 'agent.failed' })];
    case 'stopcancelled': return [make({ type: 'agent.cancelled' })];
    case 'subagentstart': return taskId ? [make({ type: 'agent.subagent.started', lifecycle: 'native' })] : [];
    case 'subagentstop': return !taskId ? [] : hook.phase === 'observe'
      ? [make({ type: 'agent.subagent.stopped', lifecycle: 'native', provisional: true })]
      : hook.phase === 'gate' ? [make({ type: 'agent.response', transcriptKind: 'subagent', provisional: true })] : [];
    default: return [];
  }
}

function grokObserverSource() {
  return `const http = require('node:http');\n${grokHookEvents.toString()}\n${readHookInput.toString()}\n` + String.raw`
readHookInput(async raw => {
  const env = process.env;
  if (!process.argv[2] || env.VIBE_TERMINAL_GROK_INVOCATION !== process.argv[2]) return;
  if (!env.VIBE_TERMINAL_CALLBACK_URL || !env.VIBE_TERMINAL_TELEMETRY_TOKEN || !env.VIBE_TERMINAL_SESSION_ID || !env.VIBE_TERMINAL_LAUNCH_NONCE) return;
  let hook; try { hook = JSON.parse(raw); } catch { return; }
  for (const event of grokHookEvents(hook)) {
    await new Promise(resolve => {
      try {
        const url = new URL(env.VIBE_TERMINAL_CALLBACK_URL);
        const body = JSON.stringify({ ...event, sessionId: env.VIBE_TERMINAL_SESSION_ID,
          launchNonce: env.VIBE_TERMINAL_LAUNCH_NONCE, timestamp: event.timestamp || Date.now() });
        const request = http.request({ hostname: url.hostname, port: url.port, path: url.pathname,
          method: 'POST', timeout: 750, headers: { 'content-type': 'application/json',
            'content-length': Buffer.byteLength(body), 'x-vibe-telemetry-token': env.VIBE_TERMINAL_TELEMETRY_TOKEN } },
          response => { response.resume(); response.on('end', resolve); });
        request.on('error', resolve); request.on('timeout', () => { request.destroy(); resolve(); });
        request.end(body);
      } catch { resolve(); }
    });
  }
});
`;
}

function prepareGrokTelemetry({ baseDir, ownerId, nodePath, env = process.env, platform = process.platform }) {
  try {
    if (!baseDir || !ownerId) throw new Error('Missing observer ownership');
    const source = grokObserverSource();
    const version = crypto.createHash('sha256').update(source).digest('hex').slice(0, 16);
    const observer = path.join(baseDir, `grok-observer-${version}.cjs`);
    fs.mkdirSync(baseDir, { recursive: true });
    try { fs.writeFileSync(observer, source, { flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST' || fs.readFileSync(observer, 'utf8') !== source) throw error; }
    const hookDir = path.join(env.GROK_HOME || path.join(os.homedir(), '.grok'), 'hooks');
    const marker = crypto.createHash('sha256').update(ownerId).digest('hex').slice(0, 20);
    const hookPath = path.join(hookDir, `vibeterminal-${marker}.json`);
    fs.mkdirSync(hookDir, { recursive: true });
    const quote = value => "'" + String(value).replace(/'/g, platform === 'win32' ? "''" : "'\\''") + "'";
    const command = platform === 'win32'
      ? 'powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ' + Buffer.from(`$env:ELECTRON_RUN_AS_NODE='1'; & ${quote(nodePath)} ${quote(observer)} ${quote(ownerId)}`, 'utf16le').toString('base64')
      : `ELECTRON_RUN_AS_NODE=1 ${quote(nodePath)} ${quote(observer)} ${quote(ownerId)}`;
    const hooks = {};
    for (const event of ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'StopFailure', 'StopCancelled', 'SubagentStart', 'SubagentStop', 'Notification']) {
      hooks[event] = [{ ...(event === 'Notification' ? { matcher: '^permission_prompt$' } : {}), hooks: [{ type: 'command', command, timeout: 3 }] }];
    }
    const content = JSON.stringify({ hooks }, null, 2) + '\n';
    try { fs.writeFileSync(hookPath, content, { flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST' || fs.readFileSync(hookPath, 'utf8') !== content) throw error; }
    return { env: { VIBE_TERMINAL_GROK_INVOCATION: ownerId }, hookPath,
      cleanup: () => { try { if (fs.readFileSync(hookPath, 'utf8') === content) fs.unlinkSync(hookPath); } catch {} },
      binaryDir: env.GROK_BIN_DIR || path.join(os.homedir(), '.grok', 'bin'),
      capabilities: { nativeActivity: 'pending', verifiedCompletion: false, reason: 'Waiting for Grok native lifecycle hooks; Stop remains provisional.' } };
  } catch (error) {
    return { env: {}, binaryDir: env.GROK_BIN_DIR || path.join(os.homedir(), '.grok', 'bin'), capabilities: { lifecycle: 'unsupported', nativeActivity: 'unavailable', reason: `Grok observer unavailable: ${error.message}` } };
  }
}

module.exports = { grokHookEvents, grokObserverSource, prepareGrokTelemetry };
