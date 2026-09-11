// Exercise the real React board in Chromium, including the frame in which a
// pointer update must paint. No user profile, terminal process, or agent runs.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');

if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const run = spawnSync(require('electron'), [__filename, ...process.argv.slice(2)], {
    env, windowsHide: true, stdio: 'inherit'
  });
  process.exit(run.status ?? 1);
}

const { app, BrowserWindow } = require('electron');
const output = path.join(root, '.tmp', 'tiled-board-drag-smoke', `${Date.now()}-${process.pid}`);
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'userData'));

async function run() {
  const entry = `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import TiledBoard from './frontend/components/TiledBoard';
    import './frontend/styles.css';
    const initial = {
      A: {x:100/12,y:100,w:560/12,h:320,unit:'fluid'},
      B: {x:900/12,y:700,w:280/12,h:170,unit:'fluid'}
    };
    window.commits = [];
    window.arranging = false;
    function Fixture() {
      const [layouts,setLayouts] = useState(initial);
      const [tick,setTick] = useState(0);
      window.rerender = () => setTick(t => t+1);
      window.replaceLayouts = setLayouts;
      return <div data-tick={tick} style={{width:1220,height:900,overflow:'auto'}}>
        <TiledBoard items={Object.entries(layouts).map(([id,layout]) => ({id,layout,
          content:<div className="terminal-pane"><div className="pane-drag-zone pane-title">{id}</div>
            <div className="terminal-surface">{Array.from({length:100},(_,i)=><div key={i}>Terminal output {i}</div>)}</div>
          </div>
        }))} onArrangeChange={value => {window.arranging=value;}}
          onLayoutCommit={changes => {window.commits.push(changes);setLayouts(old => ({...old,...changes}));}} />
      </div>;
    }
    createRoot(document.getElementById('root')).render(<Fixture/>);
  `;
  await require('esbuild').build({
    stdin: { contents: entry, resolveDir: root, loader: 'tsx' },
    bundle: true, outfile: path.join(output, 'fixture.js'),
    define: { 'process.env.NODE_ENV': '"production"' }, jsx: 'automatic'
  });
  const file = path.join(output, 'fixture.html');
  fs.writeFileSync(file, '<!doctype html><link rel="stylesheet" href="fixture.css"><style>html,body,#root{margin:0;width:100%;height:100%}</style><div id="root"></div><script src="fixture.js"></script>');
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1280, height: 1000,
    webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true }
  });
  try {
    await win.loadFile(file);
    const checks = await win.webContents.executeJavaScript(`(async () => {
      const pause = ms => new Promise(resolve => setTimeout(resolve,ms));
      const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
      const board = () => document.querySelector('.tiled-board');
      const pane = () => document.querySelector('[data-session-id="A"]');
      const rect = () => {
        const r=pane().getBoundingClientRect(), b=board().getBoundingClientRect();
        return {left:r.left-b.left-10,top:r.top-b.top,width:r.width,height:r.height};
      };
      const near = (a,b) => Object.keys(b).every(k => Math.abs(a[k]-b[k]) < 0.1);
      const checks=[];
      const check=(name,pass,detail) => checks.push({name,pass,detail});
      const pointer = (target,type,x,y,extra={}) => target.dispatchEvent(new PointerEvent(type,{
        bubbles:true,cancelable:true,pointerId:41,isPrimary:true,button:0,
        buttons:type==='pointerup'?0:1,clientX:x,clientY:y,...extra
      }));
      const begin = async (edge) => {
        const target=pane().querySelector(edge ? '.pane-resize-edge-'+edge : '.pane-title');
        const r=target.getBoundingClientRect(), p={x:r.left+r.width/2,y:r.top+r.height/2};
        pointer(target,'pointerdown',p.x,p.y);
        await pause(30);
        return p;
      };
      await pause(300);
      const start=rect(), p=await begin();
      // All raw events in one frame should be replaced by the newest position.
      for(let i=1;i<=6;i++) pointer(window,'pointermove',p.x+i*10,p.y+i*10);
      await frame();
      check('latest pointer position paints in the scheduled frame',near(rect(),{...start,left:start.left+60,top:start.top+60}),rect());
      check('drag previews do not persist layouts',window.commits.length===0);
      await pause(30);
      window.rerender();
      await pause(30);
      check('parent render retains live preview',near(rect(),{...start,left:start.left+60,top:start.top+60}),rect());
      const samples=[];
      for(let i=7;i<=16;i++) {
        pointer(window,'pointermove',p.x+i*10,p.y+i*10);
        await frame();
        samples.push({step:i,actual:rect(),expected:{left:start.left+i*10,top:start.top+i*10}});
      }
      check('continuous movement has no React render frame backlog',samples.every(s=>near(s.actual,s.expected)),samples);
      // Release must consume the final position even before a queued RAF runs.
      pointer(window,'pointermove',p.x+190,p.y+190);
      pointer(window,'pointerup',p.x+200,p.y+200);
      await pause(250);
      const committed=rect();
      check('release flushes final coordinates once',window.commits.length===1 && near(committed,{...start,left:start.left+200,top:start.top+200}),committed);
      check('arrangement finishes after release',!window.arranging);
      const cancelStart=await begin();
      pointer(window,'pointermove',cancelStart.x+60,cancelStart.y+60);
      await frame();
      pointer(window,'pointermove',cancelStart.x+90,cancelStart.y+90);
      window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
      await pause(80);
      check('escape restores committed layout and discards pending motion',near(rect(),committed) && window.commits.length===1 && !window.arranging,rect());
      const resizeStart=rect(), resize=await begin('se');
      pointer(window,'pointermove',resize.x+50,resize.y+45);
      await frame();
      check('resize paints in the scheduled frame',near(rect(),{...resizeStart,width:resizeStart.width+50,height:resizeStart.height+45}),rect());
      pointer(window,'pointerup',resize.x+60,resize.y+55);
      await pause(250);
      check('resize release matches final pointer',near(rect(),{...resizeStart,width:resizeStart.width+60,height:resizeStart.height+55}) && window.commits.length===2,rect());
      const cancelResize=await begin('se');
      const beforeCancel=rect();
      pointer(window,'pointermove',cancelResize.x+20,cancelResize.y+20);
      await frame();
      pointer(window,'pointercancel',cancelResize.x+20,cancelResize.y+20);
      await pause(60);
      check('pointer cancellation restores resize',near(rect(),beforeCancel) && window.commits.length===2,rect());
      return checks;
    })()`);
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(checks, null, 2));
    for (const check of checks) console.log(`${check.pass ? 'PASS' : 'FAIL'} ${check.name}${check.pass ? '' : ': '+JSON.stringify(check.detail)}`);
    if (checks.some(check => !check.pass)) process.exitCode = 1;
  } finally {
    win.destroy();
    console.log(`Artifacts: ${output}`);
    app.exit(process.exitCode || 0);
  }
}
run().catch(error => { console.error(error); app.exit(1); });
