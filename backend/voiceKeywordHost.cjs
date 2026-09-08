async function run() {
  let detector;
  process.on('message', async message => {
    try {
      if (message.type === 'init') {
        const { loadVoiceModels } = require('./voiceModels.cjs');
        const { createKeywordDetector } = require('./voiceKeywordModel.cjs');
        detector = createKeywordDetector({ paths: await loadVoiceModels(message.modelPath, { groups: ['keyword', 'vad'] }) });
        process.send?.({ type: 'ready' });
      } else if (message.type === 'frame' && detector) {
        process.send?.({ type: 'frame', id: message.id, result: detector.process(message.frame) });
      }
    } catch (error) {
      const clean = value => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 240) : undefined;
      process.send?.({ type: 'error', helper: 'keyword', stage: message.type === 'init' ? 'init' : 'stream', error: { name: clean(error?.name), message: clean(error?.message), code: clean(error?.code) } });
    }
  });
  process.on('disconnect', () => { detector?.dispose(); process.exit(0); });
}
if (require.main === module) run();
module.exports = { run };
