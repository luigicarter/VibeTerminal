'use strict';
// Stock Codex can abort an MCP future without sending notifications/cancelled.
// Observe only this call's native thread/turn abort record while it is active.
// This never writes history or retains prompt/tool contents.
const fs = require('node:fs'), path = require('node:path');
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{6,128}$/.test(value);
function nativeIdentity(meta) {
  if (!meta?.threadId) return null; // Ordinary MCP clients use protocol cancellation.
  let turn = meta['x-codex-turn-metadata'];
  if (typeof turn === 'string') { try { turn = JSON.parse(turn); } catch {} }
  if (!id(meta.threadId) || !id(turn?.turn_id) || (turn.thread_id && turn.thread_id !== meta.threadId)) throw Object.assign(new Error('Native image cancellation metadata is unavailable.'), { code: 'image_cancellation_unavailable' });
  return { threadId: meta.threadId, turnId: turn.turn_id };
}
function findRollout(home, threadId) {
  const sessions = path.resolve(home, 'sessions'), archived = path.resolve(home, 'archived_sessions');
  const accept = file => {
    try { const real = fs.realpathSync(file), norm = value => process.platform === 'win32' ? value.toLowerCase() : value;
      if (![sessions, archived].some(root => norm(real).startsWith(norm(root) + path.sep)) || !real.endsWith('-' + threadId + '.jsonl')) return null;
      return real;
    } catch { return null; }
  };
  // Native UUIDv7 session IDs encode their creation date. Search only the
  // possible local-date folders, even if the machine's time zone changed.
  if (/^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(threadId)) {
    const stamp = parseInt(threadId.replaceAll('-', '').slice(0, 12), 16);
    for (const offset of [0, -1, 1]) {
      const parts = new Date(stamp + offset * 86400000).toISOString().slice(0, 10).split('-'), directory = path.join(sessions, ...parts);
      try { const name = fs.readdirSync(directory).find(name => name.endsWith('-' + threadId + '.jsonl')); if (name) return accept(path.join(directory, name)); } catch {}
    }
  }
  // Older/restored threads may live elsewhere. Use the native read-only index.
  if (process.versions.bun) {
    try { const { Database } = require('bun:sqlite');
      const files = fs.readdirSync(home).filter(file => /^state_\d+\.sqlite$/.test(file)).sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
      for (const file of files) { const db = new Database(path.join(home, file), { readonly: true }); try { const row = db.query('SELECT rollout_path FROM threads WHERE id = ?').get(threadId); if (row?.rollout_path) return accept(row.rollout_path); } finally { db.close(); } }
    } catch {}
  }
  return null;
}
function abortRecord(line, turnId) {
  if (!line.includes('turn_aborted')) return false;
  try { const row = JSON.parse(line); return row.type === 'event_msg' && row.payload?.type === 'turn_aborted' && row.payload.turn_id === turnId; } catch { return false; }
}
async function watchNativeAbort(home, meta, controller) {
  const identity = nativeIdentity(meta); if (!identity) return () => {};
  const file = findRollout(home, identity.threadId);
  if (!file) throw Object.assign(new Error('A saved native session is required for cancellable image generation.'), { code: 'image_cancellation_unavailable' });
  let closed = false, busy = false, position = Math.max(0, fs.statSync(file).size - 65536), partial = '', discard = position > 0, initialized = false, timer;
  const consume = text => {
    for (const part of text.split(/(?<=\n)/)) {
      if (!discard) partial += part;
      if (part.endsWith('\n')) { if (!discard && abortRecord(partial, identity.turnId)) controller.abort(); partial = ''; discard = false; }
      else if (partial.length > 131072) { partial = ''; discard = true; }
    }
  };
  const poll = async () => {
    if (closed || busy || controller.signal.aborted) return; busy = true; let handle;
    try {
      handle = await fs.promises.open(file, 'r'); const size = (await handle.stat()).size;
      if (size < position) { controller.abort(); return; }
      if (!initialized) { initialized = true; if (position > 0) { const previous = Buffer.alloc(1); await handle.read(previous, 0, 1, position - 1); discard = previous[0] !== 10; } }
      const chunk = Buffer.alloc(65536); let budget = 4 * 1024 * 1024;
      while (!closed && !controller.signal.aborted && position < size && budget > 0) {
        const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, size - position), position);
        if (!bytesRead) break; position += bytesRead; budget -= bytesRead; consume(chunk.subarray(0, bytesRead).toString('utf8'));
      }
    } catch { controller.abort(); } finally { await handle?.close().catch(() => {}); busy = false; }
  };
  await poll();
  timer = setInterval(() => { void poll(); }, 100); timer.unref?.();
  return () => { closed = true; clearInterval(timer); };
}
module.exports = { nativeIdentity, findRollout, abortRecord, watchNativeAbort };
