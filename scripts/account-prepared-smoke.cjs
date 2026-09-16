'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path'),
  net = require('node:net'),
  crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'),
  desktop = path.join(root, 'apps/desktop'),
  server = path.join(root, 'apps/server');
const name =
  'lina-account-prepared-smoke-' + crypto.randomBytes(6).toString('hex');
const port = () =>
  new Promise((resolve) => {
    const listener = net.createServer();
    listener.listen(0, '127.0.0.1', () => {
      const value = listener.address().port;
      listener.close(() => resolve(value));
    });
  });
function run(exe, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, {
      windowsHide: true,
      stdio: 'inherit',
      ...options,
    });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(Error('Fixture command failed: ' + code)),
    );
  });
}
(async () => {
  const profile = path.join(desktop, '.tmp/account-prepared-smoke', name);
  await fs.mkdir(profile, { recursive: true });
  const selected = await port(),
    origin = 'http://127.0.0.1:' + selected,
    token = crypto.randomBytes(32).toString('hex'),
    configFile = path.join(profile, 'fixture-config.json');
  await fs.writeFile(
    configFile,
    JSON.stringify({
      profile,
      origin,
      token,
      installationId: crypto.randomUUID(),
    }),
  );
  const npm =
    process.env.npm_execpath ||
    path.join(
      path.dirname(process.execPath),
      'node_modules/npm/bin/npm-cli.js',
    );
  await run(process.execPath, [npm, 'run', 'build:account-prepared-harness'], {
    cwd: path.join(root, 'apps/website'),
  });
  await run(
    'docker',
    [
      'build',
      '-f',
      'deploy/Dockerfile.test',
      '-t',
      'lina-account-test:local',
      '.',
    ],
    { cwd: server },
  );
  try {
    await run('docker', [
      'run',
      '--detach',
      '--rm',
      '--name',
      name,
      '--publish',
      `127.0.0.1:${selected}:${selected}`,
      '--mount',
      `type=bind,source=${path.join(root, 'apps/website/frontend/.tmp/account-prepared-harness')},target=/fixture-web,readonly`,
      '-e',
      'LINA_PREPARED_HTTP_FIXTURE=1',
      '-e',
      'LINA_PREPARED_ORIGIN=' + origin,
      '-e',
      'LINA_PREPARED_FIXTURE_TOKEN=' + token,
      'lina-account-test:local',
    ]);
    const deadline = Date.now() + 45000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        ready = (
          await fetch(origin + '/_fixture/state', {
            headers: { 'x-fixture-token': token },
            signal: AbortSignal.timeout(1000),
          })
        ).ok;
        if (ready) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!ready) throw Error('Prepared HTTP fixture did not start');
    const electronEnv = {
      ...process.env,
      LINA_ACCOUNT_PREPARED_CONFIG: configFile,
    };
    delete electronEnv.ELECTRON_RUN_AS_NODE;
    for (const stage of ['create', 'resume'])
      await run(
        path.join(desktop, 'node_modules/electron/dist/electron.exe'),
        [
          path.join(desktop, 'scripts/qa/account-prepared-electron.cjs'),
          '--stage=' + stage,
        ],
        { cwd: desktop, env: electronEnv },
      );
    console.log(
      'Prepared account browser/Electron smoke passed. Evidence: ' + profile,
    );
  } finally {
    spawnSync('docker', ['stop', '--time', '10', name], {
      windowsHide: true,
      stdio: 'ignore',
    });
    await fs.unlink(configFile).catch(() => {});
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
