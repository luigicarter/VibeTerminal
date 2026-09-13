import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import {
  seedDirectory,
  applyPreviewChange,
  effectiveAccess,
} from '../frontend/src/admin/model.ts';

test('preview approval changes only the chosen sample account and records its reason', () => {
  const initial = seedDirectory(),
    before = JSON.stringify(initial),
    user = initial.users.find((u) => u.name === 'Noor Ali');
  const next = applyPreviewChange(initial, {
    userId: user.id,
    action: 'approve',
    tier: 'orchestrator',
    reason: 'Approved for evaluation',
    expectedRevision: user.revision,
  });
  assert.equal(JSON.stringify(initial), before);
  const changed = next.users.find((u) => u.id === user.id);
  assert.equal(changed.status, 'active');
  assert.equal(changed.tier, 'orchestrator');
  assert.equal(effectiveAccess(changed), 'Available');
  assert.equal(next.audit[0].reason, 'Approved for evaluation');
  assert.equal(next.users.filter((u) => u.revision !== 1).length, 1);
});
test('unverified approval and stale edits surface errors without changing sample data', () => {
  const directory = seedDirectory(),
    user = directory.users.find((u) => !u.verified);
  assert.throws(
    () =>
      applyPreviewChange(directory, {
        userId: user.id,
        action: 'approve',
        tier: 'full_access',
        reason: 'Review access',
        expectedRevision: user.revision,
      }),
    /verify/,
  );
  assert.throws(
    () =>
      applyPreviewChange(directory, {
        userId: user.id,
        action: 'close',
        reason: 'Review access',
        expectedRevision: 0,
      }),
    /changed/,
  );
});
test('sample owner and administrator rules are preserved in the preview', () => {
  const directory = seedDirectory(),
    owner = directory.users.find((u) => u.role === 'owner');
  const action = {
    userId: owner.id,
    action: 'suspend',
    reason: 'Test access control',
    expectedRevision: owner.revision,
  };
  assert.throws(() => applyPreviewChange(directory, action), /active owner/);
  assert.throws(
    () => applyPreviewChange(directory, action, 'admin'),
    /Only an owner/,
  );
  assert.throws(
    () => applyPreviewChange(directory, action, 'member'),
    /Administrator access/,
  );
});
test('expiry, suspension and assigned tier remain separate presentation states', () => {
  const directory = seedDirectory();
  assert.equal(
    effectiveAccess(directory.users.find((u) => u.name === 'Casey Brooks')),
    'Expired',
  );
  const user = directory.users[0],
    next = applyPreviewChange(directory, {
      userId: user.id,
      action: 'suspend',
      reason: 'Pause evaluation',
      expectedRevision: user.revision,
    });
  assert.equal(next.users[0].tier, 'orchestrator');
  assert.equal(effectiveAccess(next.users[0]), 'Suspended');
});
test('session revocation does not change a sample plan or account status', () => {
  const initial = seedDirectory(),
    user = initial.users[0];
  const next = applyPreviewChange(initial, {
    userId: user.id,
    action: 'revoke-sessions',
    reason: 'Lost device review',
    expectedRevision: user.revision,
  });
  assert.equal(next.users[0].sessions, 0);
  assert.equal(next.users[0].tier, user.tier);
  assert.equal(next.users[0].status, user.status);
});
test('closed accounts reopen to review without an old grant', () => {
  const initial = seedDirectory(),
    user = initial.users.find((u) => u.status === 'closed');
  const next = applyPreviewChange(initial, {
    userId: user.id,
    action: 'reopen',
    reason: 'New access request',
    expectedRevision: user.revision,
  });
  const changed = next.users.find((u) => u.id === user.id);
  assert.equal(changed.status, 'pending');
  assert.equal(changed.tier, null);
});
test('unwired web screens contain no live network or persistence operations', async () => {
  for (const folder of ['account', 'admin'])
    for (const name of await readdir(
      new URL(`../frontend/src/${folder}/`, import.meta.url),
    )) {
      if (!/\.tsx?$/.test(name)) continue;
      const source = await readFile(
        new URL(`../frontend/src/${folder}/${name}`, import.meta.url),
        'utf8',
      );
      assert.doesNotMatch(
        source,
        /\bfetch\s*\(|XMLHttpRequest|sendBeacon|localStorage|sessionStorage|ipcRenderer|window\.vibe/,
      );
      assert.doesNotMatch(
        source,
        /from\s+['"][^'"]*(?:apps\/server|better-auth|\/backend\/)/,
      );
    }
  const production = await readFile(
    new URL('../frontend/src/App.tsx', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(production, /from\s+['"]\.\/(?:account|admin)\//);
});
