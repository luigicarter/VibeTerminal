'use strict';
// The launcher catalog a request plans against.
//
// The catalog is published by the renderer's inventory reply and read straight
// out of the session directory. On the first request of a session that read
// raced the very first inventory, so the request planned against an empty
// catalog: the deterministic command compiler has no provider to resolve its
// provider slot against and declines `unknown-provider`, and the brain is asked
// to choose an agent from a list of none. The September 14 completion ladder
// recorded exactly that, once per run, always on the first request
// (`{"stage":"compiled","status":"declined","reason":"unknown-provider"}`).
const test = require('node:test');
const assert = require('node:assert/strict');
const { waitForInventoryApplied, INVENTORY_WAIT_MS } = require('../../backend/orchestratorIntegration.cjs');
const { createInventoryRefresh } = require('../../backend/orchestratorInventory.cjs');

// A workspace whose inventory reply arrives after `delayMs`, wired exactly the
// way installOrchestrator wires it: one coalescing reader, an apply that fills
// the catalog, and a counter of how many inventories have been applied.
function workspace({ delayMs = 0, launchers = [{ kind: 'codex', label: 'Codex', available: true, configured: true }], ok = true } = {}) {
  let applied = 0, reads = 0, catalog = [];
  const reader = createInventoryRefresh({
    read: async () => { reads++; if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs)); return ok ? { ok: true, sessions: [], launchers } : { ok: false, error: 'Workspace acknowledgment timed out; no automatic retry.' }; },
    apply: result => { catalog = result.launchers || []; applied++; },
  });
  return { reader, get applied() { return applied; }, get reads() { return reads; }, get catalog() { return catalog; },
    launchersForRequest: async (overrides = {}) => {
      await waitForInventoryApplied({ applied: () => applied > 0, refresh: () => reader.refresh(), ...overrides });
      return catalog;
    } };
}

test('a request that arrives before any inventory has been applied waits for one', async () => {
  const space = workspace({ delayMs: 40 });
  // What the old code did: read the directory synchronously, while the first
  // inventory was still in flight.
  assert.deepEqual(space.catalog, [], 'the catalog really is empty before the first inventory lands');
  const catalog = await space.launchersForRequest();
  assert.equal(space.applied, 1, 'exactly one inventory was applied');
  assert.deepEqual(catalog.map(item => item.kind), ['codex'], 'the request plans against the published catalog');
});

test('the wait joins the inventory already in flight rather than asking for a second one', async () => {
  const space = workspace({ delayMs: 40 });
  const inFlight = space.reader.refresh();
  const catalog = await space.launchersForRequest();
  await inFlight;
  assert.equal(space.reads, 1, 'one inventory read served both callers');
  assert.deepEqual(catalog.map(item => item.kind), ['codex']);
});

test('once one inventory has been applied nothing waits again, even for an empty catalog', async () => {
  const space = workspace({ launchers: [] });
  const clock = { at: 0 };
  const first = await space.launchersForRequest({ now: () => clock.at, sleep: () => { clock.at += 10000; } });
  assert.deepEqual(first, [], 'a workspace that publishes no launchers publishes none');
  assert.equal(space.applied, 1);
  const before = space.reads;
  assert.equal(await waitForInventoryApplied({ applied: () => space.applied > 0, refresh: () => space.reader.refresh() }), true);
  assert.equal(space.reads, before, 'an applied inventory is never re-read to satisfy the wait');
});

test('an inventory that never succeeds gives up at its own deadline instead of hanging', async () => {
  const space = workspace({ ok: false });
  const clock = { at: 0 };
  const slept = [];
  const settled = await waitForInventoryApplied({ applied: () => space.applied > 0, refresh: () => space.reader.refresh(),
    now: () => clock.at, sleep: ms => { slept.push(ms); clock.at += ms; } });
  assert.equal(settled, false, 'the wait reports that no inventory was applied');
  assert.equal(space.applied, 0);
  assert.ok(slept.length > 0 && clock.at >= INVENTORY_WAIT_MS, `gave up after ${clock.at}ms, budget ${INVENTORY_WAIT_MS}ms`);
  assert.ok(clock.at < INVENTORY_WAIT_MS + 1000, 'and did not overshoot its budget');
});

test('a disposed workspace stops waiting at once', async () => {
  const space = workspace({ delayMs: 5 });
  let disposed = true;
  assert.equal(await waitForInventoryApplied({ applied: () => space.applied > 0, refresh: () => space.reader.refresh(),
    isDisposed: () => disposed }), false);
  assert.equal(space.reads, 0, 'a disposed workspace is never read');
  disposed = false;
  assert.equal(await waitForInventoryApplied({ applied: () => space.applied > 0, refresh: () => space.reader.refresh(),
    isDisposed: () => disposed }), true);
});

// The compiler's own reading of the two states, so the cost of the race is
// visible here rather than only in a ladder report.
test('the command compiler declines unknown-provider on an empty catalog and compiles on a published one', () => {
  const path = require('node:path');
  const { compileCommand } = require('../../backend/orchestratorCommandCompiler.cjs');
  const projects = [{ name: 'vibeTerminal', path: path.win32.join('C:/Projects', 'vibeTerminal') }];
  const context = launchers => ({ instruction: 'open a new Codex terminal in vibeTerminal', requestId: 'unit',
    sessions: [], projects, roots: { projects }, launchers, projectContext: projects[0] });
  assert.deepEqual(compileCommand(context([])), { accepted: false, reason: 'unknown-provider' });
  const compiled = compileCommand(context([{ kind: 'terminal', label: 'Terminal', available: true, configured: true },
    { kind: 'codex', label: 'Codex', available: true, configured: true }]));
  assert.equal(compiled.accepted, true, compiled.reason);
  assert.equal(compiled.provider, 'codex');
});
