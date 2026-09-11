const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { isSamePath, normalizeThreadTitle, readJsonlRecords } = require("./agentThreads.cjs");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function geminiHome(options = {}) {
  return options.geminiHome || path.join(process.env.GEMINI_CLI_HOME || os.homedir(), ".gemini");
}
function projectHashes(cwd) {
  const paths = new Set([cwd, path.resolve(cwd)]);
  try { paths.add(fs.realpathSync(cwd)); } catch { /* absent project */ }
  return new Set([...paths].map((value) => crypto.createHash("sha256").update(value).digest("hex")));
}
function textContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(textContent).join("");
  return typeof content?.text === "string" ? content.text : "";
}
function meaningfulPrompt(message) {
  if (message?.type !== "user") return "";
  const text = textContent(message.content).trim();
  return /^(?:[/?]|<session_context>|<hook_context>)/.test(text) ? "" : normalizeThreadTitle(text);
}

// Mirrors Gemini chatRecordingService's legacy JSON / append-only JSONL $set
// metadata contract. Reads no credentials and returns no conversation bodies.
function parseGeminiTranscript(filePath, cwd, options = {}) {
  try {
    let metadata = {};
    let firstPrompt = "";
    function apply(record) {
      if (!record || typeof record !== "object") return;
      if (record.$set && typeof record.$set === "object") {
        metadata = { ...metadata, ...record.$set };
        if (Array.isArray(record.$set.messages)) {
          firstPrompt = record.$set.messages.map(meaningfulPrompt).find(Boolean) || "";
        }
      } else if (record.sessionId && record.projectHash) {
        metadata = { ...metadata, ...record };
        if (Array.isArray(record.messages)) firstPrompt = record.messages.map(meaningfulPrompt).find(Boolean) || firstPrompt;
      } else if (!firstPrompt) {
        firstPrompt = meaningfulPrompt(record);
      }
    }
    if (filePath.endsWith(".json")) {
      // Legacy format is one JSON document, sometimes pretty-printed.
      if (fs.statSync(filePath).size > 64 * 1024 * 1024) { options.onIncomplete?.(); return null; }
      apply(JSON.parse(fs.readFileSync(filePath, "utf8")));
    } else {
      for (const record of readJsonlRecords(filePath)) apply(record);
    }
    if (!UUID.test(metadata.sessionId || "") || !metadata.projectHash) { options.onIncomplete?.(); return null; }
    if (metadata.kind === "subagent" || metadata.parentSessionId || metadata.parent_session_id ||
        metadata.parentId || metadata.parent_id || metadata.parent_thread_id ||
        (options.sessionId && metadata.sessionId !== options.sessionId)) return null;
    const directories = Array.isArray(metadata.directories) ? metadata.directories : [];
    const projectMatches = projectHashes(cwd).has(metadata.projectHash) ||
      directories.some((directory) => typeof directory === "string" && isSamePath(directory, cwd));
    if (!projectMatches && !options.projectOwned) return null;
    const named = normalizeThreadTitle(metadata.name);
    const generated = normalizeThreadTitle(metadata.summary);
    const createdAt = Date.parse(metadata.startTime) || 0;
    return {
      provider: "gemini", id: metadata.sessionId,
      title: named || generated || firstPrompt,
      titleSource: named ? "named" : generated ? "generated" : "preview",
      createdAt, updatedAt: Date.parse(metadata.lastUpdated) || fs.statSync(filePath).mtimeMs,
      transcriptPath: path.resolve(filePath)
    };
  } catch { options.onIncomplete?.(); return null; }
}

function collectGeminiThreads(payload = {}, options = {}) {
  const home = geminiHome(options);
  const tmp = path.join(home, "tmp");
  let dirs;
  try { dirs = fs.readdirSync(tmp, { withFileTypes: true }); }
  catch (error) { return { threads: [], complete: error.code === "ENOENT" }; }
  let complete = true;
  let registry = {};
  try { registry = JSON.parse(fs.readFileSync(path.join(home, "projects.json"), "utf8")).projects || {}; } catch { /* optional */ }
  const slugs = new Set(Object.entries(registry).filter(([project]) => isSamePath(project, payload.cwd)).map(([, slug]) => slug));
  const excluded = new Set(payload.excludeIds || []);
  const refs = new Map();
  let visits = 0;
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    if (++visits > 20000) { complete = false; break; }
    const projectDir = path.join(tmp, dir.name);
    let projectOwned = slugs.has(dir.name);
    try {
      const marker = fs.readFileSync(path.join(projectDir, ".project_root"), "utf8").trim();
      projectOwned = isSamePath(marker, payload.cwd);
      if (!projectOwned) continue;
    } catch { /* old hash store or optional ownership marker */ }
    const chats = path.join(projectDir, "chats");
    let names;
    try { names = fs.readdirSync(chats); }
    catch (error) { if (error.code !== "ENOENT") complete = false; continue; }
    for (const name of names) {
      if (!/^session-.*\.jsonl?$/.test(name)) continue;
      if (++visits > 20000) { complete = false; break; }
      const ref = parseGeminiTranscript(path.join(chats, name), payload.cwd, { projectOwned, onIncomplete: () => { complete = false; } });
      if (!ref || ref.createdAt < Number(payload.after || 0) || excluded.has(ref.id)) continue;
      if (!refs.has(ref.id) || refs.get(ref.id).updatedAt < ref.updatedAt) refs.set(ref.id, ref);
    }
  }
  return { threads: [...refs.values()].sort((a,b) => b.updatedAt - a.updatedAt), complete };
}
function lookupGeminiThread(payload = {}, options = {}) {
  if (!payload.cwd) return { status: "failed", message: "A working directory is required." };
  const target = payload.confirmId || payload.sessionId;
  if (target && !UUID.test(target)) return { status: "missing", rootVerified: false };
  if (payload.transcriptPath) {
    const ref = parseGeminiTranscript(payload.transcriptPath, payload.cwd, { sessionId: target, trustedPath: Boolean(target) });
    if (ref) return payload.list ? { status: "found", threads: [ref] } : { status: "found", rootVerified: true, threadRef: ref };
  }
  const { threads, complete } = collectGeminiThreads(payload, options);
  if (payload.list) return { status: "found", threads, complete };
  if (target) {
    const threadRef = threads.find((ref) => ref.id === target);
    return threadRef ? { status: "found", rootVerified: true, threadRef } : { status: payload.confirmId && complete ? "missing" : "pending", rootVerified: false };
  }
  if (threads.length > 1) return { status: "ambiguous", candidates: threads, message: "Multiple Gemini sessions match; not guessing ownership." };
  if (!complete) return { status: "pending", message: "Gemini discovery is incomplete." };
  return threads.length === 1 ? { status: "found", rootVerified: true, threadRef: threads[0] } : { status: "pending" };
}
module.exports = { geminiHome, parseGeminiTranscript, collectGeminiThreads, lookupGeminiThread };
