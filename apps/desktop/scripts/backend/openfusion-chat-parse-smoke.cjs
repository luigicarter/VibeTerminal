// Open Fusion chat SSE normalizer smoke test.
//
// Feeds backend/openFusionChatHost.cjs's createOpenCodeEventNormalizer a
// recorded `opencode serve` /event sequence (session busy → planner deltas +
// snapshots → a task delegation spawning an executor child session → child
// output → tool completion → idle) and asserts it produces the right
// high-level chat events. Shapes verified against the OpenCode 1.17.11 source:
// message.part.delta carries field:"text" for BOTH text and reasoning parts
// (field is the part property being appended), part snapshots precede first
// deltas, and finished parts snapshot with time.end. No OpenCode, no auth, no
// cost — this guards the parsing the OpenFusionChatPane renders.

const {
  createOpenCodeEventNormalizer,
  rehydrateMessages,
  buildServeSpawn,
  normalizeAuthMethods,
  splitModelId,
  buildPlannerTurnParts,
  buildExecutorSteerParts,
  buildExecutorSteerPromptRequest,
  buildPlannerPromptRequest,
  buildOpenFusionSteerDecisionPrompt,
  parseOpenFusionSteerDecision,
  buildOpenFusionReplanPrompt,
  shouldRouteOpenFusionSteer,
  summarizeOpenFusionExecutorActivity,
  extractOpenFusionAssistantTexts,
  openFusionExecutorSnapshot,
  selectOpenFusionExecutorTask,
  OPEN_FUSION_EXECUTOR_STEER_PREFIX,
  OPEN_FUSION_GATE_MARKER,
  OPEN_FUSION_GATE_REMINDER,
  OPEN_FUSION_GATE_NUDGE,
  OPEN_FUSION_PLAN_REMINDER,
  OPEN_FUSION_BACKGROUND_MARKER,
  backgroundTaskTitleOf,
  buildOpenFusionBackgroundContract,
  buildOpenFusionBackgroundWakeText,
  parseOpenFusionBackgroundReport
} = require("../../backend/openFusionChatHost.cjs");
const { createOpenFusionGateTracker } = require("../../backend/completionGate.cjs");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const ROOT = "ses_root";
const CHILD = "ses_child";

