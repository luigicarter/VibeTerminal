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
  createStreamNormalizer,
  windowsCmdArg
} = require("../../backend/fusionChatHost.cjs");

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
        { type: "tool_result", tool_use_id: "tool-1", content: '{"status":"completed"}' },
        { type: "tool_result", tool_use_id: "agent-1", content: "done", is_error: true }
      ]
    }
  },
  { type: "result", subtype: "success", total_cost_usd: 0.012 }
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

  console.log("Fusion chat parse smoke passed");
}

try {
  main();
} catch (error) {
  console.error(`FAIL fusion-chat-parse-smoke: ${error.message}`);
  process.exit(1);
}
