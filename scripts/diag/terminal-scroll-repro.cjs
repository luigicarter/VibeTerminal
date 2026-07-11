/*
 * TEMPORARY DIAGNOSTIC ONLY — no product behavior is changed by this file.
 *
 * Reproduces xterm viewport position after pane remounts using Electron's CDP
 * endpoint. Results and screenshots are written under
 * artifacts/terminal-scroll-repro/.
 */
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");

const root = path.join(__dirname, "..", "..");
const outputDir = path.join(root, "artifacts", "terminal-scroll-repro");
const runId = `${Date.now()}-${process.pid}`;
const userDataDir = path.join(root, ".tmp", `terminal-scroll-repro-${runId}`);
const ptyLog = path.join(outputDir, `pty-${runId}.jsonl`);
const resultPath = path.join(outputDir, `results-${runId}.json`);
const badScreenshotPath = path.join(outputDir, `bad-state-${runId}.png`);
const goodScreenshotPath = path.join(outputDir, `post-fix-bottom-${runId}.png`);
const isWindows = process.platform === "win32";
const npm = isWindows ? "npm.cmd" : "npm";
const electron = path.join(
  root,
  "node_modules",
  ".bin",
  isWindows ? "electron.cmd" : "electron"
);

const LONG_ID = "diag-long";
const PEER_ID = "diag-peer";
const WORKSPACE_A = "diag-workspace-a";
const WORKSPACE_B = "diag-workspace-b";
const NORMAL_CYCLES = Number(process.env.DIAG_NORMAL_CYCLES || 25);
const MAXIMIZE_CYCLES = Number(process.env.DIAG_MAXIMIZE_CYCLES || NORMAL_CYCLES);
const WORKSPACE_CYCLES = Number(process.env.DIAG_WORKSPACE_CYCLES || NORMAL_CYCLES);
const FOCUS_SWITCHES = Number(process.env.DIAG_FOCUS_SWITCHES || 40);
const CONTROL_CYCLES = Number(process.env.DIAG_CONTROL_CYCLES || 22);
const CAPTURE_ATTEMPTS = Number(process.env.DIAG_CAPTURE_ATTEMPTS || 40);
const CPU_THROTTLE_RATE = Number(process.env.DIAG_CPU_THROTTLE_RATE || 1);
const LIVE_REPAINT = process.env.DIAG_LIVE_REPAINT === "1";
const FINAL_SETTLE_MS = Number(process.env.DIAG_FINAL_SETTLE_MS || 0);
const CAPTURE_GOOD = process.env.DIAG_CAPTURE_GOOD === "1";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let body = "";
      response.on("data", (chunk) => (body += chunk));
      response.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.once("error", reject);
  });
}

async function waitForHttp(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await getJson(url);
      return;
    } catch {
      await sleep(200);
    }
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function waitForRenderer(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await new Promise((resolve, reject) => {
        const request = http.get(url, (response) => {
          response.resume();
          resolve();
        });
        request.once("error", reject);
      });
      return;
    } catch {
      await sleep(200);
    }
  }
  throw new Error(`Timed out waiting for renderer ${url}`);
}

function killTree(child) {
  if (!child || child.killed || !child.pid) return;
  if (isWindows) {
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore"
    });
  } else {
    child.kill("SIGKILL");
  }
}

class Cdp {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (message) => {
      const packet = JSON.parse(String(message.data));
      if (packet.id) {
        const pending = this.pending.get(packet.id);
        if (!pending) return;
        this.pending.delete(packet.id);
        if (packet.error) pending.reject(new Error(packet.error.message));
        else pending.resolve(packet.result);
        return;
      }
      this.events.push(packet);
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
  }

  takeEvent(method) {
    const index = this.events.findIndex((event) => event.method === method);
    if (index === -1) return null;
    return this.events.splice(index, 1)[0];
  }
}

function session(id, name, command, x) {
  return {
    id,
    name,
    kind: "terminal",
    command,
    cwd: root,
    createdAt: Date.now(),
    nextLaunchMode: "new",
    started: true,
    launchToken: 1,
    status: "idle",
    attention: { state: "none", source: "process", updatedAt: Date.now() },
    layout: { x, y: 12, w: 48, h: 600, unit: "fluid" }
  };
}

