import { useEffect, useMemo, useState } from 'react';
import { VoiceMicrophone } from './voice/microphone';
import { PcmPlayer } from './voice/pcmPlayer';
import type { VoiceApi, VoiceState } from './voice/types';
const initial: VoiceState = { phase: 'off', muted: true, listening: false, ready: false };
export default function VoiceOverlay() {
  const api = (window.vibe as unknown as { voice: VoiceApi }).voice;
  const [state, setState] = useState<VoiceState>(initial);
  const microphone = useMemo(() => new VoiceMicrophone(), []);
  const player = useMemo(() => new PcmPlayer(id => { void api.configure({ playbackDone: id }); }, message => { void api.configure({ playbackError: message }); }), [api]);
  useEffect(() => {
    let alive = true, received = false;
    const stateOff = api.onState(next => { received = true; if (alive) setState(next); });
    const audioOff = api.onAudio(chunk => player.push(chunk));
    void api.configure({ rendererReady: true }).catch(() => { /* Integration reports renderer readiness failures. */ });
    void api.getState().then(next => { if (alive && !received) setState(next); }).catch(() => { /* Integration reports renderer readiness failures. */ });
    return () => { alive = false; stateOff(); audioOff(); microphone.stop(); player.dispose(); };
  }, [api, microphone, player]);
  useEffect(() => {
    if (!state.listening) { microphone.stop(); return; }
    let alive = true;
    const microphoneError = () => {
      if (!alive) return;
      microphone.stop();
      const message = 'Allow microphone access and check that your selected microphone is connected.';
      void api.configure({ microphoneError: message, captureToken: state.captureToken });
    };
    const flushOff = api.onFlush(request => {
      if (!alive || request.captureToken !== state.captureToken) return;
      void microphone.flush().then(sampleEnd => {
        if (alive) void api.configure({ captureFlushed: true, flushId: request.id, captureToken: request.captureToken, sampleEnd });
      }).catch(() => { /* Main process deadline handles interrupted or failed flushes. */ });
    });
    void microphone.start((samples, sampleStart) => api.frames({ samples, sampleStart, sampleRate: 16000, captureToken: state.captureToken }), state.microphoneId, microphoneError).then(() => { if (alive) void api.configure({ microphoneReady: true, captureToken: state.captureToken }); }).catch(microphoneError);
    return () => { alive = false; flushOff(); microphone.stop(); };
  }, [api, microphone, state.listening, state.microphoneId, state.captureToken]);
  return null;
}
