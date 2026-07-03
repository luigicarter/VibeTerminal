const { clipboard, contextBridge, ipcRenderer, webUtils } = require("electron");

function parseWindowsClipboardFilePaths() {
  if (process.platform !== "win32") {
    return [];
  }
  try {
    if (!clipboard.availableFormats().includes("FileNameW")) {
      return [];
    }
    const buffer = clipboard.readBuffer("FileNameW");
    if (!buffer || buffer.length === 0) {
      return [];
    }
    return buffer
      .toString("utf16le")
      .replace(/\0+$/, "")
      .split("\0")
      .map((value) => value.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function getPathForDroppedFile(file) {
  try {
    return webUtils?.getPathForFile?.(file) || file?.path || "";
  } catch {
    return file?.path || "";
  }
}

const screenshotFixture =
  process.env.VIBE_SCREENSHOT_SEED_OPEN_FUSION === "1"
    ? {
        mode: "openfusion",
        cwd: process.env.VIBE_SCREENSHOT_FIXTURE_CWD || process.cwd(),
        openCodeCommand: process.env.VIBE_SCREENSHOT_OPENCODE_COMMAND || ""
      }
    : null;

contextBridge.exposeInMainWorld("vibe", {
  // The launch command is typed into the platform shell (PowerShell on Windows,
  // the login shell on POSIX), so the renderer needs the platform to quote args
  // for the right shell.
  platform: process.platform,
  app: {
    getCwd: () => ipcRenderer.invoke("app:get-cwd"),
    screenshotFixture,
    getScreenshotFixture: () =>
      screenshotFixture
        ? Promise.resolve(screenshotFixture)
        : ipcRenderer.invoke("app:get-screenshot-fixture")
  },
  clipboard: {
    readText: () => clipboard.readText(),
    writeText: (text) => clipboard.writeText(String(text ?? "")),
    readFilePaths: () => parseWindowsClipboardFilePaths()
  },
  updates: {
    getState: () => ipcRenderer.invoke("updates:get-state"),
    check: () => ipcRenderer.invoke("updates:check"),
    download: () => ipcRenderer.invoke("updates:download"),
    restart: () => ipcRenderer.invoke("updates:restart"),
    onEvent: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on("updates:event", listener);
      return () => ipcRenderer.removeListener("updates:event", listener);
    }
  },
  workspace: {
    selectFolder: () => ipcRenderer.invoke("workspace:select-folder"),
    getCodeChanges: (cwd) =>
      ipcRenderer.invoke("workspace:code-changes", { cwd })
  },
  files: {
    getPathForFile: (file) => getPathForDroppedFile(file),
    describePaths: (payload) => ipcRenderer.invoke("files:describe-paths", payload)
  },
  agentThreads: {
    findLatest: (payload) => ipcRenderer.invoke("agent-thread:latest", payload)
  },
  terminal: {
    create: (payload) => ipcRenderer.invoke("terminal:create", payload),
    input: (id, data) => ipcRenderer.send("terminal:input", { id, data }),
    resize: (id, cols, rows) =>
      ipcRenderer.send("terminal:resize", { id, cols, rows }),
    kill: (id) => ipcRenderer.invoke("terminal:kill", { id }),
    showContextMenu: (payload) =>
      ipcRenderer.invoke("terminal:show-context-menu", payload),
    onContextMenuPaste: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on("terminal:context-menu-paste", listener);
      return () =>
        ipcRenderer.removeListener("terminal:context-menu-paste", listener);
    },
    onEvent: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on("terminal:event", listener);
      return () => ipcRenderer.removeListener("terminal:event", listener);
    }
  },
  // Headless Claude chat for Fusion panes (no PTY). `start` spawns a per-pane
  // headless `claude`; `sendUserTurn` writes a user message to its stdin;
  // `onEvent` streams normalized chat events; `stop` ends it.
  fusionChat: {
    start: (payload) => ipcRenderer.invoke("fusion-chat:start", payload),
    updateSettings: (id, settings) =>
      ipcRenderer.invoke("fusion-chat:update-settings", { id, ...settings }),
    sendUserTurn: (id, text) => ipcRenderer.send("fusion-chat:input", { id, text }),
    setMode: (id, mode) => ipcRenderer.invoke("fusion-chat:set-mode", { id, mode }),
    steer: (id, text) => ipcRenderer.send("fusion-chat:steer", { id, text }),
    interrupt: (id) => ipcRenderer.invoke("fusion-chat:interrupt", { id }),
    stop: (id) => ipcRenderer.invoke("fusion-chat:stop", { id }),
    onEvent: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on("fusion-chat:event", listener);
      return () => ipcRenderer.removeListener("fusion-chat:event", listener);
    }
  },
  // Headless OpenCode chat for Open Fusion panes (no PTY, no TUI). `start`
  // spawns a per-pane `opencode serve`; `sendUserTurn` posts a planner prompt;
  // `onEvent` streams normalized chat events shared with the Fusion pane shape.
  openFusionChat: {
    start: (payload) => ipcRenderer.invoke("openfusion-chat:start", payload),
    saveModels: (id, models) =>
      ipcRenderer.invoke("openfusion-chat:save-models", { id, ...models }),
    requestProviders: (id) => ipcRenderer.invoke("openfusion-chat:providers", { id }),
    setProviderKey: (id, providerId, key, metadata, nonce) =>
      ipcRenderer.invoke("openfusion-chat:auth-set", {
        id,
        providerId,
        key,
        metadata,
        nonce
      }),
    removeProviderKey: (id, providerId) =>
      ipcRenderer.invoke("openfusion-chat:auth-remove", { id, providerId }),
    customProviderSet: (id, provider, nonce) =>
      ipcRenderer.invoke("openfusion-chat:custom-provider-set", {
        id,
        providerId: provider?.providerId,
        name: provider?.name,
        baseURL: provider?.baseURL,
        models: provider?.models,
        key: provider?.key,
        nonce
      }),
    customProviderRemove: (id, providerId) =>
      ipcRenderer.invoke("openfusion-chat:custom-provider-remove", { id, providerId }),
    oauthAuthorize: (id, providerId, method, inputs, nonce) =>
      ipcRenderer.invoke("openfusion-chat:oauth-authorize", {
        id,
        providerId,
        method,
        inputs,
        nonce
      }),
    oauthCallback: (id, providerId, method, code, nonce) =>
      ipcRenderer.invoke("openfusion-chat:oauth-callback", {
        id,
        providerId,
        method,
        code,
        nonce
      }),
    openExternal: (url) => ipcRenderer.invoke("app:open-external", { url }),
    sendUserTurn: (id, text) => ipcRenderer.send("openfusion-chat:input", { id, text }),
    permission: (id, requestId, reply) =>
      ipcRenderer.invoke("openfusion-chat:permission", { id, requestId, reply }),
    interrupt: (id) => ipcRenderer.invoke("openfusion-chat:interrupt", { id }),
    stop: (id) => ipcRenderer.invoke("openfusion-chat:stop", { id }),
    onEvent: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on("openfusion-chat:event", listener);
      return () => ipcRenderer.removeListener("openfusion-chat:event", listener);
    }
  }
});
