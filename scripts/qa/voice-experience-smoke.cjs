'use strict';
// Real Electron capture/playback lifecycle; fake Chromium microphone, scripted cloud,
// zero-gain renderer playback, isolated profile. No live provider or user devices.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { wavFromSamples } = require('../../backend/voiceAudio.cjs');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.tmp', 'voice-experience-smoke', `${Date.now()}-${process.pid}`);
fs.mkdirSync(output, { recursive: true });
const result = { output, checks: [], audiblePlaybackVerified: false, physicalMicrophoneVerified: false, liveProviderVerified: false, nativePermissionDialogVisualVerified: false, consentDialogAndOsStatusScripted: true };
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label, ms = 30000) { let last; for (const end = Date.now() + ms; Date.now() < end;) { try { const v = await fn(); if (v) return v; } catch (e) { last = e; } await wait(150); } throw Error(`Timeout: ${label}; ${last || ''}`); }
class Cdp {
  constructor(url) { this.ws = new WebSocket(url); this.pending = new Map(); this.n = 0; }
  async open() { await new Promise((resolve, reject) => { this.ws.addEventListener('open', resolve, { once: true }); this.ws.addEventListener('error', reject, { once: true }); }); this.ws.addEventListener('message', event => { const packet = JSON.parse(String(event.data)), p = this.pending.get(packet.id); if (p) { this.pending.delete(packet.id); packet.error ? p.reject(Error(packet.error.message)) : p.resolve(packet.result); } }); }
  send(method, params = {}) { return new Promise((resolve, reject) => { const id = ++this.n; this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expression) { const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails)); return r.result.value; }
  close() { this.ws.close(); }
}
const traceFile = path.join(output, 'events.jsonl'), stateFile = path.join(output, 'windows.json'), commandFile = path.join(output, 'command.json'), failureFile = path.join(output, 'speech-failure'), consentResponseFile = path.join(output, 'consent-response.json');
const transcriptionFile = path.join(output, 'transcription.json');
fs.writeFileSync(transcriptionFile, JSON.stringify({ text: 'hello' }));
const events = () => fs.existsSync(traceFile) ? fs.readFileSync(traceFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const windows = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const record = (name, value) => { result.checks.push({ name, value }); console.log(name, JSON.stringify(value)); };
const entry = path.join(output, 'main.cjs');
fs.writeFileSync(entry, `
const fs=require('node:fs'); const electron=require('electron');
const log=data=>fs.appendFileSync(${JSON.stringify(traceFile)},JSON.stringify(data)+'\\n');
const permissionModule=require(${JSON.stringify(path.join(root,'backend/microphonePermission.cjs'))});const permissionFactory=permissionModule.createMicrophonePermission;
permissionModule.createMicrophonePermission=options=>permissionFactory({...options,
 systemPreferences:{getMediaAccessStatus:kind=>{log({consentOsStatus:kind});return 'granted';}},
 // Only this permission factory sees simulated foreground eligibility; OS focus
 // and real BrowserWindow behavior elsewhere remain untouched.
 getMainWindow:()=>{const actual=options.getMainWindow();return actual&&new Proxy(actual,{get(target,key){if(['isFocused','isVisible'].includes(key))return ()=>true;if(key==='isMinimized')return ()=>false;const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});},
 dialog:{showMessageBox:async(parent,config)=>{log({consentDialog:{parentId:parent.id,actualMainId:options.getMainWindow()?.id,title:config.title,message:config.message,detail:config.detail,buttons:config.buttons,defaultId:config.defaultId,cancelId:config.cancelId,source:'createMicrophonePermission dialog spy'}});while(!fs.existsSync(${JSON.stringify(consentResponseFile)})){if(config.signal?.aborted)throw Error('Consent cancelled');await new Promise(r=>setTimeout(r,25));}return JSON.parse(fs.readFileSync(${JSON.stringify(consentResponseFile)},'utf8'));}}
});
const handle=electron.ipcMain.handle.bind(electron.ipcMain);
// Use the same deterministic interpretation stand-in as the backend integration
// suite; recognition, recording, transport and playback remain real here.
const orchestration=require(${JSON.stringify(path.join(root, 'backend/orchestrator.cjs'))});const createRelay=orchestration.createOrchestrator;
orchestration.createOrchestrator=options=>createRelay({...options,interpretIntent:require(${JSON.stringify(path.join(root, 'scripts/backend/orchestrator-test-intent.cjs'))}).interpretTestIntent});
electron.ipcMain.handle=(channel,listener)=>handle(channel,async(event,...args)=>{ const value=await listener(event,...args); if(channel==='voice:configure')log({channel,payload:args[0],value}); return value; });
const surface=require(${JSON.stringify(path.join(root, 'backend/voiceOverlayWindow.cjs'))}); const original=surface.createVoiceOverlayWindow;
surface.createVoiceOverlayWindow=options=>original({...options,BrowserWindow:class extends options.BrowserWindow{constructor(config){super(config);log({nativeOptions:{width:config.width,height:config.height,frame:config.frame,transparent:config.transparent,alwaysOnTop:config.alwaysOnTop,focusable:config.focusable,backgroundThrottling:config.webPreferences.backgroundThrottling}});this.on('show',()=>log({unexpectedNativeAudioShow:true}));}}});
globalThis.fetch=async(url,options={})=>{
 log({request:String(url)}); const reply=data=>new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
 if(url==='https://openrouter.ai/api/v1/key')return reply({data:{is_free_tier:true}});
 if(String(url).startsWith('https://openrouter.ai/api/v1/models'))return reply({data:[{id:'fixture/relay',name:'Fixture relay',supported_parameters:['tools'],architecture:{input_modalities:['text'],output_modalities:['text']}},{id:'openai/whisper-large-v3-turbo',architecture:{output_modalities:['transcription']}},{id:'hexgrad/kokoro-82m',architecture:{output_modalities:['speech']}}]});
 if(url==='https://openrouter.ai/api/v1/chat/completions'){
  const body=JSON.parse(options.body);
  if(body.tools?.some(tool=>tool.function?.name==='interpret_workspace'))return reply({choices:[{message:{tool_calls:[{id:'fixture-intent',type:'function',function:{name:'interpret_workspace',arguments:JSON.stringify({goal:'Answer the fixture user without workspace effects.',actions:[]})}}]}}],usage:{cost:0}});
  return reply({choices:[{message:{content:'Fixture text answer.'}}],usage:{cost:0}});
 }
 if(url==='https://openrouter.ai/api/v1/audio/transcriptions'){
  const body=JSON.parse(options.body);const audio=Buffer.from(body.input_audio?.data||'','base64');
  if(body.input_audio?.format!=='wav'||audio.toString('ascii',0,4)!=='RIFF'||audio.toString('ascii',8,12)!=='WAVE')throw Error('Fixture expected WAV transcription input');
  let peak=0;for(let at=44;at+1<audio.length;at+=2){const value=Math.abs(audio.readInt16LE(at));if(value>peak)peak=value;}
  const transcript=JSON.parse(fs.readFileSync(${JSON.stringify(transcriptionFile)},'utf8'));log({transcription:transcript.text,samples:(audio.length-44)/2,peak});return reply({...transcript,usage:{cost:0}});
 }
 if(url==='https://openrouter.ai/api/v1/audio/speech'){
  const body=JSON.parse(options.body);log({speechRequest:{response_format:body.response_format,input:body.input}});
  if(body.response_format!=='pcm')throw Error('Fixture expected PCM speech request');
  if(fs.existsSync(${JSON.stringify(failureFile)}))return new Response(JSON.stringify({error:{message:'Fixture speech outage',code:503}}),{status:503,headers:{'content-type':'application/json'}});
  const pcm=Buffer.alloc(4800);for(let i=0;i<2400;i++)pcm.writeInt16LE(Math.round(1000*Math.sin(i*2*Math.PI*440/24000)),i*2);
  return new Response(pcm,{headers:{'content-type':'audio/pcm;rate=24000;channels=1'}});
 }
 throw Error('Fixture blocked network: '+url);
};
setInterval(()=>{const all=electron.BrowserWindow.getAllWindows();fs.writeFileSync(${JSON.stringify(stateFile)},JSON.stringify(all.map(w=>({id:w.id,webContentsId:w.webContents.id,url:w.webContents.getURL(),visible:w.isVisible(),bounds:w.getBounds()}))));if(fs.existsSync(${JSON.stringify(commandFile)})){const command=JSON.parse(fs.readFileSync(${JSON.stringify(commandFile)},'utf8'));fs.unlinkSync(${JSON.stringify(commandFile)});if(command.closeVoice)all.find(w=>w.webContents.getURL().includes('surface=voice'))?.close();}},100).unref();
require(${JSON.stringify(path.join(root, 'backend/main.cjs'))});
`);
let child, cdp, voice;
async function click(selector, client = cdp) { await client.eval(`document.querySelector(${JSON.stringify(selector)}).click()`); }
async function screenshot(client, name) { const r = await client.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(output, name), Buffer.from(r.data, 'base64')); }
(async () => { try {
  assert.equal(process.platform, 'win32');
  const speechWav = path.join(output, 'fake-microphone.wav');
  // Mid-command pauses must survive; the final pause gives completion a quiet
  // window before Chromium loops the fake microphone again.
  const sentence = '<speak version="1.0" xml:lang="en-US">Push to talk works. Show me the workspace. Hey Vibe.<break time="500ms"/>Open the project<break time="600ms"/>and run the tests.<break time="4s"/></speak>';
  const synthesis = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Speech;$s=New-Object System.Speech.Synthesis.SpeechSynthesizer;$f=New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000,[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,[System.Speech.AudioFormat.AudioChannel]::Mono);$s.SetOutputToWaveFile('${speechWav}',$f);$s.SpeakSsml('${sentence}');$s.Dispose()`],
    { windowsHide: true, encoding: 'utf8', timeout: 120000 });
  if (synthesis.status !== 0 || !fs.existsSync(speechWav)) throw Error(`Could not synthesize the fake microphone recording: ${synthesis.stderr || synthesis.status}`);
  const port = await new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });
  const env = { ...process.env, VIBE_SCREENSHOT_MODE: '1', VIBE_INTERNAL_SCREENSHOT: '0', VIBE_SCREENSHOT_USER_DATA: path.join(output, 'userData'), VIBE_AGENT_SHIM_BASE_DIR: path.join(output, 'shims'), CODEX_HOME: path.join(output, 'codex'), CLAUDE_CONFIG_DIR: path.join(output, 'claude'), XDG_CONFIG_HOME: path.join(output, 'config'), XDG_DATA_HOME: path.join(output, 'data') };
  for (const key of Object.keys(env)) if (/API_KEY|AUTH_TOKEN/.test(key) || ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL'].includes(key)) delete env[key];
  child = spawn(path.join(root, 'node_modules/electron/dist/electron.exe'), [entry, `--remote-debugging-port=${port}`, '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${speechWav}`], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = fs.createWriteStream(path.join(output, 'electron.log')); child.stdout.pipe(log); child.stderr.pipe(log);
  const pages = async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json());
  const page = await until(async () => (await pages()).find(p => p.type === 'page' && p.url.startsWith('file:') && !p.url.includes('surface=voice')), 'workspace');
  cdp = new Cdp(page.webSocketDebuggerUrl); await cdp.open();
  await until(() => cdp.eval('Boolean(window.vibe?.orchestrator && document.querySelector(".orchestrator-mic"))'), 'workspace UI');
  const cleanBoard = await cdp.eval('({navigation:!!document.querySelector(".session-navigation"),dock:!!document.querySelector(".orchestrator-dock"),tools:!!document.querySelector("[aria-label=\\"Open workspace tools\\"]")})');
  assert.equal(cleanBoard.navigation, false); assert.equal(cleanBoard.dock, false); assert.equal(cleanBoard.tools, true); record('clean-workspace', cleanBoard);
  await screenshot(cdp, 'workspace.png');
  await click('[aria-label="Open workspace tools"]'); await until(() => cdp.eval('Boolean(document.querySelector(".workspace-tools-heading"))'), 'tools dialog');
  await click('[aria-label="Close workspace tools"]'); assert.equal(await cdp.eval('Boolean(document.querySelector(".workspace-tools-heading"))'), false);
  await click('.orchestrator-mic'); await until(() => cdp.eval('Boolean(document.querySelector(".orchestrator-settings input[type=password]"))'), 'settings');
  async function fill(selector, value) { await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`); }
  await fill('.orchestrator-settings input[type=password]', 'fixture-no-real-key');
  await fill('input[list="orchestrator-models"]', 'fixture/relay');
  await click('.assistant-enable input');
  const consentDialog=await until(()=>events().find(e=>e.consentDialog)?.consentDialog,'first-use microphone consent dialog');
  assert.equal(consentDialog.title,'vibeTerminal');assert.match(consentDialog.message,/Allow vibeTerminal to use your microphone/);assert.deepEqual(consentDialog.buttons,['Allow microphone','Not now']);assert.equal(consentDialog.defaultId,1);assert.equal(consentDialog.cancelId,1);assert.equal(consentDialog.parentId,consentDialog.actualMainId);assert(consentDialog.parentId);
  assert.match(consentDialog.detail,/OpenRouter/);assert.match(consentDialog.detail,/background/);assert.equal(events().some(e=>e.nativeOptions),false);assert.equal(events().some(e=>e.payload?.microphoneReady),false);assert.equal((await cdp.eval('window.vibe.voice.getState()')).listening,false);
  record('first-use-consent-blocks-window-and-capture',consentDialog);
  fs.writeFileSync(consentResponseFile,JSON.stringify({response:0}));
  await until(async () => { const s = await cdp.eval('window.vibe.voice.getState()'); return s.listening && s.phase === 'listening' && events().some(e => e.payload?.microphoneReady && e.payload.captureToken === s.captureToken && e.value?.ok) && s; }, 'actual capture readiness', 45000);
  const ready = await cdp.eval('window.vibe.voice.getState()');
  assert(events().some(e => e.payload?.rendererReady && e.value?.ok)); assert(events().some(e => e.payload?.microphoneReady && e.payload.captureToken === ready.captureToken && e.value?.ok));
  record('renderer-capture-token-listening', ready);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(output,'userData','microphone-consent.json'),'utf8')),{version:1,granted:true});assert.equal(events().filter(e=>e.consentDialog).length,1);
  const saved = await cdp.eval('(()=>{const e=document.querySelector(".orchestrator-settings input[type=password]");return {disabled:e.disabled,value:e.value,placeholder:e.placeholder,color:getComputedStyle(e).color,background:getComputedStyle(e).backgroundColor};})()');
  assert.equal(saved.disabled, true); assert.equal(saved.value, ''); assert.equal(saved.placeholder, 'Saved securely'); record('saved-key-locked', saved);
  await screenshot(cdp, 'settings.png');
  const vp = await until(async () => (await pages()).find(p => p.url.includes('surface=voice')), 'voice renderer');
  voice = new Cdp(vp.webSocketDebuggerUrl); await voice.open();
  // Preserve actual AudioContext scheduling/end ACK, silence only the physical output.
  await voice.eval(`(()=>{const connect=AudioNode.prototype.connect;AudioNode.prototype.connect=function(destination,...args){if(destination instanceof AudioDestinationNode){const gain=this.context.createGain();gain.gain.value=0;connect.call(gain,destination);return connect.call(this,gain,...args);}return connect.call(this,destination,...args);};window.__qaSilentPlayback=true;window.__qaStoppedTracks=[];const stop=MediaStreamTrack.prototype.stop;MediaStreamTrack.prototype.stop=function(){const before=this.readyState;stop.call(this);window.__qaStoppedTracks.push({kind:this.kind,before,after:this.readyState});};})()`);
  await voice.eval(`(()=>{window.__qaVoiceAudio=[];window.__qaVoiceStates=[];window.vibe.voice.onAudio(({data,...chunk})=>window.__qaVoiceAudio.push({...chunk,bytes:data.length}));window.vibe.voice.onState(state=>window.__qaVoiceStates.push({phase:state.phase,reply:state.reply,replyId:state.replyId,transcript:state.transcript,recordingSource:state.recordingSource,recordingId:state.recordingId,handsFreeStatus:state.handsFreeStatus,finishHint:state.finishHint}));})()`);
  const native = await until(() => windows().find(w => w.url.includes('surface=voice') && !w.visible), 'hidden native audio renderer');
  assert.equal(native.bounds.width, 112); assert.equal(native.bounds.height, 112);
  const opts = events().find(e => e.nativeOptions).nativeOptions; assert.equal(opts.frame, false); assert.equal(opts.transparent, true); assert.equal(opts.backgroundThrottling, false); assert.equal(opts.alwaysOnTop,false); assert.equal(opts.focusable,false);
  assert.equal(await voice.eval('Boolean(document.querySelector(".voice-indicator,.voice-overlay,header"))'), false);
  await click('[aria-label="Close settings"]');
  const indicator = await until(()=>cdp.eval('(()=>{const e=document.querySelector(".voice-indicator");if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,inside:r.x>=0&&r.y>=0&&r.right<=innerWidth&&r.bottom<=innerHeight,background:getComputedStyle(e).backgroundColor};})()'),'main app microphone');
  assert.equal(indicator.width,112);assert.equal(indicator.height,112);assert.equal(indicator.inside,true);assert.equal(indicator.background,'rgba(0, 0, 0, 0)');
  const micShot=await cdp.send('Page.captureScreenshot',{format:'png',clip:{x:indicator.x,y:indicator.y,width:indicator.width,height:indicator.height,scale:1}});fs.writeFileSync(path.join(output,'microphone.png'),Buffer.from(micShot.data,'base64'));
  record('112-transparent-microphone-inside-app-hidden-native-audio', { indicator, ...native, options: opts });
  await click('[aria-label="Hide microphone indicator; keep listening"]');
  await until(() => cdp.eval('!document.querySelector(".voice-indicator")'), 'hidden in-app indicator'); assert.equal((await cdp.eval('window.vibe.voice.getState()')).listening, true);
  await click('[aria-label="Show microphone"]');
  await until(() => cdp.eval('Boolean(document.querySelector(".voice-indicator"))'), 'main app indicator restored');
  assert(windows().some(w=>w.id===native.id&&!w.visible&&w.webContentsId===native.webContentsId));
  fs.writeFileSync(commandFile, JSON.stringify({ closeVoice: true }));
  await until(() => !fs.existsSync(commandFile)&&windows().find(w => w.id === native.id && !w.visible), 'native audio close remains hidden'); assert.equal((await cdp.eval('window.vibe.voice.getState()')).listening, true); record('in-app-hide-show-native-close-preserves-listening', { id: native.id, webContentsId: native.webContentsId });
  const recording = wavFromSamples(Float32Array.from({ length: 8000 }, (_, i) => 0.1 * Math.sin(i * 2 * Math.PI * 440 / 16000))).toString('base64');
  const normal = await cdp.eval(`window.vibe.voice.sendAudio(${JSON.stringify({ audioBase64: recording, format: 'wav' })})`);
  assert.equal(normal.ok, true, JSON.stringify(normal));
  const normalReply = await until(() => voice.eval(`window.__qaVoiceStates.find(s=>s.phase==='speaking'&&s.reply==='Fixture text answer.')`), 'voice relay spoken reply');
  await until(() => events().some(e => e.payload?.playbackDone === normalReply.replyId && e.value?.ok), 'normal voice reply renderer ACK');
  const normalAudio = await voice.eval(`window.__qaVoiceAudio.filter(c=>c.replyId===${JSON.stringify(normalReply.replyId)})`);
  assert(normalAudio.some(c => c.bytes > 0 && c.sampleRate === 24000 && c.channels === 1 && c.format === 's16le' && !c.local));
  assert(normalAudio.some(c => c.done && !c.cancelled));
  assert.equal((await cdp.eval('window.vibe.voice.getState()')).transcript, 'hello');
  assert(events().some(e => e.speechRequest?.response_format === 'pcm' && e.speechRequest.input === 'Fixture text answer.'));
  record('wav-transcription-relay-pcm-reply-renderer-ack', { normal, normalReply, normalAudio });
  fs.writeFileSync(transcriptionFile, JSON.stringify({ text: '' }));
  const cloudBeforeEmpty = events().filter(e => /\/audio\/speech$|\/chat\/completions$/.test(e.request || '')).length;
  const empty = await cdp.eval(`window.vibe.voice.sendAudio(${JSON.stringify({ audioBase64: recording, format: 'wav' })})`);
  assert.equal(empty.ok, true, JSON.stringify(empty)); assert.equal(empty.status, 'empty'); assert.equal(empty.speech?.ok, true, JSON.stringify(empty));
  const emptyReply = await until(() => voice.eval(`window.__qaVoiceStates.find(s=>s.phase==='speaking'&&s.reply?.startsWith("I didn't catch that."))`), 'empty transcription spoken retry prompt');
  await until(() => events().some(e => e.payload?.playbackDone === emptyReply.replyId && e.value?.ok), 'local retry prompt renderer ACK');
  const emptyAudio = await voice.eval(`window.__qaVoiceAudio.filter(c=>c.replyId===${JSON.stringify(emptyReply.replyId)})`);
  assert(emptyAudio.some(c => c.local && c.bytes > 0 && c.format === 's16le'));
  assert(emptyAudio.some(c => c.local && c.done && !c.cancelled));
  assert.equal(events().filter(e => /\/audio\/speech$|\/chat\/completions$/.test(e.request || '')).length, cloudBeforeEmpty);
  record('empty-transcription-local-spoken-retry-renderer-ack-no-cloud-speech', { empty, emptyReply, chunks: emptyAudio.length });
  const space = type => cdp.send('Input.dispatchKeyEvent', { type, key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32, ...(type === 'keyDown' ? { text: ' ', unmodifiedText: ' ' } : {}) });
  await cdp.eval(`(()=>{const host=document.createElement('div');host.dataset.paneId='qa-pane';host.innerHTML='<textarea class="xterm-helper-textarea"></textarea>';document.body.appendChild(host);host.querySelector('textarea').focus();})()`);
  await space('keyDown'); await wait(500); await space('keyUp'); await wait(200);
  const guarded = await cdp.eval('window.vibe.voice.getState()');
  assert.equal(guarded.phase, 'listening', 'Space inside a terminal pane must never record');
  await cdp.eval(`document.querySelector('[data-pane-id=qa-pane]').remove();document.activeElement?.blur?.()`);
  record('space-inside-a-terminal-pane-never-records', guarded);
  fs.writeFileSync(transcriptionFile, JSON.stringify({ text: 'push to talk works' }));
  await cdp.eval(`(()=>{window.__qaPhases=[];window.vibe.voice.onState(state=>{if(window.__qaPhases.at(-1)!==state.phase)window.__qaPhases.push(state.phase);});})()`);
  await space('keyDown');
  await until(async () => (await cdp.eval('window.vibe.voice.getState()')).phase === 'recording', 'push-to-talk recording');
  await wait(1500);
  await space('keyUp');
  const held = await until(() => events().find(e => e.transcription === 'push to talk works'), 'push-to-talk transcription');
  assert(held.peak > 600, `The uploaded WAV must carry the fake microphone audio; peak was ${held.peak}`);
  assert(held.samples > 16000, `A 1.5 s hold plus its pre-roll must reach the cloud; got ${held.samples} samples`);
  const heldPhases = await cdp.eval('window.__qaPhases');
  assert.deepEqual(heldPhases.slice(0, 3), ['listening', 'recording', 'transcribing'], JSON.stringify(heldPhases));
  await until(() => voice.eval(`window.__qaVoiceStates.find(s=>s.transcript==='push to talk works')`), 'push-to-talk transcript in state');
  record('space-hold-records-live-microphone-and-uploads-it', { ...held, phases: heldPhases });
  await until(async () => (await cdp.eval('window.vibe.voice.getState()')).phase === 'listening', 'manual reply finished');
  fs.writeFileSync(transcriptionFile, JSON.stringify({ text: 'Hey Vibe open the project and run the tests' }));
  assert.equal((await cdp.eval('window.vibe.orchestrator.configure({handsFreeEnabled:true})')).ok, true);
  await until(async () => (await cdp.eval('window.vibe.voice.getState()')).handsFreeStatus === 'ready', 'native hands-free helpers ready', 20000);
  const automatic = await until(() => voice.eval(`window.__qaVoiceStates.find(s=>s.recordingSource==='wake')`), 'native wake starts recording from fake microphone', 30000);
  const status = await cdp.eval(`(()=>{const e=document.querySelector('.voice-status');const r=e.getBoundingClientRect();const style=getComputedStyle(e);return {text:e.textContent,width:r.width,height:r.height,visible:style.clipPath==='none'&&style.visibility!=='hidden',inside:r.x>=0&&r.y>=0&&r.right<=innerWidth&&r.bottom<=innerHeight};})()`);
  assert(status.visible && status.inside && status.width > 100 && status.height > 20, JSON.stringify(status));
  await screenshot(cdp, 'automatic-recording-status.png');
  record('visible-automatic-recording-status', status);
  const automaticTranscript = await until(() => voice.eval(`window.__qaVoiceStates.find(s=>s.transcript==='open the project and run the tests')`), 'automatic completion and wake-prefix removal', 30000);
  const automaticUpload = events().find(e => e.transcription === 'Hey Vibe open the project and run the tests');
  assert(automaticUpload?.peak > 600, 'Wake recording must contain microphone audio');
  record('native-wake-vad-completion-through-real-capture', { automatic, automaticTranscript, upload: automaticUpload });
  await until(async () => (await cdp.eval('window.vibe.voice.getState()')).phase === 'listening', 'automatic reply returns to wake listening');
  const nextRecording = await until(async () => { const s=await cdp.eval('window.vibe.voice.getState()');return s.phase==='recording'&&s.recordingSource==='wake'&&s.recordingId!==automatic.recordingId&&s; }, 'another native wake after the reply', 30000);
  const beforeSend = events().filter(e=>e.transcription).length;
  const point = await cdp.eval(`(()=>{const r=document.querySelector('.voice-mic').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});
  await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});
  await until(()=>events().filter(e=>e.transcription).length===beforeSend+1, 'click Send uploads automatic recording');
  assert(events().some(e=>e.channel==='voice:configure'&&e.payload?.finishRecording===nextRecording.recordingId&&e.value?.status==='sent'));
  record('repeat-wake-and-click-send-through-real-flush', { recordingId:nextRecording.recordingId });
  assert.equal((await cdp.eval('window.vibe.orchestrator.configure({handsFreeEnabled:false})')).ok, true);
  assert.equal((await cdp.eval('window.vibe.voice.getState()')).handsFreeStatus, 'off');
  assert.equal((await cdp.eval('window.vibe.orchestrator.setEnabled(false)')).ok, true);
  const stoppedTracks = await until(() => voice.eval('window.__qaStoppedTracks.some(t=>t.kind==="audio"&&t.before==="live"&&t.after==="ended")&&window.__qaStoppedTracks'), 'actual audio capture track stopped');
  const off = await cdp.eval('window.vibe.voice.getState()'); assert.equal(off.listening, false); assert.equal(off.phase, 'off'); record('off-tears-down-capture', { off, stoppedTracks });
  assert.equal((await cdp.eval('window.vibe.orchestrator.setEnabled(true)')).ok,true);
  assert.equal((await cdp.eval('window.vibe.voice.getState()')).phase,'listening');assert.equal(events().filter(e=>e.consentDialog).length,1);
  assert.equal((await cdp.eval('window.vibe.orchestrator.setEnabled(false)')).ok,true);
  record('saved-consent-reenable-does-not-prompt-again',{dialogCount:events().filter(e=>e.consentDialog).length});
  const beforeAck = events().filter(e => e.payload?.microphoneReady).length;
  const preview = await cdp.eval('window.vibe.voice.configure({preview:true})'); assert.equal(preview.ok, true, JSON.stringify(preview));
  assert(events().some(e => e.payload?.playbackDone)); assert.equal(events().filter(e => e.payload?.microphoneReady).length, beforeAck); assert.equal((await cdp.eval('window.vibe.voice.getState()')).listening, false); record('off-preview-real-silent-playback-ack', preview);
  fs.writeFileSync(failureFile, 'fail');
  const failed = await cdp.eval('window.vibe.voice.configure({preview:true})'); assert.equal(failed.ok, false); assert.equal(failed.operation, 'speech');
  const failureState = await cdp.eval('window.vibe.voice.getState()'); assert.equal(failureState.errorOperation, 'speech'); record('cloud-speech-failure-separate-stage', { failed, failureState });
  assert.equal(events().some(e=>e.unexpectedNativeAudioShow),false,'Native audio window must never be shown');
  result.pass = true;
} catch (e) { result.pass = false; result.error = e.stack; console.error(e.stack); process.exitCode = 1; }
finally { fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(result, null, 2)); cdp?.close(); voice?.close(); if (child?.pid) spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }); console.log(`Artifacts: ${output}`); } })();
