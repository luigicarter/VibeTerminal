const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");
const {
  buildClaudeSettingsJson,
  cleanupStaleShimDirs,
  createAgentTelemetryManager,
  installOpenCodePlugin,
  mapTelemetryToAttention,
  openCodePluginSource
} = require("../../backend/agentTelemetry.cjs");

const rootDir = path.join(__dirname, "..", "..");
const root = path.join(
  rootDir,
  ".tmp",
  `agent-telemetry-smoke-${Date.now()}-${process.pid}`
);
const fakeBin = path.join(root, "fake-bin");
const cmdOnlyFakeBin = path.join(root, "fake-cmd-bin");
const shimBase = path.join(root, "shims");

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

    // The opencode plugin source maps the documented opencode events.
    const pluginSource = openCodePluginSource();
    assert(
      pluginSource.includes("session.idle") &&
        pluginSource.includes("permission.asked") &&
        pluginSource.includes("session.error"),
      "opencode plugin should map opencode lifecycle events"
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
