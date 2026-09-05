const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const fields = ['name','kind','command','fusion','fusionPlannerFamily','fusionPlannerModel','fusionPlannerEffort','fusionPlannerFast','fusionExecutorFamily','fusionExecutorModel','fusionExecutorEffort','fusionExecutorFast','fusionRunMode','fusionModel','fusionCodexModel','fusionClaudeEffort','fusionCodexEffort','fusionEffort','openFusion','openFusionPlannerModel','openFusionExecutorModel','openFusionRunMode','providerProfileId','providerModelOverride'];
const kinds = new Set(['terminal','codex','claude','cursor','gemini','opencode','kimi','kimi-custom','qwen']);
const absolute = value => typeof value === 'string' && !value.includes('\0') && (path.win32.isAbsolute(value) || path.posix.isAbsolute(value));
const canonical = value => value.replace(/\\/g,'/').replace(/\/$/,'').toLowerCase();
function sanitizeSetup(raw) {
  if (!raw || raw.version !== 1 || !['global','project'].includes(raw.scope)) throw new Error('Unsupported setup version or scope.');
  if (typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 160) throw new Error('Invalid setup name.');
  if (raw.scope === 'project' && !absolute(raw.projectPath)) throw new Error('Project setups require an absolute folder.');
  if (!Array.isArray(raw.panes) || raw.panes.length > 128) throw new Error('Invalid setup panes.');
  const ids = new Set(raw.panes.map(p => p.localId));
  if (ids.size !== raw.panes.length || [...ids].some(id => typeof id !== 'string' || !/^pane-\d+$/.test(id))) throw new Error('Invalid recipe-local identities.');
  function tree(node, depth = 0, seen = new Set()) {
    if (!node) return undefined;
    if (depth > 6) throw new Error('Split tree too deep.');
    if (typeof node.id === 'string') {
      if (!ids.has(node.id) || seen.has(node.id) || seen.size >= 8) throw new Error('Invalid split leaf.');
      seen.add(node.id); return { id: node.id };
    }
    if (!['row','col'].includes(node.dir) || !Number.isFinite(node.ratio)) throw new Error('Invalid split branch.');
    const a = tree(node.a, depth + 1, seen), b = tree(node.b, depth + 1, seen);
    if (!a || !b) throw new Error('Incomplete split branch.');
    return { dir: node.dir, ratio: Math.max(.05, Math.min(.95, node.ratio)), a, b };
  }
  const panes = raw.panes.map(p => {
    const config = {};
    const migratedFrom = p.config?.kind === 'aider' || p.migratedFrom === 'aider' ? 'aider' : undefined;
    for (const key of fields) {
      const expected = ['fusion','openFusion','fusionPlannerFast','fusionExecutorFast'].includes(key) ? 'boolean' : 'string';
      if (typeof p.config?.[key] === expected) config[key] = p.config[key];
    }
    if (config.kind === 'aider') { config.kind = 'terminal'; config.command = ''; delete config.fusion; delete config.openFusion; delete config.providerProfileId; delete config.providerModelOverride; }
    if (!kinds.has(config.kind)) throw new Error('Unknown session kind.');
    if (!p.path || !['project','absolute'].includes(p.path.kind) || (p.path.kind === 'absolute' && !absolute(p.path.value))) throw new Error('Invalid path binding.');
    if (!p.layout || ['x','y','w','h'].some(key => !Number.isFinite(p.layout[key])) || p.layout.w <= 0 || p.layout.h <= 0) throw new Error('Invalid layout.');
    if (p.tileId && !ids.has(p.tileId)) throw new Error('Invalid tile anchor.');
    if (p.prompt !== undefined && (typeof p.prompt !== 'string' || p.prompt.length > 100000)) throw new Error('Invalid starting prompt.');
    return { localId: p.localId, ...(migratedFrom ? {migratedFrom} : {}), config, path: p.path.kind === 'project' ? { kind: 'project' } : { kind: 'absolute', value: p.path.value },
      layout: { x:p.layout.x,y:p.layout.y,w:p.layout.w,h:p.layout.h,...(p.layout.unit === 'fluid' ? {unit:'fluid'} : {}) },
      ...(p.tileId ? {tileId:p.tileId}:{}), ...(p.splitTree ? {splitTree:tree(p.splitTree)}:{}), ...(p.prompt !== undefined ? {prompt:p.prompt}:{}) };
  });
  return { version:1,id: typeof raw.id === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(raw.id) ? raw.id : randomUUID(),name:raw.name.trim(),scope:raw.scope,
    ...(raw.scope === 'project' ? {projectPath:raw.projectPath}:{}),panes,createdAt:Number.isFinite(raw.createdAt)?raw.createdAt:Date.now(),updatedAt:Number.isFinite(raw.updatedAt)?raw.updatedAt:Date.now() };
}
function createWorkspaceSetupStore({ userDataPath }) {
  const file = path.join(userDataPath,'workspace-setups.json');
  let queue = Promise.resolve();
  async function read() {
    let data;
    try { data = JSON.parse(await fs.readFile(file,'utf8')); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    if (data.version !== 1 || !Array.isArray(data.setups)) throw new Error('Unsupported setup store.');
    return data.setups.map(sanitizeSetup);
  }
  function mutate(fn) {
    const operation = queue.then(async () => {
      const setups = await read(); const result = fn(setups);
      await fs.mkdir(userDataPath,{recursive:true});
      const temporary = `${file}.${randomUUID()}.tmp`;
      try { await fs.writeFile(temporary,JSON.stringify({version:1,setups},null,2),{mode:0o600}); await fs.rename(temporary,file); }
      finally { await fs.rm(temporary,{force:true}); }
      return result;
    });
    queue = operation.catch(() => {}); return operation;
  }
  return {
    async list({projectPath} = {}) { await queue; return (await read()).filter(r => r.scope === 'global' || (absolute(projectPath) && canonical(r.projectPath) === canonical(projectPath))); },
    save(raw) { const recipe = sanitizeSetup(raw); recipe.updatedAt = Date.now(); return mutate(setups => { const index = setups.findIndex(r => r.id === recipe.id); if(index < 0) setups.push(recipe); else setups[index] = recipe; return recipe; }); },
    remove(id) { return mutate(setups => { const index = setups.findIndex(r => r.id === id); if(index >= 0) setups.splice(index,1); return {ok:true}; }); }
  };
}
module.exports = { createWorkspaceSetupStore, sanitizeSetup };
