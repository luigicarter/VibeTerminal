const fs = require("fs");
const http = require("http");
const path = require("path");
const url = require("url");
const { spawn } = require("child_process");
const {
  buildClaudeSettingsJson,
  cleanupStaleOpenFusionDirs,
  cleanupStaleShimDirs,
  createAgentTelemetryManager,
  cursorHookEntries,
  cursorTypeFromStatus,
  installOpenCodePlugin,
  mapTelemetryToAttention,
  mergeCursorHooks,
  openFusionConfigContents,
  openCodePluginSource,
  stripCursorHooks
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

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
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

    const openFusionFiles = await manager.prepareOpenFusionFiles("pane-one", {
      plannerModel: "openai/gpt-5.1",
      executorModel: "opencode/gpt-5.1-codex"
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
    assert(
      openFusionConfig.default_agent === "planner" &&
        openFusionConfig.agent?.planner?.mode === "primary" &&
        openFusionConfig.agent?.planner?.model === "openai/gpt-5.1" &&
        openFusionConfig.agent?.planner?.permission?.bash === "deny" &&
        openFusionConfig.agent?.planner?.permission?.edit === "deny" &&
        openFusionConfig.agent?.planner?.permission?.task?.executor === "allow" &&
        openFusionConfig.agent?.planner?.permission?.task?.["*"] === "deny",
      "Open Fusion planner should be a read-only primary agent with task access"
    );
    assert(
      openFusionConfig.agent?.executor?.mode === "subagent" &&
        openFusionConfig.agent?.executor?.model === "opencode/gpt-5.1-codex",
      "Open Fusion executor should be a model-pinned subagent"
    );
    assert(
      openFusionConfig.agent?.planner?.permission?.task?.investigator === "allow" &&
        openFusionConfig.agent?.investigator?.mode === "subagent" &&
        openFusionConfig.agent?.investigator?.permission?.edit === "deny" &&
        openFusionConfig.agent?.investigator?.permission?.bash === "deny" &&
        openFusionConfig.agent?.investigator?.permission?.task?.["*"] === "deny" &&
        openFusionConfig.command?.investigate?.agent === "investigator" &&
        openFusionConfig.command?.investigate?.subtask === true,
      "Open Fusion investigator must be a hard read-only subagent (no edit/bash/task) reachable from the planner and /investigate"
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
      fs.existsSync(openFusionFiles.plannerPromptPath) &&
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
    assert(
      openFusionConfigContents({ plannerModel: "bad model id" }).agent.planner
        .model === "anthropic/claude-sonnet-4-5",
      "invalid Open Fusion model ids should fall back before writing config"
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
    const notifyEnv = {
      ...process.env,
      VIBE_TERMINAL_CALLBACK_URL: manager.callbackUrl(),
      VIBE_TERMINAL_TELEMETRY_TOKEN: "test-token",
      VIBE_TERMINAL_SESSION_ID: "pane-notify"
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
    const runningEnv = {
      ...notifyEnv,
      VIBE_TERMINAL_SESSION_ID: "pane-running"
    };
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
    const runNotify = (sessionId, args) =>
      process.platform === "win32"
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
            { cwd: root, env: { ...notifyEnv, VIBE_TERMINAL_SESSION_ID: sessionId } }
          )
        : run(notifyProgram, args, {
            cwd: root,
            env: { ...notifyEnv, VIBE_TERMINAL_SESSION_ID: sessionId }
          });

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

    // codex invokes the same notify program and appends its own JSON payload as
    // the second argument; an unknown detail must be dropped, not forwarded.
    await runNotify("pane-codex-junk", [
      "agent.completed",
      '{"type":"agent-turn-complete"}'
    ]);
    const codexJunkEvent = events.find(
      (event) =>
        event.type === "agent-attention" && event.id === "pane-codex-junk"
    );
    assert(
      codexJunkEvent && codexJunkEvent.attention.state === "completed",
      "codex's appended JSON arg must not break the completed notification"
    );

    const backgroundStatus = await postTelemetry(manager.callbackUrl(), "test-token", {
      type: "agent.backgroundActivity",
      sessionId: "pane-background",
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

    const runCursorNotify = (sessionId, { args = [], stdin = "" } = {}) =>
      new Promise((resolve, reject) => {
        const cursorEnv = {
          ...process.env,
          VIBE_TERMINAL_CALLBACK_URL: manager.callbackUrl(),
          VIBE_TERMINAL_TELEMETRY_TOKEN: "test-token",
          VIBE_TERMINAL_SESSION_ID: sessionId
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
      pluginSource.includes("vibeterminal-notify-4") &&
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

    const runDir = manager.runDir;
    manager.cleanup();
    manager = null;
    assert(!fs.existsSync(runDir), "manager.cleanup should remove the run dir");

    console.log("Agent telemetry smoke passed");
  } finally {
    if (manager) {
      manager.cleanup();
    }
    process.env[pathKey] = previousPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