function seedData() {
  const longCommand = [
    "$ErrorActionPreference='Stop'",
    "1..12000 | ForEach-Object {",
    "  $n=$_",
    "  Write-Output ((\"DIAG-{0:D5} \" -f $n) + ('x' * (35 + ($n % 145))))",
    "}",
    "Write-Output 'DIAG-DONE-12000'",
    ...(LIVE_REPAINT
      ? [
          "$i=0",
          "while ($true) {",
          "  $i++",
          "  [Console]::Write((\"`e[H`e[2KDIAG-REPAINT-{0:D6}\" -f $i))",
          "  Start-Sleep -Milliseconds 35",
          "}"
        ]
      : [])
  ].join("; ");
  return {
    workspaces: [
      {
        id: WORKSPACE_A,
        name: "DIAG A",
        path: root,
        sessions: [
          session(LONG_ID, "Long output", longCommand, 0),
          session(PEER_ID, "Focus peer", "Write-Output 'PEER-READY'", 51)
        ]
      },
      { id: WORKSPACE_B, name: "DIAG B", path: root, sessions: [] }
    ]
  };
}

const instrumentationSource = String.raw`(() => {
  const records = [];
  const epoch = performance.timeOrigin;
  const stamp = (type, detail = {}) => records.push({
    type,
    t: performance.now(),
    wall: epoch + performance.now(),
    ...detail
  });
  const metric = (viewport) => ({
    sessionId: viewport.closest('[data-session-id]')?.dataset.sessionId || null,
    scrollTop: viewport.scrollTop,
    scrollHeight: viewport.scrollHeight,
    clientHeight: viewport.clientHeight
  });
  const observed = new WeakSet();
  const pauseIfBad = (m) => {
    if (window.__terminalScrollDiag?.pauseOnBad && !window.__terminalScrollDiag.pausedBad &&
        m.sessionId === '${LONG_ID}' && m.scrollTop <= 2 && m.scrollHeight - m.clientHeight > 500) {
      const diag = window.__terminalScrollDiag;
      diag.pausedBad = true;
      diag.badCapture = { ...m, t: performance.now() };
      const viewport = document.querySelector('[data-session-id="${LONG_ID}"] .xterm-viewport');
      const frame = viewport?.closest('[data-session-id]');
      if (viewport && frame) {
        const rect = frame.getBoundingClientRect();
        frame.style.setProperty('transition', 'none', 'important');
        frame.style.setProperty('width', rect.width + 'px', 'important');
        frame.style.setProperty('height', rect.height + 'px', 'important');
        diag.holdBadTimer = setInterval(() => { viewport.scrollTop = 0; }, 1);
      }
    }
  };
  const observeTree = () => {
    document.querySelectorAll('.xterm-viewport').forEach((viewport) => {
      if (observed.has(viewport)) return;
      observed.add(viewport);
      stamp('viewport-added', metric(viewport));
      const paneId = metric(viewport).sessionId;
      const host = viewport.closest('.terminal-fit-host');
      const screen = host?.querySelector('.xterm-screen');
      if (host) {
        new ResizeObserver(() => {
          const m = metric(viewport);
          stamp('host-resize', {
            sessionId: paneId,
            width: host.getBoundingClientRect().width,
            height: host.getBoundingClientRect().height,
            ...m
          });
          pauseIfBad(m);
        }).observe(host);
      }
      if (screen) {
        new ResizeObserver(() => stamp('screen-resize', {
          sessionId: paneId,
          width: screen.getBoundingClientRect().width,
          height: screen.getBoundingClientRect().height,
          ...metric(viewport)
        })).observe(screen);
      }
      new MutationObserver(() => stamp('rows-mutation', metric(viewport)))
        .observe(host || viewport, { childList: true, subtree: true, characterData: true });
    });
  };
  new MutationObserver(() => observeTree()).observe(document, { childList: true, subtree: true });
  const poll = setInterval(() => {
    observeTree();
    document.querySelectorAll('.xterm-viewport').forEach((viewport) => {
      const m = metric(viewport);
      if (m.sessionId === '${LONG_ID}') {
        stamp('poll', m);
        pauseIfBad(m);
      }
    });
  }, 10);
  const attachTerminalEvents = () => {
    if (!window.vibe?.terminal?.onEvent) return false;
    if (window.__terminalScrollDiagAttached) return true;
    window.__terminalScrollDiagAttached = true;
    window.vibe.terminal.onEvent((event) => {
      if (event?.id === '${LONG_ID}' || event?.id === '${PEER_ID}') {
        stamp('terminal-event', {
          sessionId: event.id,
          eventType: event.type,
          dataLength: typeof event.data === 'string' ? event.data.length : 0,
          isRunning: event.isRunning
        });
      }
    });
    return true;
  };
  const attachPoll = setInterval(() => {
    if (attachTerminalEvents()) clearInterval(attachPoll);
  }, 0);
  window.__terminalScrollDiag = {
    records,
    stamp,
    pauseOnBad: false,
    pausedBad: false,
    badCapture: null,
    holdBadTimer: null,
    releaseBad() {
      clearInterval(this.holdBadTimer);
      this.holdBadTimer = null;
      this.pauseOnBad = false;
    },
    clear() { records.length = 0; },
    stop() { clearInterval(poll); clearInterval(attachPoll); },
    metrics() {
      const viewport = document.querySelector('[data-session-id="${LONG_ID}"] .xterm-viewport');
      if (!viewport) return null;
      return metric(viewport);
    }
  };
})();`;

