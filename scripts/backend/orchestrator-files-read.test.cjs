'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const { createFiles } = require('../../backend/orchestratorFiles.cjs');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-file-read-'));
  t.after(async () => { assert.equal(path.dirname(root), os.tmpdir()); await fs.rm(root, { recursive: true, force: true }); });
  return { root, file: path.join(root, 'evidence.txt'), files: createFiles({ getRoots: () => [root] }) };
}
test('UTF-8 file pages preserve every character and reject changed source revisions', async t => {
  const f = await fixture(t), source = '\ufeffα🙂beta\n'.repeat(8);
  await fs.writeFile(f.file, source);
  let offset = 0, reference, combined = '';
  do {
    const page = await f.files.read({ path: f.file, offset, reference, limit: 5 });
    assert(page.text.length); combined += page.text; offset = page.nextOffset; reference = page.reference;
  } while (offset !== null);
  assert.equal(combined, source);
  await fs.writeFile(f.file, 'changed');
  await assert.rejects(() => f.files.read({ path: f.file, offset: 1, reference }), /changed/);
});
test('file reads enforce scope, text format, offsets and cancellation', async t => {
  const f = await fixture(t); await fs.writeFile(f.file, Buffer.from([0, 1, 2]));
  await assert.rejects(() => f.files.read({ path: f.file }), /Binary/);
  await assert.rejects(() => f.files.read({ path: f.root }), /regular text/);
  await assert.rejects(() => f.files.read({ path: __filename }), /outside/);
  await fs.writeFile(f.file, 'hello');
  await assert.rejects(() => f.files.read({ path: f.file, offset: 1 }), /reference/);
  await assert.rejects(() => f.files.read({ path: f.file, limit: 4001 }), /limit/);
  await assert.rejects(() => f.files.read({ path: f.file }, AbortSignal.abort()), /Cancelled/);
});
