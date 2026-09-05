"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createOrchestrator } = require("../../backend/orchestrator.cjs");
const { serializeToolResult, listSessionSummaries } = require("../../backend/orchestratorContext.cjs");
const reply = text => ({ choices: [{ message: { content: text } }] });
const tool = args => ({ choices: [{ message: { tool_calls: [{ id: "call", type: "function", function: { name: "workspace", arguments: JSON.stringify(args) } }] } }] });
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-context-test-"));
  const state = { sessions: [{ id: "a", generation: "ga", launchToken: 1, name: "Worker A", kind: "codex", cwd: root, projectName: "Fixture" }], actions: [], requests: [], responses: [], reads: 0, now: 1000 };
  state.history = { id: "saved-b", title: "Saved B", provider: "codex", reference: "ref-b", cwd: root };
  const relay = createOrchestrator({ userDataPath: root, secureStorage: { isEncryptionAvailable: () => false }, now: () => state.now,
    getSessions: () => state.sessions, getRoots: () => ({ documents: root, projects: [{ name: "Fixture", path: root }] }),
    readSession: async () => { state.reads++; return { text: "PROVIDER_TRANSCRIPT_PRIVATE_BODY" }; },
    dispatchAction: async action => {
      state.actions.push(action);
      if (action.kind === "list_conversations") return { ok: true, conversations: [state.history] };
      return state.effect ? state.effect(action) : { ok: true, status: "acknowledged" };
    },
    fetch: async (url, options) => ({ ok: true, json: async () => {
      if (url.endsWith("/key")) return { data: {} };
      if (url.endsWith("/models")) return { data: [{ id: "fake-brain", supported_parameters: ["tools"] }] };
      state.requests.push(JSON.parse(options.body)); return state.responses.shift() || reply("Ready.");
    } }) });
  t.after(() => { relay.dispose(); assert(path.resolve(root).startsWith(path.join(os.tmpdir(), "vibe-context-test-"))); fs.rmSync(root, { recursive: true, force: true }); });
  await relay.configure({ apiKey: "fake-key", sessionOnly: true, model: "fake-brain" }); assert.equal((await relay.setEnabled(true)).ok, true);
  state.root = root; state.relay = relay;
  state.run = async (text, ...args) => { state.responses.push(...args.map(tool), reply("Acknowledged.")); return relay.send({ text, origin: "text" }); };
  state.focus = () => state.run("Focus Worker A", { kind: "focus_session", targetId: "a" });
  state.resume = () => state.run('Resume Codex conversation "Saved B"', { kind: "list_conversations" }, { kind: "resume_conversation", reference: "ref-b" });
  state.b = (generation = "gb", launchToken = 2) => ({ id: "b", name: "Worker B", generation, launchToken, kind: "codex", cwd: root });
  state.sends = () => state.actions.filter(action => action.kind === "send_prompt");
  return state;
}

test("ongoing relay switches A to resumed B and extracts omitted exact payload for it", async t => {
  const f = await fixture(t); await f.focus();
  f.effect = action => { if (action.kind === "resume_conversation") { f.sessions.push(f.b()); return { ok: true, status: "resume_requested", id: "b", launchToken: 2, target: { id: "b", generation: "gb", launchToken: 2 } }; } return { ok: true }; };
  await f.resume(); await f.run("Tell it: inspect everything; do not change files", { kind: "send_prompt" });
  assert.equal(f.sends().length, 1); assert.equal(f.sends()[0].targetId, "b"); assert.equal(f.sends()[0].text, "inspect everything; do not change files");
  assert.equal(f.sends()[0].target.generation, "gb"); assert.equal(f.reads, 0);
  const resumeAction = f.actions.find(action => action.kind === "resume_conversation"); assert.equal(resumeAction.selection.value, "Saved B");
});

test("provisional resume clears A until B native generation appears with matching launch token", async t => {
  const f = await fixture(t); await f.focus();
  f.effect = action => { if (action.kind === "resume_conversation") { f.sessions.push(f.b("paused:b:2")); return { ok: true, id: "b", launchToken: 2, target: { id: "b", generation: "paused:b:2", launchToken: 2 } }; } return { ok: true }; };
  await f.resume(); await f.run("Tell it: must wait", { kind: "send_prompt" }); assert.equal(f.sends().length, 0);
  f.sessions[1] = f.b(); await f.run("Tell it: ready now", { kind: "send_prompt" });
  assert.equal(f.sends().length, 1); assert.equal(f.sends()[0].target.generation, "gb");
});

