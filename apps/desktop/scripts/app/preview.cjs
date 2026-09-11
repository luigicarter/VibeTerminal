'use strict';
// Open the built app with a persistent development profile, alongside the installed app.
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const userData = path.join(process.env.APPDATA, 'vibe-terminal-codex-web-preview');
const env = { ...process.env, LINA_USER_DATA_DIR: userData };
delete env.ELECTRON_RUN_AS_NODE;
delete env.VITE_DEV_SERVER_URL;
if (!fs.existsSync(path.join(root, 'dist/index.html'))) throw new Error('Run npm run build first.');
const child = spawn(require('electron'), ['.'], { cwd: root, env, detached: true, stdio: 'ignore', windowsHide: false });
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('spawn', () => { console.log(JSON.stringify({ pid: child.pid, userData })); child.unref(); });
