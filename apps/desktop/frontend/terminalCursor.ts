import type { Terminal } from "@xterm/xterm";

// Codex emits DECSCUSR 0 (default user shape) during ordinary redraws.
// xterm 5.5 treats it as a blinking block rather than restoring our defaults.
export function configureCodexCursor(terminal: Terminal) {
  const restoreDefault = () => {
    terminal.options.cursorStyle = "bar";
    terminal.options.cursorBlink = false;
  };
  restoreDefault();
  terminal.options.cursorInactiveStyle = "bar";

  return terminal.parser.registerCsiHandler(
    { intermediates: " ", final: "q" },
    (params) => {
      // Explicit styles still belong to the foreground application.
      if (params.length > 1 || (params[0] !== undefined && params[0] !== 0)) {
        return false;
      }
      restoreDefault();
      return true;
    }
  );
}
