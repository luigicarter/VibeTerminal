const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const vite = path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js');
const services = [
  spawn(process.execPath, ['--watch', '--import', 'tsx', 'src/server.ts'], { cwd: path.join(root, 'backend'), stdio: 'inherit', windowsHide: true }),
  spawn(process.execPath, [vite, '--host', '127.0.0.1'], { cwd: path.join(root, 'frontend'), stdio: 'inherit', windowsHide: true })
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of services) {
    if (!child.pid || child.exitCode !== null) continue;
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
    else child.kill('SIGTERM');
  }
  process.exitCode = code;
}
for (const child of services) {
  child.on('error', error => { console.error(error.message); stop(1); });
  child.on('exit', code => stop(code || 0));
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
