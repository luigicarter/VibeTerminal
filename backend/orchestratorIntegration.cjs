"use strict";

const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

// This facade composes existing engine owners. It never assigns work or makes
// approval decisions. Its new command channel always captures a generation.
function createSessionDirectory({ getRuntime, now = Date.now } = {}) {
  const ui = new Map(), chats = new Map(), activity = new Map(), bodies = new Map();
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
          mode: p.mode || p.runMode || "auto", signature, lastActivityAt: now(), closed: false });
        bodies.delete(p.id);
      }
    }
    const c = chats.get(p.id);
    if (c) {
      message = { ...message, payload: { ...p, generation: message.type === "start" ? c.generation : (p.generation || c.generation) } };
      if (message.type === "mode") c.mode = p.mode;
      if (message.type === "stop") { c.closed = true; c.status = "exited"; bodies.delete(p.id); chats.delete(p.id); }
    }
    return message;
  }
  function ingest(kind, event) {
    if (!event?.id || event.replay) return;
    const t = now();
    if (kind === "terminal") {
      const old = activity.get(event.id);
      const a = old?.generation === event.generation ? old : { generation: event.generation };
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
    if (["turn-start", "tool-call", "delta", "text-delta"].includes(event.type)) c.status = "running";
    if (["permission", "question", "interaction-request"].includes(event.type)) c.status = "waiting";
    if (event.type === "result") c.status = event.subtype === "error" ? "failed" : "completed";
    if (event.type === "result" && event.gate) c.checkEvidence = { ...event.gate, observedAt: t };
    if (event.type === "error") c.status = "failed";
    if (event.type === "closed") { c.status = "exited"; c.closed = true; bodies.delete(event.id); chats.delete(event.id); }
    if (event.type === "tool-call") c.lastTool = { name: event.name || event.toolName, at: t };
    const text = event.delta || event.text || (event.type === "error" ? event.message : "");
    if (typeof text === "string" && text) {
      const b = bodies.get(event.id) || { text: "", sequence: 0, truncated: false };
      b.text += text + (typeof event.delta === "string" || ["delta", "text-delta"].includes(event.type) ? "" : "\n");
      if (b.text.length > 200000) { b.text = b.text.slice(-200000); b.truncated = true; }
      b.sequence = ++contentSequence; b.at = t; bodies.set(event.id, b);
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
        agentPid: a?.generation === s.generation ? a.pid : undefined });
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
      complete: false, status: s.status };
  }
  return { updateUi, outgoing, ingest, list, readChat, projectPaths: () => projectPaths, get: id => list().find(s => s.id === id),
    forget: (id, generation) => { if (activity.get(id)?.generation === generation) activity.delete(id); if (chats.get(id)?.generation === generation) { chats.delete(id); bodies.delete(id); } },
    clear: () => { ui.clear(); chats.clear(); activity.clear(); bodies.clear(); } };
}

