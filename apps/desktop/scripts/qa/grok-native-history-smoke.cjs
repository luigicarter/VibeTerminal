// Read-only installed CLI verification against isolated, disposable fixtures.
// No prompt, login, provider request, or existing user config is involved.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { lookupGrokThread } = require('../../backend/grokThreads.cjs');

async function main() {
  const binary = process.argv[2] || path.join(os.homedir(), '.grok', 'bin', process.platform === 'win32' ? 'grok.exe' : 'grok');
  await fs.access(binary);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-grok-native-history-'));
  const home = path.join(root, 'home'), cwd = path.join(root, 'workspace'), grok = path.join(home, '.grok');
  const env = {};
  for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'PATH', 'PATHEXT', 'COMSPEC', 'SystemDrive']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  Object.assign(env, { HOME: home, USERPROFILE: home, GROK_HOME: grok,
    APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_CACHE_HOME: path.join(home, '.cache'), TEMP: root, TMP: root });
  const run = args => {
    const result = spawnSync(binary, args, { cwd, env, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  try {
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(home, { recursive: true });
    const version = run(['--version']).trim();
    const omissions = [null, 'info', 'session_summary', 'created_at', 'updated_at', 'num_messages', 'current_model_id'];
    const invalidDates = ['2026-02-31T00:00:00Z', '2026-09-01T24:00:00Z'];
    const ids = [];
    for (let i = 0; i < omissions.length + invalidDates.length; i++) {
      const id = `11111111-1111-4111-8111-${String(i + 1).padStart(12, '0')}`;
      ids.push(id);
      const summary = { info: { id, cwd }, session_summary: 'Opening prompt',
        generated_title: i >= omissions.length ? `INVALID_DATE_${i - omissions.length}` : i ? `OMIT_${omissions[i]}` : 'VIBE_NATIVE_HISTORY_VALID',
        created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-02T00:00:00Z',
        num_messages: 1, current_model_id: 'grok-code' };
      if (omissions[i]) delete summary[omissions[i]];
      if (i >= omissions.length) summary.created_at = invalidDates[i - omissions.length];
      const dir = path.join(grok, 'sessions', encodeURIComponent(cwd), id);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'summary.json'), JSON.stringify(summary));
    }
    const output = run(['--cwd', cwd, 'sessions', 'list', '--limit', '30']);
    assert.ok(output.includes(ids[0]), 'Installed CLI must list the valid native session ID.');
    assert.ok(output.includes('VIBE_NATIVE_HISTORY_VALID'), 'Installed CLI must prefer generated_title.');
    for (let i = 1; i < ids.length; i++) assert.ok(!output.includes(ids[i]), `Installed CLI unexpectedly accepted ${omissions[i] || invalidDates[i - omissions.length]}.`);
    const confirmed = await lookupGrokThread({ cwd, confirmId: ids[0] }, { home: grok });
    assert.equal(confirmed.rootVerified, true);
    assert.equal(confirmed.threadRef.title, 'VIBE_NATIVE_HISTORY_VALID');
    assert.equal(confirmed.threadRef.titleSource, 'generated');
    for (let i = 1; i < ids.length; i++) assert.equal((await lookupGrokThread({ cwd, confirmId: ids[i] }, { home: grok })).rootVerified, false, omissions[i] || invalidDates[i - omissions.length]);
    console.log(`Grok native history smoke passed (${version}): native title/ID match; six required-field omissions and two invalid timestamps rejected by CLI and adapter.`);
  } finally {
    // root comes directly from mkdtemp beneath the OS temp directory.
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
