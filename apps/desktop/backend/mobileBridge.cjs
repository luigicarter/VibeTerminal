'use strict';
// Opt-in, read-only LAN bridge for the phone app.
//
// This build exposes observation only. There is deliberately no endpoint that
// writes to a terminal, sends a key, interrupts a turn or submits an
// Orchestrator request: every POST is refused with 404 and no code path here
// reaches sendToPtyHost or the relay's send/dispatch surface. See
// docs/mobile-bridge.md for the reserved write contract and why it is absent.
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { buildState, fingerprint, sessionTitle } = require('./mobileBridgeState.cjs');
const { canonicalCode, formatCode, cleanDeviceName, cleanPlatform } = require('./mobileBridgeSettings.cjs');
const { renderScreen, renderScrollback, diffRows, sameCursor, createFramePump,
  STREAM_PROTOCOL, SCROLLBACK_LINES } = require('./mobileBridgeFrames.cjs');
const { terminalPage } = require('./mobileBridgeTerminalPage.cjs');

const PROTOCOL = 1;
const INVENTORY_THROTTLE_MS = 2000;
const NOTIFY_DEBOUNCE_MS = 150;
const ORCHESTRATOR_POLL_MS = 2000;
const MAX_WAIT_MS = 25000;
const SCREEN_SAMPLE_CHARS = 4000;
const DEFAULT_SCREEN_CHARS = 12000;
const MAX_SCREEN_CHARS = 200000;
const DEFAULT_HISTORY_LIMIT = 200;
const MAX_HISTORY_LIMIT = 2000;
// What a phone actually reads in one go. The relay's own history can be long;
// a mobile poll should not carry it.
const DEFAULT_ORCHESTRATOR_LIMIT = 100;
const MAX_ORCHESTRATOR_TASKS = 100;
const DEFAULT_TRANSCRIPT_LIMIT = 50;
const MAX_TRANSCRIPT_LIMIT = 500;
const TRANSCRIPT_CHARS = 16000;
// Below this a gzip member's own header costs more than the saving.
const GZIP_MIN_BYTES = 512;
const AUTH_WINDOW_MS = 60000;
const AUTH_FAILURE_LIMIT = 10;
// Discovery and pairing answer before any credential exists, so they carry their
// own budget: enough for a phone to scan a subnet and poll, not enough to farm.
const PUBLIC_WINDOW_MS = 60000;
const PUBLIC_REQUEST_LIMIT = 30;
const PAIR_TTL_MS = 120000;
const MAX_PENDING_PAIRS = 3;
const MAX_PAIR_BODY_BYTES = 8192;
const AUTO_APPROVE_DELAY_MS = 500;
// `scrollback` is the bridge's own: the frame protocol ships up to 300 lines
// above the viewport when a phone attaches, so the decoder has to keep them.
const OBSERVATION_LIMITS = { maxHistoryBytes: 256 * 1024, globalHistoryBytes: 8 * 1024 * 1024, scrollback: SCROLLBACK_LINES };
const MAX_STREAMS = 8;
const KEEPALIVE_MS = 15000;
// The desktop's own xterm build, served to the phone's terminal page. Both are
// existing desktop dependencies; nothing is fetched from a CDN.
const VENDOR_ASSETS = {
  'xterm.js': { module: '@xterm/xterm/lib/xterm.js', type: 'text/javascript; charset=utf-8' },
  'xterm.css': { module: '@xterm/xterm/css/xterm.css', type: 'text/css; charset=utf-8' },
  'addon-fit.js': { module: '@xterm/addon-fit/lib/addon-fit.js', type: 'text/javascript; charset=utf-8' }
};
// Saved native conversation stores the history service can actually open.
const HISTORY_PROVIDERS = new Set(['codex', 'open-codex', 'claude', 'claude-custom', 'cursor', 'gemini', 'grok', 'kimi', 'kimi-custom', 'qwen', 'opencode']);
const CHAT_KINDS = new Set(['fusion', 'openfusion']);

