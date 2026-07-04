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
  OPEN_FUSION_GATE_MARKER,
  OPEN_FUSION_GATE_REMINDER,
  OPEN_FUSION_PLAN_REMINDER
} = require("../../backend/openFusionChatHost.cjs");

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
assert(
  toolCalls.some((event) => event.name === "task" && event.role === "brain"),
  "the task delegation should emit a brain tool-call"
);
assert(
  toolCalls.filter((event) => event.name === "task").length === 1,
  "pending → running must emit only one task tool-call"
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
// Plan turns swap in the plan-variant reminder — SAME marker prefix, or
// rehydration would render it as user text.
const planParts = buildPlannerTurnParts("plan the migration", "plan");
assert(
  planParts[1].text === OPEN_FUSION_PLAN_REMINDER &&
    planParts[1].text.startsWith(OPEN_FUSION_GATE_MARKER) &&
    OPEN_FUSION_PLAN_REMINDER !== OPEN_FUSION_GATE_REMINDER,
  "plan-mode turns must carry the plan-variant reminder under the same marker prefix"
);

// ---- rehydrateMessages ----
const rehydrated = rehydrateMessages(
  [
    {
      info: { id: "m1", role: "user" },
      parts: [{ type: "text", text: "hi" }]
    },
    // A host-sent turn: the reminder part must NOT rehydrate as user text.
    {
      info: { id: "m1b", role: "user" },
      parts: buildPlannerTurnParts("try again")
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

console.log("Open Fusion chat parse smoke passed");
