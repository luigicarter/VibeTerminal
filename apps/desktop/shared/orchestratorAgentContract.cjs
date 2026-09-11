'use strict';

// Versioned read contract. These references describe evidence, never permission.
const VERSION = 1;
const SECTIONS = Object.freeze(['identity', 'work', 'activity', 'attention', 'capabilities', 'notes', 'results', 'history']);
const LIMITS = Object.freeze({ bootstrapEntries: 8, bootstrapBytes: 6144, pageEntries: 20, pageBytes: 8192,
  detailBytes: 4000, roundBytes: 12000, noteBytes: 2048, agentNoteBytes: 131072, storeBytes: 8388608,
  identities: 2000 });
const text = (value, limit = 240) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, limit) : undefined;
const id = value => typeof value === 'string' && value.trim() && value.length <= 4096 ? value : undefined;
const generation = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 || typeof value === 'number' && Number.isFinite(value);
function runRef(session) {
  if (!id(session?.id) || !generation(session.generation) || String(session.generation).startsWith('paused:') || session.started === false) return null;
  return { id: session.id, generation: session.generation,
    ...(Number.isSafeInteger(session.launchToken) && session.launchToken >= 0 && { launchToken: session.launchToken }) };
}
function sameRun(a, b) {
  return Boolean(a && b && a.id === b.id && a.generation === b.generation && a.launchToken === b.launchToken);
}
function sections(value = ['identity', 'work', 'activity', 'attention', 'capabilities']) {
  if (!Array.isArray(value) || !value.length || value.length > SECTIONS.length || value.some(item => !SECTIONS.includes(item))) throw new Error('Choose supported agent record sections.');
  return [...new Set(value)];
}
module.exports = { VERSION, SECTIONS, LIMITS, text, id, generation, runRef, sameRun, sections };
