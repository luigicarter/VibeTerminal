'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const yaml = require('js-yaml');
const { createLocalErrorAudio, ERROR_AUDIO_TEXT } = require('../../backend/localErrorAudio.cjs');
const { loadVoiceModels } = require('../../backend/voiceModels.cjs');
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
// Both spoken alerts and local detection models are checksum-verified.
const alerts = createLocalErrorAudio({ directory: path.join(resources, 'voice/alerts') });
for (const category of Object.keys(ERROR_AUDIO_TEXT)) alerts.load(category);
const voiceModels = loadVoiceModels(path.join(resources, 'voice'));
for (const relative of [
  'sherpa-onnx-node/sherpa-onnx.js', 'sherpa-onnx-win-x64/sherpa-onnx.node',
  'sherpa-onnx-win-x64/sherpa-onnx-c-api.dll', 'sherpa-onnx-win-x64/sherpa-onnx-cxx-api.dll',
  'sherpa-onnx-win-x64/onnxruntime.dll', 'sherpa-onnx-win-x64/onnxruntime_providers_shared.dll',
  'onnxruntime-node/dist/binding.js', 'onnxruntime-common/dist/cjs/index.js',
  'onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime_binding.node',
  'onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime.dll',
]) {
  const file = path.join(resources, 'app.asar.unpacked/node_modules', relative);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile() || !fs.statSync(file).size) throw Error(`Missing or empty unpacked voice runtime: ${relative}`);
}
console.log(JSON.stringify({ version, installer: installerName, size: bytes.length, sha512, voiceAlerts: Object.keys(ERROR_AUDIO_TEXT).length, voiceModels: voiceModels.manifest.files.length, verified: true }));
