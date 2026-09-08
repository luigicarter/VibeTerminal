"use strict";
// Scripted-model E2E: real Electron/preload/policy/PTY, no cloud requests or user sessions.
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), net = require("node:net");
const { spawn, spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "../..");
const hidden = true;
const output = path.join(root, ".tmp", "orchestrator-background-launch-smoke", `${Date.now()}-${process.pid}`);
fs.mkdirSync(output, { recursive: true });
const result = { output, mode: "scripted OpenRouter; real Electron and PTY; no live model", checks: [] };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, ms = 25000) { let last; const end = Date.now() + ms; while (Date.now() < end) { try { const value = await fn(); if (value) return value; } catch (error) { last = error; } await wait(120); } throw Error(`Timeout: ${label}; ${last || ""}`); }
class Cdp {
  constructor(url) { this.ws = new WebSocket(url); this.pending = new Map(); this.n = 0; }
  async open() { await new Promise((resolve, reject) => { this.ws.addEventListener("open", resolve, { once: true }); this.ws.addEventListener("error", reject, { once: true }); }); this.ws.addEventListener("message", event => { const packet = JSON.parse(String(event.data)), pending = this.pending.get(packet.id); if (pending) { this.pending.delete(packet.id); clearTimeout(pending.timer); packet.error ? pending.reject(Error(packet.error.message)) : pending.resolve(packet.result); } }); }
  send(method, params = {}) { return new Promise((resolve, reject) => { const id = ++this.n; const timer = setTimeout(() => { this.pending.delete(id); reject(Error(`CDP timeout: ${method}`)); }, 60000); this.pending.set(id, { resolve, reject, timer }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expression) { const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails)); return r.result.value; }
  close() { for (const pending of this.pending.values()) clearTimeout(pending.timer); this.pending.clear(); this.ws.close(); }
}
function record(name, value) { result.checks.push({ name, value }); console.log(name, JSON.stringify(value)); }
const userData = path.join(output, "userData"), planFile = path.join(output, "plan.json"), traceFile = path.join(output, "model.jsonl");
const fixtureBin = path.join(output, "bin");
fs.mkdirSync(fixtureBin, { recursive: true });
fs.writeFileSync(path.join(fixtureBin, "codex.ps1"), "Add-Content -LiteralPath (Join-Path (Get-Location) 'fixture-launches.txt') -Value 'launch'\nWrite-Output 'FIXTURE_CODEX_LAUNCHED'\n");
// A fixture-only entry point replaces fetch before loading the unchanged application.
const entry = path.join(output, "main.cjs");
fs.writeFileSync(entry, `const fs=require('node:fs');
const {interpretTestIntent}=require(${JSON.stringify(path.join(root,'scripts/backend/orchestrator-test-intent.cjs'))});
if(${hidden}){
 const electron=require('electron'),NativeWindow=electron.BrowserWindow,Module=require('node:module'),load=Module._load;
 // Fixture-only hidden runtime: do not create/activate a foreground QA window.
 const hiddenElectron=Object.create(electron);
 Object.defineProperty(hiddenElectron,'BrowserWindow',{value:class extends NativeWindow{
  constructor(options){super({...options,show:false});}
  show(){} showInactive(){} maximize(){} restore(){} focus(){}
 }});
 Module._load=function(name,...args){return name==='electron'?hiddenElectron:load.call(this,name,...args);};
}
const path=require('node:path');const permissionModule=require(${JSON.stringify(path.join(root,'backend/microphonePermission.cjs'))});const permissionFactory=permissionModule.createMicrophonePermission;
// This transport harness starts with granted app consent and scripted OS access;
// No microphone capture is used by these cases.
permissionModule.createMicrophonePermission=options=>{fs.mkdirSync(options.userDataPath,{recursive:true});fs.writeFileSync(path.join(options.userDataPath,'microphone-consent.json'),JSON.stringify({version:1,granted:true}));return permissionFactory({...options,systemPreferences:{getMediaAccessStatus:()=> 'granted'}});};
globalThis.fetch=async(url,options={})=>{
 const reply=data=>({ok:true,json:async()=>data});
 if(url==='https://openrouter.ai/api/v1/key')return reply({data:{is_free_tier:true}});
 if(String(url).startsWith('https://openrouter.ai/api/v1/models'))return reply({data:[{id:'fixture/relay',name:'Scripted fixture',context_length:128000,supported_parameters:['tools']},{id:'openai/whisper-large-v3-turbo',architecture:{output_modalities:['transcription']}},{id:'hexgrad/kokoro-82m',architecture:{output_modalities:['speech']}}]});
 if(url!=='https://openrouter.ai/api/v1/chat/completions')throw Error('Fixture blocked network: '+url);
 const body=JSON.parse(options.body);fs.appendFileSync(${JSON.stringify(traceFile)},JSON.stringify(body)+'\\n');
 const answer=message=>reply({choices:[{message}],usage:{cost:0}});
 if(!body.tools)return answer({content:'NO_CHANGE'});
 if(body.tools.some(tool=>tool.function?.name==='interpret_workspace')){
  const context=JSON.parse(body.messages.find(message=>message.role==='user').content);
  context.roots.projects=context.roots.projects.map(project=>typeof project==='string'?{path:project,name:path.basename(project)}:project);
  const intent=interpretTestIntent(context),plan=JSON.parse(fs.readFileSync(${JSON.stringify(planFile)},'utf8'));
  if(plan.directCreation && intent.actions.every(action=>action.kind==='create_session'))intent.executionMode='direct';
  return answer({tool_calls:[{id:'fixture-intent',type:'function',function:{name:'interpret_workspace',arguments:JSON.stringify(intent)}}]});
 }
 const plan=JSON.parse(fs.readFileSync(${JSON.stringify(planFile)},'utf8'));
 const completed=body.messages.filter(m=>m.role==='tool').length;
 if(completed>=plan.actions.length)return answer({content:JSON.stringify(body.messages.filter(m=>m.role==='tool').map(m=>JSON.parse(m.content)))});
 return answer({tool_calls:[{id:'fixture-'+completed,type:'function',function:{name:'workspace',arguments:JSON.stringify(plan.actions[completed])}}]});
};
require(${JSON.stringify(path.join(root, "backend/main.cjs"))});
`);
let child, cdp;
const plan = (actions, extra = {}) => fs.writeFileSync(planFile, JSON.stringify({ actions, ...extra }));
async function dispatch(action) { return cdp.eval(`window.vibe.orchestrator.dispatch(${JSON.stringify(action)})`); }
async function command(text) { return cdp.eval(`window.vibe.orchestrator.send(${JSON.stringify({ text, origin: "text" })})`); }
function toolsFrom(reply, expectedOk = true) { assert.equal(reply.ok, expectedOk, JSON.stringify(reply)); return reply.actions || []; }
(async () => { try {
  assert.equal(process.platform, "win32", "This hidden Electron/PTY harness targets Windows.");
  const port = await new Promise(resolve => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const port = s.address().port; s.close(() => resolve(port)); }); });
  const env = { ...process.env, VIBE_SCREENSHOT_MODE: "1", VIBE_INTERNAL_SCREENSHOT: "0", VIBE_SCREENSHOT_USER_DATA: userData, VIBE_AGENT_SHIM_BASE_DIR: path.join(output, "shims"), CODEX_HOME: path.join(output, "codex"), CLAUDE_CONFIG_DIR: path.join(output, "claude"), XDG_CONFIG_HOME: path.join(output, "config"), XDG_DATA_HOME: path.join(output, "data") };
  for (const key of Object.keys(env)) if (/API_KEY|AUTH_TOKEN/.test(key) || ["ELECTRON_RUN_AS_NODE", "VITE_DEV_SERVER_URL"].includes(key)) delete env[key];
  // No real user-installed agent can resolve from this test's PATH.
  for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key];
  env.PATH = [fixtureBin, path.join(process.env.SystemRoot, "System32"), process.env.SystemRoot, path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0")].join(path.delimiter);
  env.VIBE_NODE_PATH = process.execPath;
  env.VIBE_TERMINAL_SHELL = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  Object.assign(env, { KIMI_CODE_HOME: path.join(output, "kimi"), QWEN_HOME: path.join(output, "qwen"), GEMINI_CLI_HOME: path.join(output, "gemini"), CURSOR_CONFIG_DIR: path.join(output, "cursor"), VIBE_CLAUDE_CUSTOM_HOME: path.join(output, "claude-custom") });
  child = spawn(path.join(root, "node_modules/electron/dist/electron.exe"), [entry, `--remote-debugging-port=${port}`, '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'], { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const log = fs.createWriteStream(path.join(output, "electron.log")); child.stdout.pipe(log); child.stderr.pipe(log);
  const page = await until(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(p => p.type === "page" && p.url.startsWith("file:") && !p.url.includes("surface=voice")), "main renderer");
  cdp = new Cdp(page.webSocketDebuggerUrl); await cdp.open();
  await until(() => cdp.eval("Boolean(window.vibe?.orchestrator && document.querySelector('.orchestrator-mic'))"), "orchestrator UI");
  assert.equal((await cdp.eval("window.vibe.orchestrator.configure({key:'fixture-no-real-key',sessionOnly:true,model:'fixture/relay',monitoringIntervalSeconds:300})")).ok, true);
  assert.equal((await cdp.eval("window.vibe.orchestrator.setEnabled(true)")).ok, true);
  const project = async name => { const r = await dispatch({ kind: "create_project", parent: path.join(userData, "Documents"), name }); assert.equal(r.ok, true, JSON.stringify(r)); return r.path; };
  const navigate = async cwd => { assert.equal((await dispatch({ kind: "navigate", view: "project", cwd })).ok, true); };
  const inventory = id => cdp.eval(`window.vibe.orchestrator.getState().then(s=>s.sessions.find(s=>s.id===${JSON.stringify(id)}))`);
  const mounted = id => cdp.eval(`Array.from(document.querySelectorAll('[data-pane-id]'),e=>e.dataset.paneId).includes(${JSON.stringify(id)})`);
  const launchCount = cwd => { const file = path.join(cwd, "fixture-launches.txt"); return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split(/\r?\n/).length : 0; };
  async function create(cwd, kind = "codex") {
    const receipt = await dispatch({ kind: "create_session", kindOfSession: kind, cwd });
    assert.equal(receipt.ok, true, JSON.stringify(receipt));
    assert(receipt.target?.generation && !receipt.target.generation.startsWith("paused:"), `Creation must acknowledge a real launch: ${JSON.stringify(receipt)}`);
    const live = await inventory(receipt.id);
    assert(live?.terminalPid > 0, `Creation must await a real PTY: ${JSON.stringify(live)}`);
    assert.equal(live.generation, receipt.target.generation);
    assert.equal(receipt.cwd, cwd, "creation must report the confirmed workspace directory");
    return { receipt, live };
  }
  const a = await project("Visible A"), b = await project("Background B");
  await navigate(a);
  const background = await create(b);
  assert.equal(await mounted(background.receipt.id), false);
  await until(() => launchCount(b) === 1, "inactive project launcher");
  record("inactive-project-launch-without-mount", background);

  const multi = path.join(userData, "Documents", "Multi only"); fs.mkdirSync(multi, { recursive: true });
  const multiSession = await create(multi);
  assert.equal(await mounted(multiSession.receipt.id), false);
  await until(() => launchCount(multi) === 1, "inactive Multi launcher");
  record("inactive-multi-launch-without-mount", multiSession);

  plan([], { directCreation: true });
  const opened = await command("Create terminal in Visible A");
  assert.equal(opened.ok, true, JSON.stringify(opened));
  assert.equal(opened.actions?.length, 1, JSON.stringify(opened));
  assert.equal(opened.actions[0].cwd, a);
  assert(opened.text.includes(' in Visible A.'), opened.text);
  assert.doesNotMatch(opened.text, /powershell\.exe|System32|[a-z]:[\\/]/i);
  const shell = { receipt: opened.actions[0] };
  record("direct-shell-reply-reports-project-directory", opened);
  // Compare inside PowerShell so terminal line wrapping cannot split the path.
  const payload = `Write-Output ('BACKGROUND_' + 'COMMAND_OK'); Write-Output ('WORKSPACE_' + 'CWD_MATCH=' + ((Get-Location).Path -eq '${a.replace(/'/g, "''")}'))`;
  plan([{ kind: "send_prompt", targetId: shell.receipt.id, text: payload }]);
  const sent = toolsFrom(await command(`Send ${shell.receipt.id}: ${payload}`));
  assert.equal(sent[0].ok, true, JSON.stringify(sent)); assert.equal(sent[0].status, "written");
  const cwdObservation = await until(async () => { const r = await dispatch({ kind: "read_session", target: shell.receipt.target }); return r.observation?.text.includes("BACKGROUND_COMMAND_OK") && r.observation.text.includes("WORKSPACE_CWD_MATCH=True") && r; }, "immediate create then command output and actual PowerShell cwd");
  record("powershell-working-directory-matches-creation-receipt", { cwd: shell.receipt.cwd, observed: cwdObservation.observation.text });
  record("create-then-send", { created: shell.receipt, sent });
  await until(() => mounted(shell.receipt.id), "visible shell pane");
  const selector = `[data-pane-id="${shell.receipt.id}"] button[aria-label="Maximize pane"]`;
  await until(() => cdp.eval(`Boolean(document.querySelector(${JSON.stringify(selector)}))`), "maximize control");
  await cdp.eval(`document.querySelector(${JSON.stringify(selector)}).click()`);
  await until(() => cdp.eval("Boolean(document.querySelector('button[aria-label=\"Restore pane\"]'))"), "maximized tile");
  const obscured = await create(a);
  assert.equal(await mounted(obscured.receipt.id), false);
  await until(() => launchCount(a) === 1, "maximized-away launcher");
  record("maximized-away-launch", obscured);

  await navigate(a);
  assert.equal((await dispatch({ kind: "navigate", view: "orchestrator" })).ok, true);
  const covered = await create(a);
  await until(() => launchCount(a) === 2, "covered board launcher");
  assert.equal(await cdp.eval("Boolean(document.querySelector('.workspace-covered'))"), true);
  record("orchestrator-covered-launch", covered);

  await navigate(b);
  await until(() => mounted(background.receipt.id), "background pane first attachment");
  await navigate(a); await navigate(b); await wait(1000);
  const reattached = await inventory(background.receipt.id);
  assert.equal(reattached.generation, background.live.generation);
  assert.equal(reattached.terminalPid, background.live.terminalPid);
  assert.equal(launchCount(b), 1);
  record("remount-retains-process-and-launcher", { generation: reattached.generation, pid: reattached.terminalPid });

  await navigate(a);
  const restarted = await dispatch({ kind: "restart", target: background.receipt.target });
  assert.equal(restarted.ok, true, JSON.stringify(restarted));
  const fresh = await until(async () => { const r = await inventory(background.receipt.id); return r?.terminalPid > 0 && r.generation !== background.live.generation && !r.generation.startsWith("paused:") && r; }, "hidden restart generation");
  await until(() => launchCount(b) === 2, "hidden restart launcher");
  assert.equal(await mounted(background.receipt.id), false);
  assert.notEqual(fresh.terminalPid, background.live.terminalPid);
  record("hidden-restart-launches-once", { receipt: restarted, generation: fresh.generation, pid: fresh.terminalPid });
  result.pass = true;
} catch (error) { result.pass = false; result.error = error.stack; console.error(error.stack); process.exitCode = 1; }
finally {
  fs.writeFileSync(path.join(output, "results.json"), JSON.stringify(result, null, 2));
  cdp?.close();
  if (child?.pid) spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
  console.log(`Artifacts: ${output}`);
} })();
