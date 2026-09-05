'use strict';
// App-owned, hidden Node helper. Native inference never runs in Electron main.
const { createWakeDetector } = require('./voiceWake.cjs');
let detector = null;
function reply(message) { if (process.connected) process.send(message); }
process.on('message', message => {
  try {
    if (message?.type === 'init') { detector = createWakeDetector(message.modelPath); reply({ type: 'ready' }); }
    else if (message?.type === 'reset') detector?.reset();
    else if (message?.type === 'frames') {
      if (!detector) throw Error('Wake model is not ready.');
      const found = detector.accept(message.samples);
      reply({ type: 'result', id: message.id, generation: message.generation, found });
    } else if (message?.type === 'dispose') { detector?.dispose(); detector = null; process.exit(0); }
  } catch {
    reply({ type: 'error', error: 'Local wake inference failed. Talk now is still available.' });
    detector?.dispose(); detector = null; process.exitCode = 1;
    process.disconnect();
  }
});
process.on('disconnect', () => { detector?.dispose(); process.exit(); });
