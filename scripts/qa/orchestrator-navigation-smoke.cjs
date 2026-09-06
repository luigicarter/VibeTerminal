"use strict";
// Private Electron profile and local shell only; never connects a provider.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), net = require("node:net");
const { spawn, spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "../.."), output = path.join(root, ".tmp", "orchestrator-navigation-smoke", `${Date.now()}-${process.pid}`);
fs.mkdirSync(output, { recursive: true });
const userData = path.join(output, "userData"), docs = path.join(userData, "Documents");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, ms = 20000) { const end = Date.now() + ms; let last; while (Date.now() < end) { try { const value = await fn(); if (value) return value; } catch (error) { last = error; } await sleep(100); } throw Error(`Timeout: ${label}: ${last || ""}`); }
class Cdp {
  constructor(url) { this.ws = new WebSocket(url); this.id = 0; this.pending = new Map(); }
  async open() { await new Promise((resolve, reject) => { this.ws.addEventListener("open", resolve, { once: true }); this.ws.addEventListener("error", reject, { once: true }); }); this.ws.addEventListener("message", event => { const packet = JSON.parse(String(event.data)), waiter = this.pending.get(packet.id); if (waiter) { this.pending.delete(packet.id); packet.error ? waiter.reject(Error(packet.error.message)) : waiter.resolve(packet.result); } }); }
  send(method, params = {}) { return new Promise((resolve, reject) => { const id = ++this.id; this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expression) { const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails)); return result.result.value; }
}
async function freePort() { return new Promise(resolve => { const server = net.createServer(); server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close(() => resolve(port)); }); }); }
let child, cdp;
const results = { output, checks: [] };
function check(name, value) { results.checks.push({ name, value }); console.log(name, JSON.stringify(value)); }
async function shot(name) { const screenshot = await cdp.send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(output, `${name}.png`), Buffer.from(screenshot.data, "base64")); }
async function dispatch(action) { return cdp.eval(`window.vibe.orchestrator.dispatch(${JSON.stringify(action)})`); }
async function navigate(view, cwd) { const result = await dispatch({ kind: "navigate", view, ...(cwd ? { cwd } : {}) }); assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.status, "navigated"); assert.equal(result.view, view); return result; }
(async () => { try {
  const port = await freePort(), env = { ...process.env, VIBE_SCREENSHOT_MODE: "1", VIBE_INTERNAL_SCREENSHOT: "0", VIBE_SCREENSHOT_USER_DATA: userData, VIBE_AGENT_SHIM_BASE_DIR: path.join(output, "shims"), CODEX_HOME: path.join(output, "codex"), CLAUDE_CONFIG_DIR: path.join(output, "claude"), GEMINI_CLI_HOME: path.join(output, "gemini"), QWEN_HOME: path.join(output, "qwen"), KIMI_CODE_HOME: path.join(output, "kimi"), XDG_CONFIG_HOME: path.join(output, "config"), XDG_DATA_HOME: path.join(output, "data") };
  delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL;
  child = spawn(path.join(root, "node_modules/electron/dist/electron.exe"), [".", `--remote-debugging-port=${port}`], { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  results.pid = child.pid; const log = fs.createWriteStream(path.join(output, "electron.log")); child.stdout.pipe(log); child.stderr.pipe(log);
  const page = await until(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(page => page.type === "page" && page.url.startsWith("file:") && !page.url.includes("surface=voice")), "renderer");
  cdp = new Cdp(page.webSocketDebuggerUrl); await cdp.open(); await cdp.send("Page.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
  await until(() => cdp.eval("Boolean(window.vibe?.orchestrator && document.querySelector('.sidebar-footer'))"), "workspace");
  const initial = await cdp.eval("window.vibe.orchestrator.getState()"); assert.equal(initial.settings.hasKey, false); assert.equal(initial.enabled, false);
  const project = await dispatch({ kind: "create_project", parent: docs, name: "Navigation QA" }); assert(project.ok, JSON.stringify(project));
  await navigate("project", project.path);
  await until(() => cdp.eval("Boolean(document.querySelector('.session-launch-card[data-launcher-kind=terminal]'))"), "terminal launcher");
  await cdp.eval("document.querySelector('.session-launch-card[data-launcher-kind=terminal]').click()");
  const runtime = await until(() => cdp.eval("window.vibe.terminal.getRuntimeSnapshots().then(items=>items.find(item=>item.processState==='running'))"), "local terminal");
  const runtimeId = JSON.stringify(runtime.id);
  async function preserved() { const next = await cdp.eval(`window.vibe.terminal.getRuntimeSnapshots().then(items=>items.find(item=>item.id===${runtimeId}))`); assert.equal(next?.generation, runtime.generation); assert.equal(next?.processState, "running"); return { id: next.id, generation: next.generation }; }
  await navigate("settings"); assert(await cdp.eval("Boolean(document.querySelector('.settings-dialog'))")); await shot("settings"); await preserved();
  await navigate("history"); assert(await cdp.eval("Boolean(document.querySelector('.conversation-history')) && !document.querySelector('.settings-dialog')"));
  assert.equal(await cdp.eval("document.querySelector('[role=tab][aria-selected=true]')?.textContent"), "History");
  await cdp.eval("Array.from(document.querySelectorAll('[role=tab]')).find(tab=>tab.textContent==='Files').click()");
  await navigate("history"); assert(await cdp.eval("Boolean(document.querySelector('.conversation-history'))")); await shot("history"); await preserved();
  await navigate("orchestrator"); assert(await cdp.eval("Boolean(document.querySelector('.orchestrator-view-host')) && !document.querySelector('.conversation-history')")); await shot("orchestrator"); await preserved();
  await navigate("multi"); assert(await cdp.eval("document.querySelector('[aria-label=\"Multi mode\"]').classList.contains('active') && !document.querySelector('.orchestrator-view-host')")); await preserved();
  const selected = await navigate("project", project.path); assert.equal(selected.cwd.toLowerCase(), project.path.toLowerCase());
  assert(await cdp.eval("document.querySelector('.workspace-button.active')?.textContent.includes('Navigation QA')"));
  const beforeInvalid = await cdp.eval("JSON.stringify({workspace:document.querySelector('.workspace-button.active')?.textContent,storage:localStorage.getItem('vibe-terminal:workspaces:v2'),settings:!!document.querySelector('.settings-dialog')})");
  const invalid = await dispatch({ kind: "navigate", view: "project", cwd: path.join(docs, "missing") }); assert.equal(invalid.ok, false);
  assert.equal(await cdp.eval("JSON.stringify({workspace:document.querySelector('.workspace-button.active')?.textContent,storage:localStorage.getItem('vibe-terminal:workspaces:v2'),settings:!!document.querySelector('.settings-dialog')})"), beforeInvalid);
  check("native-navigation", { views: ["settings", "history", "orchestrator", "multi", "project"], invalid, terminal: await preserved() });
  for (const [width, height] of [[1440, 960], [1024, 640]]) {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    await sleep(150);
    const geometry = await cdp.eval(`(()=>{const list=document.querySelector('.workspace-list');list.querySelectorAll('[data-qa-row]').forEach(row=>row.remove());for(let i=0;i<30;i++){const row=document.createElement('div');row.className='workspace-row';row.dataset.qaRow=String(i);row.innerHTML='<button class="workspace-button"><span class="workspace-name">Layout project '+(i+1)+'</span><span class="workspace-path">C:/Layout/Project-'+(i+1)+'</span></button>';list.append(row);}list.scrollTop=0;const r=list.getBoundingClientRect(),footer=document.querySelector('.sidebar-footer').getBoundingClientRect(),button=document.querySelector('.sidebar-footer button').getBoundingClientRect();return {width:innerWidth,height:innerHeight,listTop:r.top,listBottom:r.bottom,listHeight:r.height,footerTop:footer.top,gap:footer.top-r.bottom,settingsTop:button.top,settingsBottom:button.bottom,scrollHeight:list.scrollHeight,clientHeight:list.clientHeight,maxHeight:getComputedStyle(list).maxHeight};})()`);
    assert(geometry.listHeight > 0); assert(geometry.gap >= 0 && geometry.gap <= 16, "project list fills available space to footer"); assert(geometry.settingsTop >= 0 && geometry.settingsBottom <= height, "Settings fully visible"); assert(geometry.scrollHeight > geometry.clientHeight); assert.equal(geometry.maxHeight, "none");
    await shot(`sidebar-${width}x${height}-top`);
    const bottom = await cdp.eval("(()=>{const list=document.querySelector('.workspace-list');list.scrollTop=list.scrollHeight;const row=list.querySelector('[data-qa-row=\"29\"]'),r=row.getBoundingClientRect(),lr=list.getBoundingClientRect();return {scrollTop:list.scrollTop,lastTop:r.top,lastBottom:r.bottom,listTop:lr.top,listBottom:lr.bottom,reachable:row.contains(document.elementFromPoint(r.left+r.width/2,Math.min(r.bottom-2,lr.bottom-2)))};})()");
    assert(bottom.scrollTop > 0); assert(bottom.lastBottom <= bottom.listBottom + 1); assert(bottom.lastTop >= bottom.listTop); assert(bottom.reachable); await shot(`sidebar-${width}x${height}-bottom`);
    check(`sidebar-${width}x${height}`, { geometry, bottom });
  }
  check("terminal-still-running", await preserved()); results.pass = true;
} catch (error) { results.pass = false; results.error = error.stack; console.error(error.stack); process.exitCode = 1; if (cdp) try { await shot("failure"); } catch {} }
finally { fs.writeFileSync(path.join(output, "results.json"), JSON.stringify(results, null, 2)); cdp?.ws.close(); if (child?.pid) spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" }); console.log(`Artifacts: ${output}`); }
})();
