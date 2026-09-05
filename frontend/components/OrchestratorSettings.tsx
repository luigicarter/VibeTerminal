import { useEffect, useRef, useState } from 'react';
import { relayApi, useOrchestrator, type RelayState } from '../orchestratorUi';
import type { VoiceApi, VoiceState } from '../voice/types';
import './orchestratorSettings.css';
type Model = { id: string; name?: string; label?: string; voices?: { id: string; name: string }[] };
type Draft = { model: string; sttModel: string; ttsModel: string; voice: string; language: string; microphoneId: string; monitoringEnabled: boolean; enabledOnLaunch: boolean; monitoringIntervalSeconds: string; spendingLimit: string };
function draftFrom(settings: RelayState['settings']): Draft {
  return { model: settings.model || '', sttModel: settings.sttModel || '', ttsModel: settings.ttsModel || '', voice: settings.voice || '', language: settings.language || '', microphoneId: settings.microphoneId || '', monitoringEnabled: !!settings.monitoringEnabled, enabledOnLaunch: !!settings.enabledOnLaunch, monitoringIntervalSeconds: String(settings.monitoringIntervalSeconds ?? 30), spendingLimit: settings.spendingLimit == null ? '' : String(settings.spendingLimit) };
}
export function OrchestratorSettings() {
  const state = useOrchestrator(), api = relayApi();
  const voiceApi = (window.vibe as unknown as { voice?: VoiceApi }).voice;
  const [draft, setDraft] = useState<Draft | null>(null), [apiKey, setKey] = useState(''), [sessionOnly, setSessionOnly] = useState(false), [changingKey, setChangingKey] = useState(false);
  const [models, setModels] = useState<Model[]>([]), [speech, setSpeech] = useState<Model[]>([]), [transcription, setTranscription] = useState<Model[]>([]);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]), [voiceState, setVoiceState] = useState<VoiceState | null>(null);
  const [note, setNote] = useState(''), [busy, setBusy] = useState(false), [dirty, setDirty] = useState(false), [preference, setPreference] = useState('');
  const inFlight = useRef(false), initialized = useRef(false);
  useEffect(() => { if (state && !initialized.current) { initialized.current = true; setDraft(draftFrom(state.settings)); } }, [state]);
  useEffect(() => {
    let live = true;
    if (api) void api.models('speech').then(items => { if (live) setSpeech(items); }).catch(error => { if (live) setNote(String(error)); });
    if (navigator.mediaDevices) void navigator.mediaDevices.enumerateDevices().then(items => { if (live) setDevices(items.filter(item => item.kind === 'audioinput')); }).catch(() => {});
    return () => { live = false; };
  }, [api]);
  useEffect(() => {
    if (!voiceApi) return;
    let live = true, received = false;
    const off = voiceApi.onState(next => { received = true; if (live) setVoiceState(next); });
    void voiceApi.getState().then(next => { if (live && !received) setVoiceState(next); }).catch(() => {});
    return () => { live = false; off(); };
  }, [voiceApi]);
  function edit<K extends keyof Draft>(key: K, value: Draft[K]) { setDraft(current => current ? { ...current, [key]: value } : current); setDirty(true); setNote(''); }
  async function action(run: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setNote('');
    try { await run(); } catch (error) { setNote(error instanceof Error ? error.message : String(error)); }
    finally { inFlight.current = false; setBusy(false); }
  }
  async function connect() {
    if (!api || !draft) return;
    if (!draft.model.trim()) throw new Error('Choose an assistant model.');
    const interval = Number(draft.monitoringIntervalSeconds), spending = draft.spendingLimit === '' ? null : Number(draft.spendingLimit);
    if (!Number.isFinite(interval) || interval < 5) throw new Error('Monitoring interval must be at least 5 seconds.');
    if (spending !== null && (!Number.isFinite(spending) || spending < 0)) throw new Error('Spending limit must be zero or greater.');
    const result = await api.configure({ ...draft, model: draft.model.trim(), monitoringIntervalSeconds: interval, spendingLimit: spending, ...(apiKey ? { apiKey, sessionOnly } : {}) });
    if (!result.ok) throw new Error(result.error || 'Could not save settings.');
    setKey(''); setChangingKey(false); setDirty(false);
    const connection = await api.testConnection();
    if (!connection.ok || connection.ready !== true || connection.voiceReady === false) throw new Error(connection.error || 'Settings saved, but the selected models are not ready. Check your key and model choices.');
    setNote('Settings saved and connection verified.');
  }
  async function toggle(enabled: boolean) {
    if (!api) return;
    if (enabled) await connect();
    const result = await api.setEnabled(enabled);
    if (!result.ok) throw new Error(result.error || 'Could not change Orchestrator listening.');
    setNote(enabled ? 'Listening for “Hey Vibe”.' : 'Orchestrator disabled.');
  }
  if (!draft) return <section className="orchestrator-settings"><p>Loading assistant settings…</p></section>;
  const voices = speech.find(item => item.id === draft.ttsModel)?.voices || [];
  const unsaved = dirty || !!apiKey;
  const keyLocked = !!state?.settings.hasKey && !changingKey;
  const error = voiceState?.error || voiceState?.wakeError || state?.error;
  return <section className="orchestrator-settings vibe-assistant-settings">
    <div className="settings-section-heading"><h3>Orchestrator</h3><span>{state?.enabled ? 'On' : 'Off'}</span></div>
    <p className="settings-description">Enter your key and model, then enable Orchestrator and say “Hey Vibe”. Wake listening runs locally on your CPU.</p>
    <fieldset disabled={busy}>
      <div className="assistant-device-row"><label>OpenRouter API key<input type="password" autoComplete="off" disabled={keyLocked} value={apiKey} placeholder={keyLocked ? 'Saved securely' : 'sk-or-…'} onChange={event => { setKey(event.target.value); setNote(''); }}/></label>{keyLocked && <button type="button" onClick={() => setChangingKey(true)}>Change</button>}{changingKey && <button type="button" onClick={() => { setChangingKey(false); setKey(''); }}>Cancel</button>}</div>
      <label>Assistant model<input list="orchestrator-models" value={draft.model} onChange={event => edit('model', event.target.value)} placeholder="Choose or enter an OpenRouter model ID"/><datalist id="orchestrator-models">{models.map(item => <option key={item.id} value={item.id}>{item.name || item.label || item.id}</option>)}</datalist></label>
      <button className="assistant-browse" type="button" disabled={!api} onClick={() => void action(async () => { setModels(await api!.models('brain')); setNote('Assistant models refreshed.'); })}>Browse models</button>
      <div className="assistant-enable"><label className="assistant-check"><input type="checkbox" checked={!!state?.enabled} disabled={busy || !api || (!state?.enabled && ((!state?.settings.hasKey && !apiKey.trim()) || !draft.model.trim()))} onChange={event => void action(() => toggle(event.target.checked))}/> Enable Orchestrator</label></div>
      <details className="voice-settings"><summary>Advanced</summary>
      <label className="assistant-check"><input type="checkbox" checked={sessionOnly} onChange={event => setSessionOnly(event.target.checked)}/> Use a new key for this app session only</label>
      <div className="assistant-device-row"><label>Microphone<select value={draft.microphoneId} onChange={event => edit('microphoneId', event.target.value)}><option value="">System default</option>{draft.microphoneId && !devices.some(item => item.deviceId === draft.microphoneId) && <option value={draft.microphoneId}>Saved microphone (not currently listed)</option>}{devices.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Microphone ${index + 1}`}</option>)}</select></label><button type="button" onClick={() => void action(async () => { const permission = await voiceApi?.configure({ requestMicrophoneAccess: true }); if (!permission?.ok) throw new Error(permission?.error || 'Microphone access was not allowed.'); const stream = await navigator.mediaDevices.getUserMedia({ audio: true }); stream.getTracks().forEach(track => track.stop()); setDevices((await navigator.mediaDevices.enumerateDevices()).filter(item => item.kind === 'audioinput')); setNote('Microphones refreshed.'); })}>Refresh microphones</button></div>
      <button type="button" disabled={!voiceApi} onClick={() => void action(async () => { const result = await voiceApi!.configure({ openMicrophoneSettings: true }); if (!result.ok) throw new Error(result.error || 'Could not open microphone privacy settings.'); })}>Open Windows microphone settings</button>
      <label>Voice<select value={`${draft.ttsModel}|${draft.voice}`} onChange={event => { const [ttsModel, voice] = event.target.value.split('|'); setDraft({ ...draft, ttsModel, voice }); setDirty(true); setNote(''); }}><option value="" disabled>Choose a supported voice</option>{!voices.some(item => item.id === draft.voice) && draft.voice && <option value={`${draft.ttsModel}|${draft.voice}`} disabled>Saved voice unavailable · choose a voice</option>}{speech.map(item => <optgroup key={item.id} label={item.name || item.id}>{item.voices?.map(voice => <option key={voice.id} value={`${item.id}|${voice.id}`}>{voice.name}</option>)}</optgroup>)}</select></label>
      <div className="settings-inline"><button type="button" disabled={!voiceApi || !state?.ready || unsaved} onClick={() => void action(async () => { const result = await voiceApi!.configure({ preview: true }); if (!result.ok) throw new Error(result.error || 'Voice preview failed.'); setNote('Voice preview requested. Check your speakers or headphones.'); })}>Preview voice</button><button type="button" disabled={!api} onClick={() => void action(async () => { setSpeech(await api!.models('speech')); setNote('Voice choices refreshed.'); })}>Refresh voices</button></div>
      {unsaved && <p className="settings-description">Enable Orchestrator or save changes below to preview these changes.</p>}
        <label className="assistant-check"><input type="checkbox" checked={draft.enabledOnLaunch} onChange={event => edit('enabledOnLaunch', event.target.checked)}/> Enable “Hey Vibe” when the app launches</label>
        <label>Transcription model<input list="orchestrator-transcription-models" value={draft.sttModel} onChange={event => edit('sttModel', event.target.value)}/><datalist id="orchestrator-transcription-models">{transcription.map(item => <option key={item.id} value={item.id}>{item.name || item.id}</option>)}</datalist></label>
        <button type="button" disabled={!api} onClick={() => void action(async () => { setTranscription(await api!.models('transcription')); setNote('Transcription models refreshed.'); })}>Browse transcription models</button>
        <label>Transcription language<input value={draft.language} placeholder="Auto-detect" onChange={event => edit('language', event.target.value)}/></label>
        <label className="assistant-check"><input type="checkbox" checked={draft.monitoringEnabled} onChange={event => edit('monitoringEnabled', event.target.checked)}/> Send automatic workspace activity reports</label>
        {draft.monitoringEnabled && <label>Report interval (seconds)<input type="number" min="5" value={draft.monitoringIntervalSeconds} onChange={event => edit('monitoringIntervalSeconds', event.target.value)}/></label>}
        <label>Spending limit (USD)<input type="number" min="0" step="0.1" value={draft.spendingLimit} placeholder="Optional" onChange={event => edit('spendingLimit', event.target.value)}/></label>
        <button type="button" disabled={!api || !state?.settings.hasKey} onClick={() => void action(async () => { const result = await api!.configure({ apiKey: '' }); if (!result.ok) throw new Error(result.error || 'Could not remove key.'); setKey(''); setChangingKey(false); setNote('OpenRouter key removed.'); })}>Remove saved key</button>
      <button className="assistant-connect" type="button" disabled={!api || (!state?.settings.hasKey && !apiKey.trim()) || !draft.model.trim()} onClick={() => void action(connect)}>Save changes</button>
    <details className="voice-settings"><summary>Remembered preferences & usage</summary><p className="settings-description">Only preferences you explicitly save are remembered.</p>{state?.preferences?.map(item => <p key={item.id}>{item.text} <button disabled={!api || busy} onClick={() => void action(async () => { const result = await api!.preferences({ operation: 'forget', id: item.id }); if (!result.ok) throw new Error(result.error); })}>Forget</button></p>)}<label>New preference<input value={preference} disabled={busy} onChange={event => setPreference(event.target.value)}/></label><button disabled={!api || busy || !preference.trim()} onClick={() => void action(async () => { const result = await api!.preferences({ operation: 'remember', text: preference }); if (!result.ok) throw new Error(result.error); setPreference(''); setNote('Preference saved.'); })}>Remember</button><p className="settings-description">Session usage: {Object.entries(state?.usage || {}).map(([kind, cost]) => `${kind} $${typeof cost === 'number' ? cost.toFixed(4) : '0.0000'}`).join(' · ') || '$0.0000'}</p></details>
      </details>
    </fieldset>
    {note && <p role="status" className="settings-note">{note}</p>}{error && <p role="alert" className="assistant-error">{error}</p>}
  </section>;
}
