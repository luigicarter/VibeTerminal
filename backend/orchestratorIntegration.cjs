"use strict";

const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

// This facade composes existing engine owners. It never assigns work or makes
// approval decisions. Its new command channel always captures a generation.
function createSessionDirectory({ getRuntime, now = Date.now } = {}) {
  const ui = new Map(), chats = new Map(), activity = new Map(), bodies = new Map(), interactions = new Map();
  const completedResults = new Map();
  let projectPaths = [];
  let contentSequence = 0;
  function updateUi(items, roots = []) {
    projectPaths = roots.filter(p => typeof p === "string");
    ui.clear();
    for (const s of Array.isArray(items) ? items : []) if (s?.id) ui.set(s.id, {
      id: s.id, name: s.name, kind: s.kind, cwd: s.cwd,
      projectId: s.projectId, projectName: s.projectName, model: s.model,
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
      const signature = JSON.stringify([p.cwd, p.plannerFamily, p.plannerModel, p.executorModel, p.resumeId, p.model]);
      if (!old || old.signature !== signature || old.closed) {
        chats.set(p.id, { id: p.id, kind, cwd: p.cwd, generation: randomUUID(), revision: 1,
          status: "starting", observation: "observed", model: p.plannerModel || p.model,
          mode: p.mode || p.runMode || "auto", signature, lastActivityAt: now(), closed: false,
          turnState: "unknown", turnSequence: 0, turnActive: false });
        bodies.delete(p.id);
        interactions.delete(p.id);
      }
    }
    const c = chats.get(p.id);
    if (c) {
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
    c.revision++; c.lastActivityAt = t;
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
      if (!pending.size && c.status === "waiting") c.status = "idle";
    }
    if (event.type === "engine-ready" && c.status === "starting") { c.status = "idle"; c.turnState = "idle"; }
    // The hosts emit assistant-text/thinking; streamed work must not hide an
    // unresolved question or permission from another concurrent operation.
    if (["turn-start", "tool-call", "delta", "text-delta", "assistant-text", "thinking"].includes(event.type)) {
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
    if (event.type === "interrupted") c.status = "interrupted";
    if (event.type === "result") c.status = event.subtype === "error" ? "failed" : pending.size ? "waiting" : "completed";
    if (event.type === "result" && event.gate) c.checkEvidence = { ...event.gate, observedAt: t };
    if (event.type === "error") c.status = "failed";
    if (["permission", "question", "interaction-request"].includes(event.type)) c.turnState = "waiting";
    if (["result", "error", "interrupted"].includes(event.type) && c.status !== "waiting") {
      c.turnState = c.status; c.turnEndedAt = t;
      c.completedTurnId = c.turnId; c.completedActionId = c.activeActionId;
      c.turnActive = false; c.pendingInput = false;
    }
    if (event.type === "closed") { c.status = "exited"; c.closed = true; bodies.delete(event.id); interactions.delete(event.id); chats.delete(event.id); }
    if (event.type === "tool-call") c.lastTool = { name: event.name || event.toolName, at: t };
    const text = event.delta || event.text || (event.type === "error" ? event.message : "");
    if (typeof text === "string" && text) {
      if (["assistant-text", "delta", "text-delta", "result"].includes(event.type)) c.turnText = ((c.turnText || "") + text).slice(-16000);
      const b = bodies.get(event.id) || { text: "", sequence: 0, truncated: false };
      b.text += text + (typeof event.delta === "string" || ["delta", "text-delta"].includes(event.type) ? "" : "\n");
      if (b.text.length > 200000) { b.text = b.text.slice(-200000); b.truncated = true; }
      b.sequence = ++contentSequence; b.at = t; bodies.set(event.id, b);
    }
    if (["result", "error", "interrupted"].includes(event.type) && c.turnEndedAt && c.turnId) {
      completedResults.set(JSON.stringify([c.id, c.generation, c.turnId]), { turnId: c.turnId, actionId: c.completedActionId, status: c.turnState, at: c.turnEndedAt, text: c.turnText || "", source: "chat-events" });
      while (completedResults.size > 200) completedResults.delete(completedResults.keys().next().value);
    }
  }
  function list() {
    const out = [];
    for (const s of getRuntime?.()?.listSnapshots() || []) {
      const u = ui.get(s.id) || {}, a = activity.get(s.id);
      out.push({ ...u, ...s, kind: u.kind || s.provider,
        name: s.conversation?.title || u.name || s.terminalTitle || s.provider,
        conversationTitle: s.conversation?.title,
        aliases: [...new Set([u.name, u.threadRef?.title, s.conversation?.title].filter(value => typeof value === "string" && value.trim()))],
        status: s.pendingInput ? "awaiting activity" : s.turnState,
        lastActivityAt: a?.generation === s.generation ? a.lastActivityAt : undefined,
        lastOutputAt: a?.generation === s.generation ? a.lastOutputAt : undefined,
        agentPid: a?.generation === s.generation ? a.pid : undefined,
        terminalPid: a?.generation === s.generation ? a.terminalPid : undefined });
    }
    for (const c of chats.values()) if (!c.closed) { const u = ui.get(c.id); out.push({ ...u, ...c, name: u?.threadRef?.title || u?.name || c.kind, conversationTitle: u?.threadRef?.title,
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
      complete: false, status: s.status, turnId: s.turnId, turnState: s.turnState,
      completedResult: structuredClone(completedResults.get(JSON.stringify([s.id, s.generation, target.completedTurnId || s.completedTurnId]))) };
  }
  return { updateUi, outgoing, ingest, list, readChat, projectPaths: () => projectPaths, get: id => list().find(s => s.id === id),
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
  let inventorySequence = 0, appliedInventorySequence = 0;
  const history = createOrchestratorHistoryProcess({ getConfig: () => {
    const current = directory.list();
    const roots = [...new Set([...directory.projectPaths(), ...current.map(s => s.cwd)].filter(Boolean))];
    const scopes = current.filter(s => s.kind !== "terminal").map(s => ({ provider: s.kind, cwd: s.cwd,
      claudeHome: s.providerProfileId ? "custom" : "global", providerProfileId: s.providerProfileId, ownedThreadIds: [s.threadRef?.id, s.resumeRef?.id].filter(Boolean),
      plannerProvider: s.fusionPlannerFamily || "claude", fusion: s.kind === "fusion", openFusion: s.kind === "openfusion" }));
    for (const cwd of roots) for (const provider of ["codex", "claude", "claude-custom", "cursor", "gemini", "kimi", "kimi-custom", "qwen", "opencode", "openfusion", "fusion"]) scopes.push({ provider, cwd });
    return { ...options.getHistoryConfig?.(), scopes };
  } });
  const delivery = createOrchestratorDelivery({
    getSession: id => { const s = directory.get(id); return s && { ...s, pendingInteraction: relay.getState().requests.some(r => r.sessionId === id && r.generation === s.generation && r.state === "pending") }; },
    write: payload => hostAction(sendPty, payload),
    reserveInput: payload => { const runtime = getRuntime(), reservation = runtime.recordInput?.(payload); return reservation ? () => runtime.releaseInput?.(reservation) : undefined; },
    onUpdate: result => relay.recordDelivery(result)
  });
  const terminalInput = createTerminalInput({ getSession: id => directory.get(id), readSession: target => observations.read(target),
    write: ({ signal, ...payload }) => hostAction(sendPty, payload, 'action', signal) });
  let disposed = false, inventoryTimer = null, publicationTimer = null, voice, activation = 0;
  let permissionActivation = null;
  const permissionLifetime = new AbortController();
  const microphonePermission = options.microphonePermission || createMicrophonePermission({ userDataPath: app.getPath("userData"), getMainWindow, dialog, systemPreferences, shell });
  let voiceReady = false, captureToken = 0, captureReady = false, indicatorVisible = false;
  const captureWaiters = new Set();
  const captureFlushes = new Map();
  let capturedSamples = 0;
  const surface = createVoiceOverlayWindow({ BrowserWindow, screen, canCapture: () => microphonePermission.isGranted(),
    onClosed: () => { void voice?.setListening(false); },
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
      const finish = result => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); pendingUi.delete(id); resolve(result); };
      const abort = () => finish({ ok: false, status: dispatched ? "unknown" : "cancelled", error: dispatched ? "Workspace action was dispatched before cancellation; its outcome is unconfirmed. No automatic retry." : "Cancelled before workspace dispatch." });
      const timer = setTimeout(() => finish({ ok: false, status: "unknown", error: "Workspace acknowledgment timed out; no automatic retry." }), 20000);
      if (signal?.aborted) return abort();
      pendingUi.set(id, finish); signal?.addEventListener("abort", abort, { once: true });
      try {
        if (payload.id && payload.generation) currentTarget({ id: payload.id, generation: payload.generation, signal });
        if (signal?.aborted) return abort();
        dispatched = true;
        main.webContents.send("orchestrator:ui-action", { id, kind, payload });
      } catch (error) { finish({ ok: false, status: dispatched ? "unknown" : "rejected", error: String(error?.message || error) }); }
    });
  }
  async function refreshInventory() {
    if (disposed) return;
    const sequence = ++inventorySequence;
    const result = await requestUi("inventory");
    if (!disposed && result?.ok && sequence > appliedInventorySequence) { appliedInventorySequence = sequence; directory.updateUi(result.sessions || result.items || [], result.projectPaths || []); }
    await relay.refresh();
    await delivery.observe();
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
      const finish = r => { clearTimeout(timer); if (pendingHost.get(actionId)?.finish === finish) pendingHost.delete(actionId); resolve(r); };
      const timer = setTimeout(() => finish({ ok: false, status: "unknown", error: "Delivery unconfirmed. The action was not retried." }), 15000);
      pendingHost.set(actionId, { finish, engine, id: payload.id, generation: payload.generation });
      try { if (!send({ type, payload: { ...payload, actionId } })) finish({ ok: false, status: "rejected", error: "Agent host is unavailable." }); }
      catch (error) { finish({ ok: false, status: "unknown", error: String(error?.message || error) }); }
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
  async function allowedPath(raw) {
    if (typeof raw !== "string" || !path.isAbsolute(raw)) throw new Error("An absolute path is required.");
    const resolved = await fs.promises.realpath(raw);
    const roots = [app.getPath("documents"), ...directory.projectPaths(), ...directory.list().map(s => s.cwd)];
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
    const base = { ...payload, id: s.id, generation: s.generation, actionId: payload.actionId || randomUUID() };
    if (kind === "openfusion") return hostAction(sendOpenFusion, base, payload.kind === "permission" ? "permission" : payload.kind === "progress" ? "question-progress" : "question");
    const control = getTelemetry().getFusionSessionControl(s.id);
    if (!control?.controlUrl) return { ok: false, error: "Fusion answer bridge unavailable." };
    return hostAction(sendFusion, { ...base, ...control }, "answer-question");
  }
  async function dispatchAction(action) {
    const kind = action.kind;
    const check = () => { if (disposed || action.signal?.aborted) throw new Error("Cancelled."); };
    const checkedHost = (send, payload, type) => { check(); currentTarget(action); return hostAction(send, payload, type, action.signal); };
    const createdTarget = result => {
      const session = result?.ok && result.id ? directory.get(result.id) : null;
      return session && (result.launchToken === undefined || session.launchToken === result.launchToken)
        ? { ...result, target: { id: session.id, generation: session.generation, launchToken: session.launchToken } } : result;
    };
    check();
    if (kind === "navigate") {
      if (!["settings", "history", "orchestrator", "multi", "project"].includes(action.view)) return { ok: false, error: "Choose a supported application view." };
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
      if (action.path) { action.path = await allowedPath(action.path); if (!(await fs.promises.stat(action.path)).isDirectory()) throw new Error("Project path must be a folder."); }
      if (action.cwd) { action.cwd = await allowedPath(action.cwd); if (!(await fs.promises.stat(action.cwd)).isDirectory()) throw new Error("Session folder must be a directory."); }
      const { signal, ...payload } = action;
      const result = await requestUi(kind, { ...payload, kind: action.kindOfSession || action.agentKind || action.launcherKind || action.kind }, signal);
      await refreshInventory(); return createdTarget(result);
    }
    if (["open_file", "open_folder"].includes(kind)) {
      if (typeof action.path !== "string") throw new Error("A path is required.");
      const resolved = await allowedPath(action.path);
      const stat = await fs.promises.stat(resolved);
      if (kind === "open_folder" && !stat.isDirectory()) throw new Error("This path is not a folder.");
      if (kind === "open_file" && (!stat.isFile() || /\.(exe|com|bat|cmd|ps1|lnk|url|msi)$/i.test(resolved))) throw new Error("This is not an openable document.");
      check(); const error = await shell.openPath(resolved);
      return error ? { ok: false, error } : { ok: true, status: "opened", path: resolved, text: "Opened in the default application." };
    }
    const s = await currentTarget(action);
    if (kind === 'terminal_interact') return terminalInput.handle(action);
    if (["focus_session", "stage_draft", "get_draft", "stage_handoff", "restart", "close"].includes(kind)) {
      const { signal, ...payload } = action;
      const result = await requestUi(kind, { ...payload, id: s.id, generation: s.generation }, signal);
      if (kind === "close" && result.ok) observations.forget(s.id, s.generation);
      return result;
    }
    if (["answer_question", "permission"].includes(kind)) {
      const base = { id: s.id, generation: s.generation, actionId: action.actionId,
        requestId: action.requestId, answers: action.answers, reply: action.reply || action.decision, revision: action.revision };
      if (s.kind === "openfusion") {
        if (base.answers && !Array.isArray(base.answers)) {
          const request = relay.getState().requests.find(r => r.id === base.requestId && r.sessionId === s.id);
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
      if (typeof action.text !== "string" || !action.text.trim()) throw new Error("A prompt is required.");
      if (s.kind === "fusion") {
        if (s.status === "running") {
          check(); currentTarget(action); const route = await getTelemetry().steerFusionSession(s.id, action.text);
          await currentTarget(action);
          if (!route || !["routing", "steered", "skipped"].includes(route.status)) return { ok: false, status: "unknown", error: "Steering delivery is unconfirmed; no duplicate prompt was sent." };
          return checkedHost(sendFusion, { id: s.id, generation: s.generation, text: action.text, routed: ["routing", "steered"].includes(route.status), actionId: action.actionId }, "steer");
        }
        return checkedHost(sendFusion, { id: s.id, generation: s.generation, text: action.text, actionId: action.actionId }, "input");
      }
      if (s.kind === "openfusion") return checkedHost(sendOpenFusion, { id: s.id, generation: s.generation, text: action.text, mode: s.mode || "auto", actionId: action.actionId }, "input");
      if (action.operator === true) return terminalInput.handle({ ...action, target: { id: s.id, generation: s.generation }, submit: true });
      return delivery.submit({ ...action, target: { id: s.id, generation: s.generation } });
    }
    throw new Error(`Unsupported action: ${kind}`);
  }
  const relay = createOrchestrator({ userDataPath: app.getPath("userData"), secureStorage: safeStorage, fetch: options.fetch, interpretIntent: options.interpretIntent,
    resolveWorkspaceIdentity: createWorkspaceIdentity(),
    getSessions: () => directory.list(),
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
    getRoots: () => ({ documents: app.getPath("documents"), projects: [...new Set([...directory.projectPaths(), ...directory.list().map(s => s.cwd)].filter(Boolean))] }),
    onCancel: input => { if (!input?.requestId) delivery.cancel(); voice?.cancelSpeech(input); },
    onUpstreamError: info => voice?.announceError(info),
    onChange: state => broadcast("orchestrator:state", { ...state, ready: state.ready && voiceReady, voiceReady }),
    onSpeak: event => {
      if (event.origin === "interaction") {
        const request = relay.getState().requests.find(r => r.id === event.requestId && r.sessionId === event.sessionId && r.generation === event.generation && r.revision === event.revision && r.state === "pending");
        const session = directory.get(request?.sessionId);
        return request ? voice?.announceInteraction({ ...request, sessionName: session?.name, projectName: session?.projectName }) : undefined;
      }
      return voice?.speak({ ...event, id: event.replyId });
    }
  });
  voice = (options.voiceFactory || createVoiceController)({ orchestrator: relay, getKey: () => relay.getKey(), getSettings: () => relay.getSettings(), fetch: options.fetch,
    modelPath: app.isPackaged ? path.join(process.resourcesPath, "voice") : path.join(__dirname, "..", "vendor", "voice"),
    emit: state => broadcast("voice:state", { ...state, captureToken, indicatorVisible }), onAudio: chunk => surface.send("voice:audio", chunk) });

  const snapshot = () => { const state = relay.getState(); return { ...state, ready: state.ready && voiceReady, voiceReady }; };
  const voiceSnapshot = () => ({ ...voice.getState(), captureToken, indicatorVisible });
  function showIndicator() { indicatorVisible = true; broadcast("voice:state", voiceSnapshot()); return { ok: true }; }
  function hideIndicator() { indicatorVisible = false; broadcast("voice:state", voiceSnapshot()); return { ok: true }; }
  const publish = () => broadcast("orchestrator:state", snapshot());
  function finishCapture(result) { for (const waiter of captureWaiters) waiter.finish(result); }
  function invalidateCapture() {
    captureToken++; capturedSamples = 0;
    for (const pending of captureFlushes.values()) pending.finish({ ok: false, status: 'cancelled', error: 'Microphone capture changed.' });
    voice?.configure({ captureToken });
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
    activation++; captureReady = false;
    invalidateCapture();
    finishCapture({ ok: false, error });
    voice?.configure({ microphoneError: error });
    if (relay.getState().enabled) await relay.setEnabled(false);
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
    const token = ++activation;
    permissionActivation?.abort();
    permissionActivation = null;
    if (!enabled) { invalidateCapture(); captureReady = false; finishCapture({ ok: false, status: "cancelled", error: "Voice activation was cancelled." }); voice.cancelSpeech(); await voice.setListening(false); hideIndicator(); return relay.setEnabled(false); }
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
      if (!listening.ok) { if (token === activation) { await voice.setListening(false); await relay.setEnabled(false); } return listening; }
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
      if (!audio.ok) { if (relay.getState().enabled) await relay.setEnabled(false); return { ...result, ...audio }; }
      if (wasListening && relay.getState().enabled) {
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
      { label: voice.getState().listening ? 'Turn off voice' : relay.getSettings().handsFreeEnabled ? 'Turn on voice (Hey Vibe or Space)' : 'Turn on voice (hold Space to talk)', click: () => { void setEnabled(!voice.getState().listening); } },
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
      if (!surface.isSender(event.sender) || p.captureToken !== captureToken) return { ok: false, status: "stale" };
      if (p.microphoneError) { await microphoneFailure(String(p.microphoneError).slice(0, 200)); return { ok: false, error: voice.getState().error }; }
      if (!voice.getState().listening) return { ok: false, status: "stale" };
      captureReady = true; finishCapture({ ok: true }); return { ok: true };
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
    if (!surface.isSender(event.sender) || !relay.getState().enabled || !voice.getState().listening || p?.captureToken !== captureToken) return;
    if (!Array.isArray(p.samples) || !Number.isSafeInteger(p.sampleStart) || p.sampleStart < capturedSamples) return;
    const result = voice.frames(p);
    if (result?.ok) capturedSamples = p.sampleStart + p.samples.length;
  });
  ipcMain.on("orchestrator:ui-result", (event, p) => { if (allowed(event, true)) pendingUi.get(p.id)?.(p.result); });
  inventoryTimer = setInterval(() => { if (relay.getState().enabled) void refreshInventory(); }, 4000); inventoryTimer.unref?.();
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
    if (current && event.generation && current.generation !== event.generation) return false;
    directory.ingest(kind, event);
    const ended = directory.get(event.id);
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
    delivery.forget(id, generation); observations.forget(id, generation); completions.forget(id, generation); directory.forget(id, generation);
    for (const request of relay.getState().requests) if (request.sessionId === id && request.generation === generation && request.state === "pending") {
      const scope = { id: request.id, sessionId: id, generation, revision: request.revision };
      relay.resolveInteraction(scope); voice.resolveInteraction?.(scope);
    }
    publishSoon();
  }
  let disposal;
  function dispose() {
    if (disposed) return disposal || Promise.resolve(); disposed = true; activation++; clearInterval(inventoryTimer); clearTimeout(publicationTimer);
    permissionLifetime.abort(); permissionActivation?.abort(); permissionActivation = null;
    delivery.dispose(); terminalInput.dispose(); history.dispose(); voice.dispose(); disposal = relay.dispose(); observations.dispose(); completions.clear(); directory.clear();
    finishCapture({ ok: false, error: "Application closed." });
    for (const pending of captureFlushes.values()) pending.finish({ ok: false, status: 'cancelled', error: 'Application closed.' });
    surface.dispose();
    for (const finish of pendingUi.values()) finish({ ok: false, status: "cancelled", error: "Application closed." });
    for (const pending of pendingHost.values()) pending.finish({ ok: false, status: "unknown", error: "Application closed before acknowledgment." });
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
