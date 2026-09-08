const test = require('node:test');
const assert = require('node:assert/strict');
const { spokenText } = require('../../backend/voiceText.cjs');
const { createVoiceController } = require('../../backend/voiceController.cjs');

test('speech removes Markdown emphasis, headings, lists, quotes and link destinations', () => {
  const source = '# **Status**\n\n> The ***build*** is _ready_.\n- **Passed**: `npm test`\n* [x] ~~Old~~ __New__ check\n1) Read [the docs](https://example.com/docs_(v2)).\n![diagram](chart.png)\n[Details][ref]\n\n[ref]: https://example.com\n---';
  assert.equal(spokenText(source), 'Status The build is ready. Passed: npm test Old New check 1. Read the docs. diagram Details');
  assert.equal(spokenText('**A** and *B* and _C_.'), 'A and B and C.');
  assert.equal(spokenText('**bold *italic***'), 'bold italic');
  assert.equal(spokenText('*italic **bold***'), 'italic bold');
  assert.equal(spokenText('***a** b*'), 'a b');
  assert.equal(spokenText('Title\n=====\nNext\n-----\nDone'), 'Title Next Done');
});

test('speech preserves code, escaped literals, identifiers, URLs and math', () => {
  const source = 'Use `file_name` and `**/*.js`.\n```sh\necho "**literal**"\n2 * 3 * 4\n```\nKeep file_name_here, *.js, 2 * 3 * 4, C:\\work\\file_name. Say \\*literal\\* and <https://example.com/a_b>.';
  assert.equal(spokenText(source), 'Use file_name and **/*.js. echo "**literal**" 2 * 3 * 4 Keep file_name_here, *.js, 2 * 3 * 4, C:\\work\\file_name. Say *literal* and https://example.com/a_b.');
  assert.equal(spokenText('~~~js\nconst x = "*raw*";\n~~~'), 'const x = "*raw*";');
  assert.equal(spokenText('```sh\necho **literal**'), 'echo **literal**');
  assert.equal(spokenText('Hello! How can I help?'), 'Hello! How can I help?');
  assert.equal(spokenText('---\n***\n___'), '');
});

test('speech preserves shorter backtick runs inside matched code spans', () => {
  assert.equal(spokenText('Run ``echo `date` ``.'), 'Run echo `date` .');
  assert.equal(spokenText('Use ```one `two` and ``three`` end```.'), 'Use one `two` and ``three`` end.');
  assert.equal(spokenText('**Run** ``echo `date` and **/*.js`` then *stop*.'), 'Run echo `date` and **/*.js then stop.');
  assert.equal(spokenText('Keep ``unmatched `ticks`.'), 'Keep ``unmatched ticks.');
  assert.equal(spokenText('Keep `unmatched``.'), 'Keep `unmatched``.');
  assert.equal(spokenText('Keep ``unmatched```.'), 'Keep ``unmatched```.');
});

test('speech retains exponentiation alongside ordinary emphasis', () => {
  assert.equal(spokenText('2 ** 3 ** 4'), '2 ** 3 ** 4');
  assert.equal(spokenText('**Compute** 2 ** 3 ** 4, then *finish* and _check_.'), 'Compute 2 ** 3 ** 4, then finish and check.');
  assert.equal(spokenText('Use 2 * 3 * 4 and 2 *** 3 *** 4 with ***care***.'), 'Use 2 * 3 * 4 and 2 *** 3 *** 4 with care.');
});

test('controller sends plain speech while retaining displayed Markdown and redaction', async t => {
  const calls = [], states = [];
  let controller;
  controller = createVoiceController({
    orchestrator: { getState: () => ({ enabled: false }) },
    getKey: () => 'fixture-secret', getSettings: () => ({}),
    emit: state => states.push(state),
    fetch: async (_url, options) => {
      calls.push(JSON.parse(options.body));
      return { ok: true, headers: new Headers({ 'content-type': 'audio/pcm' }), body: (async function* () { yield Buffer.from([0, 0]); })() };
    },
    onAudio: chunk => { if (chunk.done) queueMicrotask(() => controller.configure({ playbackDone: chunk.replyId })); },
  });
  t.after(() => controller.dispose());
  const message = { preview: true, text: '**Ready**. Run `npm test`. fixture-secret' };
  assert.equal((await controller.speak(message)).ok, true);
  assert.equal(calls[0].input, 'Ready. Run npm test. [REDACTED]');
  assert(states.some(state => state.reply === '**Ready**. Run `npm test`. [REDACTED]'));
  assert.equal(message.text, '**Ready**. Run `npm test`. fixture-secret');
  assert.equal((await controller.speak({ preview: true, text: '---\n***' })).ok, true);
  assert.equal(calls.length, 1, 'formatting-only replies do not request empty speech');
  const detailed = { preview: true, text: '# Full result\n' + 'Implementation detail. '.repeat(160), speechText: 'The agent reports the fix is complete. All seven checks passed.' };
  assert.equal((await controller.speak(detailed)).ok, true);
  assert.equal(calls[1].input, detailed.speechText, 'TTS uses the separate summary instead of the full result');
  assert.equal(detailed.text, '# Full result\n' + 'Implementation detail. '.repeat(160), 'written source stays intact');
  const modelSummary = 'The agent reports a relevant finding with its verification details. '.repeat(75) + 'The final blocker still needs attention.';
  assert.ok(modelSummary.length > 4000);
  assert.equal((await controller.speak({ preview: true, text: detailed.text, speechText: modelSummary })).ok, true);
  assert.equal(calls[2].input, modelSummary, 'model-chosen speech is not clipped by a presentation character cap');
});
