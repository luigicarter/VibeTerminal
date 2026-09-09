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
function isQuestionTool(provider, name) {
  return provider === "claude" ? name === "AskUserQuestion" :
    provider === "grok" && ["ask_user_question", "AskUserQuestion"].includes(name);
}

// Owns observations independently of mounted renderer panes. No inference from
// terminal output, keystrokes, elapsed silence, or a clean shell/CLI exit.
function createTerminalRuntime({ emit = () => {}, now = Date.now, lookup, capabilities = () => ({}) } = {}) {
  const records = new Map();
  let timer = null;
  const metadataReads = new Map();

  function publish(record) {
    if (record.snapshot.processState !== "running" ||
        ["exited", "failed"].includes(record.snapshot.agentProcessState)) record.snapshot.pendingTurnActivity = undefined;
    if (record.rootIdentityConflict) {
      record.snapshot.binding = { status: "ambiguous", message: "Another native root conversation was observed. Restart this pane to verify the current conversation." };
      record.snapshot.observation = "unavailable";
    }
    record.snapshot.revision += 1;
    record.snapshot.updatedAt = now();
    record.snapshot.coarseChildObservation = record.coarseDepth > 0 ? "observed" : record.coarseProvisional ? "provisional" : undefined;
    record.snapshot.childActivity = record.snapshot.children.length > 0 || record.coarseDepth > 0 || record.coarseProvisional || record.coarseBackground;
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
      closed: false, preparing: true, startedAt, lookupInFlight: false, coarseDepth: 0, coarseProvisional: false, coarseBackground: false,
      identityHints: new Map(), pendingEvents: [], retiredTurnIds: new Set(), resolvedQuestionToolIds: new Set(), nextLookupAt: 0, lookupFailures: 0,
      nativeActive: false, pendingPriorTurnId: undefined, settledToolIds: new Set(), childStops: new Map(),
      transcriptPath: undefined, explicitRef: payload.threadRef,
      claudeHome: payload.providerProfileId ? "custom" : undefined,
      snapshot: {
        id: payload.id, generation, launchToken, revision: 0, provider, cwd: payload.cwd,
        processState: "starting", agentProcessState: "unknown", turnState: "unknown",
        observation: "unavailable", telemetryHealth: provider === "terminal" ? "unavailable" : "pending", updatedAt: startedAt,
        activeTools: [], children: [], childActivity: false, activityObserved: false,
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
    if (!ref?.id || record.rootIdentityConflict) return false;
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
    record.snapshot.pendingTurnActivity = undefined;
    record.pendingTurnEnded = false;
    record.pendingTurnEventAt = undefined;
    record.pendingTurnTools = undefined;
    record.pendingPriorTurnId = undefined;
  }
  // Display evidence for the old turn must never acknowledge a later submit.
  // Consume its running/end callbacks; tool bookkeeping can still proceed.
  function observePendingTurn(record, event, child) {
    const s = record.snapshot;
    if (child || s.pendingInput !== "submit" || !record.pendingPriorTurnId ||
        event.providerTurnId !== record.pendingPriorTurnId || event.providerThreadId !== s.conversation?.id ||
        !["agent-running", "agent-activity", "agent-attention", "agent-response"].includes(event.type)) return false;
    const at = event.observedAt;
    if (!Number.isFinite(at) || at <= s.pendingInputAt || at < (record.pendingTurnEventAt || 0) ||
        record.pendingTurnEnded || record.retiredTurnIds.has(event.providerTurnId)) return true;
    const previous = s.pendingTurnActivity;
    if (event.type === "agent-response" || (event.type === "agent-attention" &&
        ["completed", "failed"].includes(event.attention?.state) && event.attention.reason !== "exit")) {
      s.pendingTurnActivity = undefined;
      record.pendingTurnEnded = true;
      record.displayEndedTurnId = event.providerTurnId;
      record.pendingTurnEventAt = at;
      clearActiveTools(record);
      return true;
    }
    if (event.type === "agent-attention") {
      if (event.attention?.state === "waiting") {
        s.pendingTurnActivity = { turnId: s.turnId, state: "waiting", observedAt: at,
          attention: previous?.state === "waiting" && previous.attention?.reason === event.attention.reason ? previous.attention :
            { id: randomUUID(), state: "waiting", reason: event.attention.reason, toolId: event.toolId, updatedAt: at } };
        record.pendingTurnEventAt = at;
      }
      return true;
    }
    // Replayed native starts, old tools, and returns alone do not prove new work.
    if (event.type === "agent-running" && event.turnStart !== false) return true;
    const tools = record.pendingTurnTools;
    const fresh = event.phase !== "stop" && (!event.toolId ? event.type === "agent-running" :
      !tools?.has(event.toolId) && !record.settledToolIds.has(event.toolId));
    const resolvesWait = previous?.state === "waiting" && event.phase === "stop" &&
      event.toolId && event.toolId === previous.attention?.toolId;
    if ((fresh && previous?.state !== "waiting") || resolvesWait) {
      s.pendingTurnActivity = { turnId: s.turnId, state: "running", observedAt: at };
      record.pendingTurnEventAt = at;
    }
    if (event.toolId) tools?.add(event.toolId);
    if (tools?.size > 1024) tools.delete(tools.values().next().value);
    return event.type !== "agent-activity";
  }
  function childId(record, event) {
    return event.taskId || (event.providerThreadId !== record.snapshot.conversation?.id ? event.providerThreadId : undefined) || event.toolId;
  }
  function observeChild(record, event, eventAt) {
    const id = childId(record, event);
    if (!id) return undefined;
    if (event.observedAt && record.childStops.get(id) > event.observedAt) return undefined;
    let entry = record.snapshot.children.find(item => item.id === id);
    if (event.observedAt && entry?.observedAt > event.observedAt) return undefined;
    if (!entry) {
      entry = { id, label: cleanTitle(event.taskLabel), startedAt: eventAt };
      record.snapshot.children.push(entry);
    }
    entry.observation = "observed";
    entry.observedAt = eventAt;
    if (event.providerThreadId && event.providerThreadId !== record.snapshot.conversation?.id) {
      entry.providerThreadId = event.providerThreadId;
      if (event.providerTurnId) entry.providerTurnId = event.providerTurnId;
    }
    record.snapshot.activityObserved = true;
    return entry;
  }
  function childEndIsStale(record, event, eventAt) {
    const id = childId(record, event);
    const entry = record.snapshot.children.find(item => item.id === id);
    return !id || record.childStops.get(id) > eventAt || entry?.observedAt > eventAt ||
      Boolean(event.providerThreadId && event.providerThreadId !== record.snapshot.conversation?.id &&
        event.providerTurnId && entry?.providerTurnId && event.providerTurnId !== entry.providerTurnId);
  }
  function provisionalChildResponse(record, event, eventAt) {
    if (childEndIsStale(record, event, eventAt)) return;
    const entry = observeChild(record, event, eventAt);
    if (entry) {
      // A Stop hook can still be blocked by another hook. Keep unresolved proof
      // without claiming the child is currently running or awaiting approval.
      entry.observation = "provisional";
      entry.attention = undefined;
    }
  }
  function authoritativeChildEnd(record, event) {
    const entry = record.snapshot.children.find(item => item.id === childId(record, event));
    return event.provisional !== true && record.snapshot.capabilities?.finalCompletion === "authoritative" &&
      Boolean(event.providerThreadId && event.providerThreadId !== record.snapshot.conversation?.id && event.providerTurnId) &&
      (!entry?.providerThreadId || entry.providerThreadId === event.providerThreadId);
  }
  function endChild(record, event, eventAt) {
    const id = childId(record, event);
    if (childEndIsStale(record, event, eventAt)) return;
    record.snapshot.children = record.snapshot.children.filter(item => item.id !== id);
    record.childStops.set(id, eventAt);
    if (record.childStops.size > 512) record.childStops.delete(record.childStops.keys().next().value);
  }
  function staleTurn(record, event) {
    const s = record.snapshot;
    return Boolean(event.providerTurnId && (record.retiredTurnIds.has(event.providerTurnId) ||
      (s.turnId && event.providerTurnId !== s.turnId))) ||
      Boolean(event.observedAt && ((s.pendingInputAt && event.observedAt < s.pendingInputAt) ||
        (s.turnStartedAt && event.observedAt < s.turnStartedAt)));
  }
  function backgroundUnavailable(record) {
    if (record.snapshot.backgroundObservation) record.snapshot.backgroundObservation = {
      ...record.snapshot.backgroundObservation, availability: "unavailable", observedAt: now()
    };
  }
  function settleQuestion(record, toolId) {
    record.resolvedQuestionToolIds.add(toolId);
    if (record.resolvedQuestionToolIds.size > 256) record.resolvedQuestionToolIds.delete(record.resolvedQuestionToolIds.values().next().value);
  }
  function clearActiveTools(record) {
    for (const tool of record.snapshot.activeTools) record.settledToolIds.add(tool.id);
    while (record.settledToolIds.size > 512) record.settledToolIds.delete(record.settledToolIds.values().next().value);
    for (const tool of record.snapshot.activeTools) if (isQuestionTool(record.snapshot.provider, tool.name)) settleQuestion(record, tool.id);
    record.snapshot.activeTools = [];
  }
  function invalidateRootObservation(record) {
    record.rootIdentityConflict = true;
    const s = record.snapshot;
    // Parentless metadata proves another root exists, not which root this TUI
    // selected. Keep the old reference for history, but retire its live proof.
    clearInput(record);
    clearActiveTools(record);
    for (const key of ["turnId", "turnStartedAt", "turnEndedAt", "attention", "lastTool"]) s[key] = undefined;
    s.turnState = "unknown";
    s.children = [];
    s.activityObserved = false;
    record.nativeActive = false;
    record.coarseDepth = 0;
    record.coarseProvisional = false;
    record.coarseBackground = false;
    record.transcriptPath = undefined;
    record.identityHints.clear();
    record.pendingEvents = [];
  }
  function recordInput(payload) {
    if (!matches(payload)) return null;
    const record = get(payload.id);
    const s = record.snapshot;
    if (record.rootIdentityConflict || s.provider === "terminal" || s.processState !== "running") return null;
    const submit = typeof payload.data === "string" && /(?:\r\n|\r|\n)$/.test(payload.data) && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(payload.data);
    const interrupt = payload.data === "\x1b" || payload.data === "\x03";
    if (!submit && !(interrupt && record.nativeActive && s.turnState === "running")) return null;
    // Enter during proven ongoing work is steering/menu input, except when it
    // follows an explicit interrupt request and begins a new submission intent.
    if (submit && record.nativeActive && s.turnState === "running" && s.pendingInput !== "interrupt") return null;
    const waitingReply = submit && s.turnState === "waiting" &&
      (s.attention?.reason === "approval" || (["claude", "grok"].includes(s.provider) && s.attention?.reason === "question"));
    const intent = submit ? "submit" : "interrupt";
    if (s.pendingInput === intent) return null;
    record.pendingPriorTurnId = waitingReply ? undefined : s.turnId;
    s.pendingInput = intent;
    s.pendingInputAt = now();
    s.pendingTurnActivity = undefined;
    record.pendingTurnEnded = !record.nativeActive || !["running", "waiting"].includes(s.turnState) ||
      Boolean(s.turnId && record.displayEndedTurnId === s.turnId);
    record.pendingTurnEventAt = undefined;
    record.pendingTurnTools = new Set([...record.settledToolIds, ...s.activeTools.map(tool => tool.id)]);
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
    if (s.provider === "claude") {
      // An idle notification is a reminder about an available response, never
      // proof of an unanswered question. Previous hooks discarded its type and
      // emitted a generic question, so require the explicit question tool too.
      // Reject before identity/observation updates: even a pending submit or a
      // provisional Stop must survive the reminder without becoming blocked.
      const question = event.type === "agent-attention" && event.attention?.state === "waiting" && event.attention.reason === "question";
      if (event.notificationType === "idle_prompt" || (question && event.toolName !== "AskUserQuestion")) return null;
    }
    if (isQuestionTool(s.provider, event.toolName) && event.toolId && !isChild(record, event) &&
        record.resolvedQuestionToolIds.has(event.toolId) &&
        ((event.type === "agent-attention" && event.attention?.state === "waiting") ||
          (event.type === "agent-activity" && event.phase === "start"))) return null;
    const observed = event.type.startsWith("agent-");
    const explicitlyChild = Boolean(event.parentThreadId || event.transcriptKind === "subagent");
    if (observed) {
      s.telemetryHealth = "available";
      if (!record.rootIdentityConflict && event.rootVerified === true && !explicitlyChild &&
          event.providerThreadId && s.conversation?.id && event.providerThreadId !== s.conversation.id &&
          ["agent-session", "agent-running", "agent-attention", "agent-response", "agent-activity"].includes(event.type)) {
        invalidateRootObservation(record);
      }
      // Neither a delayed old-root callback nor fresh metadata proves selection.
      // Only a new launch generation can restore native conversation authority.
      if (record.rootIdentityConflict && event.type !== "agent-process") return publish(record);
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
    if (observePendingTurn(record, event, child)) return publish(record);
    const pendingQuestion = s.turnState === "waiting"
      ? s.activeTools.find(tool => isQuestionTool(s.provider, tool.name)) : undefined;
    switch (event.type) {
      case "created":
        record.preparing = false;
        s.processState = "running";
        s.launchState = event.launchPending ? "pending" : "ready";
        if (Number.isSafeInteger(event.cols) && event.cols > 0) s.cols = event.cols;
        if (Number.isSafeInteger(event.rows) && event.rows > 0) s.rows = event.rows;
        break;
      case "launch-ready": s.launchState = "ready"; break;
      case "snapshot":
        record.preparing = false;
        s.processState = event.isRunning ? "running" : "exited";
        if (event.launchPending !== undefined) s.launchState = event.launchPending ? "pending" : "ready";
        if (event.terminalTitle !== undefined) s.terminalTitle = cleanTitle(event.terminalTitle);
        if (Number.isSafeInteger(event.cols) && event.cols > 0) s.cols = event.cols;
        if (Number.isSafeInteger(event.rows) && event.rows > 0) s.rows = event.rows;
        break;
      case "resize":
        if (Number.isSafeInteger(event.cols) && event.cols > 0) s.cols = event.cols;
        if (Number.isSafeInteger(event.rows) && event.rows > 0) s.rows = event.rows;
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
        if (child && event.phase === "end") endChild(record, event, eventAt);
        if (!child && event.title && event.providerThreadId) bind(record,
          { id: event.providerThreadId, title: event.title, titleSource: event.titleSource, updatedAt: eventAt }, true, true);
        if (!child && event.phase === "start" && s.turnState === "unknown") {
          s.turnState = "idle";
          s.observation = "observed";
        }
        break;
      case "agent-running":
        if (child) {
          const entry = observeChild(record, event, eventAt);
          if (entry && (event.turnStart !== false || !entry.attention?.toolId || event.toolId === entry.attention.toolId)) entry.attention = undefined;
          break;
        }
        if (event.providerTurnId && record.retiredTurnIds.has(event.providerTurnId)) break;
        if (event.turnStart === false && event.phase === "start" && event.toolId && record.settledToolIds.has(event.toolId)) break;
        if (event.turnStart === false && event.phase === "stop" && s.turnState === "response" && !record.nativeActive) break;
        // Hook processes can deliver a start after newer activity or a stop.
        // A previously unseen turn id is not authority to rewind native time.
        if (event.observedAt &&
            ((s.turnStartedAt && event.observedAt < s.turnStartedAt) ||
              (s.turnEndedAt && event.observedAt < s.turnEndedAt) ||
              (s.pendingInputAt && event.observedAt < s.pendingInputAt))) break;
        if (event.turnStart === false && s.pendingInput === "submit" && record.pendingPriorTurnId &&
            event.providerTurnId === record.pendingPriorTurnId) break;
        if (event.turnStart === false && event.providerTurnId && s.turnId && event.providerTurnId !== s.turnId) break;
        if (event.turnStart === false && ["completed", "failed", "interrupted"].includes(s.turnState)) break;
        if (event.providerTurnId && event.providerTurnId === s.turnId &&
            ["completed", "failed", "interrupted"].includes(s.turnState)) break;
        // Parallel or delayed tool callbacks do not answer an open question.
        // Its matching stop removes it from activeTools before the observer's
        // running callback arrives. A real new user turn can still supersede it.
        if (event.turnStart === false && pendingQuestion) break;
        const newTurn = !s.turnStartedAt ||
          (event.providerTurnId && s.turnId !== event.providerTurnId) ||
          (event.turnStart !== false && pendingQuestion) ||
          (event.turnStart !== false && ["completed", "failed", "interrupted", "idle", "response"].includes(s.turnState));
        if (newTurn) {
          if (s.turnId && event.providerTurnId !== s.turnId) record.retiredTurnIds.add(s.turnId);
          clearActiveTools(record);
          record.settledToolIds.clear();
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
        if (child) { provisionalChildResponse(record, event, eventAt); break; }
        if (staleTurn(record, event)) break;
        if (["completed", "failed", "interrupted"].includes(s.turnState)) break;
        if (s.turnState === "response" && !record.nativeActive) break;
        clearInput(record);
        clearActiveTools(record);
        record.nativeActive = false;
        s.attention = undefined;
        s.turnState = "response";
        s.observation = "provisional";
        s.turnEndedAt = eventAt;
        break;
      case "agent-attention": {
        if (child) {
          if (event.attention?.state === "waiting") {
            const entry = observeChild(record, event, eventAt);
            if (entry && (!entry.attention || entry.attention.reason !== event.attention.reason)) entry.attention = {
              id: randomUUID(), state: "waiting", reason: event.attention.reason, toolId: event.toolId, updatedAt: eventAt
            };
          } else if (event.attention) {
            if (authoritativeChildEnd(record, event)) endChild(record, event, eventAt);
            else provisionalChildResponse(record, event, eventAt);
          }
          break;
        }
        if (!event.attention) break;
        if (event.providerTurnId && record.retiredTurnIds.has(event.providerTurnId)) break;
        if (event.observedAt && s.turnStartedAt && event.observedAt < s.turnStartedAt) break;
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
        const provisionalCompletion = attention.state === "completed" &&
          (s.capabilities?.finalCompletion !== "authoritative" || !event.providerThreadId || !event.providerTurnId);
        // Duplicate coarse idle/Stop events cannot acknowledge a newer submit.
        // Wait for fresh activity or identified completion before clearing it.
        if (provisionalCompletion && s.turnState === "response" && !record.nativeActive) break;
        clearInput(record);
        if (provisionalCompletion) {
          // A coarse Stop can describe a child or an intermediate response, even
          // when it shares the root session id. Never cache it as final work
          // that would become completed merely because child activity closes.
          record.nativeActive = false;
          s.turnState = "response";
          s.observation = "provisional";
          s.turnEndedAt = eventAt;
          clearActiveTools(record);
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
        if (s.turnState !== "waiting") { clearActiveTools(record); s.turnEndedAt = eventAt; }
        break;
      }
      case "agent-activity": {
        if (child) {
          // A tool returning does not mean its agent stopped. Keep the native
          // child identity through parallel tools, thinking and background work.
          if (event.phase === "start") observeChild(record, event, eventAt);
          const entry = s.children.find(item => item.id === childId(record, event));
          if (entry?.attention && event.phase === "stop" && event.toolId === entry.attention.toolId) entry.attention = undefined;
          break;
        }
        // Tool callbacks are emitted before their running companion. Fence
        // both paths so a delayed return cannot acknowledge the next prompt.
        if (event.observedAt && ((s.turnStartedAt && event.observedAt < s.turnStartedAt) ||
            (s.pendingInputAt && event.observedAt < s.pendingInputAt))) break;
        if (event.phase === "stop" && !record.nativeActive &&
            ["response", "completed", "failed", "interrupted"].includes(s.turnState)) break;
        if (event.toolId && event.phase === "start" && record.settledToolIds.has(event.toolId)) break;
        if (!child && event.providerTurnId && record.retiredTurnIds.has(event.providerTurnId)) break;
        if (!child && event.providerTurnId && s.turnId && event.providerTurnId !== s.turnId) {
          if (event.phase !== "start" || s.pendingInput !== "submit") break;
          record.retiredTurnIds.add(s.turnId);
          s.turnId = event.providerTurnId;
          s.turnStartedAt = eventAt;
          s.turnEndedAt = undefined;
          s.attention = undefined;
        }
        if (!child && isQuestionTool(s.provider, event.toolName) && event.toolId && event.phase === "stop") {
          // Hook callbacks can arrive out of order. Once this question ended,
          // its delayed start cannot re-open an already answered dialog.
          settleQuestion(record, event.toolId);
        }
        const resolvesQuestion = event.phase === "stop" && isQuestionTool(s.provider, event.toolName) &&
          (event.toolId || event.toolName) === pendingQuestion?.id;
        if (!child && s.pendingInput && (!pendingQuestion || resolvesQuestion) &&
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
        if (event.toolId && event.phase === "stop") {
          record.settledToolIds.add(event.toolId);
          if (record.settledToolIds.size > 512) record.settledToolIds.delete(record.settledToolIds.values().next().value);
        }
        s.activityObserved = true;
        const isTask = event.kind !== "tool" && Boolean(event.taskId || event.kind === "task" || event.kind === "subagent" || /^(task|agent)$/i.test(event.toolName || ""));
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
        // A tool hook's agent_id identifies its issuer, not the child launched
        // by that tool. Keep fallback brackets separate from native lifetimes.
        const toolBracket = event.kind === "tool" && event.lifecycle !== "native";
        const id = toolBracket ? (event.toolId ? `tool:${event.toolId}` : undefined) :
          event.taskId || event.toolId || (child ? event.providerThreadId : undefined);
        if (!id) {
          record.coarseDepth = Math.max(0, Math.min(10000, record.coarseDepth + (event.phase === "start" ? 1 : -1)));
          if (event.phase === "stop" && (event.provisional === true || event.lifecycle === "native")) record.coarseProvisional = true;
          s.activityObserved = true;
          break;
        }
        if (event.phase === "start") {
          if (event.observedAt && record.childStops.get(id) > event.observedAt) break;
          observeChild(record, { ...event, taskId: id }, eventAt);
        } else if (event.provisional === true || event.lifecycle === "native") {
          provisionalChildResponse(record, { ...event, taskId: id }, eventAt);
        } else endChild(record, { ...event, taskId: id }, eventAt);
        break;
      }
      case "agent-background-activity": {
        const activity = event.backgroundActivity;
        if (!activity) break;
        if (activity.source === "kimi-task-metadata") {
          // A failed or partial read is not evidence that detached work ended.
          // Only a terminal native task record can settle an observed task.
          const items = Array.isArray(activity.items) ? activity.items : [];
          const missing = s.children.some(entry => entry.id.startsWith("background:") &&
            !items.some(item => `background:${item.id}` === entry.id));
          s.backgroundObservation = { source: activity.source,
            availability: activity.availability === "available" && !missing ? "available" : "unavailable", observedAt: eventAt };
          if (activity.availability !== "available") break;
          for (const item of items) {
            if (!item.id) continue;
            const id = `background:${item.id}`;
            const previous = s.children.find(entry => entry.id === id);
            s.children = s.children.filter(entry => entry.id !== id);
            if (item.status === "running") s.children.push({ id,
              label: item.kind === "process" ? "Background command" : item.kind === "question" ? "Background question" : "Background agent",
              startedAt: timestamp(item.startedAt, previous?.startedAt || eventAt) });
          }
          s.activityObserved = true;
          break;
        }
        s.activityObserved = true;
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
    if (!lookup || record.rootIdentityConflict || record.closed || record.cancelled || record.rejected || record.lookupInFlight || s.provider === "terminal" || now() < record.nextLookupAt) return;
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
          if (!current(s.id, generation) || record.rootIdentityConflict || s.conversation?.id !== knownId) return;
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
      if (!current(s.id, generation) || record.rootIdentityConflict) return;
      // Authoritative identity may have arrived while this lookup was in flight.
      // Never apply an old unbound lookup over that newly established root.
      if (s.conversation?.id !== knownId) return;
      if (result?.status === "failed") {
        record.lookupFailures += 1;
        record.nextLookupAt = now() + Math.min(60000, 8000 * 2 ** Math.min(record.lookupFailures, 3));
      } else record.lookupFailures = 0;
      if (knownId) {
        if (["kimi", "kimi-custom"].includes(s.provider) &&
            !(result?.status === "found" && result.rootVerified === true && result.threadRef?.id === knownId && result.nativeBackgroundActivity)) backgroundUnavailable(record);
        if (result?.status === "found" && result.threadRef?.id === knownId) {
          bind(record, result.threadRef, true);
          if (result.rootVerified === true && result.nativeBackgroundActivity && ["kimi", "kimi-custom"].includes(s.provider)) {
            ingest({ id: s.id, generation, type: "agent-background-activity", providerThreadId: knownId,
              rootVerified: true, backgroundActivity: result.nativeBackgroundActivity });
          }
        }
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
        backgroundUnavailable(record);
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
