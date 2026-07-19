const fs = require("fs");
const http = require("http");
const path = require("path");
const url = require("url");
const { spawn } = require("child_process");
const {
  buildClaudeSettingsJson,
  codexLifecycleConfigOverrides,
  codexLifecycleHookSource,
  cleanupStaleOpenFusionDirs,
  cleanupStaleShimDirs,
  createAgentTelemetryManager,
  cursorHookEntries,
  cursorTypeFromStatus,
  installOpenCodePlugin,
  kimiHookTomlBlocks,
  mapTelemetryToAttention,
  mergeCursorHooks,
  mergeKimiHooks,
  notifyHookSource,
  openFusionConfigContents,
  openCodePluginSource,
  stripCursorHooks,
  stripKimiHooks
} = require("../../backend/agentTelemetry.cjs");

const CURSOR_HOOK_MARKER = "vibeterminal-cursor-notify";

const rootDir = path.join(__dirname, "..", "..");
const root = path.join(
  rootDir,
  ".tmp",
  `agent-telemetry-smoke-${Date.now()}-${process.pid}`
);
const fakeBin = path.join(root, "fake-bin");
const cmdOnlyFakeBin = path.join(root, "fake-cmd-bin");
const shimBase = path.join(root, "shims");
const openFusionBase = path.join(root, "openfusion");
const previousKimiCodeHome = process.env.KIMI_CODE_HOME;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function wildcardMatch(value, pattern) {
  const escaped = String(pattern)
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(String(value));
}

function permissionRules(config) {
  const rules = [];
  for (const [permission, value] of Object.entries(config || {})) {
    if (typeof value === "string") {
      rules.push({ permission, pattern: "*", action: value });
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    for (const [pattern, action] of Object.entries(value)) {
      if (typeof action === "string") {
        rules.push({ permission, pattern, action });
      }
    }
  }
  return rules;
}

function resolveOpenCodePermission(agentPermission, permission, pattern = "*") {
  const rules = permissionRules({ "*": "allow" }).concat(
    permissionRules(agentPermission)
  );
  for (let index = rules.length - 1; index >= 0; index -= 1) {
    const rule = rules[index];
    if (
      wildcardMatch(permission, rule.permission) &&
      wildcardMatch(pattern, rule.pattern)
    ) {
      return rule.action;
    }
  }
  return "ask";
}

function writeFakeProvider(name) {
  fs.mkdirSync(fakeBin, { recursive: true });

  if (process.platform === "win32") {
    const psPath = path.join(fakeBin, `${name}.ps1`);
    fs.writeFileSync(
      psPath,
      [
        "Set-Content -LiteralPath $env:VIBE_FAKE_PROVIDER_ARGS -Value ($args | ConvertTo-Json -Compress)",
        `Write-Output "fake-${name} $($args -join ' ')"`,
        `Write-Output "fake-${name}-stdin-redirected=$([Console]::IsInputRedirected)"`,
        "exit 0"
      ].join("\r\n")
    );

    const filePath = path.join(fakeBin, `${name}.cmd`);
    fs.writeFileSync(
      filePath,
      ["@echo off", `echo cmd-fake-${name} %*`, "exit /b 0"].join("\r\n")
    );
    return psPath;
  }

  const filePath = path.join(fakeBin, name);
  fs.writeFileSync(
    filePath,
    ["#!/usr/bin/env sh", `echo fake-${name} "$@"`, "exit 0"].join("\n")
  );
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const isWindowsCommandScript =
      process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
    const commandFile = isWindowsCommandScript
      ? process.env.ComSpec || "cmd.exe"
      : command;
    const commandArgs = isWindowsCommandScript
      ? [
          "/d",
          "/c",
          `"${[quoteForCmd(command)].concat(args.map(quoteForCmd)).join(" ")}"`
        ]
      : args;
    const child = spawn(commandFile, commandArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsVerbatimArguments: isWindowsCommandScript,
      ...options
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function runWithStdin(command, args, stdin, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      ...options
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code, signal) =>
      resolve({ code, signal, stdout, stderr })
    );
    child.stdin.end(stdin);
  });
}

function runInWindowsPty(command, options = {}) {
  return new Promise((resolve, reject) => {
    const childScript = `
const pty = require("node-pty");
const command = process.argv[1];
const cwd = process.argv[2];
const terminal = pty.spawn(${JSON.stringify(powershellCommand())}, ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass"], {
  cols: 120,
  rows: 30,
  cwd,
  env: process.env,
  name: "xterm-256color"
});
let output = "";
let settled = false;
const timeout = setTimeout(() => finish({ code: null, signal: null, timedOut: true }), 10000);
function finish(result) {
  if (settled) return;
  settled = true;
  clearTimeout(timeout);
  result.output = output;
  try {
    terminal.kill();
  } catch {
    // The PTY may already be gone.
  }
  process.stdout.write(JSON.stringify(result) + "\\n", () => {
    process.exit(result.code === null ? 1 : Number(result.code) || 0);
  });
}
terminal.onData((data) => {
  output += data;
});
terminal.onExit(({ exitCode, signal }) => {
  finish({ code: exitCode, signal, timedOut: false });
});
terminal.write(command + "\\r");
terminal.write("exit $LASTEXITCODE\\r");
`;
    const child = spawn(process.execPath, ["-e", childScript, command, options.cwd], {
      cwd: rootDir,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", () => {
      const knownConptyCleanupNoise =
        stderr.includes("conpty_console_list_agent.js") &&
        stderr.includes("AttachConsole failed");
      const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
      const resultLine = lines.findLast((line) => line.trim().startsWith("{"));
      if (!resultLine) {
        reject(
          new Error(
            `PTY smoke did not return a result; stdout=${stdout}; stderr=${stderr}`
          )
        );
        return;
      }

      try {
        const result = JSON.parse(resultLine);
        if (stderr.trim() && !knownConptyCleanupNoise) {
          result.stderr = stderr;
        }
        resolve(result);
      } catch (error) {
        reject(error);
      }
    });
  });
}

function quoteForCmd(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function writeFakeCmdProvider(name) {
  fs.mkdirSync(cmdOnlyFakeBin, { recursive: true });

  const filePath = path.join(cmdOnlyFakeBin, `${name}.cmd`);
  fs.writeFileSync(
    filePath,
    [
      "@echo off",
      `echo cmd-fake-${name} %*`,
      `${quoteForCmd(process.execPath)} -e "console.log('cmd-fake-${name}-stdin-is-tty=' + Boolean(process.stdin.isTTY))"`,
      "exit /b 0"
    ].join("\r\n")
  );
  return filePath;
}

function powershellCommand() {
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const candidate = path.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  return fs.existsSync(candidate) ? candidate : "powershell.exe";
}

function postWithBadToken(callbackUrl) {
  return new Promise((resolve, reject) => {
    const url = new URL(callbackUrl);
    const body = JSON.stringify({
      type: "agent.process.exited",
      sessionId: "pane-one",
      provider: "codex",
      exitCode: 0
    });
    const request = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          "x-vibe-telemetry-token": "wrong-token"
        }
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      }
    );

    request.on("error", reject);
    request.end(body);
  });
}

function postTelemetry(callbackUrl, token, payload) {
  return new Promise((resolve, reject) => {
    const url = new URL(callbackUrl);
    const body = JSON.stringify(payload);
    const request = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          "x-vibe-telemetry-token": token
        }
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      }
    );

    request.on("error", reject);
    request.end(body);
  });
}