const fixture = [
  { type: "server.connected", properties: {} },
  // Noise the normalizer must drop silently.
  { type: "catalog.updated", properties: {} },
  { type: "plugin.added", properties: {} },
  { type: "session.status", properties: { sessionID: "ses_other", status: { type: "busy" } } },
  // Turn start.
  { type: "session.status", properties: { sessionID: ROOT, status: { type: "busy" } } },
  { type: "session.status", properties: { sessionID: ROOT, status: { type: "busy" } } },
  // User message echo must NOT stream as assistant text.
  {
    type: "message.updated",
    properties: {
      sessionID: ROOT,
      info: { id: "msg_user", role: "user", sessionID: ROOT, agent: "planner" }
    }
  },
  {
    type: "message.part.updated",
    properties: {
      sessionID: ROOT,
      part: { id: "prt_user", messageID: "msg_user", sessionID: ROOT, type: "text", text: "do the thing" }
    }
  },
  // Assistant message streams deltas, then full-text snapshots (dedup check).
  // Wire shape per OpenCode 1.17.11: text-start/reasoning-start emit a part
  // snapshot BEFORE the first delta, and ALL deltas carry field:"text" — field
  // names the part property being appended, so reasoning deltas are told apart
  // only by the part's registered type. Finished parts snapshot with time.end.
  {
    type: "message.updated",
    properties: {
      sessionID: ROOT,
      info: { id: "msg_a1", role: "assistant", sessionID: ROOT, agent: "planner" }
    }
  },
  // Delta for a part whose type is not yet known (mid-stream attach): must be
  // DROPPED without advancing the cursor — the snapshot below re-delivers it.
  {
    type: "message.part.delta",
    properties: { sessionID: ROOT, messageID: "msg_a1", partID: "prt_t1", field: "text", delta: "plan" }
  },
  {
    type: "message.part.updated",
    properties: {
      sessionID: ROOT,
      part: { id: "prt_t1", messageID: "msg_a1", sessionID: ROOT, type: "reasoning", text: "plan", time: { start: 1 } }
    }
  },
  // Reasoning delta arrives with field:"text" — must surface as thinking.
  {
    type: "message.part.delta",
    properties: { sessionID: ROOT, messageID: "msg_a1", partID: "prt_t1", field: "text", delta: " it" }
  },
  {
    type: "message.part.updated",
    properties: {
      sessionID: ROOT,
      part: { id: "prt_t1", messageID: "msg_a1", sessionID: ROOT, type: "reasoning", text: "plan it", time: { start: 1, end: 2 } }
    }
  },
  // A repeated end snapshot must not double-emit stream-end.
  {
    type: "message.part.updated",
    properties: {
      sessionID: ROOT,
      part: { id: "prt_t1", messageID: "msg_a1", sessionID: ROOT, type: "reasoning", text: "plan it", time: { start: 1, end: 2 } }
    }
  },
  // Stragglers AFTER the end snapshot (bus reordering): both the delta and a
  // longer late snapshot must be dropped — emitting them would reopen a pane
  // bubble whose caret nothing retires, since stream-end is once-per-part.
  {
    type: "message.part.delta",
    properties: { sessionID: ROOT, messageID: "msg_a1", partID: "prt_t1", field: "text", delta: " straggler" }
  },
  {
    type: "message.part.updated",
    properties: {
      sessionID: ROOT,
      part: { id: "prt_t1", messageID: "msg_a1", sessionID: ROOT, type: "reasoning", text: "plan it straggler", time: { start: 1, end: 2 } }
    }
  },
  {
    type: "message.part.updated",
    properties: {
      sessionID: ROOT,
      part: { id: "prt_t2", messageID: "msg_a1", sessionID: ROOT, type: "text", text: "", time: { start: 3 } }
    }
  },
  {
    type: "message.part.delta",
    properties: { sessionID: ROOT, messageID: "msg_a1", partID: "prt_t2", field: "text", delta: "Delegating " }
  },
  {
    type: "message.part.delta",
    properties: { sessionID: ROOT, messageID: "msg_a1", partID: "prt_t2", field: "text", delta: "now." }
  },
  {
    type: "message.part.updated",
    properties: {
      sessionID: ROOT,
      part: { id: "prt_t2", messageID: "msg_a1", sessionID: ROOT, type: "text", text: "Delegating now. Done.", time: { start: 3, end: 5 } }
    }
  },
  // Task tool: pending → running (registers the child session) → completed.
  {
    type: "message.part.updated",
    properties: {
      sessionID: ROOT,
      part: {
        id: "prt_tool",
        messageID: "msg_a1",
        sessionID: ROOT,
        type: "tool",
        tool: "task",
        callID: "task_1",
        state: {
          status: "pending",
          input: { description: "Compute", prompt: "compute it", subagent_type: "executor" }
        }
      }
    }
  },
  {
    type: "message.part.updated",
    properties: {
      sessionID: ROOT,
      part: {
        id: "prt_tool",
        messageID: "msg_a1",
        sessionID: ROOT,
        type: "tool",
        tool: "task",
        callID: "task_1",
        state: {
          status: "running",
          title: "Compute",
          input: { description: "Compute", prompt: "compute it", subagent_type: "executor" },
          metadata: { parentSessionId: ROOT, sessionId: CHILD }
        }
      }
    }
  },
  {
    type: "session.created",
    properties: {
      sessionID: CHILD,
      info: { id: CHILD, parentID: ROOT, agent: "executor", title: "Compute (@executor subagent)" }
    }
  },
  // Executor child streams its own assistant text on the SAME feed.
  {
    type: "message.updated",
    properties: {
      sessionID: CHILD,
      info: { id: "msg_c1", role: "assistant", sessionID: CHILD, agent: "executor" }
    }
  },
  {
    type: "message.part.updated",
    properties: {
      sessionID: CHILD,
      part: { id: "prt_c1", messageID: "msg_c1", sessionID: CHILD, type: "text", text: "", time: { start: 6 } }
    }
  },
  {
    type: "message.part.delta",
    properties: { sessionID: CHILD, messageID: "msg_c1", partID: "prt_c1", field: "text", delta: "391" }
  },
  {
    type: "message.part.updated",
    properties: {
      sessionID: CHILD,
      part: { id: "prt_c1", messageID: "msg_c1", sessionID: CHILD, type: "text", text: "391", time: { start: 6, end: 7 } }
    }
  },
  // Executor runs a tool of its own.
  {
    type: "message.part.updated",
    properties: {
      sessionID: CHILD,
      part: {
        id: "prt_cbash",
        messageID: "msg_c1",
        sessionID: CHILD,
        type: "tool",
        tool: "bash",
        callID: "bash_1",
        state: { status: "completed", input: { command: "echo 391" }, output: "391" }
      }
    }
  },
  // Executor edits a file — the completion-gate tracker accumulates this path.
  {
    type: "message.part.updated",
    properties: {
      sessionID: CHILD,
      part: {
        id: "prt_cedit",
        messageID: "msg_c1",
        sessionID: CHILD,
        type: "tool",
        tool: "edit",
        callID: "edit_1",
        state: {
          status: "completed",
          input: { filePath: "C:\\repo\\src\\thing.ts", oldString: "a", newString: "b" },
          output: "edited",
          metadata: { diff: "-a\n+b" }
        }
      }
    }
  },
  { type: "session.idle", properties: { sessionID: CHILD } },
  // Delegation completes back on the root.
  {
    type: "message.part.updated",
    properties: {
      sessionID: ROOT,
      part: {
        id: "prt_tool",
        messageID: "msg_a1",
        sessionID: ROOT,
        type: "tool",
        tool: "task",
        callID: "task_1",
        state: {
          status: "completed",
          title: "Compute",
          input: { description: "Compute", prompt: "compute it", subagent_type: "executor" },
          output: '<task id="ses_child" state="completed">\n<task_result>\nThe answer is 391.\n</task_result>\n</task>',
          metadata: { parentSessionId: ROOT, sessionId: CHILD }
        }
      }
    }
  },
  // Token accounting arrives via step-finish.
  {
    type: "message.part.updated",
    properties: {
      sessionID: ROOT,
      part: {
        id: "prt_sf",
        messageID: "msg_a1",
        sessionID: ROOT,
        type: "step-finish",
        tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 0, write: 0 } },
        cost: 0.01
      }
    }
  },
  // Permission round-trip.
  {
    type: "permission.asked",
    properties: { id: "perm_1", sessionID: CHILD, permission: "read", patterns: ["*.env"] }
  },
  { type: "permission.replied", properties: { sessionID: CHILD, requestID: "perm_1", reply: "once" } },
  // Question round-trip (V1 vocabulary: shape from the 1.17.13 source,
  // string-confirmed in the 1.17.11 binary — payload IS the Request object:
  // { id: "que_…", sessionID, questions: Info[], tool? }).
  {
    type: "question.asked",
    properties: {
      id: "que_1",
      sessionID: ROOT,
      questions: [
        {
          question: "Which database should the migration target?",
          header: "Database",
          options: [
            { label: "PostgreSQL", description: "the prod default" },
            { label: "SQLite", description: "local dev" }
          ]
        },
        {
          question: "Which environments apply?",
          header: "Environments",
          options: [
            { label: "staging", description: "" },
            { label: "prod", description: "" }
          ],
          multiple: true,
          custom: false
        }
      ]
    }
  },
  // A question from an unrelated session must be dropped.
  {
    type: "question.asked",
    properties: {
      id: "que_foreign",
      sessionID: "ses_other",
      questions: [{ question: "leak?", header: "leak", options: [] }]
    }
  },
  { type: "question.replied", properties: { sessionID: ROOT, requestID: "que_1", answers: [["PostgreSQL"], ["staging", "prod"]] } },
  // Server-side compaction marker (manual /compact and auto-compaction emit
  // the same event); a child-session compaction must not surface.
  { type: "session.compacted", properties: { sessionID: ROOT } },
  { type: "session.compacted", properties: { sessionID: CHILD } },
  // Turn end; a second idle must not double-emit.
  { type: "session.idle", properties: { sessionID: ROOT } },
  { type: "session.idle", properties: { sessionID: ROOT } },
  // Post-turn assistant message traffic (e.g. title generation) must not emit
  // a stray step-start — the absorption signal is busy-turn-only.
  {
    type: "message.updated",
    properties: {
      sessionID: ROOT,
      info: { id: "msg_post", role: "assistant", sessionID: ROOT, agent: "planner" }
    }
  },
  // Aborts surface as session.error but must not reach the error lane.
  {
    type: "session.error",
    properties: { sessionID: ROOT, error: { name: "MessageAbortedError", data: { message: "aborted" } } }
  },
  {
    type: "session.error",
    properties: { sessionID: ROOT, error: { name: "UnknownError", data: { message: "Model not found: x/y" } } }
  }
];

