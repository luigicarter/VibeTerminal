"use strict";
// Independent bundled runtime for the Open Codex CLI. The prepared, pinned
// Codex payload is the source; the user's global executable is never modified.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const platform = `${process.platform}-${process.arch}`;
const source = path.join(root, 'vendor', 'codex-bin', platform);
const target = path.join(root, 'vendor', 'open-codex', platform);
const executable = process.platform === 'win32' ? 'codex.exe' : 'codex';
if (!fs.existsSync(path.join(source, executable))) throw new Error('Prepare the pinned Codex payload first: npm run prepare:codex-bin:required');
const version = execFileSync(path.join(source, executable), ['--version'], { encoding: 'utf8', timeout: 60000, windowsHide: true }).trim();
fs.mkdirSync(target, { recursive: true });
fs.cpSync(source, target, { recursive: true, force: true });
fs.writeFileSync(path.join(target, 'open-codex-runtime.json'), JSON.stringify({ integration: 'Open Codex', version, preparedAt: new Date().toISOString() }, null, 2) + '\n');
console.log(`Prepared separate Open Codex runtime (${version}) at ${path.relative(root,target)}.`);
