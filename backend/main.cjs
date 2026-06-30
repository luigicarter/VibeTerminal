const {
  app,
  BrowserWindow,
  Menu,
  clipboard,
  dialog,
  ipcMain,
  screen
} = require("electron");
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
let fusionChatHost = null;
let fusionChatHostBuffer = "";
let autoUpdater = null;
let autoUpdaterConfigured = false;
let checkedForUpdatesOnLaunch = false;
let updateDownloadRequested = false;
let manualUpdateCheckRequested = false;
let updateState = {
  status: app.isPackaged ? "idle" : "disabled",
  updatedAt: Date.now()
};
const FUSION_MODEL_ID_PATTERN = /^[A-Za-z0-9._:/@+-]+$/;

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

function getFusionChatHostPath() {
  return getHelperHostPath("fusionChatHost.cjs");
}

// Resolve the embedded Codex binary each Fusion pane spawns its own instance of:
// packaged builds must use resources/codex-bin and fail closed if it is absent.
// Dev builds use vendor/codex-bin when prepared, with PATH `codex` as a local
// convenience only. See scripts/dev/prepare-codex-bin.cjs.
function resolveCodexBin() {
  const exe = process.platform === "win32" ? "codex.exe" : "codex";
  const platDir = `${process.platform}-${process.arch}`;
  const bundled = app.isPackaged
    ? path.join(process.resourcesPath, "codex-bin", platDir, exe)
    : path.join(__dirname, "..", "vendor", "codex-bin", platDir, exe);
  try {
    if (fs.existsSync(bundled)) {
      return bundled;
    }
  } catch {
    // handled below
  }
  if (app.isPackaged) {
    throw new Error(
      `Fusion is missing its embedded Codex binary at ${bundled}. ` +
        "Rebuild the release after running npm run prepare:codex-bin:required."
    );
  }
  return "codex";
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
  if (
    event?.type === "fusion-activity" &&
    event.id &&
    fusionChatHost &&
    fusionChatHost.stdin.writable
  ) {
    sendToFusionChatHost({ type: "activity", payload: event });
  }

  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send("terminal:event", event);
  });
}

function sendToPtyHost(message) {
  if (!ptyHost || !ptyHost.stdin.writable) {
    broadcastTerminalEvent({
      type: "host-error",
      id: message?.payload?.id,
      message: "PTY host is not running."
    });
    return false;
  }

  ptyHost.stdin.write(`${JSON.stringify(message)}\n`);
  return true;
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

function broadcastFusionChatEvent(event) {
  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send("fusion-chat:event", event);
  });
}

function parseFusionChatHostOutput(chunk) {
  fusionChatHostBuffer += chunk.toString("utf8");
  let newlineIndex = fusionChatHostBuffer.indexOf("\n");
  while (newlineIndex !== -1) {
    const line = fusionChatHostBuffer.slice(0, newlineIndex).trim();
    fusionChatHostBuffer = fusionChatHostBuffer.slice(newlineIndex + 1);
    if (line) {
      try {
        const message = JSON.parse(line);
        if (message.type === "event") {
          broadcastFusionChatEvent({ id: message.id, ...message.event });
        } else if (message.type === "closed") {
          broadcastFusionChatEvent({ id: message.id, type: "closed", code: message.code });
        }
      } catch {
        // Ignore non-JSON host noise.
      }
    }
    newlineIndex = fusionChatHostBuffer.indexOf("\n");
  }
}

