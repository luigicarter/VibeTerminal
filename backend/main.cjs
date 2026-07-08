const {
  app,
  BrowserWindow,
  Menu,
  clipboard,
  dialog,
  ipcMain,
  screen,
  shell
} = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { createAgentTelemetryManager } = require("./agentTelemetry.cjs");
const { createBuildSupervisor } = require("./buildSupervisor.cjs");
const { fetchClaudeModelCatalog } = require("./claudeModels.cjs");
const { fetchCodexModelCatalog } = require("./codexModels.cjs");
const { getCodeChangeSummary } = require("./codeChanges.cjs");
const { resolveLaunchCwd } = require("./launchCwd.cjs");

const isScreenshotMode =
  process.env.VIBE_SCREENSHOT_MODE === "1" || Boolean(process.env.VIBE_SCREENSHOT_PATH);
const IMAGE_FILE_EXTENSIONS = new Set([
  ".apng",
  ".avif",
  ".bmp",
  ".gif",
  ".heic",
  ".heif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".tif",
  ".tiff",
  ".webp"
]);
const TEXT_FILE_EXTENSIONS = new Set([
  ".bat",
  ".c",
  ".cc",
  ".cfg",
  ".cjs",
  ".clj",
  ".cmd",
  ".conf",
  ".cpp",
  ".cs",
  ".css",
  ".csv",
  ".cts",
  ".env",
  ".go",
  ".h",
  ".hpp",
  ".html",
  ".ini",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".kt",
  ".less",
  ".log",
  ".lua",
  ".md",
  ".mdx",
  ".mjs",
  ".mts",
  ".php",
  ".ps1",
  ".py",
  ".rb",
  ".rs",
  ".sass",
  ".scss",
  ".sh",
  ".sql",
  ".svelte",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".vue",
  ".xml",
  ".yaml",
  ".yml"
]);
const MAX_DESCRIBE_PATHS = 32;
const TEXT_SAMPLE_BYTES = 4096;
const FUSION_MODEL_CATALOG_TTL_MS = 5 * 60 * 1000;
const fusionModelCatalogCache = new Map();

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
let buildSupervisor = null;
let fusionChatHost = null;
let fusionChatHostBuffer = "";
let openFusionChatHost = null;
let openFusionChatHostBuffer = "";
let autoUpdater = null;
let autoUpdaterConfigured = false;
let checkedForUpdatesOnLaunch = false;
let updateDownloadRequested = false;
let manualUpdateCheckRequested = false;
let updateState = {
  status: app.isPackaged ? "idle" : "disabled",
  currentVersion: app.getVersion(),
  updatedAt: Date.now()
};
const FUSION_MODEL_ID_PATTERN = /^[A-Za-z0-9._:/@+-]+$/;
// Open Fusion has NO default models: "" = not chosen yet. The pane gates the
// first turn on connecting a provider and picking Brain/Executor instead of
// assuming a vendor pair the (app-owned, initially empty) store can't serve.
const OPEN_FUSION_MODEL_UNSET = "";
const FUSION_CODEX_BRIDGE_TOOLS = [
  "mcp__fusion-codex__codex_investigate",
  "mcp__fusion-codex__codex_implement",
  "mcp__fusion-codex__codex_respond",
  "mcp__fusion-codex__codex_steer_resolve",
  "mcp__fusion-codex__codex_goal_set",
  "mcp__fusion-codex__codex_goal_get",
  "mcp__fusion-codex__codex_goal_clear",
  "mcp__fusion-codex__codex_watch_build",
  "mcp__fusion-codex__codex_build_status",
  "mcp__fusion-codex__codex_build_cancel",
  // The wedge escape hatch: without it on the strict --tools/--allowedTools
  // surface, a stuck Codex turn leaves pane-restart as the only recovery.
  "mcp__fusion-codex__codex_cancel"
];
// Claude is the read-only planner: every file modification goes through the
// Codex executor. The edit tools are kept off the --tools surface AND
// hard-blocked via --disallowedTools so a prompt or surface regression can't
// silently re-open direct writes.
const FUSION_CLAUDE_BUILTIN_TOOLS = ["Read", "Glob", "Grep"];
const FUSION_CLAUDE_EDIT_DENY_TOOLS = ["Edit", "Write", "NotebookEdit"];

function pathFromFileUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "file:") return value;
    const pathname =
      process.platform === "win32" && /^\/[A-Za-z]:/.test(url.pathname)
        ? url.pathname.slice(1)
        : url.pathname;
    return decodeURIComponent(pathname).replace(
      /\//g,
      process.platform === "win32" ? "\\" : "/"
    );
  } catch {
    return value;
  }
}

function normalizeIncomingFilePath(value, cwd) {
  let text = String(value || "").trim();
  if (!text) return null;
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    text = text.slice(1, -1);
  }
  if (/^file:\/\//i.test(text)) {
    text = pathFromFileUrl(text);
  }
  if (text === "~" || text.startsWith(`~${path.sep}`) || text.startsWith("~/")) {
    text = path.join(os.homedir(), text.slice(1));
  }
  return path.isAbsolute(text) ? path.normalize(text) : path.resolve(cwd || process.cwd(), text);
}

function looksLikeTextSample(buffer) {
  if (!buffer || buffer.length === 0) return true;
  let controlCount = 0;
  for (const byte of buffer) {
    if (byte === 0) return false;
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 12 && byte !== 13) {
      controlCount += 1;
    }
  }
  return controlCount / buffer.length < 0.04;
}

async function readFileSample(filePath) {
  const handle = await fs.promises.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(TEXT_SAMPLE_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, TEXT_SAMPLE_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function countTextLines(filePath) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    let lines = 0;
    let lastByte = null;
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => {
      bytes += chunk.length;
      for (const byte of chunk) {
        if (byte === 10) lines += 1;
      }
      if (chunk.length > 0) {
        lastByte = chunk[chunk.length - 1];
      }
    });
    stream.on("error", reject);
    stream.on("end", () => {
      resolve(lines + (bytes > 0 && lastByte !== 10 ? 1 : 0));
    });
  });
}

