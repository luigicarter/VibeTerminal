const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { RATE, wavFromSamples, createRecording, decodeSpeechAudio, shouldSpeak } = require('./voiceAudio.cjs');
const { createLocalErrorAudio, ERROR_AUDIO_TEXT } = require('./localErrorAudio.cjs');
const { matchAnswer, questionSpeech } = require('./voiceAnswers.cjs');
const { spokenText } = require('./voiceText.cjs');
const { isVoiceDismissal } = require('../shared/voiceDismissal.cjs');
const { OpenRouterError, readOpenRouterResponse, classifyTransportError, upstreamErrorInfo } = require('./openRouterErrors.cjs');
const { STT_MODEL, TTS_MODEL, TTS_VOICE, TTS_VOICES } = require('../shared/voiceConfig.cjs');
// A push-to-talk hold shorter than this carries no command; it is a tap, not speech.
const MIN_VOICED_MS = 250;
const AUTOMATIC_PAUSE_MS = 1200;
const AUTOMATIC_FALLBACK_MS = 3000;
// A question left unanswered this long gets the missed-speech alert, as before.
const ANSWER_SILENCE_MS = 15000;
// Microphone history kept while idle so the first syllable after the key survives.
const RECENT_AUDIO_MS = 2000;
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
function createVoiceController({ orchestrator, getKey, getSettings = () => ({}), emit = () => {}, onAudio = () => {}, fetch: request = globalThis.fetch, modelPath = path.join(__dirname, '../vendor/voice'), recordingOptions, errorAudio, now = Date.now, inferenceFactory = options => require('./voiceInferenceService.cjs').createVoiceInferenceService(options) } = {}) {
  let state = { phase: 'off', muted: true, ready: false, listening: false, transcript: '', reply: '', error: null, microphoneId: '', handsFreeStatus: 'off', handsFreeError: null, recordingSource: undefined, finishHint: false };
  let epoch = 0, recording = null, requestAbort = null, disposed = false, playbackTimer = null, playbackResolve = null, activeReply = null, activeInteraction = null;
  let turn = null, turnSequence = 0, inference = null, inferenceGeneration = 0, streamId = 0, detectionMode = null, captureToken, samplePosition = 0, startupPromise = null, activeAnalysis = null;
  let speechQueue = Promise.resolve(), answerContext = null, announcementPending = null, recentAudio = [], answerSilenceMs = 0, deferredTimer = null; const resolvedInteractions = new Set(), legacyResolvedIds = new Set(), announcedInteractions = new Set(), deferredInteractions = new Map();
  const alerts = errorAudio || createLocalErrorAudio({ directory: path.join(modelPath, 'alerts') });
  const lastErrorAudio = new Map();
  let deferredError = null, speechGeneration = 0, activeSpeechRequestId = null;
  const cancelledSpeechRequests = new Set(), speechWaiters = new Set();
  const snapshot = () => ({ ...state });
  const update = patch => { const previousPhase = state.phase; state = { ...state, ...patch }; emit(snapshot());
    for (const wake of speechWaiters) wake(); speechWaiters.clear();
    if (state.phase !== previousPhase) { if (previousPhase === 'speaking' || state.phase === 'speaking') recentAudio = []; syncDetectionMode(true); queueMicrotask(() => { if (!disposed) void refreshHandsFree(); }); }
    if (deferredError && state.listening && state.phase === 'listening') {
      const pending = deferredError, scheduledEpoch = epoch; deferredError = null;
      queueMicrotask(() => { if (scheduledEpoch === epoch && enabled() && state.listening) void announceError(pending); });
    }
    if (state.phase === 'listening' && deferredInteractions.size && !deferredTimer) deferredTimer = setTimeout(() => {
      deferredTimer = null;
      if (!state.listening || state.phase !== 'listening' || answerContext) return;
      const entry = deferredInteractions.entries().next().value;
      if (entry) { deferredInteractions.delete(entry[0]); void announceInteraction(entry[1], true); }
    }, 200);
  };
  const enabled = () => !disposed && orchestrator?.getState?.().enabled !== false;
  const checkSpending = () => { const limit = getSettings().spendingLimit; const usage = orchestrator?.getState?.().usage || {}; if (limit != null && Object.values(usage).reduce((total, cost) => total + (Number(cost) || 0), 0) >= limit) throw Error('Session spending limit reached.'); };
  const idlePhase = () => state.listening ? 'listening' : 'off';
  const failureCategory = (error, operation) => error === 'Session spending limit reached.' ? 'spending-limit' : error === 'A relay request is already running.' ? 'busy' : operation;
  // Diagnostics are best-effort and never receive recorded or spoken content.
  function diagnostic(stage, error, details = {}, key) {
    try {
      if (error?.name === 'AbortError' || ['Session spending limit reached.', 'A relay request is already running.'].includes(error?.message)) return;
      const clean = value => typeof value === 'string' && key ? value.split(key).join('[REDACTED]') : value;
      const settings = getSettings();
      const result = orchestrator?.recordDiagnostic?.({ event: 'voice_error', origin: 'voice', stage, status: 'failed',
        ...(stage === 'transcription' ? { model: settings.sttModel || STT_MODEL } : stage === 'speech' ? { model: settings.ttsModel || TTS_MODEL } : {}),
        category: error?.category, httpStatus: error?.status, reason: error?.reason, ...details,
        error: { name: clean(error?.name), message: clean(error?.message), code: clean(error?.code), stack: clean(error?.stack) } });
      Promise.resolve(result).catch(() => {});
    } catch { /* Logging must not affect the voice lifecycle. */ }
  }
  function captureDiagnostic(stage, reason) {
    if (!turn?.source) return;
    try { Promise.resolve(orchestrator?.recordDiagnostic?.({ event: 'voice_recording', origin: 'voice', stage, reason, recordingSource: turn.source, recordingId: turn.id, elapsedMs: turn.elapsedMs || 0, voicedMs: turn.voicedMs || 0, silenceMs: turn.silenceMs || 0 })).catch(() => {}); } catch { /* Best effort. */ }
  }
  function resetRecording(reason = 'cancelled', stage = reason === 'cancelled' ? 'cancel' : 'finish') { captureDiagnostic(stage, reason); recording = null; turn = null; state.recordingSource = undefined; state.recordingId = undefined; state.finishHint = false; }
  function syncDetectionMode(force = false) {
    const mode = state.listening && state.handsFreeStatus === 'ready' ? (recording ? turn?.manual ? null : 'vad' : state.phase === 'listening' && getSettings().handsFreeEnabled ? 'wake' : state.phase === 'awaiting-answer' ? 'vad' : null) : null;
    if (force || mode !== detectionMode) { streamId++; detectionMode = mode; }
  }
  function stopInference() {
    inferenceGeneration++; const service = inference; inference = null; startupPromise = null; activeAnalysis = null;
    try { Promise.resolve(service?.dispose ? service.dispose() : service?.stop?.()).catch(() => {}); } catch { /* Already stopped. */ }
    detectionMode = null; streamId++;
  }
  function inferenceFailed(error, generation = inferenceGeneration) {
    if (generation !== inferenceGeneration || disposed) return;
    diagnostic('hands-free', error instanceof Error ? error : Error(String(error)));
    stopInference();
    if (turn && !turn.manual) { resetRecording(); answerContext = null; answerSilenceMs = 0; }
    update({ handsFreeStatus: 'unavailable', handsFreeError: 'Hands-free detection is unavailable. Use Space to talk, or toggle hands-free to retry.', ...(state.phase === 'recording' && !recording ? { phase: idlePhase(), error: 'Automatic recording cancelled. Hold Space to try again.' } : {}) });
  }
  async function refreshHandsFree() {
    if (!state.listening || !enabled() || (!getSettings().handsFreeEnabled && !answerContext)) {
      stopInference();
      if (turn && !turn.manual) { resetRecording(); update({ phase: answerContext ? 'awaiting-answer' : idlePhase() }); }
      update({ handsFreeStatus: 'off', handsFreeError: null }); return { ok: true };
    }
    if (inference && state.handsFreeStatus === 'ready') return { ok: true };
    if (state.handsFreeStatus === 'unavailable') return { ok: false, status: 'unavailable' };
    if (startupPromise) return startupPromise;
    const generation = ++inferenceGeneration;
    update({ handsFreeStatus: 'loading', handsFreeError: null });
    startupPromise = Promise.resolve().then(async () => {
      try {
        if (generation !== inferenceGeneration || disposed || !state.listening) return { ok: false, status: 'cancelled' };
        const service = inferenceFactory({ modelPath, onFrame: event => { if (generation === inferenceGeneration) inferenceFrame(event); }, onError: error => inferenceFailed(error, generation), onDiagnostic: details => {
          if (generation !== inferenceGeneration) return;
          const bounded = {};
          for (const field of ['processingMs', 'queuedSamples', 'totalMs', 'preprocessingMs', 'inferenceMs']) if (Number.isFinite(details?.[field])) bounded[field] = Math.max(0, Math.min(1e9, details[field]));
          if (Number.isFinite(details?.probability)) bounded.probability = Math.max(0, Math.min(1, details.probability));
          try { Promise.resolve(orchestrator?.recordDiagnostic?.({ event: 'voice_inference', origin: 'voice', stage: ['stream', 'completion', 'error'].includes(details?.type) ? details.type : 'inference', ...bounded })).catch(() => {}); } catch { /* Best effort. */ }
        } });
        inference = service; await service.start();
        if (generation !== inferenceGeneration || disposed) return { ok: false, status: 'cancelled' };
        update({ handsFreeStatus: 'ready', handsFreeError: null }); syncDetectionMode(true);
        return { ok: true };
      } catch (error) { inferenceFailed(error, generation); return { ok: false, status: 'unavailable' }; }
      finally { if (generation === inferenceGeneration) startupPromise = null; }
    });
    return startupPromise;
  }
  function beginAutomatic(source, event) {
    const preRoll = recentAudio; recentAudio = [];
    recording = createRecording({ ...recordingOptions, maxMs: 60000, preRoll, endpointing: false });
    turn = { id: ++turnSequence, source, manual: false, speechRevision: 0, voicedMs: 0, silenceMs: 0, elapsedMs: 0, commandSpeech: source === 'answer', lastFrameEnd: event?.sampleEnd ?? samplePosition, pending: false, analyzedRevision: null };
    captureDiagnostic('start', source);
    answerSilenceMs = 0;
    update({ phase: 'recording', recordingSource: source, recordingId: turn.id, finishHint: false, transcript: '', error: null });
  }
  function cancelAutomatic(message) {
    resetRecording(); answerContext = null; answerSilenceMs = 0;
    update({ phase: idlePhase(), error: message, transcript: '' }); syncDetectionMode(true);
  }
  function inferenceFrame(event = {}) {
    if (!inference || state.handsFreeStatus !== 'ready' || event.streamId !== streamId || event.captureToken !== captureToken || !Number.isFinite(event.sampleStart) || !Number.isFinite(event.sampleEnd) || event.sampleEnd <= event.sampleStart || event.sampleEnd > samplePosition) return;
    if (!recording && state.phase === 'listening' && event.wake) { beginAutomatic('wake', event); return; }
    if (!recording && state.phase === 'awaiting-answer' && event.speech && answerContext && currentInteraction(answerContext)) { beginAutomatic('answer', event); turn.voicedMs = (event.sampleEnd - event.sampleStart) / RATE * 1000; return; }
    if (!recording && state.phase === 'awaiting-answer' && !event.speech) { accountAnswerSilence((event.sampleEnd - event.sampleStart) / RATE * 1000); return; }
    if (!recording || !turn || turn.manual || event.sampleEnd <= turn.lastFrameEnd) return;
    const duration = (event.sampleEnd - Math.max(event.sampleStart, turn.lastFrameEnd)) / RATE * 1000;
    turn.lastFrameEnd = event.sampleEnd;
    if (event.speech) {
      turn.voicedMs += duration; turn.silenceMs = 0; turn.commandSpeech = true; turn.speechRevision++; turn.completionReady = false;
      if (state.finishHint) update({ finishHint: false });
    } else turn.silenceMs += duration;
    if (finishAnalyzedTurn()) return;
    if (turn.commandSpeech && turn.silenceMs >= AUTOMATIC_FALLBACK_MS && turn.lastFrameEnd >= samplePosition) {
      if (turn.voicedMs >= MIN_VOICED_MS) finishRecording('silence-fallback');
      else {
        resetRecording('short-speech', 'cancel'); answerSilenceMs = 0;
        const context = answerContext && currentInteraction(answerContext) ? answerContext : null;
        answerContext = context;
        update({ phase: context ? 'awaiting-answer' : idlePhase(), transcript: '', error: 'I did not catch enough speech. Please try again, or hold Space.' });
        if (context) void askQuestion(context, 'I did not catch enough speech. ');
        else void announceError({ category: 'not-understood', origin: 'voice', operation: 'transcription' });
      }
      return;
    }
    if (turn.silenceMs >= 3000 && !state.finishHint) update({ finishHint: true });
    // Wake history is retained for transcription, but never charged as live silence.
    if (!turn.commandSpeech && turn.elapsedMs >= 6000 && turn.silenceMs >= AUTOMATIC_PAUSE_MS && turn.lastFrameEnd >= samplePosition) { finishRecording('wake-grace'); return; }
    if (turn.silenceMs >= 200 && turn.commandSpeech) void analyzeTurn();
  }
  async function analyzeTurn() {
    const currentTurn = turn, service = inference, generation = inferenceGeneration;
    if (!currentTurn || currentTurn.manual || activeAnalysis || currentTurn.pending || currentTurn.completionReady || !recording || !service || currentTurn.analyzedRevision === currentTurn.speechRevision) return;
    currentTurn.pending = true; currentTurn.analyzedRevision = currentTurn.speechRevision;
    const identity = { captureToken, turnId: currentTurn.id, speechRevision: currentTurn.speechRevision };
    activeAnalysis = identity;
    try {
      const result = await service.analyze({ samples: recording.tail(), ...identity });
      if (generation !== inferenceGeneration || turn !== currentTurn || currentTurn.manual || currentTurn.speechRevision !== identity.speechRevision || captureToken !== identity.captureToken || result.captureToken !== identity.captureToken || result.turnId !== identity.turnId || result.speechRevision !== identity.speechRevision) return;
      if (result.probability > 0.5 && result.complete !== false && currentTurn.silenceMs >= 200) { currentTurn.completionReady = true; finishAnalyzedTurn(); }
    } catch (error) {
      if (['BusyError', 'AbortError'].includes(error?.name)) { if (currentTurn.analyzedRevision === identity.speechRevision) currentTurn.analyzedRevision = null; }
      else if (generation === inferenceGeneration) inferenceFailed(error, generation);
    }
    finally { currentTurn.pending = false; if (activeAnalysis === identity) activeAnalysis = null; }
  }
  function finishAnalyzedTurn() {
    // Microphone delivery can outrun VAD. Drain all received speech classifications
    // before accepting completion, so speech queued during inference can veto it.
    if (!turn?.completionReady || turn.manual || turn.lastFrameEnd < samplePosition || turn.silenceMs < AUTOMATIC_PAUSE_MS) return false;
    finishRecording('semantic'); return true;
  }
  function accountAnswerSilence(duration) {
    answerSilenceMs += duration;
    if (answerSilenceMs >= ANSWER_SILENCE_MS) { const quiet = answerContext?.taskQuestion || answerContext?.followup; answerSilenceMs = 0; answerContext = null; if (quiet) { update({ phase: idlePhase(), transcript: '', request: undefined }); return; } update({ transcript: '' }); void announceError({ category: 'not-understood', origin: 'voice', operation: 'transcription' }); }
  }
  function cancelSpeech({ requestId, preserveQueue = false } = {}) {
    if (requestId) {
      cancelledSpeechRequests.add(requestId);
      if (cancelledSpeechRequests.size > 512) cancelledSpeechRequests.delete(cancelledSpeechRequests.values().next().value);
      for (const wake of speechWaiters) wake(); speechWaiters.clear();
      if (activeSpeechRequestId !== requestId && answerContext?.taskQuestion?.requestId !== requestId && answerContext?.followup?.requestId !== requestId) return { ok: true };
    } else if (!preserveQueue) speechGeneration++;
    deferredError = null;
    epoch++; requestAbort?.abort(); requestAbort = null; clearTimeout(playbackTimer); playbackTimer = null; playbackResolve?.(); playbackResolve = null;
    if (activeReply) onAudio({ replyId: activeReply, sequence: 0, data: [], sampleRate: 24000, channels: 1, format: 's16le', cancelled: true, done: true });
    activeReply = null; activeSpeechRequestId = null; activeInteraction = null; answerContext = null; answerSilenceMs = 0; recentAudio = []; resetRecording();
    update({ phase: idlePhase(), replyId: undefined }); syncDetectionMode(true); return { ok: true };
  }
  function dismiss() {
    // Dismiss this exchange, not the user's microphone preference or terminal work.
    deferredInteractions.clear(); clearTimeout(deferredTimer); deferredTimer = null;
    announcementPending = null;
    cancelSpeech();
    update({ transcript: '', reply: '', request: undefined, error: null, errorOperation: null });
    return { ok: true, status: 'dismissed' };
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
    if (info.requestId && !info.queuedSpeech) {
      const generation = speechGeneration;
      const cancelled = () => disposed || generation !== speechGeneration || cancelledSpeechRequests.has(info.requestId);
      const run = async () => {
        while (!cancelled() && ['recording', 'transcribing', 'awaiting-answer'].includes(state.phase)) await new Promise(resolve => speechWaiters.add(resolve));
        if (cancelled()) return { ok: false, status: 'cancelled' };
        return announceError({ ...info, queuedSpeech: true });
      };
      const result = speechQueue.then(run, run); speechQueue = result.catch(() => {}); return result;
    }
    if (!state.listening || !enabled()) return { ok: true, status: 'silent' };
    const operation = ['transcription', 'speech', 'orchestration'].includes(info.operation) ? info.operation : 'orchestration';
    const stage = operation === 'speech' ? 'The answer is ready, but speech playback failed.' : operation === 'transcription' ? 'I could not transcribe that.' : 'I could not complete that request.';
    // Reconstruct the bounded classifier message so provider bodies and keys cannot enter UI state.
    const local = ['not-understood', 'transcription', 'orchestration', 'speech', 'busy', 'spending-limit', 'answer'].includes(info.category);
    const safeDetail = local ? ERROR_AUDIO_TEXT[info.category] : new OpenRouterError(info.category, info.status).message;
    const message = (local ? safeDetail : `${stage} ${safeDetail}`).slice(0, 400);
    update({ error: message, errorOperation: operation });
    if (info.origin === 'monitor' && ['recording', 'awaiting-answer', 'transcribing', 'thinking', 'speaking'].includes(state.phase)) {
      deferredError = info; return { ok: true, status: 'queued' };
    }
    // Every explicit voice attempt gets feedback, including repeated missed speech.
    if (info.origin !== 'voice' && lastErrorAudio.has(info.category) && now() - lastErrorAudio.get(info.category) < 60000) {
      if (state.phase === 'error' && !activeReply) update({ phase: idlePhase() });
      return { ok: true, status: 'duplicate' };
    }
    let clip;
    try { clip = alerts.load(info.category); }
    catch (error) { diagnostic('alert-audio', error); update({ phase: idlePhase() }); return { ok: false, status: 'audio-unavailable', error: message }; }
    cancelSpeech({ preserveQueue: true });
    lastErrorAudio.set(info.category, now());
    const current = epoch, replyId = activeReply = randomUUID(); activeSpeechRequestId = info.requestId || null;
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
    clearTimeout(playbackTimer); playbackTimer = null; playbackResolve = null; activeReply = null; activeSpeechRequestId = null;
    update({ phase: idlePhase(), replyId: undefined, ...(playback?.error && { error: `${message} ${playback.error}` }) });
    if (playback?.error) { diagnostic('playback', playback.diagnosticError || Error(playback.error), { replyId }); return { ok: false, status: 'playback-failed', error: state.error }; }
    return { ok: true, status: 'announced', category: info.category };
  }
  // The key ends the turn, so a finished recording is judged on voiced audio alone:
  // pre-roll and live speech together must clear the tap threshold to be uploaded.
  function finishRecording(reason = 'manual') {
    const finishedTurn = turn;
    const voiced = recording.voicedMs + recording.preRollVoicedMs, data = recording.finish();
    resetRecording(reason);
    if (!finishedTurn?.source && voiced < MIN_VOICED_MS) {
      answerContext = null; answerSilenceMs = 0; update({ transcript: '' });
      void announceError({ category: 'not-understood', origin: 'voice', operation: 'transcription' });
      return { ok: true, status: 'empty' };
    }
    void sendAudio({ audioBase64: wavFromSamples(data).toString('base64'), format: 'wav', recordingSource: finishedTurn?.source });
    return { ok: true, status: 'sent' };
  }
  function pushToTalk(action, holdId) {
    if (action !== 'start') {
      if (!recording) return { ok: true, status: 'idle' };
      if (turn && !turn.manual) return { ok: true, status: 'recording', recordingSource: turn.source };
      if (turn?.holdId !== undefined && holdId !== turn.holdId) return { ok: true, status: 'stale-hold', recordingSource: state.recordingSource };
      if (action === 'stop') return finishRecording();
      if (turn?.adopted) {
        turn.manual = false; turn.adopted = false; turn.holdId = undefined; turn.speechRevision++; turn.completionReady = false;
        // Audio captured during the hold has no VAD classifications. Begin a
        // fresh pause window rather than inheriting quiet from before the hold.
        turn.silenceMs = 0; turn.lastFrameEnd = samplePosition;
        update({ recordingSource: turn.source }); syncDetectionMode(true);
        return { ok: true, status: 'recording', recordingSource: turn.source };
      }
      resetRecording(); answerSilenceMs = 0;
      update({ phase: answerContext ? 'awaiting-answer' : idlePhase(), transcript: '' });
      return { ok: true, status: 'cancelled' };
    }
    if (!state.listening || !enabled()) { const error = 'Enable Orchestrator and the microphone first.'; update({ error }); return { ok: false, error }; }
    if (['transcribing', 'thinking'].includes(state.phase)) { const error = 'Wait for the current reply before talking again.'; update({ error }); return { ok: false, status: 'busy', error }; }
    if (recording) {
      if (turn && !turn.manual) { turn.manual = true; turn.adopted = true; turn.holdId = holdId; turn.speechRevision++; turn.completionReady = false; update({ recordingSource: 'ptt', finishHint: false }); syncDetectionMode(true); }
      else if (turn) turn.holdId = holdId;
      return { ok: true, status: 'recording', recordingSource: 'ptt' };
    }
    const preRoll = recentAudio; recentAudio = []; answerSilenceMs = 0;
    // Talking over a reply interrupts it; talking over a question keeps the answer route.
    if (state.phase !== 'awaiting-answer') cancelSpeech({ preserveQueue: true });
    recording = createRecording({ ...recordingOptions, preRoll, endpointing: false });
    turn = { id: ++turnSequence, manual: true, holdId };
    update({ phase: 'recording', recordingSource: 'ptt', recordingId: turn.id, transcript: '', error: null });
    return { ok: true, status: 'recording', recordingSource: 'ptt' };
  }
  function failPushToTalk(holdId, error) {
    if (!recording || !turn?.manual || turn.holdId !== holdId) return { ok: true, status: 'stale-hold' };
    resetRecording(); answerSilenceMs = 0;
    if (answerContext && !currentInteraction(answerContext)) answerContext = null;
    update({ phase: answerContext ? 'awaiting-answer' : idlePhase(), error: String(error || 'Microphone audio could not finish. Please try again.').slice(0, 200) });
    return { ok: true, status: 'cancelled' };
  }
  async function setListening(value) {
    if (!value) { update({ listening: false, muted: true }); cancelSpeech(); stopInference(); update({ phase: 'off', handsFreeStatus: 'off', handsFreeError: null }); return { ok: true }; }
    if (state.listening && enabled()) return { ok: true };
    const activation = ++epoch;
    const key = await getKey?.();
    if (activation !== epoch || disposed) return state.phase === 'microphone-error' ? { ok: false, status: 'microphone-error', error: state.error } : { ok: false, status: 'cancelled' };
    if (!enabled() || !key) { update({ ready: false, error: 'Enable Orchestrator and save an OpenRouter key to use voice.' }); return { ok: false, error: state.error }; }
    cancelSpeech(); update({ listening: true, muted: false, ready: true, microphoneId: getSettings().microphoneId || '', phase: 'listening', error: null });
    void refreshHandsFree();
    const startEpoch = epoch;
    const pending = orchestrator.getState?.().requests;
    for (const interaction of Array.isArray(pending) ? pending : [...deferredInteractions.values()]) {
      if (state.listening && epoch === startEpoch && (interaction.state === 'pending' || !Array.isArray(pending))) void announceInteraction(interaction);
    }
    return { ok: true };
  }
  async function sendAudio({ audioBase64, format = 'wav', recordingSource } = {}) {
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
      const rawText = data.text.split(key).join('[REDACTED]').trim();
      const text = recordingSource === 'wake' ? rawText.replace(/^\s*hey[\s,!.:;—-]+vibe\b[\s,!.:;—-]*/i, '').trim() : rawText;
      if (isVoiceDismissal(text)) return dismiss();
      if (recordingSource === 'wake' && !/[\p{L}\p{N}]/u.test(text)) {
        update({ phase: idlePhase(), transcript: '', error: 'No command heard. Say Hey Vibe and your command, or hold Space.' });
        return { ok: true, status: 'wake-only' };
      }
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
      const result = await (orchestrator.enqueue ? orchestrator.enqueue({ text, origin: 'voice' }) : orchestrator.send({ text, origin: 'voice' }));
      if (current === epoch && result?.ok === false && result.status !== 'cancelled' && !result.text) {
        await announceError({ ...(result.upstreamError || { category: failureCategory(result.error, operation) }), origin: 'voice', operation });
      }
      if (current === epoch && state.phase === 'thinking') update({ phase: idlePhase(), ...(result?.ok === false ? { error: result.error || 'Orchestrator could not respond.' } : {}) });
      return result;
    } catch (e) {
      if (current !== epoch || abort.signal.aborted) return { ok: false, status: 'cancelled' };
      if (operation === 'transcription') diagnostic(operation, e, {}, key);
      const error = String(e.message || 'Voice request failed.');
      const safeError = key ? error.split(key).join('[REDACTED]') : error;
      update({ phase: 'error', errorOperation: operation, error: safeError });
      const upstreamError = upstreamErrorInfo(e);
      await announceError({ ...(upstreamError || { category: failureCategory(error, operation) }), origin: 'voice', operation });
      return { ok: false, operation, error: safeError, ...(upstreamError && { upstreamError }) };
    }
    finally { if (requestAbort === abort) requestAbort = null; }
  }
  function frames({ samples, sampleRate, captureToken: frameToken, sampleStart } = {}) {
    if (!state.listening || !enabled()) return { ok: false, status: 'off' };
    if (sampleRate !== RATE || !(Array.isArray(samples) || samples instanceof Float32Array) || !samples.length || samples.length > 8192 || samples.some(n => !Number.isFinite(n) || Math.abs(n) > 1.01)) return { ok: false, error: 'Invalid microphone frames.' };
    if (captureToken !== undefined && (frameToken !== captureToken || !Number.isSafeInteger(sampleStart) || sampleStart < samplePosition)) return { ok: false, status: 'stale-capture' };
    const start = sampleStart ?? samplePosition;
    if (start !== samplePosition) {
      recentAudio = []; syncDetectionMode(true);
      if (turn && !turn.manual) cancelAutomatic('Microphone audio was interrupted. Hold Space to try again.');
    }
    samplePosition = start + samples.length;
    if (recording) {
      const complete = recording.push(samples) === 'complete';
      if (turn && !turn.manual) {
        turn.elapsedMs += samples.length / RATE * 1000;
        if (complete) { cancelAutomatic('Automatic recording reached 60 seconds. Please try a shorter command.'); return { ok: true }; }
      } else if (complete) { finishRecording(); return { ok: true }; }
    } else {
    // The ring is the pre-roll a press-to-talk turn starts from, so it is kept whenever
    // the microphone is open and nothing is being recorded.
    recentAudio.push(Float32Array.from(samples));
    let excess = recentAudio.reduce((n, chunk) => n + chunk.length, 0) - RATE * RECENT_AUDIO_MS / 1000;
    while (excess > 0) { if (recentAudio[0].length <= excess) excess -= recentAudio.shift().length; else { recentAudio[0] = recentAudio[0].slice(excess); excess = 0; } }
    if (state.phase === 'awaiting-answer' && state.handsFreeStatus !== 'ready') accountAnswerSilence(samples.length / RATE * 1000);
    }
    if (inference && detectionMode) {
      try { inference.feed({ samples: Float32Array.from(samples), sampleStart: start, captureToken, streamId, mode: detectionMode }); }
      catch (error) { inferenceFailed(error); }
    }
    return { ok: true };
  }
  function speak(message = {}) {
    if (message.origin === 'interaction') message = { ...message, kind: 'interaction', id: message.requestId || message.id };
    const identity = message.interaction || { id: message.requestId || message.id, sessionId: message.sessionId, generation: message.generation, revision: message.revision };
    if (!message.preview && (!shouldSpeak(message) || !state.listening || !enabled())) return Promise.resolve({ ok: true, status: 'silent' });
    const queuedGeneration = speechGeneration;
    const queueCancelled = () => disposed || queuedGeneration !== speechGeneration || (message.requestId && cancelledSpeechRequests.has(message.requestId));
    const run = async () => {
      while (!queueCancelled() && (recording || (['transcribing', 'awaiting-answer'].includes(state.phase) && !message.answerFollowup))) await new Promise(resolve => speechWaiters.add(resolve));
      const queuedEpoch = epoch;
      if (queueCancelled() || (!message.preview && (!state.listening || !enabled()))) return { ok: false, status: 'cancelled' };
      if (message.responseTurn === 'dismiss') return dismiss();
      if (message.question && !currentInteraction({ taskQuestion: message.question })) return { ok: false, status: 'resolved' };
      if (message.kind === 'interaction') {
        if (!currentInteraction({ interaction: identity })) return { ok: false, status: 'resolved' };
        if (recording || (['transcribing', 'awaiting-answer'].includes(state.phase) && !message.answerFollowup)) return { ok: false, status: 'user-speaking' };
      }
      let text = String(message.text || '').trim().slice(0, 4000);
      const tasks = orchestrator.getState?.().tasks || [];
      const task = tasks.find(item => item.requestId === message.requestId || item.id === message.requestId);
      const label = message.targetLabel || task?.targets?.map(target => target.name || (target.cwd && path.basename(target.cwd))).filter(Boolean).join(', ') || task?.label;
      if (label && tasks.filter(item => !['finished', 'cancelled', 'failed'].includes(item.status)).length > 1) text = `${label}. ${text}`; if (!text) return { ok: true };
      let key;
      try { key = await getKey(); } catch (error) { if (queuedEpoch === epoch) diagnostic('speech', error, { requestId: identity.id }); }
      if (queuedEpoch !== epoch) return { ok: false, status: 'cancelled' };
      if (!key) {
        const error = 'Save an OpenRouter key before checking the voice.';
        update({ phase: idlePhase(), error, errorOperation: 'speech' });
        if (state.listening) await announceError({ category: 'auth', origin: 'voice', operation: 'speech' });
        return { ok: false, operation: 'speech', error };
      }
      text = text.split(key).join('[REDACTED]');
      const speechText = spokenText(text);
      if (!speechText) return { ok: true };
      const abort = requestAbort = new AbortController();
      let speechStage = 'speech';
      const replyId = activeReply = randomUUID(); activeSpeechRequestId = message.requestId || null; activeInteraction = message.kind === 'interaction' ? identity : null;
      update({ phase: 'speaking', reply: text, replyId, error: null, errorOperation: null }); let sequence = 0, bytes = 0;
      try {
        const settings = getSettings();
        checkSpending();
        if (settings.ttsModel && settings.ttsModel !== TTS_MODEL) throw Error(`Voice playback currently supports ${TTS_MODEL}. Select this speech model in Orchestrator settings.`);
        if (settings.voice && !TTS_VOICES.includes(settings.voice)) throw Error('Select a supported Kokoro voice in Orchestrator settings.');
        const response = await requestAudio('https://openrouter.ai/api/v1/audio/speech', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(120000)]), body: JSON.stringify({ model: settings.ttsModel || TTS_MODEL, input: speechText, voice: settings.voice || TTS_VOICE, response_format: 'pcm' }) }, abort);
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
        speechStage = 'playback';
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
        if (playback?.error) throw Object.assign(Error(playback.error), { diagnosticError: playback.diagnosticError });
        if (queuedEpoch === epoch) {
          activeReply = null; activeSpeechRequestId = null; activeInteraction = null;
          const question = message.question;
          if (question?.id && question?.requestId && typeof question.text === 'string' && currentInteraction({ taskQuestion: question })) {
            answerContext = { taskQuestion: { ...question } }; answerSilenceMs = 0;
            update({ phase: 'awaiting-answer', replyId: undefined });
          } else if (!message.question && message.responseTurn === 'listen' && message.requestId && !cancelledSpeechRequests.has(message.requestId)) {
            const followup = { requestId: message.requestId, text: message.text, speechGeneration };
            if (currentInteraction({ followup })) { answerContext = { followup }; answerSilenceMs = 0; }
            update({ phase: answerContext && currentInteraction(answerContext) ? 'awaiting-answer' : idlePhase(), replyId: undefined });
          } else update({ phase: answerContext && currentInteraction(answerContext) ? 'awaiting-answer' : idlePhase(), replyId: undefined });
        }
        return { ok: true };
      } catch (e) {
        if (queuedEpoch !== epoch || abort.signal.aborted) return { ok: false, status: 'cancelled' };
        diagnostic(speechStage, e.diagnosticError || e, { replyId, requestId: identity.id, targetId: identity.sessionId, generation: identity.generation }, key);
        clearTimeout(playbackTimer); playbackTimer = null; playbackResolve = null;
        onAudio({ replyId, sequence, data: [], sampleRate: 24000, channels: 1, format: 's16le', done: true, cancelled: true });
        const error = String(e.message || 'Speech failed.').split(key).join('[REDACTED]');
        activeReply = null; activeInteraction = null; update({ phase: 'error', errorOperation: 'speech', error });
        const upstreamError = upstreamErrorInfo(e);
        if (state.listening) await announceError({ ...(upstreamError || { category: failureCategory(error, 'speech') }), origin: 'voice', operation: 'speech' });
        else update({ phase: idlePhase() });
        return { ok: false, operation: 'speech', error, ...(upstreamError && { upstreamError }) };
      } finally { if (requestAbort === abort) requestAbort = null; }
    };
    // A repeated answer prompt must bypass replies waiting for this answer window.
    // Capture/STT owns the channel here, so there is no concurrent playback.
    if (message.answerFollowup && !activeReply) return run();
    const result = speechQueue.then(run, run); speechQueue = result.catch(() => {}); return result;
  }
  function configure(patch = {}) {
    if (Object.hasOwn(patch, 'captureToken') && patch.captureToken !== captureToken) {
      captureToken = patch.captureToken; samplePosition = 0; recentAudio = []; syncDetectionMode(true);
      if (recording) { resetRecording(); answerContext = null; update({ phase: idlePhase(), error: 'Microphone changed. Please start your recording again.' }); }
    }
    if (patch.dismiss === true) return dismiss();
    if (patch.refreshHandsFree) { if (state.handsFreeStatus === 'unavailable') update({ handsFreeStatus: 'off' }); return refreshHandsFree(); }
    if (Object.hasOwn(patch, 'finishRecording')) {
      if (!recording || !turn || turn.manual || !Number.isSafeInteger(patch.finishRecording) || patch.finishRecording !== turn.id) return { ok: true, status: 'stale-recording' };
      return finishRecording('manual-send');
    }
    if (patch.playbackError && activeReply) { clearTimeout(playbackTimer); playbackResolve?.({ error: 'Speech playback failed. Check your audio output.', diagnosticError: Error(String(patch.playbackError)) }); return { ok: true }; }
    if (patch.preview === true) {
      if (state.listening && !['listening', 'error'].includes(state.phase)) return { ok: false, error: 'Finish the current voice turn before checking the voice.' };
      cancelSpeech();
      return speak({ preview: true, text: 'Hi, I’m Vibe. Hold the space bar when you need me, and I’ll help you with your workspace.' });
    }
    if (patch.playbackDone && patch.playbackDone === activeReply) { clearTimeout(playbackTimer); playbackResolve?.(); }
    if (patch.microphoneError) { diagnostic('microphone', Error(String(patch.microphoneError))); update({ listening: false, muted: true }); cancelSpeech(); stopInference(); update({ phase: 'microphone-error', handsFreeStatus: 'off', error: String(patch.microphoneError).slice(0, 200) }); }
    if (patch.pushToTalk) return ['start', 'stop', 'cancel'].includes(patch.pushToTalk) ? pushToTalk(patch.pushToTalk, patch.holdId) : { ok: false, error: 'Unknown push-to-talk action.' };
    if (patch.answerRequest && state.request) return announceInteraction(state.request, true);
    if (patch.cancelRecording) return cancelSpeech();
    return { ok: true };
  }
  function currentInteraction(context) {
    if (context.followup) {
      const followup = context.followup;
      const task = (orchestrator.getState?.().tasks || []).find(item => (item.requestId || item.id) === followup.requestId);
      return followup.speechGeneration === speechGeneration && !cancelledSpeechRequests.has(followup.requestId) && !['cancelled', 'failed', 'paused'].includes(task?.status);
    }
    if (context.taskQuestion) {
      const question = context.taskQuestion;
      return (orchestrator.getState?.().tasks || []).some(task => (task.requestId || task.id) === question.requestId && task.question?.id === question.id && !['cancelled', 'finished', 'failed', 'paused'].includes(task.status));
    }
    const requests = orchestrator.getState?.().requests;
    const item = context.interaction;
    return !resolvedInteractions.has(interactionKey(item)) && !(item.sessionId == null && legacyResolvedIds.has(item.id)) && (!Array.isArray(requests) || requests.some(r => sameInteraction(r, item) && r.state === 'pending'));
  }
  async function askQuestion(context, prefix = '') {
    if (!currentInteraction(context)) return { ok: false, status: 'resolved' };
    if (context.followup) return speak({ text: prefix + context.followup.text, responseTurn: 'listen', requestId: context.followup.requestId, origin: 'voice', answerFollowup: true });
    if (context.taskQuestion) return speak({ text: prefix + context.taskQuestion.text, question: context.taskQuestion, requestId: context.taskQuestion.requestId, kind: 'reply', origin: 'voice', answerFollowup: true });
    const generation = speechGeneration;
    const result = await speak({ text: prefix + questionSpeech(context.interaction, context.index), kind: 'interaction', interaction: context.interaction, answerFollowup: !!context.answering });
    if (result.ok && generation === speechGeneration && currentInteraction(context) && state.listening) { answerContext = context; answerSilenceMs = 0; update({ phase: 'awaiting-answer', request: { ...context.interaction, currentQuestion: context.index } }); }
    return result;
  }
  async function submitAnswer(text, current) {
    const context = answerContext;
    if (!context || !currentInteraction(context)) { answerContext = null; update({ phase: idlePhase() }); return { ok: false, status: 'resolved' }; }
    if (context.followup) {
      answerContext = null; answerSilenceMs = 0;
      const input = { text, origin: 'voice' };
      const result = await (orchestrator.enqueue ? orchestrator.enqueue(input) : orchestrator.send(input));
      if (current === epoch && state.phase === 'thinking') update({ phase: idlePhase() });
      return result;
    }
    if (context.taskQuestion) {
      const question = context.taskQuestion; answerContext = null; answerSilenceMs = 0;
      const input = { text, origin: 'voice', replyToRequestId: question.requestId, questionId: question.id };
      const result = await (orchestrator.enqueue ? orchestrator.enqueue(input) : orchestrator.send(input));
      if (current === epoch && state.phase === 'thinking') update({ phase: idlePhase() });
      return result;
    }
    const interaction = context.interaction;
    context.answering = true;
    const question = interaction.questions?.[context.index] || { id: '0', options: [] };
    const answer = matchAnswer(text, question, interaction.kind);
    if (!answer.ok && orchestrator.routeUserAnswer) {
      // Natural answers and directions to another terminal belong to the
      // orchestrator; the literal quick path must not trap the conversation.
      answerContext = null; answerSilenceMs = 0;
      const result = await orchestrator.routeUserAnswer({ text, interaction: { id: interaction.id, sessionId: interaction.sessionId, generation: interaction.generation, revision: interaction.revision } });
      if (current === epoch && state.phase === 'thinking') update({ phase: idlePhase() });
      if (current === epoch && result?.ok === false && !result.text && result.status !== 'cancelled') await announceError({ category: 'answer', origin: 'voice', operation: 'orchestration' });
      return result;
    }
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
    if (matches(activeInteraction) || matches(answerContext?.interaction)) cancelSpeech({ preserveQueue: true });
  }
  function announceInteraction(interaction, repeat = false) {
    const key = interactionKey(interaction);
    if (!repeat && announcedInteractions.has(key)) return Promise.resolve({ ok: true, status: 'duplicate' });
    const context = answerContextFor(interaction);
    if (!currentInteraction(context)) return Promise.resolve({ ok: false, status: 'resolved' });
    // A mouse answer may advance the same native form while voice is still reading it.
    const supersedes = previous => sameRequest(previous, interaction) && previous.revision !== interaction.revision && (Number(interaction.revision) > Number(previous.revision) || !currentInteraction({ interaction: previous }));
    if ([activeInteraction, answerContext?.interaction, announcementPending?.interaction].some(supersedes)) {
      cancelSpeech({ preserveQueue: true }); announcementPending = null;
    }
    for (const [oldKey, item] of deferredInteractions) if (supersedes(item)) deferredInteractions.delete(oldKey);
    if (interaction.kind !== 'permission' && context.index >= (interaction.questions?.length || 0)) {
      if (sameRequest(state.request, interaction)) update({ request: undefined });
      return Promise.resolve({ ok: true, status: 'answered' });
    }
    if (!state.listening) { deferredInteractions.set(key, interaction); if (deferredInteractions.size > 20) deferredInteractions.delete(deferredInteractions.keys().next().value); return Promise.resolve({ ok: true, status: 'silent' }); }
    announcedInteractions.add(key); if (announcedInteractions.size > 512) announcedInteractions.delete(announcedInteractions.values().next().value);
    deferredInteractions.delete(key);
    if (announcementPending || !['listening', 'error'].includes(state.phase)) { deferredInteractions.set(key, interaction); if (deferredInteractions.size > 20) deferredInteractions.delete(deferredInteractions.keys().next().value); return Promise.resolve({ ok: true, status: 'queued' }); }
    announcementPending = context;
    update({ request: interaction }); return askQuestion(context).finally(() => { if (announcementPending === context) announcementPending = null; });
  }
  function dispose() { disposed = true; state.listening = false; clearTimeout(deferredTimer); deferredTimer = null; deferredInteractions.clear(); stopInference(); cancelSpeech(); }
  return { getState: snapshot, configure, setListening, failPushToTalk, frames, sendAudio, cancelSpeech, speak, announceError, announceInteraction, resolveInteraction, dispose };
}
module.exports = { createVoiceController };
