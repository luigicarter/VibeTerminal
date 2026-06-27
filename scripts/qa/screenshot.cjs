const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const http = require("http");
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
const rendererCommand = isWindows ? `${npmCmd} run dev:frontend` : npmCmd;
const rendererArgs = isWindows ? [] : ["run", "dev:frontend"];
const electronCommand = isWindows ? `"${electronBin}" .` : electronBin;
const electronArgs = isWindows ? [] : ["."];
const artifactDir = path.join(rootDir, "artifacts");
const screenshotPath = path.join(artifactDir, "vibe-terminal-screenshot.png");
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
const screenshotTimeoutMs = 30000;
const screenshotDelayMs = 4500;
const shimBaseDir = path.join(rootDir, ".tmp", "vibe-agent-shims");

function cleanupDeadShimRuns() {
  cleanupStaleShimDirs({ baseDir: shimBaseDir });
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
    await waitForRenderer("http://127.0.0.1:5173");

    app = spawn(electronCommand, electronArgs, {
      cwd: rootDir,
      stdio: "inherit",
      env: {
        ...process.env,
        VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
        VIBE_INTERNAL_SCREENSHOT: isWindows ? "0" : "1",
        VIBE_SCREENSHOT_MODE: "1",
        VIBE_SCREENSHOT_PATH: screenshotPath,
        VIBE_SCREENSHOT_USER_DATA: screenshotUserData,
        VIBE_AGENT_SHIM_BASE_DIR: screenshotShimBase,
        VIBE_SCREENSHOT_DELAY_MS: String(screenshotDelayMs)
      },
      shell: isWindows
    });

    if (isWindows) {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          killTree(app);
          reject(new Error("Timed out waiting for Electron screenshot capture."));
        }, screenshotTimeoutMs);
        const ready = setTimeout(() => {
          clearTimeout(timeout);
          app.off("exit", onEarlyExit);
          resolve();
        }, screenshotDelayMs);

        function onEarlyExit(code) {
          clearTimeout(timeout);
          clearTimeout(ready);
          reject(new Error(`Electron exited before screenshot capture with code ${code ?? 0}`));
        }

        app.on("exit", onEarlyExit);
      });

      captureWindowToFile(screenshotPath);
    } else {
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
    }

    if (!fs.existsSync(screenshotPath)) {
      throw new Error(`Screenshot was not written: ${screenshotPath}`);
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
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
