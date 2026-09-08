'use strict';

// Coalesce reads, not mutations. An inventory started before a workspace
// mutation cannot satisfy a caller waiting for that mutation's new state.
function createInventoryRefresh({ read, apply, after = async () => {} }) {
  let epoch = 0, pending, appliedEpoch = -1, latest;
  const refresh = () => {
    if (pending?.epoch === epoch) return pending.promise;
    const flight = { epoch };
    pending = flight;
    flight.promise = Promise.resolve().then(read).then(async result => {
      if (flight.epoch !== epoch) return appliedEpoch === epoch ? latest : refresh();
      if (result?.ok) { apply(result); appliedEpoch = epoch; latest = result; }
      await after();
      if (flight.epoch !== epoch) return appliedEpoch === epoch ? latest : refresh();
      return result;
    }).finally(() => { if (pending === flight) pending = undefined; });
    return flight.promise;
  };
  return { refresh, invalidate() { epoch++; } };
}

module.exports = { createInventoryRefresh };
