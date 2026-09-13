'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const expected = fs
  .readFileSync(path.join(root, '.bun-version'), 'utf8')
  .trim();
const local = path.join(
  root,
  '.tmp',
  'toolchain',
  'bun-windows-x64',
  'bun.exe',
);
const bun =
  process.env.LINA_BUN ||
  (process.platform === 'win32' && fs.existsSync(local) ? local : 'bun');
const probe = spawnSync(bun, ['--version'], {
  encoding: 'utf8',
  windowsHide: true,
});
if (probe.status !== 0 || probe.stdout.trim() !== expected)
  throw new Error(
    `Server requires Bun ${expected}. Install it or set LINA_BUN to its executable.`,
  );
const [command, ...args] = process.argv.slice(2);
const child = spawn(
  bun,
  command === '--install'
    ? ['install', '--frozen-lockfile']
    : ['--no-env-file', 'run', command, ...args],
  { cwd: root, stdio: 'inherit', windowsHide: true },
);
child.on('error', () => {
  console.error('Server command could not start.');
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
function stop() {
  if (child.exitCode === null && child.pid) {
    if (process.platform === 'win32')
      spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    else child.kill('SIGTERM');
  }
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
