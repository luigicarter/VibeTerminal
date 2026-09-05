"use strict";

const { randomUUID } = require("node:crypto");
const path = require("node:path");

function cleanTitle(value) {
  return typeof value === "string" ? value.replace(/[\x00-\x1f\x7f-\x9f]/g, "").trim().slice(0, 512) : "";
}
function normalizedPath(value) {
  const resolved = path.resolve(value || ".");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
function timestamp(value, fallback) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// Owns observations independently of mounted renderer panes. No inference from
// terminal output, keystrokes, elapsed silence, or a clean shell/CLI exit.
function createTerminalRuntime({ emit = () => {}, now = Date.now, lookup, capabilities = () => ({}) } = {}) {
  const records = new Map();
  let timer = null;
  const metadataReads = new Map();

  function publish(record) {
    record.snapshot.revision += 1;
    record.snapshot.updatedAt = now();
    record.snapshot.childActivity = record.snapshot.children.length > 0 || record.coarseDepth > 0 || record.coarseBackground;
    const snapshot = structuredClone(record.snapshot);
    emit(snapshot);
    return snapshot;
  }
  function get(id) { return records.get(id); }
  function current(id, generation) {
    const record = get(id);
    return Boolean(record && !record.closed && !record.cancelled && record.snapshot.generation === generation);
  }
  function matches(payload) {
    const record = get(payload?.id);
    return Boolean(record && !record.closed &&
      (payload.generation === undefined || payload.generation === record.snapshot.generation) &&
      (payload.launchToken === undefined || Number(payload.launchToken) === record.snapshot.launchToken));
  }
  function beginLaunch(payload) {
    const old = get(payload.id);
    const launchToken = Number(payload.launchToken || 0);
    if (old && launchToken <= old.snapshot.launchToken) {
      if (launchToken < old.snapshot.launchToken || old.closed) return { disposition: "stale", generation: old.snapshot.generation };
      return { disposition: "attach", generation: old.snapshot.generation, record: old };
    }
    const provider = payload.provider || "terminal";
    const generation = randomUUID();
    const startedAt = now();
    const record = {
      closed: false, preparing: true, startedAt, lookupInFlight: false, coarseDepth: 0, coarseBackground: false,
      identityHints: new Map(), pendingEvents: [], retiredTurnIds: new Set(), nextLookupAt: 0, lookupFailures: 0,
      nativeActive: false, pendingPriorTurnId: undefined,
      transcriptPath: undefined, explicitRef: payload.threadRef,
      claudeHome: payload.providerProfileId ? "custom" : undefined,
      snapshot: {
        id: payload.id, generation, launchToken, revision: 0, provider, cwd: payload.cwd,
        processState: "starting", agentProcessState: "unknown", turnState: "unknown",
        observation: "unavailable", telemetryHealth: provider === "terminal" ? "unavailable" : "pending", updatedAt: startedAt,
        activeTools: [], children: [], childActivity: false,
        binding: { status: provider === "terminal" ? "unavailable" : "pending" },
        capabilities: capabilities(provider)
      }
    };
    records.set(payload.id, record);
    if (payload.threadRef?.id && payload.threadRef.provider === provider && !bind(record, payload.threadRef, true)) {
      record.preparing = false;
      record.rejected = true;
      record.snapshot.processState = "failed";
      record.snapshot.binding = { status: "ambiguous", message: "This conversation already belongs to another open pane." };
      publish(record);
      return { disposition: "conflict", generation, record, previousGeneration: old?.snapshot.generation };
    }
    publish(record);
    return { disposition: "new", generation, record, previousGeneration: old?.snapshot.generation };
  }
  function owned(provider, id, exceptId, home) {
    return Array.from(records.values()).some((record) => !record.closed &&
      record.snapshot.id !== exceptId && record.snapshot.provider === provider && record.claudeHome === home && record.snapshot.conversation?.id === id);
  }
  function bind(record, ref, authoritative = false, liveTitle = false) {
    if (!ref?.id) return false;
    const s = record.snapshot;
    // Root binding is stable. Child metadata and cwd-recency results cannot
    // replace it. A conversation belongs to one open pane in its provider home.
    if (s.conversation?.id && s.conversation.id !== ref.id) return false;
    if (owned(s.provider, ref.id, s.id, record.claudeHome)) return false;
    const previous = s.conversation;
    const title = cleanTitle(ref.title);
    const source = ref.titleSource === "native" ? "generated" :
      ["named", "generated", "preview"].includes(ref.titleSource) ? ref.titleSource : undefined;
    const ranks = { named: 3, generated: 2, preview: 1 };
    const candidateUpdatedAt = timestamp(ref.updatedAt, now());
    const replaceTitle = title && (!previous?.title ||
      (candidateUpdatedAt >= (record.titleObservedAt || 0) &&
        (liveTitle || (ranks[source] || 0) >= (ranks[previous.titleSource] || 0))));
    if (replaceTitle) record.titleObservedAt = candidateUpdatedAt;
    s.conversation = {
      provider: s.provider, id: ref.id,
      title: replaceTitle ? title : previous?.title,
      titleSource: replaceTitle ? source : previous?.titleSource,
      createdAt: timestamp(ref.createdAt, previous?.createdAt || now()),
      updatedAt: timestamp(ref.updatedAt, now())
    };
    s.binding = { status: "found" };
    return true;
  }
  function isChild(record, event) {
    return Boolean(event.parentThreadId || event.transcriptKind === "subagent" ||
      (event.providerThreadId && record.snapshot.conversation?.id &&
        event.providerThreadId !== record.snapshot.conversation.id));
  }
  function clearInput(record) {
    record.snapshot.pendingInput = undefined;
    record.snapshot.pendingInputAt = undefined;
    record.pendingPriorTurnId = undefined;
  }
  function recordInput(payload) {
    if (!matches(payload)) return null;
    const record = get(payload.id);
    const s = record.snapshot;
    if (s.provider === "terminal" || s.processState !== "running") return null;
    const submit = typeof payload.data === "string" && /(?:\r\n|\r|\n)$/.test(payload.data) && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(payload.data);
    const interrupt = payload.data === "\x1b" || payload.data === "\x03";
    if (!submit && !(interrupt && record.nativeActive && s.turnState === "running")) return null;
    // Enter during proven ongoing work is steering/menu input, except when it
    // follows an explicit interrupt request and begins a new submission intent.
    if (submit && record.nativeActive && s.turnState === "running" && s.pendingInput !== "interrupt") return null;
    const approvalReply = submit && s.turnState === "waiting" && s.attention?.reason === "approval";
    const intent = submit ? "submit" : "interrupt";
    if (s.pendingInput === intent) return null;
    record.pendingPriorTurnId = approvalReply ? undefined : s.turnId;
    s.pendingInput = intent;
    s.pendingInputAt = now();
    s.observation = "provisional";
    if (submit) s.attention = undefined;
    return publish(record);
  }
  function releaseInput(payload) {
    if (!matches(payload)) return null;
    const record = get(payload.id), s = record.snapshot;
    // Only undo the exact reservation after a definitive transport rejection.
    if (s.pendingInput !== "submit" || s.revision !== payload.revision) return null;
    clearInput(record);
    return publish(record);
  }
  function ingest(event) {
    if (!event?.id || !current(event.id, event.generation)) return null;
    const record = get(event.id);
    const s = record.snapshot;
    if (event.launchToken !== undefined && Number(event.launchToken) !== s.launchToken) return null;
    if (event.type === "data") return null;
    const observed = event.type.startsWith("agent-");
    const explicitlyChild = Boolean(event.parentThreadId || event.transcriptKind === "subagent");
    if (observed) {
      s.telemetryHealth = "available";
      if (event.providerThreadId && !s.conversation?.id && !explicitlyChild && event.rootVerified !== false &&
          ["agent-session", "agent-running", "agent-attention", "agent-response", "agent-activity", "agent-subagent"].includes(event.type)) {
        if (event.rootVerified === true) {
          if (!bind(record, { id: event.providerThreadId }, true)) {
            s.binding = { status: "ambiguous", message: "Provider identity belongs to another open pane." };
            s.observation = "provisional";
            return publish(record);
          }
          replayPending(record);
        } else {
          // A nonce proves pane ownership, not root-thread ownership: subagents
          // inherit that environment. Retain lifecycle observations until local
          // metadata confirms this hinted id is a root conversation.
          record.identityHints.set(event.providerThreadId, event.transcriptPath);
          record.pendingEvents.push({ ...event, observedAt: event.observedAt || now() });
          if (record.pendingEvents.length > 128) record.pendingEvents.shift();
          s.observation = "provisional";
          return publish(record);
        }
      }
    }
    const child = isChild(record, event);
    if (observed && event.rootVerified === false && !child && event.type !== "agent-process") return publish(record);
    if (event.transcriptPath && !child && event.rootVerified === true &&
        event.providerThreadId === s.conversation?.id) record.transcriptPath = event.transcriptPath;
    const eventAt = event.observedAt || now();
    switch (event.type) {
      case "created":
        record.preparing = false;
        s.processState = "running";
        break;
      case "snapshot":
        record.preparing = false;
        s.processState = event.isRunning ? "running" : "exited";
        if (event.terminalTitle !== undefined) s.terminalTitle = cleanTitle(event.terminalTitle);
        break;
      case "title": s.terminalTitle = cleanTitle(event.title); break;
      case "error":
        record.preparing = false;
        record.rejected = true;
        s.processState = "failed";
        s.telemetryHealth = "unavailable";
        s.binding = { status: s.binding.status === "found" ? "found" : "unavailable", message: event.message || "Terminal launch failed." };
        break;
      case "exit":
        record.preparing = false;
        s.processState = "exited";
        break;
      case "agent-process": {
        // Nested CLI shims inherit pane credentials. Only the first identified
        // root invocation owns process state for this launch; later invocations
        // require an explicit pane restart to establish a new root/binding.
        const processId = typeof event.processId === "string" && event.processId ? event.processId : undefined;
        if (!processId) break;
        if (!record.rootProcessId && event.phase === "start") record.rootProcessId = processId;
        if (processId !== record.rootProcessId) break;
        if (event.phase === "start" && ["exited", "failed"].includes(s.agentProcessState)) break;
        s.agentProcessState = event.phase === "start" ? "running" : event.exitCode || event.error ? "failed" : "exited";
        if (event.phase === "start") s.observation = "observed";
        break;
      }
      case "agent-session":
        if (!child && event.title && event.providerThreadId) bind(record,
          { id: event.providerThreadId, title: event.title, titleSource: event.titleSource, updatedAt: eventAt }, true, true);
        if (!child && event.phase === "start" && s.turnState === "unknown") {
          s.turnState = "idle";
          s.observation = "observed";
        }
        break;
      case "agent-running":
        if (child) {
          const id = event.taskId || event.providerThreadId;
          if (id && !s.children.some((entry) => entry.id === id)) s.children.push({ id, label: event.taskLabel, startedAt: eventAt });
          break;
        }
        if (event.providerTurnId && record.retiredTurnIds.has(event.providerTurnId)) break;
        if (event.turnStart === false && s.pendingInput === "submit" && record.pendingPriorTurnId &&
            event.providerTurnId === record.pendingPriorTurnId) break;
        if (event.turnStart === false && event.providerTurnId && s.turnId && event.providerTurnId !== s.turnId) break;
        if (event.turnStart === false && ["completed", "failed", "interrupted"].includes(s.turnState)) break;
        if (event.providerTurnId && event.providerTurnId === s.turnId &&
            ["completed", "failed", "interrupted"].includes(s.turnState)) break;
        const newTurn = !s.turnStartedAt ||
          (event.providerTurnId && s.turnId !== event.providerTurnId) ||
          (event.turnStart !== false && ["completed", "failed", "interrupted", "idle"].includes(s.turnState));
        if (newTurn) {
          if (s.turnId && event.providerTurnId !== s.turnId) record.retiredTurnIds.add(s.turnId);
          s.activeTools = [];
          s.lastTool = undefined;
          s.attention = undefined;
          s.turnStartedAt = eventAt;
        }
        s.turnId = event.providerTurnId || (newTurn ? undefined : s.turnId);
        s.turnEndedAt = undefined;
        if (s.attention?.state === "waiting") s.attention = undefined;
        clearInput(record);
        record.nativeActive = true;
        s.turnState = "running";
        s.observation = "observed";
        break;
      case "agent-response":
        if (!child) { clearInput(record); s.turnState = "response"; s.observation = "provisional"; s.turnEndedAt = eventAt; }
        break;
      case "agent-attention": {
        if (child) {
          if (event.attention?.state !== "waiting") {
            s.children = s.children.filter((entry) => entry.id !== (event.taskId || event.providerThreadId));
          }
          break;
        }
        if (!event.attention) break;
        if (event.providerTurnId && record.retiredTurnIds.has(event.providerTurnId)) break;
        if (s.pendingInput === "submit" && event.observedAt && event.observedAt < s.pendingInputAt) break;
        if (s.pendingInput === "submit" && record.pendingPriorTurnId && event.providerTurnId === record.pendingPriorTurnId) break;
        if (event.providerTurnId && s.turnId && event.providerTurnId !== s.turnId) {
          const notifyOnlyCompletion = s.provider === "codex" && s.capabilities?.finalCompletion === "authoritative" &&
            event.attention.state === "completed" && event.providerThreadId && !record.nativeActive &&
            (["completed", "failed", "interrupted", "unknown", "idle", "response"].includes(s.turnState) || s.pendingInput === "submit");
          if (!notifyOnlyCompletion) break;
          record.retiredTurnIds.add(s.turnId);
          s.turnId = event.providerTurnId;
          // Notify proves an outcome, not when an unobserved turn started.
          s.turnStartedAt = undefined;
          s.turnEndedAt = undefined;
          s.attention = undefined;
        }
        // Legacy wrappers emitted task completion for process exit. It is not a
        // completed model turn and must never manufacture a completion badge.
        if (event.attention.reason === "exit") break;
        const attention = event.attention;
        // Replayed hooks can carry a freshly generated transport id. The same
        // semantic occurrence keeps its original attention identity/timestamps;
        // an accepted new turn or resumed wait clears attention before this path.
        if (s.attention && s.attention.state === attention.state &&
            s.attention.reason === attention.reason &&
            (!event.providerTurnId || event.providerTurnId === s.turnId)) break;
        clearInput(record);
        if (attention.state === "completed" &&
            (s.capabilities?.finalCompletion !== "authoritative" || !event.providerThreadId || !event.providerTurnId)) {
          // A coarse Stop can describe a child or an intermediate response, even
          // when it shares the root session id. Never cache it as final work
          // that would become completed merely because child activity closes.
          s.turnState = "response";
          s.observation = "provisional";
          s.turnEndedAt = eventAt;
          s.activeTools = [];
          s.attention = undefined;
          break;
        }
        s.turnId = event.providerTurnId || s.turnId;
        record.nativeActive = attention.state === "waiting";
        s.turnState = attention.reason === "interrupted" ? "interrupted" :
          attention.state === "completed" ? "completed" : attention.state === "failed" ? "failed" : "waiting";
        s.observation = "observed";
        s.attention = { id: randomUUID(), state: attention.state,
          reason: attention.reason, updatedAt: timestamp(attention.updatedAt, now()) };
        if (s.turnState !== "waiting") { s.activeTools = []; s.turnEndedAt = eventAt; }
        break;
      }
      case "agent-activity": {
        if (!child && event.providerTurnId && record.retiredTurnIds.has(event.providerTurnId)) break;
        if (!child && event.providerTurnId && s.turnId && event.providerTurnId !== s.turnId) {
          if (event.phase !== "start" || s.pendingInput !== "submit") break;
          record.retiredTurnIds.add(s.turnId);
          s.turnId = event.providerTurnId;
          s.turnStartedAt = eventAt;
          s.turnEndedAt = undefined;
          s.attention = undefined;
        }
        if (!child && s.pendingInput &&
            !(s.pendingInput === "submit" && event.providerTurnId && event.providerTurnId === record.pendingPriorTurnId)) {
          const newObservedTurn = s.pendingInput === "submit" && ["completed", "failed", "interrupted", "idle", "response"].includes(s.turnState);
          if (newObservedTurn && !event.providerTurnId) {
            if (s.turnId) record.retiredTurnIds.add(s.turnId);
            s.turnId = undefined;
          }
          clearInput(record);
          record.nativeActive = true;
          if (newObservedTurn) s.turnStartedAt = eventAt;
          s.turnState = "running";
          s.observation = "observed";
          s.turnEndedAt = undefined;
          if (!s.turnStartedAt) s.turnStartedAt = eventAt;
        }
        const isTask = Boolean(event.taskId || child || event.kind === "task" || event.kind === "subagent" || /^(task|agent)$/i.test(event.toolName || ""));
        const stableId = event.taskId || event.toolId || (child ? event.providerThreadId : undefined);
        if (isTask && !stableId) {
          record.coarseDepth = Math.max(0, Math.min(10000, record.coarseDepth + (event.phase === "start" ? 1 : -1)));
          break;
        }
        const id = String(stableId || event.toolName || "activity");
        const field = isTask ? "children" : "activeTools";
        const previous = s[field].find((entry) => entry.id === id);
        if (!isTask) s.lastTool = { id, name: cleanTitle(event.toolName) || previous?.name || "Tool",
          startedAt: previous?.startedAt || now(), ...(event.phase === "stop" ? { endedAt: now() } : {}) };
        s[field] = s[field].filter((entry) => entry.id !== id);
        if (event.phase === "start") s[field].push(isTask ?
          { id, label: cleanTitle(event.taskLabel || event.toolName), startedAt: now() } :
          { id, name: cleanTitle(event.toolName) || "Tool", startedAt: now() });
        break;
      }
      case "agent-subagent": {
        // Typed activity and legacy brackets share the same id, so their
        // duplicate start/stop delivery remains idempotent.
        const id = event.taskId || event.toolId || (child ? event.providerThreadId : undefined);
        if (!id) {
          record.coarseDepth = Math.max(0, Math.min(10000, record.coarseDepth + (event.phase === "start" ? 1 : -1)));
          break;
        }
        if (event.phase === "start") {
          if (!s.children.some((entry) => entry.id === id)) s.children.push({ id, label: event.taskLabel, startedAt: now() });
        } else s.children = s.children.filter((entry) => entry.id !== id);
        break;
      }
      case "agent-background-activity": {
        const activity = event.backgroundActivity;
        if (!activity) break;
        s.children = s.children.filter((entry) => !entry.id.startsWith("background:"));
        record.coarseBackground = false;
        if (activity.active) {
          const items = Array.isArray(activity.items) ? activity.items : [];
          for (const item of items) {
            const id = item.id || item.taskId;
            if (id) s.children.push({ id: `background:${id}`, label: cleanTitle(item.label || item.title || item.description), startedAt: timestamp(item.startedAt, eventAt) });
          }
          if (!items.some((item) => item.id || item.taskId)) record.coarseBackground = true;
        }
        break;
      }
      default: return null;
    }
    return publish(record);
  }
  function stop(payload) {
    if (!matches(payload)) return null;
    const record = get(payload.id);
    record.closed = true;
    record.preparing = false;
    record.snapshot.processState = "exited";
    // Retain evidence internally, but closed panes leave the snapshot inventory.
    return publish(record);
  }
  function hostExited(message) {
    for (const record of records.values()) {
      if (record.closed || record.snapshot.processState === "exited") continue;
      record.preparing = false;
      record.cancelled = true;
      record.snapshot.processState = "failed";
      record.snapshot.telemetryHealth = "unavailable";
      record.snapshot.binding.message = message;
      publish(record);
    }
  }
  function replayPending(record) {
    const pending = record.pendingEvents.splice(0);
    record.identityHints.clear();
    for (const event of pending) ingest(event);
  }
  async function readMetadata(payload) {
    const key = JSON.stringify(payload);
    const cached = metadataReads.get(key);
    if (cached && cached.expiresAt > now()) return cached.promise;
    // Expired results are removed without a second timer; the shared scheduler
    // owns cadence. Concurrent panes use one filesystem/CLI lookup per key.
    for (const [oldKey, value] of metadataReads) if (value.expiresAt <= now()) metadataReads.delete(oldKey);
    const promise = Promise.resolve().then(() => lookup(payload));
    metadataReads.set(key, { promise, expiresAt: now() + 8000 });
    return promise;
  }
  async function refreshRecord(record) {
    const s = record.snapshot;
    if (!lookup || record.closed || record.cancelled || record.rejected || record.lookupInFlight || s.provider === "terminal" || now() < record.nextLookupAt) return;
    record.lookupInFlight = true;
    record.nextLookupAt = now() + 8000;
    const generation = s.generation;
    const knownId = s.conversation?.id;
    try {
      const excluded = Array.from(records.values()).filter((entry) => !entry.closed &&
        entry.snapshot.id !== s.id && entry.snapshot.provider === s.provider && entry.claudeHome === record.claudeHome)
        .map((entry) => entry.snapshot.conversation?.id).filter(Boolean);
      let result;
      if (!knownId && record.identityHints.size) {
        for (const [hintId, transcriptPath] of record.identityHints) {
          const confirmed = await readMetadata({ provider: s.provider, cwd: s.cwd, claudeHome: record.claudeHome,
            confirmId: hintId, transcriptPath });
          if (!current(s.id, generation) || s.conversation?.id !== knownId) return;
          if (confirmed?.status === "found" && confirmed.threadRef?.id === hintId &&
              confirmed.rootVerified === true && !confirmed.threadRef.parentThreadId &&
              !owned(s.provider, hintId, s.id, record.claudeHome)) {
            record.lookupFailures = 0;
            bind(record, confirmed.threadRef, true);
            if (transcriptPath) record.transcriptPath = transcriptPath;
            replayPending(record);
            publish(record);
            return;
          }
        }
      }
      const groupStart = Math.min(...Array.from(records.values()).filter((entry) => !entry.closed &&
        entry.snapshot.provider === s.provider && entry.claudeHome === record.claudeHome &&
        normalizedPath(entry.snapshot.cwd) === normalizedPath(s.cwd)).map((entry) => entry.startedAt));
      result = await readMetadata({ provider: s.provider, cwd: normalizedPath(s.cwd), claudeHome: record.claudeHome,
        ...(knownId ? { confirmId: knownId, transcriptPath: record.transcriptPath } :
          { list: true, after: groupStart, excludeIds: [] }) });
      if (!current(s.id, generation)) return;
      // Authoritative identity may have arrived while this lookup was in flight.
      // Never apply an old unbound lookup over that newly established root.
      if (s.conversation?.id !== knownId) return;
      if (result?.status === "failed") {
        record.lookupFailures += 1;
        record.nextLookupAt = now() + Math.min(60000, 8000 * 2 ** Math.min(record.lookupFailures, 3));
      } else record.lookupFailures = 0;
      if (knownId) {
        if (result?.status === "found" && result.threadRef?.id === knownId) bind(record, result.threadRef, true);
      } else {
        const candidates = (result?.threads || (result?.threadRef ? [result.threadRef] : []))
          .filter((ref) => ref.id && !excluded.includes(ref.id) &&
            timestamp(ref.createdAt, 0) >= record.startedAt - 2000);
        // Two unbound panes launched concurrently in the same provider/cwd
        // cannot safely claim the sole newly-created candidate by polling order.
        const competing = Array.from(records.values()).some((other) => other !== record && !other.closed && !other.rejected &&
          other.snapshot.provider === s.provider && other.claudeHome === record.claudeHome && !other.snapshot.conversation?.id &&
          normalizedPath(other.snapshot.cwd) === normalizedPath(s.cwd));
        if (result?.complete === false) {
          s.binding = { status: "pending", message: "Metadata scan incomplete; awaiting provider identity or retry." };
        } else if (candidates.length === 1 && !competing) bind(record, candidates[0]);
        else if (candidates.length > 1 || (candidates.length && competing)) {
          s.binding = { status: "ambiguous", message: "Multiple panes or conversations match; awaiting provider identity." };
        } else if (result?.status === "failed") {
          s.binding = { status: "unavailable", message: result.message || "Metadata unavailable; retrying." };
        } else s.binding = { status: "pending" };
      }
      if (s.conversation?.id) replayPending(record);
      publish(record);
    } catch (error) {
      record.lookupFailures += 1;
      record.nextLookupAt = now() + Math.min(60000, 8000 * 2 ** Math.min(record.lookupFailures, 3));
      if (current(s.id, generation) && s.conversation?.id === knownId) {
        s.binding = { status: knownId ? "found" : "unavailable", message: error.message };
        publish(record);
      }
    } finally { record.lookupInFlight = false; }
  }
  async function refresh() {
    await Promise.all(Array.from(records.values()).map(refreshRecord));
  }
  function start() {
    if (!timer) { timer = setInterval(() => { void refresh(); }, 8000); timer.unref?.(); }
  }
  function dispose() { if (timer) clearInterval(timer); timer = null; metadataReads.clear(); }
  return { beginLaunch, isCurrent: current, matches, recordInput, releaseInput, ingest, stop, hostExited, refresh, refreshRecord, start, dispose,
    getRecord: get, getSnapshot: (id) => { const r = get(id); return r && !r.closed ? structuredClone(r.snapshot) : null; },
    listSnapshots: () => Array.from(records.values()).filter((r) => !r.closed).map((r) => structuredClone(r.snapshot)) };
}

module.exports = { createTerminalRuntime, cleanTitle };
