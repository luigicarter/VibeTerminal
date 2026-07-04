// Fusion chat stream-json normalizer smoke test.
//
// Feeds backend/fusionChatHost.cjs's createStreamNormalizer a recorded headless
// `claude` stream-json sequence (system/init → streamed text → a buffered
// codex_implement tool_use → turn end → tool_result → result) and asserts it
// produces the right high-level chat events. No Claude, no auth, no cost — this
// guards the parsing the FusionChatPane renders.

const fs = require("fs");
const path = require("path");

const {
  buildClaudeArgs,
  buildClaudeSpawn,
  buildFusionInputContent,
  createStreamNormalizer,
  windowsCmdArg,
  FUSION_GATE_NUDGE
} = require("../../backend/fusionChatHost.cjs");
const { createFusionGateTracker } = require("../../backend/completionGate.cjs");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const fixture = [
  { type: "system", subtype: "init", session_id: "sess-abc" },
  { type: "stream_event", event: { type: "message_start", message: {} } },
  { type: "stream_event", event: { type: "content_block_start", content_block: { type: "text" } } },
  { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello " } } },
  { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "world" } } },
  { type: "stream_event", event: { type: "content_block_stop" } },
  { type: "stream_event", event: { type: "content_block_start", content_block: { type: "thinking" } } },
  { type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "Let me plan." } } },
  { type: "stream_event", event: { type: "content_block_stop" } },
  {
    type: "stream_event",
    event: {
      type: "content_block_start",
      content_block: { type: "tool_use", id: "tool-1", name: "mcp__fusion-codex__codex_implement" }
    }
  },
  { type: "stream_event", event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: '{"task":"add ' } } },
  { type: "stream_event", event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: 'rate limiting"}' } } },
  { type: "stream_event", event: { type: "content_block_stop" } },
  {
    type: "stream_event",
    event: {
      type: "content_block_start",
      content_block: { type: "tool_use", id: "agent-1", name: "Task" }
    }
  },
  { type: "stream_event", event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: '{"description":"Review API",' } } },
  { type: "stream_event", event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: '"prompt":"Check background activity."}' } } },
  { type: "stream_event", event: { type: "content_block_stop" } },
  { type: "stream_event", event: { type: "message_stop" } },
  {
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content:
            '{"status":"completed","summary":"done","files":["src/api/limits.ts"],"goalReached":true,"nextAction":"done"}'
        },
        { type: "tool_result", tool_use_id: "agent-1", content: "done", is_error: true }
      ]
    }
  },
  { type: "result", subtype: "success", total_cost_usd: 0.012 },
  // "/compact" sent as a stream-json user message — lines recorded VERBATIM
  // from a live claude 2.1.200 session (fusion-compact-spike, 2026-07-04):
  // status:"compacting" opens the pass, the follow-up status line carries
  // compact_result + compact_error.
  { type: "system", subtype: "status", status: "compacting", session_id: "sess-abc" },
  {
    type: "system",
    subtype: "status",
    status: null,
    compact_result: "failed",
    compact_error: "Not enough messages to compact.",
    session_id: "sess-abc"
  },
  { type: "system", subtype: "status", status: "compacting", session_id: "sess-abc" },
  { type: "system", subtype: "status", status: null, compact_result: "success", session_id: "sess-abc" }
];

