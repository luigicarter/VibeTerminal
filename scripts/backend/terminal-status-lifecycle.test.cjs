"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createTerminalRuntime } = require("../../backend/terminalRuntime.cjs");
const capabilities = require("../../shared/providerCapabilities.json");

function pane(provider) {
  let time = 10000;
  const runtime = createTerminalRuntime({ now: () => time, capabilities: p => capabilities[p] });
  const { generation } = runtime.beginLaunch({ id: provider, provider, cwd: process.cwd(), launchToken: 1 });
  const event = (type, details = {}) => runtime.ingest({ id: provider, generation, type, providerThreadId: "root", rootVerified: true, ...details });
  event("created");
  return { runtime, event, state: () => runtime.getSnapshot(provider), at: value => { time = value; },
    input: data => runtime.recordInput({ id: provider, generation, data }) };
}

for (const provider of Object.keys(capabilities).filter(p => p !== "terminal")) {
  test(`${provider}: response, next turn, retry, and silence retain truthful timing`, () => {
    const p = pane(provider);
    p.event("agent-running", { turnStart: true });
    p.at(12000);
    p.event("agent-activity", { kind: "tool", phase: "start", toolId: "tool", toolName: "Read" });
    p.at(20000);
    p.event("agent-response");
    assert.equal(p.state().turnState, "response");
    assert.deepEqual(p.state().activeTools, []);
    assert.equal(p.runtime.getRecord(provider).nativeActive, false);
    p.at(25000);
    p.event("agent-response");
    assert.equal(p.state().turnEndedAt, 20000, "duplicate response cannot keep moving the end time");
    p.at(30000);
    p.event("agent-running", { turnStart: false });
    assert.equal(p.state().turnStartedAt, 10000, "hook-directed continuation is the same turn");
    p.event("agent-response");
    p.at(40000);
    p.input("next\r");
    p.event("agent-running", { turnStart: true });
    assert.equal(p.state().turnStartedAt, 40000, "new prompt after a coarse response resets elapsed time");
    p.at(4000000);
    p.event("data", { data: "done, awaiting input" });
    assert.equal(p.state().turnState, "running", "silence and text cannot settle a turn");
  });
  test(`${provider}: native children outlive tool returns and root response`, () => {
    const p = pane(provider);
    p.event("agent-running", { providerTurnId: "turn", turnStart: true });
    p.event("agent-activity", { kind: "tool", phase: "start", toolId: "delegation", toolName: "Agent" });
    assert.equal(p.state().children.length, 0, "delegation tool is not a second child");
    p.event("agent-subagent", { phase: "start", taskId: "child", lifecycle: "native" });
    const child = { transcriptKind: "subagent", taskId: "child", toolId: "child-read", toolName: "Read" };
    p.event("agent-activity", { ...child, kind: "tool", phase: "start" });
    p.event("agent-activity", { ...child, kind: "tool", phase: "stop" });
    p.event("agent-activity", { kind: "tool", phase: "stop", toolId: "delegation", toolName: "Agent" });
    p.event("agent-attention", { providerTurnId: "turn", attention: { state: "completed" } });
    assert.equal(p.state().childActivity, true);
    assert.deepEqual(p.state().children.map(c => c.id), ["child"]);
    assert.equal(p.state().turnState, provider === "codex" ? "completed" : "response");
    p.event("agent-subagent", { phase: "stop", taskId: "child", lifecycle: "native", provisional: true });
    assert.equal(p.state().childActivity, true, "a provisional child Stop does not establish settlement");
    assert.equal(p.state().children[0].observation, "provisional");
    p.event("agent-session", { phase: "end", taskId: "child", transcriptKind: "subagent" });
    assert.equal(p.state().childActivity, false, "an explicit child session end settles retained proof");
    assert.equal(p.state().turnState, provider === "codex" ? "completed" : "response");
  });
  test(`${provider}: child approval is visible without replacing the root turn`, () => {
    const p = pane(provider);
    const child = { transcriptKind: "subagent", taskId: "worker", toolId: "approval-tool" };
    p.event("agent-attention", { ...child, attention: { state: "waiting", reason: "approval" } });
    assert.equal(p.state().turnState, "unknown");
    assert.equal(p.state().activityObserved, true);
    const attentionId = p.state().children[0].attention.id;
    p.event("agent-attention", { ...child, attention: { state: "waiting", reason: "approval" } });
    assert.equal(p.state().children[0].attention.id, attentionId);
    p.event("agent-running", { ...child, turnStart: false, toolId: "parallel-tool" });
    assert.equal(p.state().children[0].attention.id, attentionId, "unrelated child tool cannot clear approval");
    p.event("agent-activity", { ...child, phase: "stop", kind: "tool" });
    assert.equal(p.state().children[0].attention, undefined);
    assert.equal(p.state().childActivity, true);
  });
}

