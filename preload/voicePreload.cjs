"use strict";
const { contextBridge, ipcRenderer } = require("electron");
const subscribe = (channel, callback) => { const listener = (_event, payload) => callback(payload); ipcRenderer.on(channel, listener); return () => ipcRenderer.removeListener(channel, listener); };
// The overlay can read relay state and capture/play audio. It has no filesystem,
// raw terminal, credential-management, or arbitrary IPC capability.
contextBridge.exposeInMainWorld("vibe", {
  orchestrator: {
    getState: () => ipcRenderer.invoke("orchestrator:get-state"),
    onState: callback => subscribe("orchestrator:state", callback),
    send: payload => ipcRenderer.invoke("orchestrator:send", payload),
    cancel: () => ipcRenderer.invoke("orchestrator:cancel"),
    dispatch: payload => ipcRenderer.invoke("orchestrator:dispatch", payload),
    openMain: () => ipcRenderer.invoke("orchestrator:open-main"),
    setEnabled: enabled => ipcRenderer.invoke("orchestrator:enabled", { enabled })
  },
  voice: {
    getState: () => ipcRenderer.invoke("voice:get-state"),
    onState: callback => subscribe("voice:state", callback),
    configure: payload => ipcRenderer.invoke("voice:configure", payload),
    setListening: enabled => ipcRenderer.invoke("voice:listening", { enabled }),
    sendAudio: payload => ipcRenderer.invoke("voice:send-audio", payload),
    cancelSpeech: () => ipcRenderer.invoke("voice:cancel-speech"),
    frames: payload => ipcRenderer.send("voice:frames", payload),
    onAudio: callback => subscribe("voice:audio", callback)
  }
});