test("failed resume clears prior A binding instead of relaying a follow-up to A", async t => {
  const f = await fixture(t); await f.focus(); f.effect = () => ({ ok: false, error: "Could not resume" });
  await f.resume(); await f.run("Tell it: this is for B", { kind: "send_prompt" }); assert.equal(f.sends().length, 0);
});

test("wrong launch token and expired provisional target never adopt B", async t => {
  for (const mode of ["wrong-token", "expired"]) {
    const f = await fixture(t); await f.focus();
    f.effect = action => action.kind === "resume_conversation" ? { ok: true, id: "b", launchToken: 2 } : { ok: true };
    await f.resume(); f.sessions.push(f.b("gb", mode === "wrong-token" ? 3 : 2)); if (mode === "expired") f.now += 20001;
    await f.run("Tell it: never send", { kind: "send_prompt" }); assert.equal(f.sends().length, 0, mode);
    f.sessions[1] = f.b(); await f.run("Tell it: still never", { kind: "send_prompt" }); assert.equal(f.sends().length, 0, mode);
  }
});

test("native resume generation mismatch at acknowledgment cannot become a provisional retarget", async t => {
  const f = await fixture(t); await f.focus();
  f.effect = action => { if (action.kind === "resume_conversation") { f.sessions.push(f.b("replacement-gb")); return { ok: true, id: "b", launchToken: 2, target: { id: "b", generation: "original-gb", launchToken: 2 } }; } return { ok: true }; };
  await f.resume(); await f.run("Tell it: do not reach replacement", { kind: "send_prompt" }); assert.equal(f.sends().length, 0);
});

test("late successful send acknowledgment after restart cannot bind the replacement session", async t => {
  const f = await fixture(t); await f.focus(); let release, entered;
  const checkpoint = new Promise(resolve => { entered = resolve; });
  f.effect = action => action.kind === "send_prompt" ? new Promise(resolve => { release = () => resolve({ ok: true, status: "written" }); entered(); }) : { ok: true };
  const sending = f.run("Tell Worker A: original task", { kind: "send_prompt" }); await checkpoint;
  f.sessions[0].generation = "replacement-ga"; await f.relay.refresh(); release(); await sending;
  f.effect = () => ({ ok: true }); await f.run("Tell it: must not follow to replacement", { kind: "send_prompt" }); assert.equal(f.sends().length, 1);
});

test("pending reported native generation only adopts that exact owner", async t => {
  const f = await fixture(t); await f.focus();
  f.effect = action => action.kind === "resume_conversation" ? { ok: true, id: "b", launchToken: 2, target: { id: "b", generation: "expected-gb", launchToken: 2 } } : { ok: true };
  await f.resume(); f.sessions.push(f.b("different-gb"));
  await f.run("Tell it: never send to replacement", { kind: "send_prompt" }); assert.equal(f.sends().length, 0);
});

test("new pane creation uses the same launch-bound follow-up selection", async t => {
  const f = await fixture(t); await f.focus();
  f.effect = action => { if (action.kind === "create_session") { f.sessions.push(f.b("paused:b:2")); return { ok: true, status: "created", id: "b", launchToken: 2 }; } return { ok: true }; };
  await f.run("Create Codex in Fixture", { kind: "create_session", kindOfSession: "codex" });
  await f.run("Tell it: wait", { kind: "send_prompt" }); assert.equal(f.sends().length, 0);
  f.sessions[1] = f.b(); await f.run("Tell it: begin", { kind: "send_prompt" }); assert.equal(f.sends()[0].targetId, "b");
});

