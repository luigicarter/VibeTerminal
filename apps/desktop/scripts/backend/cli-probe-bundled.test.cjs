'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { probeInstalledClis } = require('../../backend/cliProbe.cjs');
const { launcherCatalog } = require('../../backend/orchestratorLaunchers.cjs');

test('bundled Kimi readiness follows its entrypoint and supports automatic launcher selection', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-kimi-probe-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'dist'));
  fs.writeFileSync(path.join(root, 'dist', 'main.mjs'), '');
  const report = await probeInstalledClis({}, { kimiCustomDir: root });
  const cli = report.clis['kimi-custom'];
  assert.equal(cli.available, true);
  assert.equal(cli.path, path.join(root, 'dist', 'main.mjs'));
  const [launcher] = launcherCatalog([{ kind: 'kimi-custom', available: cli.available, configured: cli.available }]);
  assert.ok(launcher.defaultRank > 0);
  fs.unlinkSync(cli.path);
  const absent = await probeInstalledClis({}, { kimiCustomDir: root });
  assert.deepEqual(absent.clis['kimi-custom'], { command: 'kimi-custom', available: false, path: null });
  const missing = await probeInstalledClis({}, { kimiCustomDir: null });
  assert.equal(missing.clis['kimi-custom'].available, false);
});
