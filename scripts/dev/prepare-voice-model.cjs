// Prepare the pinned, Apache-2.0 English keyword model. No Python at build or runtime.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const MODEL = 'sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01';
const URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/${MODEL}.tar.bz2`;
const ARCHIVE_HASH = 'f170013b4716e41b62b9bfd809687c207cef798ef9bc6534d524e17af9b6561a';
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
// Minimal protobuf reader for SentencePiece ModelProto's repeated SentencePiece field.
function fields(buffer) {
  let offset = 0;
  function varint() { let n = 0, shift = 0, b; do { if (offset >= buffer.length || shift > 49) throw Error('Invalid protobuf'); b = buffer[offset++]; n += (b & 127) * 2 ** shift; shift += 7; } while (b & 128); return n; }
  const out = [];
  while (offset < buffer.length) {
    const tag = varint(), wire = tag & 7; let data;
    if (wire === 2) { const size = varint(); data = buffer.subarray(offset, offset + size); offset += size; }
    else if (wire === 5) { data = buffer.subarray(offset, offset + 4); offset += 4; }
    else if (wire === 1) { data = buffer.subarray(offset, offset + 8); offset += 8; }
    else if (wire === 0) data = varint();
    else throw Error('Unsupported protobuf wire type');
    if (offset > buffer.length) throw Error('Truncated protobuf');
    out.push({ id: tag >> 3, wire, data });
  }
  return out;
}
function tokenizeBpe(model, text) {
  const scores = new Map();
  for (const field of fields(model).filter(f => f.id === 1 && f.wire === 2)) {
    const f = fields(field.data), piece = f.find(x => x.id === 1)?.data?.toString('utf8');
    const score = f.find(x => x.id === 2)?.data;
    if (piece && Buffer.isBuffer(score)) scores.set(piece, score.readFloatLE());
  }
  return text.trim().toUpperCase().split(/\s+/).flatMap(word => {
    const parts = Array.from(`▁${word}`);
    while (parts.length > 1) {
      let best = -1, score = -Infinity;
      for (let i = 0; i < parts.length - 1; i++) {
        const candidate = scores.get(parts[i] + parts[i + 1]);
        if (candidate !== undefined && candidate > score) { best = i; score = candidate; }
      }
      if (best < 0) break;
      parts.splice(best, 2, parts[best] + parts[best + 1]);
    }
    if (parts.some(p => !scores.has(p))) throw Error('Keyword contains unknown model tokens');
    return parts;
  });
}
async function prepare() {
  const destination = path.resolve(__dirname, '../../vendor/voice');
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(destination, 'manifest.json'), 'utf8'));
    if (manifest.archiveSha256 === ARCHIVE_HASH && Object.entries(manifest.files).every(([name, checksum]) => !name.includes('..') && hash(fs.readFileSync(path.join(destination, name))) === checksum)) {
      console.log('Pinned voice model verified.'); return;
    }
  } catch { /* Download and verify a missing or incomplete model bundle. */ }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-voice-model-'));
  try {
    const response = await fetch(URL, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw Error(`Model download HTTP ${response.status}`);
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > 20 * 1024 * 1024) throw Error('Model exceeds expected size'); chunks.push(chunk); }
    const archive = Buffer.concat(chunks);
    if (hash(archive) !== ARCHIVE_HASH) throw Error('Model archive checksum mismatch');
    const archivePath = path.join(temp, 'model.tar.bz2'); fs.writeFileSync(archivePath, archive);
    const names = ['encoder', 'decoder', 'joiner'].map(n => `${n}-epoch-12-avg-2-chunk-16-left-64.int8.onnx`).concat(['tokens.txt', 'bpe.model', 'README.md']);
    execFileSync('tar', ['-xf', archivePath, '-C', temp, ...names.map(n => `${MODEL}/${n}`)], { windowsHide: true });
    fs.mkdirSync(destination, { recursive: true });
    const checksums = {};
    for (const name of names) { const b = fs.readFileSync(path.join(temp, MODEL, name)); fs.writeFileSync(path.join(destination, name), b); checksums[name] = hash(b); }
    const keyword = tokenizeBpe(fs.readFileSync(path.join(destination, 'bpe.model')), 'HEY VIBE').join(' ') + ' @HEY_VIBE\n';
    const vocab = new Set(fs.readFileSync(path.join(destination, 'tokens.txt'), 'utf8').split(/\r?\n/).map(l => l.split(' ')[0]));
    if (keyword.split(' ').filter(t => !t.startsWith('@')).some(t => !vocab.has(t))) throw Error('Generated keyword outside model vocabulary');
    fs.writeFileSync(path.join(destination, 'hey-vibe.txt'), keyword); checksums['hey-vibe.txt'] = hash(Buffer.from(keyword));
    // The model author's Apache declaration is retained verbatim in README.md.
    const licenseResponse = await fetch('https://raw.githubusercontent.com/k2-fsa/sherpa-onnx/v1.13.7/LICENSE', { signal: AbortSignal.timeout(30000) });
    if (!licenseResponse.ok) throw Error('Cannot retrieve upstream license');
    const license = await licenseResponse.text();
    if (!license.includes('Apache License') || license.length > 20000) throw Error('Unexpected upstream license');
    fs.writeFileSync(path.join(destination, 'LICENSE'), license); checksums.LICENSE = hash(Buffer.from(license));
    fs.writeFileSync(path.join(destination, 'NOTICE'), `English keyword model by pkufool / Next-gen Kaldi contributors.\nModel: ${MODEL}\nSource: ${URL}\nModel card: https://www.modelscope.cn/pkufool/${MODEL}\nLicense: Apache License 2.0 (author declaration in README.md).\nRuntime sherpa-onnx: Copyright (c) 2022-2026 Xiaomi Corporation; Apache-2.0.\nhey-vibe.txt is a generated customization, not an upstream keyword file.\n`);
    fs.writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify({ model: MODEL, archive: URL, archiveSha256: ARCHIVE_HASH, keyword: 'Hey Vibe', sampleRate: 16000, files: checksums }, null, 2) + '\n');
    console.log(`Prepared ${MODEL}: ${keyword.trim()}`);
  } finally {
    const resolved = path.resolve(temp), tempRoot = path.resolve(os.tmpdir()) + path.sep;
    if (!resolved.startsWith(tempRoot) || !path.basename(resolved).startsWith('vibe-voice-model-')) throw Error('Unsafe temporary model path');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
if (require.main === module) prepare().catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { tokenizeBpe, prepare };
