'use strict';
const { Buffer } = require('node:buffer');
const base = { up: 'A', down: 'B', right: 'C', left: 'D', home: 'H', end: 'F' };
const fixed = { pageup: '\x1b[5~', pagedown: '\x1b[6~', insert: '\x1b[2~', delete: '\x1b[3~', backspace: '\x7f', tab: '\t', 'shift-tab': '\x1b[Z', enter: '\r', escape: '\x1b', space: ' ' };
const KEYS = new Set([...Object.keys(base), ...Object.keys(fixed)]);
Object.assign(fixed, { 'ctrl-space': '\x00', 'ctrl-backslash': '\x1c', 'ctrl-leftbracket': '\x1b', 'ctrl-rightbracket': '\x1d', 'ctrl-caret': '\x1e', 'ctrl-underscore': '\x1f' });
for (const key of Object.keys(fixed)) KEYS.add(key);
for (const digit of '0123456789') KEYS.add(`alt-${digit}`);
for (const letter of 'abcdefghijklmnopqrstuvwxyz') { KEYS.add(`ctrl-${letter}`); KEYS.add(`alt-${letter}`); }
for (const modifier of ['shift', 'ctrl', 'ctrl-shift']) for (const key of Object.keys(base)) KEYS.add(`${modifier}-${key}`);
for (let i = 1; i <= 12; i++) KEYS.add(`f${i}`);
function normalizeTerminalKeys(keys) {
  return Array.isArray(keys) ? keys.map(key => typeof key === 'string' ? key.trim().toLowerCase() : key) : keys;
}
function validateTerminalControls(action) {
  if (!action || (action.text !== undefined && (typeof action.text !== 'string' || Buffer.byteLength(action.text, 'utf8') > 100000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(action.text))) ||
      (action.keys !== undefined && (!Array.isArray(action.keys) || action.keys.length > 16 || action.keys.some(key => !KEYS.has(key)))) ||
      ['submit', 'editInput', 'operator'].some(key => action[key] !== undefined && typeof action[key] !== 'boolean') ||
      (!action.text && !action.keys?.length && !action.submit && !action.mouse)) return { ok: false, error: 'Use bounded literal text and supported named terminal keys.' };
  if (action.mouse !== undefined) {
    const mouse = action.mouse;
    if (!mouse || typeof mouse !== 'object' || Array.isArray(mouse) || Object.keys(mouse).some(key => !['x', 'y', 'button', 'action'].includes(key)) || !['x', 'y', 'button', 'action'].every(key => Object.hasOwn(mouse, key)) || !Number.isSafeInteger(mouse.x) || !Number.isSafeInteger(mouse.y) || mouse.x < 1 || mouse.y < 1 || mouse.x > 10000 || mouse.y > 10000 ||
        !['left', 'middle', 'right', 'wheel-up', 'wheel-down'].includes(mouse.button) || !['click', 'down', 'up', 'move'].includes(mouse.action) ||
        (mouse.button.startsWith('wheel-') && mouse.action !== 'click') || action.text || action.keys?.length || action.submit) return { ok: false, error: 'Use one mouse action with 1-based terminal cell coordinates and no keyboard controls.' };
  }
  const submissionKeys = (action.keys || []).filter(key => ['enter', 'ctrl-m', 'ctrl-j'].includes(key));
  if (submissionKeys.length && (action.submit || submissionKeys.length !== 1 || !['enter', 'ctrl-m', 'ctrl-j'].includes(action.keys.at(-1)))) return { ok: false, error: 'Use Enter once as the final key, or submit, never both.' };
  if (action.keys?.includes('ctrl-c') && (action.submit || action.keys.filter(key => key === 'ctrl-c').length !== 1 || action.keys.at(-1) !== 'ctrl-c')) return { ok: false, error: 'Use Ctrl-C once as the final key without submission.' };
  return { ok: true, text: (action.text || '').replace(/\r\n?/g, '\n') };
}
function encodeTerminalControls(action, modes = {}) {
  const checked = validateTerminalControls(action);
  if (!checked.ok) return checked;
  const { text } = checked;
  if (action.mouse) {
    const { x, y, button, action: mouseAction } = action.mouse;
    if (!Number.isSafeInteger(modes.cols) || !Number.isSafeInteger(modes.rows) || x > modes.cols || y > modes.rows) return { ok: false, error: 'Mouse coordinates must be inside the current terminal dimensions.' };
    if (!modes.mouseSgr || !modes.mouseTracking || (mouseAction === 'move' && ![1002, 1003].includes(modes.mouseTracking))) return { ok: false, status: 'unsupported-control', error: 'The terminal application has not enabled the required SGR mouse reporting mode.' };
    const code = { left: 0, middle: 1, right: 2, 'wheel-up': 64, 'wheel-down': 65 }[button];
    const packet = (value, release = false) => `\x1b[<${value};${x};${y}${release ? 'm' : 'M'}`;
    const data = mouseAction === 'move' ? packet(code + 32) : mouseAction === 'up' ? packet(code, true) : packet(code) + (mouseAction === 'click' && code < 64 ? packet(code, true) : '');
    return { ok: true, text: '', data };
  }
  if (/[\n\t]/.test(text) && !modes.bracketedPaste) return { ok: false, error: 'Multiline text and literal tabs require bracketed paste.' };
  const encode = key => {
    if (Object.hasOwn(fixed, key)) return fixed[key];
    if (Object.hasOwn(base, key)) return (modes.applicationCursorKeys ? '\x1bO' : '\x1b[') + base[key];
    if (/^ctrl-[a-z]$/.test(key)) return String.fromCharCode(key.charCodeAt(5) - 96);
    if (/^alt-[a-z0-9]$/.test(key)) return '\x1b' + key.at(-1);
    const modified = /^(shift|ctrl|ctrl-shift)-(up|down|left|right|home|end)$/.exec(key);
    if (modified) return `\x1b[1;${{ shift: 2, ctrl: 5, 'ctrl-shift': 6 }[modified[1]]}${base[modified[2]]}`;
    const fn = Number(key.slice(1));
    return fn <= 4 ? '\x1bO' + 'PQRS'[fn - 1] : `\x1b[${[15, 17, 18, 19, 20, 21, 23, 24][fn - 5]}~`;
  };
  return { ok: true, text, data: (text && modes.bracketedPaste ? '\x1b[200~' + text + '\x1b[201~' : text) + (action.keys || []).map(encode).join('') + (action.submit ? '\r' : '') };
}
module.exports = { TERMINAL_KEYS: [...KEYS], normalizeTerminalKeys, validateTerminalControls, encodeTerminalControls };
