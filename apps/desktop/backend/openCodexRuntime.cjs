"use strict";
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const providers = require('./openCodexProviders.cjs');
const { createAdapter } = require('./openCodexAdapter.cjs');

const BASE_INSTRUCTIONS = `You are Open Codex, a coding agent running in Lina Terminal. Help the user complete their task in the shared local workspace. Inspect the existing code and AGENTS.md instructions before making changes. Use the provided tools to read files, edit code, run commands, and verify results. Respect approval and sandbox restrictions. Preserve unrelated user changes. Give brief progress updates during substantial work. Continue until the requested task is complete, and report the result, verification, and any remaining limitations truthfully. Use apply_patch for manual code changes. Do not claim tools succeeded unless their results establish success.`;
function modelCatalog(models) {
  return { models: models.map((model, index) => ({
    slug: model.cliId || model.key, display_name: `${model.label} · ${model.providerName}`, description: `${model.label} · ${model.providerName}`,
    default_reasoning_level: model.reasoning ? 'medium' : 'none',
    supported_reasoning_levels: model.reasoning ? ['low', 'medium', 'high'].map(effort => ({ effort, description: `${effort} reasoning` })) : [{ effort: 'none', description: 'Use the model without a reasoning-effort override.' }],
    shell_type: 'shell_command', visibility: 'list', supported_in_api: true, priority: index,
    additional_speed_tiers: [], service_tiers: [], availability_nux: null, upgrade: null,
    base_instructions: BASE_INSTRUCTIONS, model_messages: null, include_skills_usage_instructions: true,
    supports_reasoning_summaries: false, default_reasoning_summary: 'none', support_verbosity: false, default_verbosity: null,
    apply_patch_tool_type: null, web_search_tool_type: 'text', truncation_policy: { mode: 'tokens', limit: 10000 },
    supports_parallel_tool_calls: false, supports_image_detail_original: false,
    context_window: model.contextWindow, max_context_window: model.contextWindow, effective_context_window_percent: 90,
    experimental_supported_tools: [], input_modalities: model.imageInput ? ['text', 'image'] : ['text'],
    supports_search_tool: false, use_responses_lite: false, tool_mode: 'default', multi_agent_version: 'v1'
  })) };
}
function cliModels(models) {
  const names = new Map();
  for (const model of models) {
    const name = model.providerName.toLowerCase().replace(/[^a-z0-9._-]+/g,'-').replace(/^-|-$/g,'').slice(0,40) || 'provider';
    (names.get(name) || names.set(name,new Set()).get(name)).add(model.providerId);
  }
  return models.map(model => {
    const name = model.providerName.toLowerCase().replace(/[^a-z0-9._-]+/g,'-').replace(/^-|-$/g,'').slice(0,40) || 'provider';
    return { ...model, cliId: `${name}${names.get(name).size > 1 ? '-'+model.providerId.slice(-6) : ''}/${model.id}` };
  });
}
function resolveHome(userData) { return path.join(userData, 'open-codex'); }
function resolveBinary({ isPackaged, resourcesPath, root }) {
  const dir = path.join(isPackaged ? resourcesPath : path.join(root, 'vendor'), 'open-codex', `${process.platform}-${process.arch}`);
  const binary = path.join(dir, process.platform === 'win32' ? 'codex.exe' : 'codex');
  if (!fs.existsSync(binary)) throw new Error('Open Codex is missing its separate bundled CLI. Run npm run prepare:open-codex or reinstall Lina Terminal.');
  return binary;
}
function shellQuote(value) { return `'${String(value).replace(/['‘’‚‛]/g, quote => process.platform === 'win32' ? quote + quote : "'\\''")}'`; }
function createRuntimeManager({ userData, binaryOptions, cliPath, nodeCommand, packaged = false, providerStore = providers }) {
  const sessions = new Map(), pending = new Map();
  async function release(id, generation) {
    if (!generation || pending.get(id)?.generation === generation) pending.delete(id);
    const session = sessions.get(id);
    if (!session || (generation && session.generation !== generation)) return;
    sessions.delete(id);
    await session.adapter.close();
    // Only the per-launch catalog is ephemeral. Saved Codex history is retained.
    try { fs.unlinkSync(session.catalogPath); fs.rmdirSync(session.runDir); } catch {}
  }
  async function prepare(payload) {
    const binary = resolveBinary(binaryOptions);
    const configured = providerStore.listProfiles();
    const selected = payload.openCodexModel || configured.defaultModel;
    if (!configured.models.length) throw new Error('Add a provider and models in Settings → Models & providers before launching.');
    if (!configured.models.some(row => row.key === selected)) throw new Error('This model is no longer configured. Choose an Open Codex model in Settings and launch a new pane.');
    // Validate that the selected saved credential is readable before launching.
    providerStore.resolveModel(selected);
    const retiring = release(payload.id);
    const ticket = { generation: payload.generation };
    pending.set(payload.id, ticket);
    await retiring;
    if (pending.get(payload.id) !== ticket) throw new Error('Open Codex launch was cancelled.');
    const exposed = cliModels(configured.models);
    const routing = new Map(exposed.map(row => [row.cliId, row.key]));
    const adapter = await createAdapter({
      resolveModel: id => { const key = routing.get(id); if (!key) throw new Error('This model is no longer configured. Restart Open Codex to load updated models.'); return providerStore.resolveModel(key); },
      listModels: () => { const current = new Set(providerStore.listProfiles().models.map(row=>row.key)); return exposed.filter(row=>current.has(row.key)).map(row=>({...row,key:row.cliId})); }
    });
    if (pending.get(payload.id) !== ticket) { await adapter.close(); throw new Error('Open Codex launch was cancelled.'); }
    const home = resolveHome(userData);
    const runDir = path.join(home, 'launches', crypto.randomUUID());
    const catalogPath = path.join(runDir, 'models.json');
    try {
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(catalogPath, JSON.stringify(modelCatalog(exposed)), { mode: 0o600 });
      sessions.set(payload.id, { generation: payload.generation, adapter, runDir, catalogPath });
      // Only a random loopback capability reaches the child. Provider API keys
      // stay in the main process and never enter argv, files, or renderer IPC.
      const env = { LINA_OPEN_CODEX_BIN: binary, LINA_OPEN_CODEX_HOME: home, LINA_OPEN_CODEX_CATALOG: catalogPath,
        LINA_OPEN_CODEX_MODEL: exposed.find(row=>row.key===selected).cliId, LINA_OPEN_CODEX_BASE_URL: adapter.baseUrl, LINA_OPEN_CODEX_TOKEN: adapter.token,
        ...(packaged ? { ELECTRON_RUN_AS_NODE: '1' } : {}) };
      const resumeId = payload.resumeId;
      if (resumeId && !/^[a-zA-Z0-9_-]{1,100}$/.test(resumeId)) throw new Error('Invalid Open Codex conversation ID.');
      const command = `${process.platform === 'win32' ? '& ' : ''}${shellQuote(nodeCommand)} ${shellQuote(cliPath)}${resumeId ? ` resume ${shellQuote(resumeId)}` : ''}`;
      return { env, command, selectedModel: selected, stripEnv: ['CODEX_HOME', 'CODEX_API_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID', 'OPENAI_ORGANIZATION', 'OPENAI_PROJECT_ID'] };
    } catch (error) { await adapter.close(); try { fs.unlinkSync(catalogPath); fs.rmdirSync(runDir); } catch {} if (sessions.get(payload.id)?.adapter === adapter) sessions.delete(payload.id); throw error; }
  }
  return { prepare, release, close: () => { pending.clear(); return Promise.all([...sessions.keys()].map(id => release(id))); }, home: resolveHome(userData) };
}
module.exports = { createRuntimeManager, modelCatalog, cliModels, resolveBinary, resolveHome };