const normalize = createOpenCodeEventNormalizer(ROOT);
const events = [];
for (const raw of fixture) {
  events.push(...normalize(raw));
}

const byType = (type) => events.filter((event) => event.type === type);

// Exactly one turn-start despite repeated busy events.
assert(byType("turn-start").length === 1, "expected exactly one turn-start");

// Exactly one step-start: the NEW root assistant message (msg_a1). The user
// message and the child session's assistant message must not emit one — it is
// the queued-steering absorption signal, root-only by design.
assert(byType("step-start").length === 1, "expected exactly one step-start for the root assistant message");

// Every streamed event carries the producing part's streamId so concurrent
// parts (parallel subagents, reasoning beside text) never share a bubble.
const streamed = [...byType("assistant-text"), ...byType("thinking")];
assert(
  streamed.every((event) => typeof event.streamId === "string" && event.streamId.includes(":")),
  "streamed events must carry a sessionID:partID streamId"
);
assert(
  new Set(streamed.map((event) => event.streamId)).size === 3 &&
    streamed.some((event) => event.streamId === `${ROOT}:prt_t2`) &&
    streamed.some((event) => event.streamId === `${CHILD}:prt_c1`),
  "root text, root reasoning, and child text must stream under distinct streamIds"
);

// Brain text streams and dedupes: deltas + snapshot suffix, never repeated text.
const brainText = byType("assistant-text")
  .filter((event) => event.role === "brain")
  .map((event) => event.delta)
  .join("");
assert(
  brainText === "Delegating now. Done.",
  `brain text should join deltas + snapshot suffix exactly once, got: ${JSON.stringify(brainText)}`
);
// Reasoning parts stream with field:"text" on the wire — the part's registered
// type must route them to thinking, never assistant-text, and the pre-snapshot
// delta ("plan") must not double-count (dropped, then re-delivered by snapshot).
const thinking = byType("thinking");
assert(
  thinking.length > 0 && thinking.every((event) => event.role === "brain"),
  "reasoning deltas should surface as brain thinking"
);
assert(
  thinking.map((event) => event.delta).join("") === "plan it",
  `reasoning should join to "plan it" exactly once, got: ${JSON.stringify(thinking.map((e) => e.delta).join(""))}`
);
assert(
  !byType("assistant-text").some((event) => event.streamId === `${ROOT}:prt_t1`),
  "reasoning content must never surface as assistant-text"
);

