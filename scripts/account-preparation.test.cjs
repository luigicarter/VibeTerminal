'use strict';
const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
function walk(directory) {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory()
        ? walk(path.join(directory, e.name))
        : [path.join(directory, e.name)],
    );
}
test('normal composition roots and fixture previews do not import prepared account code', () => {
  const files = [
    'apps/desktop/backend/main.cjs',
    'apps/desktop/preload/preload.cjs',
    'apps/desktop/frontend/main.tsx',
    'apps/desktop/frontend/App.tsx',
    'apps/website/frontend/src/App.tsx',
    'apps/server/src/server.ts',
    'apps/server/scripts/jobs.ts',
    'apps/server/scripts/migrate.ts',
  ];
  for (const directory of [
    'apps/desktop/frontend/account',
    'apps/website/frontend/src/account',
    'apps/website/frontend/src/admin',
  ])
    for (const file of walk(path.join(root, directory)))
      if (/\.[cm]?[jt]sx?$/.test(file)) files.push(path.relative(root, file));
  for (const file of files)
    assert.doesNotMatch(
      read(file),
      /(?:from\s*|require\(\s*|import\(\s*)['"][^'"]*(?:account-prepared|\/prepared(?:\/|['"]))/i,
      file,
    );
});
test('prepared source is owned by its app and excluded from normal packaging', () => {
  const desktop = JSON.parse(read('apps/desktop/package.json'));
  assert(desktop.build.files.includes('!backend/account-prepared/**'));
  const docker = read('apps/server/deploy/Dockerfile');
  assert.match(
    docker,
    /rm -rf src\/prepared migrations\/prepared contracts\/prepared/,
  );
  const migration = read('apps/server/src/db/migrations.ts');
  assert.match(migration, /\\d\{3\}/);
  assert.doesNotMatch(migration, /migrations\/prepared/);
  for (const app of ['desktop', 'website']) {
    const folder =
      app === 'desktop'
        ? 'backend/account-prepared'
        : 'frontend/src/account-prepared';
    for (const file of walk(path.join(root, 'apps', app, folder)))
      assert.doesNotMatch(
        fs.readFileSync(file, 'utf8'),
        /(?:from\s*|require\(\s*)['"][^'"]*(?:apps\/server|better-auth|stripe\/|\/db\/)/,
        file,
      );
  }
});
test('prepared modules have no startup registration or environment enable switch', () => {
  assert.doesNotMatch(read('apps/server/src/server.ts'), /prepared/i);
  assert.doesNotMatch(
    read('apps/desktop/backend/main.cjs'),
    /account-prepared/,
  );
  assert.doesNotMatch(
    read('apps/server/src/prepared/app.ts'),
    /process\.env|Bun\.serve|setInterval/,
  );
  assert.doesNotMatch(
    read('apps/desktop/backend/account-prepared/ipc.cjs'),
    /setAsDefaultProtocolClient|second-instance|open-url/,
  );
  const stripe = read('apps/server/src/prepared/stripe.ts');
  assert.match(stripe, /sk_test_/);
  assert.doesNotMatch(stripe, /process\.env/);
});
