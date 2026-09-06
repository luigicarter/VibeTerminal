async function run() {
  let detector;
  process.on('message', async message => {
    try {
      if (message.type === 'init') {
        const { loadVoiceModels } = require('./voiceModels.cjs');
        const { createTurnDetector } = require('./voiceTurnModel.cjs');
        const paths = await loadVoiceModels(message.modelPath);
        detector = await createTurnDetector({ modelPath: paths.turn.model });
        process.send?.({ type: 'ready' });
      } else if (message.type === 'analyze' && detector) {
        process.send?.({ type: 'result', id: message.id, result: await detector.predict(message.samples) });
      }
    } catch { process.send?.({ type: 'error' }); }
  });
  process.on('disconnect', () => { detector?.dispose(); process.exit(0); });
}
if (require.main === module) run();
module.exports = { run };
