const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { RATE, wavFromSamples, createRecording, decodeSpeechAudio, shouldSpeak } = require('./voiceAudio.cjs');
const { createLocalErrorAudio, ERROR_AUDIO_TEXT } = require('./localErrorAudio.cjs');
const { createWakeProcess } = require('./voiceWakeProcess.cjs');
const { matchAnswer, questionSpeech } = require('./voiceAnswers.cjs');
const { OpenRouterError, readOpenRouterResponse, classifyTransportError, upstreamErrorInfo } = require('./openRouterErrors.cjs');
const { STT_MODEL, TTS_MODEL, TTS_VOICE, TTS_VOICES } = require('../shared/voiceConfig.cjs');
// "Hey Vibe" alone runs about 600 ms; more voiced pre-roll than this carries a command.
const PRE_ROLL_COMMAND_MS = 800;
const interactionKey = item => JSON.stringify([item?.sessionId ?? '', item?.generation ?? null, item?.id ?? item?.requestId ?? '', item?.revision ?? null]);
const sameInteraction = (a, b) => interactionKey(a) === interactionKey(b);
const sameRequest = (a, b) => !!a && !!b && a.sessionId === b.sessionId && a.generation === b.generation && a.id === b.id;
function answerContextFor(interaction) {
  const context = { interaction: structuredClone(interaction), index: 0, answers: {} };
  const questions = interaction.questions || [];
  for (const values of Array.isArray(interaction.partialAnswers) ? interaction.partialAnswers : []) {
    const question = questions[context.index];
    if (!question || !Array.isArray(values) || !values.length || values.some(value => typeof value !== 'string' || !value.trim())) break;
    context.answers[question.id || String(context.index)] = question.multiple ? [...values] : values[0];
    context.index++;
  }
  return context;
}
function createVoiceController({ orchestrator, getKey, getSettings = () => ({}), emit = () => {}, onAudio = () => {}, fetch: request = globalThis.fetch, modelPath = path.join(__dirname, '../vendor/voice'), keywordFactory, recordingOptions, errorAudio, now = Date.now } = {}) {
  let state = { phase: 'off', muted: true, ready: false, wakeReady: false, listening: false, transcript: '', reply: '', error: null, microphoneId: '' };
  let epoch = 0, wake = null, wakeStartup = null, recording = null, requestAbort = null, disposed = false, playbackTimer = null, playbackResolve = null, activeReply = null, activeInteraction = null;
  let speechQueue = Promise.resolve(), answerContext = null, announcementPending = null, wakeHistory = [], deferredTimer = null; const resolvedInteractions = new Set(), legacyResolvedIds = new Set(), announcedInteractions = new Set(), deferredInteractions = new Map();
  const alerts = errorAudio || createLocalErrorAudio({ directory: path.join(modelPath, 'alerts') });
  const lastErrorAudio = new Map();
  let deferredError = null;
  const snapshot = () => ({ ...state });
  const update = patch => { state = { ...state, ...patch }; emit(snapshot());
    if (deferredError && state.listening && ['listening', 'wake-error'].includes(state.phase)) {
      const pending = deferredError, scheduledEpoch = epoch; deferredError = null;
      queueMicrotask(() => { if (scheduledEpoch === epoch && enabled() && state.listening) void announceError(pending); });
    }
    if (['listening', 'wake-error'].includes(state.phase) && deferredInteractions.size && !deferredTimer) deferredTimer = setTimeout(() => {
      deferredTimer = null;
      if (!state.listening || !['listening', 'wake-error'].includes(state.phase) || answerContext) return;
      const entry = deferredInteractions.entries().next().value;
      if (entry) { deferredInteractions.delete(entry[0]); void announceInteraction(entry[1], true); }
    }, 200);
  };
  const enabled = () => !disposed && orchestrator?.getState?.().enabled !== false;
  const checkSpending = () => { const limit = getSettings().spendingLimit; const usage = orchestrator?.getState?.().usage || {}; if (limit != null && Object.values(usage).reduce((total, cost) => total + (Number(cost) || 0), 0) >= limit) throw Error('Session spending limit reached.'); };
  const idlePhase = () => state.listening ? (state.wakeReady ? 'listening' : 'wake-error') : 'off';
  const failureCategory = (error, operation) => error === 'Session spending limit reached.' ? 'spending-limit' : error === 'A relay request is already running.' ? 'busy' : operation;
  function resetRecording() { recording = null; }
  function cancelSpeech() {
    deferredError = null;
    epoch++; requestAbort?.abort(); requestAbort = null; clearTimeout(playbackTimer); playbackTimer = null; playbackResolve?.(); playbackResolve = null;
    if (activeReply) onAudio({ replyId: activeReply, sequence: 0, data: [], sampleRate: 24000, channels: 1, format: 's16le', cancelled: true, done: true });
    activeReply = null; activeInteraction = null; answerContext = null; wakeHistory = []; resetRecording(); wake?.reset();
    update({ phase: idlePhase(), replyId: undefined }); return { ok: true };
  }
  async function requestAudio(url, options, abort) {
    try { return await request(url, options); }
    catch (error) { throw classifyTransportError(error, { signal: abort.signal }); }
  }
  async function audioJson(response, abort) {
    try { return await readOpenRouterResponse(response); }
    catch (error) { throw classifyTransportError(error, { signal: abort.signal }); }
  }
  async function* audioChunks(body, abort) {
    try { for await (const chunk of body) yield chunk; }
    catch (error) { throw classifyTransportError(error, { signal: abort.signal }); }
  }
  async function announceError(info = {}) {
    if (!state.listening || !enabled()) return { ok: true, status: 'silent' };
    const operation = ['transcription', 'speech', 'orchestration'].includes(info.operation) ? info.operation : 'orchestration';
    const stage = operation === 'speech' ? 'The answer is ready, but speech playback failed.' : operation === 'transcription' ? 'I could not transcribe that.' : 'I could not complete that request.';
    // Reconstruct the bounded classifier message so provider bodies and keys cannot enter UI state.
    const local = ['not-understood', 'transcription', 'orchestration', 'speech', 'busy', 'spending-limit', 'answer'].includes(info.category);
    const safeDetail = local ? ERROR_AUDIO_TEXT[info.category] : new OpenRouterError(info.category, info.status).message;
    const message = (local ? safeDetail : `${stage} ${safeDetail}`).slice(0, 400);
    update({ error: message, errorOperation: operation });
    if (info.origin === 'monitor' && ['recording', 'awaiting-answer', 'transcribing', 'thinking', 'speaking', 'starting'].includes(state.phase)) {
      deferredError = info; return { ok: true, status: 'queued' };
    }
    // Every explicit voice attempt gets feedback, including repeated missed speech.
    if (info.origin !== 'voice' && lastErrorAudio.has(info.category) && now() - lastErrorAudio.get(info.category) < 60000) {
      if (state.phase === 'error' && !activeReply) update({ phase: idlePhase() });
      return { ok: true, status: 'duplicate' };
    }
    let clip;
    try { clip = alerts.load(info.category); }
    catch { wake?.reset(); update({ phase: idlePhase() }); return { ok: false, status: 'audio-unavailable', error: message }; }
    cancelSpeech();
    lastErrorAudio.set(info.category, now());
    const current = epoch, replyId = activeReply = randomUUID();
    update({ phase: 'speaking', reply: clip.text || '', replyId, error: message, errorOperation: operation });
    const finished = new Promise(resolve => { playbackResolve = resolve; playbackTimer = setTimeout(() => resolve({ error: 'Speech playback did not finish. Check your audio output.' }), clip.durationMs + 5000); });
    let sequence = 0;
    for (let start = 0; start < clip.pcm.length; start += 16384) {
      if (current !== epoch || !enabled() || !state.listening) return { ok: false, status: 'cancelled' };
      onAudio({ replyId, sequence: sequence++, data: Array.from(clip.pcm.subarray(start, start + 16384)), sampleRate: clip.sampleRate || 24000, channels: clip.channels || 1, format: 's16le', local: true });
    }
    onAudio({ replyId, sequence, data: [], sampleRate: 24000, channels: 1, format: 's16le', done: true, local: true });
    const playback = await finished;
    if (current !== epoch) return { ok: false, status: 'cancelled' };
    clearTimeout(playbackTimer); playbackTimer = null; playbackResolve = null; activeReply = null;
    wake?.reset(); update({ phase: idlePhase(), replyId: undefined, ...(playback?.error && { error: `${message} ${playback.error}` }) });
    if (playback?.error) return { ok: false, status: 'playback-failed', error: state.error };
    return { ok: true, status: 'announced', category: info.category };
  }
  function beginRecording(preRoll = []) {
    if (!state.listening || !enabled()) return { ok: false, error: 'Enable Orchestrator and the microphone first.' };
    cancelSpeech(); recording = createRecording({ ...recordingOptions, preRoll }); update({ phase: 'recording', transcript: '', error: null }); return { ok: true };
  }
  async function setListening(value) {
    if (!value) { update({ listening: false, muted: true }); cancelSpeech(); wakeStartup?.dispose?.(); wakeStartup = null; wake?.dispose?.(); wake = null; update({ wakeReady: false, phase: 'off' }); return { ok: true }; }
    if (state.listening && state.wakeReady && wake && enabled()) return { ok: true, wakeReady: true };
    const interrupted = () => state.phase === 'microphone-error'
      ? { ok: false, status: 'microphone-error', wakeReady: false, error: state.error }
      : { ok: false, status: 'cancelled', wakeReady: false };
    const activation = ++epoch;
    wakeStartup?.dispose?.(); wakeStartup = null;
    const key = await getKey?.();
    if (activation !== epoch || disposed) return interrupted();
    if (!enabled() || !key) { update({ ready: false, error: 'Enable Orchestrator and save an OpenRouter key to use voice.' }); return { ok: false, error: state.error }; }
    cancelSpeech(); update({ listening: true, muted: false, ready: true, microphoneId: getSettings().microphoneId || '', phase: 'starting', error: null });
    const startEpoch = epoch;
    try {
      if (!wake) {
        const startup = keywordFactory ? Promise.resolve(keywordFactory(modelPath)) : createWakeProcess({ modelPath,
          onDetected: () => { if (state.listening && state.phase === 'listening') beginRecording(wakeHistory); },
          onError: (_message, detail) => { wake = null; if (state.listening) update({ wakeReady: false, ...(['listening', 'starting'].includes(state.phase) ? { phase: 'wake-error' } : {}), wakeError: 'Wake detection stopped. Talk now is still available.', wakeErrorDetail: String(detail || '').slice(0, 500) || null }); },
        });
        wakeStartup = startup;
        const detector = await startup; if (wakeStartup === startup) wakeStartup = null;
        if (disposed || !state.listening || epoch !== startEpoch) { detector.dispose?.(); return interrupted(); }
        wake = detector;
      }
      update({ wakeReady: true, phase: 'listening', wakeError: null, wakeErrorDetail: null });
    } catch (startupError) {
      if (disposed || !state.listening || epoch !== startEpoch) return interrupted();
      wakeStartup = null;
      update({ wakeReady: false, phase: 'wake-error', wakeError: 'Hey Vibe is unavailable. Use Talk now, or repair the local wake model.', wakeErrorDetail: String(startupError?.detail || '').slice(0, 500) || null });
    }
    if (state.listening && epoch === startEpoch) {
      const pending = orchestrator.getState?.().requests;
      for (const interaction of Array.isArray(pending) ? pending : [...deferredInteractions.values()]) {
        if (interaction.state === 'pending' || !Array.isArray(pending)) void announceInteraction(interaction);
      }
    }
    return state.wakeReady ? { ok: true, wakeReady: true } : { ok: true, status: 'manual-only', wakeReady: false, error: state.wakeError };
  }
  async function sendAudio({ audioBase64, format = 'wav' } = {}) {
    if (!enabled() || !state.listening) return { ok: false, error: 'Voice is off.' };
    if (typeof audioBase64 !== 'string' || audioBase64.length < 60 || audioBase64.length > 2600000 || format !== 'wav') return { ok: false, error: 'Expected a WAV recording of at most 60 seconds.' };
    resetRecording();
    const current = ++epoch; requestAbort?.abort(); const abort = requestAbort = new AbortController();
    let key, operation = 'transcription';
    update({ phase: 'transcribing', error: null, errorOperation: null });
    try {
      key = await getKey(); if (!key) throw Error('OpenRouter key is missing.');
      const settings = getSettings();
      if (current !== epoch) return { ok: false, status: 'cancelled' };
      checkSpending();
      const response = await requestAudio('https://openrouter.ai/api/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(60000)]), body: JSON.stringify({ model: settings.sttModel || STT_MODEL, input_audio: { data: audioBase64, format }, ...(settings.language && settings.language !== 'auto' ? { language: settings.language } : {}) }) }, abort);
      const data = await audioJson(response, abort);
      if (current !== epoch || !enabled()) return { ok: false, status: 'cancelled' };
      orchestrator.recordSpeechUsage?.('transcription', data.usage?.cost);
      if (typeof data.text !== 'string') throw new OpenRouterError('upstream', response.status);
      const text = data.text.split(key).join('[REDACTED]').replace(/^\s*hey[ ,.!]*vibe\b[ ,.!:]*/i, '').trim();
      if (!/[\p{L}\p{N}]/u.test(text)) {
        update({ transcript: '' });
        if (answerContext && currentInteraction(answerContext)) {
          answerContext.answering = true;
          return { ok: true, status: 'empty', speech: await askQuestion(answerContext, "I didn't catch that. ") };
        }
        return { ok: true, status: 'empty', speech: await announceError({ category: 'not-understood', origin: 'voice', operation }) };
      }
      operation = 'orchestration';
      update({ phase: 'thinking', transcript: text });
      if (answerContext) return await submitAnswer(text, current);
      const result = await orchestrator.send({ text, origin: 'voice' });
      if (current === epoch && result?.ok === false && result.status !== 'cancelled' && !result.text) {
        await announceError({ ...(result.upstreamError || { category: failureCategory(result.error, operation) }), origin: 'voice', operation });
      }
      if (current === epoch && state.phase === 'thinking') update({ phase: idlePhase(), ...(result?.ok === false ? { error: result.error || 'Orchestrator could not respond.' } : {}) });
      return result;
    } catch (e) {
      if (current !== epoch || abort.signal.aborted) return { ok: false, status: 'cancelled' };
      const error = String(e.message || 'Voice request failed.');
      const safeError = key ? error.split(key).join('[REDACTED]') : error;
      update({ phase: 'error', errorOperation: operation, error: safeError });
      const upstreamError = upstreamErrorInfo(e);
      await announceError({ ...(upstreamError || { category: failureCategory(error, operation) }), origin: 'voice', operation });
      return { ok: false, operation, error: safeError, ...(upstreamError && { upstreamError }) };
    }
    finally { if (requestAbort === abort) requestAbort = null; }
  }
  function frames({ samples, sampleRate } = {}) {
    if (!state.listening || !enabled()) return { ok: false, status: 'off' };
    if (sampleRate !== RATE || !Array.isArray(samples) || !samples.length || samples.length > 8192 || samples.some(n => !Number.isFinite(n) || Math.abs(n) > 1.01)) return { ok: false, error: 'Invalid microphone frames.' };
    if (recording) {
      const progress = recording.push(samples);
      // A speaker who said the command in the same breath as the wake phrase leaves no
      // live speech to endpoint; transcription, not endpointing, judges that audio.
      const banked = progress === 'silence' && recording.preRollVoicedMs >= PRE_ROLL_COMMAND_MS;
      if (progress === 'silence' && !banked) { resetRecording(); answerContext = null; update({ transcript: '' }); void announceError({ category: 'not-understood', origin: 'voice', operation: 'transcription' }); }
      else if (progress === 'complete' || banked) { const data = recording.finish(); resetRecording(); void sendAudio({ audioBase64: wavFromSamples(data).toString('base64'), format: 'wav' }); }
    } else if (state.phase === 'listening') {
      wakeHistory.push(Float32Array.from(samples));
      while (wakeHistory.reduce((n, chunk) => n + chunk.length, 0) > RATE * 2) wakeHistory.shift();
      try { if (wake?.accept(samples)) beginRecording(wakeHistory); }
      catch { wake?.dispose?.(); wake = null; update({ phase: 'wake-error', wakeReady: false, wakeError: 'Wake detection stopped. Talk now is still available.' }); }
    }
    return { ok: true };
  }
  function speak(message = {}) {
    if (message.origin === 'interaction') message = { ...message, kind: 'interaction', id: message.requestId || message.id };
    const identity = message.interaction || { id: message.requestId || message.id, sessionId: message.sessionId, generation: message.generation, revision: message.revision };
    if (!message.preview && (!shouldSpeak(message) || !state.listening || !enabled())) return Promise.resolve({ ok: true, status: 'silent' });
    const queuedEpoch = epoch;
    const run = async () => {
      if (disposed || queuedEpoch !== epoch || (!message.preview && (!state.listening || !enabled()))) return { ok: false, status: 'cancelled' };
      if (message.kind === 'interaction') {
        if (!currentInteraction({ interaction: identity })) return { ok: false, status: 'resolved' };
        if (recording || (['transcribing', 'thinking'].includes(state.phase) && !message.answerFollowup)) return { ok: false, status: 'user-speaking' };
      }
      let text = String(message.text || '').trim().slice(0, 4000); if (!text) return { ok: true };
      let key;
      try { key = await getKey(); } catch { /* Report key-store failure without exposing details. */ }
      if (queuedEpoch !== epoch) return { ok: false, status: 'cancelled' };
      if (!key) {
        const error = 'Save an OpenRouter key before checking the voice.';
        wake?.reset(); update({ phase: idlePhase(), error, errorOperation: 'speech' });
        if (state.listening) await announceError({ category: 'auth', origin: 'voice', operation: 'speech' });
        return { ok: false, operation: 'speech', error };
      }
      text = text.split(key).join('[REDACTED]');
      const abort = requestAbort = new AbortController();
      const replyId = activeReply = randomUUID(); activeInteraction = message.kind === 'interaction' ? identity : null;
      update({ phase: 'speaking', reply: text, replyId, error: null, errorOperation: null }); let sequence = 0, bytes = 0;
      try {
        const settings = getSettings();
        checkSpending();
        if (settings.ttsModel && settings.ttsModel !== TTS_MODEL) throw Error(`Voice playback currently supports ${TTS_MODEL}. Select this speech model in Orchestrator settings.`);
        if (settings.voice && !TTS_VOICES.includes(settings.voice)) throw Error('Select a supported Kokoro voice in Orchestrator settings.');
        const response = await requestAudio('https://openrouter.ai/api/v1/audio/speech', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(120000)]), body: JSON.stringify({ model: settings.ttsModel || TTS_MODEL, input: text, voice: settings.voice || TTS_VOICE, response_format: 'pcm' }) }, abort);
        if (!response.ok) await audioJson(response, abort);
        if (!response.body) throw new OpenRouterError('upstream', response.status);
        const contentType = response.headers?.get?.('content-type') || '';
        if (/json/.test(contentType)) { await audioJson(response, abort); throw new OpenRouterError('upstream', response.status); }
        // Every type this gate admits must be one decodeSpeechAudio can decode, or the
        // reply dies here instead of playing: audio/vnd.wave was decodable but unreachable.
        // audio/L16 stays out: RFC 2586 makes it big-endian, which would play as noise.
        if (contentType && !/^(?:audio\/(?:pcm|wav|wave|x-wav|vnd\.wave)|application\/octet-stream)(?:\s*;|\s*$)/i.test(contentType)) throw new OpenRouterError('upstream', response.status);
        const chunks = [];
        for await (const raw of audioChunks(response.body, abort)) {
          if (queuedEpoch !== epoch || abort.signal.aborted) return { ok: false, status: 'cancelled' };
          bytes += raw.length;
          if (bytes > 48000 * 4 * 180 + 65536) throw Error('Speech exceeded the three-minute playback limit.');
          chunks.push(Buffer.from(raw));
        }
        if (queuedEpoch !== epoch) return { ok: false, status: 'cancelled' };
        if (!bytes) throw new OpenRouterError('upstream', response.status);
        const { pcm, sampleRate, channels, durationMs } = decodeSpeechAudio(Buffer.concat(chunks), contentType);
        const finished = new Promise(resolve => { playbackResolve = resolve; playbackTimer = setTimeout(() => resolve({ error: 'Speech playback did not finish. Check your audio output.' }), durationMs + 5000); });
        // One second per buffer bounds a three-minute reply to 180 playback nodes.
        const chunkBytes = sampleRate * channels * 2;
        for (let start = 0; start < pcm.length; start += chunkBytes) onAudio({ replyId, sequence: sequence++, data: Array.from(pcm.subarray(start, start + chunkBytes)), sampleRate, channels, format: 's16le' });
        onAudio({ replyId, sequence: sequence++, data: [], sampleRate, channels, format: 's16le', done: true });
        const generationId = response.headers?.get?.('x-generation-id');
        if (generationId) void request(`https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(generationId)}`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10000) }).then(r => r.ok ? r.json() : null).then(data => { if (!disposed) orchestrator.recordSpeechUsage?.('speech', data?.data?.total_cost); }).catch(() => {});
        // The renderer acknowledges actual playback end; timeout handles a lost renderer.
        const playback = await finished;
        clearTimeout(playbackTimer); playbackTimer = null; playbackResolve = null;
        if (queuedEpoch !== epoch) return { ok: false, status: 'cancelled' };
        if (playback?.error) throw Error(playback.error);
        if (queuedEpoch === epoch) { activeReply = null; activeInteraction = null; wake?.reset(); update({ phase: idlePhase(), replyId: undefined }); }
        return { ok: true };
      } catch (e) {
        if (queuedEpoch !== epoch || abort.signal.aborted) return { ok: false, status: 'cancelled' };
        clearTimeout(playbackTimer); playbackTimer = null; playbackResolve = null;
        onAudio({ replyId, sequence, data: [], sampleRate: 24000, channels: 1, format: 's16le', done: true, cancelled: true });
        const error = String(e.message || 'Speech failed.').split(key).join('[REDACTED]');
        activeReply = null; activeInteraction = null; update({ phase: 'error', errorOperation: 'speech', error });
        const upstreamError = upstreamErrorInfo(e);
        if (state.listening) await announceError({ ...(upstreamError || { category: failureCategory(error, 'speech') }), origin: 'voice', operation: 'speech' });
        else { wake?.reset(); update({ phase: idlePhase() }); }
        return { ok: false, operation: 'speech', error, ...(upstreamError && { upstreamError }) };
      } finally { if (requestAbort === abort) requestAbort = null; }
    };
    const result = speechQueue.then(run, run); speechQueue = result.catch(() => {}); return result;
  }
  function configure(patch = {}) {
    if (patch.playbackError && activeReply) { clearTimeout(playbackTimer); playbackResolve?.({ error: 'Speech playback failed. Check your audio output.' }); return { ok: true }; }
    if (patch.preview === true) {
      if (state.listening && !['listening', 'wake-error', 'error'].includes(state.phase)) return { ok: false, error: 'Finish the current voice turn before checking the voice.' };
      cancelSpeech();
      return speak({ preview: true, text: 'Hi, I’m Vibe. Say Hey Vibe when you need me, and I’ll help you with your workspace.' });
    }
    if (patch.playbackDone && patch.playbackDone === activeReply) { clearTimeout(playbackTimer); playbackResolve?.(); }
    if (patch.microphoneError) { update({ listening: false, muted: true }); cancelSpeech(); wakeStartup?.dispose?.(); wakeStartup = null; wake?.dispose?.(); wake = null; update({ phase: 'microphone-error', wakeReady: false, error: String(patch.microphoneError).slice(0, 200) }); }
    if (patch.manual) return beginRecording();
    if (patch.answerRequest && state.request) return announceInteraction(state.request, true);
    if (patch.cancelRecording) return cancelSpeech();
    return { ok: true };
  }
  function currentInteraction(context) {
    const requests = orchestrator.getState?.().requests;
    const item = context.interaction;
    return !resolvedInteractions.has(interactionKey(item)) && !(item.sessionId == null && legacyResolvedIds.has(item.id)) && (!Array.isArray(requests) || requests.some(r => sameInteraction(r, item) && r.state === 'pending'));
  }
  async function askQuestion(context, prefix = '') {
    if (!currentInteraction(context)) return { ok: false, status: 'resolved' };
    const result = await speak({ text: prefix + questionSpeech(context.interaction, context.index), kind: 'interaction', interaction: context.interaction, answerFollowup: !!context.answering });
    if (result.ok && currentInteraction(context) && state.listening) { answerContext = context; recording = createRecording({ ...recordingOptions, initialSilenceMs: 15000 }); update({ phase: 'awaiting-answer', request: { ...context.interaction, currentQuestion: context.index } }); }
    return result;
  }
  async function submitAnswer(text, current) {
    const context = answerContext;
    if (!context || !currentInteraction(context)) { answerContext = null; update({ phase: idlePhase() }); return { ok: false, status: 'resolved' }; }
    const interaction = context.interaction;
    context.answering = true;
    const question = interaction.questions?.[context.index] || { id: '0', options: [] };
    const answer = matchAnswer(text, question, interaction.kind);
    if (!answer.ok) return askQuestion(context, 'I could not match that answer. ');
    context.answers[question.id || String(context.index)] = answer.value;
    context.index++;
    if (interaction.kind !== 'permission' && context.index < (interaction.questions?.length || 0)) return askQuestion(context);
    if (current !== epoch || !currentInteraction(context)) return { ok: false, status: 'cancelled' };
    answerContext = null;
    const result = await orchestrator.dispatch({ kind: interaction.kind === 'permission' ? 'permission' : 'answer_question', targetId: interaction.sessionId, requestId: interaction.id, generation: interaction.generation, revision: interaction.revision, ...(interaction.kind === 'permission' ? { decision: answer.value } : { answers: context.answers }) });
    if (current === epoch && result.ok === false) await announceError({ category: 'answer', origin: 'voice', operation: 'orchestration' });
    if (current === epoch) { update({ phase: idlePhase(), ...(result.ok ? { request: undefined } : { error: result.error || 'Answer was not accepted. Please review it in the workspace.' }) }); }
    return result;
  }
  function resolveInteraction(identity) {
    // Raw IDs are supported only for old unscoped tests; production supplies the full identity.
    const legacy = typeof identity === 'string';
    const target = legacy ? { id: identity } : identity;
    if (!target?.id) return;
    if (legacy) { legacyResolvedIds.add(target.id); if (legacyResolvedIds.size > 512) legacyResolvedIds.delete(legacyResolvedIds.values().next().value); }
    const matches = item => !!item && (legacy ? item.sessionId == null && item.id === target.id : item.id === target.id && item.sessionId === target.sessionId && item.generation === target.generation && (target.revision == null || item.revision === target.revision));
    resolvedInteractions.add(interactionKey(target));
    for (const item of [state.request, activeInteraction, answerContext?.interaction, ...deferredInteractions.values(), ...(orchestrator.getState?.().requests || [])]) if (matches(item)) resolvedInteractions.add(interactionKey(item));
    for (const [key, item] of deferredInteractions) if (matches(item)) deferredInteractions.delete(key);
    while (resolvedInteractions.size > 512) resolvedInteractions.delete(resolvedInteractions.values().next().value);
    if (matches(state.request)) update({ request: undefined });
    if (matches(activeInteraction) || matches(answerContext?.interaction)) cancelSpeech();
  }
  function announceInteraction(interaction, repeat = false) {
    const key = interactionKey(interaction);
    if (!repeat && announcedInteractions.has(key)) return Promise.resolve({ ok: true, status: 'duplicate' });
    const context = answerContextFor(interaction);
    if (!currentInteraction(context)) return Promise.resolve({ ok: false, status: 'resolved' });
    // A mouse answer may advance the same native form while voice is still reading it.
    const supersedes = previous => sameRequest(previous, interaction) && previous.revision !== interaction.revision && (Number(interaction.revision) > Number(previous.revision) || !currentInteraction({ interaction: previous }));
    if ([activeInteraction, answerContext?.interaction, announcementPending?.interaction].some(supersedes)) {
      cancelSpeech(); announcementPending = null;
    }
    for (const [oldKey, item] of deferredInteractions) if (supersedes(item)) deferredInteractions.delete(oldKey);
    if (interaction.kind !== 'permission' && context.index >= (interaction.questions?.length || 0)) {
      if (sameRequest(state.request, interaction)) update({ request: undefined });
      return Promise.resolve({ ok: true, status: 'answered' });
    }
    if (!state.listening) { deferredInteractions.set(key, interaction); if (deferredInteractions.size > 20) deferredInteractions.delete(deferredInteractions.keys().next().value); return Promise.resolve({ ok: true, status: 'silent' }); }
    announcedInteractions.add(key); if (announcedInteractions.size > 512) announcedInteractions.delete(announcedInteractions.values().next().value);
    deferredInteractions.delete(key);
    if (announcementPending || !['listening', 'wake-error', 'error'].includes(state.phase)) { deferredInteractions.set(key, interaction); if (deferredInteractions.size > 20) deferredInteractions.delete(deferredInteractions.keys().next().value); return Promise.resolve({ ok: true, status: 'queued' }); }
    announcementPending = context;
    update({ request: interaction }); return askQuestion(context).finally(() => { if (announcementPending === context) announcementPending = null; });
  }
  function dispose() { disposed = true; state.listening = false; clearTimeout(deferredTimer); deferredTimer = null; deferredInteractions.clear(); cancelSpeech(); wakeStartup?.dispose?.(); wakeStartup = null; wake?.dispose?.(); wake = null; }
  return { getState: snapshot, configure, setListening, frames, sendAudio, cancelSpeech, speak, announceError, announceInteraction, resolveInteraction, dispose };
}
module.exports = { createVoiceController, STT_MODEL, TTS_MODEL };
