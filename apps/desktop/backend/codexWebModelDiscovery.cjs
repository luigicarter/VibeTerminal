'use strict';
const fs = require('node:fs');
const path = require('node:path');
const ACCOUNT_PREFIX = 'chatgpt-account/';
const effortIds = { min: 'low', standard: 'medium', extended: 'high', max: 'xhigh' };
const pageSelections = new WeakMap();
const navigatedModels = new WeakMap();
function noteAccountNavigation(page, id) { navigatedModels.set(page, accountModel(id).slug); }

// Native Codex displays model IDs in /model and the status line. Keep those
// readable while retaining the exact account slug solely for Web routing.
function presentAccountCatalog(catalog) {
  const used = new Set();
  const models = catalog.models.map(model => {
    const title = model.title.replace(/[\x00-\x1f\x7f]/g, '').trim();
    const mode = model.workMode ? 'Work' : /-instant$/.test(model.slug) ? 'Instant' : /-thinking$/.test(model.slug) ? 'Thinking' : model.reasoningType === 'auto' ? 'Auto' : model.reasoningType === 'pro' ? 'Pro' : 'Chat';
    const base = title.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-|-$/g, '');
    const suffix = mode === 'Work' || base.endsWith('-' + mode.toLowerCase()) ? '' : '-' + mode.toLowerCase();
    let id = base + suffix;
    if (!/^[a-z0-9][a-z0-9.-]{0,100}$/.test(id) || used.has(id)) id = 'web-' + model.slug;
    if (used.has(id)) throw new Error('web_model_catalog_unavailable');
    used.add(id);
    const label = title.replace(/\s+/g, '-') + (suffix ? ' (' + mode + ')' : '');
    return { ...model, id, label, mode, aliases: ['chatgpt-web/' + model.slug] };
  });
  const priority = model => model.workMode ? /astra/i.test(model.title) ? 0 : /sol/i.test(model.title) ? 1 : /terra/i.test(model.title) ? 2 : /luna/i.test(model.title) ? 3 : 4 : 5;
  models.sort((a, b) => priority(a) - priority(b));
  return { ...catalog, models };
}
function refreshNativeModelNames(rows) {
  if (!Array.isArray(rows) || !rows.some(row => /^chatgpt-web\/gpt/.test(row?.slug || ''))) return rows;
  const legacy = rows.filter(row => /^chatgpt-web\/gpt/.test(row?.slug || ''));
  const display = presentAccountCatalog({ models: legacy.map(row => ({
    slug: row.slug.slice('chatgpt-web/'.length), title: String(row.display_name || row.slug).replace(/ · (?:Work|Instant|Thinking|Auto)$/, ''),
    workMode: /-wm$/.test(row.slug), reasoningType: /-pro$/.test(row.slug) ? 'pro' : / · Auto$/.test(row.display_name || '') ? 'auto' : 'reasoning',
  })) });
  return [...display.models.map(model => {
    const row = legacy.find(row => row.slug === model.aliases[0]);
    return { ...row, slug: model.id, display_name: model.label, description: `${model.label} · ChatGPT Web ${model.mode}`, _lina_web_slug: model.slug, _lina_web_aliases: model.aliases };
  }), ...rows.filter(row => !legacy.includes(row))];
}
function filterNativeModelPicker(rows) {
  if (!Array.isArray(rows)) return rows;
  const details = rows.map(row => {
    const id = row?.slug ?? row?.id;
    const slug = row?._lina_web_slug || (id?.startsWith('chatgpt-web/') ? id.slice('chatgpt-web/'.length) : '');
    if (!slug || row.hidden === true || (row.visibility === 'hide' && row._lina_web_picker_hidden !== true)) return null;
    const work = row._lina_web_work_mode === true || /-wm$/.test(slug);
    const pro = row._lina_web_reasoning_type === 'pro' || /-pro$/.test(slug);
    const nonThinking = /-instant$/.test(slug) || /-auto$/.test(id) || /(?:\(Auto\)| · Auto)$/.test(row.display_name || '') || ['none', 'auto'].includes(row._lina_web_reasoning_type);
    const thinking = !nonThinking && (work || pro || /-thinking$/.test(slug) || row._lina_web_reasoning_type === 'reasoning' || ['medium', 'high', 'xhigh', 'max', 'ultra'].includes(row.default_reasoning_level));
    return { thinking };
  });
  let changed = false;
  const filtered = rows.map((row, index) => {
    const detail = details[index];
    if (!detail) return row;
    // A Work listing does not prove that the service runs that named model.
    // Keep its separate Thinking route available for an explicit selection.
    const hidden = !detail.thinking;
    const visibility = hidden ? 'hide' : 'list';
    if (row.visibility === visibility && (row._lina_web_picker_hidden === true) === hidden) return row;
    changed = true;
    const result = { ...row, visibility };
    if (hidden) result._lina_web_picker_hidden = true;
    else delete result._lina_web_picker_hidden;
    return result;
  });
  return changed ? filtered : rows;
}