// Finished parts (snapshot with time.end) emit stream-end exactly once each,
// so the pane can retire that bubble's caret mid-turn.
const streamEnds = byType("stream-end");
assert(
  streamEnds.length === 3 &&
    streamEnds.filter((event) => event.streamId === `${ROOT}:prt_t1`).length === 1 &&
    streamEnds.filter((event) => event.streamId === `${ROOT}:prt_t2`).length === 1 &&
    streamEnds.filter((event) => event.streamId === `${CHILD}:prt_c1`).length === 1,
  `each finished part should emit exactly one stream-end (repeat end snapshots are idempotent), got: ${JSON.stringify(streamEnds.map((e) => e.streamId))}`
);

// The user echo must not leak into assistant text.
assert(!brainText.includes("do the thing"), "user message text must not stream as assistant text");

// Executor child session streams with the executor role.
const executorText = byType("assistant-text").filter((event) => event.role === "executor");
assert(
  executorText.length === 1 && executorText[0].delta === "391",
  "executor child session text should stream with role executor"
);

// Task tool call + completion; executor bash call + result carry the child role.
const toolCalls = byType("tool-call");
const toolResults = byType("tool-result");
const taskChildEvents = byType("task-child");
assert(
  toolCalls.some((event) => event.name === "task" && event.role === "brain"),
  "the task delegation should emit a brain tool-call"
);
assert(
  toolCalls.filter((event) => event.name === "task").length === 1,
  "pending → running must emit only one task tool-call"
);
assert(
  taskChildEvents.some(
    (event) =>
      event.name === "task" &&
      event.role === "brain" &&
      event.childSessionId === CHILD &&
      event.agent === "executor"
  ),
  "pending → running should surface the task child session for live executor steering without duplicating the tool row"
);
assert(
  toolResults.some(
    (event) =>
      event.name === "task" &&
      event.ok === true &&
      event.text.includes("The answer is 391.")
  ),
  "the task completion should emit a brain tool-result with the executor report"
);
assert(
  toolCalls.some((event) => event.name === "bash" && event.role === "executor") &&
    toolResults.some((event) => event.name === "bash" && event.role === "executor"),
  "executor tool activity should surface with role executor"
);
// Completion-gate plumbing: tool events carry their producing session, and a
// settled task result links to the child session whose edits were accumulated.
assert(
  toolCalls.some((event) => event.name === "edit" && event.role === "executor" && event.sessionID === CHILD) &&
    toolResults.some((event) => event.name === "edit" && event.sessionID === CHILD),
  "executor edit tool events should carry the child sessionID"
);
assert(
  toolResults.some((event) => event.name === "task" && event.childSessionId === CHILD),
  "the task tool-result should carry childSessionId for changed-file lookup"
);

// Permission round-trip.
const permissions = byType("permission");
assert(
  permissions.length === 1 &&
    permissions[0].requestId === "perm_1" &&
    permissions[0].role === "executor" &&
    permissions[0].patterns.includes("*.env"),
  "permission.asked should normalize with the asking role"
);
assert(
  byType("permission-resolved").length === 1 &&
    byType("permission-resolved")[0].reply === "once",
  "permission.replied should normalize to permission-resolved"
);

// Question round-trip: multi-question requests keep their array shape, the
// requestId is the event's `id`, and options/multiple/custom survive
// normalization (custom defaults to true when absent).
const questions = byType("question");
assert(
  questions.length === 1 && questions[0].requestId === "que_1",
  "question.asked should normalize once with the event id as requestId (foreign sessions dropped)"
);
assert(
  questions[0].questions.length === 2 &&
    questions[0].questions[0].options[0].label === "PostgreSQL" &&
    questions[0].questions[0].custom === true &&
    questions[0].questions[1].multiple === true &&
    questions[0].questions[1].custom === false &&
    questions[0].role === "brain",
  "question payload should carry all questions with options, multiple, and defaulted custom"
);
assert(
  byType("question-resolved").length === 1 &&
    byType("question-resolved")[0].requestId === "que_1",
  "question.replied should normalize to question-resolved"
);

// Compaction marker: root-only.
assert(
  byType("compacted").length === 1,
  "session.compacted should surface exactly once (root session only)"
);

// Exactly one result carrying the step-finish token totals.
const results = byType("result");
assert(results.length === 1, "expected exactly one result for one turn");
assert(
  results[0].tokens.input === 100 && results[0].tokens.output === 20,
  "result should aggregate step-finish tokens"
);

// Abort-flavored session.error is swallowed; real errors surface.
const errors = byType("error");
assert(errors.length === 1, `aborts must not reach the error lane (got ${errors.length} errors)`);
assert(errors[0].message.includes("Model not found"), "real session errors should surface");

// Foreign-session events never leak.
assert(
  !events.some((event) => JSON.stringify(event).includes("ses_other")),
  "events from foreign sessions must be dropped"
);

