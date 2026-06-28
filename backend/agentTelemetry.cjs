const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const SHIM_BASE_DIR =
  process.env.VIBE_AGENT_SHIM_BASE_DIR ||
  path.join(process.cwd(), ".tmp", "vibe-agent-shims");
const OWNER_MARKER = ".vibe-agent-shims.json";
const MAX_EVENT_BYTES = 64 * 1024;
const MAX_SESSION_ID_BYTES = 512;
const PROVIDERS = ["codex", "claude", "opencode"];

function pathEnvKey(env = process.env, platform = process.platform) {
  if (platform !== "win32") {
    return "PATH";
  }

  const matchingKey = Object.keys(env).find((key) => key.toLowerCase() === "path");
  return matchingKey || "Path";
}

function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function safeRemoveDir(target, baseDir = SHIM_BASE_DIR) {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(target);
  if (!isInside(resolvedBase, resolvedTarget)) {
    return false;
  }

  try {
    fs.rmSync(resolvedTarget, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100
    });
    return true;
  } catch {
    return false;
  }
}

function isProcessAlive(pid) {
  const normalizedPid = Number(pid);
  if (!Number.isInteger(normalizedPid) || normalizedPid <= 0) {
    return false;
  }

  try {
    process.kill(normalizedPid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function readMarker(dir) {
  try {
    const marker = JSON.parse(
      fs.readFileSync(path.join(dir, OWNER_MARKER), "utf8")
    );
    return marker?.owner === "vibeTerminal-agent-shims" ? marker : null;
  } catch {
    return null;
  }
}

function writeMarker(dir, marker) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, OWNER_MARKER),
    `${JSON.stringify(
      {
        owner: "vibeTerminal-agent-shims",
        pid: process.pid,
        createdAt: new Date().toISOString(),
        ...marker
      },
      null,
      2
    )}\n`
  );
}

function cleanupStaleShimDirs(options = {}) {
  const baseDir = options.baseDir || SHIM_BASE_DIR;
  const currentRunId = options.currentRunId;

  if (!fs.existsSync(baseDir)) {
    return [];
  }

  const removed = [];
  for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const entryPath = path.join(baseDir, entry.name);
    const marker = readMarker(entryPath);
    if (!marker || marker.runId === currentRunId) {
      continue;
    }

    if (!options.removeLive && isProcessAlive(marker.pid)) {
      continue;
    }

    if (safeRemoveDir(entryPath, baseDir)) {
      removed.push(entryPath);
    }
  }

  return removed;
}

