'use strict';

/**
 * The bytes a terminal key actually is.
 *
 * A phone keyboard has no Esc, no Tab, no arrows and no Ctrl, so the key bar
 * sends the escape sequences itself. Every one of them goes to the desktop
 * through the single `sendKeys` function in `src/api/client.ts`; this module
 * only says what the bytes are.
 *
 * Plain CommonJS so both the app (through Metro) and `node --test` can use the
 * exact same table.
 */

/** Raw byte sequences, exactly as a PTY expects them. */
const TERMINAL_KEYS = {
  escape: '\u001b',
  tab: '\t',
  up: '\u001b[A',
  down: '\u001b[B',
  left: '\u001b[D',
  right: '\u001b[C',
  enter: '\r',
  /** Ctrl+C. */
  interrupt: '\u0003',
  slash: '/',
};

/**
 * Ctrl held with one letter: the ASCII control code for it.
 * `Ctrl+C` is `\u0003`, `Ctrl+A` is `\u0001`, and so on up to `Ctrl+_`.
 *
 * @param {string} letter one character; case does not matter
 * @returns {string|null} the control code, or null when there is no such key
 */
function controlCode(letter) {
  if (typeof letter !== 'string' || letter.length === 0) return null;
  const code = letter[0].toUpperCase().charCodeAt(0);
  // @ A-Z [ \ ] ^ _ are the characters that have a control code.
  if (code < 64 || code > 95) return null;
  return String.fromCharCode(code & 31);
}

module.exports = { TERMINAL_KEYS, controlCode };