test("stale provisional response cannot replace a newer or finalized Codex turn", () => {
  const p = pane("codex");
  p.event("agent-running", { providerTurnId: "old", turnStart: true });
  p.at(20000);
  p.event("agent-running", { providerTurnId: "new", turnStart: true });
  p.event("agent-response", { providerTurnId: "old" });
  p.event("agent-response", { observedAt: 15000 });
  assert.equal(p.state().turnState, "running");
  p.event("agent-attention", { providerTurnId: "new", attention: { state: "completed" } });
  p.event("agent-response", { providerTurnId: "new" });
  assert.equal(p.state().turnState, "completed");
});

test("timestamped tool activity cannot acknowledge a newer submit or contaminate a new turn", () => {
  const p = pane("gemini");
  p.event("agent-running", { turnStart: true });
  p.at(20000);
  p.event("agent-response");
  p.at(30000);
  p.input("next\r");
  p.event("agent-activity", { phase: "start", kind: "tool", toolId: "late", observedAt: 25000 });
  p.event("agent-running", { phase: "start", turnStart: false, toolId: "late", observedAt: 25000 });
  assert.equal(p.state().pendingInput, "submit");
  assert.deepEqual(p.state().activeTools, []);
  p.event("agent-running", { turnStart: true });
  p.event("agent-activity", { phase: "start", kind: "tool", toolId: "current", observedAt: 31000 });
  p.event("agent-activity", { phase: "stop", kind: "tool", toolId: "current", observedAt: 15000 });
  assert.deepEqual(p.state().activeTools.map(tool => tool.id), ["current"]);
  p.event("agent-activity", { phase: "stop", kind: "tool", toolId: "current", observedAt: 32000 });
  assert.deepEqual(p.state().activeTools, []);
  const oldGeneration = p.state().generation;
  p.runtime.beginLaunch({ id: "gemini", provider: "gemini", cwd: process.cwd(), launchToken: 2 });
  assert.equal(p.runtime.ingest({ id: "gemini", generation: oldGeneration, type: "agent-activity", phase: "start", toolId: "stale" }), null);
  assert.deepEqual(p.state().activeTools, []);
});

test("delayed native turn starts cannot replace newer turn identity or acknowledge later input", () => {
  const p = pane("grok");
  p.event("agent-running", { providerTurnId: "first", turnStart: true, observedAt: 10000 });
  p.at(20000);
  p.event("agent-running", { providerTurnId: "current", turnStart: true, observedAt: 20000 });
  p.event("agent-activity", { phase: "start", kind: "tool", toolId: "current-tool", observedAt: 21000 });
  // The middle turn's start callback was delayed: its id has never been seen,
  // so retired-id checks alone cannot reject this older native timestamp.
  p.event("agent-running", { providerTurnId: "delayed", turnStart: true, observedAt: 15000 });
  assert.equal(p.state().turnId, "current");
  assert.equal(p.state().turnStartedAt, 20000);
  assert.deepEqual(p.state().activeTools.map(tool => tool.id), ["current-tool"]);
  p.at(25000); p.event("agent-response", { providerTurnId: "current" });
  p.event("agent-running", { turnStart: true, observedAt: 22000 });
  assert.equal(p.state().turnState, "response");
  p.at(30000); p.input("next\r");
  p.event("agent-running", { turnStart: true, observedAt: 26000 });
  assert.equal(p.state().pendingInput, "submit");
  assert.equal(p.state().turnState, "response");
  p.event("agent-running", { providerTurnId: "next", turnStart: true, observedAt: 30000 });
  assert.equal(p.state().pendingInput, undefined);
  assert.equal(p.state().turnId, "next");
});

test("anonymous child evidence does not invent exact child counts", () => {
  const p = pane("kimi");
  p.event("agent-subagent", { phase: "start", providerThreadId: undefined });
  assert.equal(p.state().activityObserved, true);
  assert.equal(p.state().children.length, 0);
  assert.equal(p.state().childActivity, true);
});

test("late native child start cannot resurrect a newer observed stop", () => {
  const p = pane("claude");
  p.event("agent-subagent", { phase: "stop", taskId: "worker", observedAt: 10000 });
  p.event("agent-subagent", { phase: "start", taskId: "worker", observedAt: 9000 });
  assert.equal(p.state().childActivity, false);
  p.event("agent-running", { transcriptKind: "subagent", taskId: "worker", observedAt: 11000 });
  assert.equal(p.state().childActivity, true, "continued work after a provisional child Stop is visible");
});

