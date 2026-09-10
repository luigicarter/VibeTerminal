// Runs the actual TerminalPane scroll handlers with the installed browser xterm.
// No model, PTY, user profile, or production app is started.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');

if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const run = spawnSync(require('electron'), [__filename, ...process.argv.slice(2)], { env, windowsHide: true, stdio: 'inherit' });
  process.exit(run.status ?? 1);
}

const { app, BrowserWindow } = require('electron');
const ts = require('typescript');
const output = path.join(root, '.tmp', 'terminal-scroll-smoke', `${Date.now()}-${process.pid}`);
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'userData'));
const pane = process.argv.includes('--baseline')
  ? require('node:child_process').execFileSync('git', ['show', 'HEAD:frontend/components/TerminalPane.tsx'], { cwd: root, encoding: 'utf8', windowsHide: true })
  : fs.readFileSync(path.join(root, 'frontend/components/TerminalPane.tsx'), 'utf8');
function slice(start, end) {
  const from = pane.indexOf(start), to = pane.indexOf(end, from);
  if (from < 0 || to < 0) throw Error(`Missing handler boundary: ${start}`);
  return pane.slice(from, to);
}
const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const modules = ['terminalOutput', 'terminalWheel', 'terminalScrollback'].map(name => {
  return `Object.assign(window, (() => {const exports = {}; ${compile(fs.readFileSync(path.join(root, `frontend/${name}.ts`), 'utf8'))}; return exports;})());`;
}).join('\n');
const handlers = compile(
  slice('  function syncFollowTail()', '  function scheduleFitAndResize()') +
  slice('    const terminalHost = containerRef.current;', '    // Frame coalescing') +
  slice('    const wheelAccumulator:', '    // Ungrouped panes')
);
const url = file => require('node:url').pathToFileURL(path.join(root, file)).href;
const html = `<!doctype html><link rel="stylesheet" href="${url('node_modules/@xterm/xterm/css/xterm.css')}">
<style>body{margin:0}.terminal-fit-host{width:640px;height:360px}.xterm{height:100%}</style>
<script src="${url('node_modules/@xterm/xterm/lib/xterm.js')}"></script><script>${modules}
window.makeFixture = async () => {
  const host = document.createElement('div');host.className='terminal-fit-host';document.body.append(host);
  const terminal = new Terminal({cols:70,rows:20,scrollback:5000,fontSize:13});terminal.open(host);
  preserveTerminalScrollback(terminal);
  const replay=createTerminalReplay(terminal,()=>terminal.scrollToBottom());
  const followTailRef={current:true}, terminalPointerRef={current:false}, terminalRef={current:terminal}, containerRef={current:host};
  const terminalExitedRef={current:false},createdRef={current:true},session={id:'fixture'},runtimeScope=()=>({});
  const sgrMouse=createSgrMouseTracker(),inputs=[];
  window.vibe={terminal:{input:(_id,data)=>inputs.push(data)}};
  terminal.onData(data=>inputs.push(data));
  terminal.onBinary(data=>inputs.push(data));
  ${handlers}
  const pause = ms => new Promise(r=>setTimeout(r,ms));
  const write=async data=>{sgrMouse.push(data);await new Promise(r=>terminal.write(data,r));await pause(60)};
  await write(Array.from({length:150},(_,i)=>'scroll fixture line '+i+'\\r\\n').join(''));
  const wheel=async (deltaY,options={})=>{const rect=host.querySelector('.xterm-screen').getBoundingClientRect();host.querySelector('.xterm-screen').dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,clientX:rect.left+50,clientY:rect.top+50,deltaY,...options}));await pause(90)};
  const state=()=>({y:terminal.buffer.active.viewportY,base:terminal.buffer.active.baseY,follow:followTailRef.current,scrollTop:host.querySelector('.xterm-viewport').scrollTop,scrollHeight:host.querySelector('.xterm-viewport').scrollHeight,inputs:inputs.join('')});
  return {terminal,host,inputs,write,wheel,state,pause,followTailRef,terminalExitedRef,replay};
};</script>`;
const file = path.join(output, 'fixture.html');fs.writeFileSync(file, html);
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { offscreen: true, backgroundThrottling: false, nodeIntegration: false, contextIsolation: true } });
  const checks=[];
  try {
    await window.loadFile(file);
    const result = await window.webContents.executeJavaScript(`(async()=>{
      const f=await makeFixture(),checks=[];await f.pause(300);
      const check=(name,pass)=>{checks.push({name,pass,state:f.state()});};
      await f.wheel(-120);check('normal wheel scrolls up',f.state().y<f.state().base);
      await f.write('new output\\r\\n');check('output preserves user scroll',f.state().y<f.state().base);
      f.terminal.scrollToBottom();await f.pause(60);
      // A wheel dispatched from RAF reaches Chromium's scroll event in a later frame.
      await new Promise(resolve=>requestAnimationFrame(()=>{f.wheel(-120).then(resolve)}));
      check('wheel during animation frame stays scrolled',f.state().y<f.state().base);
      f.terminal.scrollToBottom();await f.pause(60);
      // Exercise the ordering contract: native scroll delivery may lag the
      // capture listener's RAF (e.g. compositor/renderer scheduling).
      const viewport=f.host.querySelector('.xterm-viewport');let deferred=false;
      const delayScroll=event=>{if(deferred)return;deferred=true;event.stopImmediatePropagation();setTimeout(()=>viewport.dispatchEvent(new Event('scroll')),35)};
      viewport.addEventListener('scroll',delayScroll,true);
      await f.wheel(-120);viewport.removeEventListener('scroll',delayScroll,true);
      check('delayed viewport scroll preserves user follow state',f.state().y<f.state().base&&!f.state().follow);
      f.terminal.scrollToBottom();await f.pause(60);await f.wheel(-120,{shiftKey:true});
      check('shift wheel scrolls ordinary terminal history',f.state().y<f.state().base);
      await f.write('\\x1b[?1000h\\x1b[?1006h');
      f.terminal.scrollToBottom();await f.pause(60);f.inputs.length=0;
      await f.wheel(-120);check('live TUI receives SGR wheel',f.inputs.join('').includes('\\x1b[<64;'));
      f.inputs.length=0;const before=f.state().y;await f.wheel(-120,{shiftKey:true});
      check('shift wheel reaches local history with mouse tracking',f.state().y<before&&f.inputs.length===0);
      f.terminal.scrollToBottom();await f.pause(60);
      viewport.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));
      window.dispatchEvent(new PointerEvent('pointermove',{buttons:1}));
      viewport.scrollTop-=150;await f.pause(60);window.dispatchEvent(new PointerEvent('pointerup'));
      await f.pause(60);check('scrollbar gesture enters local history',f.state().y<f.state().base);
      f.inputs.length=0;
      const scrolled=f.state().y;await f.wheel(-120);
      check('wheel continues local history after scrollbar scroll',f.state().y<scrolled&&f.inputs.length===0);
      let previous=f.state().y;await f.wheel(-3,{deltaMode:1});
      check('local history supports line deltas',f.state().y===previous-3&&f.inputs.length===0);
      previous=f.state().y;await f.wheel(-1,{deltaMode:2});
      check('local history supports page deltas',f.state().y===previous-f.terminal.rows&&f.inputs.length===0);
      previous=f.state().y;for(let i=0;i<8;i++)await f.wheel(-2);
      check('small trackpad deltas accumulate into local scroll',f.state().y<previous&&f.inputs.length===0);
      await f.wheel(10000);check('wheel down reaches tail and rearms following',f.state().y===f.state().base&&f.state().follow);
      await f.write('following output\\r\\n');check('tail follows subsequent output',f.state().y===f.state().base);
      f.terminalExitedRef.current=true;f.inputs.length=0;await f.wheel(-120);
      check('exited TUI history scrolls despite retained mouse mode',f.state().y<f.state().base&&f.inputs.length===0);
      f.terminalExitedRef.current=false;
      await f.write('\\x1b[?1000l');
      await f.write(Array.from({length:6500},(_,i)=>'long-running line '+i+'\\r\\n').join(''));
      f.terminal.scrollToBottom();await f.pause(60);
      check('overflow retains exactly 5000 scrollback rows',f.state().base===5000);
      await f.wheel(-120);check('wheel works after the buffer fills',f.state().y<f.state().base);
      await f.write('new rows after overflow\\r\\n'.repeat(20));
      const afterOverflowOutput=f.state().y;await f.wheel(-120);
      check('FIFO eviction during output keeps history scrollable',f.state().base===5000&&f.state().y<afterOverflowOutput);
      const retained=f.terminal.buffer.normal.getLine(0).translateToString(true);
      await f.write('\\x1b[3');await f.write('J\\x1b[H\\x1b[2Jredrawn screen');
      check('split erase-saved-lines redraw retains history',f.state().base===5000&&f.terminal.buffer.normal.getLine(0).translateToString(true)===retained);
      const beforeClearWheel=f.state().y;await f.wheel(-120);
      check('wheel works after a full-screen redraw',f.state().y<beforeClearWheel);
      await f.write('\\x1b[?1000h\\x1b[?1006h');
      f.terminal.scrollToBottom();await f.pause(60);f.inputs.length=0;
      await f.wheel(-120,{shiftKey:true});
      check('shift wheel reaches full history with TUI mouse tracking',f.state().y<f.state().base&&f.inputs.length===0);
      f.terminal.write('queued stale line\\r\\n'.repeat(500));
      f.replay.restore({data:'restored history\\r\\n'.repeat(40),cols:70,rows:20});
      await f.write('live after replay');
      const restoredText=Array.from({length:f.terminal.buffer.normal.length},(_,i)=>f.terminal.buffer.normal.getLine(i).translateToString(true)).join('\\n');
      check('replay replaces queued old output before subsequent live output',!restoredText.includes('queued stale')&&restoredText.includes('restored history')&&restoredText.includes('live after replay'));
      await f.write('\\x1b[3J');
      check('scrollback protection survives snapshot reset',f.state().base>0);
      await f.write('\\x1b[?1000h\\x1b[?1006h');
      await f.write('\\x1b[?1049h');f.inputs.length=0;
      await f.wheel(-120);check('alternate screen keeps native mouse reporting',f.inputs.join('').includes('\\x1b[<64;'));
      await f.write('\\x1b[?1000l');f.inputs.length=0;
      await f.wheel(-120);check('alternate screen without mouse sends cursor keys',/^\\x1b(?:\\[|O)A/.test(f.inputs.join('')));
      await f.write('\\x1b[?1000h\\x1b[?1006l');f.inputs.length=0;
      await f.wheel(-120);check('legacy mouse encoding stays native',f.inputs.join('').startsWith('\\x1b[M'));
      return checks;
    })()`);
    checks.push(...result);for(const check of checks)console.log(JSON.stringify(check));
    if(checks.some(check=>!check.pass))process.exitCode=1;
  } catch(error) {console.error(error);process.exitCode=1;}
  finally {fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(checks,null,2));console.log('Artifacts: '+output);window.destroy();app.exit(process.exitCode||0);}
}).catch(error=>{console.error(error);app.exit(1);});
