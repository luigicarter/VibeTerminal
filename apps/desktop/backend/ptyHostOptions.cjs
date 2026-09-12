'use strict';

// Which pseudo-console host node-pty spawns Windows panes through.
//
// node-pty's default (`useConptyDll: false`) runs panes on the *inbox* conhost.
// That host flushes a paint the moment it meets Codex's per-frame DECSCUSR
// repair — with the cursor shown at the repair anchor — and closes the
// synchronized-update (`?2026`) bracket there, so the parked cursor reaches
// xterm as its own frame and the pane cursor visibly jumps (see
// docs/codex-cursor-flicker-2026-09-11.md). It also leaks one headless
// conhost.exe per naturally exited pane for the life of the host process
// (node-pty issue #965).
//
// `useConptyDll: true` loads the OpenConsole.exe + conpty.dll pair that ships
// in node-pty's own prebuilds (already unpacked from the asar in packaged
// builds). That host keeps the whole repair inside one bracket, never shows
// the cursor at the anchor, and leaves no console host behind on exit.
//
// `LINA_CONPTY_HOST=system` restores the inbox host for diagnosis.
function windowsPtyHostOptions(env = process.env) {
  if (process.platform !== 'win32') return {};
  return { useConptyDll: (env && env.LINA_CONPTY_HOST) !== 'system' };
}

// Human-readable name of the console host a spawn option set selects, for logs.
function describePtyHost(options) {
  if (!options || !('useConptyDll' in options)) return 'native';
  return options.useConptyDll ? 'openconsole' : 'conhost';
}

// Spawn a PTY on the selected console host, falling back to the inbox conhost
// once if the bundled one cannot start. A Windows build where conpty.dll or
// OpenConsole.exe refuses to load must still open the pane, not fail the
// launch. Returns { terminal, host, fallbackError }; fallbackError is the
// bundled host's error when the fallback was taken, otherwise null.
function spawnPty(pty, file, args, options, hostOptions = windowsPtyHostOptions()) {
  try {
    return {
      terminal: pty.spawn(file, args, { ...options, ...hostOptions }),
      host: describePtyHost(hostOptions),
      fallbackError: null
    };
  } catch (error) {
    if (!hostOptions || hostOptions.useConptyDll !== true) throw error;
    let terminal;
    try {
      terminal = pty.spawn(file, args, { ...options, useConptyDll: false });
    } catch (fallback) {
      if (fallback && fallback.cause === undefined) fallback.cause = error;
      throw fallback;
    }
    return { terminal, host: 'conhost', fallbackError: error };
  }
}

module.exports = { windowsPtyHostOptions, describePtyHost, spawnPty };
