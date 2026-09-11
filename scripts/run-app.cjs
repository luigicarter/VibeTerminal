'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const [app, command, ...forwarded] = process.argv.slice(2);
if (!['desktop', 'website'].includes(app) || !command) throw new Error('Usage: node scripts/run-app.cjs <desktop|website> <script|--install> [arguments]');
const appRoot = path.join(root, 'apps', app);
const npmCli = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
if (!fs.existsSync(npmCli)) throw new Error('Run this command through npm, or install npm beside Node.');
const args = command === '--install' ? ['ci', ...forwarded] : ['run', command, ...(forwarded.length ? ['--', ...forwarded] : [])];
const child = spawn(process.execPath, [npmCli, ...args], { cwd: appRoot, stdio: 'inherit', windowsHide: true });
let stopping = false;
function stop() {
  if (stopping || !child.pid || child.exitCode !== null) return;
  stopping = true;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
  else child.kill('SIGTERM');
}
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code || 0; });
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
