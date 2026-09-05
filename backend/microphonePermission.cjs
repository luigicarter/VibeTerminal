const fs = require('node:fs');
const path = require('node:path');

function createMicrophonePermission({ userDataPath, getMainWindow, dialog, systemPreferences, shell, platform = process.platform }) {
  const consentPath = path.join(userDataPath, 'microphone-consent.json');
  let pending = null;
  const failure = (status, error) => ({ ok: false, status, error });
  const aborted = () => failure('cancelled', 'Microphone permission request cancelled.');
  const required = () => failure('permission-required', 'Allow microphone access from the vibeTerminal window first.');

  function isGranted() {
    try {
      const saved = JSON.parse(fs.readFileSync(consentPath, 'utf8'));
      return saved?.version === 1 && saved?.granted === true;
    } catch { return false; }
  }

  function foregroundWindow() {
    try {
      const window = getMainWindow();
      return window && !window.isDestroyed() && window.isVisible() && window.isFocused() && !window.isMinimized() ? window : null;
    } catch { return null; }
  }

  function osStatus() {
    if (platform !== 'win32' && platform !== 'darwin') return 'unknown';
    try { return systemPreferences.getMediaAccessStatus('microphone'); }
    catch { return 'unavailable'; }
  }

  async function openSettings({ signal } = {}) {
    if (signal?.aborted) return aborted();
    if (platform !== 'win32') return failure('unsupported', 'Open microphone privacy settings in your operating system.');
    try {
      await shell.openExternal('ms-settings:privacy-microphone');
      return signal?.aborted ? aborted() : { ok: true, status: 'settings-opened' };
    } catch { return failure('settings-error', 'Could not open Windows microphone settings.'); }
  }

  async function request({ interactive, signal }) {
    if (signal?.aborted) return aborted();
    const status = osStatus();
    if (status === 'unavailable') return failure('permission-unavailable', 'Could not check operating system microphone access.');
    if (status === 'denied' || status === 'restricted') {
      const window = interactive && foregroundWindow();
      if (window) {
        const windows = platform === 'win32';
        const result = await dialog.showMessageBox(window, {
          type: 'warning', title: 'vibeTerminal', message: 'Microphone access is blocked by your operating system.',
          detail: windows ? 'Enable microphone access and allow desktop apps to access your microphone in Windows settings, then try again.' : 'Enable microphone access for vibeTerminal in your system privacy settings, then try again.',
          buttons: windows ? ['Open Windows microphone settings', 'Cancel'] : ['OK'],
          defaultId: windows ? 1 : 0, cancelId: windows ? 1 : 0, signal,
        });
        if (signal?.aborted) return aborted();
        if (windows && result.response === 0) {
          const opened = await openSettings({ signal });
          if (!opened.ok) return opened;
        }
      }
      return failure('os-permission-denied', 'Microphone access is blocked by your operating system.');
    }
    if (isGranted()) return { ok: true, status: 'granted' };
    const window = interactive && foregroundWindow();
    if (!window) return required();
    const result = await dialog.showMessageBox(window, {
      type: 'question', title: 'vibeTerminal', message: 'Allow vibeTerminal to use your microphone?',
      detail: 'While voice is enabled, vibeTerminal listens locally for “Hey Vibe”, including in the background. After activation, recordings are sent to OpenRouter for transcription. vibeTerminal does not save recordings.\n\nThis gives vibeTerminal your consent; your operating system also controls microphone access.',
      buttons: ['Allow microphone', 'Not now'], defaultId: 1, cancelId: 1, signal,
    });
    if (signal?.aborted) return aborted();
    if (result.response !== 0) return required();
    const latestStatus = osStatus();
    if (latestStatus === 'denied' || latestStatus === 'restricted') return failure('os-permission-denied', 'Microphone access is blocked by your operating system.');
    if (latestStatus === 'unavailable') return failure('permission-unavailable', 'Could not check operating system microphone access.');
    // Synchronous persistence leaves no asynchronous abort gap before committing consent.
    try {
      fs.mkdirSync(userDataPath, { recursive: true });
      if (signal?.aborted) return aborted();
      fs.writeFileSync(consentPath, `${JSON.stringify({ version: 1, granted: true })}\n`, { mode: 0o600 });
    } catch { return failure('permission-save-failed', 'Could not save microphone consent. Please try again.'); }
    return { ok: true, status: 'granted' };
  }

  function ensure({ interactive = true, signal } = {}) {
    if (signal?.aborted) return Promise.resolve(aborted());
    // Background requests never join (or create) an interactive popup.
    if (!interactive || !foregroundWindow()) return request({ interactive: false, signal });
    if (!pending) {
      pending = request({ interactive: true, signal }).catch(() => failure('permission-error', 'Could not request microphone permission.')).finally(() => { pending = null; });
    }
    if (!signal) return pending;
    const shared = pending;
    return new Promise((resolve) => {
      const onAbort = () => { signal.removeEventListener('abort', onAbort); resolve(aborted()); };
      signal.addEventListener('abort', onAbort, { once: true });
      shared.then((result) => {
        signal.removeEventListener('abort', onAbort);
        resolve(signal.aborted ? aborted() : result);
      });
      if (signal.aborted) onAbort();
    });
  }

  return { isGranted, ensure, openSettings };
}

module.exports = { createMicrophonePermission };