async function describeFilePath(rawPath, cwd) {
  const resolvedPath = normalizeIncomingFilePath(rawPath, cwd);
  if (!resolvedPath) return null;

  try {
    const stat = await fs.promises.stat(resolvedPath);
    if (stat.isDirectory()) {
      return { path: resolvedPath, kind: "directory", label: "[folder]" };
    }
    if (!stat.isFile()) {
      return { path: resolvedPath, kind: "file", label: "[file]" };
    }

    const extension = path.extname(resolvedPath).toLowerCase();
    if (IMAGE_FILE_EXTENSIONS.has(extension)) {
      return { path: resolvedPath, kind: "image", label: "[image]" };
    }

    const isKnownText = TEXT_FILE_EXTENSIONS.has(extension);
    const sample = isKnownText ? null : await readFileSample(resolvedPath);
    if (isKnownText || looksLikeTextSample(sample)) {
      const lineCount = await countTextLines(resolvedPath);
      return {
        path: resolvedPath,
        kind: "text",
        lineCount,
        label: `[${lineCount} ${lineCount === 1 ? "line" : "lines"}]`
      };
    }

    return { path: resolvedPath, kind: "file", label: "[file]" };
  } catch (error) {
    return {
      path: resolvedPath,
      kind: "missing",
      label: "[missing]",
      error: error.message
    };
  }
}

