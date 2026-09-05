const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { createAgentTelemetryManager, installOpenCodePlugin, openCodePluginSource, kimiHookTomlBlocks, notifyHookSource, cursorNotifyHookSource } = require("../../backend/agentTelemetry.cjs");
const { prepareGeminiTelemetry, parseSettings } = require("../../backend/geminiTelemetry.cjs");
const root = path.resolve(__dirname, "../../.tmp", `generation-telemetry-${process.pid}-${Date.now()}`);
const events = [];
const manager = createAgentTelemetryManager({ baseDir: path.join(root, "shims"), openCodeHome: path.join(root, "opencode-home"), emit: event => events.push(event) });

function post(instrumentation, event) {
  const env = instrumentation.env;
  const body = JSON.stringify({ sessionId: env.VIBE_TERMINAL_SESSION_ID, launchNonce: env.VIBE_TERMINAL_LAUNCH_NONCE, ...event });
  return new Promise((resolve, reject) => {
    const request = http.request(env.VIBE_TERMINAL_CALLBACK_URL, { method: "POST", headers: {
      "content-type": "application/json", "content-length": Buffer.byteLength(body), "x-vibe-telemetry-token": env.VIBE_TERMINAL_TELEMETRY_TOKEN
    } }, response => { response.resume(); response.on("end", () => resolve(response.statusCode)); });
    request.on("error", reject); request.end(body);
  });
}

function runObserver(file, env, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file], { env: { ...process.env, ...env }, windowsHide: true });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => { try { assert.equal(code, 0, stderr); assert.equal(stdout, "{}"); resolve(); } catch (error) { reject(error); } });
    child.stdin.end(JSON.stringify(input));
  });
}

function runMetadataHook(file, args, env, input) {
  return new Promise((resolve, reject) => {
    const isPs = file.endsWith(".ps1");
    const child = spawn(isPs ? "powershell.exe" : process.execPath,
      isPs ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file, ...args] : [file, ...args],
      { env: { ...process.env, ...env }, windowsHide: true });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => { try { assert.equal(code, 0, stderr); assert.equal(stdout, ""); resolve(); } catch (error) { reject(error); } });
    child.stdin.end(JSON.stringify(input));
  });
}

