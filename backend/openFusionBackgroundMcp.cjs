// Open Fusion background-delegation bridge: a minimal MCP stdio server the
// generated pane config registers as the "vibeterminal" local MCP server.
//
// The Brain calls `background_task` (dynamic tool name
// vibeterminal_background_task) to run a delegation DETACHED: this bridge
// POSTs the request to the app's telemetry callback server, main routes it to
// the pane's Open Fusion host, the host runs the executor on a host-created
// session, and — when it settles — wakes the Brain with the report as a new
// turn. The tool itself returns {status:"started", taskId} immediately.
// `background_cancel` rides the same channel.
//
// stdout is the MCP channel: NOTHING but MCP JSON-RPC may be written there.

const fs = require("fs");
const http = require("http");

const CALLBACK_URL = process.env.VIBE_TERMINAL_CALLBACK_URL;
const TOKEN = process.env.VIBE_TERMINAL_TELEMETRY_TOKEN;
const SESSION_ID = process.env.VIBE_TERMINAL_SESSION_ID;
const LAUNCH_NONCE = process.env.VIBE_TERMINAL_LAUNCH_NONCE;
const STATUS_MAX_BYTES = 1_000_000;

let taskSeq = 0;

const EMPTY_STATUS_NOTE = "No background tasks have run in this pane session.";
const STATUS_NOTE =
  "Read-only snapshot: peeking does not affect running tasks. The full report still arrives later as an [Open Fusion background report] message.";

function logErr(message) {
  try {
    process.stderr.write(`[openfusion-background] ${message}\n`);
  } catch {
    // ignore
  }
}

function postBackgroundRequest(entry) {
  return new Promise((resolve, reject) => {
    if (!CALLBACK_URL || !TOKEN || !SESSION_ID || !LAUNCH_NONCE) {
      reject(new Error("background bridge is not wired to the app (missing callback env)"));
      return;
    }
    let body;
    let url;
    try {
      body = JSON.stringify({
        sessionId: SESSION_ID,
        ts: Date.now(),
        type: "openfusion.background-task",
        ...entry,
        launchNonce: LAUNCH_NONCE
      });
      url = new URL(CALLBACK_URL);
    } catch (error) {
      reject(error);
      return;
    }
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        timeout: 5000,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          "x-vibe-telemetry-token": TOKEN
        }
      },
      (response) => {
        response.resume();
        if (response.statusCode && response.statusCode < 400) {
          resolve();
        } else {
          reject(new Error(`app callback refused the request (HTTP ${response.statusCode})`));
        }
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("app callback timed out")));
    req.end(body);
  });
}

function emptyBackgroundStatus() {
  return { status: "ok", tasks: [], settled: [], note: EMPTY_STATUS_NOTE };
}

function readBackgroundStatus(
  taskId,
  statusPath = process.env.VIBE_TERMINAL_BG_STATUS_FILE
) {
  const statusFile = String(statusPath || "").trim();
  let snapshot;
  try {
    if (!statusFile) return emptyBackgroundStatus();
    const stat = fs.statSync(statusFile);
    if (!stat.isFile()) throw new Error("snapshot path is not a file");
    if (stat.size > STATUS_MAX_BYTES) throw new Error(`snapshot is too large (${stat.size} bytes)`);
    const raw = fs.readFileSync(statusFile, "utf8");
    if (!raw.trim()) return emptyBackgroundStatus();
    snapshot = JSON.parse(raw);
  } catch {
    return emptyBackgroundStatus();
  }
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return emptyBackgroundStatus();
  }

  const now = Date.now();
  const tasks = (Array.isArray(snapshot.tasks) ? snapshot.tasks : []).map((entry) => {
    const task = entry && typeof entry === "object" ? { ...entry } : {};
    if (!task.state) task.state = "running";
    const startedAt = Number(task.startedAt);
    if (Number.isFinite(startedAt)) {
      task.elapsedMs = Math.max(0, now - startedAt);
    }
    return task;
  });
  const settled = (Array.isArray(snapshot.settled) ? snapshot.settled : []).map((entry) => ({
    ...(entry && typeof entry === "object" ? entry : {}),
    state: "settled"
  }));
  if (tasks.length === 0 && settled.length === 0) {
    return emptyBackgroundStatus();
  }

  const requestedId = String(taskId || "").trim();
  if (!requestedId) {
    return {
      status: "ok",
      updatedAt: snapshot.updatedAt ?? null,
      tasks,
      settled,
      note: STATUS_NOTE
    };
  }

  const task = tasks.find((entry) => String(entry.taskId || "") === requestedId);
  if (task) return { status: "ok", task, note: STATUS_NOTE };
  const settledTask = settled.find((entry) => String(entry.taskId || "") === requestedId);
  if (settledTask) return { status: "ok", task: settledTask, note: STATUS_NOTE };
  return {
    status: "error",
    error: `Unknown background taskId: ${requestedId}`,
    tasks
  };
}

