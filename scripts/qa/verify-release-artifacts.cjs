'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const yaml = require('js-yaml');
const { createLocalErrorAudio, ERROR_AUDIO_TEXT } = require('../../backend/localErrorAudio.cjs');
const root = path.resolve(__dirname, '../..');
const version = require('../../package.json').version;
const release = path.join(root, 'release');
const installerName = `vibeTerminal-Setup-${version}.exe`;
const installer = path.join(release, installerName);
const feed = yaml.load(fs.readFileSync(path.join(release, 'latest.yml'), 'utf8'));
const bytes = fs.readFileSync(installer), sha512 = crypto.createHash('sha512').update(bytes).digest('base64');
if (feed.version !== version || feed.path !== installerName || feed.sha512 !== sha512) throw Error('Update feed identity/hash does not match this installer.');
const item = feed.files?.find(file => file.url === installerName);
if (!item || item.sha512 !== sha512 || item.size !== bytes.length) throw Error('Update feed asset hash/size does not match this installer.');
if (!fs.statSync(installer + '.blockmap').size) throw Error('Installer blockmap is empty.');
const resources = path.join(release, 'win-unpacked/resources');
for (const name of ['sherpa-onnx.node', 'sherpa-onnx-c-api.dll', 'sherpa-onnx-cxx-api.dll', 'onnxruntime.dll', 'onnxruntime_providers_shared.dll']) {
  if (!fs.statSync(path.join(resources, 'app.asar.unpacked/node_modules/sherpa-onnx-win-x64', name)).size) throw Error(`Missing packaged native dependency: ${name}`);
}
const manifest = JSON.parse(fs.readFileSync(path.join(resources, 'voice/manifest.json'), 'utf8'));
if (manifest.sampleRate !== 16000 || Object.keys(manifest.files || {}).length < 8) throw Error('Packaged voice model manifest is incomplete.');
for (const [name, entry] of Object.entries(manifest.files || {})) {
  const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(resources, 'voice', name))).digest('hex');
  const expected = typeof entry === 'string' ? entry : entry.sha256;
  if (actual !== expected) throw Error(`Packaged voice model checksum differs: ${name}`);
}
const alerts = createLocalErrorAudio({ directory: path.join(resources, 'voice/alerts') });
for (const category of Object.keys(ERROR_AUDIO_TEXT)) alerts.load(category);
const nativeVoiceCheck = require('node:child_process').spawnSync(process.execPath, ['scripts/backend/voice-packaged-smoke.cjs'], { cwd: root, stdio: 'inherit', windowsHide: true });
if (nativeVoiceCheck.error) throw nativeVoiceCheck.error;
if (nativeVoiceCheck.status !== 0) throw Error('Packaged native voice helper failed.');
console.log(JSON.stringify({ version, installer: installerName, size: bytes.length, sha512, voiceAlerts: Object.keys(ERROR_AUDIO_TEXT).length, verified: true }));
