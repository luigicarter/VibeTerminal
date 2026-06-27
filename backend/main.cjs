const { app, BrowserWindow, dialog, ipcMain, screen } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { createAgentTelemetryManager } = require("./agentTelemetry.cjs");
const { getCodeChangeSummary } = require("./codeChanges.cjs");

const isScreenshotMode =
  process.env.VIBE_SCREENSHOT_MODE === "1" || Boolean(process.env.VIBE_SCREENSHOT_PATH);

if (isScreenshotMode) {
  const screenshotUserData =
    process.env.VIBE_SCREENSHOT_USER_DATA ||
    path.join(process.cwd(), ".tmp", `screenshot-user-data-${process.pid}`);
  fs.mkdirSync(screenshotUserData, { recursive: true });
  app.setPath("userData", screenshotUserData);
}

let mainWindow = null;
let ptyHost = null;
let ptyHostBuffer = "";
let ptyHostReady = false;
const pendingResizeMessages = new Map();
const resizeFlushTimers = new Map();
let agentThreadHost = null;
let agentThreadHostBuffer = "";
let agentThreadHostReady = false;
let nextAgentThreadRequestId = 1;
const pendingAgentThreadRequests = new Map();
let agentTelemetry = null;
let autoUpdater = null;
let autoUpdaterConfigured = false;
let checkedForUpdatesOnLaunch = false;
let updateDownloadRequested = false;
let manualUpdateCheckRequested = false;
let updateState = {
  status: app.isPackaged ? "idle" : "disabled",
  updatedAt: Date.now()
};

function getAutoUpdater() {
  if (!autoUpdater) {
    ({ autoUpdater } = require("electron-updater"));
  }

  return autoUpdater;
}

function getPtyHostPath() {
  return getHelperHostPath("ptyHost.cjs");
}

function getAgentThreadHostPath() {
  return getHelperHostPath("agentThreadHost.cjs");
}

function getAppIconPath() {
  return path.join(__dirname, "..", "frontend", "assets", "vibeterminal-logo.ico");
}

function getDefaultRuntimeCwd() {
  return app.isPackaged ? os.homedir() : process.cwd();
}

function getHelperHostPath(fileName) {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "app.asar.unpacked", "backend", fileName);
  }

  return path.join(__dirname, fileName);
}

function getNodeHostCommand() {
  return app.isPackaged ? process.execPath : process.env.VIBE_NODE_PATH || "node";
}

function getNodeHostEnv() {
  if (!app.isPackaged) {
    return process.env;
  }

  return {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1"
  };
}

function getAgentShimBaseDir() {
  return (
    process.env.VIBE_AGENT_SHIM_BASE_DIR ||
    path.join(app.getPath("userData"), "agent-shims")
  );
}

function getAgentTelemetry() {
  if (!agentTelemetry) {
    agentTelemetry = createAgentTelemetryManager({
      baseDir: getAgentShimBaseDir(),
      emit: broadcastTerminalEvent
    });
    agentTelemetry.ready.catch((error) => {
      broadcastTerminalEvent({
        type: "host-error",
        message: `Agent telemetry failed to start: ${error.message}`
      });
    });
  }

  return agentTelemetry;
}

function serializeUpdateInfo(info = {}) {
  return {
    version: info.version,
    releaseName: info.releaseName,
    releaseDate: info.releaseDate
  };
}

function publishUpdateState(nextState) {
  updateState = {
    ...updateState,
    ...nextState,
    updatedAt: Date.now()
  };

  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send("updates:event", updateState);
  });
}

function setupAutoUpdater() {
  if (!app.isPackaged || autoUpdaterConfigured) {
    return;
  }

  autoUpdaterConfigured = true;
  const updater = getAutoUpdater();
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;

  updater.on("checking-for-update", () => {
    publishUpdateState({ status: "checking" });
  });

  updater.on("update-available", (info) => {
    publishUpdateState({
      status: "available",
      info: serializeUpdateInfo(info),
      errorMessage: undefined,
      progress: undefined
    });
  });

  updater.on("update-not-available", (info) => {
    publishUpdateState({
      status: "not-available",
      info: serializeUpdateInfo(info),
      errorMessage: undefined,
      progress: undefined
    });
  });

  updater.on("download-progress", (progress) => {
    publishUpdateState({
      status: "downloading",
      progress: {
        percent: progress.percent,
        transferred: progress.transferred,
        total: progress.total
      },
      errorMessage: undefined
    });
  });

  updater.on("update-downloaded", (info) => {
    publishUpdateState({
      status: "downloaded",
      info: serializeUpdateInfo(info),
      progress: undefined,
      errorMessage: undefined
    });
  });

  updater.on("error", (error) => {
    if (updateDownloadRequested || manualUpdateCheckRequested) {
      publishUpdateState({
        status: "error",
        errorMessage: error.message || "Update failed.",
        progress: undefined
      });
      return;
    }

    console.error(`[updates] launch check failed: ${error.message}`);
    publishUpdateState({
      status: "idle",
      errorMessage: undefined,
      progress: undefined
    });
  });
}