async function evaluate(cdp, expression, returnByValue = true) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue,
    userGesture: true
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || "CDP evaluation failed");
  }
  return result.result.value;
}

async function waitFor(cdp, predicateSource, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(cdp, `Boolean(${predicateSource})`)) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function metric(cdp) {
  return evaluate(cdp, "window.__terminalScrollDiag?.metrics() || null");
}

function isTop(value) {
  return Boolean(
    value &&
      value.scrollTop <= 2 &&
      value.scrollHeight - value.clientHeight >= Math.max(500, value.clientHeight * 3)
  );
}

async function sampleSettling(cdp, durationMs = 1400) {
  const samples = [];
  const started = Date.now();
  while (Date.now() - started < durationMs) {
    const value = await metric(cdp);
    samples.push({ elapsed: Date.now() - started, ...value });
    await sleep(50);
  }
  return samples;
}

async function clickElement(cdp, selector, text) {
  const point = await evaluate(
    cdp,
    `(() => {
      const candidates = [...document.querySelectorAll(${JSON.stringify(selector)})];
      const el = candidates.find((item) => ${JSON.stringify(text || "")} === "" || item.textContent.includes(${JSON.stringify(text || "")}));
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {x:r.left+r.width/2,y:r.top+r.height/2};
    })()`
  );
  if (!point) throw new Error(`Element not found: ${selector} ${text || ""}`);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1
  });
}

async function clickTitle(cdp, sessionId, title) {
  await clickElement(
    cdp,
    `[data-session-id="${sessionId}"] button[title="${title}"]`,
    ""
  );
}

async function switchWorkspace(cdp, name) {
  await clickElement(cdp, ".workspace-button", name);
}

async function capture(cdp, filePath) {
  const screenshot = await cdp.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
    fromSurface: true
  });
  fs.writeFileSync(filePath, Buffer.from(screenshot.data, "base64"));
}

async function remountCycle(cdp, trigger, index, screenshotState) {
  await evaluate(cdp, "window.__terminalScrollDiag.clear()");
  const before = await metric(cdp);
  if (trigger === "maximize") {
    await clickTitle(cdp, PEER_ID, "Maximize pane");
    await waitFor(cdp, `!document.querySelector('[data-session-id="${LONG_ID}"]')`, "long pane unmount");
    await clickTitle(cdp, PEER_ID, "Restore pane");
  } else {
    await switchWorkspace(cdp, "DIAG B");
    await waitFor(cdp, `!document.querySelector('[data-session-id="${LONG_ID}"]')`, "workspace unmount");
    await switchWorkspace(cdp, "DIAG A");
  }
  await waitFor(
    cdp,
    `document.querySelector('[data-session-id="${LONG_ID}"] .xterm-viewport')`,
    "long pane remount"
  );
  const samples = await sampleSettling(cdp);
  const after = samples.at(-1);
  const records = await evaluate(
    cdp,
    "window.__terminalScrollDiag.records.filter(r => r.sessionId === 'diag-long')"
  );
  const bad = isTop(after);
  if (bad && !screenshotState.captured) {
    await capture(cdp, badScreenshotPath);
    screenshotState.captured = true;
    screenshotState.trigger = trigger;
    screenshotState.cycle = index;
    screenshotState.metrics = after;
  }
  return { trigger, index, before, samples, after, bad, records };
}

