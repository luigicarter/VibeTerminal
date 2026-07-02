// Open Fusion chat SSE normalizer smoke test.
//
// Feeds backend/openFusionChatHost.cjs's createOpenCodeEventNormalizer a
// recorded `opencode serve` /event sequence (session busy → planner deltas +
// snapshots → a task delegation spawning an executor child session → child
// output → tool completion → idle) and asserts it produces the right
// high-level chat events. Shapes were captured live against OpenCode 1.17.11.
// No OpenCode, no auth, no cost — this guards the parsing the
// OpenFusionChatPane renders.

const {
  createOpenCodeEventNormalizer,
  rehydrateMessages,
  buildServeSpawn,
  normalizeAuthMethods,
  splitModelId
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
  // Assistant message streams deltas, then a full-text snapshot (dedup check).
  {
    type: "message.updated",
    properties: {
      sessionID: ROOT,
      info: { id: "msg_a1", role: "assistant", sessionID: ROOT, agent: "planner" }
    }
  },
  {
    type: "message.part.delta",
    properties: { sessionID: ROOT, messageID: "msg_a1", partID: "prt_t1", field: "reasoning", delta: "plan it" }
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
      part: { id: "prt_t2", messageID: "msg_a1", sessionID: ROOT, type: "text", text: "Delegating now. Done." }
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
    type: "message.part.delta",
    properties: { sessionID: CHILD, messageID: "msg_c1", partID: "prt_c1", field: "text", delta: "391" }
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
  // Turn end; a second idle must not double-emit.
  { type: "session.idle", properties: { sessionID: ROOT } },
  { type: "session.idle", properties: { sessionID: ROOT } },
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

// Brain text streams and dedupes: deltas + snapshot suffix, never repeated text.
const brainText = byType("assistant-text")
  .filter((event) => event.role === "brain")
  .map((event) => event.delta)
  .join("");
assert(
  brainText === "Delegating now. Done.",
  `brain text should join deltas + snapshot suffix exactly once, got: ${JSON.stringify(brainText)}`
);
assert(
  byType("thinking").length === 1 && byType("thinking")[0].role === "brain",
  "reasoning deltas should surface as brain thinking"
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

// ---- rehydrateMessages ----
const rehydrated = rehydrateMessages(
  [
    {
      info: { id: "m1", role: "user" },
      parts: [{ type: "text", text: "hi" }]
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
        { type: "text", text: "All set." },
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
  rehydrated.some((event) => event.type === "tool-call" && event.name === "task") &&
    rehydrated.some((event) => event.type === "tool-result" && event.text === "done"),
  "rehydration should replay tool pairs"
);
assert(
  rehydrated.some((event) => event.type === "assistant-text" && event.delta === "All set."),
  "rehydration should replay assistant text"
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

console.log("Open Fusion chat parse smoke passed");
