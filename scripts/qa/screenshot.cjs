const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");
const { cleanupStaleShimDirs } = require("../../backend/agentTelemetry.cjs");

const isWindows = process.platform === "win32";
const rootDir = path.join(__dirname, "..", "..");
const npmCmd = isWindows ? "npm.cmd" : "npm";
const electronBin = path.join(
  rootDir,
  "node_modules",
  ".bin",
  isWindows ? "electron.cmd" : "electron"
);
const rendererCommand = npmCmd;
const electronCommand = isWindows ? `"${electronBin}" .` : electronBin;
const electronArgs = isWindows ? [] : ["."];
const artifactDir = path.join(rootDir, "artifacts");
const args = new Set(process.argv.slice(2));
const screenshotFixture = args.has("--openfusion")
  ? "openfusion"
  : args.has("--fusion-picker-claude")
    ? "fusion-picker-claude"
    : args.has("--fusion-picker-codex")
      ? "fusion-picker-codex"
      : args.has("--fusion-builds")
        ? "fusion-builds"
      : "default";
const screenshotPath = path.join(
  artifactDir,
  screenshotFixture === "openfusion"
    ? "vibe-terminal-openfusion-screenshot.png"
    : screenshotFixture === "fusion-picker-claude"
      ? "vibe-terminal-fusion-picker-claude.png"
      : screenshotFixture === "fusion-picker-codex"
        ? "vibe-terminal-fusion-picker-codex.png"
        : screenshotFixture === "fusion-builds"
          ? "vibe-terminal-fusion-builds.png"
    : "vibe-terminal-screenshot.png"
);
const screenshotUserData = path.join(
  rootDir,
  ".tmp",
  `screenshot-user-data-${Date.now()}-${process.pid}`
);
const screenshotShimBase = path.join(
  rootDir,
  ".tmp",
  `screenshot-agent-shims-${Date.now()}-${process.pid}`
);
const screenshotFakeBin = path.join(
  rootDir,
  ".tmp",
  `screenshot-fake-bin-${Date.now()}-${process.pid}`
);
const screenshotFakeOpenCodeMarker = path.join(
  rootDir,
  ".tmp",
  `screenshot-fake-opencode-${Date.now()}-${process.pid}.json`
);
const screenshotPtyDebugPath = path.join(
  rootDir,
  ".tmp",
  `screenshot-pty-debug-${Date.now()}-${process.pid}.jsonl`
);
const screenshotTimeoutMs = 30000;
const screenshotDelayMs =
  screenshotFixture === "openfusion"
    ? 8500
    : screenshotFixture === "fusion-builds"
      ? 6500
    : screenshotFixture.startsWith("fusion-picker-")
      ? 10000
      : 4500;
const shimBaseDir = path.join(rootDir, ".tmp", "vibe-agent-shims");

function electronAppEnv(extra = {}) {
  const env = {
    ...process.env,
    ...extra
  };
  if (isWindows) {
    const pathOverride = extra.Path || extra.PATH || extra.path;
    if (pathOverride) {
      for (const key of Object.keys(env)) {
        if (key.toLowerCase() === "path") {
          delete env[key];
        }
      }
      env.Path = pathOverride;
    }
  }
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function pathEnvKey(env = process.env) {
  if (!isWindows) {
    return "PATH";
  }

  return Object.keys(env).find((key) => key.toLowerCase() === "path") || "Path";
}

function quoteShellCommand(value) {
  if (isWindows) {
    return `& '${String(value).replace(/'/g, "''")}'`;
  }

  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function writeFakeOpenCodeBin(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const scriptPath = path.join(dir, "opencode-fake.cjs");
  fs.writeFileSync(
    scriptPath,
    [
      "process.stdout.write('\\x1b[2J\\x1b[H');",
      "const args = process.argv.slice(2).join(' ');",
      "try {",
      "  const fs = require('fs');",
      "  const marker = process.env.VIBE_SCREENSHOT_FAKE_OPENCODE_MARKER;",
      "  if (marker) fs.writeFileSync(marker, JSON.stringify({ args, cwd: process.cwd() }, null, 2));",
      "} catch {}",
      "const lines = [",
      "  'opencode',",
      "  '',",
      "  'Open Fusion CLI embedded in vibeTerminal',",
      "  '',",
      "  'Brain    - anthropic/claude-sonnet-4-5',",
      "  'Executor - opencode/gpt-5.1-codex',",
      "  '',",
      "  'Native slash commands:',",
      "  '  /brain-model       set pane Brain model for next restart',",
      "  '  /executor-model    set pane Executor model for next restart',",
      "  '  /brain-model-live  open OpenCode model picker for this Brain turn',",
      "  '  /delegate <task>   delegate work to the executor subagent',",
      "  '  /review <evidence> planner review gate',",
      "  '',",
      "  'Launch: opencode ' + args,",
      "  '',",
      "  'This screenshot fixture uses the real Electron PTY/Open Fusion harness.'",
      "];",
      "for (const line of lines) console.log(line);",
      "process.on('SIGINT', () => process.exit(0));",
      "process.on('SIGTERM', () => process.exit(0));",
      "setInterval(() => {}, 1000);",
      ""
    ].join("\n")
  );

  if (isWindows) {
    fs.writeFileSync(
      path.join(dir, "opencode.cmd"),
      '@echo off\r\nnode "%~dp0opencode-fake.cjs" %*\r\n'
    );
    return path.join(dir, "opencode.cmd");
  }

  const shellPath = path.join(dir, "opencode");
  fs.writeFileSync(
    shellPath,
    '#!/usr/bin/env sh\nexec node "$(dirname "$0")/opencode-fake.cjs" "$@"\n'
  );
  fs.chmodSync(shellPath, 0o755);
  return shellPath;
}

function cleanupDeadShimRuns() {
  cleanupStaleShimDirs({ baseDir: shimBaseDir });
}

function findFreePort(host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      server.close(() => {
        if (!address || typeof address === "string") {
          reject(new Error("Unable to allocate a renderer port."));
          return;
        }

        resolve(address.port);
      });
    });
  });
}

