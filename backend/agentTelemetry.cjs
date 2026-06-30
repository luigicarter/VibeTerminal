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
const PROVIDERS = ["codex", "claude", "opencode", "cursor-agent"];

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

// One env-guarded notify program backs every Cursor hook (verified to fire only
// in the interactive CLI). Two shapes:
//   * turn START (beforeSubmitPrompt) passes the type as an argument
//     (`... agent.running`) so we never have to parse the prompt payload;
//   * turn END (stop) passes no argument, and the type is derived from the
//     `status` (completed|aborted|error) the hook pipes on stdin, so a single
//     `stop` reports both done and failed.
// stdin is always drained (even when the type comes from the argument) so Cursor
// never blocks writing a large hook payload to a program that isn't reading it.
// The env guard makes the project hook inert for plain `cursor-agent` runs and
// the Cursor IDE, which carry no VIBE_TERMINAL_* env.
const CURSOR_HOOK_MARKER = "vibeterminal-cursor-notify";
const CURSOR_RUNNING_TYPE = "agent.running";
// The only types the notify program is ever allowed to POST. A bad/unknown
// argument or unparseable stdin therefore stays silent instead of POSTing junk.
const CURSOR_KNOWN_TYPES = ["agent.running", "agent.completed", "agent.failed"];

function cursorTypeFromStatus(status) {
  return String(status || "") === "error" ? "agent.failed" : "agent.completed";
}