async function describeFilePaths(payload = {}) {
  const cwd = typeof payload.cwd === "string" ? payload.cwd : process.cwd();
  const rawPaths = Array.isArray(payload.paths) ? payload.paths : [];
  const seen = new Set();
  const paths = rawPaths
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .filter((value) => {
      const key = value.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_DESCRIBE_PATHS);
  const results = [];
  for (const rawPath of paths) {
    const result = await describeFilePath(rawPath, cwd);
    if (result) results.push(result);
  }
  return results;
}

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

function getOpenFusionChatHostPath() {
  return getHelperHostPath("openFusionChatHost.cjs");
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

function getOpenFusionBaseDir() {
  return (
    process.env.VIBE_OPEN_FUSION_BASE_DIR ||
    path.join(app.getPath("userData"), "openfusion")
  );
}

function getBuildSupervisorDir() {
  return (
    process.env.VIBE_BUILD_SUPERVISOR_DIR ||
    path.join(app.getPath("userData"), "builds")
  );
}

function getAgentTelemetry() {
  if (!agentTelemetry) {
    agentTelemetry = createAgentTelemetryManager({
      baseDir: getAgentShimBaseDir(),
      openFusionBaseDir: getOpenFusionBaseDir(),
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

function getBuildSupervisor() {
  if (!buildSupervisor) {
    buildSupervisor = createBuildSupervisor({
      baseDir: getBuildSupervisorDir(),
      emit: broadcastTerminalEvent
    });
    buildSupervisor.start();
  }

  return buildSupervisor;
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

  // Detached background delegation lifecycle (adapter telemetry): the fusion
  // chat host owns the registry, the pane events, and the planner wake.
  if (
    event?.type === "fusion-background-task" &&
    event.id &&
    fusionChatHost &&
    fusionChatHost.stdin.writable
  ) {
    sendToFusionChatHost({ type: "background-task", payload: event });
  }

  // Detached build lifecycle. Started events from the adapter register with
  // the host-owned supervisor; settled supervisor events wake the planner
  // through the Fusion chat host's build-task path.
  if (event?.type === "fusion-build-task" && event.phase === "started") {
    if (
      event.buildId &&
      event.command &&
      event.cwd &&
      event.pid &&
      event.logPath &&
      event.sentinelPath
    ) {
      try {
        getBuildSupervisor().register({
          buildId: event.buildId,
          sessionId: event.id,
          command: event.command,
          cwd: event.cwd,
          pid: event.pid,
          logPath: event.logPath,
          sentinelPath: event.sentinelPath,
          startedAt: event.startedAt
        });
      } catch (error) {
        broadcastTerminalEvent({
          type: "host-error",
          message: `Build supervisor registration failed: ${error.message}`
        });
      }
    }
    if (event.id && fusionChatHost && fusionChatHost.stdin.writable) {
      sendToFusionChatHost({
        type: "build-task",
        payload: {
          ...event,
          id: event.id,
          phase: "started"
        }
      });
    }
  }

  if (event?.type === "fusion-build-task" && event.phase === "cancel-request") {
    try {
      getBuildSupervisor().cancel(String(event.buildId || ""));
    } catch (error) {
      broadcastTerminalEvent({
        type: "host-error",
        message: `Build supervisor cancellation failed: ${error.message}`
      });
    }
  }

  if (event?.type === "build-task" && event.phase === "settled") {
    if (event.sessionId && fusionChatHost && fusionChatHost.stdin.writable) {
      sendToFusionChatHost({
        type: "build-task",
        payload: {
          ...event,
          id: event.sessionId
        }
      });
    }
  }

  // Brain-initiated background delegation request (Open Fusion MCP bridge):
  // the Open Fusion host owns the detached executor session and the wake.
  if (
    event?.type === "openfusion-background-request" &&
    event.id &&
    openFusionChatHost &&
    openFusionChatHost.stdin.writable
  ) {
    sendToOpenFusionChatHost({ type: "background-request", payload: event });
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
          const fusionEvent = { id: message.id, ...message.event };
          broadcastFusionChatEvent(fusionEvent);
          // Replayed history must not re-assert a stale background chip
          // through the terminal channel; live tracking already settled it.
          if (message.event?.type === "background-activity" && !message.event.replay) {
            broadcastTerminalEvent({
              id: message.id,
              type: "agent-background-activity",
              provider: "claude",
              backgroundActivity: message.event.backgroundActivity
            });
          }
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

function broadcastOpenFusionChatEvent(event) {
  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send("openfusion-chat:event", event);
  });
}

function parseOpenFusionChatHostOutput(chunk) {
  openFusionChatHostBuffer += chunk.toString("utf8");
  let newlineIndex = openFusionChatHostBuffer.indexOf("\n");
  while (newlineIndex !== -1) {
    const line = openFusionChatHostBuffer.slice(0, newlineIndex).trim();
    openFusionChatHostBuffer = openFusionChatHostBuffer.slice(newlineIndex + 1);
    if (line) {
      try {
        const message = JSON.parse(line);
        if (message.type === "event") {
          broadcastOpenFusionChatEvent({ id: message.id, ...message.event });
        }
      } catch {
        // Ignore non-JSON host noise.
      }
    }
    newlineIndex = openFusionChatHostBuffer.indexOf("\n");
  }
}

function startOpenFusionChatHost() {
  if (openFusionChatHost) {
    return;
  }
  const nodeBinary = getNodeHostCommand();
  openFusionChatHost = spawn(nodeBinary, [getOpenFusionChatHostPath()], {
    cwd: getDefaultRuntimeCwd(),
    env: getNodeHostEnv(),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  openFusionChatHost.stdout.on("data", parseOpenFusionChatHostOutput);
  openFusionChatHost.stderr.on("data", (chunk) => {
    const message = chunk.toString("utf8").trim();
    if (message) {
      broadcastOpenFusionChatEvent({
        type: "host-error",
        message: `Open Fusion chat host error: ${message}`
      });
    }
  });
  openFusionChatHost.on("error", (error) => {
    broadcastOpenFusionChatEvent({
      type: "host-error",
      message: `Open Fusion chat host failed: ${error.message}`
    });
  });
  openFusionChatHost.on("exit", (code, signal) => {
    openFusionChatHost = null;
    openFusionChatHostBuffer = "";
    broadcastOpenFusionChatEvent({
      type: "host-error",
      message: `Open Fusion chat host exited (${code ?? signal ?? "unknown"}).`
    });
  });
}

function sendToOpenFusionChatHost(message) {
  if (!openFusionChatHost || !openFusionChatHost.stdin.writable) {
    return false;
  }
  openFusionChatHost.stdin.write(`${JSON.stringify(message)}\n`);
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

function normalizeFusionCatalogFamily(value) {
  const family = typeof value === "string" ? value.trim().toLowerCase() : "";
  return family === "claude" || family === "codex" ? family : family || "unknown";
}

async function listFusionModelCatalog(family) {
  if (family !== "claude" && family !== "codex") {
    return { ok: true, family, models: null };
  }
  const cached = fusionModelCatalogCache.get(family);
  if (cached && Date.now() - cached.fetchedAt < FUSION_MODEL_CATALOG_TTL_MS) {
    return { ok: true, family, models: cached.models };
  }
  let models;
  if (family === "codex") {
    let codexBin;
    try {
      codexBin = resolveCodexBin();
    } catch {
      codexBin = null;
    }
    models = codexBin ? await fetchCodexModelCatalog({ codexBin }) : null;
  } else {
    models = await fetchClaudeModelCatalog();
  }
  const catalog = Array.isArray(models) ? models : null;
  fusionModelCatalogCache.set(family, { fetchedAt: Date.now(), models: catalog });
  return { ok: true, family, models: catalog };
}

function normalizeFusionCodexModel(value) {
  const model = normalizeFusionModelId(value, "auto");
  const lower = model.toLowerCase();
  return lower === "auto" || lower === "default" ? undefined : model;
}

// Which CLI family backs a Fusion role. Either role can run either family.
function normalizeFusionFamily(value, fallback) {
  const lower = normalizeFusionString(value)?.toLowerCase();
  return lower === "claude" || lower === "codex" ? lower : fallback;
}

// Claude-side effort for EITHER role: the claude --effort enum. Codex-only
// levels coerce to the nearest real level so a family flip never launches
// claude with an unknown variant.
function normalizeFusionClaudeRoleEffort(value) {
  const effort = normalizeFusionString(value)?.toLowerCase();
  if (effort === "minimal") return "low";
  if (effort === "ultra") return "max";
  return ["low", "medium", "high", "xhigh", "max"].includes(effort)
    ? effort
    : undefined;
}

// Executor model for the claude family ("fast" shorthand maps to sonnet;
// unknown/auto falls back to sonnet — the executor default for Claude).
function normalizeFusionClaudeExecutorModel(value) {
  const model = normalizeFusionModelId(value, "sonnet");
  const lower = model.toLowerCase();
  if (lower === "fast" || lower === "auto" || lower === "default") return "sonnet";
  return model;
}

function normalizeOpenFusionModel(value, fallback) {
  const model = normalizeFusionModelId(value, fallback);
  const lower = model.toLowerCase();
  return lower === "auto" || lower === "default" ? fallback : model;
}

function normalizeFusionEffort(value) {
  const effort = normalizeFusionString(value)?.toLowerCase();
  return ["low", "medium", "high", "xhigh", "max"].includes(effort)
    ? effort
    : undefined;
}

// Codex speaks its own effort enum (verified against the codex 0.142 binary):
// minimal..ultra, NO "max". Legacy "max" (from panes saved before the
// per-engine split) coerces to xhigh instead of failing every delegation.
function normalizeFusionCodexEffort(value) {
  const effort = normalizeFusionString(value)?.toLowerCase();
  if (effort === "max") return "xhigh";
  return ["minimal", "low", "medium", "high", "xhigh", "ultra"].includes(effort)
    ? effort
    : undefined;
}

function normalizeFusionRunMode(value) {
  return normalizeFusionString(value)?.trim().toLowerCase() === "plan" ? "plan" : "auto";
}

function normalizeFusionBoolean(value) {
  return value === true;
}

function fusionClaudeTools() {
  return [...FUSION_CODEX_BRIDGE_TOOLS, ...FUSION_CLAUDE_BUILTIN_TOOLS].join(",");
}

function fusionClaudeAllowedTools() {
  return [...FUSION_CODEX_BRIDGE_TOOLS, ...FUSION_CLAUDE_BUILTIN_TOOLS].join(",");
}

function fusionClaudeDisallowedTools() {
  return ["Bash", ...FUSION_CLAUDE_EDIT_DENY_TOOLS].join(",");
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

  function scheduleFusionBuildFixtureEvents() {
    if (process.env.VIBE_SCREENSHOT_SEED_FUSION_BUILDS !== "1") {
      return;
    }
    setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      const id = "screenshot-fusion-builds";
      const now = Date.now();
      const events = [
        {
          id,
          type: "build-task",
          phase: "started",
          buildId: "build-running",
          command: "npm run build -- --watch",
          startedAt: now - 46_000
        },
        {
          id,
          type: "build-task",
          phase: "started",
          buildId: "build-success",
          command: "npm run compile",
          startedAt: now - 96_000
        },
        {
          id,
          type: "build-task",
          phase: "settled",
          buildId: "build-success",
          command: "npm run compile",
          status: "exited",
          exitCode: 0
        },
        {
          id,
          type: "build-task",
          phase: "started",
          buildId: "build-failed",
          command: "npm run test:ci",
          startedAt: now - 74_000
        },
        {
          id,
          type: "build-task",
          phase: "settled",
          buildId: "build-failed",
          command: "npm run test:ci",
          status: "failed",
          exitCode: 2
        },
        {
          id,
          type: "build-task",
          phase: "started",
          buildId: "build-cancelled",
          command: "npm run storybook",
          startedAt: now - 33_000
        },
        {
          id,
          type: "build-task",
          phase: "settled",
          buildId: "build-cancelled",
          command: "npm run storybook",
          status: "cancelled",
          exitCode: null
        }
      ];
      for (const event of events) {
        mainWindow.webContents.send("fusion-chat:event", event);
      }
    }, 1500);
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
    scheduleFusionBuildFixtureEvents();
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
  getBuildSupervisor();
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

  if (buildSupervisor) {
    buildSupervisor.cleanup();
    buildSupervisor = null;
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

  if (openFusionChatHost && !openFusionChatHost.killed) {
    sendToOpenFusionChatHost({ type: "shutdown" });
    openFusionChatHost.kill();
  }

  if (process.platform !== "darwin") {
    app.quit();
  }
});

ipcMain.handle("app:get-cwd", () => getDefaultRuntimeCwd());

ipcMain.handle("app:get-screenshot-fixture", () => {
  if (!isScreenshotMode) {
    return null;
  }

  if (process.env.VIBE_SCREENSHOT_SEED_OPEN_FUSION === "1") {
    return {
      mode: "openfusion",
      cwd: getDefaultRuntimeCwd()
    };
  }

  if (process.env.VIBE_SCREENSHOT_SEED_FUSION_PICKER === "1") {
    return {
      mode: "fusion-picker",
      cwd: getDefaultRuntimeCwd(),
      role: process.env.VIBE_SCREENSHOT_FUSION_PICKER_ROLE === "executor" ? "executor" : "planner",
      family: process.env.VIBE_SCREENSHOT_FUSION_PICKER_FAMILY === "codex" ? "codex" : "claude"
    };
  }

  if (process.env.VIBE_SCREENSHOT_SEED_FUSION_BUILDS === "1") {
    return {
      mode: "fusion-builds",
      cwd: getDefaultRuntimeCwd()
    };
  }

  return null;
});

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

ipcMain.handle("workspace:open-in-explorer", async (_event, payload) => {
  const folderPath = typeof payload?.path === "string" ? payload.path.trim() : "";
  if (!folderPath) {
    return { ok: false, error: "missing path" };
  }
  if (!fs.existsSync(folderPath)) {
    return { ok: false, error: "Folder no longer exists." };
  }

  try {
    const error = await shell.openPath(folderPath);
    if (error) {
      return { ok: false, error };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle("workspace:open-terminal", async (_event, payload) => {
  const folderPath = typeof payload?.path === "string" ? payload.path.trim() : "";
  if (!folderPath) {
    return { ok: false, error: "missing path" };
  }
  if (!fs.existsSync(folderPath)) {
    return { ok: false, error: "Folder no longer exists." };
  }

  try {
    if (process.platform === "win32") {
      const launchPowerShell = () => {
        const child = spawn(process.env.ComSpec || "cmd.exe", [
          "/c",
          "start",
          "",
          "powershell.exe",
          "-NoExit",
          "-Command",
          `Set-Location -LiteralPath '${folderPath.replace(/'/g, "''")}'`
        ], {
          detached: true,
          stdio: "ignore",
          windowsHide: false
        });
        child.on("error", () => {});
        child.unref();
      };

      try {
        const child = spawn("wt.exe", ["-d", folderPath], {
          detached: true,
          stdio: "ignore",
          windowsHide: false
        });
        child.on("error", () => {
          try {
            launchPowerShell();
          } catch {
            // The IPC already returned; nothing useful can be surfaced here.
          }
        });
        child.unref();
      } catch {
        launchPowerShell();
      }
      return { ok: true };
    }

    if (process.platform === "darwin") {
      const child = spawn("open", ["-a", "Terminal", folderPath], {
        detached: true,
        stdio: "ignore"
      });
      child.on("error", () => {});
      child.unref();
      return { ok: true };
    }

    const launchGnomeTerminal = () => {
      const child = spawn("gnome-terminal", [`--working-directory=${folderPath}`], {
        detached: true,
        stdio: "ignore"
      });
      child.on("error", () => {});
      child.unref();
    };

    try {
      const child = spawn("x-terminal-emulator", [], {
        cwd: folderPath,
        detached: true,
        stdio: "ignore"
      });
      child.on("error", () => {
        try {
          launchGnomeTerminal();
        } catch {
          // The IPC already returned; nothing useful can be surfaced here.
        }
      });
      child.unref();
    } catch {
      launchGnomeTerminal();
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle("files:describe-paths", (_event, payload) =>
  describeFilePaths(payload)
);

ipcMain.handle("agent-thread:latest", (_event, payload) => {
  // Open Fusion threads live in the app-owned OpenCode home, not the user's
  // global store: point the discovery host's `opencode session list` spawns at
  // it. Plain opencode terminal panes (no openFusion flag) keep the global one.
  if (payload?.provider === "opencode" && payload.openFusion) {
    try {
      const home = getAgentTelemetry().getOpenFusionOpencodeHome();
      payload = {
        ...payload,
        opencodeEnv: {
          XDG_DATA_HOME: home.dataDir,
          XDG_CONFIG_HOME: home.configDir
        }
      };
    } catch {
      // Home unavailable — fall through to a global lookup rather than block
      // the pane; the serve-side confirm remains the final authority.
    }
  }
  return findLatestAgentThread(payload);
});

ipcMain.handle("agent-thread:list", (_event, payload) => {
  // Saved-chat history for the Fusion resume picker: claude/codex chats live
  // in the user's own global stores (exactly where `--resume` reads from), so
  // the lookup passes straight through.
  if (payload?.provider === "claude" || payload?.provider === "codex") {
    return findLatestAgentThread({ ...payload, list: true });
  }

  // Saved-chat history for the Open Fusion resume picker. Unlike the latest
  // lookup this must FAIL CLOSED: listing may only ever run against the
  // app-owned OpenCode store — falling through to the user's global store
  // would surface their personal CLI threads in the picker.
  if (payload?.provider !== "opencode" || !payload.openFusion) {
    return {
      status: "failed",
      message: "Saved-chat listing is only available for chat panes."
    };
  }
  try {
    const telemetry = getAgentTelemetry();
    const home = telemetry.getOpenFusionOpencodeHome();
    // The migration cutoff hides personal CLI threads that rode along in the
    // seeded db snapshot; app-created threads all post-date it.
    const cutoff = telemetry.getOpenFusionThreadCutoffMs();
    return findLatestAgentThread({
      ...payload,
      list: true,
      after: Math.max(Number(payload.after) || 0, cutoff),
      opencodeEnv: {
        XDG_DATA_HOME: home.dataDir,
        XDG_CONFIG_HOME: home.configDir
      }
    });
  } catch {
    return {
      status: "failed",
      message: "The Open Fusion chat store is unavailable."
    };
  }
});

ipcMain.handle("terminal:create", async (_event, payload) => {
  const launchCwd = resolveLaunchCwd(payload?.cwd, getDefaultRuntimeCwd());
  if (!launchCwd.ok) {
    if (payload?.id) {
      broadcastTerminalEvent({
        id: payload.id,
        type: "error",
        message: launchCwd.message
      });
    }
    return false;
  }

  startPtyHost();
  const telemetry = getAgentTelemetry();
  // Fusion panes do NOT use the PTY path — they run headless via fusion-chat:start.
  let instrumentation = await telemetry.prepareSession(payload?.id);

  if (payload?.openFusion) {
    const openFusionFiles = await telemetry.prepareOpenFusionFiles(payload.id, {
      plannerModel: normalizeOpenFusionModel(
        payload.openFusionPlannerModel,
        OPEN_FUSION_MODEL_UNSET
      ),
      executorModel: normalizeOpenFusionModel(
        payload.openFusionExecutorModel,
        OPEN_FUSION_MODEL_UNSET
      ),
      cwd: launchCwd.cwd
    });

    if (!openFusionFiles) {
      if (payload?.id) {
        broadcastTerminalEvent({
          id: payload.id,
          type: "error",
          message: "Could not prepare Open Fusion app-scoped OpenCode config."
        });
      }
      return false;
    }

    instrumentation = {
      ...instrumentation,
      env: {
        ...(instrumentation?.env || {}),
        ...openFusionFiles.env
      }
    };
  }

  // Cursor's stop hook lives in the project's .cursor/hooks.json, so install it
  // (idempotently) whenever a cursor-agent pane launches and the cwd is known.
  if (
    launchCwd.cwd &&
    typeof payload.command === "string" &&
    /\bcursor-agent\b/.test(payload.command)
  ) {
    telemetry.ensureCursorProjectHooks(launchCwd.cwd).catch(() => {});
  }

  return sendToPtyHost({
    type: "create",
    payload: {
      ...payload,
      cwd: launchCwd.cwd,
      instrumentation
    }
  });
});

ipcMain.handle("fusion-chat:start", async (_event, payload) => {
  const id = payload?.id;
  if (!id) {
    return { ok: false, error: "missing session id" };
  }
  const launchCwd = resolveLaunchCwd(payload.cwd, getDefaultRuntimeCwd());
  if (!launchCwd.ok) {
    return { ok: false, error: launchCwd.message };
  }
  try {
    const plannerFamily = normalizeFusionFamily(payload.plannerFamily, "claude");
    const executorFamily = normalizeFusionFamily(payload.executorFamily, "codex");
    // The embedded codex binary is only REQUIRED when a role actually runs
    // the Codex family; an all-Claude pane must not fail closed on it.
    let codexBin;
    try {
      codexBin = resolveCodexBin();
    } catch (error) {
      if (plannerFamily === "codex" || executorFamily === "codex") {
        throw error;
      }
      codexBin = "codex";
    }
    startFusionChatHost();
    const fusionModel =
      plannerFamily === "codex"
        ? normalizeFusionCodexModel(payload.model)
        : normalizeFusionModel(payload.model);
    const plannerEffort =
      plannerFamily === "codex"
        ? normalizeFusionCodexEffort(payload.effort)
        : normalizeFusionEffort(payload.effort);
    const rawExecutorModel =
      typeof payload.executorModel === "string" && payload.executorModel.trim()
        ? payload.executorModel.trim()
        : typeof payload.codexModel === "string"
          ? payload.codexModel.trim()
          : "";
    const fusionExecutorModel =
      executorFamily === "claude"
        ? normalizeFusionClaudeExecutorModel(rawExecutorModel)
        : normalizeFusionCodexModel(
            rawExecutorModel &&
              rawExecutorModel.toLowerCase() !== "auto" &&
              rawExecutorModel.toLowerCase() !== "default"
              ? rawExecutorModel
              : process.env.VIBE_FUSION_CODEX_MODEL
          );
    // No `?? payload.effort` fallback: the pane omits executor effort when
    // it's "auto", and the legacy shared-enum fallback silently applied the
    // PLANNER effort to every delegation while the UI said "Execution Auto".
    const rawExecutorEffort = payload.executorEffort ?? payload.codexEffort;
    const fusionExecutorEffort =
      executorFamily === "claude"
        ? normalizeFusionClaudeRoleEffort(rawExecutorEffort)
        : normalizeFusionCodexEffort(rawExecutorEffort);
    const fusionRunMode = normalizeFusionRunMode(payload.mode);
    const plannerFast = normalizeFusionBoolean(payload.plannerFast);
    const executorFast = normalizeFusionBoolean(payload.executorFast);
    const telemetry = getAgentTelemetry();
    const files = await telemetry.prepareFusionFiles(id, {
      cwd: launchCwd.cwd,
      codexBin,
      plannerFamily,
      plannerFast,
      executorFamily,
      executorModel: fusionExecutorModel,
      executorEffort: fusionExecutorEffort,
      executorFast,
      runMode: fusionRunMode,
      buildSupervisorDir: getBuildSupervisorDir()
    });
    if (!files) {
      return { ok: false, error: "could not prepare Fusion files" };
    }
    const sent = sendToFusionChatHost({
      type: "start",
      payload: {
        id,
        cwd: launchCwd.cwd,
        plannerFamily,
        codexBin,
        mcpConfig: files.mcpConfig,
        systemPromptFile: files.systemPromptFile,
        settingsFile: files.settingsFile,
        model: fusionModel,
        mode: fusionRunMode,
        effort: plannerEffort,
        plannerFast,
        // The planner is read-only (Read/Glob/Grep + the executor bridge);
        // the executor writes all code and owns execution and final bug/goal
        // verification. The codex planner path enforces the same lock with
        // its read-only sandbox.
        tools: fusionClaudeTools(),
        allowedTools: fusionClaudeAllowedTools(),
        disallowedTools: fusionClaudeDisallowedTools(),
        strictMcpConfig: true,
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

ipcMain.handle("fusion-model-catalog:list", async (_event, payload) => {
  const family = normalizeFusionCatalogFamily(payload?.family);
  try {
    return await listFusionModelCatalog(family);
  } catch (error) {
    return {
      ok: false,
      family,
      models: null,
      error: error.message || "could not list Fusion model catalog"
    };
  }
});

ipcMain.handle("fusion-chat:update-settings", async (_event, payload) => {
  if (!payload?.id) {
    return { ok: false, error: "missing session id" };
  }
  const executorFamily = normalizeFusionFamily(payload.executorFamily, "codex");
  const rawExecutorModel =
    typeof payload.executorModel === "string" && payload.executorModel.trim()
      ? payload.executorModel.trim()
      : typeof payload.codexModel === "string"
        ? payload.codexModel.trim()
        : "";
  const fusionExecutorModel =
    executorFamily === "claude"
      ? normalizeFusionClaudeExecutorModel(rawExecutorModel)
      : normalizeFusionCodexModel(
          rawExecutorModel &&
            rawExecutorModel.toLowerCase() !== "auto" &&
            rawExecutorModel.toLowerCase() !== "default"
            ? rawExecutorModel
            : process.env.VIBE_FUSION_CODEX_MODEL
        );
  const rawExecutorEffort = payload.executorEffort ?? payload.codexEffort;
  const fusionExecutorEffort =
    executorFamily === "claude"
      ? normalizeFusionClaudeRoleEffort(rawExecutorEffort)
      : normalizeFusionCodexEffort(rawExecutorEffort);
  const plannerFamily = normalizeFusionFamily(payload.plannerFamily, "claude");
  const plannerFast = normalizeFusionBoolean(payload.plannerFast);
  const executorFast = normalizeFusionBoolean(payload.executorFast);
  const result = await getAgentTelemetry().updateFusionSettings(payload.id, {
    plannerFamily,
    plannerFast,
    executorFamily,
    executorModel: fusionExecutorModel,
    executorEffort: fusionExecutorEffort,
    executorFast
  });
  if (result.status === "failed") {
    return { ok: false, error: result.error || "could not update Fusion settings" };
  }
  sendToFusionChatHost({
    type: "settings",
    payload: {
      id: payload.id,
      plannerFamily,
      plannerFast,
      executorFamily,
      executorFast
    }
  });
  return { ok: true };
});
ipcMain.handle("fusion-chat:set-mode", async (_event, payload) => {
  if (!payload?.id) {
    return { ok: false, error: "missing session id" };
  }
  const mode = normalizeFusionRunMode(payload.mode);
  const adapterResult = await getAgentTelemetry().setFusionSessionMode(payload.id, mode);
  if (adapterResult.status === "failed") {
    return { ok: false, mode, error: adapterResult.error || "could not set Fusion mode" };
  }
  const sent = sendToFusionChatHost({ type: "mode", payload: { id: payload.id, mode } });
  if (!sent) {
    return { ok: false, mode, error: "Fusion chat host is not running." };
  }
  return { ok: true, mode };
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

ipcMain.handle("fusion-chat:background-cancel", async (_event, payload) => {
  if (!payload?.id || !payload.taskId) {
    return { status: "failed", error: "id and taskId are required" };
  }
  return getAgentTelemetry()
    .cancelFusionBackgroundTask(payload.id, String(payload.taskId))
    .catch((error) => ({ status: "failed", error: error?.message || "cancel failed" }));
});

ipcMain.handle("fusion-chat:build-cancel", (_event, payload) => {
  if (!payload?.id || !payload.buildId) {
    return { status: "failed", error: "id and buildId are required" };
  }
  const entry = getBuildSupervisor().cancel(String(payload.buildId));
  if (!entry) {
    return { status: "not_found", buildId: String(payload.buildId) };
  }
  return { status: "cancelled", buildId: entry.buildId };
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
    (async () => {
      const steerResult = await getAgentTelemetry()
        .steerFusionSession(payload.id, payload.text)
        .catch(() => ({ status: "failed" }));
      const sent = sendToFusionChatHost({
        type: "input",
        payload: {
          id: payload.id,
          text: payload.text,
          steer: true,
          routed: steerResult?.status === "routing"
        }
      });
      if (!sent) {
        broadcastFusionChatEvent({
          id: payload.id,
          type: "error",
          message: "Fusion chat host is not running. Restart Fusion to continue."
        });
      }
    })();
  }
});

ipcMain.handle("openfusion-chat:start", async (_event, payload) => {
  const id = payload?.id;
  if (!id) {
    return { ok: false, error: "missing session id" };
  }
  const launchCwd = resolveLaunchCwd(payload.cwd, getDefaultRuntimeCwd());
  if (!launchCwd.ok) {
    return { ok: false, error: launchCwd.message };
  }
  try {
    startOpenFusionChatHost();
    const telemetry = getAgentTelemetry();
    const files = await telemetry.prepareOpenFusionFiles(id, {
      plannerModel: normalizeOpenFusionModel(
        payload.plannerModel,
        OPEN_FUSION_MODEL_UNSET
      ),
      executorModel: normalizeOpenFusionModel(
        payload.executorModel,
        OPEN_FUSION_MODEL_UNSET
      ),
      cwd: launchCwd.cwd
    });
    if (!files) {
      return { ok: false, error: "could not prepare Open Fusion config" };
    }
    const sent = sendToOpenFusionChatHost({
      type: "start",
      payload: {
        id,
        cwd: launchCwd.cwd,
        env: files.env,
        plannerModel: files.env.VIBE_TERMINAL_OPEN_FUSION_PLANNER_MODEL,
        executorModel: files.env.VIBE_TERMINAL_OPEN_FUSION_EXECUTOR_MODEL,
        resumeId: payload.resumeId || undefined,
        // Capability flag: this start's generated config includes the plan
        // agent. Guards plan-mode turns against a stale serve without it.
        planAgent: true,
        // Same idea for background delegations: the generated config carries
        // the vibeterminal MCP bridge + the executor-bg agent.
        backgroundAgent: true
      }
    });
    if (!sent) {
      return { ok: false, error: "Open Fusion chat host is not running." };
    }
    return {
      ok: true,
      plannerModel: files.env.VIBE_TERMINAL_OPEN_FUSION_PLANNER_MODEL,
      executorModel: files.env.VIBE_TERMINAL_OPEN_FUSION_EXECUTOR_MODEL
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle("openfusion-chat:save-models", async (_event, payload) => {
  if (!payload?.id) {
    return { ok: false, error: "missing session id" };
  }
  const plannerModel = normalizeFusionString(payload.plannerModel);
  const executorModel = normalizeFusionString(payload.executorModel);
  const result = await getAgentTelemetry().updateOpenFusionModels(payload.id, {
    plannerModel,
    executorModel
  });
  if (result.status === "failed") {
    return { ok: false, error: result.error || "could not save Open Fusion models" };
  }
  // Brain switches apply live (per-prompt model override); Executor changes are
  // baked into the generated config, so they need a pane restart.
  if (plannerModel) {
    sendToOpenFusionChatHost({
      type: "planner-model",
      payload: { id: payload.id, model: plannerModel }
    });
  }
  return { ok: true, models: result.models };
});

ipcMain.handle("openfusion-chat:providers", (_event, payload) => {
  if (!payload?.id) {
    return { ok: false, error: "missing session id" };
  }
  const sent = sendToOpenFusionChatHost({ type: "providers", payload: { id: payload.id } });
  return sent
    ? { ok: true }
    : { ok: false, error: "Open Fusion chat host is not running." };
});

ipcMain.handle("openfusion-chat:auth-set", (_event, payload) => {
  const providerId =
    typeof payload?.providerId === "string" ? payload.providerId.trim() : "";
  const key = typeof payload?.key === "string" ? payload.key.trim() : "";
  if (!payload?.id || !providerId || !key) {
    return { ok: false, error: "missing provider id or key" };
  }
  // The key is relayed to the host verbatim and must never be logged or echoed.
  const sent = sendToOpenFusionChatHost({
    type: "auth-set",
    payload: {
      id: payload.id,
      providerId,
      key,
      metadata:
        payload.metadata && typeof payload.metadata === "object"
          ? payload.metadata
          : undefined,
      nonce: typeof payload.nonce === "string" ? payload.nonce : undefined
    }
  });
  return sent
    ? { ok: true }
    : { ok: false, error: "Open Fusion chat host is not running." };
});

ipcMain.handle("openfusion-chat:oauth-authorize", (_event, payload) => {
  const providerId =
    typeof payload?.providerId === "string" ? payload.providerId.trim() : "";
  if (!payload?.id || !providerId || !Number.isInteger(payload.method)) {
    return { ok: false, error: "missing provider id or auth method" };
  }
  const sent = sendToOpenFusionChatHost({
    type: "oauth-authorize",
    payload: {
      id: payload.id,
      providerId,
      method: payload.method,
      inputs:
        payload.inputs && typeof payload.inputs === "object"
          ? payload.inputs
          : undefined,
      nonce: typeof payload.nonce === "string" ? payload.nonce : undefined
    }
  });
  return sent
    ? { ok: true }
    : { ok: false, error: "Open Fusion chat host is not running." };
});

ipcMain.handle("openfusion-chat:oauth-callback", (_event, payload) => {
  const providerId =
    typeof payload?.providerId === "string" ? payload.providerId.trim() : "";
  if (!payload?.id || !providerId || !Number.isInteger(payload.method)) {
    return { ok: false, error: "missing provider id or auth method" };
  }
  const sent = sendToOpenFusionChatHost({
    type: "oauth-callback",
    payload: {
      id: payload.id,
      providerId,
      method: payload.method,
      code: typeof payload.code === "string" ? payload.code : undefined,
      nonce: typeof payload.nonce === "string" ? payload.nonce : undefined
    }
  });
  return sent
    ? { ok: true }
    : { ok: false, error: "Open Fusion chat host is not running." };
});

// Open an OAuth authorization URL in the user's default browser. Restricted to
// http(s) so a hostile URL can never launch arbitrary protocol handlers.
ipcMain.handle("app:open-external", (_event, payload) => {
  const raw = typeof payload?.url === "string" ? payload.url.trim() : "";
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: "invalid url" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, error: "only http(s) links can be opened" };
  }
  shell.openExternal(url.toString()).catch(() => {});
  return { ok: true };
});

ipcMain.handle("openfusion-chat:auth-remove", (_event, payload) => {
  const providerId =
    typeof payload?.providerId === "string" ? payload.providerId.trim() : "";
  if (!payload?.id || !providerId) {
    return { ok: false, error: "missing provider id" };
  }
  const sent = sendToOpenFusionChatHost({
    type: "auth-remove",
    payload: { id: payload.id, providerId }
  });
  return sent
    ? { ok: true }
    : { ok: false, error: "Open Fusion chat host is not running." };
});

// Custom OpenAI-compatible providers. The definition is validated here and in
// the host (buildCustomProviderPatch is the authority on shape); the host's
// PATCH /global/config both persists it in the app-owned OpenCode config and
// live-applies it. The optional key is relayed verbatim — never logged.
ipcMain.handle("openfusion-chat:custom-provider-set", (_event, payload) => {
  const providerId =
    typeof payload?.providerId === "string" ? payload.providerId.trim() : "";
  const name = typeof payload?.name === "string" ? payload.name.trim() : "";
  const baseURL = typeof payload?.baseURL === "string" ? payload.baseURL.trim() : "";
  const models = Array.isArray(payload?.models)
    ? payload.models
        .filter((entry) => entry && typeof entry === "object")
        .map((entry) => ({
          id: typeof entry.id === "string" ? entry.id.trim() : "",
          name: typeof entry.name === "string" ? entry.name.trim() : "",
          ...(Number.isInteger(entry.contextLimit) && entry.contextLimit > 0
            ? { contextLimit: entry.contextLimit }
            : {})
        }))
        .filter((entry) => entry.id)
    : [];
  if (!payload?.id || !providerId || !name || !baseURL || !models.length) {
    return { ok: false, error: "missing provider id, name, base URL, or models" };
  }
  const key = typeof payload?.key === "string" ? payload.key.trim() : "";
  const sent = sendToOpenFusionChatHost({
    type: "custom-provider-set",
    payload: {
      id: payload.id,
      providerId,
      name,
      baseURL,
      models,
      key: key || undefined,
      nonce: typeof payload.nonce === "string" ? payload.nonce : undefined
    }
  });
  return sent
    ? { ok: true }
    : { ok: false, error: "Open Fusion chat host is not running." };
});

ipcMain.handle("openfusion-chat:custom-provider-remove", (_event, payload) => {
  const providerId =
    typeof payload?.providerId === "string" ? payload.providerId.trim() : "";
  if (!payload?.id || !providerId) {
    return { ok: false, error: "missing provider id" };
  }
  // Drop the config entry first (a PATCH cannot delete a key, so this is a
  // direct file rewrite), then let the host clear the credential and nudge the
  // running servers to re-read the file.
  let removedFromConfig = false;
  try {
    removedFromConfig = Boolean(
      getAgentTelemetry().removeOpenFusionCustomProvider(providerId).removed
    );
  } catch {
    // An unreadable config file means there is nothing to remove from it.
  }
  const sent = sendToOpenFusionChatHost({
    type: "custom-provider-remove",
    payload: { id: payload.id, providerId, removedFromConfig }
  });
  return sent
    ? { ok: true }
    : { ok: false, error: "Open Fusion chat host is not running." };
});

ipcMain.handle("openfusion-chat:permission", (_event, payload) => {
  if (!payload?.id || !payload?.requestId) {
    return { ok: false, error: "missing permission request id" };
  }
  const sent = sendToOpenFusionChatHost({
    type: "permission",
    payload: { id: payload.id, requestId: payload.requestId, reply: payload.reply }
  });
  return sent
    ? { ok: true }
    : { ok: false, error: "Open Fusion chat host is not running." };
});

ipcMain.handle("openfusion-chat:compact", (_event, payload) => {
  if (!payload?.id) {
    return { ok: false, error: "missing session id" };
  }
  const sent = sendToOpenFusionChatHost({
    type: "compact",
    payload: { id: payload.id }
  });
  return sent
    ? { ok: true }
    : { ok: false, error: "Open Fusion chat host is not running." };
});

ipcMain.handle("openfusion-chat:question", (_event, payload) => {
  if (!payload?.id || !payload?.requestId) {
    return { ok: false, error: "missing question request id" };
  }
  const sent = sendToOpenFusionChatHost({
    type: "question",
    payload: {
      id: payload.id,
      requestId: payload.requestId,
      reject: payload.reject === true,
      answers: Array.isArray(payload.answers) ? payload.answers : []
    }
  });
  return sent
    ? { ok: true }
    : { ok: false, error: "Open Fusion chat host is not running." };
});

ipcMain.handle("openfusion-chat:interrupt", (_event, payload) => {
  if (payload?.id) {
    sendToOpenFusionChatHost({ type: "interrupt", payload: { id: payload.id } });
  }
  return true;
});

ipcMain.handle("openfusion-chat:background-cancel", (_event, payload) => {
  if (!payload?.id || !payload.taskId) {
    return { ok: false, error: "id and taskId are required" };
  }
  const sent = sendToOpenFusionChatHost({
    type: "background-cancel",
    payload: { id: payload.id, taskId: String(payload.taskId) }
  });
  return sent ? { ok: true } : { ok: false, error: "Open Fusion chat host is not running." };
});

ipcMain.handle("openfusion-chat:stop", (_event, payload) => {
  if (payload?.id) {
    sendToOpenFusionChatHost({ type: "stop", payload: { id: payload.id } });
    getAgentTelemetry().releaseSession(payload.id);
  }
  return true;
});

ipcMain.on("openfusion-chat:input", (_event, payload) => {
  if (payload?.id && typeof payload.text === "string") {
    const sent = sendToOpenFusionChatHost({
      type: "input",
      payload: {
        id: payload.id,
        text: payload.text,
        mode: typeof payload.mode === "string" ? payload.mode : undefined
      }
    });
    if (!sent) {
      broadcastOpenFusionChatEvent({
        id: payload.id,
        type: "error",
        message: "Open Fusion chat host is not running. Restart the pane to continue."
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
