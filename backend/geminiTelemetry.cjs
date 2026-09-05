const fs = require("fs");
const path = require("path");
const providerCapabilities = require("../shared/providerCapabilities.json");

// JSON with comments, as accepted by Gemini settings. Keep quoted strings intact.
function parseSettings(text) {
  let result = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      result += c;
      if (c === "\\") result += text[++i] || "";
      else if (c === '"') quoted = false;
    } else if (c === '"') {
      quoted = true;
      result += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      result += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      if (i >= text.length) throw new Error("Unterminated settings comment");
      i += 1;
      result += " ";
    } else result += c;
  }
  const parsed = JSON.parse(result.replace(/^\uFEFF/, ""));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Gemini defaults must be an object");
  }
  return parsed;
}

const GEMINI_EVENTS = ["SessionStart", "BeforeAgent", "BeforeModel", "BeforeTool", "AfterTool", "Notification", "AfterAgent", "SessionEnd"];

function geminiDefaultsPath(env = process.env, platform = process.platform) {
  if (env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH) return env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH;
  const systemPath = env.GEMINI_CLI_SYSTEM_SETTINGS_PATH || (platform === "win32"
    ? "C:\\ProgramData\\gemini-cli\\settings.json"
    : platform === "darwin" ? "/Library/Application Support/GeminiCli/settings.json" : "/etc/gemini-cli/settings.json");
  return path.join(path.dirname(systemPath), "system-defaults.json");
}