test("plain shell output never invents agent status", () => {
  const p = pane("terminal");
  p.event("data", { data: "Working...\nDone.\n>" });
  p.input("command\r");
  assert.equal(p.state().turnState, "unknown");
  assert.equal(p.state().pendingInput, undefined);
});

for (const provider of ["kimi", "kimi-custom"]) {
  test(`${provider}: verified metadata polling retains detached work until explicit settlement`, async () => {
    let time = 10000;
    let activity = { source: "kimi-task-metadata", availability: "available", active: true,
      items: [{ id: "main/agent-12345678", kind: "agent", status: "running", startedAt: 9000, endedAt: null }] };
    const runtime = createTerminalRuntime({ now: () => time, capabilities: p => capabilities[p],
      lookup: async () => ({ status: "found", rootVerified: true, threadRef: { id: "root" }, nativeBackgroundActivity: activity }) });
    const launch = runtime.beginLaunch({ id: provider, provider, cwd: process.cwd(), launchToken: 1,
      threadRef: { provider, id: "root" } });
    runtime.ingest({ id: provider, generation: launch.generation, type: "created" });
    await runtime.refresh();
    assert.equal(runtime.getSnapshot(provider).childActivity, true);
    assert.equal(runtime.getSnapshot(provider).turnState, "unknown");
    assert.equal(runtime.getSnapshot(provider).children[0].id, "background:main/agent-12345678");
    activity = { source: "kimi-task-metadata", availability: "unavailable", active: null, items: [] };
    time += 9000;
    await runtime.refresh();
    assert.equal(runtime.getSnapshot(provider).childActivity, true, "read failure preserves known evidence");
    assert.equal(runtime.getSnapshot(provider).backgroundObservation.availability, "unavailable");
    activity = { source: "kimi-task-metadata", availability: "available", active: false, items: [] };
    time += 9000;
    await runtime.refresh();
    assert.equal(runtime.getSnapshot(provider).childActivity, true, "a missing task file is not completion");
    assert.equal(runtime.getSnapshot(provider).backgroundObservation.availability, "unavailable");
    activity.items = [{ id: "main/agent-12345678", kind: "agent", status: "completed", startedAt: 9000, endedAt: time }];
    time += 9000;
    await runtime.refresh();
    assert.equal(runtime.getSnapshot(provider).childActivity, false);
    assert.equal(runtime.getSnapshot(provider).turnState, "unknown", "child metadata cannot settle the foreground turn");
    assert.equal(runtime.getSnapshot(provider).backgroundObservation.availability, "available");
    runtime.dispose();
  });
}

test("Kimi background metadata from an obsolete generation cannot populate a restarted pane", async () => {
  let complete;
  const runtime = createTerminalRuntime({ lookup: () => new Promise(resolve => { complete = resolve; }) });
  runtime.beginLaunch({ id: "p", provider: "kimi", cwd: process.cwd(), launchToken: 1, threadRef: { provider: "kimi", id: "old" } });
  const pending = runtime.refresh();
  await Promise.resolve();
  runtime.beginLaunch({ id: "p", provider: "kimi", cwd: process.cwd(), launchToken: 2 });
  complete({ status: "found", rootVerified: true, threadRef: { id: "old" }, nativeBackgroundActivity: {
    source: "kimi-task-metadata", availability: "available", active: true,
    items: [{ id: "main/agent-12345678", kind: "agent", status: "running", startedAt: 1 }]
  } });
  await pending;
  assert.equal(runtime.getSnapshot("p").childActivity, false);
  assert.equal(runtime.getSnapshot("p").conversation, undefined);
  runtime.dispose();
});

test("Kimi metadata lookup failure or lost root proof retires confident background observation", async () => {
  let time = 10000, mode = "valid";
  const runtime = createTerminalRuntime({ now: () => time, lookup: async () => {
    if (mode === "error") throw new Error("store unavailable");
    return { status: "found", rootVerified: mode === "valid", threadRef: { id: "root" },
      ...(mode === "valid" && { nativeBackgroundActivity: { source: "kimi-task-metadata", availability: "available", active: true,
        items: [{ id: "main/agent-12345678", kind: "agent", status: "running", startedAt: 1 }] } }) };
  } });
  runtime.beginLaunch({ id: "p", provider: "kimi", cwd: process.cwd(), launchToken: 1, threadRef: { provider: "kimi", id: "root" } });
  for (const next of ["valid", "error", "valid", "unverified"]) {
    mode = next; time += 65000;
    await runtime.refresh();
    const state = runtime.getSnapshot("p");
    assert.equal(state.backgroundObservation.availability, next === "valid" ? "available" : "unavailable");
    assert.equal(state.childActivity, true, "lookup failure is not task settlement");
  }
  runtime.dispose();
});
