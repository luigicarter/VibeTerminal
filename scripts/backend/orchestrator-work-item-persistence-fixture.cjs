'use strict';
const fs = require('node:fs');
const assert = require('node:assert/strict');

// Observe actual atomic commits without repeatedly opening the destination.
// Repeated destination reads can contend with Windows rename while a loaded
// test runner also makes fixed sleep durations unrelated to persistence progress.
function observeWorkItemCommits(t, file, runtime) {
  const rename = fs.promises.rename.bind(fs.promises);
  let latest;
  const listeners = new Set();
  t.mock.method(fs.promises, 'rename', async (from, to) => {
    if (to !== file) return rename(from, to);
    const payload = JSON.parse(await fs.promises.readFile(from, 'utf8'));
    const result = await rename(from, to);
    latest = payload;
    for (const listener of [...listeners]) listener();
    return result;
  });
  return {
    latest: () => latest,
    waitFor(predicate, description) {
      return new Promise((resolve, reject) => {
        const finish = () => {
          const item = latest?.items.find(predicate);
          if (!item) return;
          clearTimeout(timer); listeners.delete(finish); resolve(item);
        };
        const timer = setTimeout(() => {
          listeners.delete(finish);
          reject(new Error(`No committed work item matched ${description}. ${JSON.stringify({ latest, runtime: runtime() })}`));
        }, 10000);
        listeners.add(finish); finish();
      });
    },
    async verifyDisk() {
      assert.deepEqual(JSON.parse(await fs.promises.readFile(file, 'utf8')), latest);
    }
  };
}
module.exports = { observeWorkItemCommits };
