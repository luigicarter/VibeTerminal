'use strict';
// Run with the prepared Bun. Exercises the patched browser code on an offline DOM fixture.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { resolveLoginBrowser } = require('../../backend/codexWebBrowserLogin.cjs');
const root = path.resolve(__dirname, '../..');
const output = fs.mkdtempSync(path.join(root, '.tmp', 'web-model-binding-'));
process.env.CODEX_HOME = path.join(output, 'codex');
process.env.CODEX_CHATGPT_WEB_HOME = path.join(output, 'bridge');
process.env.LINA_CODEX_WEB_HOST_MODULE = 'offline-fixture';
async function main() {
  const TOML = require('@iarna/toml');
  require('../../backend/codexWebSupport.cjs').syncCapabilities(path.join(output, 'empty-global'), process.env.CODEX_HOME);
  const { installCompatibilityV1Features } = await import(pathToFileURL(path.join(root, '.tmp/codex-web-build/source/src/codex-integration-document.ts')).href);
  const config = fs.readFileSync(path.join(process.env.CODEX_HOME, 'config.toml'), 'utf8');
  assert.equal(TOML.parse(installCompatibilityV1Features(config).text).features.multi_agent, true, 'The actual upstream setup writer must accept a fresh Lina config.');
  const { chromium } = require('../../vendor/codex-web/runtime/app/node_modules/playwright-core');
  const browser = await chromium.launch({ executablePath: resolveLoginBrowser().executable, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<button id="model" data-testid="model-switcher-dropdown-button" aria-haspopup="menu">GPT-6 Astra Pro</button>
      <div id="models" role="menu" style="display:none">
        <button role="menuitemradio" aria-checked="true" id="pro">GPT-6 Astra Pro</button>
        <button role="menuitemradio" aria-checked="false" id="astra">GPT-6 Astra</button>
      </div>
      <form><div contenteditable="true" id="prompt-textarea">Message</div>
        <button type="button" id="effort" aria-haspopup="menu" data-tone="neutral">High</button>
        <div id="efforts" role="menu" style="display:none"><div data-model-reasoning-effort-slider style="width:180px;height:30px"><span role="slider" aria-valuemin="0" aria-valuemax="4" aria-valuenow="2">High</span></div></div>
      </form>
      <script>
      model.onclick=()=>{setTimeout(()=>models.style.display='block',75)};
      for (const option of [pro,astra]) option.onclick=()=>{pro.setAttribute('aria-checked','false');astra.setAttribute('aria-checked','false');option.setAttribute('aria-checked','true');model.textContent=option.textContent;models.style.display='none'};
      effort.onclick=()=>{efforts.style.display='block';effort.setAttribute('aria-expanded','true')};
      document.onkeydown=event=>{if(event.key==='Escape'){models.style.display='none';efforts.style.display='none';effort.setAttribute('aria-expanded','false')}};
      </script>`);
    const session = await import(pathToFileURL(path.join(root, '.tmp/codex-web-build/source/src/chatgpt-session.ts')).href);
    const capabilities = await session.detectChatGptAccountCapabilities(page, { selectorTimeoutMs: 5000 });
    assert.equal(capabilities.modelLabel, 'GPT-6 Astra'); assert.equal(capabilities.modelEffort, 'high');
    const binding = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_CHATGPT_WEB_HOME, 'lina-model.json'), 'utf8'));
    assert.equal(binding.label, 'GPT-6 Astra');
    const { ChatGptBrowserWorker } = await import(pathToFileURL(path.join(root, '.tmp/codex-web-build/source/src/adapters/chatgpt-web/browser-worker.ts')).href);
    await page.evaluate(() => { model.textContent='GPT-6 Astra Pro'; pro.setAttribute('aria-checked','true'); astra.setAttribute('aria-checked','false'); });
    const owner = { activeComposer: async () => { throw new Error('VERIFIED_MODEL'); } };
    await assert.rejects(ChatGptBrowserWorker.prototype.selectModelAndEffort.call(owner, page, 'gpt-5.6-sol', 'high', { localToolsEnabled: false, solAvailable: true, proAvailable: true }), /VERIFIED_MODEL/);
    assert.equal(await page.locator('#model').innerText(), 'GPT-6 Astra', 'Astra Pro is not silently accepted as Astra.');
    await page.evaluate(() => { model.textContent='GPT-6 Astra Pro'; astra.disabled=true; });
    await assert.rejects(ChatGptBrowserWorker.prototype.selectModelAndEffort.call(owner, page, 'gpt-5.6-sol', 'high', { localToolsEnabled: false, solAvailable: true, proAvailable: true }), /no longer available/);
    await page.evaluate(() => {
      model.removeAttribute('data-testid'); model.style.display = 'none'; astra.disabled = false;
      effort.textContent = 'GPT-6 Astra Pro';
      effort.onclick = () => { setTimeout(() => models.style.display = 'block', 75); efforts.style.display = 'block'; effort.setAttribute('aria-expanded', 'true'); };
      for (const option of [pro, astra]) option.onclick = () => { pro.setAttribute('aria-checked', 'false'); astra.setAttribute('aria-checked', 'false'); option.setAttribute('aria-checked', 'true'); effort.textContent = option.textContent; models.style.display = 'none'; };
    });
    const updatedControls = await session.detectChatGptAccountCapabilities(page, { selectorTimeoutMs: 5000 });
    assert.equal(updatedControls.modelLabel, 'GPT-6 Astra', 'The current composer picker works without the legacy model-switcher test id.');
    console.log('Patched Web probe and per-turn Astra selection passed (offline browser fixture; no account/model request).');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
