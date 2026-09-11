"use strict";
// Isolated local Git repositories and a hidden Electron window; no providers.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), net = require("node:net");
const { spawn, spawnSync, execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "../..");
const screenshots = process.argv.includes("--screenshots");
const output = path.join(root, ".tmp", "git-branch-display-smoke", `${Date.now()}-${process.pid}`);
fs.mkdirSync(output, { recursive: true });
const config = path.join(output, "gitconfig"); fs.writeFileSync(config, "");
const env = { ...process.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1", VIBE_SCREENSHOT_MODE: "1", VIBE_SCREENSHOT_HIDDEN: screenshots ? "0" : "1", VIBE_INTERNAL_SCREENSHOT: "0", VIBE_SCREENSHOT_USER_DATA: path.join(output, "userData"), VIBE_AGENT_SHIM_BASE_DIR: path.join(output, "shims"), CODEX_HOME: path.join(output, "codex"), CLAUDE_CONFIG_DIR: path.join(output, "claude"), GEMINI_CLI_HOME: path.join(output, "gemini"), QWEN_HOME: path.join(output, "qwen"), KIMI_CODE_HOME: path.join(output, "kimi"), XDG_CONFIG_HOME: path.join(output, "config"), XDG_DATA_HOME: path.join(output, "data") };
delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, ms = 20000) {
  const end = Date.now() + ms; let last;
  while (Date.now() < end) { try { const value = await fn(); if (value) return value; } catch (error) { last = error; } await sleep(100); }
  throw Error(`Timeout ${label}: ${last || ""}`);
}
function git(cwd, ...args) { return execFileSync("git", ["-c", "user.name=Git UI QA", "-c", "user.email=qa@localhost", "-c", "commit.gpgsign=false", ...args], { cwd, env, windowsHide: true, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
function fixture(name, branch) {
  const cwd = path.join(output, name); fs.mkdirSync(cwd); git(cwd, "init", "-q", "-b", branch);
  fs.writeFileSync(path.join(cwd, "file.txt"), "base\n"); git(cwd, "add", "."); git(cwd, "commit", "-qm", "base"); return cwd;
}
class Cdp {
  constructor(url) { this.ws = new WebSocket(url); this.n = 0; this.pending = new Map(); }
  async open() {
    await new Promise((resolve, reject) => { this.ws.addEventListener("open", resolve, { once: true }); this.ws.addEventListener("error", reject, { once: true }); });
    this.ws.addEventListener("message", event => { const p = JSON.parse(String(event.data)), q = this.pending.get(p.id); if (q) { this.pending.delete(p.id); clearTimeout(q.timer); p.error ? q.reject(Error(p.error.message)) : q.resolve(p.result); } });
  }
  send(method, params = {}) { return new Promise((resolve, reject) => { const id = ++this.n, timer = setTimeout(() => { this.pending.delete(id); reject(Error(`CDP timeout: ${method}`)); }, 10000); this.pending.set(id, { resolve, reject, timer }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expression) { const value = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (value.exceptionDetails) throw Error(JSON.stringify(value.exceptionDetails)); return value.result.value; }
}
const freePort = () => new Promise(resolve => { const server = net.createServer(); server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close(() => resolve(port)); }); });
let child, cdp; const results = { output, checks: [] };
const check = (name, value) => { results.checks.push({ name, value }); console.log(name, JSON.stringify(value)); };
async function key(key, shift = false) {
  const code = { ArrowDown: 40, End: 35, Home: 36, Escape: 27, Tab: 9 }[key];
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key, code: key, windowsVirtualKeyCode: code, modifiers: shift ? 8 : 0 });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, windowsVirtualKeyCode: code, modifiers: shift ? 8 : 0 });
}
async function geometry() {
  return cdp.eval(`(()=>{const p=document.querySelector('.branch-picker'),b=document.querySelector('.diff-branch-button'),l=document.querySelector('.branch-picker-list');return {popup:p.getBoundingClientRect().toJSON(),trigger:b.getBoundingClientRect().toJSON(),width:innerWidth,height:innerHeight,scroll:l.scrollTop,scrollHeight:l.scrollHeight,clientHeight:l.clientHeight,focused:document.activeElement.className,role:p.getAttribute('role'),expanded:b.getAttribute('aria-expanded'),rows:[...p.querySelectorAll('.branch-picker-row')].map(e=>({text:e.innerText,current:e.classList.contains('is-current')}))};})()`);
}
function inViewport(value) {
  assert(value.popup.top >= value.trigger.bottom); assert(value.popup.top >= 0); assert(value.popup.left >= 0);
  assert(value.popup.right <= value.width); assert(value.popup.bottom <= value.height);
}
async function screenshot(name) {
  if (!screenshots) return;
  const result = await cdp.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(output, `${name}.png`), Buffer.from(result.data, "base64"));
}
(async () => { try {
  const repo = fixture("repo-a", "main"), repoB = fixture("repo-b", "project-b");
  git(repo, "config", "remote.origin.url", path.join(output, "unused-local-remote.git")); git(repo, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
  git(repo, "update-ref", "refs/remotes/origin/main", git(repo, "rev-parse", "HEAD")); git(repo, "branch", "--set-upstream-to=origin/main", "main");
  fs.appendFileSync(path.join(repo, "file.txt"), "local\n"); git(repo, "add", "."); git(repo, "commit", "-qm", "unpushed");
  for (let i = 0; i < 18; i++) git(repo, "branch", `feature-${String(i).padStart(2, "0")}`);
  git(repo, "branch", "feature/" + "long-branch-name-".repeat(7));
  fs.writeFileSync(path.join(repo, "binary.bin"), Buffer.from([0, 1, 2]));
  const port = await freePort();
  child = spawn(path.join(root, "node_modules/electron/dist/electron.exe"), [".", `--remote-debugging-port=${port}`, "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"], { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const log = fs.createWriteStream(path.join(output, "electron.log")); child.stdout.pipe(log); child.stderr.pipe(log);
  const page = await until(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(p => p.type === "page" && p.url.startsWith("file:") && !p.url.includes("surface=voice")), "renderer");
  cdp = new Cdp(page.webSocketDebuggerUrl); await cdp.open(); await cdp.send("Page.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
  await until(() => cdp.eval("Boolean(window.vibe?.workspace)"), "preload");
  const workspaces = [{ id: "a", name: "Branch QA A", path: repo, sessions: [] }, { id: "b", name: "Branch QA B", path: repoB, sessions: [] }];
  await cdp.eval(`localStorage.setItem('vibe-terminal:workspaces:v2',${JSON.stringify(JSON.stringify(workspaces))});localStorage.setItem('vibe-terminal:active-workspace:v1','a');localStorage.setItem('vibe-terminal:active-view:v1','project');`);
  await cdp.send("Page.reload"); await until(() => cdp.eval("document.querySelector('.diff-branch-button')?.textContent==='main'"), "main branch");
  await cdp.eval("document.querySelector('.diff-branch-button').click()"); await until(() => cdp.eval("document.querySelectorAll('.branch-picker-row').length===20"), "branches");
  const initial = await geometry(); inViewport(initial); assert.equal(initial.role, "dialog"); assert.equal(initial.expanded, "true"); assert.equal(initial.focused, "branch-picker-list");
  assert.match(initial.rows.find(r => r.current).text, /1 ahead/); assert.match(initial.rows.find(r => r.current).text, /1 changed file/); assert(!initial.rows[0].text.includes("+0"));
  check("visible list, accurate binary and upstream state", initial); await screenshot("branches-1440x960");
  await key("ArrowDown"); assert((await geometry()).scroll > 0); await key("End"); assert((await geometry()).scroll > 500); await key("Home"); assert.equal((await geometry()).scroll, 0);
  await key("Tab", true); assert.equal(await cdp.eval("document.activeElement.getAttribute('aria-label')"), "Close branches");
  await key("Tab", true); assert.equal(await cdp.eval("document.activeElement.getAttribute('aria-label')"), "Refresh branches");
  await key("Tab", true); assert.equal(await cdp.eval("document.activeElement.className"), "branch-worktree-path");
  await key("Escape"); assert.equal(await cdp.eval("Boolean(document.querySelector('.branch-picker'))"), false); assert.match(await cdp.eval("document.activeElement.className"), /diff-branch-button/);
  check("keyboard scroll, focus containment and Escape", true);
  await cdp.eval("document.querySelector('.diff-branch-button').click()"); await until(() => cdp.eval("Boolean(document.querySelector('.branch-picker-row.is-current'))"), "reopened");
  git(repo, "checkout", "-q", "feature-00");
  await until(() => cdp.eval("document.querySelector('.diff-branch-button')?.textContent==='feature-00' && document.querySelector('.branch-picker-row.is-current .branch-picker-name')?.textContent.startsWith('feature-00')"), "automatic branch refresh");
  check("toolbar and open list refresh together", true);
  fs.writeFileSync(path.join(repo, "another.txt"), "new\n"); await cdp.eval("document.querySelector('[aria-label=\"Refresh branches\"]').click()");
  await until(() => cdp.eval("document.querySelector('.branch-picker-row.is-current')?.textContent.includes('2 changed files')"), "manual refresh");
  check("manual refresh", true); await key("Escape");
  await cdp.eval("[...document.querySelectorAll('.workspace-button')].find(e=>e.textContent.includes('Branch QA B')).click()");
  await until(() => cdp.eval("document.querySelector('.diff-branch-button')?.textContent==='project-b'"), "second project");
  await cdp.eval("document.querySelector('.diff-branch-button').click()"); await until(() => cdp.eval("document.querySelectorAll('.branch-picker-row').length===1"), "single branch");
  const single = await geometry(); inViewport(single); check("single branch is visible", single);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1024, height: 700, deviceScaleFactor: 1, mobile: false }); await sleep(150);
  const compact = await geometry(); check("compact viewport", compact); inViewport(compact); await screenshot("branches-1024x700");
  results.pass = true;
} catch (error) { results.pass = false; results.error = error.stack; console.error(error); process.exitCode = 1; }
finally { fs.writeFileSync(path.join(output, "results.json"), JSON.stringify(results, null, 2)); cdp?.ws.close(); if (child?.pid) spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" }); console.log(`Artifacts: ${output}`); }
})();
