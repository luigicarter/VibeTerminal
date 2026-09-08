'use strict';

// Immutable display evidence paired with an observed native root-turn end.
// This is never treated as a full transcript or proof of successful code changes.
function createCompletionEvidence({ getSession, readObservation, maxEntries = 200 } = {}) {
  const results = new Map(), pending = new Map();
  const keyFor = session => JSON.stringify([session.id, session.generation, session.turnId]);
  const eligible = session => session?.turnId && session.observation === 'observed' && session.turnState === 'completed' && !session.pendingInput && !session.childActivity && Number.isFinite(session.turnStartedAt) && Number.isFinite(session.turnEndedAt);
  function capture(session) {
    if (!eligible(session)) return Promise.resolve();
    const key = keyFor(session);
    if (results.has(key)) return Promise.resolve(results.get(key));
    if (pending.has(key)) return pending.get(key);
    const operation = Promise.resolve().then(async () => {
      const observation = await readObservation({ id: session.id, generation: session.generation, maxChars: 16000 });
      const current = getSession(session.id);
      if (!eligible(current) || keyFor(current) !== key || current.turnEndedAt !== session.turnEndedAt || observation.ok === false || observation.generation !== session.generation || !observation.text?.trim() || !Number.isFinite(observation.outputAt) || observation.outputAt < session.turnStartedAt) return;
      const value = { turnId: session.turnId, status: 'completed', at: session.turnEndedAt, text: observation.text,
        source: 'terminal-screen', sequence: observation.sequence, coverage: 'Current displayed excerpt at the observed turn end; not a complete transcript.', truncated: observation.truncated === true };
      results.set(key, value);
      while (results.size > maxEntries) results.delete(results.keys().next().value);
      return structuredClone(value);
    }).catch(() => undefined).finally(() => pending.delete(key));
    pending.set(key, operation); return operation;
  }
  return { capture,
    get(session, turnId = session?.turnId) { return session ? structuredClone(results.get(JSON.stringify([session.id, session.generation, turnId]))) : undefined; },
    forget(id, generation) { for (const key of results.keys()) { const identity = JSON.parse(key); if (identity[0] === id && identity[1] === generation) results.delete(key); } },
    clear() { results.clear(); }
  };
}
module.exports = { createCompletionEvidence };
