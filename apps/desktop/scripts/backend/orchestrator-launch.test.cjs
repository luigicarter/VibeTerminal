"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { waitForSessionLaunch } = require("../../backend/orchestratorLaunch.cjs");
const result = { ok: true, id: "pane", launchToken: 2, status: "starting", draftStaged: true };
const live = { id: "pane", launchToken: 2, generation: "g2", started: true, processState: "running" };

test("creation metadata comes from the confirmed launch, never the initial UI receipt", async () => {
  const initial = { ...result, cwd: "/unconfirmed", name: "Unconfirmed" };
  const value = await waitForSessionLaunch({ result: initial, getSession: () => ({ ...live, cwd: "/project", name: "Codex" }) });
  assert.equal(value.cwd, "/project"); assert.equal(value.name, "Codex");
  const missing = await waitForSessionLaunch({ result: initial, getSession: () => live });
  assert.equal(missing.cwd, undefined); assert.equal(missing.name, undefined);
  const failed = await waitForSessionLaunch({ result: initial, getSession: () => ({ ...live, processState: "failed" }) });
  assert.equal(failed.cwd, undefined); assert.equal(failed.name, undefined);
});

test("creation waits through missing, old and preparing snapshots, then binds the real generation", async () => {
  const snapshots = [undefined, { ...live, launchToken: 1, generation: "g1" },
    { ...live, generation: "paused:pane:2", status: "paused", processState: undefined },
    { ...live, processState: "starting" }, { ...live, launchState: "pending" }, live];
  let reads = 0;
  const value = await waitForSessionLaunch({ result, getSession: () => snapshots[reads++], pollMs: 1 });
  assert.equal(reads, 6);
  assert.equal(value.ok, true);
  assert.equal(value.processState, "running");
  assert.equal(value.draftStaged, true, "waiting never submits the saved draft");
  assert.deepEqual(value.target, { id: "pane", generation: "g2", launchToken: 2 });
});

test("failed and superseded launches never yield a usable target", async () => {
  for (const [session, status] of [
    [{ ...live, processState: "failed", binding: { message: "Executable missing" } }, "launch-failed"],
    [{ ...live, processState: "exited" }, "launch-failed"],
    [{ ...live, launchToken: 3, generation: "g3" }, "superseded"],
    [{ ...live, started: false, processState: "starting" }, "closed"]
  ]) {
    const value = await waitForSessionLaunch({ result, getSession: () => session });
    assert.equal(value.ok, false); assert.equal(value.status, status);
    assert.equal(value.sessionCreated, true); assert.equal(value.target, undefined);
  }
});

test("generation change during preparation is not silently retargeted", async () => {
  let reads = 0;
  const value = await waitForSessionLaunch({ result, pollMs: 1, getSession: () => ++reads === 1 ? { ...live, processState: "starting" } : { ...live, generation: "replacement" } });
  assert.equal(value.status, "superseded"); assert.equal(value.target, undefined);
});

test("closing a pending pane drops its provisional target without launching or waiting for timeout", async () => {
  let reads = 0;
  const provisional = { id: "pane", generation: "paused:pane:2", launchToken: 2 };
  const value = await waitForSessionLaunch({ result: { ...result, target: provisional }, pollMs: 1,
    getSession: () => ++reads === 1 ? { ...provisional, started: true } : undefined });
  assert.equal(value.status, "closed"); assert.equal(value.target, undefined);
});

test("timeout and cancellation stop waiting even if inventory refresh is stuck", async () => {
  const options = { result, getSession: () => live, refresh: () => new Promise(() => {}), timeoutMs: 15 };
  assert.equal((await waitForSessionLaunch(options)).status, "launch-timeout");
  const cancel = new AbortController();
  const waiting = waitForSessionLaunch({ ...options, timeoutMs: 10000, signal: cancel.signal });
  cancel.abort();
  const value = await waiting;
  assert.equal(value.status, "cancelled"); assert.equal(value.sessionCreated, true);
  assert.equal(value.target, undefined);
});

test("inventory failure preserves the pane receipt and does not report startup success", async () => {
  const value = await waitForSessionLaunch({ result, getSession: () => live, refresh: async () => { throw Error("Window closed"); } });
  assert.equal(value.status, "launch-unconfirmed"); assert.equal(value.ok, false);
  assert.equal(value.id, "pane"); assert.match(value.error, /Window closed/);
});