async function checkForAppUpdates(options = {}) {
  const silent = Boolean(options.silent);

  if (!app.isPackaged) {
    publishUpdateState({
      status: "disabled",
      errorMessage: undefined,
      progress: undefined
    });

    return {
      ok: false,
      message: "Updates are only available in packaged builds."
    };
  }

  if (updateState.status === "checking") {
    return {
      ok: false,
      message: "An update check is already running."
    };
  }

  if (updateState.status === "downloading") {
    return {
      ok: false,
      message: "An update is already downloading."
    };
  }

  if (updateState.status === "downloaded") {
    return {
      ok: true,
      message: "An update is ready to install."
    };
  }

  setupAutoUpdater();

  if (!silent) {
    manualUpdateCheckRequested = true;
  }

  try {
    await getAutoUpdater().checkForUpdates();

    if (updateState.status === "not-available") {
      return {
        ok: true,
        message: "vibeTerminal is up to date."
      };
    }

    return { ok: true };
  } catch (error) {
    const message = error.message || "Update check failed.";

    if (silent) {
      console.error(`[updates] launch check failed: ${message}`);
      publishUpdateState({
        status: "idle",
        errorMessage: undefined,
        progress: undefined
      });
    } else {
      publishUpdateState({
        status: "error",
        errorMessage: message,
        progress: undefined
      });
    }

    return {
      ok: false,
      message
    };
  } finally {
    if (!silent) {
      manualUpdateCheckRequested = false;
    }
  }
}

async function checkForUpdatesOnLaunch() {
  if (!app.isPackaged || checkedForUpdatesOnLaunch) {
    return;
  }

  checkedForUpdatesOnLaunch = true;
  await checkForAppUpdates({ silent: true });
}

async function downloadAppUpdate() {
  if (!app.isPackaged) {
    return {
      ok: false,
      message: "Updates are only available in packaged builds."
    };
  }

  if (updateState.status === "downloaded") {
    return { ok: true };
  }

  if (!["available", "error"].includes(updateState.status)) {
    return {
      ok: false,
      message: "No downloaded update is waiting."
    };
  }

  setupAutoUpdater();
  updateDownloadRequested = true;

  try {
    publishUpdateState({
      status: "downloading",
      errorMessage: undefined
    });
    await getAutoUpdater().downloadUpdate();
    return { ok: true };
  } catch (error) {
    publishUpdateState({
      status: "error",
      errorMessage: error.message || "Update failed.",
      progress: undefined
    });
    return {
      ok: false,
      message: error.message || "Update failed."
    };
  }
}

function restartAndInstallUpdate() {
  if (!app.isPackaged || updateState.status !== "downloaded") {
    return false;
  }

  setImmediate(() => {
    getAutoUpdater().quitAndInstall(true, true);
  });
  return true;
}

async function findLatestAgentThread(payload) {
  return requestAgentThreadLookup(payload);
}

function broadcastTerminalEvent(event) {
  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send("terminal:event", event);
  });
}

function sendToPtyHost(message) {
  if (!ptyHost || !ptyHost.stdin.writable) {
    broadcastTerminalEvent({
      type: "host-error",
      message: "PTY host is not running."
    });
    return;
  }

  ptyHost.stdin.write(`${JSON.stringify(message)}\n`);
}

function sendResizeToPtyHost(payload) {
  if (!payload?.id) {
    return;
  }

  pendingResizeMessages.set(payload.id, payload);

  if (resizeFlushTimers.has(payload.id)) {
    return;
  }

  const timer = setTimeout(() => {
    resizeFlushTimers.delete(payload.id);
    const latestPayload = pendingResizeMessages.get(payload.id);
    pendingResizeMessages.delete(payload.id);

    if (latestPayload) {
      sendToPtyHost({
        type: "resize",
        payload: latestPayload
      });
    }
  }, 40);

  resizeFlushTimers.set(payload.id, timer);
}

function parsePtyHostOutput(chunk) {
  ptyHostBuffer += chunk.toString("utf8");

  let newlineIndex = ptyHostBuffer.indexOf("\n");
  while (newlineIndex !== -1) {
    const line = ptyHostBuffer.slice(0, newlineIndex).trim();
    ptyHostBuffer = ptyHostBuffer.slice(newlineIndex + 1);

    if (line) {
      try {
        const event = JSON.parse(line);
        if (event.type === "ready") {
          ptyHostReady = true;
        }
        if (event.type === "exit" && event.id) {
          releaseTerminalResources(event.id);
        }
        broadcastTerminalEvent(event);
      } catch (error) {
        broadcastTerminalEvent({
          type: "host-error",
          message: `Could not parse PTY host event: ${line}`
        });
      }
    }

    newlineIndex = ptyHostBuffer.indexOf("\n");
  }
}

