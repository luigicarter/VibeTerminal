"use strict";
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const root = path.resolve(__dirname, "../..");
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
if (!process.versions.electron) {
  const output = path.join(root, ".tmp", "fusion-menus-smoke", `${Date.now()}`);
  fs.mkdirSync(output, { recursive: true });
  require("esbuild").buildSync({ entryPoints: [path.join(__dirname, "fusion-menu-fixture.tsx")], bundle: true,
    outfile: path.join(output, "fixture.js"), platform: "browser", format: "iife", jsx: "automatic",
    loader: { ".png": "dataurl", ".svg": "dataurl", ".woff2": "dataurl" }, define: { "process.env.NODE_ENV": '"test"' } });
  fs.writeFileSync(path.join(output, "index.html"), '<html><head><link rel="stylesheet" href="fixture.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require("node:child_process").spawn(require("electron"), [__filename, output], { env, windowsHide: true, stdio: "inherit" });
  const timer = setTimeout(() => { child.kill(); process.exitCode = 1; }, 60000);
  child.on("exit", code => { clearTimeout(timer); process.exitCode = code || 0; });
} else {
  const { app, BrowserWindow } = require("electron");
  app.disableHardwareAcceleration();
  const output = process.argv[2]; app.setPath("userData", path.join(output, "userData"));
  app.whenReady().then(async () => {
    const window = new BrowserWindow({ show: false, width: 1000, height: 820, webPreferences: { backgroundThrottling: false } });
    const errors = [];
    window.webContents.on("console-message", (_e, level, message) => { if (level >= 3) errors.push(message); });
    const run = code => window.webContents.executeJavaScript(code);
    const until = async (code, label) => { for (let i = 0; i < 80; i++) { if (await run(code)) return; await wait(50); } throw Error(`Timeout: ${label}; ${errors.join("\n")}`); };
    const fill = async value => { await run(`(()=>{const e=document.querySelector('textarea');e.focus();Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`); await wait(50); };
    const key = async keyCode => { window.webContents.sendInputEvent({ type: "keyDown", keyCode }); window.webContents.sendInputEvent({ type: "keyUp", keyCode }); await wait(70); };
    const pick = async text => { const found = await run(`(()=>{const e=[...document.querySelectorAll('.fusion-slash-item')].find(e=>e.innerText.includes(${JSON.stringify(text)}));if(!e)return false;e.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));return true;})()`); assert(found, `Missing row ${text}`); await wait(80); };
    const text = () => run("document.querySelector('.fusion-command-palette')?.innerText || ''");
    const capture = async name => { await wait(250); fs.writeFileSync(path.join(output, name + ".png"), (await window.webContents.capturePage()).toPNG()); };
    try {
      await window.loadFile(path.join(output, "index.html")); await until("!!document.querySelector('textarea')", "pane");
      await fill("/"); assert.match(await text(), /Models & reasoning/i); await capture("fusion-commands");
      await fill("/reasoning"); assert.match(await text(), /\/effort/);
      await fill("/zzzz-no-match"); assert.match(await text(), /No matches/); await key("Enter"); assert.equal(await run("qa.sends.length"), 0);
      await fill("/fast "); assert.match(await text(), /Planner — On/); await key("End"); assert.equal(await run("document.querySelector('[role=option][aria-selected=true]')?.textContent.includes('Executor — On')"), true);
      await key("Escape"); await fill("/executor-model"); await key("Enter"); await pick("Codex");
      assert.match(await text(), /GPT-6 Astra/); await capture("fusion-models");
      await run("document.querySelector('[aria-label=\"Refresh models\"]').click()"); await wait(80); assert(await run("qa.refreshes>0"));
      await key("Escape"); await key("Escape"); await key("Escape");
      await fill("Draft to preserve"); await run("document.querySelector('.fusion-command-trigger').click()"); await wait(50); await key("Escape");
      assert.equal(await run("document.querySelector('textarea').value"), "Draft to preserve");
      await fill("/resume"); await key("Enter"); await until("!!document.querySelector('.fusion-slash-item')", "saved chats");
      assert.equal(await run("document.querySelector('[aria-selected=true]').textContent.includes('Saved chat 1')"), true);
      await pick("more"); assert.match(await text(), /Saved chat 47/);
      await run("qa.setMode('openfusion')"); await wait(150); await fill("/"); await capture("openfusion-commands");
      await fill("/brain-model"); await key("Enter"); await until("document.querySelector('.fusion-command-palette')?.innerText.includes('OpenAI')", "providers");
      assert.match(await text(), /Current model/i); await pick("OpenAI");
      assert.equal(await run("document.querySelector('[role=option]')?.textContent.includes('Model 40')"), true);
      const settings = await run("qa.settings.length"); await key("Enter"); assert.equal(await run("qa.settings.length"), settings, "Current model must not trigger settings/restart");
      await fill("/brain-model"); await key("Enter"); await pick("OpenAI"); await pick("Show more"); assert.match(await text(), /Model 46/);
      await capture("openfusion-models");
      await fill("no-such-model"); assert.doesNotMatch(await text(), /Loading/);
      await key("Escape"); await key("Escape"); await fill("/connect"); await key("Enter"); await fill("unknown-provider");
      assert.doesNotMatch(await text(), /attempt anyway|Connect 'unknown-provider'/);
      await key("Escape"); await key("Escape"); await run("qa.empty=true"); await fill("/disconnect"); await key("Enter"); await wait(100);
      assert.match(await text(), /No matches/); await key("Down"); await key("Enter"); assert.equal(await run("qa.sends.length"), 0);
      window.setContentSize(520, 640); await run("document.querySelector('.fusion-command-trigger').click()"); await wait(100); await capture("openfusion-compact");
      const bounds = await run("(()=>{const p=document.querySelector('.fusion-command-palette').getBoundingClientRect();return {left:p.left,right:p.right,top:p.top,bottom:p.bottom,w:innerWidth,h:innerHeight}})()");
      assert(bounds.left >= 0 && bounds.right <= bounds.w && bounds.top >= 0 && bounds.bottom <= bounds.h, JSON.stringify(bounds));
      window.setContentSize(520, 380); await wait(200); await capture("openfusion-short-pane");
      assert(await run("(()=>{const p=document.querySelector('.fusion-command-palette').getBoundingClientRect(),c=document.querySelector('textarea').getBoundingClientRect();return p.top>=0 && p.bottom<=innerHeight && c.bottom<=innerHeight})()"), "Menu and composer fit a short pane");
      await run("qa.setMode('fusion')"); await wait(100); await fill("Keep this draft");
      await run("document.querySelector('.oc-prompt-model').click()"); await wait(100);
      assert.equal(await run("document.querySelector('textarea').value"), "", "Model chip opens an unfiltered picker");
      await run("document.querySelector('[aria-label=\"Close menu\"]').click()"); await wait(100);
      assert.equal(await run("document.querySelector('textarea').value"), "Keep this draft");
      await run("qa.setMode('openfusion');qa.empty=false"); await wait(100); await fill("Open Fusion draft");
      await run("document.querySelector('.oc-prompt-model').click()"); await wait(100); await pick("Custom model id");
      assert.equal(await run("document.querySelector('textarea').value"), "/brain-model ", "Custom ID input is not overwritten by the preserved draft");
      await fill("/brain-model openai/model-8"); await key("Enter");
      assert.equal(await run("document.querySelector('textarea').value"), "Open Fusion draft");
      await run("qa.setMode('fusion')"); await wait(100);
      await run("qa.failed=true;qa.setMode('openfusion')"); await wait(100); await fill("/brain-model"); await key("Enter"); await wait(100);
      assert.match(await text(), /Fixture catalog unavailable/); assert.doesNotMatch(await text(), /loading/i);
      await run("qa.failed=false;document.querySelector('[aria-label=\"Refresh models\"]').click()"); await wait(100);
      assert.match(await text(), /OpenAI/);
      assert.deepEqual(errors, []);
      fs.writeFileSync(path.join(output, "result.json"), JSON.stringify({ ok: true, bounds, modelTurnsTested: false }, null, 2));
      console.log(`Fusion and Open Fusion menu smoke passed. Artifacts: ${output}`); app.quit();
    } catch (error) { console.error(error); console.error(errors); await capture("failure").catch(() => {}); console.error(await run("document.body.innerText").catch(() => "Renderer unavailable")); console.error(`Artifacts: ${output}`); app.exit(1); }
  });
}