// ---- completion-gate tracker over the real fixture stream ----
// The fixture's turn is the canonical UNVERIFIED case: the executor task
// returns (child edited src/thing.ts) and the turn settles with no planner
// evidence action — the tracker must annotate the settle and arm the nudge.
{
  const gate = createOpenFusionGateTracker({ cwd: "C:\\repo" });
  const observed = events.map((event) => gate.observe(event));
  const settles = observed.filter((event) => event.type === "result");
  assert(settles.length === 1, "fixture should settle exactly once");
  assert(
    settles[0].gate && settles[0].gate.status === "unverified",
    "an executor return with no planner evidence must settle unverified"
  );
  const state = gate.getState();
  assert(
    state.latchOpen &&
      state.nudgePending &&
      state.changedFiles.length === 1 &&
      state.changedFiles[0].endsWith("src/thing.ts"),
    "the latch should stay open carrying the executor's changed file"
  );
  // Second turn: the planner runs allowlisted git evidence, then settles.
  const secondTurn = [];
  for (const raw of [
    { type: "session.status", properties: { sessionID: ROOT, status: { type: "busy" } } },
    {
      type: "message.part.updated",
      properties: {
        sessionID: ROOT,
        part: {
          id: "prt_gitbash",
          messageID: "msg_a2",
          sessionID: ROOT,
          type: "tool",
          tool: "bash",
          callID: "bash_git",
          state: { status: "completed", input: { command: "git diff --stat" }, output: "1 file changed" }
        }
      }
    },
    { type: "session.idle", properties: { sessionID: ROOT } }
  ]) {
    for (const event of normalize(raw)) secondTurn.push(gate.observe(event));
  }
  const verified = secondTurn.find((event) => event.type === "result");
  assert(
    verified && verified.gate && verified.gate.status === "verified" && verified.gate.evidence[0] === "git diff",
    "planner git evidence must verify the pending delegation with the git label"
  );
  assert(
    !gate.getState().latchOpen && !gate.getState().nudgePending && gate.consumeNudge() === false,
    "verification closes the latch and disarms the un-consumed nudge"
  );
}