test("initial context carries only eight recent relay messages and no native transcript body", async t => {
  const f = await fixture(t); f.sessions[0].transcript = "PROVIDER_TRANSCRIPT_PRIVATE_BODY";
  f.sessions[0].conversation = { id: "native-a", title: "Native title", body: "PROVIDER_TRANSCRIPT_PRIVATE_BODY" };
  for (let i = 0; i < 7; i++) await f.run(`Relay message ${i}`);
  const request = f.requests.at(-1), initial = JSON.parse(request.messages[1].content);
  assert.equal(initial.recentConversation.length, 8); assert.equal(initial.recentConversation[0].text, "Relay message 2");
  assert.equal(initial.sessions[0].conversationId, "native-a"); assert.equal(initial.sessions[0].conversationTitle, "Native title");
  assert.equal(JSON.stringify(request).includes("PROVIDER_TRANSCRIPT_PRIVATE_BODY"), false); assert.equal(f.reads, 0);
});

test("session directory exposes bounded initial page and model query reaches a later native title alias", async t => {
  const f = await fixture(t); f.sessions = Array.from({ length: 67 }, (_, i) => ({ id: `pane-${i}`, generation: `g-${i}`, name: `Worker ${i}`, kind: "codex", provider: "codex", aliases: i === 63 ? ["Payment review"] : [], cwd: f.root }));
  await f.run("Find Payment review", { kind: "list_sessions", query: "Payment review", limit: 10 });
  const initial = JSON.parse(f.requests[0].messages[1].content); assert.equal(initial.sessions.length, 40); assert.deepEqual(initial.sessionDirectory, { total: 67, truncated: true });
  const listing = JSON.parse(f.requests[1].messages.at(-1).content); assert.equal(listing.sessions[0].id, "pane-63"); assert.equal(listing.total, 1);
  const next = listSessionSummaries(f.sessions, { offset: 40, limit: 10 }); assert.equal(next.sessions[0].id, "pane-40"); assert.equal(next.nextOffset, 50);
});

test("escaped long result remains valid bounded JSON preserving receipt fields", () => {
  const result = serializeToolResult({ ok: true, status: "written", id: "receipt-1", text: '"'.repeat(16000) });
  assert(result.length <= 24000); const parsed = JSON.parse(result); assert.equal(parsed.ok, true); assert.equal(parsed.status, "written"); assert.equal(parsed.id, "receipt-1"); assert.equal(parsed.truncated, true);
  assert.deepEqual(JSON.parse(serializeToolResult(null)), null); assert.deepEqual(JSON.parse(serializeToolResult({})), {});
});

test("missing result serializes as null instead of throwing", () => {
  assert.equal(JSON.parse(serializeToolResult(undefined)), null);
});

test("oversize object keys cannot discard a short action receipt identity", () => {
  const result = serializeToolResult({ ok: true, status: "written", id: "receipt-1", ["x".repeat(25000)]: "large key" });
  assert(result.length <= 24000); const parsed = JSON.parse(result); assert.equal(parsed.id, "receipt-1"); assert.equal(parsed.ok, true); assert.equal(parsed.status, "written"); assert.equal(parsed.truncated, true);
});


test('context-shortened pages never retain a cursor that skips unseen identities', () => {
  const { listSessionSummaries, serializeToolResult } = require('../../backend/orchestratorContext.cjs');
  const sessions = Array.from({length:250}, (_,i)=>({id:`pane-${i}`,name:`Title ${i}`,generation:`gen-${i}`,provider:'codex',cwd:'C:/projects/'+ 'x'.repeat(150)}));
  const page = listSessionSummaries(sessions,{limit:200});
  const reduced = JSON.parse(serializeToolResult(page));
  assert(reduced.sessions.length < page.sessions.length);
  assert.equal(reduced.nextOffset,null);
  assert.equal(reduced.retrySmallerPage,true);
});


test('acknowledged resume waits for an older renderer launch token to advance', async t => {
  const f = await fixture(t); await f.focus(); f.sessions.push(f.b('old-b',1));
  f.effect = action => action.kind === 'resume_conversation' ? {ok:true,id:'b',launchToken:2,status:'resume_requested'} : {ok:true};
  await f.resume();
  f.sessions[1]=f.b('new-b',2); await f.relay.refresh();
  await f.run('Tell it: continue', {kind:'send_prompt'});
  assert.equal(f.sends().length,1);assert.equal(f.sends()[0].target.id,'b');assert.equal(f.sends()[0].target.generation,'new-b');
});
