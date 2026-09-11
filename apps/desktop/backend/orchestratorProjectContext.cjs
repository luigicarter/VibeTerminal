'use strict';
const path = require('node:path');
function resolveSubmittedProject(projectPath, roots) {
  if (typeof projectPath !== 'string' || !path.isAbsolute(projectPath)) throw new Error('The selected project path is invalid.');
  const normalize = value => path.resolve(value).replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
  const projects = Array.isArray(roots) ? roots : roots?.projects || [];
  const selected = projects.find(p => typeof (typeof p === 'string' ? p : p?.path) === 'string' &&
    normalize(typeof p === 'string' ? p : p.path) === normalize(projectPath));
  if (!selected) throw new Error('The project selected when this request was submitted is no longer available. No other project was substituted.');
  return { ok: true, view: 'project', cwd: typeof selected === 'string' ? selected : selected.path,
    ...(typeof selected === 'object' && selected.id && { projectId: selected.id }), source: 'submitted-project' };
}
module.exports = { resolveSubmittedProject };