// ---- buildPlannerTurnParts ----
// Every Brain turn carries the user's text plus the marked standing gate
// reminder as a SEPARATE part (so rehydration can drop it wholesale).
const turnParts = buildPlannerTurnParts("fix the bug");
assert(
  Array.isArray(turnParts) &&
    turnParts.length === 2 &&
    turnParts[0].type === "text" &&
    turnParts[0].text === "fix the bug" &&
    turnParts[1].type === "text" &&
    turnParts[1].text === OPEN_FUSION_GATE_REMINDER &&
    turnParts[1].text.startsWith(OPEN_FUSION_GATE_MARKER),
  "buildPlannerTurnParts should append the marked gate reminder as a separate part"
);
const steerParts = buildExecutorSteerParts("change course");
assert(
  Array.isArray(steerParts) &&
    steerParts.length === 1 &&
    steerParts[0].type === "text" &&
    steerParts[0].text === `${OPEN_FUSION_EXECUTOR_STEER_PREFIX}change course` &&
    !steerParts[0].text.startsWith(OPEN_FUSION_GATE_MARKER),
  "buildExecutorSteerParts should create a live executor steering prompt without using the gate marker"
);
const steerRequest = buildExecutorSteerPromptRequest("ses child/1", "openai/gpt-5.1-codex", "change course");
assert(
  steerRequest &&
    steerRequest.path === "/session/ses%20child%2F1/prompt_async" &&
    steerRequest.body.agent === "executor" &&
    steerRequest.body.model.providerID === "openai" &&
    steerRequest.body.model.modelID === "gpt-5.1-codex" &&
    steerRequest.body.parts[0].text === `${OPEN_FUSION_EXECUTOR_STEER_PREFIX}change course`,
  "buildExecutorSteerPromptRequest should target the active child session with executor model and steering parts"
);
assert(
  buildExecutorSteerPromptRequest("", "openai/gpt-5.1-codex", "change") === null &&
    buildExecutorSteerPromptRequest("ses_child", "", "change") === null &&
    buildExecutorSteerPromptRequest("ses_child", "openai/gpt-5.1-codex", "  ") === null,
  "buildExecutorSteerPromptRequest should fail closed without child session, model, or steering text"
);
const routeState = {
  activeExecutorTasks: new Map([
    [
      CHILD,
      {
        childSessionId: CHILD,
        taskPrompt: "implement the backend route",
        activity: ["tool read: backend/openFusionChatHost.cjs"],
        startedAt: 1
      }
    ],
    [
      "ses_child_two",
      {
        childSessionId: "ses_child_two",
        taskPrompt: "update the frontend task row",
        activity: ["tool read: frontend/components/OpenFusionChatPane.tsx"],
        startedAt: 2
      }
    ]
  ])
};
assert(
  shouldRouteOpenFusionSteer(routeState, "tighten this") === true &&
    shouldRouteOpenFusionSteer({ activeExecutorTasks: new Map() }, "tighten this") === false &&
    shouldRouteOpenFusionSteer(routeState, "   ") === false,
  "Open Fusion steering should route only when a non-empty steer lands during an active executor task"
);
const routeSnapshot = openFusionExecutorSnapshot(routeState);
assert(
  routeSnapshot.childSessionId === "ses_child_two" &&
    routeSnapshot.activeTasks.length === 2 &&
    routeSnapshot.activeTasks.some((task) => task.childSessionId === CHILD) &&
    selectOpenFusionExecutorTask(routeState, CHILD)?.childSessionId === CHILD &&
    selectOpenFusionExecutorTask(routeState, "missing")?.childSessionId === "ses_child_two",
  "Open Fusion steering snapshots should list every active child and target an explicit child before falling back to the newest active task"
);
const decisionPrompt = buildOpenFusionSteerDecisionPrompt("tighten this", routeSnapshot);
assert(
  decisionPrompt.includes('"childSessionId":"active child session id or empty"') &&
    decisionPrompt.includes("implement the backend route") &&
    decisionPrompt.includes("update the frontend task row") &&
    decisionPrompt.includes("ses_child_two") &&
    decisionPrompt.includes("tool read: backend/openFusionChatHost.cjs") &&
    decisionPrompt.includes("tighten this"),
  "steer decision prompt should include strict action schema, every active task, executor activity, and user steer"
);
const fencedDecision = parseOpenFusionSteerDecision(
  '```json\n{"action":"replan","childSessionId":"ses_child_two","text":"redo task","reason":"scope changed"}\n```',
  "fallback steer"
);
const noisyDecision = parseOpenFusionSteerDecision(
  'Planner note {"action":"ignore","text":"","reason":"already handled"} trailing',
  "fallback steer"
);
const garbageDecision = parseOpenFusionSteerDecision("not json", "fallback steer");
assert(
  fencedDecision.action === "replan" &&
    fencedDecision.childSessionId === "ses_child_two" &&
    fencedDecision.text === "redo task" &&
    noisyDecision.action === "ignore" &&
    noisyDecision.text === "fallback steer" &&
    garbageDecision.action === "inject" &&
    garbageDecision.text === "fallback steer" &&
    garbageDecision.fallback === true,
  "steer decision parser should handle fenced/noisy JSON and fall back to inject on garbage"
);
assert(
  summarizeOpenFusionExecutorActivity({
    type: "tool-call",
    name: "read",
    input: { path: "backend/openFusionChatHost.cjs" }
  }).includes("backend/openFusionChatHost.cjs") &&
    summarizeOpenFusionExecutorActivity({ type: "assistant-text", delta: "working on the route" }).includes("working on the route"),
  "executor activity summarizer should capture tool details and assistant snippets"
);
assert(
  extractOpenFusionAssistantTexts([
    { info: { role: "user" }, parts: [{ type: "text", text: "hidden user" }] },
    { info: { role: "assistant" }, parts: [{ type: "text", text: "decision text" }] }
  ])[0] === "decision text",
  "router assistant extraction should ignore user messages and return assistant text"
);
const plannerPrompt = buildPlannerPromptRequest("ses_root", "openrouter/google/gemini-3-pro", "amended task", "auto");
assert(
  plannerPrompt &&
    plannerPrompt.path === "/session/ses_root/prompt_async" &&
    plannerPrompt.body.agent === "planner" &&
    plannerPrompt.body.model.providerID === "openrouter" &&
    plannerPrompt.body.model.modelID === "google/gemini-3-pro",
  "planner prompt request should target the root session with the selected planner model"
);
const replanPrompt = buildOpenFusionReplanPrompt("stop doing x", "do y instead", openFusionExecutorSnapshot(routeState));
assert(
  replanPrompt.includes("OPEN FUSION STEERING REPLAN") &&
    replanPrompt.includes("stop doing x") &&
    replanPrompt.includes("do y instead") &&
    replanPrompt.includes("implement the backend route"),
  "replan prompt should carry the user steer, amended task, and interrupted executor snapshot"
);
// Plan turns swap in the plan-variant reminder — SAME marker prefix, or
// rehydration would render it as user text.
const planParts = buildPlannerTurnParts("plan the migration", "plan");
assert(
  planParts[1].text === OPEN_FUSION_PLAN_REMINDER &&
    planParts[1].text.startsWith(OPEN_FUSION_GATE_MARKER) &&
    OPEN_FUSION_PLAN_REMINDER !== OPEN_FUSION_GATE_REMINDER,
  "plan-mode turns must carry the plan-variant reminder under the same marker prefix"
);
// One-shot corrective nudge rides as a THIRD marked part — same prefix, so the
// existing rehydration strip covers it too.
const nudgeParts = buildPlannerTurnParts("continue", "auto", { nudge: true });
assert(
  nudgeParts.length === 3 &&
    nudgeParts[2].text === OPEN_FUSION_GATE_NUDGE &&
    nudgeParts[2].text.startsWith(OPEN_FUSION_GATE_MARKER) &&
    buildPlannerTurnParts("continue", "auto", {}).length === 2,
  "the gate nudge must append as a third marked part only when armed"
);