function killTree(child) {
  if (!child || child.killed) {
    return;
  }

  if (isWindows && child.pid) {
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore"
    });
    return;
  }

  child.kill();
}

function escapePowerShellString(value) {
  return value.replace(/'/g, "''");
}

function captureWindowToFile(outputPath) {
  if (!isWindows) {
    throw new Error("Visible window screenshot capture is only implemented on Windows.");
  }

  const safeOutputPath = escapePowerShellString(outputPath);
  const electronExePath = escapePowerShellString(
    path.join(rootDir, "node_modules", "electron", "dist", "electron.exe")
  );
  const script = `
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;

public struct RECT {
  public int Left;
  public int Top;
  public int Right;
  public int Bottom;
}

public class NativeWin {
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@

$deadline = (Get-Date).AddSeconds(15)
$proc = $null
$rect = New-Object RECT
$width = 0
$height = 0
$electronExePath = '${electronExePath}'

while ((Get-Date) -lt $deadline -and -not $proc) {
  $candidateProcesses = Get-CimInstance Win32_Process -Filter "Name = 'electron.exe'" |
    Where-Object { $_.ExecutablePath -eq $electronExePath -or $_.CommandLine -like "*vibeTerminal*node_modules*electron*dist*electron.exe*" }

  foreach ($candidateProcess in $candidateProcesses) {
    $candidate = Get-Process -Id $candidateProcess.ProcessId -ErrorAction SilentlyContinue
    if (-not $candidate -or $candidate.MainWindowHandle -eq 0) {
      continue
    }

    $candidateRect = New-Object RECT
    [NativeWin]::GetWindowRect($candidate.MainWindowHandle, [ref]$candidateRect) | Out-Null
    $candidateWidth = $candidateRect.Right - $candidateRect.Left
    $candidateHeight = $candidateRect.Bottom - $candidateRect.Top
    if ($candidateWidth -gt 200 -and $candidateHeight -gt 200) {
      $proc = $candidate
      $rect = $candidateRect
      $width = $candidateWidth
      $height = $candidateHeight
      break
    }
  }

  if (-not $proc) {
    Start-Sleep -Milliseconds 250
  }
}

if (-not $proc) {
  throw 'vibeTerminal Electron window not found'
}

[NativeWin]::SetForegroundWindow($proc.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 250

$bitmap = New-Object System.Drawing.Bitmap $width, $height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bitmap.Size)
$bitmap.Save('${safeOutputPath}', [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()
`;

  const powershell = isWindows ? "powershell.exe" : "pwsh";
  const result = spawnSync(
    powershell,
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    {
      cwd: rootDir,
      stdio: "inherit"
    }
  );

  if (result.status !== 0) {
    throw new Error(`Window screenshot capture failed with code ${result.status}`);
  }
}

function waitForRenderer(url, timeoutMs = 30000) {
  const started = Date.now();

  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });

      req.on("error", () => {
        if (Date.now() - started > timeoutMs) {
          reject(new Error(`Timed out waiting for ${url}`));
          return;
        }

        setTimeout(tick, 250);
      });
    };

    tick();
  });
}

