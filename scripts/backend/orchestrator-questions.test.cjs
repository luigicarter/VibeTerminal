const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeQuestions, pendingDecisionFor, buildDecisionResult } = require("../../backend/fusion-adapter.cjs");
const { observeInteractionEvent, claimInteraction, chatEventEnvelope, isCurrentChatState } = require("../../backend/fusionChatHost.cjs");
const method = "item/tool/requestUserInput";
const params = { questions: [
  { id: "scope", header: "Scope", question: "Which scope?", options: [{ label: "Small", description: "One file" }] },
  { id: "tests", question: "Which tests?", options: [{ label: "Unit" }, { label: "Smoke" }], multiple: true }
] };
test("Fusion pending payload retains distinct IDs, options, and descriptions", () => {
  const result = pendingDecisionFor("p1", { method, params });
  assert.deepEqual(result.questions, normalizeQuestions(params));
  assert.equal(result.questions[0].options[0].description, "One file");
  assert.equal(result.questions[1].multiple, true);
});
test("Fusion maps independent answers without repeating note", () => {
  assert.deepEqual(buildDecisionResult(method, params, "accept", "ignored", { scope: ["Small"], tests: ["Unit", "Smoke"] }), {
    answers: { scope: { answers: ["Small"] }, tests: { answers: ["Unit", "Smoke"] } }
  });
  assert.throws(() => buildDecisionResult(method, params, "accept", "same answer"), /distinct answer/);
  assert.throws(() => buildDecisionResult(method, params, "accept", "", { scope: ["Small"] }), /tests/);
  assert.deepEqual(buildDecisionResult(method, { questions: [params.questions[0]] }, "accept", "Custom"), { answers: { scope: { answers: ["Custom"] } } });
});
test("Approval gates retain their original enums and never use question answers", () => {
  assert.deepEqual(buildDecisionResult("execCommandApproval", {}, "decline"), { decision: "denied" });
  assert.deepEqual(buildDecisionResult("item/permissions/requestApproval", { permissions: { network: true } }, "decline"), { permissions: {}, scope: "turn" });
});
test("Retained requests deduplicate replay and atomically reject racing/stale answers", () => {
  const state = { child: {}, generation: "launch-a" };
  const events = [];
  const emit = e => events.push(e);
  const question = { type: "question", requestId: "q1", questions: normalizeQuestions(params) };
  observeInteractionEvent("pane", state, question, emit);
  observeInteractionEvent("pane", state, question, emit);
  assert.equal(events.length, 1);
  assert.equal(events[0].interaction.generation, "launch-a");
  assert.throws(() => claimInteraction(state, { requestId: "q1", generation: "launch-b" }, "question"), /Stale/);
  claimInteraction(state, { requestId: "q1", generation: "launch-a" }, "question");
  assert.throws(() => claimInteraction(state, { requestId: "q1" }, "question"), /in flight/);
  observeInteractionEvent("pane", state, { type: "question-resolved", requestId: "q1" }, emit);
  assert.equal(events[1].type, "interaction-resolved");
  observeInteractionEvent("pane", state, question, emit);
  assert.equal(state.interactions.size, 0, "Late duplicate request must not resurrect an answered question");
  assert.throws(() => claimInteraction(state, { requestId: "q1" }, "question"), /no longer pending/);
});
test("Fusion tool results enter retained registry and closure invalidates them", () => {
  const state = { child: {}, launchPayload: { generation: "launch-c" } }; const events = [];
  observeInteractionEvent("pane", state, { type: "tool-result", text: JSON.stringify({ status: "needs_decision", ...pendingDecisionFor("p1", { method, params }) }) }, e => events.push(e));
  assert.equal(state.interactions.get("p1").questions[1].id, "tests");
  observeInteractionEvent("pane", state, { type: "closed" }, e => events.push(e));
  assert.equal(state.interactions.size, 0);
  assert.equal(events[1].status, "cancelled");
});