function startFusionChatHost() {
  if (fusionChatHost) {
    return;
  }
  const nodeBinary = getNodeHostCommand();
  fusionChatHost = spawn(nodeBinary, [getFusionChatHostPath()], {
    cwd: getDefaultRuntimeCwd(),
    env: getNodeHostEnv(),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  fusionChatHost.stdout.on("data", parseFusionChatHostOutput);
  fusionChatHost.stderr.on("data", (chunk) => {
    const message = chunk.toString("utf8").trim();
    if (message) {
      broadcastFusionChatEvent({
        type: "host-error",
        message: `Fusion chat host error: ${message}`
      });
    }
  });
  fusionChatHost.on("error", (error) => {
    broadcastFusionChatEvent({
      type: "host-error",
      message: `Fusion chat host failed: ${error.message}`
    });
  });
  fusionChatHost.on("exit", (code, signal) => {
    fusionChatHost = null;
    fusionChatHostBuffer = "";
    broadcastFusionChatEvent({
      type: "host-error",
      message: `Fusion chat host exited (${code ?? signal ?? "unknown"}).`
    });
  });
}

function sendToFusionChatHost(message) {
  if (!fusionChatHost || !fusionChatHost.stdin.writable) {
    return false;
  }
  fusionChatHost.stdin.write(`${JSON.stringify(message)}\n`);
  return true;
}

function normalizeFusionString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeFusionModelId(value, fallback) {
  const model = normalizeFusionString(value);
  if (!model || model.length > 96 || !FUSION_MODEL_ID_PATTERN.test(model)) {
    return fallback;
  }
  return model;
}

function normalizeFusionModel(value) {
  const model = normalizeFusionModelId(value, "opus");
  const lower = model.toLowerCase();
  if (lower === "sonnet" || lower === "fast") return "sonnet";
  if (lower === "opus") return "opus";
  return model;
}

function normalizeFusionCodexModel(value) {
  const model = normalizeFusionModelId(value, "auto");
  const lower = model.toLowerCase();
  return lower === "auto" || lower === "default" ? undefined : model;
}

function normalizeFusionEffort(value) {
  const effort = normalizeFusionString(value)?.toLowerCase();
  return ["low", "medium", "high", "xhigh", "max"].includes(effort)
    ? effort
    : undefined;
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

  if (fusionChatHost && !fusionChatHost.killed) {
    sendToFusionChatHost({ type: "shutdown" });
    fusionChatHost.kill();
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
  const telemetry = getAgentTelemetry();
  // Fusion panes do NOT use the PTY path — they run headless via fusion-chat:start.
  const instrumentation = await telemetry.prepareSession(payload?.id);

  // Cursor's stop hook lives in the project's .cursor/hooks.json, so install it
  // (idempotently) whenever a cursor-agent pane launches and the cwd is known.
  if (
    payload?.cwd &&
    typeof payload.command === "string" &&
    /\bcursor-agent\b/.test(payload.command)
  ) {
    telemetry.ensureCursorProjectHooks(payload.cwd).catch(() => {});
  }

  return sendToPtyHost({
    type: "create",
    payload: {
      ...payload,
      instrumentation
    }
  });
});

ipcMain.handle("fusion-chat:start", async (_event, payload) => {
  const id = payload?.id;
  if (!id) {
    return { ok: false, error: "missing session id" };
  }
  try {
    const codexBin = resolveCodexBin();
    startFusionChatHost();
    const fusionModel = normalizeFusionModel(payload.model);
    const payloadCodexModel =
      typeof payload.codexModel === "string" ? payload.codexModel.trim() : "";
    const rawCodexModel =
      payloadCodexModel &&
      payloadCodexModel.toLowerCase() !== "auto" &&
      payloadCodexModel.toLowerCase() !== "default"
        ? payloadCodexModel
        : process.env.VIBE_FUSION_CODEX_MODEL;
    const fusionCodexModel = normalizeFusionCodexModel(rawCodexModel);
    const fusionClaudeEffort = normalizeFusionEffort(payload.effort);
    const fusionCodexEffort = normalizeFusionEffort(payload.codexEffort ?? payload.effort);
    const telemetry = getAgentTelemetry();
    const files = await telemetry.prepareFusionFiles(id, {
      cwd: payload.cwd,
      codexBin,
      codexModel: fusionCodexModel,
      codexEffort: fusionCodexEffort
    });
    if (!files) {
      return { ok: false, error: "could not prepare Fusion files" };
    }
    const sent = sendToFusionChatHost({
      type: "start",
      payload: {
        id,
        cwd: payload.cwd,
        mcpConfig: files.mcpConfig,
        systemPromptFile: files.systemPromptFile,
        model: fusionModel,
        effort: fusionClaudeEffort,
        // Opus orchestrates: it may READ/search to plan and review, and drives
        // Codex through the bridge tools — but it has NO direct edit/shell tools,
        // so every code change goes through codex_implement (the point of Fusion).
        allowedTools:
          "mcp__fusion-codex__codex_implement,mcp__fusion-codex__codex_respond,mcp__fusion-codex__codex_goal_set,mcp__fusion-codex__codex_goal_get,mcp__fusion-codex__codex_goal_clear,Read,Glob,Grep",
        // Belt-and-suspenders: hard-block stable mutation/shell tool names
        // regardless of permission mode. The allowlist above is the primary
        // control; avoid optional tool names that some Claude builds warn about.
        disallowedTools: "Edit,Write,Bash",
        resumeId: payload.resumeId || undefined
      }
    });
    if (!sent) {
      return { ok: false, error: "Fusion chat host is not running." };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle("fusion-chat:interrupt", (_event, payload) => {
  if (payload?.id) {
    getAgentTelemetry()
      .interruptFusionSession(payload.id)
      .catch(() => {});
    sendToFusionChatHost({ type: "interrupt", payload: { id: payload.id } });
  }
  return true;
});

ipcMain.handle("fusion-chat:stop", (_event, payload) => {
  if (payload?.id) {
    getAgentTelemetry()
      .stopFusionSession(payload.id)
      .catch(() => {});
    sendToFusionChatHost({ type: "stop", payload: { id: payload.id } });
    getAgentTelemetry().releaseSession(payload.id);
  }
  return true;
});

ipcMain.on("fusion-chat:input", (_event, payload) => {
  if (payload?.id && typeof payload.text === "string") {
    const sent = sendToFusionChatHost({
      type: "input",
      payload: { id: payload.id, text: payload.text }
    });
    if (!sent) {
      broadcastFusionChatEvent({
        id: payload.id,
        type: "error",
        message: "Fusion chat host is not running. Restart Fusion to continue."
      });
    }
  }
});

ipcMain.on("fusion-chat:steer", (_event, payload) => {
  if (payload?.id && typeof payload.text === "string") {
    getAgentTelemetry()
      .steerFusionSession(payload.id, payload.text)
      .catch(() => {});
    const sent = sendToFusionChatHost({
      type: "input",
      payload: { id: payload.id, text: payload.text, steer: true }
    });
    if (!sent) {
      broadcastFusionChatEvent({
        id: payload.id,
        type: "error",
        message: "Fusion chat host is not running. Restart Fusion to continue."
      });
    }
  }
});

ipcMain.handle("terminal:show-context-menu", (event, payload = {}) => {
  const sessionId = typeof payload.id === "string" ? payload.id : null;
  const selectionText =
    typeof payload.selectionText === "string" ? payload.selectionText : "";
  const hasSelection = selectionText.length > 0;
  const hasClipboardText = clipboard.readText().length > 0;

  const menu = Menu.buildFromTemplate([
    {
      label: "Copy",
      enabled: hasSelection,
      click: () => {
        clipboard.writeText(selectionText);
      }
    },
    {
      label: "Paste",
      enabled: Boolean(sessionId && hasClipboardText),
      click: () => {
        if (!sessionId) {
          return;
        }

        event.sender.send("terminal:context-menu-paste", {
          id: sessionId,
          text: clipboard.readText()
        });
      }
    }
  ]);

  const browserWindow = BrowserWindow.fromWebContents(event.sender);
  menu.popup(browserWindow ? { window: browserWindow } : {});
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