function releaseTerminalResources(sessionId) {
  const timer = resizeFlushTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    resizeFlushTimers.delete(sessionId);
  }
  pendingResizeMessages.delete(sessionId);
  agentTelemetry?.releaseSession(sessionId);
}

function startPtyHost() {
  if (ptyHost) {
    return;
  }

  const nodeBinary = getNodeHostCommand();
  ptyHost = spawn(nodeBinary, [getPtyHostPath()], {
    cwd: getDefaultRuntimeCwd(),
    env: getNodeHostEnv(),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });

  ptyHost.stdout.on("data", parsePtyHostOutput);

  ptyHost.stderr.on("data", (chunk) => {
    const message = chunk.toString("utf8");
    if (
      message.includes("conpty_console_list_agent.js") &&
      message.includes("AttachConsole failed")
    ) {
      return;
    }

    broadcastTerminalEvent({
      type: "host-error",
      message
    });
  });

  ptyHost.on("error", (error) => {
    broadcastTerminalEvent({
      type: "host-error",
      message: `Failed to start PTY host with "${nodeBinary}": ${error.message}`
    });
  });

  ptyHost.on("exit", (code, signal) => {
    const wasReady = ptyHostReady;
    ptyHost = null;
    ptyHostReady = false;
    broadcastTerminalEvent({
      type: "host-exit",
      message: wasReady
        ? `PTY host exited (${code ?? signal ?? "unknown"}).`
        : `PTY host failed before it was ready (${code ?? signal ?? "unknown"}).`
    });
  });
}

function resolveAgentThreadRequest(requestId, result) {
  const pending = pendingAgentThreadRequests.get(requestId);
  if (!pending) {
    return;
  }

  pendingAgentThreadRequests.delete(requestId);
  clearTimeout(pending.timeout);
  pending.resolve(result);
}

function failPendingAgentThreadRequests(message) {
  pendingAgentThreadRequests.forEach((pending) => {
    clearTimeout(pending.timeout);
    pending.resolve({
      status: "failed",
      message
    });
  });
  pendingAgentThreadRequests.clear();
}

function parseAgentThreadHostOutput(chunk) {
  agentThreadHostBuffer += chunk.toString("utf8");

  let newlineIndex = agentThreadHostBuffer.indexOf("\n");
  while (newlineIndex !== -1) {
    const line = agentThreadHostBuffer.slice(0, newlineIndex).trim();
    agentThreadHostBuffer = agentThreadHostBuffer.slice(newlineIndex + 1);

    if (line) {
      try {
        const event = JSON.parse(line);
        if (event.type === "ready") {
          agentThreadHostReady = true;
        } else if (event.type === "response") {
          resolveAgentThreadRequest(event.requestId, event.result);
        } else if (event.type === "error" && event.requestId) {
          resolveAgentThreadRequest(event.requestId, {
            status: "failed",
            message: event.message || "Agent thread discovery failed."
          });
        }
      } catch {
        // Discovery host errors are returned through individual requests when possible.
      }
    }

    newlineIndex = agentThreadHostBuffer.indexOf("\n");
  }
}

function startAgentThreadHost() {
  if (agentThreadHost) {
    return;
  }

  const nodeBinary = getNodeHostCommand();
  agentThreadHost = spawn(nodeBinary, [getAgentThreadHostPath()], {
    cwd: getDefaultRuntimeCwd(),
    env: getNodeHostEnv(),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });

  agentThreadHost.stdout.on("data", parseAgentThreadHostOutput);
  agentThreadHost.stderr.on("data", (chunk) => {
    const message = chunk.toString("utf8").trim();
    if (message) {
      console.error(`[agent-thread-host] ${message}`);
    }
  });
  agentThreadHost.on("error", (error) => {
    failPendingAgentThreadRequests(`Agent thread discovery host failed: ${error.message}`);
  });
  agentThreadHost.on("exit", (code, signal) => {
    const wasReady = agentThreadHostReady;
    agentThreadHost = null;
    agentThreadHostReady = false;
    agentThreadHostBuffer = "";
    failPendingAgentThreadRequests(
      wasReady
        ? `Agent thread discovery host exited (${code ?? signal ?? "unknown"}).`
        : `Agent thread discovery host failed before it was ready (${code ?? signal ?? "unknown"}).`
    );
  });
}

