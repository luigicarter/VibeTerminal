'use strict';
const fs = require('node:fs');
const path = require('node:path');
function patchUpstream(root) {
  fs.copyFileSync(path.join(__dirname, '../../backend/codexWebModelDiscovery.cjs'), path.join(root, 'src/lina-account-models.cjs'));
  fs.copyFileSync(path.join(__dirname, '../../backend/codexWebToolRelay.cjs'), path.join(root, 'src/lina-tool-relay.cjs'));
  fs.copyFileSync(path.join(__dirname, '../../backend/codexWebStartup.cjs'), path.join(root, 'src/lina-startup.cjs'));
  fs.copyFileSync(path.join(__dirname, '../../backend/codexWebImages.cjs'), path.join(root, 'src/lina-images.cjs'));
  fs.copyFileSync(path.join(__dirname, '../../backend/codexWebNativeCancellation.cjs'), path.join(root, 'src/lina-native-cancellation.cjs'));
  fs.copyFileSync(path.join(__dirname, '../../backend/codexWebConversation.cjs'), path.join(root, 'src/lina-conversation.cjs'));
  function edit(name, transform) {
    const file = path.join(root, name);
    const original = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    fs.writeFileSync(file, transform(original));
  }
  function replace(text, before, after) {
    if (!text.includes(before)) throw new Error(`Upstream patch anchor missing: ${before.slice(0, 90)}`);
    return text.replace(before, after);
  }
  // All panes using this resource are Web-only, including the native Codex model picker.
  edit('src/cli.ts', text => replace(text, '  } else if (command === "serve") {', `  } else if (command === 'lina-image-mcp' && process.env.LINA_CODEX_WEB_HOST_MODULE) {
    const { runImageToolServer } = await import('./lina-images.cjs');
    const browserApi = await import('./launcher-browser-host');
    const { readAccountCatalog } = await import('./lina-account-models.cjs');
    const { waitForValidation } = await import('./lina-startup.cjs');
    const { watchNativeAbort } = await import('./lina-native-cancellation.cjs');
    await runImageToolServer({ ...browserApi, loadConfig, readAccountCatalog, waitForValidation, watchNativeAbort });
  } else if (command === "serve") {`));
  edit('src/model-catalog.ts', text => {
    text = 'import { accountCatalogRow } from "./lina-account-models.cjs";\n' + text;
    text = replace(text, 'models: [...nativeModels, ...webModels]', 'models: webModels');
    return replace(text, '  delete model.availability_nux;\n  return model;', '  delete model.availability_nux;\n  return accountCatalogRow(model, route);');
  });
  edit('src/server.ts', text => {
    text = 'import { waitForValidation } from "./lina-startup.cjs";\nimport { readLauncherBrowserHostDescriptor as linaBrowserDescriptor } from "./launcher-browser-host";\n' + text;
    text = replace(text, '  const requestedModel = raw && typeof raw === "object" && !Array.isArray(raw)', `  if (process.env.LINA_CODEX_WEB_HOST_MODULE && config.browserHostDescriptorPath) {
    try {
      const validation = await waitForValidation(linaBrowserDescriptor(config.browserHostDescriptorPath), req.signal);
      if (!validation.ok) return formatErrorResponse(validation.status, validation.status === 401 ? 'authentication_error' : 'invalid_request_error', validation.message);
    } catch {
      return formatErrorResponse(503, 'invalid_request_error', 'Codex Web lost its local browser connection. Restart the pane to reconnect; sign in again if requested. Your local history is kept.');
    }
  }
  const requestedModel = raw && typeof raw === "object" && !Array.isArray(raw)`);
    text = 'import { accountMode, buildNativeCatalog } from "./lina-account-models.cjs";\nimport linaCodexTemplate from "./lina-codex-template.json";\n' + text;
    text = replace(text, '  let upstream: Response;\n  try {\n    upstream = await forwardNativeCodexRequest(req, "models", fetchUpstream);', `  if (process.env.LINA_CODEX_WEB_HOST_MODULE) return Response.json(buildNativeCatalog(linaCodexTemplate));
  let upstream: Response;
  try {
    upstream = await forwardNativeCodexRequest(req, "models", fetchUpstream);`);
    text = replace(text, '  parsed.modelId = route.backendModel;', `  if (route.backendModel.startsWith('chatgpt-account/')) {
    const mode = accountMode(route.backendModel, parsed.options.reasoning, { localToolsEnabled: config.mode === 'full' });
    parsed.modelId = route.backendModel; parsed.options.reasoning = mode.effort;
    return route;
  }
  parsed.modelId = route.backendModel;`);
    text = replace(text, '  const requestedModel = raw && typeof raw === "object" && !Array.isArray(raw)', `  const tier = raw && typeof raw === 'object' ? (raw as { service_tier?: unknown }).service_tier : undefined;
  if (process.env.LINA_CODEX_WEB_HOST_MODULE && typeof tier === 'string' && !['default', 'auto'].includes(tier)) return formatErrorResponse(400, 'invalid_request_error', 'ChatGPT Web does not support Fast mode or service tiers.');
  const requestedModel = raw && typeof raw === "object" && !Array.isArray(raw)`);
    text = replace(text, 'return await forwardNativeCodexRequest(nativeRequest, "responses", undefined, raw);', 'return formatErrorResponse(400, "invalid_request_error", "Codex Web requires a ChatGPT Web model; native inference is disabled");');
    return replace(text, 'return await forwardNativeCodexRequest(nativeRequest, "responses/compact", undefined, raw);', 'return formatErrorResponse(400, "invalid_request_error", "Codex Web requires Web compaction");');
  });
  // Operational event names and bounded numbers are sufficient; upstream free text can carry content.
  edit('launcher/electron/logging.cjs', text => replace(text, 'function sanitize(value, seen = new WeakSet()) {', `function sanitize(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(Object.entries(value).filter(([key, item]) =>
    ['pid', 'port', 'durationMs', 'elapsedMs', 'exitCode', 'count', 'statusCode'].includes(key) && Number.isFinite(item)));
  /* retained upstream implementation, unreachable */`));
  edit('launcher/electron/profile.cjs', text => text.replaceAll('Codex Web GPT', 'Codex Web'));
  edit('launcher/electron/state.cjs', text => replace(text, 'autoStart: true', 'autoStart: false'));
  edit('src/config.ts', text => replace(text, 'port: 17841,', 'port: Number(process.env.LINA_CODEX_WEB_PORT || 17841),'));
  edit('src/types.ts', text => replace(text, '  freeform?: boolean;', '  freeform?: boolean;\n  format?: Record<string, unknown>;'));
  edit('src/responses/parser.ts', text => replace(text, '      freeform: true,', '      freeform: true,\n      ...(process.env.LINA_CODEX_WEB_HOST_MODULE && isObj(t.format) ? { format: t.format } : {}),'));
  edit('src/chatgpt-web-models.ts', text => {
    text = 'import { accountRoutes, resolveAccountRoute, modelContextLimits } from "./lina-account-models.cjs";\n' + text;
    text = replace(text, '  return modelId.startsWith(CHATGPT_WEB_MODEL_PREFIX);', '  if (process.env.LINA_CODEX_WEB_HOST_MODULE) return Boolean(resolveAccountRoute(modelId));\n  return modelId.startsWith(CHATGPT_WEB_MODEL_PREFIX);');
    text = replace(text, 'export interface ChatGptWebAccountCapabilities {', 'export interface ChatGptWebAccountCapabilities {\n  modelLabel?: string;\n  modelEffort?: string;');
    text = replace(text, '| typeof CHATGPT_WEB_LUNA_BACKEND_MODEL;', '| typeof CHATGPT_WEB_LUNA_BACKEND_MODEL\n  | `chatgpt-account/${string}`;');
    text = replace(text, '): ChatGptWebContextLimits {\n  if (isChatGptWebZeroRiskBackendModel(backendModel)) {', '): ChatGptWebContextLimits {\n  if (backendModel.startsWith("chatgpt-account/")) return modelContextLimits(backendModel);\n  if (isChatGptWebZeroRiskBackendModel(backendModel)) {');
    text = replace(text, '): ChatGptWebTransportLimits {\n  if (isChatGptWebZeroRiskBackendModel(backendModel)) return {};', '): ChatGptWebTransportLimits {\n  if (backendModel.startsWith("chatgpt-account/")) return { browserMessageTokenLimit: Math.floor(modelContextLimits(backendModel).contextWindow * 0.9), browserComposerCharLimit: 1000000 };\n  if (isChatGptWebZeroRiskBackendModel(backendModel)) return {};');
    text = replace(text, '): readonly ChatGptWebModelRoute[] {\n  if (capabilities.browserInteractionMode', '): readonly ChatGptWebModelRoute[] {\n  if (process.env.LINA_CODEX_WEB_HOST_MODULE && capabilities.browserInteractionMode !== "manual") return accountRoutes();\n  if (capabilities.browserInteractionMode');
    text = replace(text, '  const route = routesBySlug.get(modelId);', '  if (process.env.LINA_CODEX_WEB_HOST_MODULE) {\n    const accountRoute = resolveAccountRoute(modelId);\n    if (!accountRoute) throw new Error("model_unavailable");\n    return accountRoute;\n  }\n  const route = routesBySlug.get(modelId);');
    return text;
  });
  edit('src/adapters/chatgpt-web/model.ts', text => {
    text = 'import { accountMode } from "../../lina-account-models.cjs";\n' + text;
    return replace(text, '  if (modelId === CHATGPT_WEB_LUNA_MODEL_ID) {', '  if (modelId.startsWith("chatgpt-account/")) return accountMode(modelId, reasoning, capabilities);\n  if (modelId === CHATGPT_WEB_LUNA_MODEL_ID) {');
  });
  edit('src/adapters/chatgpt-web/prompt.ts', text => {
    text = 'import { toolContract } from "../../lina-tool-relay.cjs";\n' + text;
    text = replace(text, '    : mode.localTools\n    ? [', '    : process.env.LINA_CODEX_WEB_HOST_MODULE\n    ? toolContract(parsed)\n    : mode.localTools\n    ? [');
    text = replace(text, '): string | undefined {\n  if (isChatGptWebZeroRiskBackendModel(parsed.modelId)) return undefined;', '): string | undefined {\n  if (process.env.LINA_CODEX_WEB_HOST_MODULE) return undefined;\n  if (isChatGptWebZeroRiskBackendModel(parsed.modelId)) return undefined;');
    return text.replaceAll('Open `MCP` in `Codex Web GPT`', 'Use the pane menu → `Codex Web tools setup` in Lina');
  });
  edit('src/adapters/chatgpt-web/index.ts', text => {
    // The stock embedded CLI has no Interrupt hook event. Its HTTP abort is
    // the cancellation boundary, including child-tool cancellations. Keep a
    // cancelled journal entry so transport retries cannot resubmit that work.
    text = replace(text, '            if (session.runtime.manualControl) {', `            if (process.env.LINA_CODEX_WEB_HOST_MODULE && !session.roundCompleted(roundKey) && !session.roundHasTerminalEvent(roundKey)) {
              const cancelled = new ChatGptWebAdapterError('The native Codex request was interrupted or disconnected. Retry the turn if needed; its Web request was not automatically repeated.', { status: 499, errorType: 'client_closed_request', code: 'client_cancelled', retryable: false });
              session.supersededError = cancelled;
              session.failRound(roundKey, cancelled);
              session.cancel(cancelled);
            }
            if (session.runtime.manualControl) {`);
    text = 'import { accountModel } from "../../lina-account-models.cjs";\nimport { guardedConversationKey, resumeRequest as linaResumeRequest } from "../../lina-conversation.cjs";\n' + text;
    text = replace(text, '      && mode.localTools\n      && retainedLauncherDescriptor', '      && (mode.localTools || process.env.LINA_CODEX_WEB_HOST_MODULE)\n      && retainedLauncherDescriptor');
    text = replace(text, '? chatGptConversationKey(checkpointInput.parsed, executionNamespace)', '? (process.env.LINA_CODEX_WEB_HOST_MODULE ? guardedConversationKey(checkpointInput.parsed, chatGptConversationKey(checkpointInput.parsed, executionNamespace), accountModel(checkpointInput.parsed.modelId).workMode) : chatGptConversationKey(checkpointInput.parsed, executionNamespace))');
    text = replace(text, '  if (normalized instanceof ChatGptWebAdapterError) return normalized;', `  if (normalized instanceof ChatGptWebAdapterError) return normalized;
  if (process.env.LINA_CODEX_WEB_HOST_MODULE && normalized.message === 'model_selection_failed') return new ChatGptWebAdapterError('ChatGPT changed the selected Web model. No request was sent to the other model. Refresh Web models from the pane menu, then retry.', { status: 400, errorType: 'invalid_request_error', code: 'model_selection_failed', retryable: false });`);
    text = replace(text, '? retainedConversationResumeRequest(checkpointInput.parsed)', '? (process.env.LINA_CODEX_WEB_HOST_MODULE ? linaResumeRequest(checkpointInput.parsed) : retainedConversationResumeRequest(checkpointInput.parsed))');
    text = replace(text, '        capabilities: turnCapabilities,\n        prepare: async () => ({', `        capabilities: turnCapabilities,
        ...(retainConversation ? { retainConversation: true, conversationKey } : {}),
        ...(resumeInput ? { prepareResume: async () => ({ ...compileChatGptWebPrompt(resumeInput, turnCapabilities, undefined, compileOptionsFor(resumeInput)), release: () => {} }) } : {}),
        prepare: async () => ({`);
    text = replace(text, '        mode: "read-only",\n        browser:', '        mode: "read-only",\n        ...(conversationKey ? { conversationKey } : {}),\n        ...(releaseRetainedConversation ? { releaseRetainedConversation } : {}),\n        browser:');
    text = 'import { createToolRelay } from "../../lina-tool-relay.cjs";\n' + text;
    text = replace(text, 'localToolsEnabled: provider.chatgptWeb?.localToolsEnabled === true,', 'localToolsEnabled: !process.env.LINA_CODEX_WEB_HOST_MODULE && provider.chatgptWeb?.localToolsEnabled === true,');
    text = replace(text, 'const structuredOutputValidator = parsed._compactionRequest', 'const structuredOutputValidator = (parsed._compactionRequest || process.env.LINA_CODEX_WEB_HOST_MODULE)');
    text = replace(text, '  return {\n    name: "chatgpt-web",', '  return createToolRelay({\n    name: "chatgpt-web",');
    return replace(text, '        clearInterval(heartbeat);\n      }\n    },\n  };\n}', '        clearInterval(heartbeat);\n      }\n    },\n  }, createChatGptStructuredOutputValidator);\n}');
  });
  edit('src/adapters/chatgpt-web/turn-execution.ts', text => replace(text,
    'export function chatGptTurnExecutionKey(parsed: CodexParsedRequest): string {',
    'export function chatGptTurnExecutionKey(parsed: CodexParsedRequest): string {\n  if (process.env.LINA_CODEX_WEB_HOST_MODULE && !parsed._compactionRequest) return chatGptTurnRoundKey(parsed);'));
  edit('src/chatgpt-session.ts', text => {
    text = `import { inspectAccountModels, saveAccountCatalog } from './lina-account-models.cjs';
import { writeFileSync as linaWrite, renameSync as linaRename, mkdirSync as linaMkdir } from 'node:fs';
import { join as linaJoin } from 'node:path';
function linaRememberModel(label: string, effort: string) {
  const home = process.env.CODEX_CHATGPT_WEB_HOME;
  if (!home || !process.env.LINA_CODEX_WEB_HOST_MODULE) return;
  linaMkdir(home, { recursive: true });
  const file = linaJoin(home, 'lina-model.json');
  const pending = file + '.' + process.pid + '.tmp';
  linaWrite(pending, JSON.stringify({ label: label.slice(0, 120), effort }), { mode: 0o600 });
  linaRename(pending, file);
}
` + text;
    text = replace(text, '  const composers = page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true });', `  // The private primary WebContents lives in a permanently hidden window.
  // Native view bounds alone leave its Chromium viewport at 0x0 on Windows.
  await page.setViewportSize({ width: 1280, height: 900 });
  if (process.env.LINA_CODEX_WEB_HOST_MODULE && new URL(page.url()).origin === 'https://chatgpt.com') {
    const catalog = saveAccountCatalog(await inspectAccountModels(page));
    const preferred = catalog.models.find(model => /astra/i.test(model.title)) || catalog.models.find(model => model.slug === catalog.defaultModel) || catalog.models[0];
    return { solAvailable: true, proAvailable: catalog.models.some(model => model.reasoningType === 'pro'), modelLabel: preferred.title, modelEffort: preferred.defaultEffort };
  }
  let modelLabel = '';
  let modelPicker = page.locator('button[data-testid="model-switcher-dropdown-button"]').filter({ visible: true }).first();
  if (!await modelPicker.count()) modelPicker = page.locator('button[data-tone="neutral"][aria-haspopup="menu"]').filter({ visible: true }).last();
  if (await modelPicker.count()) {
    modelLabel = (await modelPicker.innerText()).trim();
    if (!/(?:gpt[\\s-]*6|astra)/i.test(modelLabel) || /\\bpro\\b/i.test(modelLabel)) {
      await modelPicker.click();
      const candidates = page.getByRole('menuitemradio').filter({ visible: true }).filter({ hasText: /(?:GPT[\\s-]*6|Astra)/i });
      await candidates.first().waitFor({ state: 'visible', timeout: 4000 }).catch(() => {});
      let chosen;
      for (let index = 0; index < Math.min(await candidates.count(), 20); index++) {
        const candidate = candidates.nth(index);
        const label = (await candidate.innerText()).split('\\n')[0].trim();
        if (!/(?:gpt[\\s-]*6|astra)/i.test(label) || !await candidate.isEnabled()) continue;
        if (!chosen || !/\\bpro\\b/i.test(label)) chosen = { candidate, label };
        if (!/\\bpro\\b/i.test(label)) break;
      }
      if (chosen) {
        modelLabel = chosen.label; await chosen.candidate.click();
      }
      await page.keyboard.press('Escape').catch(() => {});
    }
  }
  const composers = page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true });`);
    text = replace(text, 'return { solAvailable: false, proAvailable: false };', 'linaRememberModel(modelLabel, "low"); return { solAvailable: false, proAvailable: false, modelLabel, modelEffort: "low" };');
    return replace(text, 'return { solAvailable: true, proAvailable: state.max - state.min + 1 >= 5 };', 'const modelEffort = ["low", "medium", "high", "xhigh", "max"][state.value - state.min]; linaRememberModel(modelLabel, modelEffort); return { solAvailable: true, proAvailable: state.max - state.min + 1 >= 5, modelLabel, modelEffort };');
  });
  edit('src/adapters/chatgpt-web/browser-worker.ts', text => {
    text = replace(text, '    captureDiagnostic?: (checkpoint: string) => Promise<void>,\n  ): Promise<ChatGptWebModelMode> {', '    captureDiagnostic?: (checkpoint: string) => Promise<void>,\n    preserveConversation = false,\n  ): Promise<ChatGptWebModelMode> {');
    text = replace(text, '          stagingMode.effort,\n          browserCapabilities,\n          checkpoint => diagnostics.capture(page, checkpoint),', '          stagingMode.effort,\n          browserCapabilities,\n          checkpoint => diagnostics.capture(page, checkpoint),\n          reuseConversation,');
    text = text.replaceAll('The ChatGPT session has expired. Sign in again in Codex Web GPT.', 'Your ChatGPT session has expired. Use the Lina pane menu → ChatGPT Web sign in, then resume the conversation with /resume.')
      .replaceAll('ChatGPT could not load the account subscription. Reload ChatGPT inside the launcher and retry; sign out only if the error persists.', 'ChatGPT could not load your subscription. Retry when the connection recovers; use the pane menu to sign in again if needed.');
    text = replace(text, '    captureDiagnostic?: (checkpoint: string) => Promise<void>,\n  ): Promise<Locator> {', '    captureDiagnostic?: (checkpoint: string) => Promise<void>,\n    modelId?: string,\n  ): Promise<Locator> {');
    text = replace(text, '    if (page.url() !== CHATGPT_TEMPORARY_CHAT_URL) {\n      await page.goto(CHATGPT_TEMPORARY_CHAT_URL, {', '    const targetUrl = process.env.LINA_CODEX_WEB_HOST_MODULE && modelId?.startsWith("chatgpt-account/") ? accountChatUrl(modelId) : CHATGPT_TEMPORARY_CHAT_URL;\n    if (page.url() !== targetUrl) {\n      await page.goto(targetUrl, {');
    text = replace(text, '          () => this.prepareTemporaryChatSurface(\n            page,\n            checkpoint => diagnostics.capture(page, checkpoint),\n          ),', '          () => this.prepareTemporaryChatSurface(\n            page,\n            checkpoint => diagnostics.capture(page, checkpoint),\n            turn.modelId,\n          ),');
    text = replace(text, '    await assertTemporaryChatPage(page);\n    await captureDiagnostic?.("session-verified");', '    await assertTemporaryChatPage(page);\n    if (process.env.LINA_CODEX_WEB_HOST_MODULE && modelId?.startsWith("chatgpt-account/")) noteAccountNavigation(page, modelId);\n    await captureDiagnostic?.("session-verified");');
    text = replace(text, '      prepared.release();\n      if (turnConnection)', '      if (process.env.LINA_CODEX_WEB_HOST_MODULE && turn.abortSignal?.aborted && diagnosticPage && !diagnosticPage.isClosed()) await linaStopPage(diagnosticPage);\n      prepared.release();\n      if (turnConnection)');
    text = `import { stopImagePage as linaStopPage } from '../../lina-images.cjs';
import { selectAccountModel, assertAccountSelection, accountChatUrl, noteAccountNavigation } from '../../lina-account-models.cjs';
import { readFileSync as linaReadBinding, existsSync as linaHasBinding } from 'node:fs';
import { join as linaBindingPath } from 'node:path';
async function linaCheckModel(page: import('playwright-core').Page, effort: string) {
  const home = process.env.CODEX_CHATGPT_WEB_HOME;
  if (!home || !process.env.LINA_CODEX_WEB_HOST_MODULE) return;
  const file = linaBindingPath(home, 'lina-model.json');
  if (!linaHasBinding(file)) throw new Error('Refresh Codex Web models before continuing.');
  const binding = JSON.parse(linaReadBinding(file, 'utf8'));
  if (binding.effort !== effort || !/(?:gpt[\\s-]*6|astra)/i.test(binding.label || '')) return;
  const expected = String(binding.label).trim().toLowerCase();
  let picker = page.locator('button[data-testid="model-switcher-dropdown-button"]').filter({ visible: true }).first();
  if (!await picker.count()) picker = page.locator('button[data-tone="neutral"][aria-haspopup="menu"]').filter({ visible: true }).last();
  if (await picker.count() && (await picker.innerText()).trim().toLowerCase() === expected) return;
  if (!await picker.count()) throw new Error('The selected Astra model cannot be verified in ChatGPT. Refresh Web models.');
  await picker.click();
  const options = page.getByRole('menuitemradio').filter({ visible: true }).filter({ hasText: binding.label });
  await options.first().waitFor({ state: 'visible', timeout: 5000 });
  let match;
  for (let index = 0; index < Math.min(await options.count(), 20); index++) {
    const option = options.nth(index);
    if ((await option.innerText()).split('\\n')[0].trim().toLowerCase() === expected && await option.isEnabled()) { match = option; break; }
  }
  if (!match) throw new Error('The selected Astra model is no longer available. Refresh Web models.');
  await match.click();
  await new Promise(resolve => setTimeout(resolve, 150));
  if ((await picker.innerText()).trim().toLowerCase() !== expected) {
    await picker.click();
    const choices = page.getByRole('menuitemradio').filter({ visible: true }).filter({ hasText: binding.label });
    await choices.first().waitFor({ state: 'visible', timeout: 5000 });
    let confirmed = false;
    for (let index = 0; index < Math.min(await choices.count(), 20); index++) {
      const choice = choices.nth(index);
      if ((await choice.innerText()).split('\\n')[0].trim().toLowerCase() === expected && await choice.getAttribute('aria-checked') === 'true') confirmed = true;
    }
    if (!confirmed) throw new Error('ChatGPT did not confirm the selected Astra model.');
    await page.keyboard.press('Escape');
  }
}
` + text;
    text = replace(text, 'export async function throwIfChatGptSessionFailureAlert(page: Page): Promise<void> {', 'export async function throwIfChatGptSessionFailureAlert(page: Page): Promise<void> {\n  assertAccountSelection(page);');
    text = replace(text, 'modelId !== CHATGPT_WEB_MODEL_ID && modelId !== CHATGPT_WEB_LUNA_MODEL_ID', 'modelId !== CHATGPT_WEB_MODEL_ID && modelId !== CHATGPT_WEB_LUNA_MODEL_ID && !modelId.startsWith("chatgpt-account/")');
    return replace(text, 'const mode = resolveChatGptWebModelMode(modelId, reasoning, capabilities);\n    const composer = await this.activeComposer(page);', 'const mode = resolveChatGptWebModelMode(modelId, reasoning, capabilities);\n    if (modelId.startsWith("chatgpt-account/")) { await selectAccountModel(page, modelId, reasoning, activateChatGptEffortMenu, preserveConversation); return mode; }\n    await linaCheckModel(page, mode.effort);\n    const composer = await this.activeComposer(page);');
  });
  edit('launcher/electron/browser-host.cjs', text => {
    text = replace(text, '  ) {\n    if (this.manualOperation) {\n      throw new Error(`ChatGPT browser is busy with ${this.manualOperation}`);', `  ) {
    const linaSession = await require(process.env.LINA_CODEX_WEB_HOST_MODULE).validatedSession(this);
    if (!linaSession.ok) throw Object.assign(new Error(linaSession.message), { code: linaSession.code });
    if (this.manualOperation) {
      throw new Error(\`ChatGPT browser is busy with \${this.manualOperation}\`);`);
    // Startup already loaded and authenticated this document. Reading the
    // account model endpoint does not require another full website reload.
    text = replace(text, 'if (detectCapabilities) await this.refreshChatGptHomeDocument();', 'if (detectCapabilities && (!process.env.LINA_CODEX_WEB_HOST_MODULE || !isTemporaryChatUrl(initialUrl))) await this.refreshChatGptHomeDocument();');
    text = replace(text, 'let sessionAuthenticated = false;', 'let sessionAuthenticated = false; let linaIdentity = ""; let linaAccountLabel = "";');
    text = replace(text, 'const sessionHasUser = user !== null && Object.keys(user).length > 0;', 'const sessionHasUser = user !== null && Object.keys(user).length > 0; linaAccountLabel = String(user?.email || user?.name || "").slice(0,120); linaIdentity = String(user?.id || user?.email || "") + ":" + String(payload?.account?.id || payload?.account_id || "");');
    text = replace(text, 'return { ...readSurface(), sessionAuthenticated };', 'return { ...readSurface(), sessionAuthenticated, linaIdentity, linaAccountLabel };');
    return replace(text, 'this.setState({ ...availability, authenticated: true, url: result.url });', 'this.setState({ ...availability, authenticated: true, url: result.url, linaAccountLabel: result.linaAccountLabel, linaAccountKey: createHash("sha256").update(result.linaIdentity || "").digest("hex") });');
  });
  edit('launcher/electron/control-server.cjs', text => {
    text = replace(text, '    const isSessionInspect = request.url === "/v1/session/inspect";', '    const isSessionReady = request.url === "/v1/session/ready";\n    const isSessionInspect = request.url === "/v1/session/inspect";');
    text = replace(text, '!isTurnRelease && !isSessionInspect && !manualAction', '!isTurnRelease && !isSessionInspect && !isSessionReady && !manualAction');
    return replace(text, '      if (isSessionInspect) {', `      if (isSessionReady) {
        const result = await require(process.env.LINA_CODEX_WEB_HOST_MODULE).validatedSession(host);
        if (!response.destroyed) writeJson(response, result.ok ? 200 : result.status, result);
        return;
      }
      if (isSessionInspect) {`);
  });
  for (const name of fs.readdirSync(path.join(root, 'launcher/electron')).filter(name => name.endsWith('.cjs'))) {
    edit('launcher/electron/' + name, text => text.replaceAll('process.resourcesPath', 'process.env.LINA_CODEX_WEB_BUNDLE'));
  }
  edit('launcher/electron/main.cjs', text => {
    text = replace(text, '  await waitForPackagedRuntimeSource({ app, resourcesPath: process.env.LINA_CODEX_WEB_BUNDLE });', '  const linaRuntimeRoot = require(process.env.LINA_CODEX_WEB_HOST_MODULE).bundledRuntime(process.env.LINA_CODEX_WEB_BUNDLE);');
    text = replace(text, `      installedRuntimeRoot = ensurePackagedRuntime({
        app,
        coreHome: CORE_HOME,
        resourcesPath: process.env.LINA_CODEX_WEB_BUNDLE,
      });`, '      installedRuntimeRoot = linaRuntimeRoot;');
    text = replace(text, '  app,\n  BrowserWindow,', '  app: electronApp,\n  BrowserWindow,');
    text = replace(text, '} = require("electron");', `} = require("electron");
const app = new Proxy(electronApp, { get(target, name) {
  if (name === 'isPackaged') return true;
  if (name === 'getVersion') return () => '5.0.6';
  const value = target[name]; return typeof value === 'function' ? value.bind(target) : value;
} });`);
    text = replace(text, 'packaged: app.isPackaged && !IS_DEV_PROFILE,', 'packaged: false,');
    text = replace(text, 'const autostart = IS_DEV_PROFILE ? { supported: false, enabled: false } : getAutostart(app);', 'const autostart = { supported: false, enabled: false };');
    text = replace(text, 'const startHidden = process.argv.includes("--hidden") && stateStore.read().onboardingComplete;', 'const startHidden = process.argv.includes("--hidden");');
    // Lina owns the visible terminal and setup flow. The upstream window only
    // hosts its hidden browser surface; no tray, activation or error dialog.
    text = replace(text, 'function showMainWindow() {', 'function showMainWindow() { return;');
    text = replace(text, 'function createTray(logger, language) {', 'function createTray(logger, language) { return false;');
    text = replace(text, 'if (windowState.maximized) window.maximize();', 'if (!startHidden && windowState.maximized) window.maximize();');
    text = replace(text, 'if (windowState.fullscreen) window.setFullScreen(true);', 'if (!startHidden && windowState.fullscreen) window.setFullScreen(true);');
    text = replace(text, '  browserControl = await new BrowserControlServer({', '  mainWindow.setSkipTaskbar(true);\n  browserControl = await new BrowserControlServer({');
    text = replace(text, 'dialog.showErrorBox("Codex Web GPT could not start", message);', '/* Startup failures go through Lina diagnostics, never a second app dialog. */');
    text = replace(text, 'cdpPort = await findFreePort();', 'cdpPort = await findFreePort();\n  process.env.LINA_CODEX_WEB_PORT = String(await findFreePort());');
    text = replace(text, '`${new Date().toISOString()} ${error?.stack || error}\\n`', '`${new Date().toISOString()} launcher_start_failed\\n`');
    text = replace(text, '  if (IS_DEV_PROFILE) {\n    let config = null;', '  let linaRuntimeStartup = Promise.resolve();\n  if (IS_DEV_PROFILE) {\n    let config = null;');
    text = replace(text, 'startupAuthenticationRefresh = browserHost.refreshAuthentication().catch((error) => {', 'startupAuthenticationRefresh = require(process.env.LINA_CODEX_WEB_HOST_MODULE).beginStartupValidation(browserHost).catch((error) => {');
    text = replace(text, '  } else void (async () => {\n    await startupAuthenticationRefresh;', '  } else linaRuntimeStartup = (async () => {\n    // The local provider can start while the browser validates its saved login.');
    text = replace(text, '  app.on("activate", () => showMainWindow());', `  await linaRuntimeStartup;
  require(process.env.LINA_CODEX_WEB_HOST_MODULE).attach({ app, browserHost, runtimeHost, runtimeSupervisor, stateStore, showMainWindow, requestQuit });
  app.on("activate", () => showMainWindow());`);
    // The application updates this resource. Never create an independent autostart entry.
    text = replace(text, 'handle("launcher:autostart", (_event, enabled) => {', 'handle("launcher:autostart", (_event, enabled) => { return { supported: false, enabled: false };');
    return text;
  });
}
module.exports = { patchUpstream };
