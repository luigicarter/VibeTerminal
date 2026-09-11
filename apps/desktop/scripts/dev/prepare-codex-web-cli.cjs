'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const VERSION = '0.154.0';
async function prepareNativeCli(root = path.resolve(__dirname, '../..')) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Codex Web currently requires Windows x64.');
  const target = path.join(root, 'vendor/codex-web/native/win32-x64'), marker = path.join(target, 'lina-native.json');
  const binary = path.join(target, 'bin/codex.exe');
  if (fs.existsSync(marker) && fs.existsSync(binary) && JSON.parse(fs.readFileSync(marker, 'utf8')).version === VERSION) return;
  const work = path.join(root, '.tmp/codex-web-native-' + VERSION); fs.mkdirSync(work, { recursive: true });
  const response = await fetch('https://registry.npmjs.org/@openai/codex/' + VERSION + '-win32-x64', { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error('Could not load the pinned Codex Web CLI package.');
  const manifest = await response.json(), archive = path.join(work, 'codex.tgz');
  if (manifest.version !== VERSION + '-win32-x64' || !manifest.dist?.integrity?.startsWith('sha512-') || new URL(manifest.dist.tarball).hostname !== 'registry.npmjs.org') throw new Error('Invalid Codex Web CLI package metadata.');
  const valid = () => fs.existsSync(archive) && 'sha512-' + crypto.createHash('sha512').update(fs.readFileSync(archive)).digest('base64') === manifest.dist.integrity;
  if (!valid()) {
    const downloaded = await fetch(manifest.dist.tarball, { signal: AbortSignal.timeout(120000) });
    if (!downloaded.ok) throw new Error('Could not download the pinned Codex Web CLI.');
    fs.writeFileSync(archive, Buffer.from(await downloaded.arrayBuffer()));
    if (!valid()) throw new Error('Codex Web CLI package integrity check failed.');
  }
  execFileSync('tar.exe', ['-xzf', archive, '-C', work], { windowsHide: true });
  const source = path.join(work, 'package/vendor/x86_64-pc-windows-msvc');
  const version = execFileSync(path.join(source, 'bin/codex.exe'), ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 60000 }).trim();
  if (version !== 'codex-cli ' + VERSION) throw new Error('Codex Web CLI version check failed.');
  fs.mkdirSync(target, { recursive: true }); fs.cpSync(source, target, { recursive: true });
  fs.writeFileSync(marker, JSON.stringify({ version: VERSION, packageIntegrity: manifest.dist.integrity }, null, 2) + '\n');
  console.log('Prepared separate Codex Web CLI ' + VERSION + '.');
}
module.exports = { prepareNativeCli, VERSION };
if (require.main === module) prepareNativeCli().catch(error => { console.error(error.message); process.exitCode = 1; });
