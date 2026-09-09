'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createVoiceController } = require('../../backend/voiceController.cjs');
const { wavFromSamples } = require('../../backend/voiceAudio.cjs');
const tick = () => new Promise(setImmediate);
async function until(check) { for (let n = 0; n < 150; n++) { if (check()) return; await tick(); } assert.fail('Condition did not settle'); }

async function fixture(t, type = 'audio/pcm;rate=24000;channels=1', onChunk) {
  const f = { calls: [], audio: [], tasks: [] };
  const body = new ReadableStream({ start(stream) { f.stream = stream; } });
  f.voice = createVoiceController({
    orchestrator: { getState: () => ({ enabled: true, tasks: f.tasks }) },
    getKey: () => 'test-key', getSettings: () => ({ voice: 'af_bella' }),
    fetch: async (_, init) => { f.calls.push(JSON.parse(init.body)); return new Response(body, { headers: { 'content-type': type } }); },
    onAudio: chunk => { f.audio.push(chunk); onChunk?.(chunk, f); },
    errorAudio: { load: () => null }
  });
  f.speak = extras => f.voice.speak({ origin: 'voice', kind: 'reply', requestId: 'r1', text: 'Completed the entire instruction.', speechText: 'A verbose result summary.', completionCue: true, ...extras });
  f.finish = async () => { await until(() => f.audio.some(chunk => chunk.done && !chunk.cancelled)); f.voice.configure({ playbackDone: f.audio.find(chunk => chunk.done).replyId }); };
  t.after(() => f.voice.dispose()); await f.voice.setListening(true); return f;
}

for (const [rate, channels] of [[24000, 1], [44100, 2]]) test(`completion prefixes one soft ding before streamed speech at ${rate} Hz/${channels} channels`, async t => {
  const f = await fixture(t, `audio/pcm;rate=${rate};channels=${channels}`);
  let settled = false;
  const speaking = f.speak().then(result => { settled = true; return result; });
  await until(() => f.calls.length);
  assert.equal(f.calls[0].input, 'done'); assert.equal(f.calls[0].voice, 'af_bella');
  const speech = Buffer.alloc(rate * channels * 2, 21);
  f.stream.enqueue(speech.subarray(0, Math.ceil(rate / 10) * channels * 2));
  await until(() => f.audio.length >= 2);
  const cue = f.audio[0]; const cueBytes = Buffer.from(cue.data);
  assert.equal(cueBytes.length, (Math.round(rate * 0.2) + Math.round(rate * 0.06)) * channels * 2);
  assert(cueBytes.some(byte => byte !== 0));
  assert(cueBytes.subarray(Math.round(rate * 0.2) * channels * 2).every(byte => byte === 0));
  for (let offset = 0; offset < cueBytes.length; offset += channels * 2) {
    const sample = cueBytes.readInt16LE(offset); assert(Math.abs(sample) < 4000);
    if (channels === 2) assert.equal(sample, cueBytes.readInt16LE(offset + 2));
  }
  f.stream.enqueue(speech.subarray(Math.ceil(rate / 10) * channels * 2)); f.stream.close();
  await until(() => f.audio.some(chunk => chunk.done));
  assert.equal(settled, false);
  assert.deepEqual(Buffer.concat(f.audio.slice(1).map(chunk => Buffer.from(chunk.data))), speech);
  assert(f.audio.every((chunk, index) => chunk.replyId === cue.replyId && chunk.sequence === index && chunk.sampleRate === rate && chunk.channels === channels && chunk.format === 's16le'));
  await f.finish(); assert.equal((await speaking).ok, true); assert.equal(f.voice.getState().reply, 'done');
});

test('WAV completion waits for decoded format and prefixes at the WAV sample rate', async t => {
  const f = await fixture(t, 'audio/wav'); const speaking = f.speak(); await until(() => f.calls.length);
  const wav = wavFromSamples(new Float32Array(1600).fill(0.1), 16000);
  f.stream.enqueue(wav); await tick(); assert.equal(f.audio.length, 0); f.stream.close();
  await f.finish(); assert.equal((await speaking).ok, true);
  assert(f.audio.every(chunk => chunk.sampleRate === 16000 && chunk.channels === 1));
  assert.deepEqual(Buffer.from(f.audio[1].data), wav.subarray(44));
});

for (const extras of [{ completionCue: false }, { completionCue: 'true' }, { responseTurn: 'listen' }, { kind: 'error' }, { error: 'failed' }, { question: { id: 'q1', requestId: 'r1', text: 'Which folder?' } }]) {
  test(`ordinary/guarded reply retains speech without a ding: ${JSON.stringify(extras)}`, async t => {
    const f = await fixture(t); if (extras.question) f.tasks.push({ requestId: 'r1', status: 'needs-answer', question: extras.question });
    const speaking = f.speak(extras); await until(() => f.calls.length);
    f.stream.enqueue(Buffer.alloc(4800, 7)); f.stream.close(); await f.finish(); assert.equal((await speaking).ok, true);
    assert.equal(f.calls[0].input, 'A verbose result summary.'); assert.equal(f.audio.filter(chunk => chunk.data.length).length, 1);
  });
}

test('muted and dismissed completions produce no ding or TTS', async t => {
  const f = await fixture(t); await f.voice.setListening(false);
  assert.equal((await f.speak()).status, 'silent'); assert.equal(f.calls.length, 0); assert.equal(f.audio.length, 0);
  await f.voice.setListening(true); await f.speak({ responseTurn: 'dismiss' }); assert.equal(f.calls.length, 0); assert.equal(f.audio.length, 0);
});

test('cancelling on the ding fences speech and retires the same reply', async t => {
  const f = await fixture(t, undefined, (chunk, context) => { if (chunk.data.length) context.voice.cancelSpeech(); });
  const speaking = f.speak(); await until(() => f.calls.length); f.stream.enqueue(Buffer.alloc(4800));
  assert.equal((await speaking).status, 'cancelled'); assert.equal(f.audio.filter(chunk => chunk.data.length).length, 1);
  assert(f.audio.some(chunk => chunk.cancelled && chunk.replyId === f.audio[0].replyId));
});

test('muting during TTS loading prevents a late cue', async t => {
  const f = await fixture(t); const speaking = f.speak(); await until(() => f.calls.length);
  await f.voice.setListening(false); assert.equal((await speaking).status, 'cancelled');
  assert.equal(f.audio.filter(chunk => chunk.data.length).length, 0);
});