for (const host of ["fusionChatHost", "openFusionChatHost"]) test(`${host} acknowledges invalid input, interrupt and answer commands without engine calls`, async () => {
  const { spawn } = require("node:child_process");
  const path = require("node:path");
  const child = spawn(process.execPath, [path.join(__dirname, "../../backend", `${host}.cjs`)], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  try {
    const results = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Missing host action acknowledgments")), 5000);
      const messages = [];
      const normalEvents = [];
      let buffer = "";
      child.on("error", error => { clearTimeout(timer); reject(error); });
      child.stdout.on("data", chunk => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const event = JSON.parse(line);
          if (event.type === "action-result") messages.push(event);
          if (event.type === "event") normalEvents.push(event);
          if (messages.length === 3 && normalEvents.length) { clearTimeout(timer); resolve({ messages, normalEvents }); }
        }
      });
      child.stdin.write(JSON.stringify({ type: "input", payload: { id: "missing-pane", generation: "origin-generation", text: "hello" } }) + "\n");
      for (const [index, type] of ["input", "interrupt", host === "fusionChatHost" ? "answer-question" : "question"].entries()) {
        child.stdin.write(JSON.stringify({ type, payload: { id: "missing-pane", generation: "g1", actionId: `a${index}`, requestId: "q1", text: "hello", answers: [] } }) + "\n");
      }
    });
    assert.equal(results.messages.length, 3);
    assert.ok(results.messages.every(result => result.ok === false && result.status === "failed" && typeof result.error === "string"));
    assert.equal(results.normalEvents[0].generation, "origin-generation");
    assert.equal(results.normalEvents[0].event.type, "error");
  } finally { child.stdin.end(JSON.stringify({ type: "shutdown" }) + "\n"); child.kill(); }
});

test("Live, closed and replay envelopes retain their origin generation across same-ID restart", () => {
  for (const oldState of [{ generation: "old-open" }, { launchPayload: { generation: "old-fusion" } }]) {
    const expected = oldState.generation || oldState.launchPayload.generation;
    const current = { generation: "new-launch", history: [] };
    const sessions = new Map([["pane", current]]);
    assert.equal(isCurrentChatState(sessions, "pane", oldState), false);
    assert.equal(isCurrentChatState(sessions, "pane", current), true);
    for (const event of [{ type: "assistant-text", text: "old delta" }, { type: "closed", code: 0 }, { type: "tool-result", text: "old replay", replay: true }]) {
      const envelope = chatEventEnvelope("pane", oldState, event);
      assert.equal(envelope.generation, expected);
      assert.notEqual(envelope.generation, current.generation);
      assert.equal(envelope.event, event);
      if (isCurrentChatState(sessions, "pane", oldState)) current.history.push(envelope);
    }
    assert.deepEqual(current.history, [], "Old launch callbacks cannot mutate the replacement transcript");
  }
});

const { updateQuestionProgress, validateQuestionPrefix } = require("../../backend/openFusionChatHost.cjs");
test("Native question progress shares completed mouse/voice answers and reserves final submission", () => {
  const interaction = { id: "q", kind: "question", revision: 1, questions: normalizeQuestions(params) };
  const state = { child: {}, generation: "generation-1", interactions: new Map([["q", interaction]]) };
  const payload = { requestId: "q", generation: "generation-1", revision: 1, answers: [["Small"]] };
  const result = updateQuestionProgress(state, payload);
  assert.equal(result.changed, true);
  assert.equal(result.interaction.revision, 2);
  assert.deepEqual(result.interaction.partialAnswers, [["Small"]]);
  payload.answers[0][0] = "mutated caller";
  assert.deepEqual(interaction.partialAnswers, [["Small"]], "Retained progress owns a copy");
  assert.throws(() => updateQuestionProgress(state, { ...payload, answers: [["Small"]] }), /Stale question revision/);
  assert.equal(updateQuestionProgress(state, { ...payload, revision: 2, answers: [["Small"]] }).changed, false);
  assert.throws(() => updateQuestionProgress(state, { ...payload, revision: 2, answers: [["Other"]] }), /progress changed/);
  assert.throws(() => updateQuestionProgress(state, { ...payload, revision: 2, generation: "old" }), /Stale session/);
  const voiceAnswers = [...interaction.partialAnswers, ["Unit", "Smoke"]];
  assert.doesNotThrow(() => validateQuestionPrefix(interaction, voiceAnswers, true));
  assert.throws(() => validateQuestionPrefix(interaction, [["Other"], ["Unit"]], true), /progress changed/);
  claimInteraction(state, { requestId: "q", generation: "generation-1" }, "question");
  assert.throws(() => updateQuestionProgress(state, { ...payload, revision: 2, answers: [["Small"]] }), /in flight/);
});
test("Native progress validates option constraints and cannot prematurely finish a request", () => {
  const interaction = { id: "q", kind: "question", revision: 1, questions: [{ question: "Pick", options: [{ label: "A" }], custom: false }, { question: "Next", options: [] }] };
  const state = { child: {}, generation: "g", interactions: new Map([["q", interaction]]) };
  assert.throws(() => updateQuestionProgress(state, { requestId: "q", generation: "g", answers: [["B"]] }), /listed option/);
  assert.throws(() => updateQuestionProgress(state, { requestId: "q", generation: "g", answers: [["A", "A"]] }), /one answer/);
  assert.throws(() => updateQuestionProgress(state, { requestId: "q", generation: "g", answers: [["A"], ["Done"]] }), /prefix/);
  assert.equal(interaction.revision, 1);
  assert.equal(interaction.partialAnswers, undefined);
});
