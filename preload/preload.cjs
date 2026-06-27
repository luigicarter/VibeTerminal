const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("vibe", {
  app: {
    getCwd: () => ipcRenderer.invoke("app:get-cwd")
  },
  updates: {
    getState: () => ipcRenderer.invoke("updates:get-state"),
    download: () => ipcRenderer.invoke("updates:download"),
    restart: () => ipcRenderer.invoke("updates:restart"),
    onEvent: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on("updates:event", listener);
      return () => ipcRenderer.removeListener("updates:event", listener);
    }
  },
  workspace: {
    selectFolder: () => ipcRenderer.invoke("workspace:select-folder")
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
    onEvent: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on("terminal:event", listener);
      return () => ipcRenderer.removeListener("terminal:event", listener);
    }
  }
});