async function focusSwitch(cdp, index) {
  const before = await metric(cdp);
  await clickElement(cdp, `[data-session-id="${PEER_ID}"] .terminal-fit-host`, "");
  await sleep(40);
  await clickElement(cdp, `[data-session-id="${LONG_ID}"] .terminal-fit-host`, "");
  await sleep(80);
  const after = await metric(cdp);
  return { index, before, after, bad: isTop(after) };
}

async function xtermGeometry(cdp) {
  return evaluate(
    cdp,
    `(() => {
      const pane = document.querySelector('[data-session-id="${LONG_ID}"]');
      const frame = pane;
      const host = pane?.querySelector('.terminal-fit-host');
      const screen = pane?.querySelector('.xterm-screen');
      const measure = pane?.querySelector('.xterm-char-measure-element');
      if (!frame || !host || !screen || !measure) return null;
      const f=frame.getBoundingClientRect(), h=host.getBoundingClientRect();
      const s=screen.getBoundingClientRect(), c=measure.getBoundingClientRect();
      const charWidth=c.width/32;
      const charHeight=c.height;
      return { frameWidth:f.width, frameHeight:f.height, hostWidth:h.width, hostHeight:h.height,
        screenWidth:s.width, screenHeight:s.height, charWidth, charHeight,
        cols:Math.round(s.width/charWidth) };
    })()`
  );
}

async function captureTransientBad(cdp, screenshotState, attempts = CAPTURE_ATTEMPTS) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await switchWorkspace(cdp, "DIAG B");
    await waitFor(cdp, `!document.querySelector('[data-session-id="${LONG_ID}"]')`, "capture unmount");
    await evaluate(cdp, `window.__terminalScrollDiag.pauseOnBad=true; window.__terminalScrollDiag.pausedBad=false`);
    await switchWorkspace(cdp, "DIAG A");
    const deadline = Date.now() + 250;
    let caught = null;
    while (Date.now() < deadline && !caught) {
      caught = await evaluate(cdp, `window.__terminalScrollDiag.pausedBad ? window.__terminalScrollDiag.badCapture : null`);
      if (!caught) await sleep(5);
    }
    if (caught) {
      await capture(cdp, badScreenshotPath);
      screenshotState.captured = true;
      screenshotState.trigger = "workspace-transient";
      screenshotState.cycle = attempt;
      screenshotState.caughtMetrics = caught;
      await sleep(300);
      screenshotState.settledMetrics = await metric(cdp);
      await evaluate(cdp, `window.__terminalScrollDiag.releaseBad()`);
      return true;
    }
    await evaluate(cdp, `window.__terminalScrollDiag.pauseOnBad=false`);
    await sleep(50);
  }
  return false;
}

async function measureDefaultScreen(cdp) {
  await switchWorkspace(cdp, "DIAG B");
  await waitFor(cdp, `!document.querySelector('[data-session-id="${LONG_ID}"]')`, "default calibration unmount");
  await evaluate(cdp, `(() => {
    window.__diagOriginalRaf = window.requestAnimationFrame;
    window.__diagOriginalCancelRaf = window.cancelAnimationFrame;
    window.requestAnimationFrame = () => 9000001;
    window.cancelAnimationFrame = () => {};
  })()`);
  await switchWorkspace(cdp, "DIAG A");
  await waitFor(cdp, `document.querySelector('[data-session-id="${LONG_ID}"] .xterm-screen')`, "default xterm canvas");
  await sleep(80);
  const geometry = await xtermGeometry(cdp);
  await evaluate(cdp, `(() => {
    window.requestAnimationFrame = window.__diagOriginalRaf;
    window.cancelAnimationFrame = window.__diagOriginalCancelRaf;
  })()`);
  await switchWorkspace(cdp, "DIAG B");
  await waitFor(cdp, `!document.querySelector('[data-session-id="${LONG_ID}"]')`, "post-calibration unmount");
  await switchWorkspace(cdp, "DIAG A");
  await waitFor(cdp, `document.querySelector('[data-session-id="${LONG_ID}"] .xterm-screen')`, "post-calibration remount");
  await sleep(400);
  return { width: geometry.screenWidth, height: geometry.screenHeight, cols: 80, rows: 24 };
}

