// Regression for Fusion's Codex-planner + Claude-executor delegation row race.
//
// The real reducer is currently trapped inside frontend/components/FusionChatPane.tsx,
// so this script mirrors the smallest relevant reducer branches and feeds the
// observed cross-transport event order: adapter activity arrives before the
// Codex planner tool-call.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const rootDir = path.join(__dirname, "..", "..");
const fusionPanePath = path.join(rootDir, "frontend", "components", "FusionChatPane.tsx");
const fusionPaneSource = fs.readFileSync(fusionPanePath, "utf8");

assert(
  fusionPaneSource.includes("const delegationRef = useRef") &&
    fusionPaneSource.includes('case "tool-call"') &&
    fusionPaneSource.includes('case "activity"') &&
    fusionPaneSource.includes("delegationRef.current = {") &&
    fusionPaneSource.includes("pendingDelegationActivityRef") &&
    fusionPaneSource.includes("drainPendingDelegationActivity()"),
  "FusionChatPane reducer shape changed; update this repro to use the extracted reducer seam."
);

function isDelegationTool(name) {
  return /codex_(?:investigate|implement)$/.test(name);
}

function delegationPromptBlock(prompt) {
  return `**Delegation**\n\n${prompt}`;
}

function applyCurrentFusionPaneReducer(events) {
  const state = {
    keySeq: 0,
    busy: false,
    messages: [],
    delegation: null,
    pendingDelegationActivity: []
  };

  const push = (entry) => {
    const key = `m${state.keySeq++}`;
    state.messages.push({ key, ...entry });
    return key;
  };

  for (const event of events) {
    switch (event.type) {
      case "turn-start":
        state.busy = true;
        break;
      case "tool-call": {
        if (!isDelegationTool(event.name)) break;
        const key = push({
          role: "codex",
          kind: "tool",
          toolId: event.toolId,
          toolName: "task",
          toolStatus: "running",
          toolInput: {
            subagent_type: event.name.endsWith("codex_investigate") ? "scout" : "executor",
            description: event.input?.task || "implementation"
          }
        });
        state.delegation = {
          key,
          toolId: event.toolId,
          toolcalls: 0,
          activities: []
        };
        const pending = state.pendingDelegationActivity.splice(0);
        for (const item of pending) {
          applyDelegationActivity(state, state.delegation, item.kind, item.text);
        }
        break;
      }
      case "activity": {
        const kind = event.kind || "";
        const text = event.text || "";
        const delegation = state.delegation;
        if (delegation && event.role === "codex" && isProgressKind(kind)) {
          applyDelegationActivity(state, delegation, kind, text);
          break;
        }
        if (kind === "delegate" && delegation) {
          applyDelegationActivity(state, delegation, kind, text);
          break;
        }
        if (
          state.busy &&
          !delegation &&
          (kind === "delegate" || (event.role === "codex" && isProgressKind(kind)))
        ) {
          state.pendingDelegationActivity.push({ role: event.role, kind, text });
          break;
        }
        push({
          role: event.role,
          kind: "activity",
          text: `${kind ? `${kind}: ` : ""}${text}`,
          internal: ["delegate", "decision", "goal", "warmup"].includes(kind)
        });
        break;
      }
      default:
        break;
    }
  }

  return state;
}

function isProgressKind(kind) {
  return kind === "command" || kind === "file" || kind === "message";
}

function applyDelegationActivity(state, delegation, kind, text) {
  if (isProgressKind(kind)) {
    delegation.toolcalls += 1;
    const detail = kind === "command" ? `$ ${text}` : text;
    delegation.activities.push(detail);
    state.messages = state.messages.map((row) =>
      row.key === delegation.key ? { ...row, taskDetail: detail } : row
    );
    return;
  }
  if (kind === "delegate") {
    delegation.prompt = text;
    state.messages = state.messages.map((row) =>
      row.key === delegation.key ? { ...row, toolOutput: delegationPromptBlock(text) } : row
    );
  }
}

const racedCodexPlannerClaudeExecutorEvents = [
  { type: "turn-start" },
  {
    type: "activity",
    role: "opus",
    kind: "delegate",
    text: "Implement the login retry fix."
  },
  {
    type: "activity",
    role: "codex",
    kind: "command",
    text: "npm test -- --runInBand"
  },
  {
    type: "tool-call",
    toolId: "call-implement-1",
    name: "mcp__fusion-codex__codex_implement",
    input: { task: "Implement the login retry fix." }
  }
];

const state = applyCurrentFusionPaneReducer(racedCodexPlannerClaudeExecutorEvents);
const taskRow = state.messages.find(
  (row) => row.kind === "tool" && row.toolName === "task" && row.toolId === "call-implement-1"
);

assert(taskRow, "expected the codex_implement tool-call to create a Task row");
assert(
  taskRow.toolOutput && taskRow.toolOutput.includes("Implement the login retry fix."),
  [
    "delegate activity arrived before tool-call but did not attach to the Task row.",
    `Task row: ${JSON.stringify(taskRow, null, 2)}`,
    `All rows: ${JSON.stringify(state.messages, null, 2)}`
  ].join("\n")
);
assert.strictEqual(
  taskRow.taskDetail,
  "$ npm test -- --runInBand",
  [
    "command progress arrived before tool-call but did not tick the Task row.",
    `Task row: ${JSON.stringify(taskRow, null, 2)}`,
    `All rows: ${JSON.stringify(state.messages, null, 2)}`
  ].join("\n")
);

console.log("Fusion delegation race repro passed");
