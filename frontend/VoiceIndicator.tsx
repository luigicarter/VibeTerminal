import { useEffect, useMemo, useRef, useState } from 'react';
import { Mic, MicOff, Send, X } from 'lucide-react';
import type { VoiceApi, VoiceState } from './voice/types';
import { pressToTalk } from './voice/pushToTalk';
import './voice/overlay.css';
const phases: Record<string, string> = { off: 'Microphone muted', listening: 'Hold Space to talk', recording: 'Listening… release Space to send', 'awaiting-answer': 'Hold Space to answer', transcribing: 'Understanding your request', thinking: 'Working on it', speaking: 'Speaking', error: 'Voice needs attention', 'microphone-error': 'Microphone unavailable' };
const initial: VoiceState = { phase: 'off', muted: true, listening: false, ready: false };
// Main-window controls only. Capture and playback belong to the hidden audio renderer.
export default function VoiceIndicator() {
  const api = (window.vibe as unknown as { voice?: VoiceApi }).voice;
  const orchestrator = (window.vibe as unknown as { orchestrator: { cancel(): Promise<unknown> } }).orchestrator;
  const [state, setState] = useState<VoiceState>(initial), [localError, setLocalError] = useState(''), [hidden, setHidden] = useState(document.hidden);
  const actionScope = useRef({ phase: initial.phase, recordingId: initial.recordingId, recordingSource: initial.recordingSource, revision: 0 });
  useEffect(() => {
    const changed = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', changed);
    return () => document.removeEventListener('visibilitychange', changed);
  }, []);
  useEffect(() => {
    if (!api) return;
    let alive = true, received = false;
    const receive = (next: VoiceState) => {
      if (next.phase !== actionScope.current.phase || next.recordingId !== actionScope.current.recordingId || next.recordingSource !== actionScope.current.recordingSource) {
        actionScope.current = { phase: next.phase, recordingId: next.recordingId, recordingSource: next.recordingSource, revision: actionScope.current.revision + 1 };
        setLocalError('');
      }
      setState(next);
    };
    const off = api.onState(next => { received = true; if (alive) receive(next); });
    void api.getState().then(next => { if (alive && !received) receive(next); }).catch(error => { if (alive && !received) setLocalError(String(error)); });
    return () => { alive = false; off(); };
  }, [api]);
  const busy = ['recording', 'awaiting-answer', 'transcribing', 'thinking', 'speaking'].includes(state.phase);
  const working = ['transcribing', 'thinking'].includes(state.phase);
  const error = localError || state.error;
  const automatic = state.phase === 'recording' && (state.recordingSource === 'wake' || state.recordingSource === 'answer');
  const status = state.captureRecovering ? 'Reconnecting microphone…' :
    state.handsFreeStatus === 'recovering' && ['listening', 'awaiting-answer'].includes(state.phase) ? 'Restarting hands-free voice… hold Space to talk' :
    error || (state.finishHint ? 'Still listening… click Send when finished' :
    automatic ? 'Listening… speak naturally, or click Send' :
    state.phase === 'awaiting-answer' && state.handsFreeStatus === 'ready' ? 'Listening for your answer · say “never mind” to dismiss' :
    state.phase === 'awaiting-answer' && state.handsFreeStatus === 'loading' ? 'Getting ready to listen… or hold Space to answer' :
    state.phase === 'awaiting-answer' && state.handsFreeStatus === 'unavailable' ? 'Automatic listening unavailable · hold Space to answer' :
    state.phase === 'listening' && state.handsFreeStatus === 'loading' ? 'Starting hands-free voice... hold Space to talk' :
    state.phase === 'listening' && state.handsFreeStatus === 'ready' ? 'Say Hey Vibe or hold Space to talk' :
    state.phase === 'listening' && state.handsFreeStatus === 'unavailable' ? `${state.handsFreeError || 'Hands-free voice unavailable.'} Hold Space to talk` :
    phases[state.phase] || state.phase);
  const visual = error ? 'error' : !state.listening && !busy ? 'muted' : working ? 'thinking' : busy ? state.phase === 'speaking' ? 'speaking' : 'recording' : 'listening';
  // Manual gesture failures arrive in authoritative voice state for both mouse and Space.
  const hold = useMemo(() => api && pressToTalk(api), [api]);
  async function act(run: () => Promise<{ ok?: boolean; error?: string } | unknown>) {
    const revision = actionScope.current.revision;
    const fail = (message: string) => { if (revision === actionScope.current.revision) setLocalError(message); };
    setLocalError('');
    try { const result = await run() as { ok?: boolean; error?: string } | undefined; if (result?.ok === false) fail(result.error || 'Voice action failed.'); }
    catch (failure) { fail(String(failure)); }
  }
  // Manual capture uses a hold; an automatic turn uses an identity-bound Send click.
  const pointerHeld = useRef(false);
  const pointerRecording = useRef<{ recordingId: number; recordingSource: VoiceState['recordingSource']; revision: number } | null>(null);
  const automaticIdentity = () => ({ recordingId: state.recordingId ?? 0, recordingSource: state.recordingSource, revision: actionScope.current.revision });
  const sendAutomatic = (recording: NonNullable<typeof pointerRecording.current>) => {
    const current = actionScope.current;
    if (current.phase !== 'recording' || !['wake', 'answer'].includes(current.recordingSource || '') || current.recordingId !== recording.recordingId || current.recordingSource !== recording.recordingSource || current.revision !== recording.revision) return;
    void act(() => api!.configure({ finishRecording: recording.recordingId }));
  };
  const releasePointer = (send = false) => {
    pointerHeld.current = false;
    const recording = pointerRecording.current;
    pointerRecording.current = null;
    if (recording !== null) { if (send) sendAutomatic(recording); return; }
    hold?.release();
  };
  async function press() {
    pointerHeld.current = true;
    if (!api || !hold) return;
    if (automatic) { pointerRecording.current = automaticIdentity(); return; }
    if (working) return act(async () => { await orchestrator.cancel(); return api.cancelSpeech(); });
    await act(async () => {
      if (!state.listening) { const result = await api.setListening(true); if (!result.ok) return result; }
      if (pointerHeld.current) hold.start();
    });
  }
  const action = working ? 'Stop current request' : automatic ? 'Send recording' : state.listening ? 'Hold to talk' : 'Enable microphone and hold to talk';
  if (!api || !state.indicatorVisible) return null;
  return <div className={`voice-indicator voice-${visual}${hidden ? ' voice-hidden' : ''}`} onContextMenu={event => { event.preventDefault(); void act(() => api.configure({ menu: true })); }}>
    <button className="voice-mic" aria-label={`${status}. ${action}`} title={`${status}\n${action} · Right-click for options`} onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); void press(); }} onPointerUp={event => { if (event.button === 0) releasePointer(true); }} onPointerLeave={() => releasePointer()} onPointerCancel={() => releasePointer()} onKeyDown={event => { if (event.key === ' ') event.preventDefault(); if (event.key === 'Enter' && automatic && !event.repeat) sendAutomatic(automaticIdentity()); }}>{automatic ? <Send size={26} strokeWidth={1.7}/> : busy || state.listening ? <Mic size={29} strokeWidth={1.7}/> : <MicOff size={27} strokeWidth={1.7}/>}</button>
    <button className="voice-mini voice-mute" aria-label={state.listening ? 'Mute microphone' : 'Enable microphone'} title={state.listening ? 'Mute microphone' : 'Enable microphone'} onClick={() => void act(() => api.setListening(!state.listening))}>{state.listening ? <MicOff size={12}/> : <Mic size={12}/>}</button>
    <button className="voice-mini voice-hide" aria-label="Dismiss voice conversation" title="Dismiss voice conversation; return to standby" onClick={() => void act(() => api.configure({ dismiss: true }))}><X size={13}/></button>
    <span className="voice-status" role={error ? 'alert' : 'status'}>{status}</span>
  </div>;
}