const TOOLS = [
  {
    name: "background_task",
    description:
      "Run ONE executor delegation as a DETACHED background task: this call returns {status:'started', taskId, title} immediately so you can end your turn and keep talking with the user; the executor's full report arrives later as an [Open Fusion background report] message opening a new turn — review it with the SAME independent verification you apply to any task result before presenting the work. Use only when the user asked for background work or wants to keep chatting during long INDEPENDENT work; never run dependent milestones in the background concurrently. Cancel with background_cancel {taskId}.",
    inputSchema: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description: "Short (3-8 word) title for the task, shown in the UI."
        },
        prompt: {
          type: "string",
          description:
            "Complete, self-contained instructions for the executor: files, intent, constraints, acceptance criteria, and what to verify. The executor does not share your context, and no mid-turn questions are possible."
        }
      },
      required: ["prompt"]
    }
  },
  {
    name: "background_cancel",
    description:
      "Cancel a running detached background task started with background_task. The task settles as cancelled and its (partial) report is delivered like any other background settle.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" }
      },
      required: ["taskId"]
    }
  },
  {
    name: "background_status",
    description:
      "Peek at your detached background tasks WITHOUT blocking or affecting them. Without taskId, returns {status:'ok', tasks, settled}: tasks contains running snapshots (title, elapsed, update count, recent activity) and settled is bounded newest-first memory. With taskId, returns that task's detail including files touched so far. Read-only and safe in Plan mode; the full report still arrives later as an [Open Fusion background report] message. Cancel with background_cancel {taskId}.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" }
      }
    }
  }
];

function sendMcp(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function taskTitle(description, prompt) {
  const source = String(description || "").trim() || String(prompt || "").trim();
  const firstLine =
    source
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) || "background task";
  return firstLine.length > 64 ? `${firstLine.slice(0, 61)}...` : firstLine;
}

async function handleToolCall(id, params) {
  const name = params && params.name;
  const args = (params && params.arguments) || {};
  let result;
  try {
    if (name === "background_task") {
      const prompt = String(args.prompt || "").trim();
      if (!prompt) {
        result = { status: "error", error: "prompt is required" };
      } else {
        taskSeq += 1;
        const taskId = `obg-${process.pid}-${taskSeq}`;
        const title = taskTitle(args.description, prompt);
        await postBackgroundRequest({
          action: "start",
          taskId,
          description: String(args.description || ""),
          prompt
        });
        result = {
          status: "started",
          taskId,
          title,
          note:
            "The delegation is running as a detached background task. End your turn and tell the user what is running; the full report arrives as an [Open Fusion background report] message in a later turn. Review that report with your normal independent verification before acting on it."
        };
      }
    } else if (name === "background_cancel") {
      const taskId = String(args.taskId || "").trim();
      if (!taskId) {
        result = { status: "error", error: "taskId is required" };
      } else {
        await postBackgroundRequest({ action: "cancel", taskId });
        result = { status: "cancelling", taskId };
      }
    } else if (name === "background_status") {
      result = readBackgroundStatus(args.taskId);
    } else {
      sendMcp({ jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${name}` } });
      return;
    }
  } catch (error) {
    result = { status: "failed", error: error?.message || String(error) };
  }
  sendMcp({
    jsonrpc: "2.0",
    id,
    result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }
  });
}

function handleMcpLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  if (method === "initialize") {
    sendMcp({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: (params && params.protocolVersion) || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "vibeterminal", version: "0.1.0" }
      }
    });
    return;
  }
  if (method === "notifications/initialized" || method === "initialized") {
    return; // notification — no reply
  }
  if (method === "tools/list") {
    sendMcp({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    return;
  }
  if (method === "tools/call") {
    void handleToolCall(id, params);
    return;
  }
  if (method === "ping") {
    sendMcp({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (id !== undefined && id !== null) {
    sendMcp({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

function startMcpServer() {
  let stdinBuffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    stdinBuffer += chunk;
    let index;
    while ((index = stdinBuffer.indexOf("\n")) !== -1) {
      const line = stdinBuffer.slice(0, index).trim();
      stdinBuffer = stdinBuffer.slice(index + 1);
      if (line) handleMcpLine(line);
    }
  });
  process.stdin.on("end", () => {
    process.exit(0);
  });
  logErr(`started (session=${SESSION_ID || "?"})`);
}

module.exports = { taskTitle, TOOLS, readBackgroundStatus };

if (require.main === module) {
  startMcpServer();
}
