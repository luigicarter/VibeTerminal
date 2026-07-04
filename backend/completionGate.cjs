"use strict";

// Completion-gate tracker for Fusion / Open Fusion panes.
//
// The planner prompts REQUIRE an independent check (git evidence, reading the
// changed files, or an investigator pass) between an executor delegation
// returning and the planner presenting that work as done — but a prompt rule
// is an honor system. This module is the observability half: it watches a
// host's NORMALIZED event stream, keeps a per-pane latch (executor returned →
// evidence owed), attaches `gate: {status, evidence?, pendingSince?}` to clean
// `result` (turn-settle) events, and arms a one-shot corrective nudge the host
// rides on the next planner turn. It never blocks or rewrites anything else.
//
// Mode differences (what counts as an executor return, what counts as
// evidence, where changed files come from) live in the config each factory
// supplies; the tracker itself is host-agnostic. Feed it ONLY live normalizer
// output: rehydration and reattach-replay bypass it by design — a resumed pane
// starts with a fresh latch, because a stale one would fire a spurious nudge
// on every resume (child sessions are not rehydrated, so the changed-file set
// could never be rebuilt anyway).

const MAX_TRACKED_TOOLS = 4000;
const MAX_TRACKED_SESSIONS = 64;

const GIT_EVIDENCE_RE = /^\s*git\s+(status|diff|log|show)\b/i;

function normalizeGatePath(value, cwd) {
  let path = String(value || "").trim().replace(/\\/g, "/");
  if (!path) return "";
  const isAbsolute = path.startsWith("/") || /^[a-z]:\//i.test(path);
  const base = String(cwd || "").trim().replace(/\\/g, "/");
  if (!isAbsolute && base) {
    path = `${base.replace(/\/+$/, "")}/${path.replace(/^\.\//, "")}`;
  }
  path = path.replace(/\/+$/, "");
  return process.platform === "win32" ? path.toLowerCase() : path;
}

// Changed-file lists and planner read paths can disagree on relative vs
// absolute (the adapter's `files` may be repo-relative while claude Reads
// absolute paths). After normalization, accept an exact match or a
// /-boundary suffix match in either direction.
function gatePathsMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  return a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

function gateSetHasPath(set, path) {
  if (!path) return false;
  for (const entry of set) {
    if (gatePathsMatch(entry, path)) return true;
  }
  return false;
}

function gitEvidenceLabel(command) {
  const match = GIT_EVIDENCE_RE.exec(String(command || ""));
  return match ? `git ${match[1].toLowerCase()}` : null;
}

function readPathFromInput(input) {
  const data = input && typeof input === "object" ? input : {};
  return String(data.filePath || data.file_path || data.path || "");
}

// "read changed file" needs the changed-file set; when a delegation returned
// no usable file list the fallback is any successful planner read — without
// it such delegations would be permanently unverifiable on planners that have
// no git channel (Fusion claude).
function readEvidenceLabel(input, latch, cwd) {
  const rawPath = readPathFromInput(input);
  if (!rawPath) return null;
  if (!latch.changedFiles.size) return "read";
  return gateSetHasPath(latch.changedFiles, normalizeGatePath(rawPath, cwd))
    ? "read changed file"
    : null;
}

function capMap(map, max) {
  while (map.size > max) {
    const oldest = map.keys().next().value;
    map.delete(oldest);
  }
}

function createCompletionGateTracker(config = {}) {
  const cwd = typeof config.cwd === "string" ? config.cwd : "";
  const toolInfo = new Map(); // toolId -> {name, input, subagentType}
  const filesBySession = new Map(); // child sessionID -> Set<normalized path>
  let latch = null; // { changedFiles: Set<string>, pendingSince: number }
  // Labels of evidence that closed a latch since the last settle. Multiple
  // entries happen in checkpointed flows (verify M1, delegate M2, verify M2,
  // settle) — the settling turn then reports every check it ran.
  let evidenceLabels = [];
  let interruptedSinceSettle = false;
  let nudgePending = false;

  function openLatch(files) {
    const changedFiles = new Set();
    for (const file of Array.isArray(files) ? files : []) {
      const normalized = normalizeGatePath(file, cwd);
      if (normalized) changedFiles.add(normalized);
    }
    latch = { changedFiles, pendingSince: Date.now() };
  }

  function closeLatch(label) {
    latch = null;
    nudgePending = false;
    evidenceLabels.push(label);
  }

  function observe(event) {
    if (!event || typeof event !== "object") return event;
    switch (event.type) {
      case "tool-call": {
        if (event.toolId) {
          const input = event.input && typeof event.input === "object" ? event.input : {};
          toolInfo.set(String(event.toolId), {
            name: String(event.name || ""),
            input,
            subagentType: String(input.subagent_type || "")
          });
          capMap(toolInfo, MAX_TRACKED_TOOLS);
        }
        if (typeof config.collectChangedFile === "function") {
          const hit = config.collectChangedFile(event);
          if (hit && hit.sessionId && hit.path) {
            const key = String(hit.sessionId);
            let set = filesBySession.get(key);
            if (!set) {
              set = new Set();
              filesBySession.set(key, set);
              capMap(filesBySession, MAX_TRACKED_SESSIONS);
            }
            const normalized = normalizeGatePath(hit.path, cwd);
            if (normalized) set.add(normalized);
          }
        }
        return event;
      }
      case "tool-result": {
        const info = toolInfo.get(String(event.toolId || "")) || { name: "", input: {}, subagentType: "" };
        if (!info.name && event.name) info.name = String(event.name);
        // Executor return FIRST: a task/codex_implement result must never
        // double as evidence for the delegation it itself reported.
        const returned =
          typeof config.executorReturn === "function"
            ? config.executorReturn(info, event, filesBySession)
            : null;
        if (returned) {
          openLatch(returned.files);
          return event;
        }
        if (latch && typeof config.evidence === "function") {
          const label = config.evidence(info, event, latch);
          if (label) closeLatch(label);
        }
        return event;
      }
      case "native-tool": {
        // Codex-planner native shell (observe-only events the panes ignore).
        if (latch && typeof config.nativeEvidence === "function") {
          const label = config.nativeEvidence(event, latch);
          if (label) closeLatch(label);
        }
        return event;
      }
      case "interrupted": {
        interruptedSinceSettle = true;
        return event;
      }
      case "result": {
        const interrupted = interruptedSinceSettle;
        interruptedSinceSettle = false;
        const subtype = String(event.subtype || "");
        // An aborted/errored settle never "presented work as done": no
        // annotation, no nudge, and the latch stays owed for the next turn.
        const dirty =
          Boolean(event.isError) ||
          interrupted ||
          subtype === "aborted" ||
          subtype === "restored" ||
          /error/i.test(subtype);
        if (dirty) {
          evidenceLabels = [];
          return event;
        }
        if (evidenceLabels.length) {
          event.gate = { status: "verified", evidence: evidenceLabels.slice() };
          evidenceLabels = [];
        } else if (latch) {
          event.gate = { status: "unverified", pendingSince: latch.pendingSince };
          nudgePending = true;
        }
        return event;
      }
      default:
        return event;
    }
  }

  function consumeNudge() {
    const armed = nudgePending;
    nudgePending = false;
    return armed;
  }

  function getState() {
    return {
      latchOpen: Boolean(latch),
      changedFiles: latch ? Array.from(latch.changedFiles) : [],
      pendingSince: latch ? latch.pendingSince : 0,
      evidence: evidenceLabels.slice(),
      nudgePending
    };
  }

  return { observe, consumeNudge, getState };
}