// ---- rehydrateMessages ----
const rehydrated = rehydrateMessages(
  [
    {
      info: { id: "m1", role: "user" },
      parts: [{ type: "text", text: "hi" }]
    },
    // A host-sent turn (with the nudge armed): neither the reminder nor the
    // nudge part may rehydrate as user text.
    {
      info: { id: "m1b", role: "user" },
      parts: buildPlannerTurnParts("try again", "auto", { nudge: true })
    },
    {
      info: { id: "m2", role: "assistant" },
      parts: [
        { type: "step-start" },
        {
          type: "tool",
          tool: "task",
          callID: "t1",
          state: { status: "completed", title: "Sub", input: {}, output: "done" }
        },
        { type: "text", id: "prt_r1", text: "All set." },
        { type: "step-finish", tokens: { input: 1, output: 1 } }
      ]
    }
  ],
  ROOT
);
assert(
  rehydrated[0].type === "user" && rehydrated[0].text === "hi",
  "rehydration should replay user turns"
);
assert(
  rehydrated[1].type === "user" && rehydrated[1].text === "try again",
  "rehydration must strip the gate-reminder part from user turns"
);
assert(
  !rehydrated.some(
    (event) => typeof event.text === "string" && event.text.includes(OPEN_FUSION_GATE_MARKER)
  ),
  "the gate reminder must never surface in rehydrated transcript events"
);
assert(
  rehydrated.some((event) => event.type === "tool-call" && event.name === "task") &&
    rehydrated.some((event) => event.type === "tool-result" && event.text === "done"),
  "rehydration should replay tool pairs"
);
assert(
  rehydrated.some(
    (event) =>
      event.type === "assistant-text" &&
      event.delta === "All set." &&
      event.streamId === `${ROOT}:prt_r1`
  ),
  "rehydration should replay assistant text with a per-part streamId"
);

// ---- splitModelId ----
assert(
  JSON.stringify(splitModelId("anthropic/claude-sonnet-4-5")) ===
    JSON.stringify({ providerID: "anthropic", modelID: "claude-sonnet-4-5" }),
  "splitModelId should split at the first slash"
);
assert(
  JSON.stringify(splitModelId("openrouter/google/gemini-3-pro")) ===
    JSON.stringify({ providerID: "openrouter", modelID: "google/gemini-3-pro" }),
  "model ids may contain slashes; only the first segment is the provider"
);
assert(splitModelId("no-slash") === null, "ids without a provider segment are invalid");

// ---- buildServeSpawn ----
const spawnSpec = buildServeSpawn({ OPENCODE_CONFIG: "C:\\cfg\\opencode.json" }, "C:\\repo", "pw");
assert(
  spawnSpec.options.env.OPENCODE_SERVER_PASSWORD === "pw" &&
    spawnSpec.options.env.OPENCODE_CONFIG === "C:\\cfg\\opencode.json" &&
    spawnSpec.options.cwd === "C:\\repo",
  "serve spawn should carry the pane env, cwd, and generated password"
);
const joined = [spawnSpec.command, ...spawnSpec.args].join(" ");
assert(joined.includes("serve"), "spawn should invoke opencode serve");

// ---- normalizeAuthMethods (shape recorded live from GET /provider/auth) ----
const methods = normalizeAuthMethods({
  "github-copilot": [
    {
      type: "oauth",
      label: "Login with GitHub Copilot",
      prompts: [
        {
          type: "select",
          key: "deploymentType",
          message: "Select GitHub deployment type",
          options: [
            { label: "GitHub.com", value: "github.com", hint: "most users" },
            { label: "Data residency", value: "data-residency" }
          ]
        }
      ],
      authorize: () => {}
    }
  ],
  azure: [
    {
      type: "api",
      label: "API key",
      prompts: [
        {
          type: "text",
          key: "resourceName",
          message: "Enter Azure Resource Name",
          placeholder: "e.g. my-models",
          validate: () => true
        }
      ]
    }
  ],
  bogus: [{ type: "carrier-pigeon", label: "nope" }]
});
assert(
  methods["github-copilot"]?.[0].type === "oauth" &&
    methods["github-copilot"][0].prompts?.[0].type === "select" &&
    methods["github-copilot"][0].prompts[0].options?.[0].value === "github.com" &&
    !("authorize" in methods["github-copilot"][0]),
  "oauth methods should keep label/prompts/options and drop functions"
);
assert(
  methods.azure?.[0].type === "api" &&
    methods.azure[0].prompts?.[0].key === "resourceName" &&
    methods.azure[0].prompts[0].placeholder === "e.g. my-models" &&
    !("validate" in methods.azure[0].prompts[0]),
  "api methods should keep prompt metadata and drop validators"
);
assert(!methods.bogus, "unknown method types are dropped entirely");

// ---- reattach replay contract ----
// Replayed history must be distinguishable from live activity so the renderer
// can rebuild the transcript without re-latching status or re-marking the
// acknowledged attention dot.
const hostSource = require("fs").readFileSync(
  require("path").join(__dirname, "..", "..", "backend", "openFusionChatHost.cjs"),
  "utf8"
);
assert(
  hostSource.includes("function replaySession") &&
    hostSource.includes("replaySession(id, existingState);") &&
    hostSource.includes("event: { ...event, replay: true }"),
  "Open Fusion host should tag reattach-replayed events with replay: true"
);
// Completion-gate wiring: the tracker observes the LIVE normalizer stream (and
// the synthesized interrupt), and only fresh non-plan turns consume the nudge.
assert(
  hostSource.includes("state.gate ? state.gate.observe(event) : event") &&
    hostSource.includes("createOpenFusionGateTracker({ cwd: state.cwd })") &&
    hostSource.includes('mode !== "plan" && !queued && Boolean(state.gate && state.gate.consumeNudge())'),
  "Open Fusion host must observe live events through the completion-gate tracker and gate the one-shot nudge"
);
assert(
  hostSource.includes("activeExecutorTasks") &&
    hostSource.includes("getPrimaryActiveExecutorTask") &&
    hostSource.includes("selectOpenFusionExecutorTask") &&
    hostSource.includes("ensureRouterSession") &&
    hostSource.includes("runSteerDecision") &&
    hostSource.includes("routeSteerToPlanner") &&
    hostSource.includes("preserveSteerViaExecutorOrRoot") &&
    hostSource.includes('type: "steer-route"') &&
    hostSource.includes("if (!handled)") &&
    hostSource.includes("return;"),
  "Open Fusion host should route active executor steering through a hidden planner decision before falling back to root queue"
);

