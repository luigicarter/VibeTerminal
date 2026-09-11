'use strict';
// Builds the pinned upstream bridge into an executable resource, never into Lina's renderer.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const { patchUpstream } = require('./patch-codex-web.cjs');
const ROOT = path.resolve(__dirname, '../..');
const REV = 'e85e3693fdb4e3e033348c08df0298c20fcdb612';
const PATCH_VERSION = 42;
const CODEX_TEMPLATE_REV = 'f91334380e46cfd909c3642c1e05d3d8283c40ef';
const work = path.join(ROOT, '.tmp', 'codex-web-build');
const source = path.join(work, 'source');
const output = path.join(ROOT, 'vendor', 'codex-web');
function run(exe, args, cwd = work) { execFileSync(exe, args, { cwd, stdio: 'inherit', windowsHide: true, env: { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: '1' } }); }
async function download(url, dest) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  fs.writeFileSync(dest, Buffer.from(await response.arrayBuffer()));
}
async function prepare() {
  await require('./prepare-codex-web-cli.cjs').prepareNativeCli(ROOT);
  const marker = path.join(output, 'lina-build.json');
  if (!process.argv.includes('--force') && fs.existsSync(marker)) {
    const installed = JSON.parse(fs.readFileSync(marker, 'utf8'));
    if (installed.revision === REV && installed.patchVersion === PATCH_VERSION && installed.platform === process.platform && installed.arch === process.arch && fs.existsSync(path.join(output, 'runtime', 'runtime', process.platform === 'win32' ? 'bun.exe' : 'bun'))) {
      console.log('Codex Web resource is prepared.'); return;
    }
  }
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Codex Web resource preparation currently supports Windows x64.');
  fs.mkdirSync(work, { recursive: true });
  const bunDir = path.join(work, 'bun');
  const bun = path.join(bunDir, 'bun-windows-x64', 'bun.exe');
  if (!fs.existsSync(bun)) {
    const archive = path.join(work, 'bun.zip');
    await download('https://github.com/oven-sh/bun/releases/download/bun-v1.4.0/bun-windows-x64.zip', archive);
    const quote = value => "'" + value.replace(/'/g, "''") + "'";
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(bunDir)} -Force`]);
  }
  if (execFileSync(bun, ['--version'], { encoding: 'utf8', windowsHide: true }).trim() !== '1.4.0') throw new Error('Expected pinned Bun 1.4.0.');
  if (!fs.existsSync(path.join(source, '.git'))) run('git', ['clone', '--no-checkout', 'https://github.com/miuuyy/codex-chatgpt-web.git', source]);
  run('git', ['checkout', '--force', REV], source); // Only this disposable build checkout.
  const templateSource = path.join(work, 'codex-models-' + CODEX_TEMPLATE_REV + '.json');
  const templateLicense = path.join(work, 'codex-models-' + CODEX_TEMPLATE_REV + '.LICENSE');
  if (!fs.existsSync(templateSource) || !fs.existsSync(templateLicense)) {
    const local = path.join(ROOT, 'vendor/codex-official');
    let sameRevision = false;
    try { sameRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: local, encoding: 'utf8', windowsHide: true }).trim() === CODEX_TEMPLATE_REV; } catch {}
    if (sameRevision) {
      fs.writeFileSync(templateSource, execFileSync('git', ['show', CODEX_TEMPLATE_REV + ':codex-rs/models-manager/models.json'], { cwd: local, maxBuffer: 16 * 1024 * 1024, windowsHide: true }));
      fs.writeFileSync(templateLicense, execFileSync('git', ['show', CODEX_TEMPLATE_REV + ':LICENSE'], { cwd: local, windowsHide: true }));
    } else {
      await download(`https://raw.githubusercontent.com/openai/codex/${CODEX_TEMPLATE_REV}/codex-rs/models-manager/models.json`, templateSource);
      await download(`https://raw.githubusercontent.com/openai/codex/${CODEX_TEMPLATE_REV}/LICENSE`, templateLicense);
    }
  }
  const nativeModels = JSON.parse(fs.readFileSync(templateSource, 'utf8'));
  const template = (nativeModels.models || nativeModels).find(model => model.visibility === 'list' && typeof model.base_instructions === 'string');
  if (!template) throw new Error('Pinned native Codex model template is invalid.');
  fs.writeFileSync(path.join(source, 'src/lina-codex-template.json'), JSON.stringify(template));
  patchUpstream(source);
  run(bun, ['install', '--frozen-lockfile', '--ignore-scripts'], source);
  run(bun, ['install', '--frozen-lockfile', '--ignore-scripts'], path.join(source, 'launcher'));
  fs.mkdirSync(output, { recursive: true });
  const actualOutput = fs.realpathSync(output);
  const relativeOutput = path.relative(fs.realpathSync(ROOT), actualOutput);
  if (relativeOutput.startsWith('..') || path.isAbsolute(relativeOutput)) throw new Error('Runtime build target must stay inside this workspace.');
  // Upstream replaces this exact runtime directory recursively; validate its physical parent first.
  const runtimeOutput = path.join(actualOutput, 'runtime');
  if (fs.existsSync(runtimeOutput) && fs.lstatSync(runtimeOutput).isSymbolicLink()) throw new Error('Runtime build target cannot be a symbolic link.');
  // Upstream clears its output directory. Always build into a fresh staging
  // directory: the installed Bun executable may be running in a terminal.
  const staging = fs.mkdtempSync(path.join(work, 'runtime-stage-'));
  run(bun, ['run', 'scripts/build-runtime-bundle.ts', staging], source);
  fs.cpSync(staging, runtimeOutput, { recursive: true, filter: (sourcePath, targetPath) => {
    if (!fs.statSync(sourcePath).isFile() || !fs.existsSync(targetPath)) return true;
    const left = fs.statSync(sourcePath), right = fs.statSync(targetPath);
    if (left.size !== right.size) return true;
    const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    return digest(sourcePath) !== digest(targetPath);
  } });
  run(bun, ['run', 'build:renderer'], path.join(source, 'launcher'));
  const launcher = path.join(output, 'launcher');
  fs.mkdirSync(launcher, { recursive: true });
  for (const item of ['electron', 'dist', 'assets', 'package.json']) fs.cpSync(path.join(source, 'launcher', item), path.join(launcher, item), { recursive: true });
  // Verify every bundled file at build time; startup uses this app-owned copy
  // directly instead of hashing and copying the whole runtime on every launch.
  require(path.join(launcher, 'electron/runtime-install.cjs')).validateRuntimeBundle(runtimeOutput, { version: '5.0.6', platform: process.platform, arch: process.arch });
  for (const item of ['LICENSE', 'LICENSES', 'README.md']) fs.cpSync(path.join(source, item), path.join(output, item), { recursive: true });
  fs.copyFileSync(templateLicense, path.join(output, 'LICENSES/codex-model-template.LICENSE'));
  fs.writeFileSync(marker, JSON.stringify({ revision: REV, patchVersion: PATCH_VERSION, version: '5.0.6', platform: process.platform, arch: process.arch, bunSha256: crypto.createHash('sha256').update(fs.readFileSync(bun)).digest('hex') }, null, 2) + '\n');
  console.log('Prepared Codex Web 5.0.6 for Lina.');
}
prepare().catch(error => { console.error(error.message); process.exitCode = 1; });
