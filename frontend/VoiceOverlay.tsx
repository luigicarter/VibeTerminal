import { useEffect, useMemo, useState } from 'react';
import { Mic, MicOff, Square, X, ArrowUpRight, Minus } from 'lucide-react';
import { VoiceMicrophone } from './voice/microphone';
import { PcmPlayer } from './voice/pcmPlayer';
import type { VoiceApi, VoiceState } from './voice/types';
import './voice/overlay.css';
const phases: Record<string, string> = { off: 'Microphone off', starting: 'Starting microphone', listening: 'Say “Hey Vibe”', recording: 'Listening to you', 'awaiting-answer': 'Listening for your answer', transcribing: 'Transcribing', thinking: 'Working on it', speaking: 'Speaking', 'wake-error': 'Talk with the button', error: 'Voice needs attention', 'microphone-error': 'Microphone unavailable' };
const initial: VoiceState = { phase: 'off', muted: true, listening: false, ready: false, wakeReady: false };
export default function VoiceOverlay() {
  const api = (window.vibe as unknown as { voice: VoiceApi }).voice;
  const orchestrator = (window.vibe as unknown as { orchestrator: { dispatch(action: Record<string, unknown>): Promise<unknown>; cancel(): Promise<unknown>; getState(): Promise<{ settings?: { model?: string } }>; onState(callback: (state: { settings?: { model?: string } }) => void): () => void } }).orchestrator;
  const [state, setState] = useState<VoiceState>(initial), [localError, setLocalError] = useState(''), [collapsed, setCollapsed] = useState(false), [model, setModel] = useState('');
  const microphone = useMemo(() => new VoiceMicrophone(), []);
  const player = useMemo(() => new PcmPlayer(id => { void api.configure({ playbackDone: id }); }, message => { setLocalError(message); void api.cancelSpeech(); }), [api]);
  useEffect(() => {
    let alive = true;
    void api.getState().then(s => { if (alive) setState(s); });
    const stateOff = api.onState(setState), audioOff = api.onAudio(chunk => player.push(chunk));
    return () => { alive = false; stateOff(); audioOff(); microphone.stop(); player.dispose(); };
  }, [api, microphone, player]);
  useEffect(() => {
    let alive = true;
    const sync = (next: { settings?: { model?: string } }) => { if (alive) setModel(next.settings?.model || ''); };
    void orchestrator.getState().then(sync);
    const off = orchestrator.onState(sync); return () => { alive = false; off(); };
  }, [orchestrator]);
  useEffect(() => {
    if (!state.listening) { microphone.stop(); player.stop(); return; }
    let alive = true; setLocalError('');
    const microphoneError = () => {
      if (!alive) return; microphone.stop();
      const message = 'Allow microphone access and check that your selected microphone is connected.'; setLocalError(message); void api.configure({ microphoneError: message });
    };
    void microphone.start(samples => api.frames({ samples, sampleRate: 16000 }), state.microphoneId, microphoneError).catch(microphoneError);
    return () => { alive = false; microphone.stop(); };
  }, [api, microphone, player, state.listening, state.microphoneId]);
  const busy = ['recording', 'awaiting-answer', 'transcribing', 'thinking', 'speaking'].includes(state.phase);
  function cancel() { if (state.phase === 'thinking') void orchestrator.cancel(); void api.cancelSpeech(); }
  return <main className={`voice-overlay ${busy ? 'voice-active' : ''} ${collapsed ? 'voice-collapsed' : ''}`}>
    <header className="voice-overlay-header"><span className="voice-brand">Orchestrator<span title={model}>{model.split('/').pop() || 'Choose a model'}</span></span><span className="voice-private">{state.listening ? 'MIC ON' : 'MIC OFF'}</span><button aria-label="Open workspace" title="Open workspace" onClick={() => void api.configure({ openWorkspace: true })}><ArrowUpRight size={16}/></button><button aria-label={collapsed ? 'Expand voice' : 'Collapse voice'} title={collapsed ? 'Expand voice' : 'Collapse voice'} onClick={() => { setCollapsed(!collapsed); void api.configure({ collapse: !collapsed }); }}><Minus size={16}/></button><button aria-label="Turn off voice" title="Turn off voice" onClick={() => void api.setListening(false)}><X size={16}/></button></header>
    <div className="voice-mic" aria-hidden="true"><Mic size={29} strokeWidth={1.2}/></div>
    <div className="voice-phase" role="status">{phases[state.phase] || state.phase}</div>
    <p className="voice-hint">{state.phase === 'listening' ? 'Your wake phrase stays on this device.' : state.phase === 'off' ? 'One voice for your whole workspace.' : 'Your workspace is still yours to control.'}</p>
    {(localError || state.error || state.wakeError) && <p className="voice-error" role="alert">{localError || state.error || state.wakeError}</p>}
    {(state.transcript || state.reply) && <div className="voice-conversation">{state.transcript && <p className="voice-you"><small>You</small>{state.transcript}</p>}{state.reply && <p><small>Vibe</small>{state.reply}</p>}</div>}
    {state.request && <div className="voice-question"><p>{state.request.questions?.[state.request.currentQuestion || 0]?.question || state.request.detail}</p>{state.request.questions?.[state.request.currentQuestion || 0]?.options?.map((option, i) => <span key={i}>{i + 1}. {option.label}</span>)}<div><button onClick={() => void api.configure({ answerRequest: true })}>Answer by voice</button><button onClick={() => { void api.configure({ openWorkspace: true }); void orchestrator.dispatch({ kind: 'focus_session', targetId: state.request?.sessionId }); }}>Open agent<ArrowUpRight size={13}/></button></div></div>}
    <footer className="voice-controls"><button className={state.listening ? '' : 'voice-primary'} onClick={() => void api.setListening(!state.listening)}>{state.listening ? <MicOff size={15}/> : <Mic size={15}/>} {state.listening ? 'Mute' : 'Enable mic'}</button>{state.listening && <button className="voice-primary" onClick={() => busy ? cancel() : void api.configure({ manual: true })}>{busy ? <Square size={13}/> : <Mic size={15}/>} {busy ? 'Cancel' : 'Talk now'}</button>}</footer>
  </main>;
}
