const { app, BrowserWindow, dialog, ipcMain, screen } = require("electron");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { createAgentTelemetryManager } = require("./agentTelemetry.cjs");

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

function getPtyHostPath() {
  return path.join(__dirname, "ptyHost.cjs");
}

function getAgentThreadHostPath() {
  return path.join(__dirname, "agentThreadHost.cjs");
}

function getAgentTelemetry() {
  if (!agentTelemetry) {
    agentTelemetry = createAgentTelemetryManager({
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

  const nodeBinary = process.env.VIBE_NODE_PATH || "node";
  ptyHost = spawn(nodeBinary, [getPtyHostPath()], {
    cwd: process.cwd(),
    env: process.env,
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

  const nodeBinary = process.env.VIBE_NODE_PATH || "node";
  agentThreadHost = spawn(nodeBinary, [getAgentThreadHostPath()], {
    cwd: process.cwd(),
    env: process.env,
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

ipcMain.handle("app:get-cwd", () => process.cwd());

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