// ---- Open Fusion (opencode planner/executor/investigator) ----
// Events carry `role` + `sessionID`; the executor-done signal is the ROOT
// `task` tool-result (its `childSessionId` links to the child session whose
// edit/write paths we accumulated); planner evidence is the git bash
// allowlist, a read of a changed file, or an investigator task.
function createOpenFusionGateTracker(options = {}) {
  const cwd = typeof options.cwd === "string" ? options.cwd : "";
  return createCompletionGateTracker({
    cwd,
    collectChangedFile(event) {
      if (event.role !== "executor") return null;
      const name = String(event.name || "");
      if (name !== "edit" && name !== "write") return null;
      const path = readPathFromInput(event.input);
      if (!path || !event.sessionID) return null;
      return { sessionId: String(event.sessionID), path };
    },
    executorReturn(info, event, filesBySession) {
      if (event.role !== "brain" || event.ok !== true) return null;
      if (String(info.name || event.name || "") !== "task") return null;
      if (info.subagentType === "investigator") return null;
      const childId = String(event.childSessionId || "");
      const files = childId ? filesBySession.get(childId) : null;
      return { files: files ? Array.from(files) : [] };
    },
    evidence(info, event, latch) {
      if (event.role !== "brain" || event.ok !== true) return null;
      const name = String(info.name || event.name || "");
      if (name === "bash") return gitEvidenceLabel(info.input.command);
      if (name === "read") return readEvidenceLabel(info.input, latch, cwd);
      if (name === "task" && info.subagentType === "investigator") return "investigator";
      return null;
    }
  });
}

// ---- Fusion (claude or codex planner over the codex bridge) ----
// All stream events are planner-side (the executor lives behind the adapter).
// The executor-done signal is a codex_implement tool-result whose JSON parses
// to status:"completed" (`needs_decision` must NOT open the latch — that turn
// is still in flight); `files` is the adapter's deduped changed-file list.
// Evidence: Read of a changed file, a codex_investigate pass, or (codex
// planner only) a native read-only shell git command / file read.
function createFusionGateTracker(options = {}) {
  const cwd = typeof options.cwd === "string" ? options.cwd : "";
  return createCompletionGateTracker({
    cwd,
    executorReturn(info, event) {
      if (event.isError) return null;
      if (!String(info.name || "").endsWith("codex_implement")) return null;
      const text = String(event.text || "");
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      if (parsed && typeof parsed === "object") {
        if (parsed.status !== "completed") return null;
        return { files: Array.isArray(parsed.files) ? parsed.files : [] };
      }
      // Unparseable but plausibly-completed result: fail toward opening the
      // latch with no file set (Read fallback applies) rather than silently
      // waiving the check.
      return /"status"\s*:\s*"completed"/.test(text) ? { files: [] } : null;
    },
    evidence(info, event, latch) {
      if (event.isError) return null;
      const name = String(info.name || "");
      if (name === "Read") return readEvidenceLabel(info.input, latch, cwd);
      if (name.endsWith("codex_investigate")) return "investigate";
      return null;
    },
    nativeEvidence(event, latch) {
      if (!event.ok) return null;
      const gitLabel = gitEvidenceLabel(event.command);
      if (gitLabel) return gitLabel;
      for (const action of Array.isArray(event.actions) ? event.actions : []) {
        if (!action || action.type !== "read") continue;
        if (!latch.changedFiles.size) return "read";
        if (gateSetHasPath(latch.changedFiles, normalizeGatePath(action.path, cwd))) {
          return "read changed file";
        }
      }
      return null;
    }
  });
}

module.exports = {
  createCompletionGateTracker,
  createFusionGateTracker,
  createOpenFusionGateTracker,
  normalizeGatePath
};
