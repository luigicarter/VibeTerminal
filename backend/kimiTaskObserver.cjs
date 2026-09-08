const fs = require("fs/promises");
const path = require("path");

const SOURCE = "kimi-task-metadata";
const AGENT_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const TASK_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-z]{8}$/;
const STATUSES = new Set(["running", "completed", "failed", "timed_out", "killed", "lost"]);
const KINDS = new Set(["agent", "process", "question"]);
const MAX_BYTES = 32768;
const MAX_AGENTS = 64;
const MAX_TASKS = 256;

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

// Read only the task registry: wire history, task output, and configuration are
// deliberately outside this observer's input surface. Missing/partial evidence
// is unavailable, never proof that previously observed work has stopped.
async function readKimiTaskActivity({ home, sessionDir }) {
  const unavailable = (reason) => ({ source: SOURCE, availability: "unavailable", active: null, items: [], reason });
  const deadline = Date.now() + 2500;
  const checkTime = () => { if (Date.now() > deadline) throw new Error("scan-limit"); };
  try {
    const root = path.resolve(home);
    const session = path.resolve(sessionDir);
    if (!within(root, session) || session === root) return unavailable("outside-store");
    // Pin the canonical ancestor prefix once: Windows TEMP can contain 8.3
    // aliases. checked() still rejects a linked root or linked descendants.
    const canonicalRoot = await fs.realpath(root);
    async function checked(target, directory) {
      checkTime();
      if (!within(root, target)) throw new Error("outside-store");
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw new Error("unsafe-path");
      const actual = await fs.realpath(target);
      if (path.relative(path.join(canonicalRoot, path.relative(root, target)), actual) !== "") throw new Error("unsafe-path");
      return stat;
    }
    await checked(root, true);
    let current = root;
    for (const component of path.relative(root, session).split(path.sep)) {
      current = path.join(current, component);
      await checked(current, true);
    }
    const agentsDir = path.join(session, "agents");
    await checked(agentsDir, true);
    await checked(path.join(agentsDir, "main"), true);
    await checked(path.join(agentsDir, "main", "tasks"), true);
    async function entries(directory, limit) {
      const result = [];
      const handle = await fs.opendir(directory);
      try {
        for await (const entry of handle) {
          checkTime();
          if (result.length >= limit) throw new Error("scan-limit");
          result.push(entry);
        }
      } finally {
        await handle.close().catch(() => {});
      }
      return result;
    }
    const items = [];
    let taskCount = 0;
    for (const agent of await entries(agentsDir, MAX_AGENTS)) {
      if (!AGENT_ID.test(agent.name)) throw new Error("invalid-agent-id");
      const agentDir = path.join(agentsDir, agent.name);
      await checked(agentDir, true);
      const tasksDir = path.join(agentDir, "tasks");
      try { await checked(tasksDir, true); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      for (const entry of await entries(tasksDir, MAX_TASKS)) {
        // Native task output lives in sibling task-id directories. Never enter.
        if (entry.isDirectory() && TASK_ID.test(entry.name)) continue;
        if (!entry.name.endsWith(".json")) throw new Error("unsupported-task-entry");
        const taskId = entry.name.slice(0, -5);
        if (!TASK_ID.test(taskId) || ++taskCount > MAX_TASKS) throw new Error("scan-limit");
        const file = path.join(tasksDir, entry.name);
        const before = await checked(file, false);
        if (before.size > MAX_BYTES) throw new Error("metadata-too-large");
        const handle = await fs.open(file, "r");
        let raw;
        try {
          const opened = await handle.stat();
          if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("metadata-changed");
          const buffer = Buffer.alloc(MAX_BYTES + 1);
          let length = 0;
          while (length < buffer.length) {
            checkTime();
            const read = await handle.read(buffer, length, buffer.length - length, length);
            if (!read.bytesRead) break;
            length += read.bytesRead;
          }
          const after = await handle.stat();
          if (length > MAX_BYTES || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error("metadata-changed");
          const final = await checked(file, false);
          if (final.dev !== before.dev || final.ino !== before.ino || final.size !== before.size || final.mtimeMs !== before.mtimeMs) throw new Error("metadata-changed");
          raw = JSON.parse(buffer.subarray(0, length).toString("utf8"));
        } finally { await handle.close(); }
        if (!raw || raw.taskId !== taskId || !KINDS.has(raw.kind) || !STATUSES.has(raw.status) ||
            !Number.isFinite(raw.startedAt) || raw.startedAt <= 0 ||
            !(raw.endedAt === null || (Number.isFinite(raw.endedAt) && raw.endedAt >= raw.startedAt)) ||
            (raw.status === "running" ? raw.endedAt !== null : raw.endedAt === null) ||
            (raw.agentId !== undefined && (typeof raw.agentId !== "string" || !AGENT_ID.test(raw.agentId)))) throw new Error("invalid-metadata");
        items.push({ id: `${agent.name}/${taskId}`, ownerAgentId: agent.name, taskId,
          ...(raw.agentId ? { agentId: raw.agentId } : {}), kind: raw.kind, status: raw.status,
          startedAt: raw.startedAt, endedAt: raw.endedAt });
      }
    }
    return { source: SOURCE, availability: "available", active: items.some((item) => item.status === "running"), items };
  } catch (error) {
    return unavailable(error.code === "ENOENT" ? "metadata-unavailable" : "incomplete-scan");
  }
}

module.exports = { readKimiTaskActivity };
