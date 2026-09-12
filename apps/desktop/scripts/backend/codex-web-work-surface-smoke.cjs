'use strict';
// Offline browser fixture for the actual Work selection controller. No account
// cookies, model inference, or user settings are used.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
const home = fs.mkdtempSync(path.join(root, '.tmp/codex-web-work-surface-'));
process.env.CODEX_CHATGPT_WEB_HOME = home;
const { selectAccountModel, accountChatUrl } = require('../../backend/codexWebModelDiscovery.cjs');
const { chromium } = require('../../vendor/codex-web/runtime/app/node_modules/playwright-core');
const { resolveLoginBrowser } = require('../../backend/codexWebBrowserLogin.cjs');
const models = [
  { slug: 'gpt-6-astra-wm', title: 'GPT-6 Astra', workMode: true },
  { slug: 'gpt-5.6-sol-wm', title: 'GPT-5.6 Sol', workMode: true },
  { slug: 'gpt-5-6-thinking', title: 'GPT-5.6 Sol', workMode: false },
].map(model => ({ ...model, reasoningType: 'reasoning', defaultEffort: 'medium', maxTokens: 100000, efforts: [
  { effort: 'low', webEffort: 'min' }, { effort: 'medium', webEffort: 'standard' },
  { effort: 'high', webEffort: 'extended' }, { effort: 'xhigh', webEffort: 'max' },
] }));
fs.writeFileSync(path.join(home, 'lina-account-models.json'), JSON.stringify({ version: 1, models }));
const fixture = `<header><div role="radiogroup" aria-label="Select chat surface">
  <button role="radio" aria-checked="true" id="chat">Chat</button><button role="radio" aria-checked="false" id="work">Work</button>
</div></header><main><form><div contenteditable="true" role="textbox" id="prompt-textarea"></div><button type="button" id="picker"></button></form></main>
<div role="menu" id="menu" style="display:none">
  <div role="menuitemcheckbox" id="fast" aria-checked="true">Enable fast mode</div>
  <div role="menuitem" id="power" tabindex="0">Power</div>
  <div role="menuitemradio" id="defaultModel" aria-checked="true">Default</div>
  <div role="menuitemradio" id="astra" aria-checked="false">GPT-6 Astra</div>
  <div role="menuitemradio" id="sol" aria-checked="false">GPT-5.6 Sol</div>
</div><script>
let chosen='GPT-5.6 Sol',effort=4,explicit=false;const labels=['Light','Medium','High','Extra High','Max','Ultra'];
window.actions=[];
function render(){picker.innerHTML='<span>'+chosen+'</span><span>'+labels[effort]+'</span>';}
work.onclick=()=>{chat.setAttribute('aria-checked','false');work.setAttribute('aria-checked','true');actions.push('work');};
picker.onclick=()=>{menu.style.display='block';picker.setAttribute('aria-expanded','true');};
for(const option of [astra,sol])option.onclick=()=>{chosen=option.textContent;explicit=true;defaultModel.setAttribute('aria-checked','false');astra.setAttribute('aria-checked',String(option===astra));sol.setAttribute('aria-checked',String(option===sol));actions.push('model:'+chosen);render();};
fast.onclick=()=>fast.setAttribute('aria-checked',String(fast.getAttribute('aria-checked')!=='true'));
power.onkeydown=event=>{if(!['ArrowLeft','ArrowRight'].includes(event.key))return;effort=Math.max(0,Math.min(5,effort+(event.key==='ArrowRight'?1:-1)));if(!explicit)chosen=effort<4?'GPT-5.6 Sol':'GPT-6 Astra';actions.push('effort');render();};
document.onkeydown=event=>{if(event.key==='Escape'){menu.style.display='none';picker.setAttribute('aria-expanded','false');}};
window.reset=()=>{explicit=false;chosen='GPT-5.6 Sol';effort=4;defaultModel.setAttribute('aria-checked','true');astra.setAttribute('aria-checked','false');sol.setAttribute('aria-checked','false');render();};
window.read=()=>({chosen,effort:labels[effort],work:work.getAttribute('aria-checked')==='true',fast:fast.getAttribute('aria-checked')==='true',actions:[...actions]});render();
</script>`;
(async () => {
  const browser = await chromium.launch({ executablePath: resolveLoginBrowser().executable, headless: true });
  try {
    const page = await browser.newPage();
    await page.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', body: fixture }));
    await selectAccountModel(page, 'chatgpt-account/gpt-6-astra-wm', 'high');
    assert.equal(new URL(page.url()).searchParams.has('temporary-chat'), false);
    let state = await page.evaluate(() => window.read());
    assert.equal(state.work, true); assert.equal(state.chosen, 'GPT-6 Astra'); assert.equal(state.effort, 'High'); assert.equal(state.fast, false);
    assert(state.actions.indexOf('work') < state.actions.indexOf('model:GPT-6 Astra'));
    assert(state.actions.indexOf('model:GPT-6 Astra') < state.actions.indexOf('effort'));
    await page.locator('#prompt-textarea').fill('Preserve this draft.');
    await page.evaluate(() => window.reset());
    const url = page.url();
    await selectAccountModel(page, 'chatgpt-account/gpt-6-astra-wm', 'medium', undefined, true);
    state = await page.evaluate(() => window.read());
    assert.equal(state.chosen, 'GPT-6 Astra'); assert.equal(state.effort, 'Medium');
    assert.equal(page.url(), url); assert.equal(await page.locator('#prompt-textarea').innerText(), 'Preserve this draft.');
    await page.goto('https://chatgpt.com/?temporary-chat=true&model=gpt-6-astra-wm');
    await assert.rejects(selectAccountModel(page, 'chatgpt-account/gpt-6-astra-wm', 'high', undefined, true), /model_surface_mismatch/);
    assert.equal(new URL(accountChatUrl('chatgpt-account/gpt-5-6-thinking')).searchParams.get('temporary-chat'), 'true');
    console.log(JSON.stringify({ passed: true, workSurface: true, exactModelAndEffort: true, retainedDraftPreserved: true, webRequests: 0 }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
