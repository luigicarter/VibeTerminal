'use strict';

// The relay has one conversation. Session directories contain identity/title
// metadata; provider transcripts enter context only through explicit reads.
function sessionSummary(s) {
  const native = s.conversation || s.threadRef;
  return {
    id: s.id, generation: s.generation, launchToken: s.launchToken,
    name: s.name, conversationTitle: s.conversationTitle || native?.title,
    aliases: [...new Set((s.aliases || []).filter(v => typeof v === 'string'))].slice(0, 5),
    kind: s.kind, provider: s.provider, cwd: s.cwd, projectName: s.projectName,
    status: s.status, observation: s.observation, lastActivityAt: s.lastActivityAt,
    home: s.openFusion || s.kind === 'openfusion' ? 'openfusion' : s.providerProfileId ? 'custom' : 'global',
    conversationId: native?.id
  };
}

function listSessionSummaries(sessions, { query = '', provider, cwd, offset = 0, limit = 50 } = {}) {
  const needle = String(query).trim().toLowerCase();
  const selected = sessions.filter(s => {
    if (provider && ![s.provider, s.kind].includes(provider)) return false;
    if (cwd && String(s.cwd).replace(/\\/g, '/').toLowerCase() !== String(cwd).replace(/\\/g, '/').toLowerCase()) return false;
    return !needle || [s.id, s.name, s.conversationTitle, s.projectName, s.cwd, ...(s.aliases || [])].filter(Boolean).join('\n').toLowerCase().includes(needle);
  });
  const start = Math.max(0, Math.min(10000, Math.floor(Number(offset) || 0)));
  const size = Math.max(1, Math.min(200, Math.floor(Number(limit) || 50)));
  return { ok: true, sessions: selected.slice(start, start + size).map(sessionSummary), total: selected.length,
    nextOffset: start + size < selected.length ? start + size : null, truncated: start + size < selected.length };
}

function serializeToolResult(value, maxChars = 24000) {
  const full = JSON.stringify(value ?? null);
  if (full.length <= maxChars) return full;
  const priority = ['ok', 'status', 'error', 'kind', 'id', 'reference', 'target', 'generation', 'launchToken', 'provider', 'cwd', 'name', 'title', 'nextOffset', 'total', 'complete', 'truncated'];
  for (const stringLimit of [4096, 2048, 1024, 512, 256, 128, 64]) {
    const arrayLimit = Math.max(3, Math.floor(stringLimit / 80));
    function trim(item, depth = 0) {
      if (typeof item === 'string') return item.slice(0, stringLimit);
      if (item === null || typeof item !== 'object') return item;
      if (depth > 8) return null;
      if (Array.isArray(item)) return item.slice(0, arrayLimit).map(v => trim(v, depth + 1));
      const keys = [...priority.filter(key => Object.hasOwn(item, key)), ...Object.keys(item).filter(key => !priority.includes(key))].slice(0, 80);
      return Object.fromEntries(keys.map(key => [key, trim(item[key], depth + 1)]));
    }
    const reduced = trim(value);
    const result = reduced && typeof reduced === 'object' && !Array.isArray(reduced)
      ? { ...reduced, truncated: true, contextNote: 'Tool context shortened. Narrow the query or request a smaller page; never repeat an effect because its details were shortened.' }
      : { data: reduced, truncated: true };
    if (['sessions', 'conversations', 'files'].some(key => Array.isArray(value?.[key]) && Array.isArray(result[key]) && result[key].length < value[key].length)) {
      result.nextOffset = null;
      result.retrySmallerPage = true;
      result.contextNote = 'This page was shortened for context. Repeat this read with the same offset and a smaller limit; do not advance to the next page yet.';
    }
    const serialized = JSON.stringify(result);
    if (serialized.length <= maxChars) return serialized;
  }
  return JSON.stringify({ ok: value?.ok === true, status: String(value?.status || 'unknown').slice(0, 100), id: typeof value?.id === 'string' ? value.id.slice(0, 200) : undefined, reference: typeof value?.reference === 'string' ? value.reference.slice(0, 200) : undefined, truncated: true,
    error: 'Result exceeds the context limit. Use a narrower read; check action receipts before requesting any new effect.' });
}

module.exports = { sessionSummary, listSessionSummaries, serializeToolResult };