// Compare digests, not the codes: equal-length buffers keep timingSafeEqual from
// throwing and stop a wrong-length guess from being distinguishable by timing.
function sameSecret(a, b) {
  const left = crypto.createHash('sha256').update(String(a)).digest();
  const right = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(left, right);
}
function lanAddresses(interfaces) {
  const out = [];
  for (const entries of Object.values(interfaces || {})) {
    for (const entry of entries || []) {
      const family = entry.family === 'IPv4' || entry.family === 4;
      if (!family || entry.internal || !entry.address || entry.address.startsWith('169.254.')) continue;
      out.push(entry.address);
    }
  }
  return [...new Set(out)];
}
// backend/*.cjs are unpacked from the asar but @xterm/xterm is not, so
// require.resolve cannot reach it from a packaged build. Electron reads straight
// through app.asar, so the packed copy is the fallback rather than a new
// packaging rule.
const vendorCache = new Map();
function vendorAsset(name) {
  if (vendorCache.has(name)) return vendorCache.get(name);
  const asset = VENDOR_ASSETS[name];
  if (!asset) return null;
  const relative = path.join('node_modules', ...asset.module.split('/'));
  const candidates = [];
  try { candidates.push(require.resolve(asset.module)); } catch { /* packaged builds resolve by path */ }
  candidates.push(path.join(__dirname, '..', relative));
  candidates.push(path.join(__dirname.replace(/app\.asar\.unpacked/, 'app.asar'), '..', relative));
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'app.asar', relative));
  for (const candidate of candidates) {
    try {
      const body = fs.readFileSync(candidate);
      // The content hash is the cache key the URL carries: the same bytes keep
      // the same URL for a year, and a build upgrade mints a new one instead of
      // hoping a phone revalidates.
      const hash = crypto.createHash('sha256').update(body).digest('hex').slice(0, 16);
      let compressed = null;
      try { compressed = zlib.gzipSync(body, { level: zlib.constants.Z_BEST_COMPRESSION }); } catch { compressed = null; }
      const loaded = { body, type: asset.type, hash, gzip: compressed, url: `/vendor/${hash}/${name}` };
      vendorCache.set(name, loaded);
      return loaded;
    } catch { /* try the next layout */ }
  }
  return null;
}
// Hashed URLs for the terminal page, resolved once per process.
function vendorManifest() {
  const manifest = {};
  for (const name of Object.keys(VENDOR_ASSETS)) manifest[name] = vendorAsset(name)?.url || `/vendor/${name}`;
  return manifest;
}
// An absent query parameter reads as null, and Number(null) is 0 — which would
// silently clamp every default to the minimum. Absent means "use the default".
function boundedNumber(value, fallback, min, max) {
  if (value === null || value === undefined || String(value).trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function createMobileBridge(options = {}) {
  const {
    settings,
    getDirectory = () => null,
    refreshInventory = async () => {},
    getOrchestratorState = () => null,
    getHistoryConfig = () => ({}),
    version = '0.0.0',
    hostname = () => os.hostname(),
    networkInterfaces = () => os.networkInterfaces(),
    now = () => Date.now(),
    log = message => console.log(`[mobile-bridge] ${message}`),
    createServer = http.createServer,
    onStatus = () => {},
    onPairRequest = () => {},
    // Fixtures shorten this; nothing else may.
    keepaliveMs = KEEPALIVE_MS
  } = options;
  if (!settings) throw new Error('Mobile bridge settings are required.');

  const observation = options.observation
    || require('./terminalObservation.cjs').createTerminalObservation(OBSERVATION_LIMITS);
  const ownsObservation = !options.observation;
  const streams = new Set();
  // Coalesces repaints into at most twelve frames a second per pane.
  const pump = options.framePump || createFramePump(options.frameClock);
  // Per-pane accounting behind the frames: the PTY bytes that came in, the
  // compressed bytes that went out, and the frames it took. Observation only —
  // it is what `/api/sessions/:id/metrics` reports and what the smoke measures.
  const meters = new Map();
  function meter(id) {
    let entry = meters.get(id);
    if (!entry) { entry = { rawBytes: 0, rawChunks: 0, frames: 0, sentBytes: 0, seq: 0 }; meters.set(id, entry); }
    return entry;
  }
  let history = options.history || null;
  let ownsHistory = false;

  let server = null;
  let listening = false;
  let enabled = false;
  let closed = false;
  let listenError = '';
  let boundHost = '';
  let boundPort = 0;

  let revision = 1;
  let cached = null;
  let cachedPrint = '';
  let rebuilding = null;
  let lastInventoryAt = 0;
  let notifyTimer = null;
  let orchestratorTimer = null;
  let lastPublication = null;
  const waiters = new Set();
  const authFailures = new Map();
  const publicHits = new Map();
  const pairs = new Map();
  const pairWaiters = new Map();

  function report(message, error) {
    try { log(error ? `${message}: ${error && error.message ? error.message : error}` : message); } catch {}
  }
  function publishStatus() { try { onStatus(getStatus()); } catch {} }

  function getStatus() {
    const current = settings.get();
    return {
      enabled: current.enabled === true,
      listening,
      host: listening ? boundHost : current.host,
      port: listening ? boundPort : current.port,
      addresses: lanAddresses(networkInterfaces()),
      code: current.code,
      desktopId: current.desktopId,
      devices: current.devices || [],
      pending: pendingPairs(),
      autoApprove: current.autoApprove === true,
      error: listenError
    };
  }

  // ------------------------------------------------------------- pairing ---
  // A pair request is a short-lived, in-memory offer. Nothing about the
  // workspace is readable until a person on the desktop approves it, and the
  // approval hands over the same code the manual fallback shows.

  function publicPair(record) {
    return { requestId: record.id, deviceName: record.deviceName, platform: record.platform,
      remoteAddress: record.remoteAddress, expiresAt: record.expiresAt };
  }
  function pairStatus(record) {
    return record.status === 'pending' && now() >= record.expiresAt ? 'expired' : record.status;
  }
  function sweepPairs() {
    for (const [id, record] of pairs) {
      if (now() >= record.expiresAt + PAIR_TTL_MS) { pairs.delete(id); pairWaiters.delete(id); }
      else if (record.status === 'pending' && now() >= record.expiresAt) settlePair(record, 'expired');
    }
  }
  function pendingPairs() {
    sweepPairs();
    return [...pairs.values()].filter(record => record.status === 'pending').map(publicPair);
  }
  function wakePair(id) {
    for (const waiter of [...(pairWaiters.get(id) || [])]) { try { waiter(); } catch {} }
  }
  function settlePair(record, status) {
    if (record.status !== 'pending') return;
    record.status = status;
    if (status === 'approved') record.code = formatCode(settings.get().code);
    wakePair(record.id);
    publishStatus();
  }
  function createPair({ deviceName, platform, remoteAddress }) {
    sweepPairs();
    const name = cleanDeviceName(deviceName);
    if (!name) return { ok: false, status: 400, error: 'deviceName is required' };
    if (pendingPairs().length >= MAX_PENDING_PAIRS) return { ok: false, status: 429, error: 'too many pending requests' };
    const record = { id: crypto.randomUUID(), deviceName: name, platform: cleanPlatform(platform),
      remoteAddress, createdAt: now(), expiresAt: now() + PAIR_TTL_MS, status: 'pending' };
    pairs.set(record.id, record);
    report(`pair request from ${record.remoteAddress}: "${record.deviceName}" (${record.platform}); awaiting approval on the desktop`);
    try { onPairRequest(publicPair(record)); } catch (error) { report('pair notification failed', error); }
    publishStatus();
    if (settings.get().autoApprove === true) {
      report(`!! LINA_MOBILE_BRIDGE_AUTO_APPROVE is set: approving "${record.deviceName}" without asking. FIXTURE USE ONLY.`);
      const timer = setTimeout(() => void respondPair(record.id, true), AUTO_APPROVE_DELAY_MS);
      timer.unref?.();
    }
    return { ok: true, requestId: record.id, expiresAt: record.expiresAt };
  }
  async function respondPair(requestId, approve) {
    sweepPairs();
    const record = pairs.get(String(requestId || ''));
    if (!record) return { ok: false, error: 'not found' };
    if (pairStatus(record) !== 'pending') return { ok: false, error: `already ${pairStatus(record)}` };
    if (approve === true) {
      // Record before settling, so the single status publication a UI sees has
      // both the cleared request and the new device. Denial records nothing.
      await settings.rememberDevice({ deviceName: record.deviceName, platform: record.platform, approvedAt: now() })
        .catch(error => report('device record failed', error));
      settlePair(record, 'approved');
    } else settlePair(record, 'denied');
    return { ok: true, status: record.status };
  }
  async function readPair(requestId, wait, response) {
    sweepPairs();
    const id = String(requestId || '');
    const record = pairs.get(id);
    if (!record) return { ok: false, status: 404, error: 'not found' };
    if (wait > 0 && pairStatus(record) === 'pending') {
      await new Promise(resolve => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          const set = pairWaiters.get(id);
          if (set) { set.delete(finish); if (!set.size) pairWaiters.delete(id); }
          clearTimeout(timer);
          response?.off('close', finish);
          resolve();
        };
        const timer = setTimeout(finish, Math.min(wait, Math.max(0, record.expiresAt - now()) + 100));
        timer.unref?.();
        if (!pairWaiters.has(id)) pairWaiters.set(id, new Set());
        pairWaiters.get(id).add(finish);
        response?.on('close', finish);
      });
      sweepPairs();
    }
    const status = pairStatus(record);
    if (status === 'approved') {
      // The code crosses the wire exactly once; the offer is spent on delivery.
      const code = record.code;
      pairs.delete(id); pairWaiters.delete(id);
      publishStatus();
      return { ok: true, status, code };
    }
    return { ok: true, status };
  }

  // ---------------------------------------------------------------- state ---

  function orchestratorState() {
    try { return getOrchestratorState() || null; } catch (error) { report('orchestrator state unavailable', error); return null; }
  }
  async function maybeRefreshInventory() {
    const at = now();
    if (at - lastInventoryAt < INVENTORY_THROTTLE_MS) return;
    lastInventoryAt = at;
    // A renderer round-trip that fails only means the inventory is stale; the
    // runtime snapshots the directory already holds are still served.
    try { await refreshInventory(); } catch (error) { report('inventory refresh failed', error); }
  }
  async function screenFor(record, maxChars) {
    try {
      const view = await observation.read({ id: record.id, generation: record.generation, maxChars });
      return view && view.ok ? view : null;
    } catch (error) { report(`screen read failed for ${record.id}`, error); return null; }
  }
  async function rebuild() {
    await maybeRefreshInventory();
    const directory = getDirectory();
    let records = [];
    let projects = [];
    try { records = directory ? directory.list() || [] : []; } catch (error) { report('session list failed', error); }
    try { projects = directory ? directory.projects() || [] : []; } catch (error) { report('project list failed', error); }
    const screens = {};
    await Promise.all(records.map(async record => {
      if (!record || typeof record.id !== 'string') return;
      const view = await screenFor(record, SCREEN_SAMPLE_CHARS);
      if (view) screens[record.id] = view.text;
    }));
    const state = buildState({ records, projects, orchestrator: orchestratorState(), screens, now: now() });
    const print = fingerprint(state);
    const changed = print !== cachedPrint;
    cachedPrint = print;
    cached = state;
    if (changed) { revision++; wake(); }
    return { ...state, revision };
  }
  function refreshState() {
    if (!rebuilding) {
      rebuilding = rebuild().catch(error => {
        report('state rebuild failed', error);
        return { ...(cached || buildState({ now: now() })), revision };
      }).finally(() => { rebuilding = null; });
    }
    return rebuilding;
  }
  function wake() { for (const waiter of [...waiters]) { try { waiter(); } catch {} } }

  function notify() {
    if (!listening || notifyTimer) return;
    notifyTimer = setTimeout(() => { notifyTimer = null; void refreshState(); }, NOTIFY_DEBOUNCE_MS);
    notifyTimer.unref?.();
  }
  // The relay publishes without touching a terminal, so a waiting phone needs a
  // poll to see it. Only while somebody is actually waiting.
  function syncOrchestratorTimer() {
    if (waiters.size && listening && !orchestratorTimer) {
      orchestratorTimer = setInterval(() => {
        const publication = orchestratorState()?.publicationRevision ?? null;
        if (publication === lastPublication) return;
        lastPublication = publication;
        notify();
      }, ORCHESTRATOR_POLL_MS);
      orchestratorTimer.unref?.();
    } else if ((!waiters.size || !listening) && orchestratorTimer) {
      clearInterval(orchestratorTimer);
      orchestratorTimer = null;
    }
  }

  function ingest(event) {
    if (!enabled || !event) return;
    try { void Promise.resolve(observation.ingest(event)).catch(() => {}); } catch (error) { report('observation ingest failed', error); }
    try { publishStream(event); } catch (error) { report('stream capture failed', error); }
    if (['data', 'created', 'exit', 'resize'].includes(event.type)) notify();
  }
  function forget(id, generation) {
    // A stale generation is somebody else's pane: leave its viewers alone.
    const live = inspectPane(id);
    const mine = generation === undefined || !live || live.generation === generation;
    try { observation.forget(id, generation); } catch {}
    if (mine) {
      try { pump.forget(id); } catch {}
      meters.delete(id);
      closeStreams(id);
    }
    notify();
  }

  // --------------------------------------------------------------- streams ---
  // One server-sent stream per viewing phone, carrying frame protocol v2: the
  // rows of the pane that actually changed, rendered from the bridge's own
  // headless terminal and coalesced to twelve frames a second. It is never a
  // control channel — nothing a client sends on this connection is read, and
  // there is no route it could send one to.

  function inspectPane(id) {
    try { return observation.inspect(id); } catch { return null; }
  }
  function writeEvent(stream, type, payload) {
    if (stream.response.writableEnded || stream.response.destroyed) return;
    const frame = payload === undefined ? `${type}\n\n` : `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
    try {
      if (!stream.gzip) {
        stream.sentBytes += Buffer.byteLength(frame, 'utf8');
        meter(stream.id).sentBytes += Buffer.byteLength(frame, 'utf8');
        stream.response.write(frame);
        return;
      }
      // Flush after every event: a deflate window that waits for more input
      // would hold a frame the phone is meant to draw now.
      stream.gzip.write(frame);
      stream.gzip.flush(zlib.constants.Z_SYNC_FLUSH);
    } catch (error) { report('stream write failed', error); closeStream(stream); }
  }
  function closeStream(stream) {
    if (!streams.delete(stream)) return;
    clearInterval(stream.keepalive);
    try { stream.gzip?.end(); } catch {}
    try { stream.response.end(); } catch {}
    // The last viewer of a pane leaves: stop the frame timer it was driving.
    if (![...streams].some(entry => entry.id === stream.id)) pump.cancel(stream.id);
  }
  function closeStreams(id) {
    for (const stream of [...streams]) if (id === undefined || stream.id === id) closeStream(stream);
  }
  const viewersOf = id => [...streams].filter(stream => stream.id === id);

  // One render per pane per frame, shared by every viewer of it; each viewer
  // diffs against its own hash table, because two phones may have attached at
  // different moments.
  // The decoder parses on its own microtask queue, so a frame taken the instant
  // a PTY chunk arrives would render the screen as it was before that chunk.
  // Wait for the pane to settle first, then read the buffer once.
  async function emitFrame(id) {
    if (!viewersOf(id).length) return;
    const settling = inspectPane(id);
    if (!settling) return;
    try { await settling.settled(); } catch { /* a pane disposed mid-write */ }
    const viewers = viewersOf(id);
    if (!viewers.length) return;
    const pane = inspectPane(id);
    if (!pane || pane.generation !== settling.generation) return;
    let rendered;
    try { rendered = renderScreen(pane.terminal, { cursorVisible: pane.cursorVisible }); }
    catch (error) { report(`frame render failed for ${id}`, error); return; }
    const entry = meter(id);
    let published = false;
    for (const stream of viewers) {
      if (stream.cols !== rendered.cols || stream.rows !== rendered.rows) stream.full = true;
      const changed = stream.full ? rendered.lines.map((line, index) => [index, line]) : diffRows(stream.hashes, rendered);
      const moved = !sameCursor(stream.cursor, rendered.cursor);
      if (!stream.full && !changed.length && !moved) continue;
      if (!published) { entry.seq += 1; entry.frames += 1; published = true; }
      writeEvent(stream, stream.full ? 'screen' : 'frame', { seq: entry.seq, rows: changed, cursor: rendered.cursor });
      stream.hashes = rendered.hashes.slice();
      stream.cursor = rendered.cursor;
      stream.cols = rendered.cols;
      stream.rows = rendered.rows;
      stream.full = false;
    }
  }
  function scheduleFrame(id) {
    if (!viewersOf(id).length) return;
    pump.request(id, () => { void emitFrame(id); });
  }
  // A pane event, seen through main's tap. Geometry and exit go out at once;
  // output only moves the frame clock.
  function publishStream(event) {
    if (!event || typeof event.id !== 'string' || !event.id) return;
    if (event.type === 'data' && typeof event.data === 'string') {
      const entry = meter(event.id);
      entry.rawBytes += Buffer.byteLength(event.data, 'utf8');
      entry.rawChunks += 1;
    }
    if (event.type === 'created') {
      meters.delete(event.id);
      for (const stream of viewersOf(event.id)) { stream.full = true; stream.hashes = null; }
    }
    const viewers = viewersOf(event.id);
    if (!viewers.length) return;
    if (event.type === 'resize' || event.type === 'created') {
      const cols = Number.isSafeInteger(event.cols) && event.cols > 0 ? event.cols : null;
      const rows = Number.isSafeInteger(event.rows) && event.rows > 0 ? event.rows : null;
      if (cols && rows) for (const stream of viewers) { stream.full = true; writeEvent(stream, 'resize', { cols, rows }); }
    }
    // The last frame first: what the process printed before it went is the
    // screen a phone should be left looking at.
    if (event.type === 'exit') {
      void emitFrame(event.id).then(() => { for (const stream of viewersOf(event.id)) writeEvent(stream, 'exit', {}); });
      return;
    }
    scheduleFrame(event.id);
  }

  // ----------------------------------------------------------- transcript ---

  function historyService() {
    if (history) return history;
    const { createOrchestratorHistoryProcess } = require('./orchestratorHistoryProcess.cjs');
    history = createOrchestratorHistoryProcess({ getConfig: () => {
      const directory = getDirectory();
      const current = directory ? directory.list() || [] : [];
      const roots = [...new Set([...(directory?.projectPaths?.() || []), ...current.map(session => session.cwd)].filter(Boolean))];
      const scopes = current.filter(session => session.kind !== 'terminal').map(session => ({ provider: session.kind, cwd: session.cwd,
        claudeHome: session.providerProfileId ? 'custom' : 'global', providerProfileId: session.providerProfileId,
        ownedThreadIds: [session.threadRef?.id, session.resumeRef?.id].filter(Boolean),
        plannerProvider: session.fusionPlannerFamily || 'claude', fusion: session.kind === 'fusion', openFusion: session.kind === 'openfusion' }));
      for (const cwd of roots) for (const provider of HISTORY_PROVIDERS) scopes.push({ provider, cwd });
      return { ...getHistoryConfig(), scopes };
    } });
    ownsHistory = true;
    return history;
  }
  async function transcriptFor(record) {
    if (CHAT_KINDS.has(record.kind)) {
      const directory = getDirectory();
      try {
        const chat = directory.readChat({ id: record.id, generation: record.generation, maxChars: TRANSCRIPT_CHARS });
        const text = typeof chat?.text === 'string' ? chat.text : '';
        return { status: 'found', messages: text ? [{ role: 'assistant', text }] : [] };
      } catch (error) { report(`chat transcript unavailable for ${record.id}`, error); return { status: 'unavailable', messages: [] }; }
    }
    // A plain shell keeps no conversation; its screen text is the only record.
    if (!HISTORY_PROVIDERS.has(record.kind)) return { status: 'unsupported', messages: [] };
    const threadId = record.threadRef?.id || record.resumeRef?.id || record.conversation?.id;
    if (!threadId || !record.cwd) return { status: 'unavailable', messages: [] };
    try {
      const service = historyService();
      const listed = await service.list({ provider: record.kind, cwd: record.cwd, limit: DEFAULT_HISTORY_LIMIT });
      const match = (listed?.conversations || []).find(conversation => conversation.id === threadId);
      if (!match) return { status: 'unavailable', messages: [] };
      const result = await service.read({ reference: match.reference, maxChars: TRANSCRIPT_CHARS });
      if (!result?.ok) return { status: result?.status === 'unsupported' ? 'unsupported' : 'unavailable', messages: [] };
      const messages = (result.messages || [])
        .filter(message => message && typeof message.role === 'string' && typeof message.text === 'string')
        .map(message => ({ role: message.role, text: message.text }));
      return { status: 'found', messages };
    } catch (error) { report(`transcript unavailable for ${record.id}`, error); return { status: 'unavailable', messages: [] }; }
  }

  // --------------------------------------------------------------- routes ---

  // Every JSON answer over half a kilobyte is gzipped when the client says it
  // can read it. State, transcripts and history are the ones that matter: they
  // are mostly repeated keys and terminal text, which deflates hard.
  function send(response, status, body) {
    let payload = Buffer.from(JSON.stringify(body), 'utf8');
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      Vary: 'Accept-Encoding',
      'X-Lina-Bridge': String(PROTOCOL),
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, OPTIONS'
    };
    if (response.linaGzip && payload.length > GZIP_MIN_BYTES) {
      try {
        payload = zlib.gzipSync(payload);
        headers['Content-Encoding'] = 'gzip';
      } catch (error) { report('response compression failed', error); }
    }
    headers['Content-Length'] = payload.length;
    response.writeHead(status, headers);
    response.end(payload);
  }
  const fail = (response, status, error) => send(response, status, { ok: false, error });
  const acceptsGzip = request => /(^|,)\s*(gzip|\*)\s*(;|,|$)/i.test(String(request.headers?.['accept-encoding'] || ''));

  function clientAddress(request) {
    return String(request.socket?.remoteAddress || 'unknown');
  }
  function rateLimited(address) {
    const entry = authFailures.get(address);
    if (!entry) return false;
    if (now() - entry.at > AUTH_WINDOW_MS) { authFailures.delete(address); return false; }
    return entry.count >= AUTH_FAILURE_LIMIT;
  }
  function recordAuthFailure(address) {
    const entry = authFailures.get(address);
    if (!entry || now() - entry.at > AUTH_WINDOW_MS) authFailures.set(address, { count: 1, at: now() });
    else entry.count++;
    if (authFailures.size > 1000) authFailures.delete(authFailures.keys().next().value);
  }
  // Fixed-window budget for the routes that answer before any credential exists.
  function publicBudgetExceeded(address) {
    const entry = publicHits.get(address);
    if (!entry || now() - entry.at > PUBLIC_WINDOW_MS) { publicHits.set(address, { count: 1, at: now() }); }
    else entry.count++;
    if (publicHits.size > 1000) publicHits.delete(publicHits.keys().next().value);
    return publicHits.get(address).count > PUBLIC_REQUEST_LIMIT;
  }
  function readBody(request) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      request.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_PAIR_BODY_BYTES) { request.destroy(); reject(new Error('body too large')); return; }
        chunks.push(chunk);
      });
      request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      request.on('error', reject);
    });
  }
  // `query` is supplied only for the three routes a browser cannot send a header
  // on (EventSource, <script>, <link>, and the page that owns them). It is
  // checked exactly like the header: same canonical form, same constant-time
  // digest compare, same failure accounting.
  function authorized(request, query = null) {
    const header = request.headers?.authorization || '';
    const match = /^Bearer\s+(.+)$/i.exec(String(header).trim());
    const supplied = canonicalCode(match ? match[1] : query || '');
    const expected = canonicalCode(settings.get().code);
    return Boolean(supplied) && Boolean(expected) && sameSecret(supplied, expected);
  }

  function findRecord(state, id) {
    return (state.sessions || []).find(session => session.id === id) || null;
  }
  function rawRecord(id) {
    const directory = getDirectory();
    try { return (directory?.list() || []).find(record => record && record.id === id) || null; } catch { return null; }
  }

  async function routeState(url, response) {
    const requested = boundedNumber(url.searchParams.get('revision'), null, 0, Number.MAX_SAFE_INTEGER);
    const wait = boundedNumber(url.searchParams.get('wait'), 0, 0, MAX_WAIT_MS);
    let state = await refreshState();
    if (wait > 0 && Number.isFinite(requested) && requested === state.revision) {
      await new Promise(resolve => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          waiters.delete(waiter);
          clearTimeout(timer);
          response.off('close', finish);
          syncOrchestratorTimer();
          resolve();
        };
        const waiter = finish;
        const timer = setTimeout(finish, wait);
        timer.unref?.();
        waiters.add(waiter);
        response.on('close', finish);
        syncOrchestratorTimer();
      });
      if (response.writableEnded || response.destroyed) return;
      state = await refreshState();
    }
    send(response, 200, { ok: true, ...state });
  }

  async function routeScreen(id, url, response) {
    const record = rawRecord(id);
    if (!record) return fail(response, 404, 'not found');
    const maxChars = boundedNumber(url.searchParams.get('maxChars'), DEFAULT_SCREEN_CHARS, 1, MAX_SCREEN_CHARS);
    const view = await screenFor(record, maxChars);
    send(response, 200, { ok: true, text: view?.text || '', exited: Boolean(view?.exited),
      updatedAt: Number.isFinite(view?.outputAt) ? view.outputAt : Number.isFinite(view?.metadataAt) ? view.metadataAt : null });
  }

  // The PTY's own geometry, read off the live decoder when there is one.
  function geometry(record, pane) {
    return { cols: pane?.cols || (Number.isSafeInteger(record?.cols) && record.cols > 0 ? record.cols : 80),
      rows: pane?.rows || (Number.isSafeInteger(record?.rows) && record.rows > 0 ? record.rows : 24) };
  }

  function routeStream(id, url, request, response) {
    const record = rawRecord(id);
    if (!record) return fail(response, 404, 'not found');
    if (streams.size >= MAX_STREAMS) return fail(response, 503, 'too many streams');
    const gzipped = acceptsGzip(request);
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      Vary: 'Accept-Encoding',
      ...(gzipped ? { 'Content-Encoding': 'gzip' } : {}),
      'X-Lina-Bridge': String(PROTOCOL),
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, OPTIONS'
    });
    const stream = { id, response, gzip: null, keepalive: null, hashes: null, cursor: null,
      cols: 0, rows: 0, full: true, sentBytes: 0 };
    if (gzipped) {
      const gzip = zlib.createGzip();
      // Count what actually leaves the machine, not what was serialized.
      gzip.on('data', chunk => { stream.sentBytes += chunk.length; meter(id).sentBytes += chunk.length; });
      gzip.on('error', error => { report('stream compression failed', error); closeStream(stream); });
      gzip.pipe(response);
      stream.gzip = gzip;
    }
    streams.add(stream);
    const pane = inspectPane(id);
    const size = geometry(record, pane);
    const entry = meter(id);
    writeEvent(stream, 'hello', { protocol: STREAM_PROTOCOL, cols: size.cols, rows: size.rows,
      seq: entry.seq, exited: Boolean(pane?.exited), control: false });
    let lines = [];
    try { if (pane) lines = renderScrollback(pane.terminal, SCROLLBACK_LINES); }
    catch (error) { report(`scrollback render failed for ${id}`, error); }
    writeEvent(stream, 'scrollback', { lines });
    // The viewport itself, in full, so the phone starts from a known screen.
    void emitFrame(id).then(() => { if (pane?.exited) writeEvent(stream, 'exit', {}); });
    stream.keepalive = setInterval(() => {
      if (stream.response.writableEnded || stream.response.destroyed) return closeStream(stream);
      writeEvent(stream, ': keepalive');
    }, Math.max(50, Number(keepaliveMs) || KEEPALIVE_MS));
    stream.keepalive.unref?.();
    response.on('close', () => closeStream(stream));
  }

  // A content-hashed vendor URL is immutable by construction, so it is cached
  // for a year and never revalidated. The unhashed path a older page may still
  // ask for is redirected to the current hash rather than served stale.
  function routeVendor(name, hash, request, response) {
    const asset = vendorAsset(name);
    if (!asset) return fail(response, 404, 'not found');
    if (hash !== asset.hash) {
      response.writeHead(302, { Location: asset.url, 'Cache-Control': 'no-store',
        'X-Lina-Bridge': String(PROTOCOL), 'Access-Control-Allow-Origin': '*' });
      return response.end();
    }
    const etag = `"${asset.hash}"`;
    if (String(request.headers?.['if-none-match'] || '').includes(asset.hash)) {
      response.writeHead(304, { ETag: etag, 'Cache-Control': 'public, max-age=31536000, immutable',
        Vary: 'Accept-Encoding', 'X-Lina-Bridge': String(PROTOCOL), 'Access-Control-Allow-Origin': '*' });
      return response.end();
    }
    const compressed = asset.gzip && acceptsGzip(request);
    const body = compressed ? asset.gzip : asset.body;
    response.writeHead(200, {
      'Content-Type': asset.type,
      'Content-Length': body.length,
      'Cache-Control': 'public, max-age=31536000, immutable',
      ETag: etag,
      Vary: 'Accept-Encoding',
      ...(compressed ? { 'Content-Encoding': 'gzip' } : {}),
      'X-Lina-Bridge': String(PROTOCOL),
      'Access-Control-Allow-Origin': '*'
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  }

  function routeTerminalPage(id, request, response) {
    const record = rawRecord(id);
    if (!record) return fail(response, 404, 'not found');
    const pane = inspectPane(id);
    const size = geometry(record, pane);
    // The caller has already proved it holds the code; the page carries it so
    // its own /vendor and stream requests can be authorized without a header.
    const html = terminalPage({ id, code: canonicalCode(settings.get().code), kind: record.kind || 'terminal',
      title: sessionTitle(record), cols: size.cols, rows: size.rows, exited: Boolean(pane?.exited),
      vendor: vendorManifest() });
    let body = Buffer.from(html, 'utf8');
    const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      Vary: 'Accept-Encoding', 'X-Lina-Bridge': String(PROTOCOL), 'Access-Control-Allow-Origin': '*' };
    if (acceptsGzip(request) && body.length > GZIP_MIN_BYTES) {
      try { body = zlib.gzipSync(body); headers['Content-Encoding'] = 'gzip'; }
      catch (error) { report('page compression failed', error); }
    }
    headers['Content-Length'] = body.length;
    response.writeHead(200, headers);
    response.end(body);
  }

  // Observation only: what the bridge took in and what it sent out for one
  // pane. It exists so the redraw-storm fixture can prove the frame protocol
  // costs less than the bytes it replaced, and it writes nothing.
  function routeMetrics(id, response) {
    const record = rawRecord(id);
    if (!record) return fail(response, 404, 'not found');
    const pane = inspectPane(id);
    const entry = meters.get(id) || { rawBytes: 0, rawChunks: 0, frames: 0, sentBytes: 0, seq: 0 };
    const size = geometry(record, pane);
    send(response, 200, { ok: true, rawBytes: entry.rawBytes, rawChunks: entry.rawChunks,
      frames: entry.frames, sentBytes: entry.sentBytes, seq: entry.seq,
      streams: viewersOf(id).length, cols: size.cols, rows: size.rows, exited: Boolean(pane?.exited) });
  }

  // Newest-last pagination: `before` is an index into the whole conversation,
  // so a phone can walk backwards without the server holding a cursor.
  async function routeTranscript(id, url, response) {
    const record = rawRecord(id);
    if (!record) return fail(response, 404, 'not found');
    const result = await transcriptFor(record);
    const all = Array.isArray(result.messages) ? result.messages : [];
    const total = all.length;
    const limit = boundedNumber(url.searchParams.get('limit'), DEFAULT_TRANSCRIPT_LIMIT, 1, MAX_TRANSCRIPT_LIMIT);
    const before = boundedNumber(url.searchParams.get('before'), total, 0, total);
    const start = Math.max(0, before - limit);
    send(response, 200, { ok: true, status: result.status, messages: all.slice(start, before),
      total, nextBefore: start > 0 ? start : null });
  }

  function routeOrchestratorHistory(url, response) {
    const limit = boundedNumber(url.searchParams.get('limit'), DEFAULT_ORCHESTRATOR_LIMIT, 1, MAX_HISTORY_LIMIT);
    const state = orchestratorState() || {};
    const messages = (Array.isArray(state.messages) ? state.messages : []).slice(-limit).map(message => ({
      id: message.id ?? null, role: message.role ?? null, text: typeof message.text === 'string' ? message.text : '',
      at: Number.isFinite(message.at) ? message.at : null, requestId: message.requestId ?? null,
      taskId: message.taskId ?? null, status: message.status ?? null, targetId: message.targetId ?? null
    }));
    const tasks = (Array.isArray(state.tasks) ? state.tasks : []).slice(-MAX_ORCHESTRATOR_TASKS).map(task => ({
      id: task.id ?? null, requestId: task.requestId ?? null, text: typeof task.text === 'string' ? task.text : '',
      status: task.status ?? null, terminalId: task.terminalId ?? null, projectId: task.projectId ?? null,
      cwd: task.cwd ?? null, createdAt: Number.isFinite(task.createdAt) ? task.createdAt : null,
      updatedAt: Number.isFinite(task.updatedAt) ? task.updatedAt : null,
      result: task.result ?? null, error: task.error ?? null, summary: task.summary ?? null
    }));
    send(response, 200, { ok: true, enabled: state.enabled === true, ready: state.ready === true, messages, tasks });
  }

  async function route(request, response) {
    const url = new URL(request.url || '/', 'http://bridge.invalid');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    // Stashed once so every `send` below can answer compressed without each
    // route having to carry the request through.
    response.linaGzip = acceptsGzip(request);
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'X-Lina-Bridge': String(PROTOCOL),
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Max-Age': '600'
      });
      return response.end();
    }

    // The xterm library files the terminal page loads. They are the desktop's
    // own vendored dependency, byte for byte the same in every install, and say
    // nothing about this workspace — so they answer without a credential. A
    // <script> or <link> cannot send a header, and charging a stale code four
    // failed authorizations per page load would lock a phone out of its own
    // bridge. For the same reason they are outside both limiters: they are a
    // memory-cached static read, and metering them would recreate the lockout
    // against discovery instead.
    // They are served under a content hash — `/vendor/<hash>/xterm.js` — so a
    // phone caches them for a year and never asks again until the build
    // changes. The old unhashed path redirects to the current hash.
    const hashedVendor = /^\/vendor\/([0-9a-f]{8,64})\/([^/]+)$/.exec(path);
    const vendorRoute = hashedVendor || /^\/vendor\/([^/]+)$/.exec(path);
    if (vendorRoute) {
      if (request.method !== 'GET' && request.method !== 'HEAD') return fail(response, 404, 'not found');
      return hashedVendor
        ? routeVendor(hashedVendor[2], hashedVendor[1], request, response)
        : routeVendor(vendorRoute[1], null, request, response);
    }

    const address = clientAddress(request);

    // Discovery and pairing come before the credential gate: they are how a
    // phone gets one. They expose no workspace data of any kind.
    const pairRead = /^\/api\/pair\/([^/]+)$/.exec(path);
    if (path === '/api/discover' || path === '/api/pair' || pairRead) {
      if (publicBudgetExceeded(address)) return fail(response, 429, 'too many requests');
      const current = settings.get();
      if (path === '/api/discover') {
        if (request.method !== 'GET' && request.method !== 'HEAD') return fail(response, 404, 'not found');
        return send(response, 200, { ok: true, app: 'lina-terminal', host: hostname(), version,
          bridge: PROTOCOL, readOnly: true, desktopId: current.desktopId });
      }
      if (path === '/api/pair') {
        if (request.method !== 'POST') return fail(response, 404, 'not found');
        let body;
        try { body = JSON.parse(await readBody(request) || '{}'); }
        catch { return fail(response, 400, 'invalid request body'); }
        const created = createPair({ deviceName: body?.deviceName, platform: body?.platform, remoteAddress: address });
        if (!created.ok) return fail(response, created.status, created.error);
        return send(response, 200, { ok: true, requestId: created.requestId, expiresAt: created.expiresAt });
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') return fail(response, 404, 'not found');
      const wait = boundedNumber(url.searchParams.get('wait'), 0, 0, MAX_WAIT_MS);
      const result = await readPair(decodeURIComponent(pairRead[1]), wait, response);
      if (response.writableEnded || response.destroyed) return;
      if (!result.ok) return fail(response, result.status || 404, result.error || 'not found');
      return send(response, 200, { ok: true, status: result.status, ...(result.code ? { code: result.code } : {}) });
    }

    // The two viewing surfaces a browser cannot put a header on: the stream an
    // EventSource opens, and the page itself.
    const streamRoute = /^\/api\/sessions\/([^/]+)\/stream$/.exec(path);
    const pageRoute = /^\/terminal\/([^/]+)$/.exec(path);
    const viewing = Boolean(streamRoute || pageRoute);

    if (rateLimited(address)) return fail(response, 429, 'too many attempts');
    if (!authorized(request, viewing ? url.searchParams.get('code') : null)) { recordAuthFailure(address); return fail(response, 401, 'unauthorized'); }
    // Reserved write routes (input, interrupt, request) are not implemented in
    // this build; every non-GET verb falls through to the same 404 as an
    // unknown path so nothing here can be mistaken for a control surface.
    if (request.method !== 'GET' && request.method !== 'HEAD') return fail(response, 404, 'not found');

    if (path === '/api/hello') {
      return send(response, 200, { ok: true, app: 'lina-terminal', version, host: hostname(), bridge: PROTOCOL, readOnly: true });
    }
    if (path === '/api/state') return routeState(url, response);
    if (path === '/api/orchestrator/history') return routeOrchestratorHistory(url, response);
    if (streamRoute) return routeStream(decodeURIComponent(streamRoute[1]), url, request, response);
    if (pageRoute) return routeTerminalPage(decodeURIComponent(pageRoute[1]), request, response);
    const session = /^\/api\/sessions\/([^/]+)\/(screen|transcript|metrics)$/.exec(path);
    if (session) {
      const id = decodeURIComponent(session[1]);
      if (session[2] === 'screen') return routeScreen(id, url, response);
      if (session[2] === 'metrics') return routeMetrics(id, response);
      return routeTranscript(id, url, response);
    }
    return fail(response, 404, 'not found');
  }

  function handle(request, response) {
    // Only the pair offer has a body worth reading. Everything else is drained
    // so the socket can close; draining before readBody would eat that one body.
    const pairing = request.method === 'POST' && String(request.url || '').split('?')[0].replace(/\/+$/, '') === '/api/pair';
    if (!pairing) request.resume();
    Promise.resolve()
      .then(() => route(request, response))
      .catch(error => {
        report('request failed', error);
        if (!response.headersSent && !response.writableEnded) fail(response, 500, 'internal error');
        else response.end();
      });
  }

  // ------------------------------------------------------------ lifecycle ---

  function stopServer() {
    listening = false;
    boundHost = ''; boundPort = 0;
    closeStreams();
    try { pump.clear(); } catch {}
    if (notifyTimer) { clearTimeout(notifyTimer); notifyTimer = null; }
    // Offers do not survive the listener that made them.
    for (const id of [...pairs.keys()]) wakePair(id);
    pairs.clear(); pairWaiters.clear();
    wake();
    waiters.clear();
    syncOrchestratorTimer();
    const current = server;
    server = null;
    if (!current) return Promise.resolve();
    return new Promise(resolve => { try { current.close(() => resolve()); current.closeAllConnections?.(); } catch { resolve(); } });
  }

  async function start() {
    if (closed) return getStatus();
    const current = settings.get();
    enabled = current.enabled === true;
    // Switched off keeps nothing: the decoders and their accounting go with the listener.
    if (!enabled) { await stopServer(); meters.clear(); listenError = ''; publishStatus(); return getStatus(); }
    if (listening && boundPort === current.port && boundHost === current.host) return getStatus();
    await stopServer();
    listenError = '';
    const instance = createServer(handle);
    server = instance;
    await new Promise(resolve => {
      const onError = error => {
        listenError = error && error.code === 'EADDRINUSE'
          ? `Port ${current.port} is already in use.`
          : `Could not listen on ${current.host}:${current.port}. ${error && error.message ? error.message : error}`;
        report('listen failed', error);
        instance.removeListener('listening', onListening);
        if (server === instance) { server = null; listening = false; }
        resolve();
      };
      const onListening = () => {
        instance.removeListener('error', onError);
        // A late socket error must never crash the app.
        instance.on('error', error => report('server error', error));
        listening = true;
        const address = instance.address();
        boundHost = current.host;
        boundPort = typeof address === 'object' && address ? address.port : current.port;
        report(`listening on ${boundHost}:${boundPort} (read-only)`);
        resolve();
      };
      instance.once('error', onError);
      instance.once('listening', onListening);
      try { instance.listen(current.port, current.host); } catch (error) { onError(error); }
    });
    if (listening) {
      // Persist the desktop identity only now, so a switched-off app writes nothing.
      await settings.ensureStored().catch(error => report('identity persist failed', error));
      if (settings.get().autoApprove === true) report('!! LINA_MOBILE_BRIDGE_AUTO_APPROVE is set: pair requests are approved automatically. FIXTURE USE ONLY.');
    }
    publishStatus();
    if (listening) void refreshState();
    return getStatus();
  }

  async function setEnabled(value) {
    await settings.setEnabled(value === true);
    return start();
  }
  async function regenerateCode() {
    await settings.regenerateCode();
    // Authorization reads the stored code per request, so the old pairing is
    // already dead. Release held polls so a stale phone learns it at once,
    // without a relisten that could lose the port to TIME_WAIT.
    wake();
    publishStatus();
    return getStatus();
  }

  async function close() {
    if (closed) return;
    closed = true;
    enabled = false;
    await stopServer();
    meters.clear();
    if (ownsObservation) { try { observation.dispose(); } catch {} }
    if (ownsHistory && history) { try { history.dispose(); } catch {} }
  }

  return { start, stop: stopServer, close, ingest, forget, notify, getStatus, setEnabled, regenerateCode,
    respondPair, pendingPairs,
    // Exposed for tests: the assembled state a phone would receive, the
    // per-pane byte accounting behind the frame stream, and the hashed vendor
    // URLs the terminal page is built against.
    state: refreshState,
    streamStats: id => ({ ...(meters.get(id) || { rawBytes: 0, rawChunks: 0, frames: 0, sentBytes: 0, seq: 0 }),
      streams: [...streams].filter(stream => stream.id === id).length }),
    vendorUrls: vendorManifest };
}

module.exports = { createMobileBridge, lanAddresses, HISTORY_PROVIDERS, PROTOCOL, STREAM_PROTOCOL,
  PAIR_TTL_MS, MAX_PENDING_PAIRS, PUBLIC_REQUEST_LIMIT, MAX_STREAMS, VENDOR_ASSETS, SCROLLBACK_LINES };
