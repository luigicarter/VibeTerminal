"use strict";
// Scripted-model E2E: real Electron/preload/policy/PTY, no cloud requests or user sessions.
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), net = require("node:net");
const { spawn, spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "../..");
const observeExternal = process.argv.includes("--observe-external");
const output = path.join(root, ".tmp", "orchestrator-command-smoke", `${Date.now()}-${process.pid}`);
fs.mkdirSync(output, { recursive: true });
const result = { output, mode: "scripted OpenRouter; real Electron and PTY; no live model", checks: [] };
result.focusMode = observeExternal ? "observe-existing-external-foreground" : "strict-selected-text-sentinel";
result.externalSelectionVerified = false;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, ms = 25000) { let last; const end = Date.now() + ms; while (Date.now() < end) { try { const value = await fn(); if (value) return value; } catch (error) { last = error; } await wait(120); } throw Error(`Timeout: ${label}; ${last || ""}`); }
class Cdp {
  constructor(url) { this.ws = new WebSocket(url); this.pending = new Map(); this.n = 0; }
  async open() { await new Promise((resolve, reject) => { this.ws.addEventListener("open", resolve, { once: true }); this.ws.addEventListener("error", reject, { once: true }); }); this.ws.addEventListener("message", event => { const packet = JSON.parse(String(event.data)), pending = this.pending.get(packet.id); if (pending) { this.pending.delete(packet.id); packet.error ? pending.reject(Error(packet.error.message)) : pending.resolve(packet.result); } }); }
  send(method, params = {}) { return new Promise((resolve, reject) => { const id = ++this.n; this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expression) { const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails)); return r.result.value; }
  close() { this.ws.close(); }
}
function record(name, value) { result.checks.push({ name, value }); console.log(name, JSON.stringify(value)); }
const userData = path.join(output, "userData"), planFile = path.join(output, "plan.json"), traceFile = path.join(output, "model.jsonl");
const fixtureBin = path.join(output, "bin"), resumeLog = path.join(output, "resume-args.json");
fs.mkdirSync(fixtureBin, { recursive: true });
fs.writeFileSync(path.join(fixtureBin, "codex.ps1"), `ConvertTo-Json -InputObject @($args) -Compress | Set-Content -LiteralPath '${resumeLog.replace(/'/g, "''")}'\nWrite-Output 'FIXTURE_CODEX_RESUMED'\n`);
const historyIds = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
const historyRoot = path.join(output, "codex", "sessions", "2026", "09", "05");
fs.mkdirSync(historyRoot, { recursive: true });
for (const [index, id] of historyIds.entries()) {
  const records = [{ type: "session_meta", payload: { id, cwd: path.join(userData, "Documents", "Relay E2E"), name: `Fixture history ${index + 1}`, timestamp: new Date().toISOString(), originator: "Codex CLI" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `Historical user ${index + 1}` }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `Historical answer ${index + 1}` }] } }];
  fs.writeFileSync(path.join(historyRoot, `rollout-2026-09-05T00-00-00-${id}.jsonl`), records.map(r => JSON.stringify(r)).join("\n") + "\n");
}
// A fixture-only entry point replaces fetch before loading the unchanged application.
const entry = path.join(output, "main.cjs");
fs.writeFileSync(entry, `const fs=require('node:fs');
globalThis.fetch=async(url,options={})=>{
 const reply=data=>({ok:true,json:async()=>data});
 if(url==='https://openrouter.ai/api/v1/key')return reply({data:{is_free_tier:true}});
 if(url==='https://openrouter.ai/api/v1/models')return reply({data:[{id:'fixture/relay',name:'Scripted fixture',supported_parameters:['tools']}]});
 if(url!=='https://openrouter.ai/api/v1/chat/completions')throw Error('Fixture blocked network: '+url);
 const body=JSON.parse(options.body);fs.appendFileSync(${JSON.stringify(traceFile)},JSON.stringify(body)+'\\n');
 const answer=message=>reply({choices:[{message}],usage:{cost:0}});
 if(!body.tools)return answer({content:'NO_CHANGE'});
 const plan=JSON.parse(fs.readFileSync(${JSON.stringify(planFile)},'utf8'));
 if(plan.hold){fs.writeFileSync(${JSON.stringify(path.join(output, "held"))},'held');await new Promise((resolve,reject)=>{if(options.signal.aborted)return reject(Error('Cancelled'));options.signal.addEventListener('abort',()=>reject(Error('Cancelled')),{once:true});});}
 const completed=body.messages.filter(m=>m.role==='tool').length;
 if(completed>=plan.actions.length)return answer({content:JSON.stringify(body.messages.filter(m=>m.role==='tool').map(m=>JSON.parse(m.content)))});
 return answer({tool_calls:[{id:'fixture-'+completed,type:'function',function:{name:'workspace',arguments:JSON.stringify(plan.actions[completed])}}]});
};
require(${JSON.stringify(path.join(root, "backend/main.cjs"))});
`);
const sentinelScript = path.join(output, "sentinel.ps1"), sentinelState = path.join(output, "sentinel.json"), armFile = path.join(output, "arm");
fs.writeFileSync(sentinelScript, `$ErrorActionPreference='Stop'
[Console]::Error.WriteLine('sentinel: starting')
Add-Type -AssemblyName System.Windows.Forms
[Console]::Error.WriteLine('sentinel: WinForms loaded')
Add-Type @'
using System; using System.Runtime.InteropServices;
public class Native { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid); [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber(); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window,int command); }
'@
[Console]::Error.WriteLine('sentinel: native API compiled')
$observeExternal=${observeExternal ? "$true" : "$false"}
[uint32]$script:baselineForeground=0
if($observeExternal) {
 [void][Native]::GetWindowThreadProcessId([Native]::GetForegroundWindow(),[ref]$script:baselineForeground)
 if($script:baselineForeground -eq 0 -or $script:baselineForeground -eq $PID){throw 'No external foreground desktop baseline is available'}
 $parents=@{}; Get-CimInstance Win32_Process | ForEach-Object {$parents[[uint32]$_.ProcessId]=[uint32]$_.ParentProcessId}
 [uint32]$ancestor=$script:baselineForeground; $seen=@{}
 while($ancestor -ne 0 -and !$seen.ContainsKey($ancestor)) {
  if($ancestor -eq [uint32]$env:VIBE_QA_APP_PID){throw 'Foreground belongs to the fixture Electron process family'}
  $seen[$ancestor]=$true; $ancestor=$parents[$ancestor]
 }
 [Console]::Error.WriteLine('sentinel: observing external PID '+$script:baselineForeground+' without activation; selected text unverified')
} else {
 $form=New-Object Windows.Forms.Form
 $form.Text='vibeTerminal QA focus sentinel'; $form.Width=420; $form.Height=130
 $box=New-Object Windows.Forms.TextBox; $box.Dock='Fill'; $box.Text='preserve this selected text'; $form.Controls.Add($box)
}
$script:baseline=[Native]::GetClipboardSequenceNumber(); $script:samples=0; $script:violations=0
$timer=New-Object Windows.Forms.Timer; $timer.Interval=100
$timer.Add_Tick({
 [uint32]$foregroundPid=0; [void][Native]::GetWindowThreadProcessId([Native]::GetForegroundWindow(),[ref]$foregroundPid)
 $sequence=[Native]::GetClipboardSequenceNumber()
 $expectedForeground=if($observeExternal){$script:baselineForeground}else{$PID}
 $selectionValid=$observeExternal -or $box.SelectedText -eq 'selected'
 if(Test-Path -LiteralPath '${armFile.replace(/'/g, "''")}') { $script:samples++; if($foregroundPid -ne $expectedForeground -or $sequence -ne $script:baseline -or !$selectionValid){$script:violations++} }
 @{pid=$PID;foregroundPid=$foregroundPid;baselineForegroundPid=$expectedForeground;clipboardSequence=$sequence;baseline=$script:baseline;selection=$box.SelectedText;selectionVerified=(!$observeExternal);observeExternal=$observeExternal;samples=$script:samples;violations=$script:violations}|ConvertTo-Json|Set-Content -LiteralPath '${sentinelState.replace(/'/g, "''")}'
})
[Console]::Error.WriteLine('sentinel: entering message loop')
if($observeExternal){$timer.Start();[Windows.Forms.Application]::Run()}
else {$form.Add_Shown({[Console]::Error.WriteLine('sentinel: shown');[void][Native]::ShowWindow($form.Handle,5);$form.Activate();[void][Native]::SetForegroundWindow($form.Handle);$box.Focus();$box.Select(14,8);$timer.Start()});[Windows.Forms.Application]::Run($form)}
`);
let child, sentinel, cdp, overlayCdp;
const plan = actions => fs.writeFileSync(planFile, JSON.stringify({ actions }));
async function dispatch(action) { return cdp.eval(`window.vibe.orchestrator.dispatch(${JSON.stringify(action)})`); }
async function command(text) { return cdp.eval(`window.vibe.orchestrator.send(${JSON.stringify({ text, origin: "text" })})`); }
function toolsFrom(reply) { assert.equal(reply.ok, true, JSON.stringify(reply)); return JSON.parse(reply.text); }
(async () => { try {
  assert.equal(process.platform, "win32", "This foreground/PTY harness targets Windows.");
  const port = await new Promise(resolve => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const port = s.address().port; s.close(() => resolve(port)); }); });
  const env = { ...process.env, VIBE_SCREENSHOT_MODE: "1", VIBE_INTERNAL_SCREENSHOT: "0", VIBE_SCREENSHOT_USER_DATA: userData, VIBE_AGENT_SHIM_BASE_DIR: path.join(output, "shims"), CODEX_HOME: path.join(output, "codex"), CLAUDE_CONFIG_DIR: path.join(output, "claude"), XDG_CONFIG_HOME: path.join(output, "config"), XDG_DATA_HOME: path.join(output, "data") };
  for (const key of Object.keys(env)) if (/API_KEY|AUTH_TOKEN/.test(key) || ["ELECTRON_RUN_AS_NODE", "VITE_DEV_SERVER_URL"].includes(key)) delete env[key];
  // No real user-installed agent can resolve from this test's PATH.
  for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key];
  env.PATH = [fixtureBin, path.join(process.env.SystemRoot, "System32"), process.env.SystemRoot, path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0")].join(path.delimiter);
  env.VIBE_NODE_PATH = process.execPath;
  env.VIBE_TERMINAL_SHELL = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  Object.assign(env, { KIMI_CODE_HOME: path.join(output, "kimi"), QWEN_HOME: path.join(output, "qwen"), GEMINI_CLI_HOME: path.join(output, "gemini"), CURSOR_CONFIG_DIR: path.join(output, "cursor"), VIBE_CLAUDE_CUSTOM_HOME: path.join(output, "claude-custom") });
  child = spawn(path.join(root, "node_modules/electron/dist/electron.exe"), [entry, `--remote-debugging-port=${port}`], { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const log = fs.createWriteStream(path.join(output, "electron.log")); child.stdout.pipe(log); child.stderr.pipe(log);
  const page = await until(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(p => p.type === "page" && p.url.startsWith("file:") && !p.url.includes("surface=voice")), "main renderer");
  cdp = new Cdp(page.webSocketDebuggerUrl); await cdp.open();
  await until(() => cdp.eval("Boolean(window.vibe?.orchestrator && document.querySelector('.orchestrator-mic'))"), "orchestrator UI");
  assert.equal((await cdp.eval("window.vibe.orchestrator.configure({key:'fixture-no-real-key',sessionOnly:true,model:'fixture/relay',monitoringIntervalSeconds:300})")).ok, true);
  assert.equal((await cdp.eval("window.vibe.orchestrator.setEnabled(true)")).ok, true);
  const project = await dispatch({ kind: "create_project", parent: path.join(userData, "Documents"), name: "Relay E2E" }); assert.equal(project.ok, true, JSON.stringify(project));
  const created = await dispatch({ kind: "create_session", kindOfSession: "terminal", cwd: project.path }); assert.equal(created.ok, true, JSON.stringify(created));
  const id = created.id || created.sessionId;
  const session = await until(() => cdp.eval(`window.vibe.orchestrator.getState().then(s=>s.sessions.find(s=>s.id===${JSON.stringify(id)}&&s.generation&&!s.generation.startsWith('paused:')))`), "live generation");
  await until(() => cdp.eval(`window.vibe.terminal.getRuntimeSnapshots().then(s=>s.some(s=>s.id===${JSON.stringify(id)}&&s.processState==='running'))`), "running PTY transport");
  const selectedBefore = await cdp.eval("({project:localStorage.getItem('vibe-terminal:active-workspace:v1'),view:localStorage.getItem('vibe-terminal:active-view:v1'),selected:document.querySelector('.session-nav-item.active strong')?.textContent||null})");
  sentinel = spawn(path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", sentinelScript], { env: { ...process.env, VIBE_QA_APP_PID: String(child.pid) }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const sentinelLog = fs.createWriteStream(path.join(output, "sentinel.log")); sentinel.stdout.pipe(sentinelLog); sentinel.stderr.pipe(sentinelLog);
  sentinel.on("error", error => sentinelLog.write(`sentinel: process error ${error.stack}\n`));
  sentinel.on("exit", (code, signal) => sentinelLog.write(`sentinel: exit code=${code} signal=${signal}\n`));
  const foregroundBaseline = await until(() => { if (sentinel.exitCode !== null) throw Error(`Sentinel exited ${sentinel.exitCode}; see sentinel.log`); const state = JSON.parse(fs.readFileSync(sentinelState, "utf8").replace(/^\uFEFF/, "")); const expected = observeExternal ? state.baselineForegroundPid : sentinel.pid; if (!expected || state.foregroundPid !== expected || (!observeExternal && state.selection !== "selected")) throw Error(`Sentinel ready but OS foreground=${state.foregroundPid}, expected=${expected}, selection=${JSON.stringify(state.selection)}; see sentinel.log`); return state; }, "OS foreground sentinel");
  record("foreground-probe-baseline", { mode: result.focusMode, ...foregroundBaseline });
  fs.writeFileSync(armFile, "armed");
  const payload = "Write-Output ('RELAY_' + 'OBSERVED_42')";
  plan([{ kind: "send_prompt", targetId: id, text: payload }, { kind: "read_session", targetId: id }]);
  const sent = toolsFrom(await command(`Send ${id}: ${payload}`)); assert.equal(sent[0].ok, true, JSON.stringify(sent)); assert.equal(sent[0].status, "written");
  const observed = await until(async () => { const read = await dispatch({ kind: "read_session", target: { id, generation: session.generation } }); return read.observation?.text.includes("RELAY_OBSERVED_42") && read; }, "evaluated PTY output, distinct from command echo");
  record("command-policy-generation-real-pty-output", { target: { id, generation: session.generation }, payload, receipt: sent[0], observation: observed });
  plan([{ kind: "send_prompt", targetId: id, text: "Write-Output POLICY_BYPASS" }]);
  const refused = toolsFrom(await command(`Send ${id}: Write-Output legitimate`)); assert.equal(refused[0].ok, false); assert.match(refused[0].error, /COMPLETE|payload/i);
  const stale = await dispatch({ kind: "send_prompt", target: { id, generation: "stale-generation" }, text: "Write-Output STALE_BYPASS" }); assert.equal(stale.ok, false); assert.match(stale.error, /generation|changed/i);
  record("policy-and-stale-refusal", { refused, stale });
  fs.writeFileSync(planFile, JSON.stringify({ actions: [], hold: true }));
  await cdp.eval(`window.__pendingRelay=window.vibe.orchestrator.send({text:'Read ${id}',origin:'text'});void 0`);
  await until(() => fs.existsSync(path.join(output, "held")), "held inference");
  const busy = await command(`Read ${id}`); assert.equal(busy.ok, false); assert.match(busy.error, /running/);
  await cdp.eval("window.vibe.orchestrator.cancel()"); const cancelled = await cdp.eval("window.__pendingRelay"); assert.equal(cancelled.status, "cancelled");
  record("busy-and-cancel", { busy, cancelled });
  const selectedAfter = await cdp.eval("({project:localStorage.getItem('vibe-terminal:active-workspace:v1'),view:localStorage.getItem('vibe-terminal:active-view:v1'),selected:document.querySelector('.session-nav-item.active strong')?.textContent||null})");
  assert.deepEqual(selectedAfter, selectedBefore); record("relay-workspace-view-preserved", selectedAfter);
  plan([{ kind: "list_conversations", provider: "codex", cwd: project.path }]);
  const history = toolsFrom(await command("List saved Codex conversations in Relay E2E"))[0];
  assert.equal(history.ok, true, JSON.stringify(history));
  const first = history.conversations.find(c => c.id === historyIds[0]), second = history.conversations.find(c => c.id === historyIds[1]);
  assert(first && second, JSON.stringify(history));
  plan([{ kind: "read_conversation", reference: first.reference }]);
  const excerpt = toolsFrom(await command(`Read saved conversation ${first.id}`))[0];
  assert.equal(excerpt.ok, true, JSON.stringify(excerpt)); assert.equal(excerpt.identity.id, first.id);
  assert(excerpt.text.includes("Historical answer 1"));
  assert.equal(excerpt.messages, undefined, "Model receives one bounded text projection, not duplicate raw message arrays");
  plan([{ kind: "resume_conversation", reference: second.reference }]);
  const wrongHistory = toolsFrom(await command(`Resume Codex conversation ${first.id} in ${project.path}`))[0]; assert.equal(wrongHistory.ok, false, JSON.stringify(wrongHistory)); assert(!fs.existsSync(resumeLog));
  plan([{ kind: "resume_conversation", reference: first.reference }]);
  const resumed = toolsFrom(await command(`Resume Codex conversation ${first.id} in ${project.path}`))[0]; assert.equal(resumed.ok, true, JSON.stringify(resumed));
  const resumeArgs = await until(() => fs.existsSync(resumeLog) && JSON.parse(fs.readFileSync(resumeLog, "utf8").replace(/^\uFEFF/, "")), "fixture native resume command");
  assert(resumeArgs.includes("resume") && resumeArgs.includes(first.id), JSON.stringify(resumeArgs)); assert(!resumeArgs.includes(second.id));
  record("native-history-list-read-exact-resume", { history: history.conversations, excerpt, wrongHistory, resumed, resumeArgs });
  await until(()=>cdp.eval(`window.vibe.terminal.getRuntimeSnapshots().then(s=>s.some(s=>s.id===${JSON.stringify(resumed.id)}&&['exited','failed'].includes(s.agentProcessState)))`), 'resumed fixture agent exited');
  plan([{kind:'send_prompt'}]);
  const followup=toolsFrom(await command('Tell it: FOLLOWUP_MUST_TARGET_RESUMED_CHAT'))[0];
  assert.equal(followup.id,resumed.id,JSON.stringify(followup));
  assert.equal(followup.status,'not-running',JSON.stringify(followup));
  record('resumed-title-followup-bound-to-new-pane',followup);
  await wait(300);
  const focus = JSON.parse(fs.readFileSync(sentinelState, "utf8").replace(/^\uFEFF/, "")); assert(focus.samples > 3); assert.equal(focus.violations, 0, JSON.stringify(focus)); assert.equal(focus.foregroundPid, foregroundBaseline.baselineForegroundPid); assert.equal(focus.clipboardSequence, focus.baseline);
  if (!observeExternal) { assert.equal(focus.selection, "selected"); result.externalSelectionVerified = true; }
  record(observeExternal ? "external-os-focus-clipboard-selection-unverified" : "external-os-focus-clipboard-selection", focus);
  fs.unlinkSync(armFile); // Foreground assertion interval ends before UI screenshot navigation.
  const finalRead = await dispatch({ kind: "read_session", target: { id, generation: session.generation } }); assert(!/POLICY_BYPASS|STALE_BYPASS|FOLLOWUP_MUST_TARGET_RESUMED_CHAT/.test(finalRead.observation.text));
  const screenshot = await cdp.send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(output, "workspace.png"), Buffer.from(screenshot.data, "base64"));
  await cdp.eval("Array.from(document.querySelectorAll('[role=tab]')).find(e=>e.textContent==='History').click()");
  await until(() => cdp.eval("Boolean(document.querySelector('[aria-label=\"History provider\"]'))"), "history UI");
  await cdp.eval("(()=>{const e=document.querySelector('[aria-label=\"History provider\"]');e.value='codex';e.dispatchEvent(new Event('change',{bubbles:true}));})()");
  await cdp.eval("document.querySelector('.conversation-history-search').requestSubmit()");
  await until(() => cdp.eval("Array.from(document.querySelectorAll('.conversation-history-item')).some(e=>e.textContent.includes('Fixture history 1'))"), "native fixture in History UI");
  await cdp.eval("Array.from(document.querySelectorAll('.conversation-history-item')).find(e=>e.textContent.includes('Fixture history 1')).click()");
  await until(() => cdp.eval("document.querySelector('[aria-label=\"Saved conversation messages\"]')?.textContent.includes('Historical answer 1')"), "History excerpt UI");
  const historyScreenshot = await cdp.send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(output, "history.png"), Buffer.from(historyScreenshot.data, "base64"));
  const voicePage = await until(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(p => p.url.includes("surface=voice")), "overlay renderer");
  overlayCdp = new Cdp(voicePage.webSocketDebuggerUrl); await overlayCdp.open();
  await until(() => overlayCdp.eval("Boolean(document.querySelector('.voice-overlay'))"), "overlay UI");
  const voiceState = await overlayCdp.eval("window.vibe.voice.getState()"); assert.equal(voiceState.listening, false);
  const overlayScreenshot = await overlayCdp.send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(output, "overlay.png"), Buffer.from(overlayScreenshot.data, "base64"));
  record("history-excerpt-and-overlay-ui", { historyExcerptRendered: true, listening: voiceState.listening, phase: voiceState.phase });
  result.pass = true;
} catch (error) { result.pass = false; result.error = error.stack; console.error(error.stack); process.exitCode = 1; }
finally { fs.writeFileSync(path.join(output, "results.json"), JSON.stringify(result, null, 2)); cdp?.close(); overlayCdp?.close(); for (const process of [sentinel, child]) if (process?.pid) spawnSync("taskkill", ["/pid", String(process.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" }); console.log(`Artifacts: ${output}`); } })();
