import type { Terminal } from "@xterm/xterm";

// Agent redraws can issue ED 3 (erase saved lines) while work is still running.
// History belongs to the pane: retain it until FIFO eviction or a real reset.
// ED 0/1/2 still clear the live screen normally; alternate screens stay native.
export function preserveTerminalScrollback(terminal: Terminal) {
  return terminal.parser.registerCsiHandler(
    { final: "J" },
    params => params.length === 1 && params[0] === 3
  );
}

export function createTerminalReplay(terminal: Terminal, onRestored: () => void) {
  let pending = 0, disposed = false;
  return {
    get pending() { return pending > 0; },
    restore(snapshot: { data: string; cols?: number; rows?: number }) {
      pending++;
      // Restore cells at their original geometry before the pane fits again.
      if (snapshot.cols && snapshot.rows) terminal.resize(snapshot.cols, snapshot.rows);
      // An API reset runs immediately, ahead of already queued output. Put RIS
      // in the write stream so older output cannot reappear after the reset.
      terminal.write('\x1bc' + snapshot.data, () => {
        pending--;
        if (!disposed && pending === 0) onRestored();
      });
    },
    dispose() { disposed = true; }
  };
}
