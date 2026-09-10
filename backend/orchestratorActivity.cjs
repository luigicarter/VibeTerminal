'use strict';

// Request-owned, ephemeral identities only. A relay retains its touched targets
// through its reply; independent direct actions release only their own scope.
function createActivity() {
  const scopes = new Set();
  return {
    begin(epoch, { independent = false } = {}) { const scope = { epoch, independent, targets: new Map() }; scopes.add(scope); return scope; },
    touch(scope, target, operation) {
      if (!scopes.has(scope) || !target?.id || !target.generation) return false;
      const key = JSON.stringify([target.id, target.generation]);
      if (!scope.targets.has(key)) {
        if (scope.targets.size >= 200) return false;
        scope.targets.set(key, { id: target.id, generation: target.generation, operations: new Set() });
      }
      scope.targets.get(key).operations.add(operation);
      return true;
    },
    end(scope) { return scopes.delete(scope) && scope.targets.size > 0; },
    clear() { scopes.clear(); },
    snapshot(sessions, epoch) {
      const live = new Set(sessions.map(s => JSON.stringify([s.id, s.generation])));
      const targets = new Map();
      for (const scope of scopes) {
        if (!scope.independent && scope.epoch !== epoch) { scopes.delete(scope); continue; }
        for (const [key, target] of scope.targets) {
          if (!live.has(key)) { scope.targets.delete(key); continue; }
          if (!targets.has(key)) {
            if (targets.size >= 200) continue;
            targets.set(key, { id: target.id, generation: target.generation, operations: new Set() });
          }
          for (const operation of target.operations) targets.get(key).operations.add(operation);
        }
      }
      return [...targets.values()].map(target => ({ ...target, operations: [...target.operations].sort() }));
    },
  };
}
module.exports = { createActivity };