async function main() {
  fs.mkdirSync(artifactDir, { recursive: true });
  cleanupDeadShimRuns();

  const electronEnv = {};
  if (screenshotFixture === "openfusion") {
    const fakeOpenCodeCommand = writeFakeOpenCodeBin(screenshotFakeBin);
    const key = pathEnvKey();
    electronEnv[key] = [screenshotFakeBin, process.env[key]].filter(Boolean).join(path.delimiter);
    electronEnv.VIBE_SCREENSHOT_SEED_OPEN_FUSION = "1";
    electronEnv.VIBE_SCREENSHOT_FIXTURE_CWD = rootDir;
    electronEnv.VIBE_SCREENSHOT_OPENCODE_COMMAND = quoteShellCommand(fakeOpenCodeCommand);
    electronEnv.VIBE_SCREENSHOT_FAKE_OPENCODE_MARKER = screenshotFakeOpenCodeMarker;
  } else if (screenshotFixture.startsWith("fusion-picker-")) {
    electronEnv.VIBE_SCREENSHOT_SEED_FUSION_PICKER = "1";
    electronEnv.VIBE_SCREENSHOT_FIXTURE_CWD = rootDir;
    electronEnv.VIBE_SCREENSHOT_FUSION_PICKER_FAMILY =
      screenshotFixture === "fusion-picker-codex" ? "codex" : "claude";
    electronEnv.VIBE_SCREENSHOT_FUSION_PICKER_ROLE =
      screenshotFixture === "fusion-picker-codex" ? "executor" : "planner";
  } else if (screenshotFixture === "fusion-builds") {
    electronEnv.VIBE_SCREENSHOT_SEED_FUSION_BUILDS = "1";
    electronEnv.VIBE_SCREENSHOT_FIXTURE_CWD = rootDir;
  }

  const rendererPort = await findFreePort();
  const rendererUrl = `http://127.0.0.1:${rendererPort}`;
  const rendererArgs = [
    "run",
    "dev:frontend",
    "--",
    "--port",
    String(rendererPort),
    "--strictPort"
  ];

  const renderer = spawn(rendererCommand, rendererArgs, {
    cwd: rootDir,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
    shell: isWindows
  });

  renderer.stdout.on("data", (chunk) => process.stdout.write(chunk));
  renderer.stderr.on("data", (chunk) => process.stderr.write(chunk));

  const shutdown = () => {
    killTree(renderer);
  };

  let app = null;

  try {
    await waitForRenderer(rendererUrl);

    app = spawn(electronCommand, electronArgs, {
      cwd: rootDir,
      stdio: "inherit",
      env: electronAppEnv({
        VITE_DEV_SERVER_URL: rendererUrl,
        VIBE_INTERNAL_SCREENSHOT: "1",
        VIBE_SCREENSHOT_MODE: "1",
        VIBE_SCREENSHOT_PATH: screenshotPath,
        VIBE_SCREENSHOT_USER_DATA: screenshotUserData,
        VIBE_AGENT_SHIM_BASE_DIR: screenshotShimBase,
        VIBE_SCREENSHOT_DELAY_MS: String(screenshotDelayMs),
        VIBE_SCREENSHOT_PTY_DEBUG: screenshotPtyDebugPath,
        ...electronEnv
      }),
      shell: isWindows
    });

    const exitCode = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        killTree(app);
        reject(new Error("Timed out waiting for Electron screenshot capture."));
      }, screenshotTimeoutMs);

      app.on("exit", (code) => {
        clearTimeout(timeout);
        resolve(code ?? 0);
      });
    });

    if (exitCode !== 0) {
      throw new Error(`Electron screenshot run exited with code ${exitCode}`);
    }

    if (!fs.existsSync(screenshotPath)) {
      throw new Error(`Screenshot was not written: ${screenshotPath}`);
    }
    if (
      screenshotFixture === "openfusion" &&
      !fs.existsSync(screenshotFakeOpenCodeMarker)
    ) {
      if (fs.existsSync(screenshotPtyDebugPath)) {
        process.stderr.write(fs.readFileSync(screenshotPtyDebugPath, "utf8"));
      }
      throw new Error("Open Fusion screenshot fixture did not execute fake opencode.");
    }

    console.log(`Screenshot written: ${screenshotPath}`);
  } finally {
    killTree(app);
    shutdown();
    cleanupDeadShimRuns();
    try {
      fs.rmSync(screenshotUserData, { recursive: true, force: true });
    } catch {
      // Chromium can hold a cache file for a moment on Windows; this is test-only data.
    }
    fs.rmSync(screenshotShimBase, { recursive: true, force: true });
    fs.rmSync(screenshotFakeBin, { recursive: true, force: true });
    fs.rmSync(screenshotFakeOpenCodeMarker, { force: true });
    fs.rmSync(screenshotPtyDebugPath, { force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
