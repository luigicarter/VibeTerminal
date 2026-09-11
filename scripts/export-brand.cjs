const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const repoRoot = path.resolve(__dirname, '..');
const root = path.join(repoRoot, 'apps/website');
const desktop = process.argv[2] ? path.resolve(process.argv[2]) : path.join(repoRoot, 'apps/desktop');
const brand = path.join(repoRoot, 'packages/brand');
const scratch = path.join(root, '.tmp/brand-export');
fs.mkdirSync(scratch, { recursive: true });
const svg = fs.readFileSync(path.join(brand, 'lina-mark.svg'), 'utf8');
const entry = path.join(scratch, 'render.cjs');
fs.writeFileSync(entry, `
const fs = require('node:fs');
const path = require('node:path');
const {app, BrowserWindow} = require('electron');
app.disableHardwareAcceleration();
app.setPath('userData', ${JSON.stringify(path.join(scratch,'profile'))});
app.whenReady().then(async () => {
  const win = new BrowserWindow({width:1024,height:1024,frame:false,show:false,transparent:true,webPreferences:{offscreen:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  const html = '<!doctype html><html><style>html,body{margin:0;width:1024px;height:1024px;background:transparent}svg{display:block;width:1024px;height:1024px}</style><body>' + ${JSON.stringify(svg)} + '</body></html>';
  await win.loadURL('data:text/html;base64,' + Buffer.from(html).toString('base64'));
  await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await new Promise(resolve => setTimeout(resolve, 250));
  const vector = await win.webContents.capturePage();
  const sizes = [16,24,32,48,64,128,256];
  const pngs = sizes.map(size => vector.resize({width:size,height:size,quality:'best'}).toPNG());
  const header = Buffer.alloc(6 + sizes.length * 16);
  header.writeUInt16LE(1,2);header.writeUInt16LE(sizes.length,4);
  let offset = header.length;
  sizes.forEach((size,index)=>{const at=6+index*16;header[at]=size===256?0:size;header[at+1]=size===256?0:size;header.writeUInt16LE(1,at+4);header.writeUInt16LE(32,at+6);header.writeUInt32LE(pngs[index].length,at+8);header.writeUInt32LE(offset,at+12);offset+=pngs[index].length;});
  const ico = Buffer.concat([header,...pngs]);
  const png = vector.resize({width:512,height:512,quality:'best'}).toPNG();
  for (const target of ${JSON.stringify([path.join(brand,'lina-logo.png'),path.join(desktop,'frontend/assets/lina-logo.png'),path.join(desktop,'frontend/assets/vibeterminal-logo.png'),path.join(desktop,'frontend/assets/vibeterminal-logo-source.png'),path.join(root,'frontend/public/vibeterminal-logo.png'),path.join(root,'frontend/public/vibeterminal-logo-source.png')])}) fs.writeFileSync(target,png);
  for (const target of ${JSON.stringify([path.join(brand,'lina-logo.ico'),path.join(desktop,'frontend/assets/lina-logo.ico'),path.join(desktop,'frontend/assets/vibeterminal-logo.ico'),path.join(root,'frontend/public/favicon.ico')])}) fs.writeFileSync(target,ico);
  fs.writeFileSync(${JSON.stringify(path.join(desktop,'frontend/assets/lina-logo.svg'))},${JSON.stringify(svg)});
  console.log('Exported Lina logo: SVG, 512px PNG, and 7-resolution Windows ICO.');
  app.quit();
}).catch(error=>{console.error(error);app.exit(1);});
setTimeout(()=>app.exit(1),15000);
`);
const env = {...process.env};delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(path.join(desktop,'node_modules/electron/dist/electron.exe'),[entry,'--force-device-scale-factor=1','--disable-gpu'],{cwd:desktop,env,stdio:'inherit',windowsHide:true});
child.on('exit',code=>{
  if (code) { process.exitCode = code; return; }
  const sync = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/sync-brand.cjs')], { stdio: 'inherit', windowsHide: true });
  process.exitCode = sync.status || (sync.error ? 1 : 0);
});