// ---- detached background delegations ----
assert(
  hostSource.includes("function startOpenFusionBackgroundTask") &&
    hostSource.includes("function observeBackgroundSseEvent") &&
    hostSource.includes("function settleBackgroundTask") &&
    hostSource.includes("function maybeFlushOpenFusionWakes") &&
    hostSource.includes("function deliverOpenFusionWake") &&
    hostSource.includes('agent: "executor-bg"') &&
    hostSource.includes("state.backgroundBySession") &&
    hostSource.includes("state.gate.observe(echo)") &&
    hostSource.includes("s.turnBusy || (s.backgroundTasks && s.backgroundTasks.size > 0)") &&
    hostSource.includes("settleAllBackgroundTasks(id, state,"),
  "Open Fusion host must own the detached background engine (host-created executor-bg sessions watched pre-normalizer, gate-observed wake echo, dispose guard, engine-death settle)"
);
assert(
  hostSource.includes("const BACKGROUND_IDLE_TIMEOUT_MS = 600_000;") &&
    hostSource.includes("const BACKGROUND_HARD_TIMEOUT_MS = 14_400_000;") &&
    /task\.hardTimer = setTimeout\(\(\) => \{[\s\S]*?abortOpenFusionBackgroundSession\(state, task\.childSessionId\);[\s\S]*?settleBackgroundTask/.test(
      hostSource
    ) &&
    hostSource.includes("abortOpenFusionBackgroundSession(state, created.id);") &&
    hostSource.includes("function cancelOpenFusionBackgroundTask") &&
    (hostSource.match(/abortOpenFusionBackgroundSession\(state, task\.childSessionId\);/g) || [])
      .length >= 2,
  "Open Fusion background tasks should keep the 10-minute idle guard, use a four-hour absolute cap, and abort timed-out/cancelled sessions"
);
assert(
  hostSource.includes("function writeBackgroundStatusSnapshotFile") &&
    hostSource.includes("VIBE_TERMINAL_BG_STATUS_FILE") &&
    hostSource.includes("backgroundSettled") &&
    hostSource.includes("recentActivity") &&
    hostSource.includes("writeBackgroundStatusFile(id, state);") &&
    hostSource.includes("payload.backgroundStatusPath") &&
    hostSource.includes("Open Fusion stopped while this background task was running."),
  "Open Fusion host must maintain the pane-bound running/settled background status snapshot across progress, settlement, and stop"
);
// Wake envelope round-trip: what deliverOpenFusionWake posts must be filtered
// out of rehydrated user text and rebuilt as a report row instead.
{
  assert(
    backgroundTaskTitleOf("", "Fix the flaky test\nmore detail") === "Fix the flaky test",
    "backgroundTaskTitleOf should take the first non-empty prompt line"
  );
  assert(
    buildOpenFusionBackgroundContract("do the thing").includes("## Detached background task") &&
      buildOpenFusionBackgroundContract("do the thing").includes("OPEN_FUSION_EXECUTOR_REPORT"),
    "the background contract must mark the task detached and demand the executor report block"
  );
  const wakeText = buildOpenFusionBackgroundWakeText({
    taskId: "obg-3",
    title: "docs sweep",
    cancelled: false,
    result: { status: "completed", report: "OPEN_FUSION_EXECUTOR_REPORT ... Recommendation: COMPLETE", files: ["src/a.ts"] }
  });
  assert(
    wakeText.startsWith(OPEN_FUSION_BACKGROUND_MARKER) &&
      wakeText.includes("taskId: obg-3") &&
      wakeText.includes("verify it independently"),
    "buildOpenFusionBackgroundWakeText must produce the marked report with the review duty"
  );
  const parsed = parseOpenFusionBackgroundReport(wakeText);
  assert(
    parsed && parsed.taskId === "obg-3" && parsed.title === "docs sweep",
    "parseOpenFusionBackgroundReport must recover taskId/title"
  );
  const rehydrated = rehydrateMessages(
    [
      {
        info: { role: "user" },
        parts: [
          { type: "text", text: wakeText },
          { type: "text", text: OPEN_FUSION_GATE_REMINDER }
        ]
      }
    ],
    ROOT
  );
  assert(
    rehydrated.length === 1 &&
      rehydrated[0].type === "user" &&
      rehydrated[0].backgroundReport === true &&
      rehydrated[0].taskId === "obg-3" &&
      rehydrated[0].title === "docs sweep",
    "a resumed wake prompt must rehydrate as a backgroundReport row, never as user text"
  );
}

console.log("Open Fusion chat parse smoke passed");
