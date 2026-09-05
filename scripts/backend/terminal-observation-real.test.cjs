const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createTerminalObservation } = require('../../backend/terminalObservation.cjs');

test('real PTY renders Unicode ANSI fixture without agent invocation', { timeout: 15000 }, async () => {
  const observation = createTerminalObservation();
  const script = `
    const pty = require('node-pty');
    const windows = process.platform === 'win32';
    const command = windows ? "[Console]::OutputEncoding=[Text.Encoding]::UTF8; [Console]::Write(([char]27)+'[2J'+([char]27)+'[Hfixture 世界')" : "printf '\\033[2J\\033[Hfixture 世界'";
    const terminal = pty.spawn(windows ? 'powershell.exe' : '/bin/sh', windows ? ['-NoLogo','-NoProfile','-NonInteractive','-Command',command] : ['-c',command], { cols:80, rows:10, cwd:process.cwd(), env:process.env });
    terminal.onData(data => process.stdout.write(JSON.stringify({data})+'\\n'));
    terminal.onExit(({exitCode}) => setTimeout(() => process.exit(exitCode),100));
  `;
  const child = spawn(process.execPath, ['-e', script], { cwd: require('node:path').resolve(__dirname, '../..'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let buffer = '', errors = '';
  const timer = setTimeout(() => child.kill(), 12000);
  try {
    await observation.ingest({ type: 'created', id: 'real', generation: 'g', cols: 80, rows: 10 });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const event = JSON.parse(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        observation.ingest({ type: 'data', id: 'real', generation: 'g', data: event.data });
      }
    });
    child.stderr.on('data', chunk => { errors += chunk; });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.equal(code, 0, errors);
    const result = await observation.read({ id: 'real', generation: 'g' });
    assert.match(result.text, /fixture 世界/);
    assert(result.sequence > 0);
  } finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); observation.dispose(); }
});
