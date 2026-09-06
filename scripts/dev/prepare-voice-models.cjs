'use strict';
// Download only pinned artifacts. Existing verified bundles need no network.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { loadVoiceModels } = require('../../backend/voiceModels.cjs');
const root = path.resolve(__dirname, '../../vendor/voice');
const directory = path.join(root, 'models');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  return Buffer.from(await response.arrayBuffer());
}
async function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  const archives = new Map();
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-voice-models-'));
  try {
    for (const file of manifest.files) {
      if (path.basename(file.path) !== file.path) throw new Error('Invalid model path');
      const target = path.join(directory, file.path);
      if (fs.existsSync(target)) {
        const current = fs.readFileSync(target);
        if (current.length === file.bytes && hash(current) === file.sha256) continue;
        throw new Error(`Corrupt model ${file.path}; remove that file explicitly before restoring it`);
      }
      let bytes;
      if (file.content !== undefined) bytes = Buffer.from(file.content, 'utf8');
      else if (file.archiveMember) {
        if (!archives.has(file.url)) {
          const archive = await download(file.url);
          if (hash(archive) !== file.archiveSha256) throw new Error('Archive checksum mismatch');
          const archivePath = path.join(temporary, `archive-${archives.size}.tar.bz2`);
          fs.writeFileSync(archivePath, archive); archives.set(file.url, archivePath);
        }
        bytes = execFileSync('tar', ['-xOf', archives.get(file.url), file.archiveMember], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
      } else bytes = await download(file.url);
      if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) throw new Error(`Downloaded checksum mismatch: ${file.path}`);
      fs.writeFileSync(target, bytes, { flag: 'wx' });
    }
    loadVoiceModels(root);
    console.log(`Verified ${manifest.files.length} bundled voice assets (offline when present).`);
  } finally {
    // This exact directory is created by mkdtemp above and contains only downloaded archives.
    if (path.dirname(temporary) !== path.resolve(os.tmpdir())) throw new Error('Unexpected temporary directory');
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