async function forceEightyByTwentyFour(cdp, defaultScreen) {
  let geometry = await xtermGeometry(cdp);
  if (!geometry) throw new Error("Could not read xterm geometry");
  let width = geometry.frameWidth;
  let hostHeight = geometry.hostHeight;
  await evaluate(
    cdp,
    `(() => { const style=document.createElement('style'); style.id='diag-fixed-size'; document.head.append(style); })()`
  );
  for (let attempt = 0; attempt < 12; attempt += 1) {
    width += defaultScreen.width - geometry.screenWidth;
    hostHeight += defaultScreen.height - geometry.screenHeight;
    await evaluate(
      cdp,
      `document.querySelector('#diag-fixed-size').textContent='[data-session-id="${LONG_ID}"]{width:${width}px !important;transition:none !important}[data-session-id="${LONG_ID}"] .terminal-fit-host{height:${hostHeight}px !important;flex:none !important}'`
    );
    await sleep(250);
    geometry = await xtermGeometry(cdp);
    if (
      Math.abs(geometry.screenWidth - defaultScreen.width) <= 1 &&
      Math.abs(geometry.screenHeight - defaultScreen.height) <= 1
    ) return { ...geometry, cols: 80, rows: 24, defaultScreen };
  }
  throw new Error(`Failed to force 80x24, last geometry ${JSON.stringify(geometry)}`);
}