function requestAgentThreadLookup(payload) {
  startAgentThreadHost();

  if (!agentThreadHost || !agentThreadHost.stdin.writable) {
    return Promise.resolve({
      status: "failed",
      message: "Agent thread discovery host is not running."
    });
  }

  const requestId = nextAgentThreadRequestId;
  nextAgentThreadRequestId += 1;

  const message = {
    type: "lookup",
    requestId,
    payload
  };

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pendingAgentThreadRequests.delete(requestId);
      resolve({
        status: "failed",
        message: "Agent thread discovery timed out."
      });
    }, 15_000);

    pendingAgentThreadRequests.set(requestId, {
      resolve,
      timeout
    });
    agentThreadHost.stdin.write(`${JSON.stringify(message)}\n`);
  });
}

function createMainWindow() {
  const screenshotPath =
    process.env.VIBE_INTERNAL_SCREENSHOT === "0" ? null : process.env.VIBE_SCREENSHOT_PATH;
  let screenshotScheduled = false;
  const workArea = screen.getPrimaryDisplay().workArea;
  const screenshotBounds = {
    x: workArea.x,
    y: workArea.y,
    width: Math.min(1200, workArea.width),
    height: Math.min(820, workArea.height)
  };

  function scheduleScreenshotCapture() {
    if (!screenshotPath || screenshotScheduled) {
      return;
    }

    screenshotScheduled = true;
    const delayMs = Number(process.env.VIBE_SCREENSHOT_DELAY_MS || 3500);
    setTimeout(async () => {
      try {
        const image = await mainWindow.webContents.capturePage();
        fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
        fs.writeFileSync(screenshotPath, image.toPNG());
      } catch (error) {
        console.error(error);
        process.exitCode = 1;
      } finally {
        app.quit();
      }
    }, delayMs);
  }

  mainWindow = new BrowserWindow({
    x: isScreenshotMode ? screenshotBounds.x : undefined,
    y: isScreenshotMode ? screenshotBounds.y : undefined,
    width: isScreenshotMode ? screenshotBounds.width : 1440,
    height: isScreenshotMode ? screenshotBounds.height : 960,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#111312",
    icon: getAppIconPath(),
    title: "vibeTerminal",
    show: isScreenshotMode,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.once("ready-to-show", () => {
    if (isScreenshotMode) {
      mainWindow.maximize();
    }
    mainWindow.show();
    scheduleScreenshotCapture();
  });

  if (isScreenshotMode) {
    mainWindow.maximize();
  }

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    mainWindow.loadURL(devServerUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }

  scheduleScreenshotCapture();
}

app.whenReady().then(() => {
  getAgentTelemetry();
  startPtyHost();
  startAgentThreadHost();
  createMainWindow();
  setTimeout(checkForUpdatesOnLaunch, 1500);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (agentTelemetry) {
    agentTelemetry.cleanup();
    agentTelemetry = null;
  }

  if (ptyHost && !ptyHost.killed) {
    sendToPtyHost({ type: "shutdown" });
    ptyHost.kill();
  }

  if (agentThreadHost && !agentThreadHost.killed) {
    agentThreadHost.stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`);
    agentThreadHost.kill();
  }

  if (process.platform !== "darwin") {
    app.quit();
  }
});

ipcMain.handle("app:get-cwd", () => getDefaultRuntimeCwd());

ipcMain.handle("updates:get-state", () => updateState);

ipcMain.handle("updates:check", () => checkForAppUpdates());

ipcMain.handle("updates:download", () => downloadAppUpdate());

ipcMain.handle("updates:restart", () => restartAndInstallUpdate());

ipcMain.handle("workspace:select-folder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
    title: "Open project folder"
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  return result.filePaths[0];
});

ipcMain.handle("workspace:code-changes", (_event, payload) =>
  getCodeChangeSummary(payload?.cwd)
);

ipcMain.handle("agent-thread:latest", (_event, payload) =>
  findLatestAgentThread(payload)
);

ipcMain.handle("terminal:create", async (_event, payload) => {
  startPtyHost();
  const instrumentation = await getAgentTelemetry().prepareSession(payload?.id);
  sendToPtyHost({
    type: "create",
    payload: {
      ...payload,
      instrumentation
    }
  });
  return true;
});

ipcMain.handle("terminal:input", (_event, payload) => {
  sendToPtyHost({
    type: "input",
    payload
  });
  return true;
});

ipcMain.on("terminal:input", (_event, payload) => {
  sendToPtyHost({
    type: "input",
    payload
  });
});

ipcMain.handle("terminal:resize", (_event, payload) => {
  sendResizeToPtyHost(payload);
  return true;
});

ipcMain.on("terminal:resize", (_event, payload) => {
  sendResizeToPtyHost(payload);
});

ipcMain.handle("terminal:kill", (_event, payload) => {
  if (payload?.id) {
    releaseTerminalResources(payload.id);
  }

  sendToPtyHost({
    type: "kill",
    payload
  });
  return true;
});