// Runs in Lina's owned ChatGPT page. Credentials remain inside that page and
// only model metadata crosses back to the application.
async function inspectAccountModels(page) {
  return page.evaluate(async () => {
    if (location.origin !== 'https://chatgpt.com') return { status: 0, models: [] };
    const sessionResponse = await fetch('/api/auth/session', { credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(8000) });
    if (!sessionResponse.ok) return { status: sessionResponse.status, models: [] };
    const session = await sessionResponse.json();
    if (typeof session.accessToken !== 'string') return { status: 401, models: [] };
    const response = await fetch('/backend-api/models', { credentials: 'include', headers: { Authorization: 'Bearer ' + session.accessToken }, signal: AbortSignal.timeout(10000) });
    if (!response.ok) return { status: response.status, models: [] };
    const payload = await response.json();
    const rows = Array.isArray(payload.models) ? payload.models : [];
    return { status: response.status, defaultModel: payload.default_model_slug, categories: payload.categories, versions: payload.versions, groups: payload.internal_groups, models: rows.slice(0, 100).map(row => ({
      id: typeof row.slug === 'string' ? row.slug.slice(0, 120) : '',
      title: typeof row.title === 'string' ? row.title.slice(0, 120) : '',
      description: typeof row.description === 'string' ? row.description.slice(0, 220) : '',
      fields: Object.keys(row).slice(0, 35),
      maxTokens: row.max_tokens, thinkingEfforts: row.thinking_efforts, configurableEffort: row.configurable_thinking_effort,
      reasoningType: row.reasoning_type, workMode: row.is_work_mode_model, tags: row.tags,
      ...(typeof row.enabled === 'boolean' ? { enabled: row.enabled } : {}),
      ...(typeof row.is_available === 'boolean' ? { available: row.is_available } : {}),
    })) };
  });
}
function normalizeAccountCatalog(payload) {
  if (payload?.status === 401) throw new Error('authentication_required');
  if (payload?.status !== 200 || !Array.isArray(payload.models)) throw new Error('web_model_catalog_unavailable');
  const versions = (Array.isArray(payload.versions) ? payload.versions : []).filter(version => version.enabled === true);
  const allowed = new Set(versions.flatMap(version => version.slugs || []));
  for (const category of Array.isArray(payload.categories) ? payload.categories : []) for (const id of [category.default_model, ...(category.supported_models || [])]) if (typeof id === 'string') allowed.add(id);
  const seen = new Set();
  const models = payload.models.filter(model => {
    if (!/^[a-z0-9][a-z0-9.-]{0,100}$/.test(model.id || '') || typeof model.title !== 'string' || !model.title.trim() || seen.has(model.id) || model.enabled === false || model.available === false) return false;
    if (!model.workMode && !allowed.has(model.id)) return false;
    seen.add(model.id); return true;
  }).map(model => {
    const efforts = (Array.isArray(model.thinkingEfforts) ? model.thinkingEfforts : []).filter(item => effortIds[item.thinking_effort]).map(item => ({ effort: effortIds[item.thinking_effort], webEffort: item.thinking_effort, description: String(item.short_label || item.full_label || item.thinking_effort).slice(0, 80) }));
    if (!efforts.length) efforts.push({ effort: model.reasoningType === 'reasoning' ? 'medium' : 'low', webEffort: null, description: 'Default' });
    const suffix = model.workMode ? (/astra/i.test(model.title) ? '' : ' · Work') : /-instant$/.test(model.id) && !/instant/i.test(model.title) ? ' · Instant' : /-thinking$/.test(model.id) && !/thinking/i.test(model.title) ? ' · Thinking' : model.reasoningType === 'auto' ? ' · Auto' : '';
    const presets = versions.flatMap(version => (version.intelligence_presets || []).map((preset, index) => ({ ...preset, index, count: version.intelligence_presets.length, version: version.id }))).filter(preset => preset.model_slug === model.id && preset.preset_type === 'available');
    const title = model.title.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 120);
    return { slug: model.id, id: 'chatgpt-web/' + model.id, title, label: title + suffix, workMode: model.workMode === true,
      maxTokens: Number.isSafeInteger(model.maxTokens) && model.maxTokens > 0 ? model.maxTokens : 100000,
      reasoningType: model.reasoningType, efforts, defaultEffort: efforts.find(effort => effort.webEffort === 'standard')?.effort || efforts[0].effort, presets };
  });
  if (!models.length) throw new Error('web_model_catalog_unavailable');
  const priority = model => /\bastra\b/i.test(model.title) ? 0 : model.slug === payload.defaultModel ? 1 : 2;
  models.sort((left, right) => priority(left) - priority(right));
  return presentAccountCatalog({ version: 1, fetchedAt: new Date().toISOString(), defaultModel: payload.defaultModel, models });
}
function catalogFile() {
  const home = process.env.CODEX_CHATGPT_WEB_HOME;
  if (!home) throw new Error('web_model_catalog_unavailable');
  return path.join(home, 'lina-account-models.json');
}
function saveAccountCatalog(payload) {
  const catalog = normalizeAccountCatalog(payload), file = catalogFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(catalog), { mode: 0o600 }); fs.renameSync(temporary, file);
  return catalog;
}
function readAccountCatalog() {
  const value = JSON.parse(fs.readFileSync(catalogFile(), 'utf8'));
  if (value.version !== 1 || !Array.isArray(value.models)) throw new Error('web_model_catalog_unavailable');
  return presentAccountCatalog(value);
}
function accountModel(id) {
  const slug = id.startsWith(ACCOUNT_PREFIX) ? id.slice(ACCOUNT_PREFIX.length) : id.replace(/^chatgpt-web\//, '');
  const model = readAccountCatalog().models.find(model => model.slug === slug || model.id === id || model.aliases.includes(id));
  if (!model) throw new Error('model_unavailable');
  return model;
}
function accountMode(id, reasoning, capabilities) {
  const model = accountModel(id), effort = reasoning || model.defaultEffort;
  if (!model.efforts.some(item => item.effort === effort)) throw new Error('model_effort_unavailable');
  return { modelId: id, effort, displayLabel: model.label, uiEffortIndex: null, thinkEnabled: false, localTools: capabilities.localToolsEnabled };
}
function accountSelection(id, reasoning) {
  if (typeof id !== 'string' || !id.startsWith(ACCOUNT_PREFIX)) return null;
  const model = accountModel(id), effort = reasoning || model.defaultEffort;
  if (!model.efforts.some(item => item.effort === effort)) throw new Error('model_effort_unavailable');
  return { model: model.id, name: model.title, mode: model.mode, reasoning_effort: effort };
}
function accountRoutes() {
  return readAccountCatalog().models.map(model => ({ slug: model.id, displayName: model.label, description: `ChatGPT Web · ${model.label}`, interactionMode: 'automatic', backendModel: ACCOUNT_PREFIX + model.slug, codexEffort: model.defaultEffort, adapterEffort: model.defaultEffort, requiresPro: false }));
}
function resolveAccountRoute(id) {
  const models = readAccountCatalog().models;
  const model = models.find(model => model.id === id || model.aliases.includes(id));
  return model ? accountRoutes().find(route => route.slug === model.id) : undefined;
}
function neutralInstructions(value) {
  if (typeof value === 'string') return value.replace(/^You are Codex, (?:an agent|a coding agent) based on [A-Za-z0-9][A-Za-z0-9 .-]{0,50}?\.(?=\s|$)/gm, 'You are Codex, a coding assistant running in Lina Terminal.');
  if (Array.isArray(value)) return value.map(neutralInstructions);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, neutralInstructions(child)]));
  return value;
}
function accountCatalogRow(row, route) {
  const result = neutralInstructions(row);
  if (!route.backendModel.startsWith(ACCOUNT_PREFIX)) return result;
  const model = accountModel(route.backendModel);
  result.default_reasoning_level = model.defaultEffort;
  result.supported_reasoning_levels = model.efforts.map(item => ({ effort: item.effort, description: item.description }));
  return result;
}
function modelContextLimits(id) {
  const model = accountModel(id), contextWindow = Math.min(model.maxTokens, 103000);
  return { contextWindow, effectiveContextWindowPercent: 90, autoCompactTokenLimit: Math.floor(contextWindow * 0.85) };
}
function buildNativeCatalog(template, catalog = readAccountCatalog()) {
  return { models: filterNativeModelPicker(presentAccountCatalog(catalog).models.map((model, index) => {
    const contextWindow = Math.min(model.maxTokens, 103000);
    const row = { ...neutralInstructions(template), slug: model.id, display_name: model.label, description: `${model.label} · ChatGPT Web ${model.mode}`,
      _lina_web_slug: model.slug, _lina_web_aliases: model.aliases,
      _lina_web_work_mode: model.workMode, _lina_web_reasoning_type: model.reasoningType,
      visibility: 'list', supported_in_api: true, priority: index, input_modalities: ['text', 'image'], tool_mode: null, upgrade: null,
      multi_agent_version: 'v1', default_reasoning_level: model.defaultEffort,
      supported_reasoning_levels: model.efforts.map(item => ({ effort: item.effort, description: item.description })),
      context_window: contextWindow, max_context_window: contextWindow, effective_context_window_percent: 90, auto_compact_token_limit: Math.floor(contextWindow * 0.85),
      additional_speed_tiers: [], service_tiers: [], default_service_tier: null };
    if (model.workMode) row.description += ' · saved in ChatGPT';
    delete row.comp_hash; delete row.availability_nux; return row;
  })) };
}
function responseModelMetadata(text) {
  const models = new Set(); let visited = 0;
  const add = value => { if (typeof value === 'string' && /^[a-z0-9][a-z0-9.-]{0,100}$/i.test(value)) models.add(value); };
  const visit = (value, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 16 || ++visited > 100000) return;
    if (Array.isArray(value)) { for (const child of value) visit(child, depth + 1); return; }
    const pointer = value.p ?? value.path;
    if (typeof pointer === 'string' && /\/(?:model_slug|model_id|model_name|default_model_slug)$/.test(pointer)) add(value.v ?? value.value);
    for (const [key, child] of Object.entries(value)) {
      if (['model_slug', 'model_id', 'model_name', 'default_model_slug'].includes(key)) add(child);
      if (typeof child === 'object') visit(child, depth + 1);
    }
  };
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    try { visit(JSON.parse(line.slice(5).trim())); } catch {}
  }
  return [...models];
}
async function bindAccountSelection(page, id, reasoning) {
  const model = accountModel(id), selectedEffort = model.efforts.find(item => item.effort === (reasoning || model.defaultEffort));
  if (!selectedEffort) throw new Error('model_effort_unavailable');
  let selection = pageSelections.get(page);
  if (!selection) {
    selection = { slug: null, expected: model.slug, verified: false, error: null, verifier: await require('./codexWebModelVerification.cjs').createResponseVerifier(page) };
    pageSelections.set(page, selection);
    await page.route('**/backend-api/**', async route => {
      const request = route.request(), url = new URL(request.url());
      if (request.method() !== 'POST' || !/\/(?:f\/)?conversation$/.test(url.pathname)) return route.continue();
      let body; try { body = request.postDataJSON(); } catch {}
      if (body?.model !== selection.expected) {
        selection.error = 'model_selection_failed';
        try { fs.writeFileSync(path.join(path.dirname(catalogFile()), 'lina-model-selection-error.json'), JSON.stringify({ time: new Date().toISOString(), expected: selection.expected, actual: /^[a-z0-9][a-z0-9.-]{0,100}$/.test(body?.model || '') ? body.model : null }), { mode: 0o600 }); } catch {}
        return route.abort('failed');
      }
      if (selection.workMode && body.history_and_training_disabled === true) {
        selection.error = 'model_surface_mismatch'; return route.abort('failed');
      }
      if (selection.expectedEffort && body.thinking_effort !== selection.expectedEffort) {
        selection.error = 'model_effort_unavailable'; return route.abort('failed');
      }
      selection.verified = true;
      const file = path.join(path.dirname(catalogFile()), 'lina-last-model-request.json');
      const receipt = { requestId: require('node:crypto').randomUUID(), time: new Date().toISOString(), model: selection.expected, effort: selection.expectedEffort || null, surface: selection.workMode ? 'work' : 'chat', temporary: body.history_and_training_disabled === true, verified: true, requestVerified: true, responseVerified: false, responseModels: [] };
      selection.receipt = receipt;
      try { fs.writeFileSync(file, JSON.stringify(selection.receipt), { mode: 0o600 }); }
      catch { selection.error = 'storage_failed'; return route.abort('failed'); }
      const requestedModel = accountModel(ACCOUNT_PREFIX + selection.expected);
      const accepted = responseModelSlugs(requestedModel);
      selection.verifier.begin(request, slug => accepted.has(slug), evidence => {
        Object.assign(receipt, evidence);
        // The shared latest-receipt file must not be overwritten by a slower
        // response belonging to a different request or pane.
        try {
          const latest = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (latest.requestId === receipt.requestId) fs.writeFileSync(file, JSON.stringify(receipt), { mode: 0o600 });
        } catch { selection.error = 'storage_failed'; }
      });
      return route.continue();
    });
  }
  selection.expected = model.slug; selection.expectedEffort = selectedEffort.webEffort; selection.workMode = model.workMode; selection.error = null;
  return { model, selectedEffort, selection };
}
async function selectWorkModel(page, model, selectedEffort, preserveConversation) {
  if (new URL(page.url()).searchParams.get('temporary-chat') === 'true') throw new Error('model_surface_mismatch');
  if (!preserveConversation) {
    const work = page.getByRole('radio', { name: 'Work', exact: true });
    await work.waitFor({ state: 'visible', timeout: 15000 });
    if (await work.getAttribute('aria-checked') !== 'true') await work.click();
    await page.waitForFunction(() => Array.from(document.querySelectorAll('[role="radio"][aria-checked="true"]')).some(node => node.textContent?.trim() === 'Work'), undefined, { timeout: 5000 });
  }
  const composer = page.locator('#prompt-textarea,[data-testid="prompt-textarea"]').filter({ visible: true }).last();
  const form = composer.locator('xpath=ancestor::form[1]');
  const picker = form.getByRole('button', { name: /^(?:GPT[ -]|Select model|Select effort)/ }).filter({ visible: true }).last();
  await picker.click({ timeout: 10000 });
  const choice = page.getByRole('menuitemradio', { name: model.title, exact: true }).filter({ visible: true }).last();
  await choice.waitFor({ state: 'visible', timeout: 10000 });
  if (!await choice.isEnabled()) throw new Error('model_unavailable');
  // The Work radio is a custom clickable div. Its explicit selection replaces
  // the default Power ladder, which can switch models when changing effort.
  if (await choice.getAttribute('aria-checked') !== 'true') await choice.dispatchEvent('click');
  await page.waitForFunction(title => Array.from(document.querySelectorAll('[role="menuitemradio"]')).some(node => node.textContent?.trim() === title && node.getAttribute('aria-checked') === 'true'), model.title, { timeout: 5000 });
  const fast = page.getByRole('menuitemcheckbox', { name: 'Enable fast mode', exact: true }).filter({ visible: true });
  if (await fast.count() && await fast.getAttribute('aria-checked') === 'true') await fast.dispatchEvent('click');
  const labels = { low: 'Light', medium: 'Medium', high: 'High', xhigh: 'Extra High' };
  const index = ['low', 'medium', 'high', 'xhigh'].indexOf(selectedEffort.effort);
  if (index < 0) throw new Error('model_effort_unavailable');
  const power = page.getByRole('menuitem', { name: 'Power', exact: true }).filter({ visible: true }).last();
  // Work's explicit model ladder adds Max/Ultra after the four account levels.
  // Start at its left bound instead of interpreting the default-model ladder.
  for (let step = 0; step < 8; step++) await power.press('ArrowLeft');
  for (let step = 0; step < index; step++) await power.press('ArrowRight');
  await page.keyboard.press('Escape');
  const expected = (model.title + labels[selectedEffort.effort]).replace(/\s+/g, '');
  await page.waitForFunction(label => Array.from(document.querySelectorAll('main form button')).some(node => node.textContent?.replace(/\s+/g, '') === label), expected, { timeout: 5000 });
}
async function selectAccountModel(page, id, reasoning, activateMenu, preserveConversation = false) {
  const { model, selectedEffort, selection } = await bindAccountSelection(page, id, reasoning);
  await page.setViewportSize({ width: 1280, height: 900 });
  const current = new URL(page.url());
  if (current.origin === 'https://chatgpt.com' && navigatedModels.get(page) === model.slug) selection.slug = model.slug;
  navigatedModels.delete(page);
  if (preserveConversation && current.origin !== 'https://chatgpt.com') throw new Error('model_selection_failed');
  if (preserveConversation) selection.slug = model.slug;
  if (current.origin === 'https://chatgpt.com' && current.searchParams.get('model') === model.slug) selection.slug = model.slug;
  if (selection.slug !== model.slug) {
    await page.goto(accountChatUrl(id), { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.locator('#prompt-textarea,[data-testid="prompt-textarea"],[contenteditable="true"][data-lexical-editor="true"]').filter({ visible: true }).last().waitFor({ state: 'visible', timeout: 20000 });
    selection.slug = model.slug;
  }
  if (model.workMode) return selectWorkModel(page, model, selectedEffort, preserveConversation);
  if (!selectedEffort.webEffort) return;
  const composer = page.locator('#prompt-textarea,[data-testid="prompt-textarea"],[contenteditable="true"][data-lexical-editor="true"]').filter({ visible: true }).last();
  const control = composer.locator('xpath=ancestor::form[1]').locator('button[aria-haspopup="menu"][data-tone="neutral"],button[data-testid="model-switcher-dropdown-button"][aria-haspopup="menu"]').last();
  const activation = await activateMenu(page, control);
  const slider = activation.slider;
  await slider.waitFor({ state: 'attached', timeout: 10000 });
  const min = Number(await slider.getAttribute('aria-valuemin')), max = Number(await slider.getAttribute('aria-valuemax'));
  let index;
  if (model.workMode || max - min + 1 === model.efforts.length) index = model.efforts.indexOf(selectedEffort);
  else index = model.presets.find(preset => preset.count === max - min + 1 && (preset.thinking_effort || null) === selectedEffort.webEffort)?.index;
  if (!Number.isInteger(index) && model.reasoningType === 'pro') index = model.presets.find(preset => preset.count === max - min + 1)?.index;
  if (!Number.isInteger(index) || index < 0 || min + index > max) throw new Error('model_effort_unavailable');
  const target = min + index, owner = slider.locator('xpath=ancestor::*[@role="menuitem"][1]');
  for (let step = 0; step < 8; step++) {
    const current = Number(await slider.getAttribute('aria-valuenow'));
    if (current === target) { await page.keyboard.press('Escape'); return; }
    await owner.press(current < target ? 'ArrowRight' : 'ArrowLeft');
    await page.waitForFunction(({ selector, current }) => Number(document.querySelector(selector)?.getAttribute('aria-valuenow')) !== current, { selector: '[data-model-reasoning-effort-slider] [role="slider"]', current }, { timeout: 3000 });
  }
  throw new Error('model_effort_unavailable');
}
function assertAccountSelection(page) {
  const failure = pageSelections.get(page)?.error;
  if (failure) throw new Error(failure);
  pageSelections.get(page)?.verifier.isVerified();
}
function responseModelSlugs(model) {
  const slugs = new Set([model.slug, model.id]);
  // Observed service metadata pairs this resolved alias with model_slug
  // gpt-5-6-thinking. It remains confined to the same approved model family.
  if (slugs.has('gpt-5-6-thinking')) slugs.add('gpt-5-6-auto-thinking');
  return slugs;
}
function accountResponseVerified(page) { return pageSelections.get(page)?.verifier.isVerified() || false; }
async function requireAccountResponse(page, modelId) {
  if (!modelId.startsWith(ACCOUNT_PREFIX)) return;
  const verifier = pageSelections.get(page)?.verifier;
  if (!verifier) throw new Error('model_response_unverified');
  await verifier.verify();
}
function accountChatUrl(id) { const model = accountModel(id); return 'https://chatgpt.com/?' + (model.workMode ? '' : 'temporary-chat=true&') + 'model=' + encodeURIComponent(model.slug); }
module.exports = { ACCOUNT_PREFIX, inspectAccountModels, normalizeAccountCatalog, presentAccountCatalog, refreshNativeModelNames, filterNativeModelPicker, saveAccountCatalog, readAccountCatalog, accountModel, accountMode, accountSelection, accountRoutes, resolveAccountRoute, accountCatalogRow, neutralInstructions, modelContextLimits, bindAccountSelection, selectWorkModel, selectAccountModel, assertAccountSelection, responseModelMetadata, responseModelSlugs, accountResponseVerified, requireAccountResponse, buildNativeCatalog, accountChatUrl, noteAccountNavigation };
