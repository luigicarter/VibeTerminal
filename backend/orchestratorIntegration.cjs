"use strict";
const { captureProjectRemoval, validateProjectRemoval } = require('./orchestratorProjects.cjs');
const { WORKSPACE_VIEWS } = require('./orchestratorWorkspace.cjs');

const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

// Display activity is distinct from the raw turn evidence used by task proofs.
// Keep this projection aligned with frontend/terminalRuntime.ts (parity tested).
function nativeSessionStatus(s) {
  if (s.processState === "failed") return "failed";
  if (s.processState === "exited") return "exited";
  if (s.processState === "starting" || s.launchState === "pending") return "starting";
  if (s.provider !== "terminal") {
    if (s.agentProcessState === "failed") return "failed";
    if (s.agentProcessState === "exited") return "exited";
  }
  const childUnverified = child => child.observation === "provisional" ||
    (s.backgroundObservation?.availability === "unavailable" && child.id.startsWith("background:"));
  const retainedChildrenOnly = (s.children?.some(childUnverified) || s.coarseChildObservation === "provisional") &&
    s.coarseChildObservation !== "observed" && (s.children || []).every(childUnverified);
  const liveChildren = !retainedChildrenOnly && (s.children?.length > 0 || s.childActivity);
  const childObserved = liveChildren && (s.activityObserved === true || (s.observation === "observed" && s.telemetryHealth !== "unavailable"));
  if (childObserved && s.children?.some(child => !childUnverified(child) && child.attention?.state === "waiting")) return "waiting";
  if (s.pendingInput) {
    const activity = s.pendingTurnActivity;
    if (activity && activity.turnId === s.turnId && activity.observedAt > (s.pendingInputAt ?? Infinity)) return activity.state;
    if (childObserved) return "running";
    return s.pendingInput === "interrupt" ? "interrupt requested" : "awaiting activity";
  }
  if (s.provider === "terminal") return "terminal open";
  const rootActive = s.telemetryHealth !== "unavailable" && s.observation !== "unavailable" && ["running", "waiting"].includes(s.turnState);
  if (retainedChildrenOnly && !rootActive && !s.activeTools?.length) return "activity unverified";
  if (s.telemetryHealth === "unavailable" || s.observation === "unavailable") {
    if (!s.activityObserved) return "unobserved";
    return liveChildren || s.activeTools?.length > 0 ? "running" : "unobserved";
  }
  if (s.turnState === "waiting") return "waiting";
  if (s.activityObserved && s.activeTools?.length > 0) return "running";
  if (liveChildren) return "running";
  if (s.turnState === "completed") return s.observation === "observed" ? "completed" : "response";
  return s.turnState || "unknown";
}

