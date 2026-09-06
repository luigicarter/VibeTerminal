async function run() {
  let detector;
  process.on('message', async message => {
    try {
      if (message.type === 'init') {
        const { loadVoiceModels } = require('./voiceModels.cjs');
        const { createKeywordDetector } = require('./voiceKeywordModel.cjs');
        detector = createKeywordDetector({ paths: await loadVoiceModels(message.modelPath) });
        process.send?.({ type: 'ready' });
      } else if (message.type === 'frame' && detector) {
        process.send?.({ type: 'frame', id: message.id, result: detector.process(message.frame) });
      }
    } catch { process.send?.({ type: 'error' }); }
  });
  process.on('disconnect', () => { detector?.dispose(); process.exit(0); });
}
if (require.main === module) run();
module.exports = { run };