function main() {
  const normalize = createStreamNormalizer();
  const events = [];
  for (const obj of fixture) {
    for (const event of normalize(JSON.stringify(obj))) events.push(event);
  }

  const session = events.find((e) => e.type === "session");
  assert(session && session.sessionId === "sess-abc", "missing/incorrect session event");

  const text = events.filter((e) => e.type === "assistant-text").map((e) => e.delta).join("");
  assert(text === "Hello world", `assistant text mismatch: "${text}"`);

  const thinking = events.filter((e) => e.type === "thinking").map((e) => e.delta).join("");
  assert(thinking === "Let me plan.", `thinking text mismatch: "${thinking}"`);

  const tool = events.find((e) => e.type === "tool-call");
  assert(tool, "missing tool-call event");
  assert(tool.toolId === "tool-1", "tool-call id mismatch");
  assert(tool.name.endsWith("codex_implement"), "tool-call name mismatch");
  assert(
    tool.input && tool.input.task === "add rate limiting",
    `tool-call buffered input not parsed: ${JSON.stringify(tool.input)}`
  );

  const toolResult = events.find((e) => e.type === "tool-result");
  assert(toolResult && toolResult.toolId === "tool-1", "missing tool-result event");
  // is_error must ride through: the pane's OpenCode-style rows settle red on
  // it instead of guessing from the result text.
  assert(toolResult.isError === false, "tool-result should carry isError: false");
  const failedResult = events.find((e) => e.type === "tool-result" && e.toolId === "agent-1");
  assert(failedResult && failedResult.isError === true, "failed tool-result should carry isError: true");

  const backgroundEvents = events.filter((e) => e.type === "background-activity");
  assert(backgroundEvents.length === 2, `expected background start/stop, got ${backgroundEvents.length}`);
  assert(
    backgroundEvents[0].backgroundActivity.active === true &&
      backgroundEvents[0].backgroundActivity.count === 1,
    `background start should report one active agent: ${JSON.stringify(backgroundEvents[0])}`
  );
  assert(
    backgroundEvents[0].backgroundActivity.items[0].label === "Review API",
    `background label should come from Task description: ${JSON.stringify(backgroundEvents[0])}`
  );
  assert(
    backgroundEvents[1].backgroundActivity.active === false &&
      backgroundEvents[1].backgroundActivity.count === 0,
    `background stop should clear active agents: ${JSON.stringify(backgroundEvents[1])}`
  );

  assert(events.some((e) => e.type === "turn-start"), "missing turn-start");
  assert(events.some((e) => e.type === "turn-end"), "missing turn-end");
  const result = events.find((e) => e.type === "result");
  assert(result && result.subtype === "success", "missing successful result event");

  // /compact status lines → compact-start + compacted (ok mirrors
  // compact_result; the error text rides along for the failed case).
  const compactStarts = events.filter((e) => e.type === "compact-start");
  const compacted = events.filter((e) => e.type === "compacted");
  assert(compactStarts.length === 2, `expected two compact-start events, got ${compactStarts.length}`);
  assert(
    compacted.length === 2 &&
      compacted[0].ok === false &&
      compacted[0].error === "Not enough messages to compact." &&
      compacted[1].ok === true &&
      compacted[1].error === undefined,
    `compacted events should mirror compact_result/compact_error: ${JSON.stringify(compacted)}`
  );

  // ---- completion-gate tracker over the real fixture stream ----
  // The fixture is the canonical UNVERIFIED case: codex_implement returns
  // (files: src/api/limits.ts) and the turn settles with no planner evidence.
  {
    const gate = createFusionGateTracker({ cwd: "C:\\repo" });
    const observed = events.map((event) => gate.observe(event));
    const settle = observed.find((event) => event.type === "result");
    assert(
      settle && settle.gate && settle.gate.status === "unverified",
      "a codex_implement return with no planner evidence must settle unverified"
    );
    assert(
      gate.getState().latchOpen &&
        gate.getState().changedFiles[0].endsWith("src/api/limits.ts"),
      "the latch should carry the adapter's changed-file list"
    );
    assert(gate.consumeNudge() === true && gate.consumeNudge() === false, "nudge must be one-shot");
    // Follow-up turn: Claude Reads the changed file (absolute path vs the
    // adapter's relative one), then settles — verified.
    const followUp = [];
    for (const obj of [
      {
        type: "stream_event",
        event: {
          type: "content_block_start",
          content_block: { type: "tool_use", id: "read-1", name: "Read" }
        }
      },
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "input_json_delta", partial_json: '{"file_path":"C:\\\\repo\\\\src\\\\api\\\\limits.ts"}' }
        }
      },
      { type: "stream_event", event: { type: "content_block_stop" } },
      {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "read-1", content: "file body" }] }
      },
      { type: "result", subtype: "success", total_cost_usd: 0.001 }
    ]) {
      for (const event of normalize(JSON.stringify(obj))) followUp.push(gate.observe(event));
    }
    const verified = followUp.find((event) => event.type === "result");
    assert(
      verified && verified.gate && verified.gate.status === "verified" &&
        verified.gate.evidence[0] === "read changed file",
      "a Read of the returned file must verify the pending delegation"
    );
  }

  // ---- buildFusionInputContent nudge arm ----
  assert(
    buildFusionInputContent("x", "auto", false, true).includes(FUSION_GATE_NUDGE) &&
      buildFusionInputContent("x", "auto", false, true).includes("x") &&
      buildFusionInputContent("x", "auto", false, false) === "x" &&
      !buildFusionInputContent("x", "plan", false, true).includes(FUSION_GATE_NUDGE) &&
      !buildFusionInputContent("x", "auto", true, true).includes(FUSION_GATE_NUDGE),
    "the gate nudge must ride only fresh non-plan, non-steer turns"
  );

  const claudeArgs = buildClaudeArgs({
    cwd: "C:\\repo dir\\a&b",
    mcpConfig: "C:\\cfg dir\\fusion|mcp.json",
    systemPromptFile: "C:\\prompt dir\\system\"prompt.md",
    model: "opus",
    effort: "high",
    settingsFile: "C:\\cfg dir\\fusion-claude-settings.json",
    tools: "Read,Glob,Grep,Edit,Write",
    allowedTools: "mcp__fusion-codex__codex_investigate,mcp__fusion-codex__codex_implement,Read,Glob,Grep,Edit,Write",
    disallowedTools: "Bash",
    strictMcpConfig: true,
    resumeId: "resume & id"
  });
  assert(!claudeArgs.includes("claude"), "claude executable should not be part of argv args");
  assert(claudeArgs.includes("C:\\repo dir\\a&b"), "cwd should remain one raw argv value");
  assert(
    claudeArgs.includes("C:\\cfg dir\\fusion|mcp.json"),
    "mcpConfig should remain one raw argv value"
  );
  assert(
    claudeArgs.includes("C:\\prompt dir\\system\"prompt.md"),
    "system prompt path should remain one raw argv value"
  );
  assert(claudeArgs.includes("--effort") && claudeArgs.includes("high"), "effort should be passed to claude");
  assert(
    claudeArgs.includes("--settings") &&
      claudeArgs.includes("C:\\cfg dir\\fusion-claude-settings.json"),
    "Fusion-specific Claude settings file should be passed to claude"
  );
  assert(
      claudeArgs.includes("--tools") &&
      claudeArgs.includes("Read,Glob,Grep,Edit,Write"),
    "available Claude built-ins should be restricted to read and UI write tools"
  );
  assert(
      claudeArgs.includes("--allowedTools") &&
      claudeArgs.includes("mcp__fusion-codex__codex_investigate,mcp__fusion-codex__codex_implement,Read,Glob,Grep,Edit,Write"),
    "allowed tools should include the Fusion bridge plus direct UI write tools"
  );
  assert(
    claudeArgs.includes("--disallowedTools") &&
      claudeArgs.includes("Bash"),
    "Bash denylist should be passed to claude"
  );
  assert(claudeArgs.includes("--strict-mcp-config"), "Fusion should isolate Claude to the per-pane MCP config");

  const escaped = windowsCmdArg("C:\\repo dir\\a&b|\"quoted\"");
  assert(escaped.startsWith('"') && escaped.endsWith('"'), "Windows special args should be quoted");
  assert(!escaped.includes("^"), "cmd keeps ^ literal inside quotes, so quoting must not caret-escape");
  assert(escaped.includes('\\"quoted\\"'), "embedded quotes should be escaped for the child argv parser");
  assert(
    windowsCmdArg("D:\\repos\\app(old)") === '"D:\\repos\\app(old)"',
    "paths with parens should be quoted verbatim, not caret-mangled"
  );
  assert(
    windowsCmdArg("C:\\repo dir\\").endsWith('\\\\"'),
    "trailing backslashes must be doubled so the closing quote survives"
  );

  const spawnPlan = buildClaudeSpawn({ cwd: "C:\\repo dir\\a&b" });
  if (process.platform === "win32") {
    assert(spawnPlan.command.toLowerCase().endsWith("cmd.exe"), "Windows should use cmd.exe for the global claude wrapper");
    assert(spawnPlan.args[3].includes('"C:\\repo dir\\a&b"'), "Windows launch command should quote shell metacharacters without caret escapes");
  } else {
    assert(spawnPlan.command === "claude", "POSIX should spawn global claude directly");
    assert(spawnPlan.args.includes("C:\\repo dir\\a&b"), "POSIX spawn plan should keep cwd as argv");
  }

  const hostSource = fs.readFileSync(
    path.join(__dirname, "..", "..", "backend", "fusionChatHost.cjs"),
    "utf8"
  );
  assert(
    hostSource.includes("function replaySession") &&
      hostSource.includes("replaySession(id, existingState);") &&
      // Replayed history must be distinguishable from live activity so the
      // renderer can rebuild the transcript without re-latching status or
      // re-marking the acknowledged attention dot.
      hostSource.includes("event: { ...event, replay: true }") &&
      hostSource.includes("emitSessionEvent(id, state, event)") &&
      hostSource.includes("emitDirectSessionEvent(id,") &&
      hostSource.includes("sessions.get(id) !== state") &&
      hostSource.includes("Fusion process is closed. Restart Fusion to continue.") &&
      hostSource.includes("STEER CURRENT FUSION TURN:") &&
      hostSource.includes("payload?.steer") &&
      hostSource.includes('if (effort) args.push("--effort", String(effort));') &&
      hostSource.includes('else if (msg.type === "activity") activity(msg.payload)') &&
      hostSource.includes('type: "background-activity"') &&
      hostSource.includes('function isBackgroundAgentTool'),
    "Fusion host should replay live sessions, reject stale process events, and report closed-session input"
  );
  assert(
    hostSource.includes("if (state.gate) event = state.gate.observe(event);") &&
      hostSource.includes("createFusionGateTracker({ cwd })") &&
      hostSource.includes("state.gate && state.gate.consumeNudge()"),
    "Fusion host must observe events through the completion-gate tracker (both engines) and gate the one-shot nudge"
  );

  // ---- codex-brain planner normalizer (per-role families) ----
  // Feed the pure normalizer real notification shapes recorded from the live
  // codex-cli 0.142.5 probe (2026-07-03) and assert the pane-vocabulary
  // events plus the elicitation auto-accept/decline replies.
  const {
    createCodexBrainNormalizer,
    bridgeConfigFromMcpFile
  } = require("../../backend/fusionCodexBrain.cjs");
  const brain = createCodexBrainNormalizer();
  const collect = (msg) => brain.normalize(msg);

  const sessionOut = collect({
    method: "thread/started",
    params: { thread: { id: "thread-1" } }
  });
  assert(
    sessionOut.events.length === 1 &&
      sessionOut.events[0].type === "session" &&
      sessionOut.events[0].sessionId === "thread-1",
    "codex brain should emit one session event from thread/started"
  );
  assert(
    collect({ method: "thread/started", params: { thread: { id: "thread-1" } } }).events.length === 0,
    "codex brain session event should be emitted only once"
  );

  const turnStart = collect({
    method: "turn/started",
    params: { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress" } }
  });
  assert(
    turnStart.events[0].type === "turn-start" && brain.getActiveTurnId() === "turn-1",
    "turn/started should emit turn-start and track the active turn id"
  );

  const delta = collect({
    method: "item/agentMessage/delta",
    params: { threadId: "thread-1", turnId: "turn-1", itemId: "msg-1", delta: "Hel" }
  });
  assert(
    delta.events[0].type === "assistant-text" && delta.events[0].delta === "Hel",
    "agentMessage deltas should stream as assistant-text"
  );

  const reasoning = collect({
    method: "item/reasoningSummaryText/delta",
    params: { delta: "thinking…" }
  });
  assert(
    reasoning.events[0].type === "thinking" && reasoning.events[0].delta === "thinking…",
    "reasoning deltas should stream as thinking"
  );

  const toolCall = collect({
    method: "item/started",
    params: {
      item: {
        type: "mcpToolCall",
        id: "call-1",
        server: "fusion-codex",
        tool: "codex_implement",
        arguments: { task: "add rate limiting" }
      }
    }
  });
  assert(
    toolCall.events[0].type === "tool-call" &&
      toolCall.events[0].name === "mcp__fusion-codex__codex_implement" &&
      toolCall.events[0].input.task === "add rate limiting",
    "bridge mcpToolCall items should surface with the claude-path tool name prefix"
  );

  const elicitation = collect({
    id: 0,
    method: "mcpServer/elicitation/request",
    params: { serverName: "fusion-codex", mode: "form" }
  });
  assert(
    elicitation.reply &&
      elicitation.reply.id === 0 &&
      elicitation.reply.result &&
      elicitation.reply.result.action === "accept",
    "fusion bridge elicitations must be auto-accepted (unanswered ones wedge the thread)"
  );
  const foreignElicitation = collect({
    id: 1,
    method: "mcpServer/elicitation/request",
    params: { serverName: "node_repl" }
  });
  assert(
    foreignElicitation.reply &&
      foreignElicitation.reply.result &&
      foreignElicitation.reply.result.action === "decline",
    "non-bridge MCP elicitations must be declined"
  );
  const unsupported = collect({ id: 2, method: "account/chatgptAuthTokens/refresh", params: {} });
  assert(
    unsupported.reply && unsupported.reply.error,
    "unsupported server requests must be answered with a JSON-RPC error (fail closed)"
  );

  const toolDone = collect({
    method: "item/completed",
    params: {
      item: {
        type: "mcpToolCall",
        id: "call-1",
        server: "fusion-codex",
        tool: "codex_implement",
        status: "completed",
        result: { content: [{ type: "text", text: '{"status":"completed"}' }] },
        error: null
      }
    }
  });
  assert(
    toolDone.events[0].type === "tool-result" &&
      toolDone.events[0].text === '{"status":"completed"}' &&
      toolDone.events[0].isError === false,
    "bridge tool results should surface their text content"
  );

  // Native shell items surface as observe-only completion-gate evidence: one
  // event on item/completed, nothing on item/started, panes ignore the type.
  const nativeStarted = collect({
    method: "item/started",
    params: {
      item: { type: "commandExecution", id: "cmd-1", command: "git diff --stat", status: "inProgress" }
    }
  });
  assert(
    nativeStarted.events.length === 0,
    "commandExecution item/started must emit nothing (observe on completion only)"
  );
  const nativeDone = collect({
    method: "item/completed",
    params: {
      item: {
        type: "commandExecution",
        id: "cmd-1",
        command: "git diff --stat",
        status: "completed",
        exitCode: 0,
        commandActions: [{ type: "unknown", command: "git diff --stat" }]
      }
    }
  });
  assert(
    nativeDone.events.length === 1 &&
      nativeDone.events[0].type === "native-tool" &&
      nativeDone.events[0].name === "bash" &&
      nativeDone.events[0].command === "git diff --stat" &&
      nativeDone.events[0].ok === true &&
      Array.isArray(nativeDone.events[0].actions),
    "completed commandExecution items should emit one observe-only native-tool event"
  );
  const nativeFailed = collect({
    method: "item/completed",
    params: {
      item: { type: "commandExecution", id: "cmd-2", command: "git diff", status: "failed", exitCode: 1 }
    }
  });
  assert(
    nativeFailed.events[0].type === "native-tool" && nativeFailed.events[0].ok === false,
    "failed commandExecution items must carry ok:false (never counts as evidence)"
  );

  collect({
    method: "thread/tokenUsage/updated",
    params: { tokenUsage: { total: { totalTokens: 12939 } } }
  });
  const done = collect({
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", error: null } }
  });
  assert(
    done.events[0].type === "turn-end" &&
      done.events[1].type === "result" &&
      done.events[1].isError === false &&
      done.events[1].usage &&
      done.events[1].usage.total.totalTokens === 12939 &&
      brain.getActiveTurnId() === null,
    "turn/completed(completed) should emit turn-end + success result with usage"
  );

  collect({ method: "turn/started", params: { turn: { id: "turn-2" } } });
  const failed = collect({
    method: "turn/completed",
    params: { turn: { id: "turn-2", status: "failed", error: { message: "model exploded" } } }
  });
  assert(
    failed.events[0].type === "turn-error" &&
      failed.events[0].message === "model exploded" &&
      failed.events[1].type === "result" &&
      failed.events[1].isError === true,
    "turn/completed(failed) should emit turn-error + error result"
  );

  collect({ method: "turn/started", params: { turn: { id: "turn-3" } } });
  const interrupted = collect({
    method: "turn/completed",
    params: { turn: { id: "turn-3", status: "interrupted", error: null } }
  });
  assert(
    interrupted.events[0].type === "turn-end" &&
      interrupted.events[1].type === "result" &&
      interrupted.events[1].subtype === "aborted" &&
      interrupted.events[1].isError === false,
    "an interrupted turn must not read as a failure"
  );

  // bridgeConfigFromMcpFile: the claude-path --mcp-config file translates to
  // a codex config override table keyed by the bridge server name.
  const os = require("os");
  const tmpMcp = path.join(os.tmpdir(), `fusion-brain-smoke-${process.pid}.json`);
  fs.writeFileSync(
    tmpMcp,
    JSON.stringify({
      mcpServers: {
        "fusion-codex": { command: "node", args: ["adapter.cjs"], env: { A: "1" } }
      }
    })
  );
  try {
    const config = bridgeConfigFromMcpFile(tmpMcp);
    assert(
      config.mcp_servers["fusion-codex"].command === "node" &&
        config.mcp_servers["fusion-codex"].args[0] === "adapter.cjs" &&
        config.mcp_servers["fusion-codex"].env.A === "1",
      "bridgeConfigFromMcpFile should map the mcpServers entry to codex mcp_servers"
    );
  } finally {
    fs.unlinkSync(tmpMcp);
  }

  assert(
    hostSource.includes("startCodexBrain(payload)") &&
      hostSource.includes('state.engine === "codex"') &&
      hostSource.includes("createCodexBrainSession"),
    "Fusion host should dispatch codex-family planners to the codex brain engine"
  );

  console.log("Fusion chat parse smoke passed");
}

try {
  main();
} catch (error) {
  console.error(`FAIL fusion-chat-parse-smoke: ${error.message}`);
  process.exit(1);
}
