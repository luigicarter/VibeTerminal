// Regression for Fusion Codex-planner interrupt double-settle.
//
// Codex planner emits `interrupted`, then a follow-up
// result{subtype:"aborted", isError:false}. The pane must render exactly one
// interrupted turn-end row and must not later report a completed turn.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const rootDir = path.join(__dirname, "..", "..");
const fusionPanePath = path.join(rootDir, "frontend", "components", "FusionChatPane.tsx");
const fusionPaneSource = fs.readFileSync(fusionPanePath, "utf8");

assert(
  fusionPaneSource.includes("const interruptSettledRef = useRef(false)") &&
    fusionPaneSource.includes('case "interrupted"') &&
    fusionPaneSource.includes('case "result"') &&
    fusionPaneSource.includes("interruptSettledRef.current = true") &&
    fusionPaneSource.includes("interruptSettledRef.current && !event.isError"),
  "FusionChatPane interrupt/result reducer shape changed; update this repro."
);
assert(
  fusionPaneSource.includes("pendingDelegationActivityRef") &&
    fusionPaneSource.includes("drainPendingDelegationActivity()"),
  "delegation activity buffer/drain fix must remain present"
);

function applyCurrentInterruptReducer(events) {
  const state = {
    busy: false,
    interrupting: false,
    waiting: false,
    failed: false,
    interruptSettled: false,
    runningTools: 0,
    messages: [],
    attention: []
  };

  const push = (entry) => {
    state.messages.push({ key: `m${state.messages.length}`, ...entry });
  };

  const settleRunningTools = () => {
    if (state.runningTools > 0) {
      state.runningTools = 0;
    }
  };

  const pushTurnEnd = (interrupted) => {
    push({
      role: "opus",
      kind: "result",
      text: "Fusion",
      taskDetail: interrupted ? "interrupted" : "completed"
    });
  };

  for (const event of events) {
    switch (event.type) {
      case "turn-start":
        state.busy = true;
        state.waiting = false;
        state.failed = false;
        state.interruptSettled = false;
        break;
      case "tool-call":
        state.runningTools += 1;
        push({
          role: "codex",
          kind: "tool",
          toolId: event.toolId,
          toolName: "task",
          toolStatus: "running"
        });
        break;
      case "interrupted":
        settleRunningTools();
        state.interrupting = false;
        state.waiting = false;
        state.failed = false;
        state.busy = false;
        state.interruptSettled = true;
        pushTurnEnd(true);
        break;
      case "result":
        state.interrupting = false;
        state.busy = false;
        if (event.subtype === "restored") {
          break;
        }
        if (state.interruptSettled && !event.isError) {
          state.interruptSettled = false;
          break;
        }
        if (event.isError) {
          state.interruptSettled = false;
          state.failed = true;
          state.attention.push({ state: "failed", reason: "error" });
          break;
        }
        pushTurnEnd(false);
        state.attention.push({ state: "completed", reason: "done" });
        break;
      default:
        break;
    }
  }

  return state;
}

const codexPlannerInterruptedThenAborted = [
  { type: "turn-start" },
  {
    type: "tool-call",
    toolId: "call-implement-1",
    name: "mcp__fusion-codex__codex_implement"
  },
  { type: "interrupted" },
  { type: "result", subtype: "aborted", isError: false }
];

const state = applyCurrentInterruptReducer(codexPlannerInterruptedThenAborted);
const resultRows = state.messages.filter((row) => row.kind === "result");
const completedAttention = state.attention.filter((entry) => entry.state === "completed");

assert.strictEqual(
  resultRows.length,
  1,
  `expected exactly one turn-end row after interrupted+aborted result, got ${JSON.stringify(resultRows, null, 2)}`
);
assert(
  /interrupted/.test(resultRows[0].taskDetail || ""),
  `expected the single turn-end row to remain interrupted: ${JSON.stringify(resultRows[0], null, 2)}`
);
assert.strictEqual(
  completedAttention.length,
  0,
  `aborted interrupt confirmation must not report completed attention: ${JSON.stringify(state.attention, null, 2)}`
);
assert.strictEqual(state.busy, false, "interrupt confirmation must leave the pane not busy");
assert.strictEqual(state.interruptSettled, false, "interrupt confirmation must clear the dedupe flag");

console.log("Fusion interrupt dedupe repro passed");