// This facade composes existing engine owners. It never assigns work or makes
// approval decisions. Its new command channel always captures a generation.
function createSessionDirectory({ getRuntime, now = Date.now } = {}) {
  const ui = new Map(), chats = new Map(), activity = new Map(), bodies = new Map(), interactions = new Map();
  const completedResults = new Map();
  let projectPaths = [], launchers = [], projects = [], inventoryRevision = 0, inventorySignature;
  let contentSequence = 0;
  function updateUi(items, roots = [], catalog = [], projectCatalog = []) {
    const signature = JSON.stringify([items, roots, projectCatalog]);
    if (signature !== inventorySignature) { inventoryRevision++; inventorySignature = signature; }
    projects = projectCatalog.filter(project => project && typeof project.id === 'string' && typeof project.path === 'string').map(project => ({ id: project.id, path: project.path, name: project.name }));
    launchers = require("./orchestratorLaunchers.cjs").launcherCatalog(catalog);
    projectPaths = roots.filter(p => typeof p === "string");
    ui.clear();
    for (const s of Array.isArray(items) ? items : []) if (s?.id) ui.set(s.id, {
      id: s.id, name: s.name, kind: s.kind, cwd: s.cwd,
      projectId: s.projectId, projectName: s.projectName, model: s.model, visiblePane: true, board: s.projectId ? 'project' : 'multi', inventoryRevision,
      status: s.status, started: s.started, launchToken: s.launchToken,
      threadRef: s.threadRef, resumeRef: s.resumeRef, providerProfileId: s.providerProfileId,
      fusionPlannerFamily: s.fusionPlannerFamily, fusion: s.fusion, openFusion: s.openFusion
    });
  }
  function outgoing(kind, message) {
    const p = message.payload || {};
    if (!p.id) return message;
    if (message.type === "start") {
      const old = chats.get(p.id);
      // Main's start route is invoked by pane mounts too. An unchanged live
      // configuration is an attach; explicit stop/close retires the owner.
      // Open Fusion's Brain model is a live per-turn setting. Its picker does
      // not restart the server, so a subsequent mount must retain its owner.
      const plannerModel = kind === "openfusion" ? undefined : p.plannerModel;
      const signature = JSON.stringify([kind, p.launchToken, p.cwd, p.plannerFamily, plannerModel, p.executorModel, p.resumeId, p.model]);
      const configurationSignature = JSON.stringify([kind, p.cwd, p.plannerFamily, plannerModel, p.executorModel, p.model]);
      // Fresh chats learn their native ID after start. A later pane mount sends
      // that ID as resumeId, but the host reattaches to its existing generation.
      const attachesCurrentConversation = old?.launchToken === p.launchToken && old?.configurationSignature === configurationSignature &&
        typeof p.resumeId === "string" && p.resumeId && p.resumeId === old.conversationId;
      if (!old || old.signature !== signature && !attachesCurrentConversation || old.closed) {
        const plannerFamily = kind === "fusion" ? p.plannerFamily || ui.get(p.id)?.fusionPlannerFamily || "claude" : undefined;
        chats.set(p.id, { id: p.id, kind, cwd: p.cwd, ...(p.launchToken !== undefined && { launchToken: p.launchToken }), generation: randomUUID(), revision: 1,
          status: "starting", observation: "observed", model: p.plannerModel || p.model,
          ...(plannerFamily && { plannerProvider: plannerFamily, fusionPlannerFamily: plannerFamily }),
          ...(typeof p.resumeId === "string" && p.resumeId && { conversationId: p.resumeId }),
          mode: p.mode || p.runMode || "auto", signature, configurationSignature, lastActivityAt: now(), closed: false,
          turnState: "unknown", turnSequence: 0, turnActive: false });
        bodies.delete(p.id);
        interactions.delete(p.id);
      }
    }
    const c = chats.get(p.id);
    if (c) {
      if (kind === "openfusion" && message.type === "start") c.model = p.plannerModel || c.model;
      if (kind === "openfusion" && message.type === "planner-model") c.model = p.model;
      message = { ...message, payload: { ...p, generation: message.type === "start" ? c.generation : (p.generation || c.generation) } };
      if (message.type === "mode") c.mode = p.mode;
      if (["input", "steer"].includes(message.type)) {
        // A second/human input makes attribution ambiguous; it must not let an
        // unrelated result release an Orchestrator dependency.
        if (c.turnActive || c.pendingInput) { c.activeActionId = undefined; c.pendingActionId = undefined; c.completionAttribution = "ambiguous"; }
        else { c.pendingActionId = p.actionId; c.completionAttribution = p.actionId ? "action" : "observed"; }
        c.pendingInput = true;
      }
      if (message.type === "stop") { c.closed = true; c.status = "exited"; bodies.delete(p.id); interactions.delete(p.id); chats.delete(p.id); }
    }
    return message;
  }
  function canRestartChat(kind, event) {
    const retained = chats.get(event?.id);
    return kind === "fusion" && event?.type === "engine-restarting" && !event.replay &&
      retained?.kind === "fusion" && retained.closed === true && event.generation === retained.generation;
  }
  function ingest(kind, event) {
    if (!event?.id || event.replay) return;
    const t = now();
    if (kind === "terminal") {
      const old = activity.get(event.id);
      const a = old?.generation === event.generation ? old : { generation: event.generation };
      if (event.type === 'created' && Number.isSafeInteger(event.pid) && event.pid > 0) a.terminalPid = event.pid;
      if (event.type === "data") { a.lastOutputAt = event.outputAt || t; a.lastActivityAt = a.lastOutputAt; }
      if (event.type.startsWith("agent-") || event.type === "exit") {
        a.lastActivityAt = t;
        const pid = Number(event.pid || event.agentPid);
        if (event.type === "agent-process" && event.phase === "start" && !event.parentThreadId && event.transcriptKind !== "subagent" && Number.isInteger(pid) && pid > 0) a.pid = pid;
        if (event.type === "agent-process" && event.phase === "exit" && (!pid || pid === a.pid) && !event.parentThreadId && event.transcriptKind !== "subagent") a.pid = undefined;
      }
      activity.set(event.id, a);
      return;
    }
    const c = chats.get(event.id);
    if (!c || (event.generation && event.generation !== c.generation)) return;
    // Fusion can recover a cleanly exited planner for the next user input or
    // background report. Only its explicit, generation-bound restart may
    // revive the retained owner; late output/readiness from an exit cannot.
    if (c.closed) {
      if (!canRestartChat(kind, event)) return;
      for (const key of ['turnId', 'turnStartedAt', 'turnEndedAt', 'completedTurnId', 'completedActionId', 'activeActionId', 'pendingActionId', 'completionAttribution', 'turnText', 'lastTool', 'checkEvidence']) delete c[key];
      c.closed = false; c.engineReady = false; c.status = "starting";
      c.turnState = "unknown"; c.turnActive = false; c.pendingInput = false; c.interruptSettled = false;
      c.detachedTaskIds = []; c.backgroundActivity = undefined;
      interactions.delete(c.id);
    }
    // The engine's generation-bound identity is authoritative immediately;
    // renderer inventory updates can arrive later or carry the previous thread.
    if (event.type === "session" && event.generation === c.generation && typeof event.sessionId === "string" && event.sessionId) {
      const previousId = c.conversationId || ui.get(c.id)?.threadRef?.id;
      if (previousId && previousId !== event.sessionId) {
        // Current turn evidence belongs to the old native conversation. Keep
        // its immutable result cache and transcript, but never relabel those
        // fields as activity or completion in the replacement conversation.
        for (const key of ['turnId', 'turnStartedAt', 'turnEndedAt', 'completedTurnId', 'completedActionId', 'activeActionId', 'pendingActionId', 'completionAttribution', 'turnText', 'lastTool', 'checkEvidence']) delete c[key];
        c.turnActive = false; c.pendingInput = false; c.interruptSettled = false; c.turnState = 'unknown'; c.status = 'unknown';
        c.detachedTaskIds = []; c.backgroundActivity = undefined;
        interactions.delete(c.id);
      }
      c.conversationId = event.sessionId;
    }
    c.revision++; c.lastActivityAt = t;
    if (event.type === "background-task" && typeof event.taskId === "string" && event.taskId) {
      const tasks = new Set(c.detachedTaskIds || []);
      if (event.phase === "started") tasks.add(event.taskId);
      if (event.phase === "settled") tasks.delete(event.taskId);
      c.detachedTaskIds = [...tasks];
    }
    if (event.type === "background-activity" && event.backgroundActivity) {
      c.backgroundActivity = structuredClone(event.backgroundActivity);
    }
    if (event.type === "action-result" && event.ok === false) {
      if (c.pendingActionId === event.actionId) { c.pendingActionId = undefined; c.pendingInput = false; }
      if (c.activeActionId === event.actionId) c.activeActionId = undefined;
      if (c.completedActionId === event.actionId) c.completedActionId = undefined;
    }
    const pending = interactions.get(event.id) || new Set();
    if (["permission", "question", "interaction-request"].includes(event.type)) {
      pending.add(String(event.requestId || event.interaction?.id || event.interaction?.kind || event.type));
      interactions.set(event.id, pending);
      c.status = "waiting";
    }
    if (["permission-resolved", "question-resolved", "interaction-resolved"].includes(event.type)) {
      pending.delete(String(event.requestId || event.interaction?.id || event.type.replace("-resolved", "")));
      if (!pending.size && c.status === "waiting") { c.status = "idle"; c.turnState = "idle"; }
    }
    if (event.type === "engine-ready") { c.engineReady = true; if (c.status === "starting") { c.status = "idle"; c.turnState = "idle"; } }
    // The hosts emit assistant-text/thinking; streamed work must not hide an
    // unresolved question or permission from another concurrent operation.
    if (["turn-start", "tool-call", "delta", "text-delta", "assistant-text", "thinking"].includes(event.type)) {
      c.interruptSettled = false;
      if (!c.turnActive) {
        c.turnActive = true; c.turnSequence++;
        c.turnId = event.turnId || event.providerTurnId || `${c.generation}:${c.turnSequence}`;
        c.turnStartedAt = t; c.turnEndedAt = undefined; c.turnText = "";
        c.activeActionId = c.pendingActionId; c.pendingActionId = undefined; c.pendingInput = false;
      }
      c.status = pending.size ? "waiting" : "running";
      c.turnState = c.status;
    }
    // Hosts retain interaction ownership through a planner result/error. Only
    // explicit resolution or interruption retires those outstanding requests.
    if (event.type === "interrupted") interactions.delete(event.id);
    if (event.type === "interrupted") { c.status = "interrupted"; c.interruptSettled = true; }
    const failedResult = event.type === "result" && (event.isError === true || event.subtype === "error");
    // Hosts replay a restoration settle and may send a final result after an
    // interrupt. Neither is a new successful completion of the foreground turn.
    const passiveResult = event.type === "result" && (event.subtype === "restored" || (c.interruptSettled && (kind === "openfusion" || !failedResult)));
    if (event.type === "result" && !passiveResult) c.status = failedResult ? "failed" : pending.size ? "waiting" : "completed";
    if (event.type === "result" && event.subtype === "restored" && !c.turnActive) { c.status = "idle"; c.turnState = "idle"; }
    if (event.type === "result" && !passiveResult && event.gate) c.checkEvidence = { ...event.gate, observedAt: t };
    if (event.type === "error") c.status = "failed";
    if (["permission", "question", "interaction-request"].includes(event.type)) c.turnState = "waiting";
    if (["result", "error", "interrupted"].includes(event.type) && !passiveResult && c.status !== "waiting") {
      c.turnState = c.status; c.turnEndedAt = t;
      c.completedTurnId = c.turnId; c.completedActionId = c.activeActionId;
      c.turnActive = false; c.pendingInput = false;
    }
    if (event.type === "closed") {
      c.status = "exited"; c.closed = true; c.engineReady = false; interactions.delete(event.id);
      if (kind !== "fusion") { bodies.delete(event.id); chats.delete(event.id); }
    }
    if (event.type === "tool-call") c.lastTool = { name: event.name || event.toolName, at: t };
    const text = event.delta || event.text || (event.type === "error" ? event.message : "");
    if (typeof text === "string" && text) {
      if (["assistant-text", "delta", "text-delta", "result"].includes(event.type)) c.turnText = ((c.turnText || "") + text).slice(-16000);
      const b = bodies.get(event.id) || { text: "", sequence: 0, truncated: false };
      b.text += text + (typeof event.delta === "string" || ["delta", "text-delta"].includes(event.type) ? "" : "\n");
      if (b.text.length > 200000) { b.text = b.text.slice(-200000); b.truncated = true; }
      b.sequence = ++contentSequence; b.at = t; bodies.set(event.id, b);
    }
    if (["result", "error", "interrupted"].includes(event.type) && !passiveResult && c.turnEndedAt && c.turnId) {
      completedResults.set(JSON.stringify([c.id, c.generation, c.turnId]), { turnId: c.turnId, actionId: c.completedActionId, status: c.turnState, at: c.turnEndedAt, text: c.turnText || "", source: "chat-events" });
      while (completedResults.size > 200) completedResults.delete(completedResults.keys().next().value);
    }
  }
  function chatActivity(c) {
    const childActivity = Boolean(c.detachedTaskIds?.length || c.backgroundActivity?.active);
    return { childActivity, status: c.status === "waiting" ? "waiting" : childActivity ? "running" : c.status };
  }
  function list() {
    const out = [];
    for (const s of getRuntime?.()?.listSnapshots() || []) {
      const u = ui.get(s.id) || {}, a = activity.get(s.id);
      if (Number.isSafeInteger(u.launchToken) && Number.isSafeInteger(s.launchToken) && u.launchToken !== s.launchToken) continue;
      out.push({ ...u, ...s, visiblePane: ui.has(s.id), board: u.board, projectId: u.projectId, inventoryRevision, kind: u.kind || s.provider,
        name: s.conversation?.title || u.name || s.terminalTitle || s.provider,
        conversationTitle: s.conversation?.title,
        aliases: [...new Set([u.name, u.threadRef?.title, s.conversation?.title].filter(value => typeof value === "string" && value.trim()))],
        status: nativeSessionStatus(s),
        lastActivityAt: a?.generation === s.generation ? a.lastActivityAt : undefined,
        lastOutputAt: a?.generation === s.generation ? a.lastOutputAt : undefined,
        agentPid: a?.generation === s.generation ? a.pid : undefined,
        terminalPid: a?.generation === s.generation ? a.terminalPid : undefined });
    }
    for (const c of chats.values()) if (!c.closed) { const u = ui.get(c.id);
      if (Number.isSafeInteger(u?.launchToken) && Number.isSafeInteger(c.launchToken) && u.launchToken !== c.launchToken) continue;
      out.push({ ...u, ...c, ...chatActivity(c), visiblePane: Boolean(u), board: u?.board, projectId: u?.projectId, inventoryRevision,
      name: u?.threadRef?.title || u?.name || c.kind, conversationTitle: u?.threadRef?.title,
      aliases: [...new Set([u?.name, u?.threadRef?.title].filter(value => typeof value === "string" && value.trim()))] }); }
    for (const u of ui.values()) if (!out.some(s => s.id === u.id)) out.push({ ...u,
      generation: `paused:${u.id}:${u.launchToken || 0}`, revision: 0, observation: "unavailable", status: "paused" });
    return out;
  }
  function readChat(target) {
    if (target.beforeSequence !== undefined) return { ok: false, status: "use-saved-history", error: "For older chat content, search or page the saved conversation." };
    const s = chats.get(target.id);
    if (!s || s.closed || s.generation !== target.generation) throw new Error("This session has changed. Select it again.");
    const b = bodies.get(target.id);
    const limit = Math.max(100, Math.min(32000, Number(target.maxChars) || 16000));
    return { id: s.id, generation: s.generation, source: "chat-events", sequence: b?.sequence || 0,
      observedAt: b?.at, text: b?.text.slice(-limit) || "", truncated: Boolean(b?.truncated || b?.text.length > limit),
      complete: false, ...chatActivity(s), turnId: s.turnId, turnState: s.turnState,
      completedResult: structuredClone(completedResults.get(JSON.stringify([s.id, s.generation, target.completedTurnId || s.completedTurnId]))) };
  }
  return { updateUi, outgoing, ingest, list, readChat, canRestartChat, projectPaths: () => projectPaths, projects: () => structuredClone(projects), launchers: () => structuredClone(launchers), get: id => list().find(s => s.id === id),
    forget: (id, generation) => { if (activity.get(id)?.generation === generation) activity.delete(id); if (chats.get(id)?.generation === generation) { chats.delete(id); bodies.delete(id); interactions.delete(id); } for (const key of completedResults.keys()) { const identity = JSON.parse(key); if (identity[0] === id && identity[1] === generation) completedResults.delete(key); } },
    clear: () => { ui.clear(); chats.clear(); activity.clear(); bodies.clear(); interactions.clear(); completedResults.clear(); } };
}

