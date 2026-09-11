const path = require('node:path');
const fs = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');
const websiteRoot = path.resolve(__dirname, '..');
const appRoot = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(websiteRoot, '../desktop');
const out = path.join(websiteRoot, 'frontend/public/screenshots');
const fixture = process.argv[3] || 'split';
const scratch = path.join(websiteRoot, '.tmp', `app-capture-${fixture}-${Date.now()}`);
fs.mkdirSync(scratch, { recursive: true });
fs.mkdirSync(out, { recursive: true });
const filename = { split: 'workspace', 'fusion-builds': 'fusion', openfusion: 'open-fusion', orchestrator: 'orchestrator', 'voice-settings': 'voice-settings' }[fixture];
if (!filename) throw Error('Unknown fixture');
const demo = path.join(scratch, 'lina-demo');
fs.mkdirSync(demo, { recursive: true });
fs.writeFileSync(path.join(demo, 'package.json'), JSON.stringify({ name: 'lina-demo', private: true, scripts: { test: 'node --test workspace.test.cjs' } }, null, 2));
fs.writeFileSync(path.join(demo, 'workspace.test.cjs'), `const { test } = require('node:test');
const assert = require('node:assert/strict');
test('each session belongs to a project', () => assert.equal({ project: 'lina-demo' }.project, 'lina-demo'));
test('a board can hold several sessions', () => assert.equal(['shell', 'tests', 'server'].length, 3));
test('project paths stay separate', () => assert.notEqual('projects/web', 'projects/api'));
`);
fs.writeFileSync(path.join(demo, 'shell.cjs'), "console.log('LINA DEMO / PROJECT SHELL\\n\\nA real local terminal, inside Lina.\\n\\n  Project   lina-demo\\n  Runtime   ' + process.version + '\\n  Platform  ' + process.platform + '\\n\\nReady for your next command.');");
fs.writeFileSync(path.join(demo, 'files.cjs'), "console.log('PROJECT FILES\\n'); for (const file of require('fs').readdirSync('.').filter(file => !file.startsWith('.'))) console.log('  ' + file); console.log('\\nYour files. Your local tools.');");
fs.writeFileSync(path.join(demo, 'dev.cjs'), "const http=require('http'); const server=http.createServer((req,res)=>res.end('Hello from Lina')); server.listen(0,'127.0.0.1',()=>console.log('DEVELOPMENT SERVER\\n\\n  Local  http://127.0.0.1:'+server.address().port+'\\n\\nReady for requests.\\nPress Ctrl+C to stop.'));");
spawnSync('git', ['init', '--initial-branch=main', demo], { stdio: 'ignore', windowsHide: true });
const demoCommands = ['node shell.cjs', 'node --test workspace.test.cjs', 'node files.cjs', 'node dev.cjs'];
const demoSessions = ['Project shell', 'Tests', 'Project files', 'Development server'].map((name, index) => ({ id: `website-demo-${index}`, name, kind: 'terminal', command: `function prompt { 'lina-demo > ' }; $Host.UI.RawUI.WindowTitle = '${name}'; Clear-Host; ${demoCommands[index]}`, cwd: demo, createdAt: Date.now(), started: true, launchToken: 1, status: 'idle', attention: { state: 'none', unread: false }, layout: { x: index % 2 ? 50.5 : 0, y: index > 1 ? 340 : 0, w: 49.5, h: 330, unit: 'fluid' } }));
const demoWorkspace = [{ id: 'website-demo', name: 'lina-demo', path: demo, sessions: demoSessions }];
const entry = path.join(scratch, 'capture.cjs');
fs.writeFileSync(entry, `
const fs = require('node:fs');
const { app } = require('electron');
app.disableHardwareAcceleration();
app.setVersion(${JSON.stringify(require(path.join(appRoot, 'package.json')).version)});
if (${fixture === 'orchestrator'}) {
  const module = require(${JSON.stringify(path.join(appRoot,'backend/orchestrator.cjs'))});
  const create = module.createOrchestrator;
  module.createOrchestrator = options => create({...options, getSessions: async () => [
    ...await options.getSessions(),
    ...['Website','API','Documentation','Tests'].map((project,index) => ({id:'marketing-'+index,name:['Review the website','Build the API','Update the guides','Check the changes'][index],kind:['codex','claude','opencode','gemini'][index],cwd:require('node:path').join(${JSON.stringify(demo)},project),projectName:project,generation:'marketing-generation-'+index,started:true,status:['working','done','idle','waiting'][index]}))
  ]});
}
app.on('browser-window-created', (_, win) => {
  win.setContentSize(1440, 920);
  let seeded = false;
  win.webContents.on('console-message', (_, level, message) => console.log('renderer', level, message));
  win.webContents.on('did-fail-load', (_, code, message) => console.error('load', code, message));
  win.webContents.on('did-finish-load', async () => {
    try {
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        const length = await win.webContents.executeJavaScript('document.body.innerText.length');
        if (length > 200) break;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      await new Promise(resolve => setTimeout(resolve, 6000));
      if (${fixture === 'split'} && !seeded) {
        seeded = true;
        await win.webContents.executeJavaScript(${JSON.stringify(`localStorage.setItem('vibe-terminal:workspaces:v2', ${JSON.stringify(JSON.stringify(demoWorkspace))}); localStorage.setItem('vibe-terminal:active-workspace:v1', 'website-demo'); localStorage.setItem('vibe-terminal:active-view:v1', 'project'); localStorage.setItem('vibe-terminal:sidebar-width:v1', '230');`)});
        win.webContents.reload();
        return;
      }
      if (${fixture === 'orchestrator'}) {
        await win.webContents.executeJavaScript("document.querySelector('.orchestrator-nav-button').click(); window.vibe.orchestrator.dispatch({kind:'list_sessions'});");
        await new Promise(resolve => setTimeout(resolve, 1800));
      }
      if (${fixture === 'voice-settings'}) {
        // Chromium's native top-layer dialog needs a visible compositor, even
        // for a webContents capture. Keep the isolated fixture transparent and unfocused.
        win.setOpacity(0);
        win.setSkipTaskbar(true);
        win.showInactive();
        await win.webContents.executeJavaScript("window.vibe.orchestrator.dispatch({kind:'list_sessions'});");
        await win.webContents.executeJavaScript("document.querySelector('.workspace-settings-button').click();");
        const settingsDeadline = Date.now() + 12000;
        while (Date.now() < settingsDeadline) {
          if (await win.webContents.executeJavaScript("Boolean(document.querySelector('.orchestrator-settings input'))")) break;
          await new Promise(resolve => setTimeout(resolve, 250));
        }
        if (!await win.webContents.executeJavaScript("Boolean(document.querySelector('.orchestrator-settings input'))")) throw Error('Voice settings did not finish loading');
        await new Promise(resolve => setTimeout(resolve, 700));
      }
      const shot = await win.webContents.capturePage();
      fs.writeFileSync(${JSON.stringify(path.join(out, `${filename}.png`))}, shot.toPNG());
      console.log('Captured ${filename}.png');
      app.quit();
    } catch (error) { console.error(error); app.exit(1); }
  });
});
require(${JSON.stringify(path.join(appRoot, 'backend/main.cjs'))});
setTimeout(() => { console.error('Capture timeout'); app.exit(1); }, 45000);
`);
const env = { ...process.env, VIBE_SCREENSHOT_MODE: '1', VIBE_SCREENSHOT_HIDDEN: '1', VIBE_INTERNAL_SCREENSHOT: '0', VIBE_SCREENSHOT_USER_DATA: path.join(scratch, 'profile'), VIBE_AGENT_SHIM_BASE_DIR: path.join(scratch, 'shims'), VIBE_SCREENSHOT_FIXTURE_CWD: demo, VIBE_SCREENSHOT_SEED_SPLIT: '0', VIBE_SCREENSHOT_SEED_FUSION_BUILDS: fixture === 'fusion-builds' ? '1' : '0', VIBE_SCREENSHOT_SEED_OPEN_FUSION: fixture === 'openfusion' ? '1' : '0' };
for (const key of Object.keys(env)) if (/API_KEY|AUTH_TOKEN/.test(key) || ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'VIBE_SCREENSHOT_PATH'].includes(key)) delete env[key];
const child = spawn(path.join(appRoot, 'node_modules/electron/dist/electron.exe'), [entry, '--disable-gpu', '--force-device-scale-factor=1'], { cwd: appRoot, env, windowsHide: true, stdio: 'inherit' });
child.on('exit', code => { process.exitCode = code || 0; });
