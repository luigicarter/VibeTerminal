'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const json = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));

test('apps resolve their own dependencies and keep independent release boundaries', () => {
  const desktop = json('apps/desktop/package.json');
  const website = json('apps/website/package.json');
  assert.equal(desktop.main, 'backend/main.cjs');
  assert.equal(desktop.build.directories.output, 'release');
  assert.deepEqual(website.workspaces, ['backend', 'frontend']);
  assert.equal(desktop.workspaces, undefined);
  for (const app of ['desktop', 'website']) {
    const location = path.join(root, 'apps', app);
    const resolve = createRequire(path.join(location, 'package.json')).resolve;
    assert.ok(resolve('react').startsWith(path.join(location, 'node_modules') + path.sep));
    assert.ok(fs.existsSync(path.join(location, 'package-lock.json')));
  }
  assert.equal(Object.keys(json('package-lock.json').packages).length, 1);
  for (const pattern of desktop.build.files.filter(value => !value.startsWith('!'))) {
    assert.ok(!pattern.startsWith('../'), `Desktop package escapes its app: ${pattern}`);
    assert.ok(!pattern.includes('website'), `Desktop package includes website: ${pattern}`);
  }
  assert.ok(!website.dependencies?.electron);
});

test('shared brand exports match the desktop and website consumer assets', () => {
  const mappings = {
    'lina-mark.svg': ['apps/desktop/frontend/assets/lina-logo.svg', 'apps/website/frontend/public/brand/lina-mark.svg'],
    'lina-logo.png': ['apps/desktop/frontend/assets/lina-logo.png', 'apps/website/frontend/public/brand/lina-logo.png'],
    'lina-logo.ico': ['apps/desktop/frontend/assets/lina-logo.ico', 'apps/website/frontend/public/favicon.ico']
  };
  for (const [source, copies] of Object.entries(mappings)) {
    const expected = fs.readFileSync(path.join(root, 'packages/brand', source));
    for (const copy of copies) assert.ok(expected.equals(fs.readFileSync(path.join(root, copy))), copy);
  }
});