function installOrchestrator(options) {
  const { app, BrowserWindow, Menu, ipcMain, screen, shell, safeStorage, dialog, systemPreferences, getMainWindow,
    getRuntime, sendPty, sendFusion, sendOpenFusion, getTelemetry, getChanges } = options;
  const { createOrchestrator } = require("./orchestrator.cjs");
  const { createTerminalObservation } = require("./terminalObservation.cjs");
  const { createWorkspaceSetupStore } = require("./workspaceSetups.cjs");
  const { createOrchestratorDelivery } = require("./orchestratorDelivery.cjs");
  const { createInventoryRefresh } = require("./orchestratorInventory.cjs");
  const { waitForSessionLaunch } = require("./orchestratorLaunch.cjs");
  const { createTerminalInput } = require("./orchestratorTerminalInput.cjs");
  const { createOrchestratorHistoryProcess } = require("./orchestratorHistoryProcess.cjs");
  const { createWorkspaceIdentity } = require("./orchestratorWorkspaceIdentity.cjs");
  const { createCompletionEvidence } = require("./orchestratorCompletion.cjs");
  const { createVoiceController } = require("./voiceController.cjs");
  const { createVoiceOverlayWindow } = require("./voiceOverlayWindow.cjs");
  const { createMicrophonePermission } = require("./microphonePermission.cjs");
  const { TTS_MODEL, TTS_VOICES } = require("../shared/voiceConfig.cjs");
  const changes = require("./workspaceChanges.cjs");
  const directory = createSessionDirectory({ getRuntime });
  const observations = createTerminalObservation();
  const completions = createCompletionEvidence({ getSession: id => directory.get(id), readObservation: target => observations.read(target) });
  const setups = createWorkspaceSetupStore({ userDataPath: app.getPath("userData") });
  const pendingUi = new Map(), pendingHost = new Map();
  const inventoryReader = createInventoryRefresh({ read: () => requestUi("inventory"),
    apply: result => { if (!disposed) directory.updateUi(result.sessions || result.items || [], result.projectPaths || [], result.launchers || [], result.projects || []); } });
  const closeReconciliation = require("./orchestratorCloseReconciliation.cjs").createCloseReconciliation({
    observe: options.observeStoppedSession,
    getSessions: () => directory.list(),
    publish: receipt => disposed ? { ok: false } : relay.recordLifecycle?.(receipt) ?? { ok: false }
  });
  const history = createOrchestratorHistoryProcess({ getConfig: () => {
    const current = directory.list();
    const roots = [...new Set([...directory.projectPaths(), ...current.map(s => s.cwd)].filter(Boolean))];
    const scopes = current.filter(s => s.kind !== "terminal").map(s => ({ provider: s.kind, cwd: s.cwd,
      claudeHome: s.providerProfileId ? "custom" : "global", providerProfileId: s.providerProfileId, ownedThreadIds: [s.threadRef?.id, s.resumeRef?.id].filter(Boolean),
      plannerProvider: s.fusionPlannerFamily || "claude", fusion: s.kind === "fusion", openFusion: s.kind === "openfusion" }));
    for (const cwd of roots) for (const provider of ["codex", "claude", "claude-custom", "cursor", "gemini", "kimi", "kimi-custom", "qwen", "grok", "opencode", "openfusion", "fusion"]) scopes.push({ provider, cwd });
    return { ...options.getHistoryConfig?.(), scopes };
  } });
  const delivery = createOrchestratorDelivery({
    getSession: inputSession,
    write: ({ signal, ...payload }) => hostAction(sendPty, payload, 'action', signal),
    writeBusyPrompt: promoteQueuedPrompt,
    reserveInput: payload => { const runtime = getRuntime(), reservation = runtime.recordInput?.(payload); return reservation ? () => runtime.releaseInput?.(reservation) : undefined; },
    onUpdate: result => relay.recordDelivery(result),
    onBeforeWrite: metadata => relay.prepareDelivery(metadata)
  });
  const routedInputBindings = new Map();
  const idleInputActions = new Set();
  const queuedInputAttempts = require('./orchestratorQueuedInputAttempts.cjs').createQueuedInputAttempts();
  const terminalInput = createTerminalInput({ getSession: inputSession, readSession: target => observations.read(target),
    startupTimeoutMs: options.startupTimeoutMs ?? options.launchTimeoutMs ?? 60000, startupPollMs: options.startupPollMs ?? 100,
    onBeforeWrite: metadata => relay.prepareDelivery(queuedInputAttempts.correlate(metadata)),
    write: ({ signal, ...payload }) => {
      if (!require("./orchestratorLaunchers.cjs").routingBindingMatches(routedInputBindings.get(payload.actionId), directory.get(payload.id))) return { ok: false, status: "blocked", delivery: "not-dispatched", error: "The routed conversation changed before dispatch." };
      if (idleInputActions.has(payload.actionId) && !require('./orchestratorTargetAvailability.cjs').isIdleTarget(inputSession(payload.id))) return unavailableIdleTarget();
      return hostAction(sendPty, payload, 'action', signal);
    } });
  function unavailableIdleTarget() {
    return { ok: false, status: 'target-unavailable', delivery: 'not-dispatched', error: 'The selected terminal is no longer idle. Select an available terminal again.' };
  }
  async function promoteQueuedPrompt(action) {
    const target = { id: action.target?.id || action.id || action.targetId, generation: action.target?.generation ?? action.generation };
    const observation = await observations.read(target);
    const session = inputSession(target.id);
    const prompt = { ...action, target, submit: true, promptSubmission: true };
    if (action.signal?.aborted) return { ok: false, status: 'cancelled', delivery: 'not-dispatched' };
    if (action.targetAvailability === 'idle' || !observation?.ok || observation.id !== target.id || observation.generation !== target.generation ||
        !require('./orchestratorBusyInput.cjs').isBusyPromptSubmission(prompt, session)) return { ok: false, status: 'blocked', delivery: 'not-dispatched', error: 'The queued prompt no longer has a verified busy input recipient.' };
    if (observation.manualInputPending || observation.interactionInputPending) return { ok: false, status: 'input-buffer-occupied', delivery: 'not-dispatched', error: 'The terminal contains staged input. The queued prompt was not sent.' };
    // Both terminal-input and PTY transports retain proven-unsent action IDs.
    // Use one fresh attempt, retaining the original queued delivery owner for
    // prewrite/result attribution and delayed native events.
    const actionId = randomUUID();
    queuedInputAttempts.remember(actionId, { ...action, target });
    if (action.routingBinding) routedInputBindings.set(actionId, action.routingBinding);
    try {
      const result = await terminalInput.handle({ ...prompt, actionId, observationSequence: observation.sequence, inputRevision: observation.inputRevision,
        promptObservation: { agentPid: session.agentPid, turnId: session.turnId, turnStartedAt: session.turnStartedAt } });
      return queuedInputAttempts.correlate(result);
    } finally {
      routedInputBindings.delete(actionId); queuedInputAttempts.complete(actionId);
    }
  }
  let disposed = false, inventoryTimer = null, publicationTimer = null, voice, activation = 0;
  function inputSession(id) {
    const session = directory.get(id);
    if (!session) return;
    const pendingInteractions = relay.getRequests().filter(request => request.sessionId === id &&
      (request.generation === undefined || request.generation === session.generation) && request.state === "pending");
    return { ...session, pendingInteraction: pendingInteractions.length > 0, pendingInteractions: structuredClone(pendingInteractions) };
  }
  let permissionActivation = null;
  const permissionLifetime = new AbortController();
  const launchLifetime = new AbortController();
  const microphonePermission = options.microphonePermission || createMicrophonePermission({ userDataPath: app.getPath("userData"), getMainWindow, dialog, systemPreferences, shell });
  let voiceReady = false, captureToken = 0, captureReady = false, captureRecovering = false, indicatorVisible = false;
  let captureHeartbeatTimer = null, captureRecoveryTimer = null;
  const captureRestarts = [];
  const captureWaiters = new Set();
  const captureFlushes = new Map();
  let capturedSamples = 0;
  const surface = createVoiceOverlayWindow({ BrowserWindow, screen, canCapture: () => microphonePermission.isGranted(),
    onClosed: () => { if (disposed) return; captureReady = false; invalidateCapture(); finishCapture({ ok: false, status: 'cancelled', error: 'Voice audio window closed.' }); void voice?.setListening(false); },
    onFailure: error => { void microphoneFailure(error); },
  });
  function broadcast(channel, value) {
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isDestroyed() || (channel === "orchestrator:state" && surface.isSender(w.webContents))) continue;
      w.webContents.send(channel, value);
    }
  }
  function allowed(event, mainOnly = false) {
    const main = getMainWindow();
    return event.sender === main?.webContents || (!mainOnly && surface.isSender(event.sender));
  }
  function guarded(channel, fn, mainOnly = false) {
    ipcMain.handle(channel, async (event, payload) => {
      if (!allowed(event, mainOnly)) return { ok: false, error: "Unsupported caller." };
      try { return await fn(payload || {}, event); } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 1000) }; }
    });
  }
  function requestUi(kind, payload = {}, signal) {
    const main = getMainWindow();
    if (!main || main.isDestroyed() || disposed) return Promise.resolve({ ok: false, error: "Workspace window unavailable." });
    const id = randomUUID();
    return new Promise(resolve => {
      let dispatched = false, settled = false;
      const finish = result => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); pendingUi.delete(id); if (!["inventory", "workspace_state"].includes(kind) && dispatched) inventoryReader.invalidate(); resolve(result); };
      const abort = () => finish({ ok: false, status: dispatched ? "unknown" : "cancelled", error: dispatched ? "Workspace action was dispatched before cancellation; its outcome is unconfirmed. No automatic retry." : "Cancelled before workspace dispatch." });
      const timer = setTimeout(() => finish({ ok: false, status: "unknown", error: "Workspace acknowledgment timed out; no automatic retry." }), 20000);
      if (signal?.aborted) return abort();
      pendingUi.set(id, finish); signal?.addEventListener("abort", abort, { once: true });
      try {
        if (kind !== "close" && payload.id && payload.generation) currentTarget({ id: payload.id, generation: payload.generation, signal });
        if (signal?.aborted) return abort();
        dispatched = true;
        if (!["inventory", "workspace_state"].includes(kind)) inventoryReader.invalidate();
        main.webContents.send("orchestrator:ui-action", { id, kind, payload });
      } catch (error) { finish({ ok: false, status: dispatched ? "unknown" : "rejected", error: String(error?.message || error) }); }
    });
  }
  async function refreshInventory() {
    if (disposed) return;
    await relay.refresh();
    if (!disposed) void delivery.observe().catch(error => relay.recordDiagnostic({ event: "orchestrator_error", stage: "delivery", error }));
  }
  function publishSoon() {
    if (disposed || publicationTimer) return;
    publicationTimer = setTimeout(() => { publicationTimer = null; void relay.refresh(); }, 150);
  }
  function hostAction(send, payload, type = "action", signal) {
    const actionId = payload.actionId || randomUUID();
    if (disposed || signal?.aborted) return Promise.resolve({ ok: false, status: "cancelled", error: "Cancelled before host dispatch." });
    if (pendingHost.has(actionId)) return Promise.resolve({ ok: false, status: "rejected", error: "This action ID already has a pending host acknowledgment." });
    const engine = send === sendPty ? "terminal" : send === sendFusion ? "fusion" : "openfusion";
    return new Promise(resolve => {
      let settled = false;
      const finish = r => {
        if (settled) return;
        settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (pendingHost.get(actionId)?.finish === finish) pendingHost.delete(actionId);
        resolve(r);
      };
      const cancel = error => {
        if (settled) return;
        // Cancel only this host action, never the agent turn or another request.
        if (engine === 'terminal') {
          try { send({ type: 'action-cancel', payload: { id: payload.id, generation: payload.generation, actionId } }); } catch { /* Deadline also fences a delayed host submit. */ }
        }
        finish({ ok: false, status: 'unknown', error });
      };
      const abort = () => cancel('Terminal input was cancelled after dispatch. The outcome is unconfirmed; no automatic retry.');
      const deadlineAt = Date.now() + 15000;
      const timer = setTimeout(() => cancel("Delivery unconfirmed. The action was not retried."), 15000);
      pendingHost.set(actionId, { finish, cancel, engine, id: payload.id, generation: payload.generation });
      if (engine === 'terminal') signal?.addEventListener('abort', abort, { once: true });
      try { if (!send({ type, payload: { ...payload, actionId, ...(engine === 'terminal' ? { deadlineAt } : {}) } })) finish({ ok: false, status: "rejected", delivery: 'not-dispatched', error: "Agent host is unavailable." }); }
      catch (error) { cancel(String(error?.message || error)); }
    });
  }
  function currentTarget(action) {
    const id = action.target?.id || action.targetId || action.id;
    const s = directory.get(id);
    if (!s) throw new Error("The target session is no longer available.");
    const generation = action.target?.generation || action.generation;
    if (!generation || generation !== s.generation) throw new Error("The target session changed. Select it again.");
    if (action.signal?.aborted) throw new Error("Cancelled.");
    return s;
  }
  function folderLocations() {
    return ['documents', 'desktop', 'downloads'].flatMap(id => {
      try { const folder = app.getPath(id); return path.isAbsolute(folder) ? [{ id, path: folder }] : []; } catch { return []; }
    });
  }
  async function allowedPath(raw, explicit = false) {
    if (typeof raw !== "string" || !path.isAbsolute(raw)) throw new Error("An absolute path is required.");
    const resolved = await fs.promises.realpath(raw);
    if (explicit) return resolved;
    const roots = [...folderLocations().map(item => item.path), ...directory.projectPaths(), ...directory.list().map(s => s.cwd)];
    for (const root of roots) {
      if (!root) continue;
      let canonical; try { canonical = await fs.promises.realpath(root); } catch { continue; }
      const relative = path.relative(canonical, resolved);
      if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) return resolved;
    }
    throw new Error("That path is outside Documents and known projects.");
  }
  async function answerExisting(kind, payload) {
    const s = directory.get(payload.id);
    if (!s || s.kind !== kind || (payload.generation && payload.generation !== s.generation)) return { ok: false, error: "This session has changed." };
    const request = relay.getRequests().find(item => item.id === payload.requestId && item.sessionId === s.id && item.generation === s.generation && item.state === "pending" && (payload.revision === undefined || payload.revision === item.revision));
    if (!request) return { ok: false, error: "This interaction is no longer current." };
    const binding = { target: { id: s.id, generation: s.generation }, nativeIdentity: require("./orchestratorRouting.cjs").sessionIdentity(s) };
    const base = { ...payload, id: s.id, generation: s.generation, revision: request.revision, actionId: payload.actionId || randomUUID() };
    const sendCurrent = (send, value, type) => {
      if (!require("./orchestratorLaunchers.cjs").routingBindingMatches(binding, directory.get(s.id)) || !relay.getRequests().some(item => item.id === request.id && item.sessionId === s.id && item.generation === s.generation && item.revision === request.revision && item.state === "pending")) return { ok: false, status: "blocked", delivery: "not-dispatched", error: "This interaction is no longer current." };
      return hostAction(send, value, type);
    };
    if (kind === "openfusion") return sendCurrent(sendOpenFusion, base, payload.kind === "permission" ? "permission" : payload.kind === "progress" ? "question-progress" : "question");
    const control = getTelemetry().getFusionSessionControl(s.id);
    if (!control?.controlUrl) return { ok: false, error: "Fusion answer bridge unavailable." };
    return sendCurrent(sendFusion, { ...base, ...control }, "answer-question");
  }
  async function dispatchAction(action) {
    const kind = action.kind;
    let effectBinding = action.routingBinding;
    const check = () => { if (disposed || action.signal?.aborted) throw new Error("Cancelled."); };
    const checkedHost = (send, payload, type) => {
      check();
      const current = currentTarget(action);
      if (!require("./orchestratorLaunchers.cjs").routingBindingMatches(effectBinding, current)) return { ok: false, status: "blocked", delivery: "not-dispatched", reason: "conversation-changed", error: "The conversation changed before host input." };
      if (kind === 'send_prompt' && action.targetAvailability === 'idle' && !require('./orchestratorTargetAvailability.cjs').isIdleTarget(inputSession(current.id))) return unavailableIdleTarget();
      if (["answer_question", "permission"].includes(kind) && !relay.getRequests().some(request => request.id === action.requestId && request.sessionId === current.id && request.generation === current.generation && request.revision === action.revision && request.state === "pending")) return { ok: false, status: "blocked", delivery: "not-dispatched", error: "This interaction is no longer current." };
      return hostAction(send, payload, type, action.signal);
    };
    const createdTarget = async result => {
      if (result?.ok && result.id) terminalInput.trackStartup({ id: result.id, launchToken: result.launchToken,
        ...(result.target?.generation && !String(result.target.generation).startsWith('paused:') ? { generation: result.target.generation } : {}) });
      if (action.waitForReady && result?.ok && result.id) return require("./orchestratorLaunchers.cjs").waitForRoutingReady({ result, getSession: id => directory.get(id), refresh: refreshInventory, signal: AbortSignal.any([launchLifetime.signal, ...(action.signal ? [action.signal] : [])]), timeoutMs: options.launchTimeoutMs ?? 20000 });
      const session = result?.ok && result.id ? directory.get(result.id) : null;
      if (result?.ok && result.id && Number.isFinite(result.launchToken) &&
          !session?.fusion && !session?.openFusion && !["fusion", "openfusion"].includes(session?.kind || action.kindOfSession)) {
        return waitForSessionLaunch({ result, getSession: id => directory.get(id), refresh: refreshInventory,
          signal: AbortSignal.any([launchLifetime.signal, ...(action.signal ? [action.signal] : [])]),
          timeoutMs: options.launchTimeoutMs ?? 20000 });
      }
      return session && (result.launchToken === undefined || session.launchToken === result.launchToken)
        ? { ...result, target: { id: session.id, generation: session.generation, launchToken: session.launchToken } } : result;
    };
    check();
    if (kind === 'remove_project') {
      const inventory = await inventoryReader.refresh(); check();
      if (!inventory?.ok) return { ok: false, status: 'project-retained', error: 'The current project inventory is unavailable.', filesDeleted: false };
      const selection = action.projectSelection || captureProjectRemoval(action.path, directory.projects(), directory.list());
      validateProjectRemoval(selection, directory.projects(), directory.list());
      const result = await requestUi('remove_project', { projectSelection: selection }, action.signal);
      await refreshInventory(); check();
      if (result?.ok && directory.projects().some(project => project.id === selection.id)) return { ...result, ok: false, status: 'project-retained', error: 'The project is still present in the current workspace inventory.' };
      return result;
    }
    if (kind === "navigate") {
      if (!WORKSPACE_VIEWS.includes(action.view)) return { ok: false, error: "Choose a supported application view." };
      if (action.view === "project" && (typeof action.cwd !== "string" || !action.cwd.trim())) return { ok: false, error: "An existing project folder is required." };
      return requestUi("navigate", { view: action.view, ...(action.view === "project" ? { cwd: action.cwd } : {}) }, action.signal);
    }
    if (kind === "list_conversations") return history.list({ provider: action.provider, cwd: action.cwd, query: action.query, limit: action.limit, offset: action.offset });
    if (kind === "read_conversation") return history.read({ reference: action.reference, cursor: action.cursor, maxChars: action.maxChars, maxBytes: action.maxBytes, limit: action.limit });
    if (kind === "search_conversation") return history.search({ reference: action.reference, query: action.query, cursor: action.cursor, limit: action.limit, maxBytes: action.maxBytes });
    if (kind === "resume_conversation") {
      const found = await history.resolve({ reference: action.reference, selection: action.selection });
      if (action.signal?.aborted) throw new Error("Cancelled.");
      const cwd = await allowedPath(found.cwd);
      if (!(await fs.promises.stat(cwd)).isDirectory()) throw new Error("The saved conversation's project folder is unavailable.");
      const conversation = { ...found,
        provider: found.provider === "fusion" ? found.plannerProvider || "claude" : found.provider === "openfusion" ? "opencode" : found.provider === "claude-custom" ? "claude" : found.provider,
        fusion: found.fusion || found.provider === "fusion", openFusion: found.openFusion || found.provider === "openfusion",
        claudeHome: found.provider === "claude-custom" ? "custom" : found.claudeHome };
      const result = await requestUi("resume_conversation", { conversation }, action.signal);
      await refreshInventory();
      return createdTarget(result);
    }
    async function availableSetups() {
      const paths = action.projectPath ? [await allowedPath(action.projectPath)] : [...directory.projectPaths(), ...directory.list().map(s => s.cwd)];
      const recipes = await setups.list();
      for (const root of new Set(paths.filter(Boolean))) recipes.push(...await setups.list({ projectPath: root }));
      return [...new Map(recipes.map(r => [r.id, r])).values()];
    }
    if (kind === "list_setups") return { ok: true, setups: await availableSetups() };
    if (kind === "read_setup" || (kind === "launch_setup" && !action.recipe)) {
      const candidates = await availableSetups();
      const matches = candidates.filter(r => action.setupId ? r.id === action.setupId : r.name.toLowerCase() === String(action.name || "").toLowerCase());
      if (matches.length !== 1) return { ok: false, error: "Choose one saved setup by its exact name." };
      if (kind === "read_setup") return { ok: true, setup: matches[0] };
      action.recipe = matches[0];
    }
    if (["add_project", "create_session", "launch_setup", "save_setup"].includes(kind)) {
      if (action.path) { action.path = await allowedPath(action.path, kind === "add_project" && action.folderAccess?.explicit === true && action.folderAccess.path === action.path); if (!(await fs.promises.stat(action.path)).isDirectory()) throw new Error("Project path must be a folder."); }
      if (action.cwd) { action.cwd = await allowedPath(action.cwd); if (!(await fs.promises.stat(action.cwd)).isDirectory()) throw new Error("Session folder must be a directory."); }
      const { signal, ...payload } = action;
      const result = await requestUi(kind, { ...payload, kind: action.kindOfSession || action.agentKind || action.launcherKind || action.kind }, signal);
      await refreshInventory(); return createdTarget(result);
    }
    if (["open_file", "open_folder"].includes(kind)) {
      if (typeof action.path !== "string") throw new Error("A path is required.");
      const resolved = await allowedPath(action.path, kind === "open_folder" && action.folderAccess?.explicit === true && action.folderAccess.path === action.path);
      const stat = await fs.promises.stat(resolved);
      if (kind === "open_folder" && !stat.isDirectory()) throw new Error("This path is not a folder.");
      if (kind === "open_file" && (!stat.isFile() || /\.(exe|com|bat|cmd|ps1|lnk|url|msi)$/i.test(resolved))) throw new Error("This is not an openable document.");
      check(); const error = await shell.openPath(resolved);
      return error ? { ok: false, error } : { ok: true, status: "opened", path: resolved, text: "Opened in the default application." };
    }
    if (kind === "close") {
      // Lifecycle reconciliation keeps the frozen identity even when the pane
      // disappeared or restarted. The renderer and process owner fence mutation.
      const inventory = await inventoryReader.refresh();
      if (!inventory?.ok) return { ok: false, status: "close-partial", error: inventory?.error || "Current workspace inventory is unavailable.", delivery: "not-dispatched" };
      const supplied = action.target || {};
      const current = directory.get(supplied.id || action.targetId);
      const target = { id: supplied.id || action.targetId, generation: supplied.generation ?? action.generation,
        launchToken: supplied.launchToken ?? current?.launchToken };
      const frozen = action.closeScope?.targets?.find(item => item.id === target.id);
      if (!target.id || target.generation === undefined || !Number.isSafeInteger(target.launchToken)) return { ok: false, status: "close-partial", error: "Missing frozen pane identity." };
      const { signal, ...payload } = action;
      const result = await requestUi("close", { ...payload, id: target.id, generation: target.generation, target,
        kindOfSession: frozen?.kind || current?.kind || "terminal" }, signal);
      const verified = await inventoryReader.refresh();
      const remaining = directory.list().find(item => item.id === target.id && item.visiblePane === true);
      if (result.close && verified?.ok) {
        if (remaining && remaining.launchToken === target.launchToken) { result.ok = false; result.status = "close-partial"; result.close.pane = "unknown"; }
        if (action.closeScope) Object.assign(result.close, require("./orchestratorCloseScope.cjs").remainingCloseScope(action.closeScope, directory.list()));
        result.close.inventoryRevision = Math.max(0, ...directory.list().map(item => item.inventoryRevision || 0));
      } else if (result.close) { result.ok = false; result.status = "close-partial"; result.close.pane = "unknown"; result.error = "The post-close inventory could not be verified."; }
      // A timed-out UI acknowledgment can still gain committed pane-absence
      // evidence from this fresh read. Process proof remains unknown until an
      // observation of the original operation settles it.
      if (!result.close && !result.ok && verified?.ok && !remaining && action.actionId && result.delivery !== 'not-dispatched') {
        result.close = { operationId: action.actionId, target: { ...target }, pane: 'already-absent', process: 'unknown', launchSettled: false, verifiedAt: Date.now() };
      }
      if (result.ok && result.close?.process && ["stopped", "already-absent"].includes(result.close.process)) observations.forget(target.id, target.generation);
      else if (result.close) closeReconciliation.track({ ...result, kind: 'close', actionId: action.actionId, grantId: action.grantId, targetId: target.id, generation: target.generation },
        { operationId: result.close.operationId, ...target, kind: frozen?.kind || current?.kind || 'terminal' }, action.closeScope);
      return result;
    }
    const s = await currentTarget(action);
    if (!effectBinding && ["fusion", "openfusion"].includes(s.kind)) effectBinding = { target: { id: s.id, generation: s.generation }, nativeIdentity: require("./orchestratorRouting.cjs").sessionIdentity(s) };
    if (kind === 'terminal_interact') return terminalInput.handle(action);
    if (["focus_session", "stage_draft", "get_draft", "stage_handoff", "restart"].includes(kind)) {
      const { signal, ...payload } = action;
      const result = await requestUi(kind, { ...payload, id: s.id, generation: s.generation }, signal);
      return result;
    }
    if (["answer_question", "permission"].includes(kind)) {
      const base = { id: s.id, generation: s.generation, actionId: action.actionId,
        requestId: action.requestId, answers: action.answers, reply: action.reply || action.decision, revision: action.revision };
      if (s.kind === "openfusion") {
        if (base.answers && !Array.isArray(base.answers)) {
          const request = relay.getRequests().find(r => r.id === base.requestId && r.sessionId === s.id);
          if (!request) throw new Error("This question is no longer current.");
          const keyed = base.answers;
          base.answers = request.questions.map((q, i) => { const answer = keyed[q.id || String(i)]; return Array.isArray(answer) ? answer : answer === undefined ? [] : [String(answer)]; });
        }
        return checkedHost(sendOpenFusion, base, kind === "permission" ? "permission" : "question");
      }
      if (s.kind === "fusion") {
        if (base.answers && !Array.isArray(base.answers)) base.answers = Object.fromEntries(Object.entries(base.answers).map(([id, value]) => [id, Array.isArray(value) ? value : typeof value === "object" && value?.answers ? value.answers : [String(value)]]));
        const control = getTelemetry().getFusionSessionControl(s.id);
        if (!control?.controlUrl) throw new Error("Fusion's answer bridge is unavailable.");
        return checkedHost(sendFusion, { ...base, ...control }, "answer-question");
      }
      throw new Error("This terminal does not expose structured answers. Open the terminal to answer its current prompt.");
    }
    if (kind === "interrupt") {
      if (s.kind === "fusion") { check(); currentTarget(action); await getTelemetry().interruptFusionSession(s.id); return checkedHost(sendFusion, { id: s.id, generation: s.generation, actionId: action.actionId }, "interrupt"); }
      if (s.kind === "openfusion") return checkedHost(sendOpenFusion, { id: s.id, generation: s.generation, actionId: action.actionId }, "interrupt");
      if (action.operator === true) return terminalInput.handle({ ...action, target: { id: s.id, generation: s.generation }, keys: ['ctrl-c'] });
      return checkedHost(sendPty, { id: s.id, generation: s.generation, actionId: action.actionId, kind: "interrupt" });
    }
    if (kind === "send_prompt") {
      if (!require("./orchestratorLaunchers.cjs").routingBindingMatches(action.routingBinding, s)) return { ok: false, status: "blocked", delivery: "not-dispatched", reason: "conversation-changed", error: "The routed conversation changed before dispatch." };
      if (action.targetAvailability === 'idle' && !require('./orchestratorTargetAvailability.cjs').isIdleTarget(inputSession(s.id))) return unavailableIdleTarget();
      if (typeof action.text !== "string" || !action.text.trim()) throw new Error("A prompt is required.");
      if (s.kind === "fusion") {
        if (s.status === "running") {
          check(); currentTarget(action); const route = await getTelemetry().steerFusionSession(s.id, action.text);
          const current = directory.get(s.id);
          if (!current || current.generation !== s.generation || !require("./orchestratorLaunchers.cjs").routingBindingMatches(effectBinding, current)) {
            // Telemetry may already have steered the original conversation.
            // Only an explicit skipped result proves no earlier effect; never
            // fall back to sending this prompt to the replacement conversation.
            return { ok: false, status: route?.status === "skipped" ? "blocked" : "unknown", ...(route?.status === "skipped" && { delivery: "not-dispatched" }), reason: "conversation-changed", error: route?.status === "skipped" ? "The conversation changed while steering. No prompt was sent." : "The conversation changed while steering. No follow-up was sent to the replacement; earlier steering may already have been applied." };
          }
          if (!route || !["routing", "steered", "skipped"].includes(route.status)) return { ok: false, status: "unknown", error: "Steering delivery is unconfirmed; no duplicate prompt was sent." };
          return checkedHost(sendFusion, { id: s.id, generation: s.generation, text: action.text, routed: ["routing", "steered"].includes(route.status), actionId: action.actionId }, "steer");
        }
        return checkedHost(sendFusion, { id: s.id, generation: s.generation, text: action.text, actionId: action.actionId }, "input");
      }
      if (s.kind === "openfusion") return checkedHost(sendOpenFusion, { id: s.id, generation: s.generation, text: action.text, mode: s.mode || "auto", actionId: action.actionId }, "input");
      if (action.operator === true || terminalInput.needsStartupReadiness(s)) {
        const prompt = { ...action, target: { id: s.id, generation: s.generation }, submit: true, promptSubmission: true,
          promptObservation: action.promptObservation ?? { agentPid: s.agentPid, turnId: s.turnId, turnStartedAt: s.turnStartedAt } };
        if (relay.getRequests().some(request => request.sessionId === s.id && request.generation === s.generation && request.state === 'pending')) return { ok: false, status: 'blocked', delivery: 'not-dispatched', error: 'Answer the pending terminal request before submitting a new prompt.' };
        if (action.routingBinding) routedInputBindings.set(action.actionId, action.routingBinding);
        if (action.targetAvailability === 'idle') idleInputActions.add(action.actionId);
        let result;
        const startup = terminalInput.needsStartupReadiness(s) && action.operator === true &&
          !action.editInput && Number.isSafeInteger(action.inputRevision);
        try {
          result = await terminalInput.handle(prompt);
          // A startup repaint can win the race between decoded readiness and
          // the PTY's exact screen fence. Retry only a proven-unsent rejection,
          // retaining the original input revision, PID and routing authority.
          // Fresh transport IDs are correlated back to this one task owner.
          for (let retry = 0; startup && retry < 2 && result?.ok === false && result.delivery === 'not-dispatched' &&
              result.status === 'stale-observation' && result.reason !== 'input-revision-changed' && !action.signal?.aborted; retry++) {
            const current = inputSession(s.id);
            if (!current || current.generation !== s.generation || current.launchToken !== s.launchToken || current.agentPid !== s.agentPid ||
                !require('./orchestratorLaunchers.cjs').routingBindingMatches(action.routingBinding, current) || !terminalInput.needsStartupReadiness(current)) break;
            const attemptId = randomUUID();
            queuedInputAttempts.remember(attemptId, prompt);
            if (action.routingBinding) routedInputBindings.set(attemptId, action.routingBinding);
            if (action.targetAvailability === 'idle') idleInputActions.add(attemptId);
            try { result = queuedInputAttempts.correlate(await terminalInput.handle({ ...prompt, actionId: attemptId })); }
            finally { routedInputBindings.delete(attemptId); idleInputActions.delete(attemptId); queuedInputAttempts.complete(attemptId); }
          }
        } finally { routedInputBindings.delete(action.actionId); idleInputActions.delete(action.actionId); }
        const latest = directory.get(s.id);
        const pendingInteraction = relay.getRequests().some(request => request.sessionId === s.id && request.generation === s.generation && request.state === 'pending');
        if (require('./orchestratorBusyInput.cjs').canQueueBusyPrompt(prompt, latest && { ...latest, pendingInteraction }, result)) return delivery.submit({ ...action, target: prompt.target });
        return result;
      }
      return delivery.submit({ ...action, target: { id: s.id, generation: s.generation } });
    }
    throw new Error(`Unsupported action: ${kind}`);
  }
  const relay = createOrchestrator({ userDataPath: app.getPath("userData"), secureStorage: safeStorage, fetch: options.fetch, interpretIntent: options.interpretIntent,
    resolveWorkspaceIdentity: createWorkspaceIdentity(),
    getSessions: async () => {
      const result = await inventoryReader.refresh();
      if (!result?.ok) throw new Error(result?.error || "Current workspace inventory is unavailable.");
      // Reading late process proof must not hold inventory publication or recurse
      // into relay.refresh. The reconciler coalesces bounded observation batches.
      void closeReconciliation.refresh().catch(() => {});
      return directory.list();
    },
    getLaunchers: () => directory.launchers(),
    getWorkspaceState: signal => requestUi("workspace_state", {}, signal),
    readSession: async target => {
      const session = directory.get(target.id);
      if (["fusion", "openfusion"].includes(session?.kind)) return directory.readChat(target);
      const observation = await observations.read(target);
      if (target.beforeSequence === undefined && session?.generation === target.generation) {
        await completions.capture(session);
        return { ...observation, turnId: session.turnId, turnState: session.turnState, completedResult: completions.get(session, target.completedTurnId) };
      }
      return observation;
    },
    dispatchAction,
    getRoots: () => ({ documents: app.getPath("documents"), locations: folderLocations(), projects: [...directory.projects(), ...[...new Set([...directory.projectPaths(), ...directory.list().map(s => s.cwd)].filter(Boolean))].filter(path => !directory.projects().some(project => project.path === path))] }),
    onCancel: input => { if (!input?.requestId) delivery.cancel(); voice?.cancelSpeech(input); },
    onUpstreamError: info => voice?.announceError(info),
    onChange: state => {
      voice?.reconcileTaskQuestions?.();
      broadcast("orchestrator:state", { ...state, ready: state.ready && voiceReady, voiceReady });
    },
    onSpeak: event => {
      if (event.origin === "interaction") {
        const request = relay.getRequests().find(r => r.id === event.requestId && r.sessionId === event.sessionId && r.generation === event.generation && r.revision === event.revision && r.state === "pending");
        const session = directory.get(request?.sessionId);
        return request ? voice?.announceInteraction({ ...request, sessionName: session?.name, projectName: session?.projectName }) : undefined;
      }
      return voice?.speak({ ...event, id: event.replyId });
    }
  });
  voice = (options.voiceFactory || createVoiceController)({ orchestrator: relay, getKey: () => relay.getKey(), getSettings: () => relay.getSettings(), fetch: options.fetch,
    modelPath: app.isPackaged ? path.join(process.resourcesPath, "voice") : path.join(__dirname, "..", "vendor", "voice"),
    emit: state => broadcast("voice:state", { ...state, captureToken, captureRecovering, indicatorVisible }), onAudio: chunk => surface.send("voice:audio", chunk) });

  const snapshot = () => { const state = relay.getState(); return { ...state, ready: state.ready && voiceReady, voiceReady }; };
  const voiceSnapshot = () => ({ ...voice.getState(), captureToken, captureRecovering, indicatorVisible });
  function showIndicator() { indicatorVisible = true; broadcast("voice:state", voiceSnapshot()); return { ok: true }; }
  function hideIndicator() { indicatorVisible = false; broadcast("voice:state", voiceSnapshot()); return { ok: true }; }
  const publish = () => broadcast("orchestrator:state", snapshot());
  function finishCapture(result) { for (const waiter of captureWaiters) waiter.finish(result); }
  function invalidateCapture({ recovering = false } = {}) {
    clearTimeout(captureHeartbeatTimer); captureHeartbeatTimer = null;
    clearTimeout(captureRecoveryTimer); captureRecoveryTimer = null;
    captureRecovering = recovering;
    captureToken++; capturedSamples = 0;
    for (const pending of captureFlushes.values()) pending.finish({ ok: false, status: 'cancelled', error: 'Microphone capture changed.' });
    voice?.configure({ captureToken, captureRecovery: recovering });
    if (voice && !disposed) broadcast('voice:state', voiceSnapshot());
  }
  function watchCaptureFrames() {
    clearTimeout(captureHeartbeatTimer); captureHeartbeatTimer = null;
    if (disposed || !captureReady || captureRecovering || !relay.isEnabled() || !voice.getState().listening) return;
    const token = captureToken;
    captureHeartbeatTimer = setTimeout(() => { captureHeartbeatTimer = null; void recoverCapture(token); }, options.captureHeartbeatTimeoutMs ?? 6000);
    captureHeartbeatTimer.unref?.();
  }
  async function recoverCapture(token) {
    if (disposed || token !== captureToken || !relay.isEnabled() || !voice.getState().listening) return { ok: false, status: 'stale' };
    if (captureRecovering) return { ok: true, status: 'recovering' };
    const now = Date.now();
    while (captureRestarts.length && now - captureRestarts[0] >= 60000) captureRestarts.shift();
    if (captureRestarts.length >= 3) {
      const error = 'Microphone audio keeps stopping. Check the selected microphone, then turn voice on to retry.';
      await microphoneFailure(error); return { ok: false, error };
    }
    captureRestarts.push(now);
    captureReady = false; invalidateCapture({ recovering: true });
    const current = captureToken;
    captureRecoveryTimer = setTimeout(() => {
      captureRecoveryTimer = null;
      if (!disposed && current === captureToken && captureRecovering && relay.isEnabled() && voice.getState().listening) {
        void microphoneFailure('Microphone could not restart. Check the selected microphone, then turn voice on to retry.');
      }
    }, options.captureReadyTimeoutMs ?? 15000);
    captureRecoveryTimer.unref?.();
    return { ok: true, status: 'recovering', captureToken: current };
  }
  function flushCapture() {
    if (!captureReady || !voice.getState().listening) return Promise.resolve({ ok: false, status: 'cancelled', error: 'Microphone is not recording.' });
    const id = randomUUID(), token = captureToken;
    return new Promise(resolve => {
      const finish = result => { clearTimeout(timer); captureFlushes.delete(id); resolve(result); };
      const timer = setTimeout(() => finish({ ok: false, error: 'Microphone audio did not finish. Hold Space and try again.' }), options.captureFlushTimeoutMs ?? 1500);
      captureFlushes.set(id, { token, finish });
      surface.send('voice:flush', { id, captureToken: token });
    });
  }
  async function microphoneFailure(error) {
    if (disposed) return;
    activation++; captureReady = false;
    invalidateCapture();
    finishCapture({ ok: false, error });
    voice?.configure({ microphoneError: error });
    if (relay.isEnabled()) await relay.setEnabled(false);
  }
  async function startListening(token) {
    if (captureReady && voice.getState().listening) return { ok: true, listening: true };
    captureReady = false; invalidateCapture();
    const hardware = new Promise(resolve => {
      const waiter = { finish: result => { clearTimeout(timer); captureWaiters.delete(waiter); resolve(result); } };
      const timer = setTimeout(() => waiter.finish({ ok: false, error: 'Microphone access did not finish. Check the selected microphone and its permission.' }), options.captureReadyTimeoutMs ?? 15000);
      captureWaiters.add(waiter);
    });
    const result = await voice.setListening(true);
    if (!result.ok || !voice.getState().listening) {
      const failure = { ok: false, error: result.error || voice.getState().error || 'Voice could not start listening.' };
      finishCapture(failure);
      return failure;
    }
    const microphone = await hardware;
    if (!microphone.ok) return microphone;
    if (disposed || token !== activation) return { ok: false, status: 'cancelled', error: 'Voice activation was cancelled.' };
    return { ok: true, listening: true };
  }

  const speechChoices = () => [{ id: TTS_MODEL, name: 'Kokoro · English', voices: TTS_VOICES.map(id => ({ id, name: id.slice(3).replace(/^./, letter => letter.toUpperCase()) + (id.startsWith('b') ? ' · British' : ' · American') })) }];
  async function validateVoice() {
    const settings = relay.getSettings();
    if (settings.ttsModel !== TTS_MODEL || !TTS_VOICES.includes(settings.voice)) return { ok: false, voiceReady: false, error: 'Choose a supported voice in Settings.' };
    try {
      const [transcription, speech] = await Promise.all([relay.models('transcription'), relay.models('speech')]);
      if (!transcription.some(model => model.id === settings.sttModel)) return { ok: false, voiceReady: false, error: 'The selected transcription model is unavailable. Choose another in Settings.' };
      if (!speech.some(model => model.id === settings.ttsModel)) return { ok: false, voiceReady: false, error: 'The speech service is currently unavailable. Your text assistant is still available.' };
      const current = relay.getSettings();
      if (['sttModel', 'ttsModel', 'voice'].some(key => current[key] !== settings[key])) return { ok: false, voiceReady: false, error: 'Voice settings changed during validation. Try again.' };
      return { ok: true, voiceReady: true };
    } catch (error) { return { ok: false, voiceReady: false, error: String(error?.message || 'Could not validate voice.').slice(0, 1000) }; }
  }
  async function testConnection() {
    const result = await relay.testConnection();
    if (!result.ok || !result.ready) { voiceReady = false; publish(); return result; }
    const audio = await validateVoice();
    voiceReady = audio.ok; publish();
    return { ...result, ...audio, ready: result.ready && audio.ok };
  }
  async function setEnabled(enabled, { interactive = true } = {}) {
    // A deliberate new activation after failure starts a fresh recovery budget.
    // Reasserting enabled during a live/recovering capture must not bypass it.
    if (enabled && interactive && !voice.getState().listening) captureRestarts.length = 0;
    const token = ++activation;
    permissionActivation?.abort();
    permissionActivation = null;
    if (!enabled) { captureRestarts.length = 0; invalidateCapture(); captureReady = false; finishCapture({ ok: false, status: "cancelled", error: "Voice activation was cancelled." }); voice.cancelSpeech(); await voice.setListening(false); hideIndicator(); return relay.setEnabled(false); }
    const consent = permissionActivation = new AbortController();
    const permission = await microphonePermission.ensure({ interactive, signal: AbortSignal.any([consent.signal, permissionLifetime.signal]) });
    if (permissionActivation === consent) permissionActivation = null;
    if (disposed || token !== activation) return { ok: false, status: 'cancelled' };
    if (!permission.ok) { captureReady = false; await voice.setListening(false); await relay.setEnabled(false); hideIndicator(); return permission; }
    const result = await relay.setEnabled(true);
    if (!result.ok || disposed || token !== activation) return result.ok ? { ok: false, status: 'cancelled' } : result;
    const audio = await validateVoice();
    if (disposed || token !== activation) return { ok: false, status: 'cancelled' };
    voiceReady = audio.ok; publish();
    if (!audio.ok) { captureReady = false; await voice.setListening(false); await relay.setEnabled(false); return audio; }
    try {
      showIndicator(); await surface.ensureReady();
      if (disposed || token !== activation) return { ok: false, status: 'cancelled' };
      const listening = await startListening(token);
      if (!listening.ok) { if (token === activation) { captureReady = false; invalidateCapture(); await voice.setListening(false); await relay.setEnabled(false); } return listening; }
      await refreshInventory();
      return { ok: true, voiceReady: true, listening: true };
    } catch (error) {
      if (token === activation) { finishCapture({ ok: false, error: String(error?.message || "Voice could not start.") }); captureReady = false; await voice.setListening(false); await relay.setEnabled(false); hideIndicator(); }
      return { ok: false, error: String(error?.message || 'Voice could not start.') };
    }
  }
  async function configure(patch) {
    const before = relay.getSettings(), beforeKey = relay.getKey(), wasListening = voice.getState().listening;
    const result = await relay.configure(patch);
    if (!result.ok || disposed) return result;
    const after = relay.getSettings();
    const changesConnection = beforeKey !== relay.getKey() || before.model !== after.model;
    const changesAudio = ['microphoneId', 'ttsModel', 'sttModel', 'voice', 'language'].some(key => before[key] !== after[key]);
    if (!changesConnection && !changesAudio) {
      if (before.handsFreeEnabled !== after.handsFreeEnabled) await voice.configure({ refreshHandsFree: true });
      return result;
    }
    const token = ++activation;
    permissionActivation?.abort(); permissionActivation = null;
    finishCapture({ ok: false, status: 'cancelled', error: 'Voice settings changed during activation.' });
    captureReady = false; invalidateCapture();
    await voice.setListening(false);
    if (changesConnection) { voiceReady = false; hideIndicator(); publish(); }
    else {
      const audio = await validateVoice();
      if (disposed || token !== activation) return { ok: false, status: 'cancelled' };
      voiceReady = audio.ok; publish();
      if (!audio.ok) { if (relay.isEnabled()) await relay.setEnabled(false); return { ...result, ...audio }; }
      if (wasListening && relay.isEnabled()) {
        const listening = await startListening(token);
        if (!listening.ok) {
          if (token === activation) {
            captureReady = false; invalidateCapture();
            finishCapture(listening);
            await voice.setListening(false); await relay.setEnabled(false); hideIndicator();
          }
          return { ...result, ...listening };
        }
      }
    }
    return result;
  }
  function showMenu() {
    if (!Menu) return { ok: false, error: 'Voice menu unavailable.' };
    const items = [
      { label: voice.getState().listening ? 'Turn off voice' : relay.getSettings().handsFreeEnabled ? 'Turn on voice (Hey Lina or Space)' : 'Turn on voice (hold Space to talk)', click: () => { void setEnabled(!voice.getState().listening); } },
      { label: 'Hide microphone · keep listening', click: () => hideIndicator() },
      { type: 'separator' },
      { label: 'Voice settings', click: () => { const window = getMainWindow(); if (window?.isMinimized()) window.restore(); window?.show(); void requestUi('open_settings'); } },
    ];
    Menu.buildFromTemplate(items).popup({ window: getMainWindow() }); return { ok: true };
  }
  guarded("orchestrator:get-state", snapshot);
  guarded("orchestrator:configure", configure, true);
  guarded("orchestrator:models", p => p.kind === "speech" ? speechChoices() : relay.models(p.kind));
  guarded("orchestrator:test", testConnection, true);
  guarded("orchestrator:enabled", p => setEnabled(p.enabled));
  guarded("orchestrator:send", async p => { await refreshInventory(); return relay.send(p); });
  guarded("orchestrator:enqueue", p => relay.enqueue(p));
  guarded("orchestrator:retry", p => relay.retry(p));
  guarded("orchestrator:history-clear", () => relay.clearHistory());
  guarded("orchestrator:cancel", p => relay.cancel(p));
  guarded("orchestrator:dispatch", async p => { await refreshInventory(); return relay.dispatch(p); });
  guarded("orchestrator:preferences", p => relay.preferences(p));
  guarded("orchestrator:overlay", showIndicator);
  guarded("orchestrator:open-main", async () => { const w = getMainWindow(); if (w?.isMinimized()) w.restore(); w?.show(); return { ok: true }; });
  guarded("orchestrator:changes", async p => { const target = directory.get(p.id); return getChanges(target?.cwd || p.cwd); });
  guarded("orchestrator:changes-list", async p => changes.listChanges(await allowedPath(p.cwd)));
  guarded("orchestrator:change-read", async p => changes.readChange(await allowedPath(p.cwd), p.path));
  guarded("orchestrator:setups-list", p => setups.list(p));
  guarded("orchestrator:setups-save", p => setups.save(p), true);
  guarded("orchestrator:setups-remove", p => setups.remove(p.id), true);
  guarded("voice:get-state", voiceSnapshot);
  guarded("voice:configure", async (p, event) => {
    if (p.requestMicrophoneAccess || p.openMicrophoneSettings) {
      if (event.sender !== getMainWindow()?.webContents || disposed) return { ok: false, error: "Unsupported caller." };
      return p.openMicrophoneSettings ? microphonePermission.openSettings({ signal: permissionLifetime.signal }) : microphonePermission.ensure({ signal: permissionLifetime.signal });
    }
    if (p.rendererReady) return surface.markReady(event.sender);
    if (p.captureStalled) {
      if (!surface.isSender(event.sender)) return { ok: false, status: 'stale' };
      return recoverCapture(p.captureToken);
    }
    if (p.captureFlushed) {
      const pending = captureFlushes.get(p.flushId);
      if (!pending || !surface.isSender(event.sender) || p.captureToken !== captureToken || pending.token !== captureToken) return { ok: false, status: 'stale' };
      if (!Number.isSafeInteger(p.sampleEnd) || p.sampleEnd < 0 || p.sampleEnd > capturedSamples) {
        pending.finish({ ok: false, error: 'Microphone audio was incomplete. Hold Space and try again.' });
        return { ok: false, status: 'incomplete' };
      }
      pending.finish({ ok: true, sampleEnd: p.sampleEnd }); return { ok: true };
    }
    if (p.microphoneReady || p.microphoneError) {
      if (disposed || !surface.isSender(event.sender) || p.captureToken !== captureToken || !relay.isEnabled() || !voice.getState().listening) return { ok: false, status: "stale" };
      if (p.microphoneError) { await microphoneFailure(String(p.microphoneError).slice(0, 200)); return { ok: false, error: voice.getState().error }; }
      if (captureReady) return { ok: true };
      captureReady = true; captureRecovering = false;
      clearTimeout(captureRecoveryTimer); captureRecoveryTimer = null;
      finishCapture({ ok: true }); watchCaptureFrames();
      broadcast('voice:state', voiceSnapshot()); return { ok: true };
    }
    if (p.hideOverlay) return hideIndicator();
    if (p.menu) return showMenu();
    if (p.openWorkspace) { const w = getMainWindow(); if (w?.isMinimized()) w.restore(); w?.show(); }
    if (p.preview) { await surface.ensureReady(); return voice.configure({ preview: true }); }
    // Capture identities are assigned by main, never by either renderer.
    if (p.captureToken !== undefined) return { ok: false, error: 'Unsupported capture configuration.' };
    if (p.finishRecording !== undefined) {
      const token = captureToken, recordingId = p.finishRecording;
      const recording = voice.getState();
      if (!Number.isSafeInteger(recordingId) || recording.recordingId !== recordingId || recording.phase !== 'recording' || !['wake', 'answer'].includes(recording.recordingSource)) return { ok: true, status: 'stale-recording' };
      const flushed = await flushCapture();
      if (!flushed.ok || token !== captureToken) return flushed.ok ? { ok: false, status: 'stale' } : flushed;
      return voice.configure({ finishRecording: recordingId, sampleEnd: flushed.sampleEnd });
    }
    if (p.pushToTalk === 'stop') {
      const token = captureToken;
      const flushed = await flushCapture();
      if (!flushed.ok || token !== captureToken) {
        if (token === captureToken && !flushed.ok) voice.failPushToTalk(p.holdId, flushed.error);
        return flushed.ok ? { ok: false, status: 'cancelled' } : flushed;
      }
      return voice.configure({ ...p, sampleEnd: flushed.sampleEnd });
    }
    return voice.configure(p);
  });
  guarded("voice:listening", p => setEnabled(Boolean(p.enabled)));
  guarded("voice:send-audio", p => voice.sendAudio(p));
  guarded("voice:cancel-speech", () => voice.cancelSpeech());
  ipcMain.on("voice:frames", (event, p) => {
    if (disposed || !surface.isSender(event.sender) || !relay.isEnabled() || !voice.getState().listening || p?.captureToken !== captureToken) return;
    if (!Array.isArray(p.samples) || !Number.isSafeInteger(p.sampleStart) || p.sampleStart < capturedSamples) return;
    const result = voice.frames(p);
    if (result?.ok) { capturedSamples = p.sampleStart + p.samples.length; if (p.samples.length) watchCaptureFrames(); }
  });
  ipcMain.on("orchestrator:ui-result", (event, p) => { if (allowed(event, true)) pendingUi.get(p.id)?.(p.result); });
  inventoryTimer = setInterval(() => { if (relay.isEnabled()) void refreshInventory(); }, 4000); inventoryTimer.unref?.();
  // Restore only the user's explicit startup preference: open the microphone at launch.
  if (relay.getKey() && relay.getSettings().model) {
    if (relay.getSettings().enabledOnLaunch) void setEnabled(true, { interactive: false });
    else void testConnection();
  }
  function incoming(kind, event) {
    if (disposed) return;
    const current = event?.id ? directory.get(event.id) : undefined;
    // A late acknowledgment still describes its original action, but stale
    // output/process events cannot replace the current pane's PID or activity.
    if (event?.type === "action-result") { const pending = pendingHost.get(event.actionId);
      if (pending && pending.engine === kind && pending.id === event.id && pending.generation === event.generation) pending.finish({ ...event, status: event.status || "acknowledged" }); }
    if (kind === 'terminal') event = queuedInputAttempts.correlate(event);
    // Closed Fusion owners are retained privately while inventory exposes a
    // paused fallback. Only the matching owner's explicit restart may cross
    // that display-generation boundary; stop/replacement removes the right.
    const restartingChat = directory.canRestartChat(kind, event);
    if (event?.type === "engine-restarting" && !restartingChat) return false;
    // A new process can report creation before React publishes its new launch
    // token. The visible inventory then has a paused fallback for the old pane.
    // Runtime admission, not that lagging UI projection, owns native identity.
    const native = kind === 'terminal' && event?.id
      ? getRuntime?.()?.listSnapshots().find(snapshot => snapshot.id === event.id) : undefined;
    const currentGeneration = native?.generation ?? current?.generation;
    if (currentGeneration && event.generation && currentGeneration !== event.generation && !restartingChat) return false;
    directory.ingest(kind, event);
    const ended = directory.get(event.id);
    if (["fusion", "openfusion"].includes(kind) && event.type === "session" && !event.replay && current && event.generation === current.generation) {
      const previousId = current.conversationId || current.conversation?.id || current.threadRef?.id;
      if (previousId && ended?.conversationId && previousId !== ended.conversationId) {
        // These requests were pending in the old native context. Retire their
        // exact revisions together with any spoken/listening interaction so
        // they cannot block or answer work in the replacement conversation.
        for (const request of relay.getRequests()) if (request.sessionId === current.id && request.generation === current.generation && request.state === "pending") {
          const scope = { id: request.id, sessionId: current.id, generation: current.generation, revision: request.revision };
          if (relay.resolveInteraction(scope).ok) voice.resolveInteraction?.(scope);
        }
      }
    }
    if (ended) relay.observeWork?.([ended]);
    if (kind === "terminal") void observations.ingest(event).then(async () => {
      const session = directory.get(event.id);
      if (!session) return;
      const result = await completions.capture(session);
      relay.observeWork?.([session], result);
    }).catch(() => {});
    else if (ended && ["result", "error", "interrupted"].includes(event.type)) {
      relay.observeWork?.([ended], directory.readChat(ended).completedResult);
    }
    if (event?.type === "interaction-request") relay.ingestInteraction(event.interaction || { ...event, id: event.requestId, sessionId: event.id });
    if (event?.type === "interaction-resolved" || event?.type === "question-resolved" || event?.type === "permission-resolved") {
      const resolved = relay.resolveInteraction({ id: event.requestId, sessionId: event.id, generation: event.generation, revision: event.revision });
      if (resolved.ok) voice.resolveInteraction?.({ id: event.requestId, sessionId: event.id, generation: event.generation, revision: event.revision });
    }
    publishSoon();
    void delivery.observe().catch(() => {});
    return true;
  }
  function forgetTerminal(id, generation) {
    queuedInputAttempts.forget(id, generation);
    delivery.forget(id, generation); observations.forget(id, generation); completions.forget(id, generation); directory.forget(id, generation);
    for (const request of relay.getRequests()) if (request.sessionId === id && request.generation === generation && request.state === "pending") {
      const scope = { id: request.id, sessionId: id, generation, revision: request.revision };
      relay.resolveInteraction(scope); voice.resolveInteraction?.(scope);
    }
    publishSoon();
  }
  let disposal;
  function dispose() {
    if (disposed) return disposal || Promise.resolve(); disposed = true; activation++; clearInterval(inventoryTimer); clearTimeout(publicationTimer);
    permissionLifetime.abort(); permissionActivation?.abort(); permissionActivation = null;
    launchLifetime.abort();
    clearTimeout(captureHeartbeatTimer); clearTimeout(captureRecoveryTimer); captureRecovering = false;
    closeReconciliation.dispose();
    delivery.dispose(); terminalInput.dispose(); history.dispose(); voice.dispose(); disposal = relay.dispose(); observations.dispose(); completions.clear(); directory.clear();
    finishCapture({ ok: false, error: "Application closed." });
    for (const pending of captureFlushes.values()) pending.finish({ ok: false, status: 'cancelled', error: 'Application closed.' });
    surface.dispose();
    for (const finish of pendingUi.values()) finish({ ok: false, status: "cancelled", error: "Application closed." });
    for (const pending of [...pendingHost.values()]) pending.cancel("Application closed before acknowledgment.");
    queuedInputAttempts.clear();
    return disposal;
  }
  app.once("before-quit", event => {
    const flushed = dispose();
    if (event?.preventDefault && typeof app.quit === 'function') {
      event.preventDefault();
      // Finish local error writes on orderly exit, with a bound for an unavailable disk.
      let timeout;
      const deadline = new Promise(resolve => { timeout = setTimeout(resolve, 1000); });
      void Promise.race([flushed, deadline]).finally(() => { clearTimeout(timeout); app.quit(); });
    }
  });
  return { incoming, outgoing: directory.outgoing, refreshInventory, dispose, getState: snapshot, directory, answerExisting, forgetTerminal };
}

module.exports = { createSessionDirectory, installOrchestrator };
