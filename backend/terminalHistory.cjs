const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');
const { scrollback } = require('../shared/terminalDisplay.json');

// Retain terminal cells, not a byte suffix: spinner/repaint traffic must never
// evict readable history. This decoder has no input/reply connection to the PTY.
function createTerminalHistory(cols, rows) {
  const terminal = new Terminal({ cols, rows, scrollback, allowProposedApi: true });
  const serializer = new SerializeAddon();
  terminal.loadAddon(serializer);
  terminal.parser.registerCsiHandler({ final: 'J' }, params => params.length === 1 && params[0] === 3);
  let visible = true, mouseEncoding = 0, cursorStyle = 0, margins = null;
  let pending = '', state = 'text';
  const resetModes = () => { visible = true; mouseEncoding = 0; cursorStyle = 0; margins = null; return false; };
  terminal.parser.registerEscHandler({ final: 'c' }, resetModes);
  for (const final of ['h', 'l']) terminal.parser.registerCsiHandler({ prefix: '?', final }, params => {
    for (const mode of params) {
      if (mode === 25) visible = final === 'h';
      // xterm 5.5 ignores 1005/1015; disabling either supported encoding
      // restores legacy reports regardless of which encoding was last enabled.
      if (mode === 1006 || mode === 1016) mouseEncoding = final === 'h' ? mode : 0;
    }
    return false;
  });
  terminal.parser.registerCsiHandler({ intermediates: ' ', final: 'q' }, params => {
    if (typeof params[0] === 'number' && params[0] >= 0 && params[0] <= 6) cursorStyle = params[0];
    return false;
  });
  terminal.parser.registerCsiHandler({ final: 'r' }, params => {
    const top = Number(params[0]) || 1, bottom = Number(params[1]) || terminal.rows;
    if (top < bottom && bottom <= terminal.rows) margins = [top, bottom];
    return false;
  });

  // A snapshot may fall between chunks of a CSI/OSC/DCS sequence. The serializer
  // preserves completed state; replay the unfinished suffix before live bytes.
  function trackPending(data) {
    for (const char of data) {
      const code = char.codePointAt(0);
      if (code === 0x18 || code === 0x1a) { pending = ''; state = 'text'; continue; }
      if (state === 'string' || state === 'string-escape') {
        pending += char;
        if (code === 0x9c || (code === 7 && (pending.startsWith('\x1b]') || pending.startsWith('\x9d'))) || (state === 'string-escape' && char === '\\')) {
          pending = ''; state = 'text';
        } else state = code === 27 ? 'string-escape' : 'string';
        continue;
      }
      if (code === 27) { pending = char; state = 'escape'; continue; }
      if (state === 'escape') {
        pending += char;
        if (char === '[') state = 'csi';
        else if (']PX^_'.includes(char)) state = 'string';
        else if (code >= 0x30 && code <= 0x7e) { pending = ''; state = 'text'; }
      } else if (state === 'csi') {
        pending += char;
        if (code >= 0x40 && code <= 0x7e) { pending = ''; state = 'text'; }
      } else if (code === 0x9b) { pending = char; state = 'csi'; }
      else if ([0x90, 0x98, 0x9d, 0x9e, 0x9f].includes(code)) { pending = char; state = 'string'; }
      else pending = code >= 0xd800 && code <= 0xdbff ? char : '';
    }
  }

  const queue = [];
  let writing = false, disposed = false;
  function drain() {
    if (writing || disposed) return;
    while (queue.length && !disposed) {
      const operation = queue.shift();
      if (operation.kind === 'write') {
        let data = operation.data;
        while (queue[0]?.kind === 'write') data += queue.shift().data;
        trackPending(data);
        writing = true;
        terminal.write(data, () => { writing = false; drain(); });
        return;
      }
      if (operation.kind === 'resize') {
        terminal.resize(operation.cols, operation.rows);
        margins = null;
      } else if (operation.kind === 'snapshot') {
        // SerializeAddon omits mouse encoding, cursor visibility/style and
        // scroll margins. Restore those after drawing both buffers. Setting
        // margins moves the cursor, so restore its position afterward too.
        const buffer = terminal.buffer.active;
        let modes = `\x1b[?25${visible ? 'h' : 'l'}\x1b[${cursorStyle} q`;
        if (mouseEncoding) modes += `\x1b[?${mouseEncoding}h`;
        if (margins) modes += `\x1b[${margins.join(';')}r`;
        if (margins || terminal.modes.originMode) {
          const y = buffer.cursorY + 1 - (terminal.modes.originMode ? (margins?.[0] || 1) - 1 : 0);
          modes += `\x1b[${y};${buffer.cursorX + 1}H`;
        }
        operation.callback({ data: serializer.serialize() + modes + pending, cols: terminal.cols, rows: terminal.rows });
      }
    }
  }
  function enqueue(operation) { if (!disposed) { queue.push(operation); drain(); } }
  return {
    write(data) { if (data) enqueue({ kind: 'write', data }); },
    resize(cols, rows) { enqueue({ kind: 'resize', cols, rows }); },
    snapshot(callback) { enqueue({ kind: 'snapshot', callback }); },
    dispose() { disposed = true; queue.length = 0; terminal.dispose(); }
  };
}

module.exports = { createTerminalHistory };