(async () => {
  let manager = null;
  const previousPath = process.env.Path ?? process.env.PATH ?? "";
  const pathKey = process.platform === "win32" ? "Path" : "PATH";
  const events = [];

  try {
    fs.mkdirSync(root, { recursive: true });
    const lifecycleSource = codexLifecycleHookSource();
    assert(
      lifecycleSource.includes("hook.agent_id || hook.agent_type") &&
        lifecycleSource.includes('case "UserPromptSubmit"') &&
        lifecycleSource.includes('case "PermissionRequest"') &&
        lifecycleSource.includes('case "PreToolUse"') &&
        lifecycleSource.includes('provider: "codex"') &&
        !lifecycleSource.includes("dangerously-bypass-hook-trust"),
      "Codex lifecycle observer should be passive and use normal hook trust"
    );
    const lifecycleOverrides = codexLifecycleConfigOverrides(
      process.execPath,
      path.join(shimBase, "codex-lifecycle-hook.cjs"),
      process.platform === "win32"
    );
    assert(
      lifecycleOverrides.length === 4 &&
        lifecycleOverrides.every(
          (entry) =>
            (entry.includes('type = "command"') ||
              entry.includes("type = 'command'")) &&
            entry.includes("timeout = 5")
        ),
      "Codex lifecycle config should cover start, approval, and tool activity"
    );
    writeFakeProvider("codex");
    process.env[pathKey] = fakeBin;

    const staleRun = path.join(shimBase, "stale-run");
    const currentRun = path.join(shimBase, "current-run");
    const unmarkedRun = path.join(shimBase, "unmarked-run");
    fs.mkdirSync(staleRun, { recursive: true });
    fs.mkdirSync(currentRun, { recursive: true });
    fs.mkdirSync(unmarkedRun, { recursive: true });
    fs.writeFileSync(
      path.join(staleRun, ".vibe-agent-shims.json"),
      `${JSON.stringify({
        owner: "vibeTerminal-agent-shims",
        runId: "stale-run"
      })}\n`
    );
    fs.writeFileSync(
      path.join(currentRun, ".vibe-agent-shims.json"),
      `${JSON.stringify({
        owner: "vibeTerminal-agent-shims",
        runId: "current-run"
      })}\n`
    );

    const removed = cleanupStaleShimDirs({
      baseDir: shimBase,
      currentRunId: "current-run"
    });
    assert(removed.includes(staleRun), "marked stale shim dir should be removed");
    assert(!fs.existsSync(staleRun), "marked stale shim dir should not remain");
    assert(fs.existsSync(currentRun), "current run dir should not be removed");
    assert(fs.existsSync(unmarkedRun), "unmarked dir should not be removed");

    // Isolate the opencode global-plugin install to a fake home so the smoke
    // test never touches the developer's real ~/.config/opencode.
    const openCodeHome = path.join(root, "ocfake");
    fs.mkdirSync(path.join(openCodeHome, ".config", "opencode"), {
      recursive: true
    });

    manager = createAgentTelemetryManager({
      baseDir: shimBase,
      openFusionBaseDir: openFusionBase,
      emit: (event) => events.push(event),
      runId: "current-run",
      token: "test-token",
      nodePath: process.execPath,
      openCodeHome
    });
    await manager.ready;

    // Notification assets are written for the run.
    const notifyProgram =
      process.platform === "win32"
        ? path.join(manager.runDir, "notify.ps1")
        : path.join(manager.runDir, "notify.sh");
    assert(fs.existsSync(notifyProgram), "notify program should be written");
    const claudeSettings = JSON.parse(
      fs.readFileSync(path.join(manager.runDir, "claude-settings.json"), "utf8")
    );
    assert(
      Array.isArray(claudeSettings?.hooks?.Stop) &&
        Array.isArray(claudeSettings?.hooks?.Notification),
      "claude settings should declare Stop and Notification hooks"
    );
    assert(
      Array.isArray(claudeSettings?.hooks?.UserPromptSubmit) &&
        JSON.stringify(claudeSettings.hooks.UserPromptSubmit).includes(
          "agent.running"
        ),
      "claude settings should fire agent.running on turn start (UserPromptSubmit)"
    );

    // The guarded opencode plugin lands in the (fake) opencode config dir.
    const openCodePlugin = path.join(
      openCodeHome,
      ".config",
      "opencode",
      "plugin",
      "vibeterminal-notify.js"
    );
    assert(
      fs.existsSync(openCodePlugin) &&
        fs.readFileSync(openCodePlugin, "utf8").includes("agent.completed"),
      "opencode notify plugin should be installed into the opencode config dir"
    );

    const instrumentation = await manager.prepareSession("pane-one");
    const traversalInstrumentation = await manager.prepareSession("..\\..\\backend");
    assert(
      traversalInstrumentation.shimDir.startsWith(`${manager.runDir}${path.sep}`),
      "renderer-controlled session ids must not escape the telemetry run dir"
    );
    manager.releaseSession("..\\..\\backend");

    assert(
      instrumentation.env.VIBE_TERMINAL_SESSION_ID === "pane-one",
      "session id should be present in shim env"
    );

    // The kimi-custom shim wrapper lands alongside the other providers too, so
    // PATH interception gives the fork's panes the process-exit fallback.
    const kimiCustomWrapper = path.join(
      instrumentation.shimDir,
      process.platform === "win32" ? "kimi-custom.cmd" : "kimi-custom"
    );
    assert(
      fs.existsSync(kimiCustomWrapper),
      "prepareSession should write a kimi-custom shim wrapper"
    );
    // The kimi shim wrapper lands alongside the other providers, so PATH
    // interception gives kimi panes the process-exit fallback too.
    const kimiWrapper = path.join(
      instrumentation.shimDir,
      process.platform === "win32" ? "kimi.cmd" : "kimi"
    );
    assert(
      fs.existsSync(kimiWrapper),
      "prepareSession should write a kimi shim wrapper"
    );
    const lifecycleHookName = fs
      .readdirSync(shimBase)
      .find((name) => /^codex-lifecycle-hook-[a-f0-9]{12}\.cjs$/.test(name));
    const lifecycleHookPath = lifecycleHookName
      ? path.join(shimBase, lifecycleHookName)
      : "";
    assert(
      fs.existsSync(lifecycleHookPath),
      "content-versioned Codex lifecycle observer should be written"
    );
    const lifecycleResult = await runWithStdin(
      process.execPath,
      [lifecycleHookPath],
      JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        session_id: "root-thread",
        turn_id: "turn-one",
        prompt: "smoke"
      }),
      { env: { ...process.env, ...instrumentation.env } }
    );
    assert(
      lifecycleResult.code === 0 &&
        lifecycleResult.stdout === "" &&
        lifecycleResult.stderr === "",
      "Codex lifecycle observer should stay passive and quiet"
    );
    const lifecycleRunningEvent = events.find(
      (event) =>
        event.type === "agent-running" &&
        event.id === "pane-one" &&
        event.providerThreadId === "root-thread" &&
        event.providerTurnId === "turn-one"
    );
    assert(
      lifecycleRunningEvent?.turnStart === true,
      "UserPromptSubmit observer should emit an identified turn start"
    );
    const eventsBeforeChildHook = events.length;
    await runWithStdin(
      process.execPath,
      [lifecycleHookPath],
      JSON.stringify({
        hook_event_name: "PostToolUse",
        session_id: "root-thread",
        turn_id: "child-turn",
        agent_id: "child",
        agent_type: "worker"
      }),
      { env: { ...process.env, ...instrumentation.env } }
    );
    assert(
      events.length === eventsBeforeChildHook,
      "Codex lifecycle observer should defensively ignore explicit subagent payloads"
    );
    assert(
      typeof instrumentation.env.VIBE_TERMINAL_LAUNCH_NONCE === "string" &&
        instrumentation.env.VIBE_TERMINAL_LAUNCH_NONCE.length >= 24,
      "each prepared pane launch should carry a strong callback nonce"
    );
    const remountedInstrumentation = await manager.prepareSession("pane-one");
    assert(
      remountedInstrumentation.env.VIBE_TERMINAL_LAUNCH_NONCE ===
        instrumentation.env.VIBE_TERMINAL_LAUNCH_NONCE,
      "remounting an active pane session should preserve its launch nonce"
    );

    const stalePaneFirst = await manager.prepareSession("pane-stale-callback");
    const staleNonce = stalePaneFirst.env.VIBE_TERMINAL_LAUNCH_NONCE;
    manager.releaseSession("pane-stale-callback");
    const releasedStatus = await postTelemetry(manager.callbackUrl(), "test-token", {
      type: "agent.completed",
      sessionId: "pane-stale-callback",
      launchNonce: staleNonce
    });
    assert(
      releasedStatus === 409,
      "callbacks for a released pane session should be rejected"
    );
    const stalePaneSecond = await manager.prepareSession("pane-stale-callback");
    const currentNonce = stalePaneSecond.env.VIBE_TERMINAL_LAUNCH_NONCE;
    assert(
      currentNonce !== staleNonce,
      "restarting a released pane session should create a new launch nonce"
    );
    const staleRestartStatus = await postTelemetry(
      manager.callbackUrl(),
      "test-token",
      {
        type: "agent.completed",
        sessionId: "pane-stale-callback",
        launchNonce: staleNonce
      }
    );
    assert(
      staleRestartStatus === 409,
      "a delayed callback from the prior pane launch should be rejected"
    );
    const currentRestartStatus = await postTelemetry(
      manager.callbackUrl(),
      "test-token",
      {
        type: "agent.completed",
        sessionId: "pane-stale-callback",
        launchNonce: currentNonce
      }
    );
    assert(
      currentRestartStatus === 204,
      "the current pane launch nonce should remain accepted"
    );
    assert(
      instrumentation.env.VIBE_TERMINAL_ORIGINAL_PATH === fakeBin,
      "original PATH should be captured"
    );
    // instrumentation.env is a plain object, so look up the PATH key with the
    // same case-insensitive rule the shim uses (Windows may spell it "PATH").
    const instrumentationPathKey =
      Object.keys(instrumentation.env).find(
        (envKey) => envKey.toLowerCase() === "path"
      ) || pathKey;
    assert(
      (instrumentation.env[instrumentationPathKey] || "").startsWith(
        instrumentation.shimDir
      ),
      "shim dir should be prepended to PATH"
    );
    assert(
      (process.env[pathKey] || "") === fakeBin,
      "global process PATH should not be mutated by instrumentation"
    );

    const claudeSkillsDir = path.join(root, ".claude", "skills");
    const codexSkillsDir = path.join(root, ".codex", "skills");
    fs.mkdirSync(path.join(claudeSkillsDir, "doc-writer"), { recursive: true });
    fs.mkdirSync(path.join(codexSkillsDir, "repo-auditor"), { recursive: true });
    fs.writeFileSync(
      path.join(claudeSkillsDir, "doc-writer", "SKILL.md"),
      "# doc-writer\n"
    );
    fs.writeFileSync(
      path.join(codexSkillsDir, "repo-auditor", "SKILL.md"),
      "# repo-auditor\n"
    );
    fs.writeFileSync(
      path.join(root, ".mcp.json"),
      `${JSON.stringify(
        {
          mcpServers: {
            docs: {
              command: "node",
              args: ["docs-mcp.js"],
              env: { DOCS_TOKEN: "local" },
              disabled: false
            },
            linear: {
              command: "node",
              args: ["linear-mcp.js"],
              env: { LINEAR_TOKEN: "local" }
            },
            remote: {
              url: "https://example.test/mcp",
              headers: { "X-Test": "yes" },
              enabled: true
            },
            invalid: {
              args: ["missing-command-or-url"]
            }
          }
        },
        null,
        2
      )}\n`
    );

    const openFusionFiles = await manager.prepareOpenFusionFiles("pane-one", {
      plannerModel: "openai/gpt-5.1",
      executorModel: "opencode/gpt-5.1-codex",
      cwd: root
    });
    assert(openFusionFiles, "Open Fusion files should be prepared");
    assert(
      openFusionFiles.configPath.startsWith(`${manager.openFusionBaseDir}${path.sep}`) &&
        openFusionFiles.configDir.startsWith(`${manager.openFusionBaseDir}${path.sep}`) &&
        !openFusionFiles.configPath.startsWith(`${manager.runDir}${path.sep}`),
      "Open Fusion config must stay inside the dedicated Open Fusion user-data dir"
    );
    assert(
      openFusionFiles.env.OPENCODE_CONFIG === openFusionFiles.configPath &&
        openFusionFiles.env.OPENCODE_CONFIG_DIR === openFusionFiles.configDir &&
        typeof openFusionFiles.env.OPENCODE_CONFIG_CONTENT === "string" &&
        openFusionFiles.env.OPENCODE_TUI_CONFIG === openFusionFiles.tuiConfigPath &&
        openFusionFiles.env.VIBE_TERMINAL_OPEN_FUSION_DIR === openFusionFiles.openFusionDir &&
        openFusionFiles.env.VIBE_TERMINAL_OPEN_FUSION_MODEL_STATE === openFusionFiles.modelStatePath &&
        openFusionFiles.env.VIBE_TERMINAL_OPEN_FUSION_PLANNER_MODEL === "openai/gpt-5.1" &&
        openFusionFiles.env.VIBE_TERMINAL_OPEN_FUSION_EXECUTOR_MODEL === "opencode/gpt-5.1-codex",
      "Open Fusion env should point at the pane-scoped config files"
    );
    const openFusionEnvConfig = JSON.parse(
      openFusionFiles.env.OPENCODE_CONFIG_CONTENT
    );
    const openFusionConfig = JSON.parse(
      fs.readFileSync(openFusionFiles.configPath, "utf8")
    );
    const plannerPermission = openFusionConfig.agent?.planner?.permission;
    const plannerBash = openFusionConfig.agent?.planner?.permission?.bash;
    assert(
      openFusionConfig.default_agent === "planner" &&
        openFusionConfig.agent?.planner?.mode === "primary" &&
        openFusionConfig.agent?.planner?.model === "openai/gpt-5.1" &&
        plannerPermission?.["*"] === "deny" &&
        plannerPermission?.read?.["*"] === "allow" &&
        plannerPermission?.read?.["mcp:*"] === "deny" &&
        plannerPermission?.grep === "allow" &&
        plannerPermission?.glob === "allow" &&
        plannerPermission?.todowrite === "allow" &&
        plannerBash?.["*"] === "deny" &&
        plannerBash?.["git status *"] === "allow" &&
        plannerBash?.["git diff *"] === "allow" &&
        plannerBash?.["git log *"] === "allow" &&
        plannerBash?.["git show *"] === "allow" &&
        plannerBash?.["git * --output*"] === "deny" &&
        plannerPermission?.edit === "deny" &&
        plannerPermission?.task?.executor === "allow" &&
        plannerPermission?.task?.["*"] === "deny" &&
        plannerPermission?.skill === "deny",
      "Open Fusion planner should be read-only except the git evidence bash allowlist"
    );
    assert(
      openFusionConfig.mcp?.docs?.type === "local" &&
        openFusionConfig.mcp?.docs?.command?.[0] === "node" &&
        openFusionConfig.mcp?.docs?.command?.[1] === "docs-mcp.js" &&
        openFusionConfig.mcp?.docs?.environment?.DOCS_TOKEN === "local" &&
        openFusionConfig.mcp?.docs?.enabled === true &&
        openFusionConfig.mcp?.linear?.type === "local" &&
        openFusionConfig.mcp?.linear?.command?.[0] === "node" &&
        openFusionConfig.mcp?.linear?.command?.[1] === "linear-mcp.js" &&
        openFusionConfig.mcp?.linear?.environment?.LINEAR_TOKEN === "local" &&
        openFusionConfig.mcp?.remote?.type === "remote" &&
        openFusionConfig.mcp?.remote?.url === "https://example.test/mcp" &&
        openFusionConfig.mcp?.remote?.headers?.["X-Test"] === "yes" &&
        !openFusionConfig.mcp?.invalid &&
        Array.isArray(openFusionConfig.skills?.paths) &&
        openFusionConfig.skills.paths.includes(claudeSkillsDir) &&
        openFusionConfig.skills.paths.includes(codexSkillsDir),
      "Open Fusion config should translate workspace .mcp.json and include workspace skill paths"
    );
    assert(
      JSON.stringify(openFusionEnvConfig.mcp) === JSON.stringify(openFusionConfig.mcp) &&
        JSON.stringify(openFusionEnvConfig.skills) ===
          JSON.stringify(openFusionConfig.skills),
      "Open Fusion env config should carry the same workspace capabilities as the file config"
    );
    // opencode evaluates permission rules with findLast (LAST matching key
    // wins), so the deny catch-all must be first and the --output deny last —
    // reordering these keys silently flips the whole allowlist.
    const plannerPermissionKeys = Object.keys(plannerPermission || {});
    assert(
      plannerPermissionKeys[0] === "*",
      "Open Fusion planner permission must keep top-level '*' deny first so dynamic MCP tools stay blocked"
    );
    const plannerBashKeys = Object.keys(plannerBash || {});
    assert(
      plannerBashKeys[0] === "*" &&
        plannerBashKeys[plannerBashKeys.length - 1] === "git * --output*",
      "Open Fusion planner bash allowlist must keep '*' deny first and the --output deny last (findLast semantics)"
    );
    assert(
      openFusionConfig.agent?.executor?.mode === "subagent" &&
        openFusionConfig.agent?.executor?.model === "opencode/gpt-5.1-codex" &&
        openFusionConfig.agent?.executor?.permission?.vibeterminal_background_task === "deny" &&
        openFusionConfig.agent?.executor?.permission?.vibeterminal_background_cancel === "deny" &&
        openFusionConfig.agent?.executor?.permission?.vibeterminal_background_status === "deny",
      "Open Fusion executor should be model-pinned with only the Brain background bridge denied"
    );
    assert(
      resolveOpenCodePermission(plannerPermission, "linear_create_issue") === "deny" &&
        resolveOpenCodePermission(plannerPermission, "read", "src/index.ts") === "allow" &&
        resolveOpenCodePermission(plannerPermission, "read", "mcp:linear:*") === "deny" &&
        resolveOpenCodePermission(plannerPermission, "todowrite") === "allow" &&
        resolveOpenCodePermission(plannerPermission, "grep") === "allow" &&
        resolveOpenCodePermission(
          openFusionConfig.agent?.executor?.permission,
          "linear_create_issue"
        ) === "allow",
      "Open Fusion planner must hard-deny dynamic MCP tools while keeping read-only built-ins allowed and executor default-allowed"
    );
    // Plan mode: a second read-only primary agent selected per-prompt. The
    // task map must deny the executor (scout allowed, implementation blocked)
    // and default_agent must stay planner.
    const planAgent = openFusionConfig.agent?.plan;
    const planPermission = planAgent?.permission;
    const planBash = planAgent?.permission?.bash;
    assert(
      planAgent?.mode === "primary" &&
        planAgent?.model === "openai/gpt-5.1" &&
        planPermission?.["*"] === "deny" &&
        planPermission?.read?.["*"] === "allow" &&
        planPermission?.read?.["mcp:*"] === "deny" &&
        planPermission?.grep === "allow" &&
        planPermission?.todowrite === "allow" &&
        planPermission?.edit === "deny" &&
        planPermission?.skill === "deny" &&
        planBash?.["*"] === "deny" &&
        planBash?.["git status *"] === "allow" &&
        planBash?.["git * --output*"] === "deny" &&
        openFusionConfig.default_agent === "planner",
      "Open Fusion plan agent should be a read-only primary on the Brain model with the git evidence allowlist"
    );
    assert(
      Object.keys(planPermission || {})[0] === "*" &&
        resolveOpenCodePermission(planPermission, "linear_create_issue") === "deny" &&
        resolveOpenCodePermission(planPermission, "todowrite") === "allow" &&
        resolveOpenCodePermission(planPermission, "read", "src/index.ts") === "allow",
      "Open Fusion plan agent must deny dynamic MCP tools while keeping read-only built-ins allowed"
    );
    const planBashKeys = Object.keys(planBash || {});
    assert(
      planBashKeys.join("|") === plannerBashKeys.join("|"),
      "Open Fusion plan agent bash map must stay byte-identical (incl. key order) to the planner's (findLast semantics)"
    );
    assert(
      JSON.stringify(Object.keys(planAgent?.permission?.task || {})) ===
        JSON.stringify(["*", "investigator"]) &&
        planAgent?.permission?.task?.["*"] === "deny" &&
        planAgent?.permission?.task?.investigator === "allow",
      "Open Fusion plan agent task map must be exactly {'*': deny, investigator: allow} in that order — NO executor key"
    );
    assert(
      openFusionEnvConfig.agent?.plan?.prompt?.includes("Open Fusion Plan Mode") &&
        openFusionEnvConfig.agent?.plan?.prompt?.includes("must not delegate implementation") &&
        openFusionEnvConfig.agent?.plan?.prompt?.includes("2-5 milestones"),
      "Open Fusion plan prompt must carry the plan-mode contract (no implementation, milestone plan)"
    );
    const investigatorPermission = openFusionConfig.agent?.investigator?.permission;
    assert(
      plannerPermission?.task?.investigator === "allow" &&
        openFusionConfig.agent?.investigator?.mode === "subagent" &&
        investigatorPermission?.["*"] === "deny" &&
        investigatorPermission?.read?.["*"] === "allow" &&
        investigatorPermission?.read?.["mcp:*"] === "deny" &&
        investigatorPermission?.grep === "allow" &&
        investigatorPermission?.todowrite === "allow" &&
        investigatorPermission?.edit === "deny" &&
        investigatorPermission?.bash === "deny" &&
        investigatorPermission?.task?.["*"] === "deny" &&
        investigatorPermission?.skill === "deny" &&
        openFusionConfig.command?.investigate?.agent === "investigator" &&
        openFusionConfig.command?.investigate?.subtask === true,
      "Open Fusion investigator must be a hard read-only subagent (no edit/bash/task) reachable from the planner and /investigate"
    );
    assert(
      Object.keys(investigatorPermission || {})[0] === "*" &&
        resolveOpenCodePermission(investigatorPermission, "linear_create_issue") === "deny" &&
        resolveOpenCodePermission(investigatorPermission, "todowrite") === "allow" &&
        resolveOpenCodePermission(investigatorPermission, "read", "src/index.ts") === "allow",
      "Open Fusion investigator must deny dynamic MCP tools while keeping read-only built-ins allowed"
    );
    // Detached background delegations: the app-owned MCP bridge, its
    // planner-only dynamic-tool allows (which must come AFTER the '*' deny —
    // findLast semantics), and the executor-bg PRIMARY clone that drives
    // host-created background sessions.
    const bgBridge = openFusionConfig.mcp?.vibeterminal;
    assert(
      bgBridge?.type === "local" &&
        Array.isArray(bgBridge?.command) &&
        String(bgBridge?.command?.[1] || "").includes("openFusionBackgroundMcp.cjs") &&
        bgBridge?.environment?.ELECTRON_RUN_AS_NODE === "1" &&
        typeof bgBridge?.environment?.VIBE_TERMINAL_CALLBACK_URL === "string" &&
        typeof bgBridge?.environment?.VIBE_TERMINAL_TELEMETRY_TOKEN === "string" &&
        typeof bgBridge?.environment?.VIBE_TERMINAL_SESSION_ID === "string" &&
        bgBridge?.environment?.VIBE_TERMINAL_SESSION_ID.length > 0 &&
        bgBridge?.environment?.VIBE_TERMINAL_BG_STATUS_FILE ===
          openFusionFiles.backgroundStatusPath &&
        openFusionFiles.backgroundStatusPath.startsWith(`${openFusionFiles.openFusionDir}${path.sep}`) &&
        JSON.stringify(openFusionEnvConfig.mcp?.vibeterminal) === JSON.stringify(bgBridge),
      "Open Fusion config should carry the pane-bound vibeterminal background bridge and snapshot path in both config forms"
    );
    const plannerKeys = Object.keys(plannerPermission || {});
    assert(
      plannerPermission?.vibeterminal_background_task === "allow" &&
        plannerPermission?.vibeterminal_background_cancel === "allow" &&
        plannerPermission?.vibeterminal_background_status === "allow" &&
        plannerKeys.indexOf("*") !== -1 &&
        plannerKeys.indexOf("*") < plannerKeys.indexOf("vibeterminal_background_task") &&
        resolveOpenCodePermission(plannerPermission, "vibeterminal_background_task") === "allow" &&
        resolveOpenCodePermission(plannerPermission, "vibeterminal_background_status") === "allow" &&
        resolveOpenCodePermission(planPermission, "vibeterminal_background_task") === "deny" &&
        resolveOpenCodePermission(planPermission, "vibeterminal_background_cancel") === "deny" &&
        resolveOpenCodePermission(planPermission, "vibeterminal_background_status") === "allow" &&
        resolveOpenCodePermission(investigatorPermission, "vibeterminal_background_task") === "deny",
      "background start/cancel must be planner-only while read-only status remains available in planner and Plan mode"
    );
    assert(
      JSON.stringify(plannerKeys.slice(-3)) ===
        JSON.stringify([
          "vibeterminal_background_task",
          "vibeterminal_background_cancel",
          "vibeterminal_background_status"
        ]) &&
        Object.keys(planPermission || {}).at(-1) === "vibeterminal_background_status",
      "background permission exceptions must be appended after the load-bearing wildcard without reordering existing keys"
    );
    const executorBg = openFusionConfig.agent?.["executor-bg"];
    assert(
      executorBg?.mode === "primary" &&
        executorBg?.model === "opencode/gpt-5.1-codex" &&
        executorBg?.hidden === true &&
        executorBg?.permission?.vibeterminal_background_task === "deny" &&
        executorBg?.permission?.vibeterminal_background_cancel === "deny" &&
        executorBg?.permission?.vibeterminal_background_status === "deny",
      "executor-bg must be a hidden PRIMARY executor clone (a subagent driving a fresh session is unverified on 1.17.11)"
    );
    assert(
      openFusionEnvConfig.agent?.planner?.prompt?.includes("background_status") &&
        openFusionEnvConfig.agent?.plan?.prompt?.includes("background_status") &&
        openFusionEnvConfig.agent?.plan?.prompt?.includes("read-only"),
      "planner and Plan prompts should explain the on-demand read-only background status peek"
    );
    const emptyWorkspace = path.join(root, "empty-workspace");
    fs.mkdirSync(emptyWorkspace, { recursive: true });
    const emptyWorkspaceConfig = openFusionConfigContents({
      plannerModel: "openai/gpt-5.1",
      executorModel: "opencode/gpt-5.1-codex",
      cwd: emptyWorkspace
    });
    assert(
      emptyWorkspaceConfig.mcp === undefined &&
        Object.keys(emptyWorkspaceConfig.agent?.planner?.permission || {})[0] === "*" &&
        Object.keys(emptyWorkspaceConfig.agent?.plan?.permission || {})[0] === "*" &&
        Object.keys(emptyWorkspaceConfig.agent?.investigator?.permission || {})[0] === "*" &&
        resolveOpenCodePermission(
          emptyWorkspaceConfig.agent?.planner?.permission,
          "linear_create_issue"
        ) === "deny" &&
        emptyWorkspaceConfig.agent?.planner?.permission?.skill === "deny" &&
        emptyWorkspaceConfig.agent?.plan?.permission?.skill === "deny" &&
        emptyWorkspaceConfig.agent?.investigator?.permission?.skill === "deny" &&
        emptyWorkspaceConfig.agent?.executor?.permission === undefined,
      "Open Fusion read-only agent MCP lock must not depend on workspace .mcp.json being present"
    );
    assert(
      openFusionConfig.command?.delegate?.agent === "executor" &&
        openFusionConfig.command?.delegate?.model === "opencode/gpt-5.1-codex" &&
        openFusionConfig.command?.delegate?.subtask === true &&
        openFusionConfig.command?.review?.agent === "planner" &&
        openFusionConfig.command?.fusion?.model === "openai/gpt-5.1",
      "Open Fusion should expose native OpenCode slash commands for delegation and review"
    );
    assert(
      openFusionEnvConfig.agent?.planner?.prompt.includes("Open Fusion Planner") &&
        openFusionEnvConfig.agent?.executor?.prompt.includes("Open Fusion Executor") &&
        openFusionEnvConfig.command?.delegate?.template.includes("$ARGUMENTS"),
      "Open Fusion inline config should carry prompts and commands so env config can override project config"
    );
    assert(
      openFusionEnvConfig.agent?.planner?.prompt.includes("Workspace capabilities (MCP servers & skills)") &&
        openFusionEnvConfig.agent?.planner?.prompt.includes("reading `.mcp.json`") &&
        openFusionEnvConfig.agent?.planner?.prompt.includes("specific server/tool or skill") &&
        openFusionEnvConfig.agent?.plan?.prompt.includes("Workspace capabilities (MCP servers & skills)") &&
        openFusionEnvConfig.agent?.plan?.prompt.includes("skill's") &&
        openFusionEnvConfig.agent?.plan?.prompt.includes("`SKILL.md`") &&
        openFusionEnvConfig.agent?.executor?.prompt.includes("If the Planner names a specific MCP server/tool or skill") &&
        openFusionEnvConfig.command?.delegate?.template.includes("If the task names a specific MCP server/tool or skill"),
      "Open Fusion planner/plan should inspect workspace capabilities while executor and /delegate require real invocation evidence"
    );
    assert(
      openFusionEnvConfig.agent?.executor?.prompt.includes("Preflight named capabilities before building work on top of them") &&
        openFusionEnvConfig.agent?.executor?.prompt.includes("ASK_HUMAN when fixing it needs the user to connect, install, or authenticate") &&
        openFusionEnvConfig.command?.delegate?.template.includes("Preflight the named capability") &&
        openFusionEnvConfig.agent?.planner?.prompt.includes("unavailable or not connected") &&
        openFusionEnvConfig.agent?.planner?.prompt.includes("tell the user exactly which server"),
      "Open Fusion executor/delegate should preflight named capabilities and the planner should escalate not-connected capabilities to the user"
    );
    assert(
      openFusionEnvConfig.agent?.executor?.prompt.includes("another agent may be editing this checkout") &&
        openFusionEnvConfig.agent?.planner?.prompt.includes("files changing underneath it"),
      "Open Fusion prompts should carry the concurrent-edits (foreign drift) guidance"
    );
    assert(
      openFusionEnvConfig.agent?.executor?.prompt?.includes("Self-review loop (mandatory before returning control)") &&
        openFusionEnvConfig.agent?.executor?.prompt?.includes("one final review") &&
        openFusionEnvConfig.agent?.planner?.prompt?.includes("independent second gate") &&
        openFusionEnvConfig.command?.delegate?.template?.includes("self-review findings per pass"),
      "Open Fusion executor should carry the capped self-review loop with the planner as the independent second gate"
    );
    assert(
      openFusionEnvConfig.agent?.planner?.prompt?.includes("at least ONE independent check") &&
        openFusionEnvConfig.agent?.planner?.prompt?.includes("which independent check you performed") &&
        openFusionEnvConfig.agent?.planner?.prompt?.includes("does not earn an exemption") &&
        openFusionEnvConfig.agent?.executor?.prompt?.includes("verbatim primary artifacts") &&
        openFusionEnvConfig.command?.delegate?.template?.includes("Evidence must be verbatim"),
      "Open Fusion completion gate must be operational: mandatory independent check + verbatim evidence contract"
    );
    assert(
      openFusionEnvConfig.agent?.executor?.prompt?.includes(
        "Visual verification (mandatory when the outcome is visual)"
      ) &&
        openFusionEnvConfig.agent?.executor?.prompt?.includes(
          "open that image with your image-viewing tool"
        ) &&
        openFusionEnvConfig.agent?.executor?.prompt?.includes("not actually view") &&
        openFusionEnvConfig.command?.delegate?.template?.includes("actually view that image") &&
        openFusionEnvConfig.agent?.planner?.prompt?.includes(
          "never\n   verify a visual outcome"
        ),
      "Open Fusion must mandate visual verification: executor renders + views visual outcomes, planner rejects code-read-only verification of visual work"
    );
    assert(
      openFusionEnvConfig.agent?.planner?.prompt?.includes("switch families mid-thread") &&
        openFusionEnvConfig.agent?.planner?.prompt?.includes("at most one question") &&
        openFusionEnvConfig.agent?.executor?.prompt?.includes(
          "Never fabricate, approximate, or reconstruct command or test output"
        ),
      "Open Fusion prompts should carry the mid-thread identity, act-vs-ask, and anti-simulation clauses"
    );
    assert(
      openFusionEnvConfig.agent?.executor?.prompt?.includes("OPEN_FUSION_EXECUTOR_REPORT") &&
        openFusionEnvConfig.agent?.executor?.prompt?.includes(
          "Recommendation: COMPLETE | CONTINUE | ASK_HUMAN"
        ) &&
        openFusionEnvConfig.agent?.executor?.prompt?.includes("Use exactly one Recommendation token") &&
        openFusionEnvConfig.command?.delegate?.template?.includes("OPEN_FUSION_EXECUTOR_REPORT") &&
        openFusionEnvConfig.command?.delegate?.template?.includes(
          "Recommendation: COMPLETE | CONTINUE | ASK_HUMAN"
        ) &&
        openFusionEnvConfig.command?.delegate?.template?.includes("END_OPEN_FUSION_EXECUTOR_REPORT"),
      "Open Fusion executor and /delegate prompts should require a fixed parseable report block with an explicit Recommendation token"
    );
    assert(
      openFusionEnvConfig.agent?.planner?.prompt?.includes("Checkpointed delegation") &&
        openFusionEnvConfig.agent?.planner?.prompt?.includes("ONE milestone per task call") &&
        openFusionEnvConfig.agent?.planner?.prompt?.includes("Withholding forward knowledge") &&
        openFusionEnvConfig.agent?.planner?.prompt?.includes("BEFORE delegating the next milestone") &&
        openFusionEnvConfig.agent?.executor?.prompt?.includes("implement ONLY that milestone") &&
        openFusionEnvConfig.command?.delegate?.template?.includes("one milestone of a larger plan"),
      "Open Fusion checkpointed delegation must be wired: milestone plan + between-milestone review in the planner, milestone scope discipline in the executor and /delegate"
    );
    assert(
      openFusionEnvConfig.agent?.planner?.prompt?.includes("Independent parallel fan-out") &&
        openFusionEnvConfig.agent?.planner?.prompt?.includes("multiple task tool calls in one assistant turn") &&
        openFusionEnvConfig.agent?.planner?.prompt?.includes("genuinely independent") &&
        openFusionEnvConfig.agent?.planner?.prompt?.includes("Those remain sequential"),
      "Open Fusion planner should permit same-turn parallel task fan-out only for independent disjoint work"
    );
    assert(
      openFusionEnvConfig.agent?.planner?.prompt?.includes("Orchestration triage") &&
        openFusionEnvConfig.agent?.planner?.prompt?.includes("cheapest sufficient level") &&
        openFusionEnvConfig.agent?.planner?.prompt?.includes("parallel investigator scouts") &&
        openFusionEnvConfig.agent?.planner?.prompt?.includes("Never send the investigator for what one read answers"),
      "Open Fusion planner should carry the orchestration triage ladder"
    );
    assert(
      openFusionEnvConfig.agent?.planner?.prompt?.includes("verified, not assumed") &&
        openFusionEnvConfig.agent?.planner?.prompt?.includes("disjoint file ownership") &&
        openFusionEnvConfig.agent?.planner?.prompt?.includes("independent integration check"),
      "Open Fusion planner must verify parallelizability before executor fan-out and integration-check after"
    );
    assert(
      openFusionEnvConfig.agent?.plan?.prompt?.includes("parallel scouts") &&
        openFusionEnvConfig.agent?.plan?.prompt?.includes("skip the investigator when your own reads answer") &&
        openFusionEnvConfig.agent?.plan?.prompt?.includes("parallelizable"),
      "Open Fusion plan mode should right-size research with parallel scouts and mark parallelizable milestones"
    );
    assert(
      openFusionEnvConfig.agent?.investigator?.prompt?.includes("one of several scouts") &&
        openFusionEnvConfig.agent?.executor?.prompt?.includes("one of several executors running IN") &&
        openFusionEnvConfig.agent?.executor?.prompt?.includes("Touch ONLY files inside your delegated"),
      "Open Fusion investigator/executor prompts should carry the parallel-scope discipline"
    );
    assert(
      fs.existsSync(openFusionFiles.plannerPromptPath) &&
        fs.existsSync(openFusionFiles.planPromptPath) &&
        fs.existsSync(openFusionFiles.executorPromptPath) &&
        fs.existsSync(openFusionFiles.investigatorPromptPath) &&
        fs.existsSync(openFusionFiles.themePath) &&
        fs.existsSync(openFusionFiles.tuiConfigPath) &&
        fs.existsSync(openFusionFiles.modelStatePath) &&
        fs.existsSync(openFusionFiles.tuiPluginPath) &&
        fs.existsSync(path.join(openFusionFiles.commandsDir, "delegate.md")) &&
        fs.existsSync(path.join(openFusionFiles.commandsDir, "investigate.md")),
      "Open Fusion prompt/theme/TUI command/plugin files should be written"
    );
    const openFusionTuiConfig = JSON.parse(
      fs.readFileSync(openFusionFiles.tuiConfigPath, "utf8")
    );
    assert(
      Array.isArray(openFusionTuiConfig.plugin) &&
        openFusionTuiConfig.plugin[0] ===
          url.pathToFileURL(openFusionFiles.tuiPluginPath).href &&
        !openFusionFiles.tuiPluginPath.startsWith(
          `${openFusionFiles.configDir}${path.sep}`
        ),
      "tui.json must declare the TUI plugin (the TUI only loads declared plugins) and the plugin must live outside configDir so the server-side loader does not reject it"
    );
    const openFusionTuiPlugin = fs.readFileSync(openFusionFiles.tuiPluginPath, "utf8");
    assert(
      openFusionTuiPlugin.includes("slashName: 'brain-model'") &&
        openFusionTuiPlugin.includes("slashName: 'executor-model'") &&
        openFusionTuiPlugin.includes("api.keymap.dispatchCommand('model.list')") &&
        openFusionTuiPlugin.includes("api.command.register(() => commands.map"),
      "Open Fusion TUI plugin should register native Brain/Executor model slash commands"
    );
    assert(
      openFusionTuiPlugin.includes("api.client.provider.list()") &&
        openFusionTuiPlugin.includes("api.ui.DialogSelect({") &&
        openFusionTuiPlugin.includes("connected: new Set(") &&
        openFusionTuiPlugin.includes("opencode auth login") &&
        openFusionTuiPlugin.includes("value: '__custom__'"),
      "Open Fusion TUI plugin should pick Brain/Executor models from the provider catalog with auth flags"
    );
    assert(
      JSON.parse(fs.readFileSync(openFusionFiles.modelStatePath, "utf8"))
        .executorModel === "opencode/gpt-5.1-codex",
      "Open Fusion model state should persist pane-scoped model settings"
    );
    // No default models by design: an invalid (or missing) model id resolves
    // to "unset" and the generated config OMITS the model fields entirely —
    // opencode must never silently pick a vendor the user didn't choose.
    const unsetModelConfig = openFusionConfigContents({ plannerModel: "bad model id" });
    assert(
      unsetModelConfig.agent.planner.model === undefined &&
        unsetModelConfig.model === undefined &&
        unsetModelConfig.agent.executor.model === undefined &&
        !JSON.stringify(unsetModelConfig).includes('"model"'),
      "invalid or missing Open Fusion model ids must leave the generated config model-less, not fall back to a default"
    );

    // Saved pane models win over launch opts (the TUI pickers own them between
    // restarts), but invalid saved values must fall back to the launch opts.
    const paneTwoFirst = await manager.prepareOpenFusionFiles("pane-two", {
      plannerModel: "openai/gpt-5.1",
      executorModel: "opencode/gpt-5.1-codex"
    });
    fs.writeFileSync(
      paneTwoFirst.modelStatePath,
      `${JSON.stringify({ plannerModel: "auto", executorModel: "xai/grok-4" })}\n`
    );
    const paneTwoSecond = await manager.prepareOpenFusionFiles("pane-two", {
      plannerModel: "openai/gpt-5.1",
      executorModel: "opencode/gpt-5.1-codex"
    });
    assert(
      paneTwoSecond.env.VIBE_TERMINAL_OPEN_FUSION_PLANNER_MODEL === "openai/gpt-5.1" &&
        paneTwoSecond.env.VIBE_TERMINAL_OPEN_FUSION_EXECUTOR_MODEL === "xai/grok-4",
      "valid saved pane models should win over launch opts; invalid saved values should fall back to opts"
    );

    // Age-based GC: a pane dir untouched for over the max age is swept; a
    // fresh pane dir (its files are rewritten every launch) is preserved so
    // models.json keeps carrying TUI picker choices across restarts.
    const openFusionSessionsDir = path.dirname(paneTwoSecond.openFusionDir);
    const staleOpenFusionDir = path.join(openFusionSessionsDir, "session-stale-pane");
    fs.mkdirSync(staleOpenFusionDir, { recursive: true });
    fs.writeFileSync(path.join(staleOpenFusionDir, "models.json"), "{}\n");
    const staleStamp = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    fs.utimesSync(path.join(staleOpenFusionDir, "models.json"), staleStamp, staleStamp);
    fs.utimesSync(staleOpenFusionDir, staleStamp, staleStamp);
    const sweptOpenFusionDirs = cleanupStaleOpenFusionDirs(
      path.dirname(openFusionSessionsDir)
    );
    assert(
      sweptOpenFusionDirs.includes(staleOpenFusionDir) &&
        !fs.existsSync(staleOpenFusionDir) &&
        fs.existsSync(paneTwoSecond.modelStatePath),
      "stale Open Fusion pane dirs should be swept while fresh panes keep their saved models"
    );

    const badTokenStatus = await postWithBadToken(manager.callbackUrl());
    assert(badTokenStatus === 403, "bad telemetry token should be rejected");

    const literalArg = "literal%VIBE_SMOKE_SET%";
    const spacedArg = "x y";
    const providerArgsPath = path.join(root, "provider-args.json");
    const result =
      process.platform === "win32"
        ? await run(
            powershellCommand(),
            [
              "-NoProfile",
              "-ExecutionPolicy",
              "Bypass",
              "-Command",
              `codex --hello "a&b" '${literalArg}' "${spacedArg}"`
            ],
            {
              cwd: root,
              env: {
                ...process.env,
                ...instrumentation.env,
                VIBE_FAKE_PROVIDER_ARGS: providerArgsPath,
                VIBE_SMOKE_SET: "EXPANDED"
              }
            }
          )
        : await run(path.join(instrumentation.shimDir, "codex"), [
            "--hello",
            "a&b",
            literalArg,
            spacedArg
          ], {
            cwd: root,
            env: {
              ...process.env,
              ...instrumentation.env
            }
          });
    assert(
      result.code === 0,
      `wrapper should exit 0, got ${result.code}; stdout=${result.stdout}; stderr=${result.stderr}`
    );
    assert(
      result.stdout.includes("fake-codex"),
      "wrapper should forward to real provider command"
    );
    if (process.platform === "win32") {
      const providerArgs = JSON.parse(fs.readFileSync(providerArgsPath, "utf8"));
      const baseArgs = ["--hello", "a&b", literalArg, spacedArg];
      assert(
        JSON.stringify(providerArgs.slice(0, baseArgs.length)) ===
          JSON.stringify(baseArgs),
        `PowerShell shim should preserve provider argv; got ${JSON.stringify(providerArgs)}`
      );
      assert(
        providerArgs.includes("-c") &&
          providerArgs.some(
            (arg) => typeof arg === "string" && arg.startsWith("notify=[")
          ),
        `codex shim should inject the notify config; got ${JSON.stringify(providerArgs)}`
      );
      for (const eventName of [
        "UserPromptSubmit",
        "PermissionRequest",
        "PreToolUse",
        "PostToolUse"
      ]) {
        assert(
          providerArgs.some(
            (arg) =>
              typeof arg === "string" &&
              arg.startsWith(`hooks.${eventName}=`)
          ),
          `codex shim should inject the ${eventName} observer hook`
        );
      }

      const ptyResult = await runInWindowsPty("codex --tty-smoke", {
        cwd: root,
        env: {
          ...process.env,
          ...instrumentation.env,
          VIBE_FAKE_PROVIDER_ARGS: providerArgsPath
        }
      });
      assert(
        ptyResult.code === 0,
        `PTY shim should exit 0, got ${ptyResult.code}; output=${ptyResult.output}`
      );
      assert(
        ptyResult.output.includes("fake-codex-stdin-redirected=False"),
        `PTY shim should preserve terminal stdin; output=${ptyResult.output}`
      );

      writeFakeCmdProvider("codex");
      const previousSmokePath = process.env[pathKey];
      const cmdProviderArgsPath = path.join(root, "cmd-provider-args.json");
      try {
        process.env[pathKey] = cmdOnlyFakeBin;
        const cmdInstrumentation = await manager.prepareSession("pane-cmd");
        const cmdPtyResult = await runInWindowsPty("codex --cmd-tty-smoke", {
          cwd: root,
          env: {
            ...process.env,
            ...cmdInstrumentation.env,
            VIBE_FAKE_PROVIDER_ARGS: cmdProviderArgsPath
          }
        });
        assert(
          cmdPtyResult.code === 0,
          `CMD PTY shim should exit 0, got ${cmdPtyResult.code}; output=${cmdPtyResult.output}`
        );
        assert(
          cmdPtyResult.output.includes("cmd-fake-codex-stdin-is-tty=true"),
          `CMD PTY shim should preserve terminal stdin; output=${cmdPtyResult.output}`
        );
        manager.releaseSession("pane-cmd");
      } finally {
        process.env[pathKey] = previousSmokePath;
      }
    } else {
      assert(
        result.stdout.includes("--hello") &&
          result.stdout.includes("a&b") &&
          result.stdout.includes(literalArg),
        `wrapper should preserve provider arguments; stdout=${result.stdout}; stderr=${result.stderr}`
      );
    }

    const eventTypes = events.map((event) => event.type);
    assert(
      !eventTypes.includes("agent-telemetry"),
      "raw agent-telemetry event channel should no longer be emitted"
    );
    assert(
      events.some(
        (event) =>
          event.type === "agent-attention" &&
          event.id === "pane-one" &&
          event.attention.state === "completed"
      ),
      "completed attention event should be emitted"
    );

    // The notify program (used by the claude/codex hooks) POSTs a per-turn
    // attention event straight to the live callback server.
    const notifyInstrumentation = await manager.prepareSession("pane-notify");
    const notifyEnv = {
      ...process.env,
      ...notifyInstrumentation.env
    };
    const notifyResult =
      process.platform === "win32"
        ? await run(
            powershellCommand(),
            [
              "-NoProfile",
              "-ExecutionPolicy",
              "Bypass",
              "-File",
              notifyProgram,
              "agent.waiting"
            ],
            { cwd: root, env: notifyEnv }
          )
        : await run(notifyProgram, ["agent.waiting"], {
            cwd: root,
            env: notifyEnv
          });
    assert(
      notifyResult.code === 0,
      `notify program should exit 0, got ${notifyResult.code}; stderr=${notifyResult.stderr}`
    );
    assert(
      events.some(
        (event) =>
          event.type === "agent-attention" &&
          event.id === "pane-notify" &&
          event.attention.state === "waiting"
      ),
      "notify program should produce a waiting attention event"
    );

    // A turn-start hook (claude UserPromptSubmit/tool use) posts agent.running,
    // which the server turns into a dedicated agent-running event (the working
    // spinner), NOT an attention/unread signal. Use a fresh pane id so no earlier
    // attention event for it can mask the "no attention" assertion.
    const runningInstrumentation = await manager.prepareSession("pane-running");
    const runningEnv = { ...process.env, ...runningInstrumentation.env };
    const runningResult =
      process.platform === "win32"
        ? await run(
            powershellCommand(),
            [
              "-NoProfile",
              "-ExecutionPolicy",
              "Bypass",
              "-File",
              notifyProgram,
              "agent.running"
            ],
            { cwd: root, env: runningEnv }
          )
        : await run(notifyProgram, ["agent.running"], {
            cwd: root,
            env: runningEnv
          });
    assert(
      runningResult.code === 0,
      `notify program should exit 0 for agent.running, got ${runningResult.code}; stderr=${runningResult.stderr}`
    );
    assert(
      events.some(
        (event) =>
          event.type === "agent-running" && event.id === "pane-running"
      ),
      "agent.running should produce a dedicated agent-running event"
    );
    assert(
      !events.some(
        (event) =>
          event.type === "agent-attention" && event.id === "pane-running"
      ),
      "agent.running must not raise an attention/unread event"
    );
    assert(
      events.some(
        (event) =>
          event.type === "agent-running" &&
          event.id === "pane-running" &&
          event.turnStart === true
      ),
      "an undetailed agent.running is a genuine turn start (may override done/failed)"
    );

    // Mid-turn tool activity (claude PreToolUse/PostToolUse) carries the "tool"
    // detail and must be flagged turnStart:false so a hook POST racing past the
    // turn's Stop cannot resurrect a finished pane's spinner.
    const runNotify = async (sessionId, args) => {
      const sessionInstrumentation = await manager.prepareSession(sessionId);
      const sessionEnv = { ...process.env, ...sessionInstrumentation.env };
      return process.platform === "win32"
        ? run(
            powershellCommand(),
            [
              "-NoProfile",
              "-ExecutionPolicy",
              "Bypass",
              "-File",
              notifyProgram,
              ...args
            ],
            { cwd: root, env: sessionEnv }
          )
        : run(notifyProgram, args, {
            cwd: root,
            env: sessionEnv
          });
    };

    await runNotify("pane-tool", ["agent.running", "tool"]);
    assert(
      events.some(
        (event) =>
          event.type === "agent-running" &&
          event.id === "pane-tool" &&
          event.turnStart === false
      ),
      "a tool-detailed agent.running should be flagged turnStart:false"
    );

    // The claude permission Notification hook tags its wait "approval" so the
    // renderer can flip waiting->running on the user's answer keystroke.
    await runNotify("pane-approval", ["agent.waiting", "approval"]);
    assert(
      events.some(
        (event) =>
          event.type === "agent-attention" &&
          event.id === "pane-approval" &&
          event.attention.state === "waiting" &&
          event.attention.reason === "approval"
      ),
      "an approval-detailed agent.waiting should carry reason approval"
    );

    // Codex invokes the same notify program and appends its legacy JSON payload
    // as the second argument. Preserve its provider thread identity so the
    // renderer can reject a spawned subagent's completion for the root pane.
    await runNotify("pane-codex", [
      "agent.completed",
      '{"type":"agent-turn-complete","thread-id":"root-thread","turn-id":"root-turn"}'
    ]);
    const codexEvent = events.find(
      (event) =>
        event.type === "agent-attention" && event.id === "pane-codex"
    );
    assert(
      codexEvent &&
        codexEvent.provider === "codex" &&
        codexEvent.providerThreadId === "root-thread" &&
        codexEvent.providerTurnId === "root-turn" &&
        codexEvent.attention.state === "completed",
      "codex's appended JSON should forward provider thread and turn identity"
    );

    // Exercise the POSIX Node hook directly even when this smoke runs on
    // Windows, so its Codex JSON parser cannot drift from the PowerShell path.
    const posixCodexInstrumentation = await manager.prepareSession(
      "pane-codex-posix-parser"
    );
    const posixNotifyProgram = path.join(root, "notify-posix-parser.cjs");
    fs.writeFileSync(posixNotifyProgram, notifyHookSource());
    const posixNotifyResult = await run(
      process.execPath,
      [
        posixNotifyProgram,
        "agent.completed",
        '{"type":"agent-turn-complete","thread-id":"posix-thread","turn-id":"posix-turn"}'
      ],
      { cwd: root, env: { ...process.env, ...posixCodexInstrumentation.env } }
    );
    assert(
      posixNotifyResult.code === 0 &&
        events.some(
          (event) =>
            event.type === "agent-attention" &&
            event.id === "pane-codex-posix-parser" &&
            event.provider === "codex" &&
            event.providerThreadId === "posix-thread" &&
            event.providerTurnId === "posix-turn"
        ),
      "the POSIX notify hook should parse and forward valid Codex identity JSON"
    );

    // An incomplete JSON argument is not a trusted Codex payload and must
    // remain neither a known detail nor provider identity metadata.
    await runNotify("pane-codex-junk", [
      "agent.completed",
      '{"type":"agent-turn-complete","thread-id":"incomplete-thread"}'
    ]);
    const codexJunkEvent = events.find(
      (event) =>
        event.type === "agent-attention" && event.id === "pane-codex-junk"
    );
    assert(
      codexJunkEvent &&
        codexJunkEvent.provider === "codex" &&
        codexJunkEvent.providerThreadId === undefined &&
        codexJunkEvent.providerTurnId === undefined &&
        codexJunkEvent.attention.state === "completed" &&
        codexJunkEvent.attention.reason === "done",
      "unknown Codex notify JSON must be identified but not trusted as thread metadata"
    );

    const foreignProviderInstrumentation = await manager.prepareSession(
      "pane-foreign-provider"
    );
    const foreignProviderStatus = await postTelemetry(
      manager.callbackUrl(),
      "test-token",
      {
        type: "agent.completed",
        sessionId: "pane-foreign-provider",
        launchNonce:
          foreignProviderInstrumentation.env.VIBE_TERMINAL_LAUNCH_NONCE,
        provider: "claude",
        providerThreadId: "forged-thread",
        providerTurnId: "forged-turn"
      }
    );
    assert(
      foreignProviderStatus === 204,
      "foreign provider completion telemetry should remain accepted"
    );
    const foreignProviderEvent = events.find(
      (event) =>
        event.type === "agent-attention" &&
        event.id === "pane-foreign-provider"
    );
    assert(
      foreignProviderEvent &&
        foreignProviderEvent.provider === "claude" &&
        foreignProviderEvent.providerThreadId === undefined &&
        foreignProviderEvent.providerTurnId === undefined,
      "provider identity metadata should only be forwarded for Codex"
    );

    const backgroundInstrumentation = await manager.prepareSession("pane-background");
    const backgroundStatus = await postTelemetry(manager.callbackUrl(), "test-token", {
      type: "agent.backgroundActivity",
      sessionId: "pane-background",
      launchNonce: backgroundInstrumentation.env.VIBE_TERMINAL_LAUNCH_NONCE,
      provider: "claude",
      backgroundActivity: {
        active: true,
        count: 2,
        source: "opus",
        items: [{ id: "agent-1", label: "Review API", source: "opus" }],
        updatedAt: 123
      }
    });
    assert(backgroundStatus === 204, "background activity telemetry should be accepted");
    assert(
      events.some(
        (event) =>
          event.type === "agent-background-activity" &&
          event.id === "pane-background" &&
          event.backgroundActivity.count === 2
      ),
      "agent.backgroundActivity should produce a background activity status event"
    );

    // --- Cursor: one notify program backs both hooks. The running hook passes
    // the type as an argument; the stop hook passes none and derives it from the
    // JSON status piped on stdin. Both POST to the live callback. ---
    const cursorNotifyProgram =
      process.platform === "win32"
        ? path.join(manager.runDir, `${CURSOR_HOOK_MARKER}.ps1`)
        : path.join(manager.runDir, `${CURSOR_HOOK_MARKER}.sh`);
    assert(
      fs.existsSync(cursorNotifyProgram),
      "cursor notify program should be written for the run"
    );

    const runCursorNotify = async (sessionId, { args = [], stdin = "" } = {}) => {
      const cursorInstrumentation = await manager.prepareSession(sessionId);
      return new Promise((resolve, reject) => {
        const cursorEnv = {
          ...process.env,
          ...cursorInstrumentation.env
        };
        const child =
          process.platform === "win32"
            ? spawn(
                powershellCommand(),
                [
                  "-NoProfile",
                  "-ExecutionPolicy",
                  "Bypass",
                  "-File",
                  cursorNotifyProgram,
                  ...args
                ],
                { cwd: root, env: cursorEnv, stdio: ["pipe", "ignore", "pipe"] }
              )
            : spawn(cursorNotifyProgram, args, {
                cwd: root,
                env: cursorEnv,
                stdio: ["pipe", "ignore", "pipe"]
              });
        child.on("error", reject);
        child.on("exit", () => resolve());
        child.stdin.write(stdin);
        child.stdin.end();
      });
    };

    // Turn START: type from the argument, stdin (the prompt payload) drained and
    // ignored. Produces a dedicated agent-running event, not an attention/unread.
    await runCursorNotify("pane-cursor-run", {
      args: ["agent.running"],
      stdin: JSON.stringify({ hook_event_name: "beforeSubmitPrompt", prompt: "hi" })
    });
    // Turn END: no argument, type derived from the stdin status.
    await runCursorNotify("pane-cursor-done", {
      stdin: JSON.stringify({ hook_event_name: "stop", status: "completed" })
    });
    await runCursorNotify("pane-cursor-fail", {
      stdin: JSON.stringify({ hook_event_name: "stop", status: "error" })
    });
    await runCursorNotify("pane-cursor-abort", {
      stdin: JSON.stringify({ hook_event_name: "stop", status: "aborted" })
    });
    // The notify program POSTs and waits for the response, so the events have
    // landed by the time the child exits; a small grace window covers slack.
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert(
      events.some(
        (event) =>
          event.type === "agent-running" && event.id === "pane-cursor-run"
      ),
      "cursor beforeSubmitPrompt (agent.running arg) should produce an agent-running event"
    );
    assert(
      !events.some(
        (event) =>
          event.type === "agent-attention" && event.id === "pane-cursor-run"
      ),
      "cursor agent.running must not raise an attention/unread event"
    );
    assert(
      events.some(
        (event) =>
          event.type === "agent-attention" &&
          event.id === "pane-cursor-done" &&
          event.provider === "cursor" &&
          event.attention.state === "completed"
      ),
      "cursor stop status=completed should map to a completed attention event"
    );
    assert(
      events.some(
        (event) =>
          event.type === "agent-attention" &&
          event.id === "pane-cursor-fail" &&
          event.provider === "cursor" &&
          event.attention.state === "failed"
      ),
      "cursor stop status=error should map to a failed attention event"
    );
    // A user-aborted turn is not "done": it is the user's turn, i.e. waiting.
    assert(
      events.some(
        (event) =>
          event.type === "agent-attention" &&
          event.id === "pane-cursor-abort" &&
          event.provider === "cursor" &&
          event.attention.state === "waiting"
      ),
      "cursor stop status=aborted should map to a waiting attention event"
    );

    // The status->type mapping helper backs the stop behaviour.
    assert(
      cursorTypeFromStatus("completed") === "agent.completed" &&
        cursorTypeFromStatus("aborted") === "agent.waiting" &&
        cursorTypeFromStatus(undefined) === "agent.completed" &&
        cursorTypeFromStatus("error") === "agent.failed",
      "cursorTypeFromStatus should map error->failed, aborted->waiting, else completed"
    );

    // ensureCursorProjectHooks merges our env-guarded running + stop hooks into
    // the project .cursor/hooks.json idempotently, preserving the user's hooks.
    const cursorCwd = path.join(root, "cursor-proj");
    fs.mkdirSync(path.join(cursorCwd, ".cursor"), { recursive: true });
    fs.writeFileSync(
      path.join(cursorCwd, ".cursor", "hooks.json"),
      JSON.stringify(
        {
          version: 1,
          hooks: {
            stop: [{ command: "user-own-stop-hook" }],
            beforeSubmitPrompt: [{ command: "user-bsp-hook" }],
            afterFileEdit: [{ command: "user-afe-hook" }]
          }
        },
        null,
        2
      )
    );
    await manager.ensureCursorProjectHooks(cursorCwd);
    await manager.ensureCursorProjectHooks(cursorCwd);
    const mergedHooks = JSON.parse(
      fs.readFileSync(path.join(cursorCwd, ".cursor", "hooks.json"), "utf8")
    );
    const ourStop = mergedHooks.hooks.stop.filter((entry) =>
      entry.command.includes(CURSOR_HOOK_MARKER)
    );
    const ourRunning = mergedHooks.hooks.beforeSubmitPrompt.filter((entry) =>
      entry.command.includes(CURSOR_HOOK_MARKER)
    );
    assert(
      ourStop.length === 1 && ourRunning.length === 1,
      "cursor hook install should be idempotent (exactly one entry per event)"
    );
    assert(
      ourRunning[0].command.includes("agent.running") &&
        !ourStop[0].command.includes("agent.running"),
      "the running hook should carry the agent.running arg and the stop hook should not"
    );
    assert(
      mergedHooks.hooks.stop.some(
        (entry) => entry.command === "user-own-stop-hook"
      ) &&
        mergedHooks.hooks.beforeSubmitPrompt.some(
          (entry) => entry.command === "user-bsp-hook"
        ) &&
        mergedHooks.hooks.afterFileEdit?.[0]?.command === "user-afe-hook",
      "ensureCursorProjectHooks must preserve the user's existing hooks (incl. unrelated events)"
    );

    // A .cursor/hooks.json we create from scratch is removed on cleanup so we do
    // not leave a dangling entry pointing at a deleted run dir in the repo.
    const cursorFreshCwd = path.join(root, "cursor-proj-fresh");
    fs.mkdirSync(cursorFreshCwd, { recursive: true });
    await manager.ensureCursorProjectHooks(cursorFreshCwd);
    const cursorFreshFile = path.join(cursorFreshCwd, ".cursor", "hooks.json");
    assert(
      fs.existsSync(cursorFreshFile),
      "ensureCursorProjectHooks should create a hooks.json when none exists"
    );

    // A pre-existing but malformed hooks.json must NOT be clobbered.
    const cursorBadCwd = path.join(root, "cursor-proj-bad");
    fs.mkdirSync(path.join(cursorBadCwd, ".cursor"), { recursive: true });
    const badContent = "{ not valid json";
    fs.writeFileSync(
      path.join(cursorBadCwd, ".cursor", "hooks.json"),
      badContent
    );
    await manager.ensureCursorProjectHooks(cursorBadCwd);
    assert(
      fs.readFileSync(
        path.join(cursorBadCwd, ".cursor", "hooks.json"),
        "utf8"
      ) === badContent,
      "ensureCursorProjectHooks must not clobber an unparseable hooks.json"
    );

    // A stale/missing cwd must not be recreated just to install Cursor hooks.
    const cursorMissingCwd = path.join(root, "cursor-proj-missing");
    await manager.ensureCursorProjectHooks(cursorMissingCwd);
    assert(
      !fs.existsSync(cursorMissingCwd),
      "ensureCursorProjectHooks must not create a missing workspace cwd"
    );

    // mergeCursorHooks / stripCursorHooks unit behaviour with the real entry set.
    const entries = cursorHookEntries(
      "/run/vibeterminal-cursor-notify.sh",
      false
    );
    const mergedUnit = mergeCursorHooks(
      {
        version: 1,
        hooks: {
          stop: [{ command: "keep" }],
          afterFileEdit: [{ command: "user-afe" }]
        }
      },
      entries
    );
    assert(
      mergedUnit.hooks.stop.length === 2 &&
        mergedUnit.hooks.stop.some((entry) => entry.command === "keep") &&
        mergedUnit.hooks.beforeSubmitPrompt.length === 1 &&
        mergedUnit.hooks.afterFileEdit[0].command === "user-afe",
      "mergeCursorHooks should append our entries and preserve unrelated arrays"
    );
    const reMerged = mergeCursorHooks(mergedUnit, entries);
    assert(
      reMerged.hooks.stop.filter((entry) =>
        entry.command.includes(CURSOR_HOOK_MARKER)
      ).length === 1 &&
        reMerged.hooks.beforeSubmitPrompt.filter((entry) =>
          entry.command.includes(CURSOR_HOOK_MARKER)
        ).length === 1,
      "mergeCursorHooks should replace prior entries in every event array, not stack them"
    );
    // A malformed (array) hooks value must not crash or corrupt the merge.
    const mergedFromArray = mergeCursorHooks({ hooks: [] }, entries);
    assert(
      Array.isArray(mergedFromArray.hooks.stop) &&
        mergedFromArray.hooks.stop.length === 1,
      "mergeCursorHooks should recover from a non-object hooks value"
    );
    const stripped = stripCursorHooks(reMerged);
    assert(
      stripped.hasOtherContent === true &&
        !Object.values(stripped.trimmed.hooks)
          .flat()
          .some((entry) => entry.command.includes(CURSOR_HOOK_MARKER)) &&
        stripped.trimmed.hooks.stop.some((entry) => entry.command === "keep"),
      "stripCursorHooks should drop our entries from all arrays and keep user content"
    );

    // The opencode plugin source maps the documented opencode events, and infers
    // turn-start "working" from the message stream (throttled by a busy latch).
    const pluginSource = openCodePluginSource();
    assert(
      pluginSource.includes("session.idle") &&
        pluginSource.includes("permission.asked") &&
        pluginSource.includes("session.error"),
      "opencode plugin should map opencode lifecycle events"
    );
    assert(
      pluginSource.includes("agent.running") &&
        pluginSource.includes('startsWith("message.")') &&
        pluginSource.includes("busy"),
      "opencode plugin should infer agent.running from the throttled message stream"
    );
    // The busy latch must drop on EVERY mapped event, not only idle/error: the
    // approval that resumes a permission-paused turn has no event of its own,
    // so only the next message.* burst can re-assert "working" — and it can't
    // while the latch is still up. Version must bump with any source change or
    // installed copies never update.
    assert(
      pluginSource.includes("vibeterminal-notify-5") &&
        !pluginSource.includes("vibeterminal-notify-3") &&
        !pluginSource.includes("vibeterminal-notify-2") &&
        pluginSource.includes("busy = false;") &&
        !pluginSource.includes(
          'if (event.type === "session.idle" || event.type === "session.error") {'
        ),
      "opencode plugin should drop the busy latch on every mapped event (permission prompts included)"
    );
    assert(
      pluginSource.includes(
        'send(type, type === "agent.waiting" ? "approval" : undefined)'
      ),
      "opencode permission waits should be tagged as approvals"
    );
    // Child sessions (task-tool subagents, e.g. the Open Fusion executor) going
    // idle/erroring must not read as the pane's turn ending: they are tracked by
    // the parentID on session.created/updated info and filtered from the
    // idle/error mapping (fail-open: unknown payload shapes filter nothing).
    // Permission asks are never filtered.
    assert(
      pluginSource.includes("childSessions") &&
        pluginSource.includes("info.parentID") &&
        pluginSource.includes("childSessions.has(eventSessionId(event))") &&
        !pluginSource.includes('"permission.asked" ||'),
      "opencode plugin should ignore child-session idle/error but never filter permission asks"
    );

    // The claude settings builder targets the notify program on both platforms.
    const winCmd = JSON.parse(
      buildClaudeSettingsJson("C:\\x\\notify.ps1", true)
    ).hooks.Stop[0].hooks[0].command;
    assert(
      winCmd.includes("powershell") &&
        winCmd.includes("C:/x/notify.ps1") &&
        winCmd.includes("agent.completed"),
      `windows claude hook should invoke the notify ps1 via powershell; got ${winCmd}`
    );
    const posixCmd = JSON.parse(
      buildClaudeSettingsJson("/x/notify.sh", false)
    ).hooks.Notification[0].hooks[0].command;
    assert(
      posixCmd.includes("/x/notify.sh") && posixCmd.includes("agent.waiting"),
      `posix claude hook should invoke the notify wrapper; got ${posixCmd}`
    );
    const claudeHooks = JSON.parse(
      buildClaudeSettingsJson("/x/notify.sh", false)
    ).hooks;
    const runningCmd = claudeHooks.UserPromptSubmit[0].hooks[0].command;
    assert(
      runningCmd.includes("/x/notify.sh") && runningCmd.includes("agent.running"),
      `claude turn-start hook should fire agent.running; got ${runningCmd}`
    );
    // Only the turn START may override a finished pill; tool activity carries
    // the "tool" detail so the renderer routes it through the done/failed latch.
    assert(
      !runningCmd.includes("tool"),
      `claude UserPromptSubmit must be an undetailed (latch-overriding) turn start; got ${runningCmd}`
    );
    for (const hookEvent of ["PreToolUse", "PostToolUse"]) {
      const toolCmd = claudeHooks[hookEvent][0].hooks[0].command;
      assert(
        toolCmd.includes("'agent.running' 'tool'"),
        `claude ${hookEvent} should fire agent.running with the tool detail; got ${toolCmd}`
      );
    }
    // The Notification hook is split so approvals and idle prompts are
    // distinguishable: answering an approval flips waiting->running in the
    // renderer, composing after an idle prompt does not.
    assert(
      claudeHooks.Notification.length === 2 &&
        claudeHooks.Notification[0].matcher === "permission_prompt" &&
        claudeHooks.Notification[0].hooks[0].command.includes(
          "'agent.waiting' 'approval'"
        ) &&
        claudeHooks.Notification[1].matcher === "idle_prompt" &&
        claudeHooks.Notification[1].hooks[0].command.includes(
          "'agent.waiting' 'question'"
        ),
      "claude Notification hooks should tag approval vs idle waits"
    );
    const winToolCmd = JSON.parse(
      buildClaudeSettingsJson("C:\\x\\notify.ps1", true)
    ).hooks.PostToolUse[0].hooks[0].command;
    assert(
      winToolCmd.includes("agent.running tool"),
      `windows claude tool hook should pass the tool detail; got ${winToolCmd}`
    );
    // The kimi hook blocks carry the claude event set as config.toml TOML
    // ([[hooks]] tables), marker-tagged so merge/strip only ever touches
    // vibeTerminal's own entries.
    const kimiWinBlocks = kimiHookTomlBlocks("C:\\x\\notify.ps1", true);
    assert(
      (kimiWinBlocks.match(/# vibeterminal-kimi-notify/g) || []).length === 6 &&
        (kimiWinBlocks.match(/\[\[hooks\]\]/g) || []).length === 6,
      "kimi blocks should be six marker-tagged [[hooks]] tables"
    );
    assert(
      kimiWinBlocks.includes(
        'powershell -NoProfile -ExecutionPolicy Bypass -File "C:/x/notify.ps1"'
      ),
      `windows kimi hooks should invoke the notify ps1 via powershell; got ${kimiWinBlocks}`
    );
    const kimiPosixBlocks = kimiHookTomlBlocks("/x/notify.sh", false);
    const kimiEventCommand = (event) => {
      const match = kimiPosixBlocks.match(
        new RegExp(`event = '${event}'\\ncommand = (.*)`)
      );
      return match ? match[1] : "";
    };
    // Same semantics as claude: an undetailed (latch-overriding) turn start,
    // tool-tagged mid-turn activity, an approval-tagged wait, and
    // completed/failed turn ends.
    const kimiTurnStart = kimiEventCommand("UserPromptSubmit");
    assert(
      kimiTurnStart.includes("'/x/notify.sh' 'agent.running'") &&
        !kimiTurnStart.includes("tool"),
      `kimi UserPromptSubmit must be an undetailed turn start; got ${kimiTurnStart}`
    );
    for (const hookEvent of ["PreToolUse", "PostToolUse"]) {
      const toolCmd = kimiEventCommand(hookEvent);
      assert(
        toolCmd.includes("'agent.running' 'tool'"),
        `kimi ${hookEvent} should fire agent.running with the tool detail; got ${toolCmd}`
      );
    }
    assert(
      kimiEventCommand("PermissionRequest").includes(
        "'agent.waiting' 'approval'"
      ),
      "kimi PermissionRequest should fire agent.waiting with the approval detail"
    );
    assert(
      kimiEventCommand("Stop").includes("agent.completed") &&
        kimiEventCommand("StopFailure").includes("agent.failed"),
      "kimi Stop/StopFailure should fire agent.completed/agent.failed"
    );

    // The config.toml merge is conservative and idempotent: user content is
    // preserved byte-for-byte, repeated launches never duplicate blocks, and a
    // new run refreshes the (per-run) notify program path.
    const userToml = '[providers.kimi]\napi_key = "sk-x"\n';
    const mergedToml = mergeKimiHooks(userToml, kimiPosixBlocks);
    assert(
      mergeKimiHooks(mergedToml, kimiPosixBlocks) === mergedToml,
      "kimi config merge should be idempotent"
    );
    const strippedToml = stripKimiHooks(mergedToml);
    assert(
      strippedToml.trimmed === '[providers.kimi]\napi_key = "sk-x"' &&
        strippedToml.hasOtherContent,
      "kimi strip should restore the user's config exactly"
    );
    assert(
      !stripKimiHooks(mergeKimiHooks("", kimiPosixBlocks)).hasOtherContent,
      "a hooks-only config should strip back to empty"
    );
    const refreshedToml = mergeKimiHooks(mergedToml, kimiWinBlocks);
    assert(
      refreshedToml.includes("notify.ps1") && !refreshedToml.includes("notify.sh"),
      "a re-merge should refresh the notify program path"
    );

    // The kimi-custom fork gets the same hook set under its own marker, and
    // the two markers never strip each other's entries.
    const kimiCustomBlocks = kimiHookTomlBlocks(
      "/x/notify.sh",
      false,
      "vibeterminal-kimi-custom-notify"
    );
    assert(
      (kimiCustomBlocks.match(/# vibeterminal-kimi-custom-notify/g) || [])
        .length === 6,
      "kimi-custom blocks should be six marker-tagged [[hooks]] tables"
    );
    const bothMarkers = mergeKimiHooks(
      mergedToml,
      kimiCustomBlocks,
      "vibeterminal-kimi-custom-notify"
    );
    assert(
      bothMarkers.includes("# vibeterminal-kimi-notify") &&
        bothMarkers.includes("# vibeterminal-kimi-custom-notify"),
      "merging kimi-custom blocks must preserve the stock kimi ones"
    );
    const strippedCustom = stripKimiHooks(
      bothMarkers,
      "vibeterminal-kimi-custom-notify"
    );
    assert(
      strippedCustom.trimmed.includes("# vibeterminal-kimi-notify") &&
        !strippedCustom.trimmed.includes("# vibeterminal-kimi-custom-notify"),
      "stripping the kimi-custom marker must leave stock kimi blocks intact"
    );

    const signaledAttention = mapTelemetryToAttention({
      type: "agent.process.exited",
      exitCode: null,
      signal: "SIGTERM"
    });
    assert(
      signaledAttention.state === "failed",
      "signaled provider exits should not be marked completed"
    );

    const sessionDir = path.dirname(instrumentation.shimDir);
    manager.releaseSession("pane-one");
    assert(
      !fs.existsSync(sessionDir),
      "releaseSession should remove pane shim dir"
    );

    // ensureKimiHooks merges the blocks into $KIMI_CODE_HOME/config.toml;
    // manager.cleanup strips them back out (deleting a config it created).
    const kimiCreatedHome = path.join(root, "kimi-created-home");
    const kimiUserHome = path.join(root, "kimi-user-home");
    fs.mkdirSync(kimiUserHome, { recursive: true });
    fs.writeFileSync(
      path.join(kimiUserHome, "config.toml"),
      '[providers.kimi]\napi_key = "sk-x"\n'
    );

    process.env.KIMI_CODE_HOME = kimiCreatedHome;
    await manager.ensureKimiHooks();
    const kimiCreatedConfigPath = path.join(kimiCreatedHome, "config.toml");
    assert(
      fs
        .readFileSync(kimiCreatedConfigPath, "utf8")
        .includes("# vibeterminal-kimi-notify"),
      "ensureKimiHooks should create a hooks-only config when none exists"
    );

    process.env.KIMI_CODE_HOME = kimiUserHome;
    await manager.ensureKimiHooks();
    const kimiUserConfigPath = path.join(kimiUserHome, "config.toml");
    const kimiUserConfig = fs.readFileSync(kimiUserConfigPath, "utf8");
    assert(
      kimiUserConfig.includes('api_key = "sk-x"') &&
        kimiUserConfig.includes("# vibeterminal-kimi-notify"),
      "ensureKimiHooks should merge into an existing config without clobbering it"
    );
    await manager.ensureKimiHooks();
    assert(
      fs.readFileSync(kimiUserConfigPath, "utf8") === kimiUserConfig,
      "ensureKimiHooks should be idempotent across launches"
    );
    if (previousKimiCodeHome === undefined) {
      delete process.env.KIMI_CODE_HOME;
    } else {
      process.env.KIMI_CODE_HOME = previousKimiCodeHome;
    }

    // ensureKimiCustomHooks does the same into the fork's home (an explicit
    // override stands in for the shared $KIMI_CODE_HOME/~/.kimi-code
    // resolution), and manager.cleanup removes a config it created.
    const kimiCustomCreatedHome = path.join(root, "kimi-custom-created-home");
    await manager.ensureKimiCustomHooks(kimiCustomCreatedHome);
    const kimiCustomConfigPath = path.join(kimiCustomCreatedHome, "config.toml");
    const kimiCustomConfig = fs.readFileSync(kimiCustomConfigPath, "utf8");
    assert(
      kimiCustomConfig.includes("# vibeterminal-kimi-custom-notify") &&
        !kimiCustomConfig.includes("# vibeterminal-kimi-notify"),
      "ensureKimiCustomHooks should create a hooks-only config under its own marker"
    );
    await manager.ensureKimiCustomHooks(kimiCustomCreatedHome);
    assert(
      fs.readFileSync(kimiCustomConfigPath, "utf8") === kimiCustomConfig,
      "ensureKimiCustomHooks should be idempotent across launches"
    );

    const runDir = manager.runDir;
    manager.cleanup();
    manager = null;
    assert(!fs.existsSync(runDir), "manager.cleanup should remove the run dir");
    assert(
      !fs.existsSync(kimiCreatedConfigPath),
      "cleanup should remove a config.toml it created"
    );
    const strippedUserConfig = fs.readFileSync(kimiUserConfigPath, "utf8");
    assert(
      strippedUserConfig.includes('api_key = "sk-x"') &&
        !strippedUserConfig.includes("vibeterminal-kimi-notify"),
      "cleanup should strip our hook blocks but keep the user's config"
    );

    assert(
      !fs.existsSync(kimiCustomConfigPath),
      "cleanup should remove a kimi-custom config.toml it created"
    );

    console.log("Agent telemetry smoke passed");
  } finally {
    if (manager) {
      manager.cleanup();
    }
    process.env[pathKey] = previousPath;
    if (previousKimiCodeHome === undefined) {
      delete process.env.KIMI_CODE_HOME;
    } else {
      process.env.KIMI_CODE_HOME = previousKimiCodeHome;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
