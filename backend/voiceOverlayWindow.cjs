'use strict';
const path = require('node:path');

// Audio runs in a permanently hidden renderer. The mic is drawn inside the main
// app; this surface must never appear above a game or another application.
function createVoiceOverlayWindow({ BrowserWindow, screen, canCapture = () => false, onClosed = () => {}, onFailure = () => {} }) {
  let window = null, ready = false, disposed = false;
  const waiting = new Set();
  function finish(error) {
    for (const entry of waiting) { clearTimeout(entry.timer); error ? entry.reject(error) : entry.resolve(); }
    waiting.clear();
  }
  function clamp() {
    if (!window || window.isDestroyed()) return;
    const bounds = window.getBounds(), area = screen.getDisplayMatching(bounds).workArea;
    const width = Math.min(112, area.width), height = Math.min(112, area.height);
    window.setBounds({ width, height, x: Math.max(area.x, Math.min(bounds.x, area.x + area.width - width)), y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - height)) });
  }
  function create() {
    if (disposed) throw new Error('Voice is closed.');
    if (window && !window.isDestroyed()) return window;
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const width = Math.min(112, area.width), height = Math.min(112, area.height);
    const current = window = new BrowserWindow({
      width, height, x: Math.round(area.x + area.width - width - Math.min(20, area.width - width)),
      y: Math.round(area.y + area.height - height - Math.min(20, area.height - height)),
      frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false,
      alwaysOnTop: false, focusable: false, skipTaskbar: true, show: false, resizable: false, maximizable: false,
      title: 'vibeTerminal voice audio', webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'voicePreload.cjs'),
        nodeIntegration: false, contextIsolation: true, sandbox: true,
        backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required', partition: 'voice-overlay',
      },
    });
    ready = false;
    current.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    current.webContents.on('will-navigate', event => event.preventDefault());
    current.webContents.session.setPermissionRequestHandler((contents, permission, callback, details = {}) => {
      callback(contents === window?.webContents && permission === 'media' && !details.mediaTypes?.includes('video') && canCapture());
    });
    current.on('close', event => { if (!disposed) { event.preventDefault(); hide(); } });
    current.on('closed', () => {
      if (window !== current) return;
      window = null; ready = false; finish(new Error('Voice audio window closed.')); onClosed();
    });
    current.webContents.on('render-process-gone', () => {
      ready = false; finish(new Error('Voice audio stopped. Turn Hey Vibe off and on to retry.'));
      current.destroy(); onFailure('Voice audio stopped. Turn Hey Vibe on to retry.');
    });
    const devUrl = process.env.VITE_DEV_SERVER_URL;
    const loaded = devUrl ? current.loadURL(`${devUrl}/?surface=voice`) : current.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { query: { surface: 'voice' } });
    Promise.resolve(loaded).catch(() => {
      if (window !== current) return;
      finish(new Error('Could not load the voice indicator.'));
      current.destroy(); onFailure('Could not load the voice indicator.');
    });
    return current;
  }
  function hide() { window?.hide(); return { ok: true }; }
  async function ensureReady() {
    create(); if (ready) return;
    await new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: null };
      entry.timer = setTimeout(() => { waiting.delete(entry); reject(new Error('Voice audio did not start. Turn Hey Vibe off and on to retry.')); }, 15000);
      waiting.add(entry);
    });
  }
  function markReady(sender) {
    if (disposed || sender !== window?.webContents) return { ok: false };
    ready = true; finish(); return { ok: true };
  }
  screen.on?.('display-removed', clamp); screen.on?.('display-metrics-changed', clamp);
  return {
    hide, ensureReady, markReady, getWindow: () => window,
    isSender: sender => Boolean(window && sender === window.webContents),
    send: (channel, payload) => { if (window && !window.isDestroyed() && ready) window.webContents.send(channel, payload); },
    dispose() {
      if (disposed) return; disposed = true;
      finish(new Error('Application closed.'));
      screen.removeListener?.('display-removed', clamp); screen.removeListener?.('display-metrics-changed', clamp);
      if (window && !window.isDestroyed()) window.destroy(); window = null;
    },
  };
}
module.exports = { createVoiceOverlayWindow };
