async function run() {
  let detector;
  process.on('message', async message => {
    try {
      if (message.type === 'init') {
        const { loadVoiceModels } = require('./voiceModels.cjs');
        const { createTurnDetector } = require('./voiceTurnModel.cjs');
        const paths = await loadVoiceModels(message.modelPath, { groups: ['turn'] });
        detector = await createTurnDetector({ modelPath: paths.turn.model });
        process.send?.({ type: 'ready' });
      } else if (message.type === 'analyze' && detector) {
        process.send?.({ type: 'result', id: message.id, result: await detector.predict(message.samples) });
      }
    } catch (error) {
      const clean = value => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 240) : undefined;
      process.send?.({ type: 'error', helper: 'completion', stage: message.type === 'init' ? 'init' : 'completion', error: { name: clean(error?.name), message: clean(error?.message), code: clean(error?.code) } });
    }
  });
  process.on('disconnect', () => { detector?.dispose(); process.exit(0); });
}
if (require.main === module) run();
module.exports = { run };
