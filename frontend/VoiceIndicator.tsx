import { useEffect, useMemo, useState } from 'react';
import { Mic, MicOff, X } from 'lucide-react';
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
  useEffect(() => {
    const changed = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', changed);
    return () => document.removeEventListener('visibilitychange', changed);
  }, []);
  useEffect(() => {
    if (!api) return;
    let alive = true, received = false;
    const off = api.onState(next => { received = true; if (alive) setState(next); });
    void api.getState().then(next => { if (alive && !received) setState(next); }).catch(error => { if (alive) setLocalError(String(error)); });
    return () => { alive = false; off(); };
  }, [api]);
  const busy = ['recording', 'awaiting-answer', 'transcribing', 'thinking', 'speaking'].includes(state.phase);
  const working = ['transcribing', 'thinking'].includes(state.phase);
  const error = localError || state.error;
  const status = error || phases[state.phase] || state.phase;
  const visual = error ? 'error' : !state.listening && !busy ? 'muted' : working ? 'thinking' : busy ? state.phase === 'speaking' ? 'speaking' : 'recording' : 'listening';
  const hold = useMemo(() => api && pressToTalk(api, result => { if (result?.ok === false) setLocalError(result.error || 'Voice action failed.'); }), [api]);
  async function act(run: () => Promise<{ ok?: boolean; error?: string } | unknown>) {
    setLocalError('');
    try { const result = await run() as { ok?: boolean; error?: string } | undefined; if (result?.ok === false) setLocalError(result.error || 'Voice action failed.'); }
    catch (failure) { setLocalError(String(failure)); }
  }
  // The mic is the mouse equivalent of the Space key: press and hold, release to send.
  async function press() {
    if (!api || !hold) return;
    if (working) return act(async () => { await orchestrator.cancel(); return api.cancelSpeech(); });
    setLocalError('');
    if (!state.listening) { const result = await api.setListening(true); if (!result.ok) { setLocalError(result.error || 'Voice action failed.'); return; } }
    hold.start();
  }
  const action = working ? 'Stop current request' : state.listening ? 'Hold to talk' : 'Enable microphone and hold to talk';
  if (!api || !state.indicatorVisible) return null;
  return <div className={`voice-indicator voice-${visual}${hidden ? ' voice-hidden' : ''}`} onContextMenu={event => { event.preventDefault(); void act(() => api.configure({ menu: true })); }}>
    <button className="voice-mic" aria-label={`${status}. ${action}`} title={`${status}\n${action} · Right-click for options`} onPointerDown={event => { event.preventDefault(); void press(); }} onPointerUp={() => hold?.release()} onPointerLeave={() => hold?.release()} onPointerCancel={() => hold?.release()} onKeyDown={event => { if (event.key === ' ') event.preventDefault(); }}>{busy || state.listening ? <Mic size={29} strokeWidth={1.7}/> : <MicOff size={27} strokeWidth={1.7}/>}</button>
    <button className="voice-mini voice-mute" aria-label={state.listening ? 'Mute microphone' : 'Enable microphone'} title={state.listening ? 'Mute microphone' : 'Enable microphone'} onClick={() => void act(() => api.setListening(!state.listening))}>{state.listening ? <MicOff size={12}/> : <Mic size={12}/>}</button>
    <button className="voice-mini voice-hide" aria-label="Hide microphone indicator; keep listening" title="Hide indicator; keep listening" onClick={() => void act(() => api.configure({ hideOverlay: true }))}><X size={13}/></button>
    <span className="voice-accessible-status" role={error ? 'alert' : 'status'}>{status}</span>
  </div>;
}