function installOrchestrator(options) {
  const { app, BrowserWindow, ipcMain, screen, shell, safeStorage, getMainWindow,
    getRuntime, sendPty, sendFusion, sendOpenFusion, getTelemetry, getChanges } = options;
  const { createOrchestrator } = require("./orchestrator.cjs");
  const { createTerminalObservation } = require("./terminalObservation.cjs");
  const { createWorkspaceSetupStore } = require("./workspaceSetups.cjs");
  const { createOrchestratorDelivery } = require("./orchestratorDelivery.cjs");
  const { createOrchestratorHistoryProcess } = require("./orchestratorHistoryProcess.cjs");
  const { createVoiceController } = require("./voiceController.cjs");
  const changes = require("./workspaceChanges.cjs");
  const directory = createSessionDirectory({ getRuntime });
  const observations = createTerminalObservation();
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
    stage: async (action, reason) => {
      await currentTarget(action);
      const result = await requestUi("stage_draft", { id: action.target.id, text: action.text, generation: action.target.generation,
        ...(action.expectedDraftRevision !== undefined ? { mode: "replace", expectedRevision: action.expectedDraftRevision } : {}) }, action.signal);
      return result.ok ? { ...result, text: `Prompt preserved as a draft: ${reason}` } : result;
    },
    onUpdate: result => relay.recordDelivery(result)
  });
  let overlay = null, disposed = false, inventoryTimer = null, publicationTimer = null, voice;
  const positionPath = path.join(app.getPath("userData"), "voice-overlay-position.json");
  function broadcast(channel, value) {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, value);
  }
  function allowed(event, mainOnly = false) {
    const main = getMainWindow();
    return event.sender === main?.webContents || (!mainOnly && event.sender === overlay?.webContents);
  }
  function guarded(channel, fn, mainOnly = false) {
    ipcMain.handle(channel, async (event, payload) => {
      if (!allowed(event, mainOnly)) return { ok: false, error: "Unsupported caller." };
      try { return await fn(payload || {}); } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 1000) }; }
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
      return delivery.submit({ ...action, target: { id: s.id, generation: s.generation } });
    }
    throw new Error(`Unsupported action: ${kind}`);
  }
  const relay = createOrchestrator({ userDataPath: app.getPath("userData"), secureStorage: safeStorage,
    getSessions: () => directory.list(),
    readSession: async target => ["fusion", "openfusion"].includes(directory.get(target.id)?.kind) ? directory.readChat(target) : observations.read(target),
    dispatchAction,
    getRoots: () => ({ documents: app.getPath("documents"), projects: [...new Set([...directory.projectPaths(), ...directory.list().map(s => s.cwd)].filter(Boolean))] }),
    onCancel: () => { delivery.cancel(); voice?.cancelSpeech(); },
    onUpstreamError: info => voice?.announceError(info),
    onChange: state => broadcast("orchestrator:state", state),
    onSpeak: event => {
      if (event.origin === "interaction") {
        const request = relay.getState().requests.find(r => r.id === event.requestId && r.sessionId === event.sessionId && r.generation === event.generation && r.revision === event.revision && r.state === "pending");
        const session = directory.get(request?.sessionId);
        return request ? voice?.announceInteraction({ ...request, sessionName: session?.name, projectName: session?.projectName }) : undefined;
      }
      return voice?.speak({ ...event, id: event.replyId });
    }
  });
  voice = createVoiceController({ orchestrator: relay, getKey: () => relay.getKey(), getSettings: () => relay.getSettings(),
    modelPath: app.isPackaged ? path.join(process.resourcesPath, "voice") : path.join(__dirname, "..", "vendor", "voice"),
    emit: state => broadcast("voice:state", state), onAudio: chunk => overlay?.webContents.send("voice:audio", chunk) });

  function showOverlay() {
    if (disposed) return { ok: false };
    if (overlay && !overlay.isDestroyed()) { overlay.showInactive(); return { ok: true }; }
    let saved;
    try { saved = JSON.parse(fs.readFileSync(positionPath, "utf8")); } catch {}
    const display = saved ? screen.getDisplayMatching(saved) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const area = display.workArea, width = Math.min(420, area.width), height = Math.min(300, area.height);
    const x = Math.max(area.x, Math.min(saved?.x ?? area.x + (area.width - width) / 2, area.x + area.width - width));
    const y = Math.max(area.y, Math.min(saved?.y ?? area.y + area.height - height - 20, area.y + area.height - height));
    overlay = new BrowserWindow({ width, height, x: Math.round(x), y: Math.round(y), frame: false,
      alwaysOnTop: true, skipTaskbar: true, show: false, resizable: false, backgroundColor: "#111111",
      title: "vibeTerminal Orchestrator", webPreferences: { preload: path.join(__dirname, "..", "preload", "voicePreload.cjs"),
        nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false, autoplayPolicy: "no-user-gesture-required", partition: "voice-overlay" } });
    overlay.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    overlay.webContents.on("will-navigate", event => event.preventDefault());
    overlay.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => {
      callback(contents === overlay?.webContents && permission === "media" && !details.mediaTypes?.includes("video"));
    });
    overlay.on("moved", () => { if (!overlay) return; try { fs.mkdirSync(path.dirname(positionPath), { recursive: true }); fs.writeFileSync(positionPath, JSON.stringify(overlay.getBounds())); } catch {} });
    overlay.on("closed", () => { overlay = null; void voice.setListening(false); });
    overlay.once("ready-to-show", () => overlay?.showInactive());
    const devUrl = process.env.VITE_DEV_SERVER_URL;
    if (devUrl) void overlay.loadURL(`${devUrl}/?surface=voice`);
    else void overlay.loadFile(path.join(__dirname, "..", "dist", "index.html"), { query: { surface: "voice" } });
    return { ok: true };
  }
  async function setEnabled(enabled) {
    const result = await relay.setEnabled(Boolean(enabled));
    if (result.ok && enabled) { showOverlay(); await refreshInventory(); }
    if (!enabled) { voice.cancelSpeech(); await voice.setListening(false); overlay?.hide(); }
    return result;
  }
  function clampOverlay() {
    if (!overlay || overlay.isDestroyed()) return;
    const b = overlay.getBounds(), area = screen.getDisplayMatching(b).workArea;
    const width = Math.min(b.width, area.width), height = Math.min(b.height, area.height);
    overlay.setBounds({ width, height, x: Math.max(area.x, Math.min(b.x, area.x + area.width - width)), y: Math.max(area.y, Math.min(b.y, area.y + area.height - height)) });
  }
  screen.on?.("display-removed", clampOverlay);
  screen.on?.("display-metrics-changed", clampOverlay);
  guarded("orchestrator:get-state", () => relay.getState());
  guarded("orchestrator:configure", async p => { voice.cancelSpeech(); if (p.apiKey !== undefined || p.key !== undefined) await voice.setListening(false); return relay.configure(p); }, true);
  guarded("orchestrator:models", p => relay.models(p.kind));
  guarded("orchestrator:test", () => relay.testConnection(), true);
  guarded("orchestrator:enabled", p => setEnabled(p.enabled));
  guarded("orchestrator:send", async p => { await refreshInventory(); return relay.send(p); });
  guarded("orchestrator:cancel", () => { voice.cancelSpeech(); return relay.cancel(); });
  guarded("orchestrator:dispatch", async p => { await refreshInventory(); return relay.dispatch(p); });
  guarded("orchestrator:preferences", p => relay.preferences(p));
  guarded("orchestrator:overlay", () => showOverlay());
  guarded("orchestrator:open-main", async () => { const w = getMainWindow(); if (w?.isMinimized()) w.restore(); w?.show(); return { ok: true }; });
  guarded("orchestrator:changes", async p => { const target = directory.get(p.id); return getChanges(target?.cwd || p.cwd); });
  guarded("orchestrator:changes-list", async p => changes.listChanges(await allowedPath(p.cwd)));
  guarded("orchestrator:change-read", async p => changes.readChange(await allowedPath(p.cwd), p.path));
  guarded("orchestrator:setups-list", p => setups.list(p));
  guarded("orchestrator:setups-save", p => setups.save(p), true);
  guarded("orchestrator:setups-remove", p => setups.remove(p.id), true);
  guarded("voice:get-state", () => voice.getState());
  guarded("voice:configure", p => {
    if (p.openWorkspace) { const w = getMainWindow(); if (w?.isMinimized()) w.restore(); w?.show(); }
    if (typeof p.collapsed === "boolean" && overlay) overlay.setSize(420, p.collapsed ? 86 : 420);
    return voice.configure(p);
  });
  guarded("voice:listening", p => relay.getState().enabled ? voice.setListening(p.enabled) : { ok: false, error: "Enable Orchestrator first." });
  guarded("voice:send-audio", p => voice.sendAudio(p));
  guarded("voice:cancel-speech", () => voice.cancelSpeech());
  ipcMain.on("voice:frames", (event, p) => { if (event.sender === overlay?.webContents && relay.getState().enabled) voice.frames(p); });
  ipcMain.on("orchestrator:ui-result", (event, p) => { if (allowed(event, true)) pendingUi.get(p.id)?.(p.result); });
  inventoryTimer = setInterval(() => { void refreshInventory(); }, 4000); inventoryTimer.unref?.();
  // Read-only validation of a previously configured account. No inference,
  // microphone capture, or paid model request starts with the application.
  if (relay.getKey() && relay.getSettings().model) void relay.testConnection();
  function incoming(kind, event) {
    if (disposed) return;
    const current = event?.id ? directory.get(event.id) : undefined;
    // A late acknowledgment still describes its original action, but stale
    // output/process events cannot replace the current pane's PID or activity.
    if (event?.type === "action-result") { const pending = pendingHost.get(event.actionId);
      if (pending && pending.engine === kind && pending.id === event.id && pending.generation === event.generation) pending.finish({ ...event, status: event.status || "acknowledged" }); }
    if (current && event.generation && current.generation !== event.generation) return false;
    directory.ingest(kind, event);
    if (kind === "terminal") void observations.ingest(event).catch(() => {});
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
    delivery.forget(id, generation); observations.forget(id, generation); directory.forget(id, generation);
    for (const request of relay.getState().requests) if (request.sessionId === id && request.generation === generation && request.state === "pending") {
      const scope = { id: request.id, sessionId: id, generation, revision: request.revision };
      relay.resolveInteraction(scope); voice.resolveInteraction?.(scope);
    }
    publishSoon();
  }
  function dispose() {
    if (disposed) return; disposed = true; clearInterval(inventoryTimer); clearTimeout(publicationTimer);
    delivery.dispose(); history.dispose(); voice.dispose(); relay.dispose(); observations.dispose(); directory.clear();
    screen.removeListener?.("display-removed", clampOverlay);
    screen.removeListener?.("display-metrics-changed", clampOverlay);
    for (const finish of pendingUi.values()) finish({ ok: false, status: "cancelled", error: "Application closed." });
    for (const pending of pendingHost.values()) pending.finish({ ok: false, status: "unknown", error: "Application closed before acknowledgment." });
    if (overlay && !overlay.isDestroyed()) overlay.destroy(); overlay = null;
  }
  app.once("before-quit", dispose);
  return { incoming, outgoing: directory.outgoing, refreshInventory, dispose, getState: relay.getState, directory, answerExisting, forgetTerminal };
}

module.exports = { createSessionDirectory, installOrchestrator };