function quoteCmd(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function quotePowerShell(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function windowsPowerShellCommand() {
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

function windowsPowerShellShimSource(provider) {
  return [
    "$ErrorActionPreference = 'Continue'",
    `$Provider = ${quotePowerShell(provider)}`,
    "$ProviderArgs = @($args)",
    "",
    "function Send-VibeEvent {",
    "  param([string]$Type, [hashtable]$Extra)",
    "  if ([string]::IsNullOrEmpty($env:VIBE_TERMINAL_CALLBACK_URL) -or [string]::IsNullOrEmpty($env:VIBE_TERMINAL_TELEMETRY_TOKEN) -or [string]::IsNullOrEmpty($env:VIBE_TERMINAL_SESSION_ID)) {",
    "    return",
    "  }",
    "",
    "  try {",
    "    $payload = [ordered]@{",
    "      type = $Type",
    "      provider = $Provider",
    "      sessionId = $env:VIBE_TERMINAL_SESSION_ID",
    "      argv = @($ProviderArgs)",
    "      cwd = (Get-Location).ProviderPath",
    "      pid = $PID",
    "      timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()",
    "    }",
    "",
    "    if ($Extra) {",
    "      foreach ($key in $Extra.Keys) {",
    "        $payload[$key] = $Extra[$key]",
    "      }",
    "    }",
    "",
    "    $body = $payload | ConvertTo-Json -Compress -Depth 8",
    "    $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)",
    "    $request = [System.Net.WebRequest]::Create($env:VIBE_TERMINAL_CALLBACK_URL)",
    "    $request.Method = 'POST'",
    "    $request.Timeout = 1000",
    "    $request.ContentType = 'application/json'",
    "    $request.ContentLength = $bytes.Length",
    "    $request.Headers.Set('x-vibe-telemetry-token', $env:VIBE_TERMINAL_TELEMETRY_TOKEN)",
    "    $stream = $request.GetRequestStream()",
    "    try {",
    "      $stream.Write($bytes, 0, $bytes.Length)",
    "    } finally {",
    "      $stream.Dispose()",
    "    }",
    "    $response = $request.GetResponse()",
    "    if ($response) {",
    "      $response.Dispose()",
    "    }",
    "  } catch {",
    "    return",
    "  }",
    "}",
    "",
    "function Get-CommandCandidates {",
    "  param([string]$Command)",
    "  if ([System.IO.Path]::GetFileName($Command) -ne $Command) {",
    "    return @($Command)",
    "  }",
    "",
    "  $preferred = @('.exe', '.ps1', '.cmd', '.bat', '.com')",
    "  $pathExt = @()",
    "  if (-not [string]::IsNullOrEmpty($env:PATHEXT)) {",
    "    $pathExt = $env:PATHEXT -split ';' | Where-Object { $_ }",
    "  }",
    "",
    "  $extensions = @()",
    "  foreach ($extension in @($preferred + $pathExt)) {",
    "    $normalized = $extension.Trim()",
    "    if (-not $normalized) {",
    "      continue",
    "    }",
    "    if (-not $normalized.StartsWith('.')) {",
    "      $normalized = '.' + $normalized",
    "    }",
    "    $lower = $normalized.ToLowerInvariant()",
    "    if ($extensions -notcontains $lower) {",
    "      $extensions += $lower",
    "    }",
    "  }",
    "",
    "  $names = @()",
    "  foreach ($extension in $extensions) {",
    '    $names += "$Command$extension"',
    "  }",
    "  return $names",
    "}",
    "",
    "function Resolve-RealCommand {",
    "  param([string]$Command)",
    "  $originalPath = $env:VIBE_TERMINAL_ORIGINAL_PATH",
    "  if ([string]::IsNullOrEmpty($originalPath)) {",
    "    return $null",
    "  }",
    "",
    "  $separator = [Regex]::Escape([string][System.IO.Path]::PathSeparator)",
    "  foreach ($dir in ($originalPath -split $separator)) {",
    "    if ([string]::IsNullOrWhiteSpace($dir)) {",
    "      continue",
    "    }",
    "",
    "    foreach ($candidate in (Get-CommandCandidates $Command)) {",
    "      $filePath = Join-Path $dir $candidate",
    "      if (Test-Path -LiteralPath $filePath -PathType Leaf) {",
    "        return (Resolve-Path -LiteralPath $filePath).ProviderPath",
    "      }",
    "    }",
    "  }",
    "",
    "  return $null",
    "}",
    "",
    "function Get-PowerShellCommand {",
    "  $candidate = Join-Path $PSHOME 'powershell.exe'",
    "  if (Test-Path -LiteralPath $candidate -PathType Leaf) {",
    "    return $candidate",
    "  }",
    "  return 'powershell.exe'",
    "}",
    "",
    "$Command = Resolve-RealCommand $Provider",
    "if (-not $Command) {",
    "  $message = 'vibeTerminal: could not find real ' + $Provider + ' executable on the original PATH.'",
    "  Send-VibeEvent 'agent.process.exited' @{ exitCode = 127; error = $message }",
    "  [Console]::Error.WriteLine($message)",
    "  exit 127",
    "}",
    "",
    "# Inject per-turn notification hooks for the threaded agents (see agentTelemetry.cjs).",
    "if ($Provider -eq 'claude' -and -not [string]::IsNullOrEmpty($env:VIBE_TERMINAL_CLAUDE_SETTINGS)) {",
    "  $ProviderArgs = @($ProviderArgs) + @('--settings', $env:VIBE_TERMINAL_CLAUDE_SETTINGS)",
    "}",
    "elseif ($Provider -eq 'codex' -and -not [string]::IsNullOrEmpty($env:VIBE_TERMINAL_NOTIFY_PROGRAM)) {",
    "  $notifyValue = \"notify=['powershell','-NoProfile','-ExecutionPolicy','Bypass','-File','$($env:VIBE_TERMINAL_NOTIFY_PROGRAM)','agent.completed']\"",
    "  $ProviderArgs = @($ProviderArgs) + @('-c', $notifyValue)",
    "}",
    "",
    "$env:Path = $env:VIBE_TERMINAL_ORIGINAL_PATH",
    "$ExitCode = 0",
    "$global:LASTEXITCODE = $null",
    "try {",
    "  $extension = [System.IO.Path]::GetExtension($Command).ToLowerInvariant()",
    "  if ($extension -eq '.ps1') {",
    "    & (Get-PowerShellCommand) -NoProfile -ExecutionPolicy Bypass -File $Command @ProviderArgs",
    "  } else {",
    "    & $Command @ProviderArgs",
    "  }",
    "",
    "  if ($null -ne $global:LASTEXITCODE) {",
    "    $ExitCode = [int]$global:LASTEXITCODE",
    "  } elseif (-not $?) {",
    "    $ExitCode = 1",
    "  }",
    "} catch {",
    "  $ExitCode = 1",
    "  [Console]::Error.WriteLine($_.Exception.Message)",
    "}",
    "",
    "Send-VibeEvent 'agent.process.exited' @{ exitCode = $ExitCode }",
    "exit $ExitCode"
  ].join(os.EOL);
}

function writeWrapper(shimDir, provider, runnerPath, nodePath) {
  if (process.platform === "win32") {
    const psWrapperPath = path.join(shimDir, `${provider}.ps1`);
    fs.writeFileSync(psWrapperPath, windowsPowerShellShimSource(provider));

    const wrapperPath = path.join(shimDir, `${provider}.cmd`);
    fs.writeFileSync(
      wrapperPath,
      [
        "@echo off",
        `${quoteCmd(windowsPowerShellCommand())} -NoProfile -ExecutionPolicy Bypass -File ${quoteCmd(psWrapperPath)} %*`,
        "exit /b %ERRORLEVEL%"
      ].join(os.EOL)
    );
    return wrapperPath;
  }

  const wrapperPath = path.join(shimDir, provider);
  fs.writeFileSync(
    wrapperPath,
    [
      "#!/usr/bin/env sh",
      `exec ${JSON.stringify(nodePath)} ${JSON.stringify(runnerPath)} ${JSON.stringify(provider)} "$@"`
    ].join("\n")
  );
  fs.chmodSync(wrapperPath, 0o755);
  return wrapperPath;
}

function normalizeSessionId(sessionId) {
  if (
    typeof sessionId !== "string" ||
    sessionId.length === 0 ||
    Buffer.byteLength(sessionId, "utf8") > MAX_SESSION_ID_BYTES
  ) {
    return null;
  }

  return sessionId;
}

function sessionDirName(sessionId) {
  const readable =
    sessionId
      .replace(/[^a-zA-Z0-9_-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 32) || "session";
  const hash = crypto
    .createHash("sha256")
    .update(sessionId)
    .digest("hex")
    .slice(0, 16);
  return `${readable}-${hash}`;
}

function shimRunnerSource() {
  return String.raw`const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");

const provider = process.argv[2];
let args = process.argv.slice(3);
const callbackUrl = process.env.VIBE_TERMINAL_CALLBACK_URL;
const token = process.env.VIBE_TERMINAL_TELEMETRY_TOKEN;
const sessionId = process.env.VIBE_TERMINAL_SESSION_ID;
const originalPath = process.env.VIBE_TERMINAL_ORIGINAL_PATH || "";

function pathKey(env = process.env) {
  if (process.platform !== "win32") return "PATH";
  return Object.keys(env).find((key) => key.toLowerCase() === "path") || "Path";
}

function post(event) {
  if (!callbackUrl || !token || !sessionId) return Promise.resolve();
  const body = JSON.stringify({
    ...event,
    provider,
    sessionId,
    argv: args,
    cwd: process.cwd(),
    pid: process.pid,
    timestamp: Date.now()
  });

  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(callbackUrl);
    } catch {
      resolve();
      return;
    }

    const request = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "POST",
      timeout: 1000,
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        "x-vibe-telemetry-token": token
      }
    }, (response) => {
      response.resume();
      response.on("end", resolve);
    });

    request.on("error", resolve);
    request.on("timeout", () => {
      request.destroy();
      resolve();
    });
    request.end(body);
  });
}

function candidates(command) {
  if (path.basename(command) !== command) return [command];
  if (process.platform !== "win32") return [command];
  const preferredExtensions = [".EXE", ".PS1", ".CMD", ".BAT", ".COM"];
  const pathext = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean);
  const extensions = Array.from(new Set(preferredExtensions.concat(pathext)));
  return extensions.flatMap((extension) => [
    command + extension.toLowerCase(),
    command + extension.toUpperCase()
  ]);
}

function resolveRealCommand(command) {
  const pathParts = originalPath.split(path.delimiter).filter(Boolean);
  for (const dir of pathParts) {
    for (const candidate of candidates(command)) {
      const filePath = path.join(dir, candidate);
      try {
        if (fs.statSync(filePath).isFile()) {
          return filePath;
        }
      } catch {
        // Keep searching.
      }
    }
  }
  return null;
}

function quoteForCmd(value) {
  return "\"" + String(value).replace(/"/g, "\"\"") + "\"";
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
  try {
    if (fs.statSync(candidate).isFile()) return candidate;
  } catch {
    // Fall back to PATH lookup below.
  }
  return "powershell.exe";
}

(async () => {
  const env = { ...process.env };
  env[pathKey(env)] = originalPath;

  const command = resolveRealCommand(provider);
  if (!command) {
    await post({
      type: "agent.process.exited",
      exitCode: 127,
      error: "Could not find real " + provider + " executable on the original PATH."
    });
    process.stderr.write("vibeTerminal: could not find real " + provider + " executable on the original PATH.\n");
    process.exit(127);
  }

  // Inject per-turn notification hooks for the threaded agents (see agentTelemetry.cjs).
  if (provider === "claude" && process.env.VIBE_TERMINAL_CLAUDE_SETTINGS) {
    args = args.concat(["--settings", process.env.VIBE_TERMINAL_CLAUDE_SETTINGS]);
  } else if (provider === "codex" && process.env.VIBE_TERMINAL_NOTIFY_PROGRAM) {
    args = args.concat([
      "-c",
      "notify=['" + process.env.VIBE_TERMINAL_NOTIFY_PROGRAM + "','agent.completed']"
    ]);
  }

  const isWindowsCommandScript =
    process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
  const isWindowsPowerShellScript =
    process.platform === "win32" && /\.ps1$/i.test(command);
  const child = isWindowsPowerShellScript
    ? spawn(powershellCommand(), [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        command,
        ...args
      ], {
        env,
        stdio: "inherit"
      })
    : isWindowsCommandScript
      ? spawn(process.env.ComSpec || "cmd.exe", [
        "/d",
        "/c",
        "\"" + [quoteForCmd(command)].concat(args.map(quoteForCmd)).join(" ") + "\""
      ], {
        env,
        stdio: "inherit",
        windowsVerbatimArguments: true
      })
    : spawn(command, args, {
        env,
        stdio: "inherit"
      });

  child.on("error", async (error) => {
    await post({
      type: "agent.process.exited",
      exitCode: 127,
      error: error.message
    });
    process.stderr.write(error.message + "\n");
    process.exit(127);
  });

  child.on("exit", async (code, signal) => {
    await post({
      type: "agent.process.exited",
      exitCode: code,
      signal
    });
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
})();`;
}

// Tiny Node script (POSIX) that POSTs a single attention event to the local
// telemetry callback. Invoked by the per-provider hooks as
// `node notify-hook.cjs <agent.completed|agent.waiting|agent.failed>`. It reads
// the pane id and callback details from the env the shim injected, ignores any
// extra args (codex appends a JSON payload) and stdin (claude pipes hook JSON),
// and exits quietly when run outside vibeTerminal.
function notifyHookSource() {
  return String.raw`const http = require("http");

const type = process.argv[2];
const callbackUrl = process.env.VIBE_TERMINAL_CALLBACK_URL;
const token = process.env.VIBE_TERMINAL_TELEMETRY_TOKEN;
const sessionId = process.env.VIBE_TERMINAL_SESSION_ID;

if (!type || !callbackUrl || !token || !sessionId) {
  process.exit(0);
}

const body = JSON.stringify({ type, sessionId, timestamp: Date.now() });

let url;
try {
  url = new URL(callbackUrl);
} catch {
  process.exit(0);
}

const request = http.request(
  {
    hostname: url.hostname,
    port: url.port,
    path: url.pathname,
    method: "POST",
    timeout: 1000,
    headers: {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
      "x-vibe-telemetry-token": token
    }
  },
  (response) => {
    response.resume();
    response.on("end", () => process.exit(0));
  }
);

request.on("error", () => process.exit(0));
request.on("timeout", () => {
  request.destroy();
  process.exit(0);
});
request.end(body);
`;
}

// Windows notify program body (PowerShell). Same contract as notifyHookSource
// but implemented without Node so it works regardless of whether the user has
// `node` on PATH. `$args[0]` is the attention type.
function windowsNotifyPs1Source() {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$Type = $args[0]",
    "if ([string]::IsNullOrEmpty($Type) -or [string]::IsNullOrEmpty($env:VIBE_TERMINAL_CALLBACK_URL) -or [string]::IsNullOrEmpty($env:VIBE_TERMINAL_TELEMETRY_TOKEN) -or [string]::IsNullOrEmpty($env:VIBE_TERMINAL_SESSION_ID)) {",
    "  exit 0",
    "}",
    "try {",
    "  $payload = [ordered]@{",
    "    type = $Type",
    "    sessionId = $env:VIBE_TERMINAL_SESSION_ID",
    "    timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()",
    "  }",
    "  $body = $payload | ConvertTo-Json -Compress",
    "  $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)",
    "  $request = [System.Net.WebRequest]::Create($env:VIBE_TERMINAL_CALLBACK_URL)",
    "  $request.Method = 'POST'",
    "  $request.Timeout = 1000",
    "  $request.ContentType = 'application/json'",
    "  $request.ContentLength = $bytes.Length",
    "  $request.Headers.Set('x-vibe-telemetry-token', $env:VIBE_TERMINAL_TELEMETRY_TOKEN)",
    "  $stream = $request.GetRequestStream()",
    "  try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }",
    "  $response = $request.GetResponse()",
    "  if ($response) { $response.Dispose() }",
    "} catch {",
    "  exit 0",
    "}",
    "exit 0"
  ].join(os.EOL);
}

// POSIX notify program: a shell wrapper that runs the Node hook. Forces
// ELECTRON_RUN_AS_NODE so the bundled Electron binary behaves as Node when it
// is used as the runtime (a no-op for a real `node`).
function posixNotifyShSource(nodePath, notifyHookPath) {
  return [
    "#!/usr/bin/env sh",
    `ELECTRON_RUN_AS_NODE=1 exec ${JSON.stringify(nodePath)} ${JSON.stringify(
      notifyHookPath
    )} "$@"`
  ].join("\n");
}

// Per-session claude settings file passed via `claude --settings <file>`. Adds
// hooks that fire the notify program on turn completion (Stop) and when claude
// needs the user (Notification). `--settings` merges over the user's own
// settings without mutating ~/.claude.
function buildClaudeSettingsJson(scriptPath, isWin) {
  const hook = (type) => {
    // Keep the command shell-agnostic so it works whatever shell claude runs
    // hooks under: on Windows invoke powershell explicitly against the .ps1
    // (forward slashes dodge backslash-escaping in any shell); on POSIX run the
    // executable notify wrapper directly.
    const command = isWin
      ? `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath.replace(
          /\\/g,
          "/"
        )}" ${type}`
      : `'${scriptPath}' '${type}'`;
    return { type: "command", command, timeout: 5 };
  };

  const settings = {
    hooks: {
      Stop: [{ matcher: "*", hooks: [hook("agent.completed")] }],
      Notification: [
        {
          matcher: "permission_prompt|idle_prompt",
          hooks: [hook("agent.waiting")]
        }
      ]
    }
  };

  return `${JSON.stringify(settings, null, 2)}\n`;
}

const OPENCODE_PLUGIN_VERSION = "vibeterminal-notify-1";

// opencode cannot take a per-invocation hook, so we install one small plugin in
// the user's opencode config. It is guarded: it only POSTs when the
// VIBE_TERMINAL_* env vars are present, so a plain `opencode` run does nothing.
function openCodePluginSource() {
  return [
    `// vibeterminal-notify (${OPENCODE_PLUGIN_VERSION}) - auto-generated by vibeTerminal.`,
    "// Safe no-op outside vibeTerminal: only POSTs when VIBE_TERMINAL_* env vars are set.",
    "export const VibeTerminalNotify = async () => ({",
    "  event: async ({ event }) => {",
    "    const url = process.env.VIBE_TERMINAL_CALLBACK_URL;",
    "    const token = process.env.VIBE_TERMINAL_TELEMETRY_TOKEN;",
    "    const sessionId = process.env.VIBE_TERMINAL_SESSION_ID;",
    '    if (!url || !token || !sessionId || !event || typeof event.type !== "string") {',
    "      return;",
    "    }",
    "    const map = {",
    '      "session.idle": "agent.completed",',
    '      "permission.asked": "agent.waiting",',
    '      "permission.updated": "agent.waiting",',
    '      "session.error": "agent.failed"',
    "    };",
    "    const type = map[event.type];",
    "    if (!type) {",
    "      return;",
    "    }",
    "    try {",
    "      await fetch(url, {",
    '        method: "POST",',
    "        headers: {",
    '          "content-type": "application/json",',
    '          "x-vibe-telemetry-token": token',
    "        },",
    '        body: JSON.stringify({ type, sessionId, provider: "opencode", timestamp: Date.now() })',
    "      });",
    "    } catch (_error) {",
    "      // Telemetry is best-effort; ignore delivery failures.",
    "    }",
    "  }",
    "});",
    ""
  ].join("\n");
}

function installOpenCodePlugin(homeDir = os.homedir()) {
  try {
    const base = path.join(homeDir, ".config", "opencode");
    if (!fs.existsSync(base)) {
      // User has no opencode config yet; install lazily on a later launch.
      return;
    }

    const source = openCodePluginSource();
    // opencode has used both "plugin" and "plugins" for its local-plugin dir
    // across versions; write to both so discovery does not depend on the spelling.
    for (const dirName of ["plugin", "plugins"]) {
      const file = path.join(base, dirName, "vibeterminal-notify.js");
      try {
        if (fs.readFileSync(file, "utf8").includes(OPENCODE_PLUGIN_VERSION)) {
          continue;
        }
      } catch {
        // Not present or unreadable: fall through and (re)write it.
      }
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, source);
      } catch {
        // Best-effort; never let plugin install break telemetry startup.
      }
    }
  } catch {
    // Never let opencode plugin install break the telemetry manager.
  }
}

function mapTelemetryToAttention(event) {
  if (event.type === "agent.process.exited") {
    const hasSignal = Boolean(event.signal);
    const exitCode =
      event.exitCode === undefined || event.exitCode === null
        ? null
        : Number(event.exitCode);
    const completed = !hasSignal && exitCode === 0;
    return {
      state: completed ? "completed" : "failed",
      reason: completed ? "done" : "exit",
      source: "shim",
      message: event.error || (hasSignal ? `Exited with signal ${event.signal}.` : undefined),
      updatedAt: Date.now()
    };
  }

  if (event.type === "agent.waiting") {
    return {
      state: "waiting",
      reason: event.reason === "approval" ? "approval" : "question",
      source: "provider",
      message: event.message,
      updatedAt: Date.now()
    };
  }

  if (event.type === "agent.completed") {
    return {
      state: "completed",
      reason: "done",
      source: "provider",
      message: event.message,
      updatedAt: Date.now()
    };
  }

  if (event.type === "agent.failed") {
    return {
      state: "failed",
      reason: "error",
      source: "provider",
      message: event.message,
      updatedAt: Date.now()
    };
  }

  return null;
}

function createAgentTelemetryManager(options = {}) {
  const baseDir = options.baseDir || SHIM_BASE_DIR;
  const emit = options.emit || (() => {});
  const runId = options.runId || `${Date.now()}-${process.pid}-${crypto.randomUUID()}`;
  const token = options.token || crypto.randomBytes(32).toString("hex");
  const nodePath = options.nodePath || process.execPath;
  const runDir = path.join(baseDir, runId);
  const runnerPath = path.join(runDir, "shim-runner.cjs");
  const isWin = process.platform === "win32";
  const notifyHookPath = path.join(runDir, "notify-hook.cjs");
  const notifyPs1Path = path.join(runDir, "notify.ps1");
  const notifyShPath = path.join(runDir, "notify.sh");
  const claudeSettingsPath = path.join(runDir, "claude-settings.json");
  // The single "notify program" each agent invokes with the attention type as
  // its first argument: the PowerShell body on Windows, the sh wrapper on POSIX.
  const notifyProgramPath = isWin ? notifyPs1Path : notifyShPath;
  const sessions = new Map();
  let server = null;
  let callbackUrl = null;

  const ready = new Promise((resolve, reject) => {
    try {
      fs.mkdirSync(baseDir, { recursive: true });
      cleanupStaleShimDirs({ baseDir, currentRunId: runId });
      writeMarker(runDir, { runId, type: "run" });
      fs.writeFileSync(runnerPath, shimRunnerSource());

      // Per-turn notification assets: the notify program (PowerShell on Windows,
      // Node-via-sh on POSIX) plus the claude --settings hook file. codex points
      // its `notify` at the same program; opencode uses a guarded global plugin.
      if (isWin) {
        fs.writeFileSync(notifyPs1Path, windowsNotifyPs1Source());
      } else {
        fs.writeFileSync(notifyHookPath, notifyHookSource());
        fs.writeFileSync(notifyShPath, posixNotifyShSource(nodePath, notifyHookPath));
        fs.chmodSync(notifyShPath, 0o755);
      }
      fs.writeFileSync(
        claudeSettingsPath,
        buildClaudeSettingsJson(notifyProgramPath, isWin)
      );
      installOpenCodePlugin(options.openCodeHome);

      server = http.createServer((request, response) => {
        if (request.method !== "POST" || request.url !== "/agent-event") {
          response.writeHead(404);
          response.end();
          return;
        }

        if (request.headers["x-vibe-telemetry-token"] !== token) {
          response.writeHead(403);
          response.end();
          return;
        }

        let body = "";
        request.on("data", (chunk) => {
          body += chunk.toString("utf8");
          if (body.length > MAX_EVENT_BYTES) {
            request.destroy();
          }
        });

        request.on("end", () => {
          try {
            const event = JSON.parse(body);
            if (!event.sessionId || typeof event.type !== "string") {
              response.writeHead(400);
              response.end();
              return;
            }

            const attention = mapTelemetryToAttention(event);
            if (attention) {
              emit({
                id: event.sessionId,
                type: "agent-attention",
                provider: event.provider,
                attention
              });
            }

            response.writeHead(204);
            response.end();
          } catch {
            response.writeHead(400);
            response.end();
          }
        });
      });

      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        callbackUrl = `http://127.0.0.1:${address.port}/agent-event`;
        resolve();
      });
    } catch (error) {
      reject(error);
    }
  });

  async function prepareSession(sessionId) {
    await ready;
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return null;
    }

    if (sessions.has(normalizedSessionId)) {
      return sessions.get(normalizedSessionId).instrumentation;
    }

    const sessionDir = path.join(runDir, sessionDirName(normalizedSessionId));
    const shimDir = path.join(sessionDir, "bin");
    fs.mkdirSync(shimDir, { recursive: true });
    writeMarker(sessionDir, {
      runId,
      sessionId: normalizedSessionId,
      type: "session"
    });
    for (const provider of PROVIDERS) {
      writeWrapper(shimDir, provider, runnerPath, nodePath);
    }

    const key = pathEnvKey(process.env);
    const originalPath = process.env[key] || "";
    const nextPath = [shimDir, originalPath].filter(Boolean).join(path.delimiter);
    const instrumentation = {
      shimDir,
      env: {
        [key]: nextPath,
        VIBE_TERMINAL_SESSION_ID: normalizedSessionId,
        VIBE_TERMINAL_CALLBACK_URL: callbackUrl,
        VIBE_TERMINAL_TELEMETRY_TOKEN: token,
        VIBE_TERMINAL_ORIGINAL_PATH: originalPath,
        VIBE_TERMINAL_SHIM_DIR: shimDir,
        VIBE_TERMINAL_CLAUDE_SETTINGS: claudeSettingsPath,
        VIBE_TERMINAL_NOTIFY_PROGRAM: notifyProgramPath
      }
    };

    sessions.set(normalizedSessionId, {
      dir: sessionDir,
      instrumentation
    });
    return instrumentation;
  }

  function releaseSession(sessionId) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return;
    }

    const session = sessions.get(normalizedSessionId);
    sessions.delete(normalizedSessionId);
    if (session) {
      safeRemoveDir(session.dir, runDir);
    }
  }

  function cleanup() {
    for (const sessionId of Array.from(sessions.keys())) {
      releaseSession(sessionId);
    }
    if (server) {
      server.close();
      server = null;
    }
    safeRemoveDir(runDir, baseDir);
  }

  return {
    baseDir,
    callbackUrl: () => callbackUrl,
    cleanup,
    prepareSession,
    ready,
    releaseSession,
    runDir,
    runId,
    token
  };
}

module.exports = {
  buildClaudeSettingsJson,
  cleanupStaleShimDirs,
  createAgentTelemetryManager,
  installOpenCodePlugin,
  mapTelemetryToAttention,
  notifyHookSource,
  openCodePluginSource,
  safeRemoveDir
};