async function main() {
  fs.mkdirSync(outputDir, { recursive: true });
  const rendererPort = await freePort();
  const debugPort = await freePort();
  const rendererUrl = `http://127.0.0.1:${rendererPort}`;
  const renderer = spawn(
    npm,
    ["run", "dev:frontend", "--", "--port", String(rendererPort), "--strictPort"],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"], shell: isWindows }
  );
  renderer.stdout.on("data", (data) => process.stdout.write(data));
  renderer.stderr.on("data", (data) => process.stderr.write(data));
  let app;
  let cdp;
  const results = {
    runId,
    config: {
      NORMAL_CYCLES,
      MAXIMIZE_CYCLES,
      WORKSPACE_CYCLES,
      FOCUS_SWITCHES,
      CONTROL_CYCLES,
      CAPTURE_ATTEMPTS,
      CPU_THROTTLE_RATE,
      LIVE_REPAINT,
      FINAL_SETTLE_MS,
      CAPTURE_GOOD
    },
    artifacts: { resultPath, ptyLog, badScreenshotPath, goodScreenshotPath },
    maximize: [],
    workspace: [],
    focus: [],
    control: [],
    controlGeometry: null,
    controlDefaultScreen: null,
    screenshot: { captured: false }
  };
  try {
    await waitForRenderer(rendererUrl);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    Object.assign(env, {
      VITE_DEV_SERVER_URL: rendererUrl,
      VIBE_SCREENSHOT_MODE: "1",
      VIBE_INTERNAL_SCREENSHOT: "0",
      VIBE_SCREENSHOT_USER_DATA: userDataDir,
      VIBE_SCREENSHOT_PTY_DEBUG: ptyLog
    });
    app = spawn(electron, [".", `--remote-debugging-port=${debugPort}`], {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: isWindows
    });
    app.stdout.on("data", (data) => process.stdout.write(data));
    app.stderr.on("data", (data) => process.stderr.write(data));
    await waitForHttp(`http://127.0.0.1:${debugPort}/json/version`);
    let targets = [];
    for (let i = 0; i < 100; i += 1) {
      targets = await getJson(`http://127.0.0.1:${debugPort}/json/list`);
      if (targets.some((target) => target.type === "page" && target.url.startsWith(rendererUrl))) break;
      await sleep(100);
    }
    const target = targets.find(
      (candidate) => candidate.type === "page" && candidate.url.startsWith(rendererUrl)
    );
    if (!target) throw new Error(`Renderer CDP target not found: ${JSON.stringify(targets)}`);
    cdp = new Cdp(target.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    if (CPU_THROTTLE_RATE > 1) {
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_THROTTLE_RATE });
    }
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: instrumentationSource });
    await cdp.send("Page.navigate", { url: rendererUrl });
    await waitFor(
      cdp,
      `location.origin === ${JSON.stringify(rendererUrl)} && document.readyState !== 'loading'`,
      "renderer navigation commit"
    );
    const seed = seedData();
    await evaluate(
      cdp,
      `(() => {
        localStorage.setItem('vibe-terminal:workspaces:v2', ${JSON.stringify(JSON.stringify(seed.workspaces))});
        localStorage.setItem('vibe-terminal:active-workspace:v1', '${WORKSPACE_A}');
        localStorage.setItem('vibe-terminal:active-view:v1', 'project');
        localStorage.removeItem('vibe-terminal:multi-sessions:v1');
        location.reload();
      })()`
    );
    await waitFor(
      cdp,
      `window.__terminalScrollDiag && document.querySelector('[data-session-id="${LONG_ID}"] .xterm-viewport')`,
      "seeded terminal"
    );
    await waitFor(
      cdp,
      `document.querySelector('[data-session-id="${LONG_ID}"] .xterm-rows')?.textContent.includes('DIAG-DONE-12000')`,
      "long output completion",
      90000
    );
    await sleep(1500);
    await evaluate(cdp, `document.querySelector('[data-session-id="${LONG_ID}"] .xterm-viewport').scrollTop = 1e9`);
    await sleep(200);

    for (let i = 1; i <= MAXIMIZE_CYCLES; i += 1) {
      const row = await remountCycle(cdp, "maximize", i, results.screenshot);
      results.maximize.push(row);
      console.log(`maximize ${i}/${MAXIMIZE_CYCLES}: top=${row.bad} ${JSON.stringify(row.after)}`);
    }
    for (let i = 1; i <= WORKSPACE_CYCLES; i += 1) {
      const row = await remountCycle(cdp, "workspace", i, results.screenshot);
      results.workspace.push(row);
      console.log(`workspace ${i}/${WORKSPACE_CYCLES}: top=${row.bad} ${JSON.stringify(row.after)}`);
    }
    if (FINAL_SETTLE_MS > 0) {
      await sleep(FINAL_SETTLE_MS);
      results.postWorkspaceSettle = await metric(cdp);
      console.log(`post-workspace settle: ${JSON.stringify(results.postWorkspaceSettle)}`);
    }
    if (CAPTURE_GOOD && WORKSPACE_CYCLES > 0) {
      results.goodScreenshotMetrics = await metric(cdp);
      await capture(cdp, goodScreenshotPath);
      console.log(`post-fix screenshot: ${goodScreenshotPath}`);
    }
    await evaluate(cdp, `document.querySelector('[data-session-id="${LONG_ID}"] .xterm-viewport').scrollTop = 1e9`);
    for (let i = 1; i <= FOCUS_SWITCHES; i += 1) {
      const row = await focusSwitch(cdp, i);
      results.focus.push(row);
      console.log(`focus ${i}/${FOCUS_SWITCHES}: top=${row.bad} ${JSON.stringify(row.after)}`);
    }

    if (!results.screenshot.captured) {
      const captured = await captureTransientBad(cdp, results.screenshot);
      console.log(`transient top screenshot captured=${captured}`);
    }

    results.controlDefaultScreen = await measureDefaultScreen(cdp);
    results.controlGeometry = await forceEightyByTwentyFour(cdp, results.controlDefaultScreen);
    console.log(`control geometry: ${JSON.stringify(results.controlGeometry)}`);
    await evaluate(cdp, `document.querySelector('[data-session-id="${LONG_ID}"] .xterm-viewport').scrollTop = 1e9`);
    for (let i = 1; i <= CONTROL_CYCLES; i += 1) {
      const row = await remountCycle(cdp, "workspace-control", i, results.screenshot);
      row.geometry = await xtermGeometry(cdp);
      row.controlValid =
        Math.abs(row.geometry?.screenWidth - results.controlDefaultScreen.width) <= 1 &&
        Math.abs(row.geometry?.screenHeight - results.controlDefaultScreen.height) <= 1;
      row.noReflow = row.records
        .filter((event) => event.type === "screen-resize")
        .every(
          (event) =>
            Math.abs(event.width - results.controlDefaultScreen.width) <= 1 &&
            Math.abs(event.height - results.controlDefaultScreen.height) <= 1
        );
      results.control.push(row);
      console.log(`control ${i}/${CONTROL_CYCLES}: top=${row.bad} valid=${row.controlValid} noReflow=${row.noReflow}`);
    }
  } finally {
    results.summary = {
      maximizeTop: results.maximize.filter((row) => row.bad).length,
      workspaceTop: results.workspace.filter((row) => row.bad).length,
      focusTop: results.focus.filter((row) => row.bad).length,
      controlTop: results.control.filter((row) => row.bad).length,
      controlValid: results.control.filter((row) => row.controlValid).length
    };
    fs.writeFileSync(resultPath, JSON.stringify(results, null, 2));
    cdp?.close();
    killTree(app);
    killTree(renderer);
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {}
  }
  console.log(`RESULTS ${resultPath}`);
  console.log(JSON.stringify(results.summary));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