function prepareGeminiTelemetry({ sessionDir, nodePath, env = process.env, platform = process.platform }) {
  const capabilities = {
    ...providerCapabilities.gemini,
    nativeIdentity: "pending", nativeActivity: "pending", nativeTitle: "pending",
    verifiedCompletion: false, nativeTurnId: false, childIdentity: "transcript",
    reason: "Waiting for a root-validated Gemini hook; AfterAgent is provisional."
  };
  try {
    const defaultsPath = geminiDefaultsPath(env, platform);
    let defaults = {};
    try { defaults = parseSettings(fs.readFileSync(defaultsPath, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (defaults.hooksConfig?.enabled === false) {
      return { env: {}, capabilities: { ...capabilities, lifecycle: "unsupported", nativeActivity: "disabled", reason: "Gemini hooks are disabled in system defaults." } };
    }
    const observerPath = path.join(sessionDir, "gemini-observer.cjs");
    const overlayPath = path.join(sessionDir, "gemini-defaults.json");
    const quote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";
    let command;
    if (platform === "win32") {
      const psQuote = value => "'" + String(value).replace(/'/g, "''") + "'";
      const script = `$env:ELECTRON_RUN_AS_NODE='1'; & ${psQuote(nodePath)} ${psQuote(observerPath)}`;
      command = "powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand " + Buffer.from(script, "utf16le").toString("base64");
    } else command = `ELECTRON_RUN_AS_NODE=1 ${quote(nodePath)} ${quote(observerPath)}`;
    const hooks = { ...(defaults.hooks || {}) };
    for (const event of GEMINI_EVENTS) {
      if (hooks[event] !== undefined && !Array.isArray(hooks[event])) throw new Error(`Invalid Gemini ${event} hooks`);
      hooks[event] = [...(hooks[event] || []), {
        ...(event === "Notification" ? { matcher: "ToolPermission" } : {}),
        hooks: [{ name: `vibeterminal-observe-${event}`, type: "command", command, timeout: 3000 }]
      }];
    }
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(observerPath, geminiHookSource());
    fs.writeFileSync(overlayPath, JSON.stringify({ ...defaults, hooks }, null, 2) + "\n");
    return { env: { GEMINI_CLI_SYSTEM_DEFAULTS_PATH: overlayPath }, capabilities };
  } catch (error) {
    return { env: {}, capabilities: { ...capabilities, lifecycle: "unsupported", nativeActivity: "unavailable", reason: `Gemini instrumentation unavailable: ${error.message}` } };
  }
}

function geminiHookSource() {
  return String.raw`const fs = require("fs");
const http = require("http");
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { if (raw.length < 1024 * 1024) raw += chunk; });
process.stdin.on("end", () => {
  const finish = () => { process.stdout.write("{}"); process.exit(0); };
  let hook;
  try { hook = JSON.parse(raw); } catch { finish(); return; }
  const env = process.env;
  if (!env.VIBE_TERMINAL_CALLBACK_URL || !env.VIBE_TERMINAL_TELEMETRY_TOKEN || !env.VIBE_TERMINAL_SESSION_ID || !env.VIBE_TERMINAL_LAUNCH_NONCE) { finish(); return; }
  let rootVerified;
  let transcriptKind;
  // Read only metadata; never send prompts, responses, credentials, or tool inputs.
  if (typeof hook.transcript_path === "string" && hook.transcript_path) {
    let fd;
    try {
      fd = fs.openSync(hook.transcript_path, "r");
      const buffer = Buffer.alloc(64 * 1024);
      const text = buffer.toString("utf8", 0, fs.readSync(fd, buffer, 0, buffer.length, 0));
      let record;
      if (hook.transcript_path.endsWith(".jsonl")) record = JSON.parse(text.split(/\r?\n/)[0]);
      else {
        // Legacy JSON may be large. Do not infer identity from a partial parse.
        if (fs.fstatSync(fd).size <= buffer.length) record = JSON.parse(text);
      }
      transcriptKind = record && record.kind;
      // Ownership is confirmed centrally against cwd/project metadata. This
      // observer can reject an explicit child/mismatch but never prove a root.
      if (record && (record.kind === "subagent" || record.sessionId !== hook.session_id || record.parentSessionId || record.parent_session_id)) rootVerified = false;
    } catch {} finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
  }
  const common = {
    provider: "gemini", sessionId: env.VIBE_TERMINAL_SESSION_ID, launchNonce: env.VIBE_TERMINAL_LAUNCH_NONCE,
    providerThreadId: hook.session_id, transcriptPath: hook.transcript_path, cwd: hook.cwd,
    rootVerified, transcriptKind, timestamp: Date.now()
  };
  let event;
  switch (hook.hook_event_name) {
    case "SessionStart": event = { type: "agent.session", phase: "start", source: hook.source }; break;
    case "SessionEnd": event = { type: "agent.session", phase: "end", reason: hook.reason }; break;
    case "BeforeAgent": event = { type: "agent.running", detail: "turn-start" }; break;
    case "BeforeModel": event = { type: "agent.running", detail: "tool" }; break;
    case "BeforeTool": case "AfterTool": event = { type: "agent.activity", phase: hook.hook_event_name === "BeforeTool" ? "start" : "stop", toolName: hook.tool_name }; break;
    case "Notification": if (hook.notification_type === "ToolPermission") event = { type: "agent.waiting", detail: "approval" }; break;
    // Other AfterAgent hooks may still retry after this observer returns.
    case "AfterAgent": event = { type: "agent.response", provisional: true, retry: hook.stop_hook_active === true }; break;
  }
  if (!event) { finish(); return; }
  let url;
  try { url = new URL(env.VIBE_TERMINAL_CALLBACK_URL); } catch { finish(); return; }
  const body = JSON.stringify({ ...common, ...event });
  const req = http.request({ hostname: url.hostname, port: url.port, path: url.pathname, method: "POST", timeout: 1000,
    headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), "x-vibe-telemetry-token": env.VIBE_TERMINAL_TELEMETRY_TOKEN }
  }, response => { response.resume(); response.on("end", finish); });
  req.on("error", finish);
  req.on("timeout", () => { req.destroy(); });
  req.end(body);
});
process.stdin.resume();
`;
}

module.exports = { geminiDefaultsPath, geminiHookSource, parseSettings, prepareGeminiTelemetry };
