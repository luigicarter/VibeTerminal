const { clipboard, contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("vibe", {
  // The launch command is typed into the platform shell (PowerShell on Windows,
  // the login shell on POSIX), so the renderer needs the platform to quote args
  // for the right shell.
  platform: process.platform,
  app: {
    getCwd: () => ipcRenderer.invoke("app:get-cwd")
  },
  clipboard: {
    readText: () => clipboard.readText(),
    writeText: (text) => clipboard.writeText(String(text ?? ""))
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
    sendUserTurn: (id, text) => ipcRenderer.send("fusion-chat:input", { id, text }),
    steer: (id, text) => ipcRenderer.send("fusion-chat:steer", { id, text }),
    interrupt: (id) => ipcRenderer.invoke("fusion-chat:interrupt", { id }),
    stop: (id) => ipcRenderer.invoke("fusion-chat:stop", { id }),
    onEvent: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on("fusion-chat:event", listener);
      return () => ipcRenderer.removeListener("fusion-chat:event", listener);
    }
  }
});