// Windows notify program (PowerShell). Type comes from the first argument (turn
// start) or, absent that, from the stdin JSON `status` (turn end); POSTs it.
function windowsCursorNotifyPs1Source() {
  const knownTypeGuard = CURSOR_KNOWN_TYPES.map(
    (type) => `$type -ne '${type}'`
  ).join(" -and ");
  return [
    `# ${CURSOR_HOOK_MARKER}`,
    "$ErrorActionPreference = 'SilentlyContinue'",
    "if ([string]::IsNullOrEmpty($env:VIBE_TERMINAL_CALLBACK_URL) -or [string]::IsNullOrEmpty($env:VIBE_TERMINAL_TELEMETRY_TOKEN) -or [string]::IsNullOrEmpty($env:VIBE_TERMINAL_SESSION_ID)) {",
    "  exit 0",
    "}",
    "$raw = ''",
    "try { $raw = [Console]::In.ReadToEnd() } catch { $raw = '' }",
    "if ($args.Count -ge 1 -and -not [string]::IsNullOrEmpty([string]$args[0])) {",
    "  $type = [string]$args[0]",
    "} else {",
    "  $status = ''",
    "  try { $status = [string]((($raw | ConvertFrom-Json)).status) } catch { $status = '' }",
    "  $type = if ($status -eq 'error') { 'agent.failed' } else { 'agent.completed' }",
    "}",
    `if (${knownTypeGuard}) { exit 0 }`,
    "try {",
    "  $payload = [ordered]@{",
    "    type = $type",
    "    sessionId = $env:VIBE_TERMINAL_SESSION_ID",
    "    provider = 'cursor'",
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

// POSIX notify program (Node). Same contract as the PowerShell body: the type is
// the first argument (turn start) or derived from the stdin JSON `status` (turn
// end). A safety timer guarantees it proceeds even if stdin never closes, so the
// hook can never hang the agent.
function cursorNotifyHookSource() {
  return String.raw`const http = require("http");

const KNOWN_TYPES = new Set(${JSON.stringify(CURSOR_KNOWN_TYPES)});
const callbackUrl = process.env.VIBE_TERMINAL_CALLBACK_URL;
const token = process.env.VIBE_TERMINAL_TELEMETRY_TOKEN;
const sessionId = process.env.VIBE_TERMINAL_SESSION_ID;
const argType = process.argv[2] || "";

if (!callbackUrl || !token || !sessionId) {
  process.exit(0);
}

let raw = "";
let settled = false;

function finish() {
  if (settled) return;
  settled = true;

  let type = argType;
  if (!type) {
    let status = "";
    try {
      status = String(JSON.parse(raw).status || "");
    } catch {
      status = "";
    }
    type = status === "error" ? "agent.failed" : "agent.completed";
  }
  if (!KNOWN_TYPES.has(type)) {
    process.exit(0);
    return;
  }

  const body = JSON.stringify({ type, sessionId, provider: "cursor", timestamp: Date.now() });

  let url;
  try {
    url = new URL(callbackUrl);
  } catch {
    process.exit(0);
    return;
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
}

process.stdin.on("data", (chunk) => {
  raw += chunk.toString("utf8");
});
process.stdin.on("error", finish);
process.stdin.on("end", finish);
// Never hang if stdin is not piped/closed for some reason.
setTimeout(finish, 1500);
`;
}

function posixCursorNotifyShSource(nodePath, cursorNotifyHookPath) {
  return [
    "#!/usr/bin/env sh",
    `ELECTRON_RUN_AS_NODE=1 exec ${JSON.stringify(nodePath)} ${JSON.stringify(
      cursorNotifyHookPath
    )} "$@"`
  ].join("\n");
}

// Reject non-plain-object inputs (arrays, null) so a malformed hooks.json never
// gets spread into a corrupt shape.
function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isOurCursorEntry(entry) {
  return Boolean(
    entry &&
      typeof entry.command === "string" &&
      entry.command.includes(CURSOR_HOOK_MARKER)
  );
}

// The shell command Cursor runs for one of our hooks: invoke the notify program,
// passing the attention type as an argument for the running hooks and nothing for
// the stop hook (which derives it from stdin). Forward slashes in the Windows
// path dodge backslash escaping inside the JSON command string.
function cursorHookCommand(cursorNotifyProgramPath, isWin, type) {
  const arg = type ? ` ${type}` : "";
  return isWin
    ? `powershell -NoProfile -ExecutionPolicy Bypass -File "${cursorNotifyProgramPath.replace(
        /\\/g,
        "/"
      )}"${arg}`
    : `'${cursorNotifyProgramPath}'${arg}`;
}

// The set of project hooks vibeTerminal installs: turn-start "running" and
// turn-end completed/failed. Returns `{ event, command }` entries for merging.
function cursorHookEntries(cursorNotifyProgramPath, isWin) {
  return [
    {
      event: "beforeSubmitPrompt",
      command: cursorHookCommand(
        cursorNotifyProgramPath,
        isWin,
        CURSOR_RUNNING_TYPE
      )
    },
    {
      event: "stop",
      command: cursorHookCommand(cursorNotifyProgramPath, isWin)
    }
  ];
}

// Merge our env-guarded hooks into a Cursor `hooks.json` object without disturbing
// the user's own hooks. Idempotent: every prior vibeTerminal entry (identified by
// the marker the notify command carries) is dropped from EVERY event array before
// the current set is appended, so repeated launches never accumulate duplicates,
// a per-run notify path is always refreshed, and dropping an event we no longer
// register leaves no orphan. `entries` is `[{ event, command }]`.
function mergeCursorHooks(existing, entries) {
  const base = isPlainObject(existing) ? { ...existing } : {};
  base.version = base.version || 1;
  const hooks = isPlainObject(base.hooks) ? { ...base.hooks } : {};

  for (const key of Object.keys(hooks)) {
    if (Array.isArray(hooks[key])) {
      hooks[key] = hooks[key].filter((entry) => !isOurCursorEntry(entry));
    }
  }

  for (const { event, command } of entries) {
    const list = Array.isArray(hooks[event]) ? hooks[event] : [];
    hooks[event] = [...list, { command }];
  }

  // Drop any event array our filtering emptied (e.g. an event we used to
  // register but no longer do) so we never leave a bare `"event": []`.
  for (const key of Object.keys(hooks)) {
    if (Array.isArray(hooks[key]) && hooks[key].length === 0) {
      delete hooks[key];
    }
  }

  base.hooks = hooks;
  return base;
}

// Strip our entries from every event array in a Cursor hooks object (used on
// cleanup). Returns the trimmed object plus whether anything other than our own
// contribution remains, so the caller can delete a file vibeTerminal created.
function stripCursorHooks(existing) {
  const base = isPlainObject(existing) ? { ...existing } : {};
  const hooks = isPlainObject(base.hooks) ? { ...base.hooks } : {};

  for (const key of Object.keys(hooks)) {
    if (!Array.isArray(hooks[key])) {
      continue;
    }
    const filtered = hooks[key].filter((entry) => !isOurCursorEntry(entry));
    if (filtered.length > 0) {
      hooks[key] = filtered;
    } else {
      delete hooks[key];
    }
  }
  base.hooks = hooks;

  const hasOtherContent =
    Object.keys(hooks).length > 0 ||
    Object.keys(base).some((key) => key !== "version" && key !== "hooks");
  return { trimmed: base, hasOtherContent };
}

// The architect system prompt a Fusion pane's claude is launched with
// (`claude --append-system-prompt-file <file>`). Opus orchestrates with
// READ-ONLY tools (Read/Grep/Glob) + the Codex bridge; it has no edit/shell
// tools, so Codex implements and verifies everything through the app-server.
function buildFusionSystemPrompt() {
  return [
    "# Terminal Fusion - you are the Claude/Opus orchestrator",
    "",
    "You are running inside a **Fusion terminal**. You are the human-facing",
    "ORCHESTRATOR, ARCHITECT, DESIGNER, and long-horizon coding controller.",
    "Your counterpart, **Codex GPT-5.5**, is the executor, tester, bug reviewer,",
    "and goal-completion verifier.",
    "",
    "## Tooling (read this first)",
    "You have READ-ONLY tools for investigation — **Read, Grep, Glob** — plus the",
    "Codex bridge tools. The tool allowlist does not expose direct editing or",
    "shell execution to you. Therefore EVERY file change, command, and test run",
    "MUST go through **codex_implement** — there is no path where you edit the",
    "repo yourself. Investigate and review with Read/Grep/Glob; implement only",
    "by delegating to Codex. If a request needs any code change, your first",
    "substantive action is a codex_implement call, not an attempt to edit.",
    "",
    "## Your scope",
    "- Architecture and design decisions.",
    "- Long-horizon coding control through Codex's native goal state.",
    "- Decomposing the work and routing every concrete implementation step to Codex.",
    "- Planning the work and splitting it into precise, self-contained tasks.",
    "- Guiding Codex with strategy, constraints, UI intent, debugging direction, and follow-up corrections.",
    "- Threat-modeling and debugging *strategy* (what to investigate and why).",
    "- Human-facing tradeoff reasoning and override decisions.",
    "- Reviewing Codex's diffs and verifier verdict via read-only inspection (Read/Grep/Glob).",
    '- "What are we missing?" analysis and tradeoff reasoning.',
    "",
    "## Codex's scope",
    "- Editing files, running tests, fixing compile/runtime errors, refactors, and repo navigation.",
    "- Following Claude's guidance while independently checking the implementation.",
    "- Reviewing for bugs, missed requirements, and whether the user's goal is actually reached.",
    "- Tracking the active objective in Codex's native per-thread goal state.",
    "- Returning a structured verifier verdict that gates completion.",
    "",
    "## Codex native goals",
    "For substantial user work, call **codex_goal_set** before the first",
    "codex_implement call. Treat this as Claude adopting Codex's long-horizon",
    "coding state: set `objective` to the user's top-level objective and",
    '`status:"active"`, then delegate concrete execution steps to Codex.',
    "Use **codex_goal_get** before final completion or when you need the current",
    "goal/usage state. Use **codex_goal_clear** only when the human abandons the",
    "objective or starts a separate unrelated objective.",
    "The Fusion adapter also creates a fallback Codex goal when codex_implement",
    "runs without one, and marks the native goal complete after a successful",
    "Codex verifier verdict. It does not overwrite Codex-managed blocked or",
    "usage/budget-limited goal states.",
    "",
    "## How to delegate to Codex",
    "Use the **codex_implement** tool (NOT your shell, NOT `codex` directly) with",
    "complete, self-contained instructions — Codex does not share your context, so",
    "give it the files, intent, constraints, acceptance criteria, and what to verify.",
    "Codex edits files, runs tests, reviews bugs, and verifies goal completion.",
    "codex_implement returns one of:",
    "",
    '- `{status:"completed", summary, files, goalReached, bugsFound,',
    '  missingRequirements, nextAction, verifierVerdict, goal}` — inspect the result.',
    '  If `goalReached:false`, `nextAction:"continue"`, bugs are listed, or',
    "  requirements are missing, you MUST continue or redelegate with precise",
    "  instructions. Do not tell the user the task is done.",
    '  If `nextAction:"ask_human"`, ask the human for the missing decision.',
    '  If `goalReached:true` and `nextAction:"done"`, you may finish.',
    '- `{status:"needs_decision", pendingId, kind, detail}` — Codex needs approval',
    "  (a command or patch) or is asking a question. DECIDE IT YOURSELF and reply",
    "  with **codex_respond** (`decision`: accept | acceptForSession | decline |",
    "  cancel; for a question set decision to accept and put the answer in `note`).",
    "  Only ask the human when you genuinely cannot decide.",
    '- `{status:"failed", error}` — diagnose; if Codex is unavailable / not',
    "  authenticated, tell the user to run `codex login`.",
    "",
    "## Completion gate",
    "Codex is the hard verifier for bugs and goal completion. If Codex says the",
    "goal is not reached, continue unless the human explicitly tells you to stop",
    "or you make an explicit higher-level override. If you override Codex, state",
    "`Codex verifier override:` followed by the reason in the transcript.",
    "You cannot edit the repo yourself, so there are never unverified Claude edits",
    "to reconcile — always let Codex's verifier verdict gate completion.",
    "",
    "## User-facing style",
    "Present yourself as one Fusion agent. Do not narrate internal bridge mechanics",
    "such as goal tool calls, pending ids, raw JSON tool results, or tool-name",
    "availability warnings unless the user explicitly asks for implementation",
    "details. Summarize delegated work in human terms: what you are checking, what",
    "changed, what passed, and what still needs a decision.",
    ""
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
      // Turn START: the user submitted a prompt, or the agent is running a tool
      // (PreToolUse/PostToolUse also re-assert "working" right after a permission
      // approval). This is the interaction-proof signal behind the sidebar
      // "working" spinner, so typing or clicking the pane never reads as working.
      UserPromptSubmit: [{ matcher: "*", hooks: [hook("agent.running")] }],
      PreToolUse: [{ matcher: "*", hooks: [hook("agent.running")] }],
      PostToolUse: [{ matcher: "*", hooks: [hook("agent.running")] }],
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

const OPENCODE_PLUGIN_VERSION = "vibeterminal-notify-2";

// opencode cannot take a per-invocation hook, so we install one small plugin in
// the user's opencode config. It is guarded: it only POSTs when the
// VIBE_TERMINAL_* env vars are present, so a plain `opencode` run does nothing.
//
// Turn START (`agent.running`, the sidebar "working" spinner) is inferred from
// message-stream events: while the assistant is generating, opencode emits a
// burst of `message.*` events, so the FIRST one after idle reports "working" and
// the rest are throttled by the per-turn `busy` latch (reset on idle/error).
// NOTE: the exact `message.*` event names are LIVE-VERIFY pending; if they differ
// in a given opencode version the spinner simply won't show (no false positive),
// while done/waiting still flow from session.idle/permission events.
function openCodePluginSource() {
  return [
    `// vibeterminal-notify (${OPENCODE_PLUGIN_VERSION}) - auto-generated by vibeTerminal.`,
    "// Safe no-op outside vibeTerminal: only POSTs when VIBE_TERMINAL_* env vars are set.",
    "export const VibeTerminalNotify = async () => {",
    "  let busy = false;",
    "  return {",
    "    event: async ({ event }) => {",
    "      const url = process.env.VIBE_TERMINAL_CALLBACK_URL;",
    "      const token = process.env.VIBE_TERMINAL_TELEMETRY_TOKEN;",
    "      const sessionId = process.env.VIBE_TERMINAL_SESSION_ID;",
    '      if (!url || !token || !sessionId || !event || typeof event.type !== "string") {',
    "        return;",
    "      }",
    "      const send = async (type) => {",
    "        try {",
    "          await fetch(url, {",
    '            method: "POST",',
    "            headers: {",
    '              "content-type": "application/json",',
    '              "x-vibe-telemetry-token": token',
    "            },",
    '            body: JSON.stringify({ type, sessionId, provider: "opencode", timestamp: Date.now() })',
    "          });",
    "        } catch (_error) {",
    "          // Telemetry is best-effort; ignore delivery failures.",
    "        }",
    "      };",
    '      if (event.type.startsWith("message.")) {',
    "        if (!busy) {",
    "          busy = true;",
    '          await send("agent.running");',
    "        }",
    "        return;",
    "      }",
    "      const map = {",
    '        "session.idle": "agent.completed",',
    '        "permission.asked": "agent.waiting",',
    '        "permission.updated": "agent.waiting",',
    '        "session.error": "agent.failed"',
    "      };",
    "      const type = map[event.type];",
    "      if (!type) {",
    "        return;",
    "      }",
    '      if (event.type === "session.idle" || event.type === "session.error") {',
    "        busy = false;",
    "      }",
    "      await send(type);",
    "    }",
    "  };",
    "};",
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
  // Cursor's stop hook derives the attention type from the JSON it pipes on
  // stdin, so it gets its own notify program. The filename carries the marker so
  // mergeCursorHooks can recognise (and refresh) our entry inside the user's
  // project hooks.json across runs.
  const cursorNotifyPs1Path = path.join(runDir, `${CURSOR_HOOK_MARKER}.ps1`);
  const cursorNotifyHookPath = path.join(runDir, `${CURSOR_HOOK_MARKER}.cjs`);
  const cursorNotifyShPath = path.join(runDir, `${CURSOR_HOOK_MARKER}.sh`);
  const cursorNotifyProgramPath = isWin ? cursorNotifyPs1Path : cursorNotifyShPath;
  // Project hooks.json files we have touched this run, mapped to whether the
  // file pre-existed, so cleanup can strip our entry (or delete a file we
  // created) without disturbing the user's own hooks.
  const cursorHookFiles = new Map();
  const sessions = new Map();
  const fusionAdapterControls = new Map();
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
        fs.writeFileSync(cursorNotifyPs1Path, windowsCursorNotifyPs1Source());
      } else {
        fs.writeFileSync(notifyHookPath, notifyHookSource());
        fs.writeFileSync(notifyShPath, posixNotifyShSource(nodePath, notifyHookPath));
        fs.chmodSync(notifyShPath, 0o755);
        fs.writeFileSync(cursorNotifyHookPath, cursorNotifyHookSource());
        fs.writeFileSync(
          cursorNotifyShPath,
          posixCursorNotifyShSource(nodePath, cursorNotifyHookPath)
        );
        fs.chmodSync(cursorNotifyShPath, 0o755);
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

            if (event.type === "fusion.adapterReady") {
              const normalizedSessionId = normalizeSessionId(event.sessionId);
              let controlUrl = null;
              try {
                const parsedUrl = new URL(String(event.controlUrl || ""));
                if (
                  parsedUrl.protocol === "http:" &&
                  parsedUrl.hostname === "127.0.0.1" &&
                  parsedUrl.port
                ) {
                  parsedUrl.pathname = parsedUrl.pathname.replace(/\/+$/, "");
                  parsedUrl.search = "";
                  parsedUrl.hash = "";
                  controlUrl = parsedUrl.toString().replace(/\/$/, "");
                }
              } catch {
                controlUrl = null;
              }
              if (normalizedSessionId && controlUrl) {
                fusionAdapterControls.set(normalizedSessionId, controlUrl);
              }
            } else if (event.type === "fusion.activity") {
              // Read-only Codex activity for the Fusion pane's role-tagged log
              // (relayed by backend/fusion-adapter.cjs). Not an attention signal.
              emit({
                id: event.sessionId,
                type: "fusion-activity",
                role: event.role,
                kind: event.kind,
                text: event.text,
                ts: event.ts
              });
            } else if (event.type === "agent.running") {
              // A turn started (claude UserPromptSubmit/tool use, opencode busy
              // event). This drives the pane's "working" state only; it is not an
              // attention/unread signal, so it rides a dedicated event.
              emit({
                id: event.sessionId,
                type: "agent-running",
                provider: event.provider
              });
            } else {
              const attention = mapTelemetryToAttention(event);
              if (attention) {
                emit({
                  id: event.sessionId,
                  type: "agent-attention",
                  provider: event.provider,
                  attention
                });
              }
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

  async function prepareSession(sessionId, options = {}) {
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

  // Generate the per-pane Fusion files (Codex MCP adapter config + architect
  // system prompt) for the HEADLESS chat path (backend/fusionChatHost.cjs spawns
  // `claude` with these as explicit argv). Independent of the PTY shim. Returns
  // { systemPromptFile, mcpConfig } absolute paths.
  async function prepareFusionFiles(sessionId, opts = {}) {
    await ready;
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return null;
    }

    const sessionDir = path.join(runDir, sessionDirName(normalizedSessionId));
    fs.mkdirSync(sessionDir, { recursive: true });

    const systemPromptFile = path.join(sessionDir, "fusion-system-prompt.md");
    fs.writeFileSync(systemPromptFile, buildFusionSystemPrompt());

    const adapterPath = path.join(__dirname, "fusion-adapter.cjs");
    const mcpConfigObj = {
      mcpServers: {
        "fusion-codex": {
          command: nodePath,
          args: [adapterPath],
          env: {
            ELECTRON_RUN_AS_NODE: "1",
            VIBE_FUSION_CODEX_BIN: opts.codexBin || "codex",
            // Pin the user's Codex home so the EMBEDDED binary uses their existing
            // ChatGPT/Codex login (auth.json) with zero re-auth — even if the MCP
            // spawn chain doesn't inherit HOME/USERPROFILE.
            CODEX_HOME: process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
            VIBE_TERMINAL_FUSION_CWD: opts.cwd || "",
            VIBE_TERMINAL_SESSION_ID: normalizedSessionId,
            VIBE_TERMINAL_CALLBACK_URL: callbackUrl,
            VIBE_TERMINAL_TELEMETRY_TOKEN: token,
            ...(opts.codexModel ? { VIBE_FUSION_CODEX_MODEL: opts.codexModel } : {}),
            ...(opts.codexEffort ? { VIBE_FUSION_CODEX_EFFORT: opts.codexEffort } : {})
          }
        }
      }
    };
    const mcpConfig = path.join(sessionDir, "fusion-mcp.json");
    fs.writeFileSync(mcpConfig, `${JSON.stringify(mcpConfigObj, null, 2)}\n`);

    return { systemPromptFile, mcpConfig };
  }

  function releaseSession(sessionId) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return;
    }

    fusionAdapterControls.delete(normalizedSessionId);
    const session = sessions.get(normalizedSessionId);
    sessions.delete(normalizedSessionId);
    if (session) {
      safeRemoveDir(session.dir, runDir);
    }
  }

  function postFusionAdapterControl(sessionId, pathName, payload = {}) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return Promise.resolve({ status: "skipped", reason: "invalid_session" });
    }
    const controlUrl = fusionAdapterControls.get(normalizedSessionId);
    if (!controlUrl) {
      return Promise.resolve({ status: "skipped", reason: "adapter_not_ready" });
    }
    return new Promise((resolve) => {
      let url;
      try {
        url = new URL(`${controlUrl}${pathName}`);
        if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
          resolve({ status: "skipped", reason: "invalid_adapter_url" });
          return;
        }
      } catch (error) {
        resolve({ status: "skipped", reason: error.message });
        return;
      }

      const body = JSON.stringify({
        sessionId: normalizedSessionId,
        ...payload
      });
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
          let responseBody = "";
          response.on("data", (chunk) => {
            responseBody += chunk.toString("utf8");
          });
          response.on("end", () => {
            try {
              const parsed = JSON.parse(responseBody || "{}");
              resolve(parsed && typeof parsed === "object" ? parsed : { status: "ok" });
            } catch {
              resolve({ status: response.statusCode && response.statusCode >= 400 ? "failed" : "ok" });
            }
          });
        }
      );
      request.on("error", (error) => resolve({ status: "failed", error: error.message }));
      request.on("timeout", () => {
        request.destroy();
        resolve({ status: "failed", error: "adapter control timed out" });
      });
      request.end(body);
    });
  }

  function steerFusionSession(sessionId, text) {
    return postFusionAdapterControl(sessionId, "/steer", { text });
  }

  function interruptFusionSession(sessionId) {
    return postFusionAdapterControl(sessionId, "/interrupt");
  }

  function stopFusionSession(sessionId) {
    return postFusionAdapterControl(sessionId, "/stop");
  }

  // Cursor has no per-invocation hook flag, so its hooks are registered in the
  // project's `.cursor/hooks.json`: `beforeSubmitPrompt` -> running and `stop` ->
  // completed/failed. This runs at launch (the cwd is known then) to merge our
  // env-guarded entries in, refreshing the per-run notify path. Best-effort and
  // idempotent; never throws so it cannot break a terminal launch. The user's own
  // Cursor hooks are preserved.
  async function ensureCursorProjectHooks(cwd) {
    try {
      await ready;
      if (!cwd || typeof cwd !== "string") {
        return;
      }

      const dir = path.join(cwd, ".cursor");
      const file = path.join(dir, "hooks.json");

      let raw = null;
      try {
        raw = fs.readFileSync(file, "utf8");
      } catch {
        raw = null;
      }

      let existing = null;
      if (raw !== null) {
        try {
          existing = JSON.parse(raw);
        } catch {
          // The file exists but is not valid JSON. Do not clobber it — the user
          // may be mid-edit or using a format we do not understand.
          return;
        }
      }

      const merged = mergeCursorHooks(
        existing,
        cursorHookEntries(cursorNotifyProgramPath, isWin)
      );
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`);
      if (!cursorHookFiles.has(file)) {
        cursorHookFiles.set(file, { createdByUs: raw === null });
      }
    } catch {
      // Best-effort; never let cursor hook install break a terminal launch.
    }
  }

  function cleanupCursorHooks() {
    for (const [file, info] of cursorHookFiles) {
      try {
        const raw = fs.readFileSync(file, "utf8");
        const parsed = JSON.parse(raw);
        const { trimmed, hasOtherContent } = stripCursorHooks(parsed);
        if (info.createdByUs && !hasOtherContent) {
          // We created this file purely for our hook; remove it (and the
          // .cursor dir if it is now empty) rather than leave a dangling entry.
          fs.rmSync(file, { force: true });
          const dir = path.dirname(file);
          try {
            if (fs.readdirSync(dir).length === 0) {
              fs.rmdirSync(dir);
            }
          } catch {
            // Directory not empty or unreadable — leave it.
          }
        } else {
          fs.writeFileSync(file, `${JSON.stringify(trimmed, null, 2)}\n`);
        }
      } catch {
        // File gone, unreadable, or malformed — nothing safe to do.
      }
    }
    cursorHookFiles.clear();
  }

  function cleanup() {
    for (const sessionId of Array.from(sessions.keys())) {
      releaseSession(sessionId);
    }
    cleanupCursorHooks();
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
    ensureCursorProjectHooks,
    prepareSession,
    prepareFusionFiles,
    ready,
    releaseSession,
    steerFusionSession,
    interruptFusionSession,
    stopFusionSession,
    runDir,
    runId,
    token
  };
}

module.exports = {
  buildClaudeSettingsJson,
  buildFusionSystemPrompt,
  cleanupStaleShimDirs,
  createAgentTelemetryManager,
  cursorHookEntries,
  cursorNotifyHookSource,
  cursorTypeFromStatus,
  installOpenCodePlugin,
  mapTelemetryToAttention,
  mergeCursorHooks,
  notifyHookSource,
  openCodePluginSource,
  safeRemoveDir,
  stripCursorHooks
};
