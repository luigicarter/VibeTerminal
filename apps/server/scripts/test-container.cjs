'use strict';
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const cwd = path.resolve(__dirname, '..');
const image = 'lina-account-test:local';
for (const args of [
  ['build', '-f', 'deploy/Dockerfile.test', '-t', image, '.'],
  ['run', '--rm', image],
]) {
  const result = spawnSync('docker', args, {
    cwd,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.status !== 0) {
    process.exitCode = result.status || 1;
    break;
  }
}