(async () => {
  await manager.ready;
  const first = await manager.prepareSession("pane", { generation: "g1", provider: "codex" });
  assert.equal(await manager.prepareSession("pane", { generation: "g1", provider: "codex" }), first);
  assert.equal(await post(first, { type: "agent.running", generation: "forged", providerThreadId: "root", providerTurnId: "turn", detail: "turn-start" }), 204);
  assert.equal(events.at(-1).generation, "g1");
  assert.equal(events.at(-1).provider, "codex");
  const second = await manager.prepareSession("pane", { generation: "g2", provider: "codex" });
  assert.notEqual(first.shimDir, second.shimDir);
  assert.notEqual(first.env.VIBE_TERMINAL_LAUNCH_NONCE, second.env.VIBE_TERMINAL_LAUNCH_NONCE);
  assert.equal(fs.existsSync(first.shimDir), false);
  assert.equal(manager.releaseSession("pane", { generation: "g1" }), false);
  assert.equal(fs.existsSync(second.shimDir), true);
  assert.equal(await post(first, { type: "agent.completed" }), 409);
  let start = events.length;
  await post(second, { type: "agent.process.started", provider: "codex", pid: 123, processId: "root-invocation" });
  await post(second, { type: "agent.process.exited", provider: "codex", exitCode: 0, processId: "root-invocation" });
  assert.deepEqual(events.slice(start).map(event => [event.type, event.phase]), [["agent-process", "start"], ["agent-process", "exit"]]);
  assert.deepEqual(events.slice(start).map(event => event.processId), ["root-invocation", "root-invocation"]);
  start = events.length;
  await post(second, { type: "agent.process.started", processId: "outer", pid: 123 });
  await post(second, { type: "agent.process.started", processId: "nested", pid: 456 });
  await post(second, { type: "agent.process.exited", processId: "nested", exitCode: 0 });
  assert.deepEqual(events.slice(start).map(event => [event.processId, event.phase]), [["outer", "start"], ["nested", "start"], ["nested", "exit"]]);
  const fakeBin = path.join(root, "process-fixture-bin");
  fs.mkdirSync(fakeBin, { recursive: true });
  const fakeProvider = path.join(fakeBin, process.platform === "win32" ? "codex.ps1" : "codex");
  fs.writeFileSync(fakeProvider, process.platform === "win32" ? "exit 0\n" : "#!/bin/sh\nexit 0\n");
  if (process.platform !== "win32") fs.chmodSync(fakeProvider, 0o755);
  const invocationIds = new Set();
  for (const engine of ["node", ...(process.platform === "win32" ? ["powershell"] : [])]) {
    const instrument = await manager.prepareSession(`shim-process-${engine}`, { generation: "process-test", provider: "codex" });
    start = events.length;
    await runMetadataHook(engine === "node" ? path.join(manager.runDir, "shim-runner.cjs") : path.join(instrument.shimDir, "codex.ps1"),
      engine === "node" ? ["codex"] : [], { ...instrument.env, VIBE_TERMINAL_ORIGINAL_PATH: fakeBin }, {});
    const processEvents = events.slice(start).filter(event => event.type === "agent-process");
    assert.equal(processEvents.length, 2);
    assert.deepEqual(processEvents.map(event => event.phase), ["start", "exit"]);
    assert.equal(typeof processEvents[0].processId, "string");
    assert.ok(processEvents[0].processId.length >= 32);
    assert.equal(processEvents[0].processId, processEvents[1].processId);
    invocationIds.add(processEvents[0].processId);
  }
  assert.equal(invocationIds.size, process.platform === "win32" ? 2 : 1);
  const spawnMarker = path.join(root, "provider-spawned.txt");
  fs.writeFileSync(fakeProvider, process.platform === "win32"
    ? "Set-Content -LiteralPath $env:VIBE_TEST_SPAWN_MARKER -Value started\nexit 0\n"
    : '#!/bin/sh\nprintf started > "$VIBE_TEST_SPAWN_MARKER"\nexit 0\n');
  let beforeStartAck;
  const ackServer = http.createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      if (JSON.parse(body).type === "agent.process.started") {
        setTimeout(() => { beforeStartAck = fs.existsSync(spawnMarker); response.writeHead(204); response.end(); }, 500);
      } else { response.writeHead(204); response.end(); }
    });
  });
  await new Promise(resolve => ackServer.listen(0, "127.0.0.1", resolve));
  try {
    const instrument = await manager.prepareSession("start-ack-order", { generation: "ack-test", provider: "codex" });
    await runMetadataHook(path.join(manager.runDir, "shim-runner.cjs"), ["codex"], {
      ...instrument.env, VIBE_TERMINAL_ORIGINAL_PATH: fakeBin, VIBE_TEST_SPAWN_MARKER: spawnMarker,
      VIBE_TERMINAL_CALLBACK_URL: `http://127.0.0.1:${ackServer.address().port}/agent-event`
    }, {});
    assert.equal(beforeStartAck, false, "Node shim must await bounded invocation-start acknowledgement before spawning");
    assert.equal(fs.existsSync(spawnMarker), true);
  } finally { await new Promise(resolve => ackServer.close(resolve)); }
  const missingBin = path.join(root, "missing-process-fixture-bin");
  fs.mkdirSync(missingBin, { recursive: true });
  for (const engine of ["node", ...(process.platform === "win32" ? ["powershell"] : [])]) {
    const instrument = await manager.prepareSession(`missing-process-${engine}`, { generation: "missing-test", provider: "codex" });
    start = events.length;
    const file = engine === "node" ? path.join(manager.runDir, "shim-runner.cjs") : path.join(instrument.shimDir, "codex.ps1");
    const result = await new Promise((resolve, reject) => {
      const child = spawn(engine === "node" ? process.execPath : "powershell.exe",
        engine === "node" ? [file, "codex"] : ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file],
        { env: { ...process.env, ...instrument.env, VIBE_TERMINAL_ORIGINAL_PATH: missingBin }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.resume(); child.stderr.resume();
      child.on("error", reject); child.on("close", resolve);
    });
    assert.equal(result, 127);
    const processEvents = events.slice(start).filter(event => event.type === "agent-process");
    assert.deepEqual(processEvents.map(event => [event.phase, event.exitCode]), [["start", null], ["exit", 127]]);
    assert.equal(processEvents[0].processId, processEvents[1].processId);
  }
  await post(second, { type: "agent.activity", phase: "start", providerThreadId: "root", providerTurnId: "turn", toolId: "tool-1", toolName: "read_file", taskId: "task-1", taskLabel: "Scout" });
  assert.equal(events.at(-1).toolId, "tool-1");
  assert.equal(events.at(-1).taskLabel, "Scout");
  assert.equal(events.at(-1).generation, "g2");
  const genericNode = path.join(root, "generic-notify.cjs");
  const cursorNode = path.join(root, "cursor-notify.cjs");
  fs.writeFileSync(genericNode, notifyHookSource());
  fs.writeFileSync(cursorNode, cursorNotifyHookSource());
  for (const provider of ["claude", "kimi", "qwen"]) {
    const instrument = await manager.prepareSession(`metadata-${provider}`, { generation: "metadata", provider });
    for (const file of [genericNode, ...(process.platform === "win32" ? [path.join(manager.runDir, "notify.ps1")] : [])]) {
      await runMetadataHook(file, ["agent.running", "tool"], instrument.env, {
        hook_event_name: "PreToolUse", session_id: "native-thread", turn_id: "native-turn", tool_use_id: "native-tool", tool_name: "Read", tool_input: { secret: "SECRET TOOL INPUT" }
      });
      const activity = events.at(-2);
      assert.equal(activity.type, "agent-activity");
      assert.equal(activity.provider, provider);
      assert.equal(activity.providerThreadId, "native-thread");
      assert.equal(activity.toolId, "native-tool");
      assert.equal(activity.rootVerified, undefined);
      assert.equal(events.at(-1).providerTurnId, "native-turn");
    }
  }
  const cursor = await manager.prepareSession("metadata-cursor", { generation: "metadata", provider: "cursor" });
  for (const file of [cursorNode, ...(process.platform === "win32" ? [path.join(manager.runDir, "vibeterminal-cursor-notify.ps1")] : [])]) {
    await runMetadataHook(file, [], cursor.env, { conversation_id: "cursor-thread", generation_id: "cursor-turn", status: "completed" });
    assert.equal(events.at(-1).providerThreadId, "cursor-thread");
    assert.equal(events.at(-1).providerTurnId, "cursor-turn");
  }
  const legacy = await manager.prepareSession("legacy");
  start = events.length;
  await post(legacy, { type: "agent.process.exited", exitCode: 0 });
  assert.equal(events.slice(start).some(event => event.type === "agent-attention" && event.attention.state === "completed"), true);

  const defaults = path.join(root, "system-defaults.json");
  const original = '{ // retained config\n "model":{"name":"user-model"}, "hooks":{"AfterAgent":[{"hooks":[{"type":"command","command":"user-validator"}]}]}, "hooksConfig":{"disabled":["user-disabled"]} }';
  fs.writeFileSync(defaults, original);
  const gemini = await manager.prepareSession("gemini-pane", { generation: "gemini-g1", provider: "gemini", env: { ...process.env, GEMINI_CLI_SYSTEM_DEFAULTS_PATH: defaults } });
  const overlay = JSON.parse(fs.readFileSync(gemini.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH, "utf8"));
  assert.equal(overlay.model.name, "user-model");
  assert.equal(overlay.hooks.AfterAgent[0].hooks[0].command, "user-validator");
  assert.deepEqual(overlay.hooksConfig.disabled, ["user-disabled"]);
  assert.equal(fs.readFileSync(defaults, "utf8"), original);
  assert.equal(gemini.capabilities.verifiedCompletion, false);
  assert.equal(Object.hasOwn(gemini.env, "GEMINI_CLI_HOME"), false);
  const observer = path.join(path.dirname(gemini.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH), "gemini-observer.cjs");
  const transcript = path.join(root, "session-root.jsonl");
  const sessionId = "d5cded11-4056-469a-8a9c-c68de588c278";
  fs.writeFileSync(transcript, JSON.stringify({ sessionId, projectHash: "project", kind: "main" }) + "\n");
  const common = { session_id: sessionId, transcript_path: transcript, cwd: root };
  await runObserver(observer, gemini.env, { ...common, hook_event_name: "SessionStart", source: "startup" });
  assert.equal(events.at(-1).type, "agent-session");
  assert.equal(events.at(-1).rootVerified, undefined);
  assert.equal(events.at(-1).providerThreadId, sessionId);
  await runObserver(observer, gemini.env, { ...common, hook_event_name: "BeforeAgent", prompt: "SECRET TEST PROMPT" });
  assert.equal(events.at(-1).type, "agent-running");
  await runObserver(observer, gemini.env, { ...common, hook_event_name: "BeforeTool", tool_name: "read_file", tool_input: { secret: "SECRET TOOL INPUT" } });
  assert.equal(events.at(-1).type, "agent-activity");
  assert.equal(events.at(-1).toolName, "read_file");
  await runObserver(observer, gemini.env, { ...common, hook_event_name: "Notification", notification_type: "ToolPermission" });
  assert.equal(events.at(-1).attention.reason, "approval");
  start = events.length;
  for (const retry of [false, true]) {
    await runObserver(observer, gemini.env, { ...common, hook_event_name: "AfterAgent", stop_hook_active: retry, prompt_response: "SECRET RESPONSE" });
  }
  assert.deepEqual(events.slice(start).map(event => [event.type, event.provisional, event.retry]), [["agent-response", true, false], ["agent-response", true, true]]);
  assert.equal(JSON.stringify(events).includes("SECRET"), false);
  fs.writeFileSync(transcript, JSON.stringify({ sessionId, projectHash: "project", kind: "subagent" }) + "\n");
  await runObserver(observer, gemini.env, { ...common, hook_event_name: "BeforeAgent" });
  assert.equal(events.at(-1).rootVerified, false);
  const largeLegacy = path.join(root, "session-large.json");
  fs.writeFileSync(largeLegacy, JSON.stringify({ sessionId, projectHash: "project", kind: "main", messages: [{ content: "x".repeat(100000) }] }));
  await runObserver(observer, gemini.env, { ...common, transcript_path: largeLegacy, hook_event_name: "BeforeAgent" });
  assert.equal(events.at(-1).rootVerified, undefined, "A bounded read cannot classify a large legacy transcript as a child");
  assert.equal(events.at(-1).providerThreadId, sessionId);
  assert.equal(events.at(-1).transcriptPath, largeLegacy);
  const disabledFile = path.join(root, "disabled.json");
  fs.writeFileSync(disabledFile, '{"hooksConfig":{"enabled":false}}');
  const disabled = prepareGeminiTelemetry({ sessionDir: path.join(root, "disabled"), nodePath: process.execPath, env: { GEMINI_CLI_SYSTEM_DEFAULTS_PATH: disabledFile } });
  assert.equal(disabled.capabilities.nativeActivity, "disabled");
  assert.deepEqual(disabled.env, {});
  assert.throws(() => parseSettings('{ /* unterminated'));

  const openConfig = path.join(root, "xdg", "opencode");
  installOpenCodePlugin(undefined, { XDG_CONFIG_HOME: path.dirname(openConfig) });
  assert.equal(fs.existsSync(path.join(openConfig, "plugins", "vibeterminal-notify.js")), true);
  const overrideConfig = path.join(root, "override-config");
  installOpenCodePlugin(undefined, { OPENCODE_CONFIG_DIR: overrideConfig });
  assert.equal(fs.existsSync(path.join(overrideConfig, "plugins", "vibeterminal-notify.js")), true);
  const source = openCodePluginSource();
  const fn = new Function(source.replace('export const VibeTerminalNotify', 'const VibeTerminalNotify') + '; return VibeTerminalNotify;')();
  const savedFetch = global.fetch;
  const savedEnv = Object.fromEntries(Object.keys(gemini.env).map(key => [key, process.env[key]]));
  const captured = [];
  try {
    Object.assign(process.env, gemini.env);
    global.fetch = async (_url, options) => { captured.push(JSON.parse(options.body)); return {}; };
    const plugin = await fn();
    await plugin.event({ event: { type: "session.updated", properties: { info: { id: "root-session", title: "Renamed conversation", directory: root } } } });
    assert.equal(captured.at(-1).type, "agent.session");
    assert.equal(captured.at(-1).title, "Renamed conversation");
    assert.equal(captured.at(-1).providerThreadId, "root-session");
    assert.equal(captured.at(-1).titleSource, "generated");
    await plugin.event({ event: { type: "session.created", properties: { info: { id: "child-session", parentID: "root-session", title: "Child task" } } } });
    const beforeChild = captured.length;
    await plugin.event({ event: { type: "message.updated", properties: { info: { sessionID: "child-session" } } } });
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: "child-session" } } });
    assert.equal(captured.length, beforeChild);
    await plugin.event({ event: { type: "message.updated", properties: { info: { sessionID: "root-session" } } } });
    assert.equal(captured.at(-1).type, "agent.running");
    assert.equal(captured.at(-1).providerThreadId, "root-session");
    await plugin.event({ event: { type: "message.updated", properties: { info: { sessionID: "second-root" } } } });
    assert.equal(captured.at(-1).providerThreadId, "second-root");
  } finally {
    global.fetch = savedFetch;
    for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }

  const kimiHome = path.join(root, "kimi");
  fs.mkdirSync(kimiHome, { recursive: true });
  const kimiFile = path.join(kimiHome, "config.toml");
  fs.writeFileSync(kimiFile, 'model = "user-model"\n' + kimiHookTomlBlocks("old", false, "vibeterminal-kimi-custom-notify") + "\n# vibeterminal-kimi-custom-notify\n[[hooks]]\nevent = 'SubagentStart'\ncommand = 'old-notifier'\n");
  await manager.ensureKimiCustomHooks(kimiHome);
  await manager.ensureKimiHooks(kimiHome);
  const kimi = fs.readFileSync(kimiFile, "utf8");
  assert.equal(kimi.includes("SubagentStart"), false);
  assert.equal(kimi.includes("kimi-custom-notify"), false);
  assert.equal(kimi.match(/event = 'UserPromptSubmit'/g).length, 1);
  assert.equal(kimi.includes('model = "user-model"'), true);
  console.log("Generation telemetry smoke passed: nonce isolation, stale release, process separation, metadata, Gemini passive overlay/hooks, OpenCode config/title, shared Kimi migration.");
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  manager.cleanup();
  // Fixture tree is an explicit child of this workspace's .tmp directory.
  const tempRoot = path.resolve(__dirname, "../../.tmp");
  const relative = path.relative(tempRoot, root);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) fs.rmSync(root, { recursive: true, force: true });
});
