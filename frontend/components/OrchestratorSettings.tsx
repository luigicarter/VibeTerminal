import { useEffect, useState } from "react";
import { relayApi, useOrchestrator } from "../orchestratorUi";
export function OrchestratorSettings() {
    const state = useOrchestrator();
    const [apiKey, setKey] = useState("");
    const [sessionOnly, setSessionOnly] = useState(false);
    const [model, setModel] = useState("");
    const [models, setModels] = useState<{
        id: string;
        name?: string;
        label?: string;
    }[]>([]);
    const [query, setQuery] = useState("");
    const [voiceModels, setVoiceModels] = useState<{
        id: string;
        name?: string;
    }[]>([]);
    const [preference, setPreference] = useState("");
    const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
    const [note, setNote] = useState("");
    const [busy, setBusy] = useState(false);
    useEffect(() => { if (state?.settings.model)
        setModel(state.settings.model); }, [state?.settings.model]);
    async function action(run: () => Promise<{
        ok: boolean;
        error?: string;
    }>, success: string) { setBusy(true); try {
        const result = await run();
        setNote(result.ok ? success : result.error || "Action failed.");
    }
    catch (e) {
        setNote(String(e));
    }
    finally {
        setBusy(false);
    } }
    const api = relayApi();
    return <section className="orchestrator-settings"><div className="settings-section-heading"><h3>Orchestrator / OpenRouter</h3><span>{state?.ready ? "Ready" : "Not connected"}</span></div><p className="settings-description">Orchestrator relays your commands across sessions. It starts off each launch.</p>
    <label>OpenRouter API key<input type="password" autoComplete="off" value={apiKey} placeholder={state?.settings.hasKey ? "Saved securely · enter to replace" : "sk-or-…"} onChange={e => setKey(e.target.value)}/></label>
    <label className="key-session-choice"><input type="checkbox" checked={sessionOnly} onChange={event=>setSessionOnly(event.target.checked)}/> Use a new key for this app session only</label>
    <div className="settings-inline"><label>Search models<input value={query} onChange={e => setQuery(e.target.value)} placeholder="Filter by model or provider"/></label><button disabled={!api || busy} onClick={() => void action(async () => { if (apiKey) {
        const saved = await api!.configure({ apiKey, sessionOnly });
        if (!saved.ok)
            return saved;
        setKey("");
    } setModels(await api!.models("brain")); return { ok: true }; }, "Models refreshed.")}>Load models</button></div>
    <label>Orchestrator model<input list="orchestrator-models" value={model} onChange={e => setModel(e.target.value)} placeholder="Choose or enter an OpenRouter model ID"/><datalist id="orchestrator-models">{models.filter(m => (m.name || m.id).toLowerCase().includes(query.toLowerCase())).map(m => <option key={m.id} value={m.id}>{m.name || m.label || m.id}</option>)}</datalist></label>
    <div className="settings-inline"><button disabled={!api || busy} onClick={() => void action(async () => { const result = await api!.configure({ model, ...(apiKey ? { apiKey, sessionOnly } : {}) }); if (result.ok)
        setKey(""); return result; }, "Orchestrator settings saved.")}>Save orchestrator</button><button disabled={!api || busy} onClick={() => void action(() => api!.testConnection(), "Connection verified.")}>Test connection</button></div>
    <button disabled={!api || busy || !state?.settings.hasKey} onClick={() => void action(() => api!.configure({apiKey:""}), "OpenRouter key removed.")}>Remove saved key</button>
    <details className="voice-settings"><summary>Voice & monitoring</summary><button disabled={!api || busy} onClick={() => void action(async () => { const result = await Promise.all([api!.models("transcription"), api!.models("speech")]); setVoiceModels([...result[0], ...result[1]]); return { ok: true }; }, "Voice models loaded.")}>Load voice models</button><datalist id="orchestrator-voice-models">{voiceModels.map((model, index) => <option key={`${model.id}-${index}`} value={model.id}>{model.name || model.id}</option>)}</datalist><p className="settings-description">Use the microphone control beside the app version to enable voice. Audio is not saved.</p>{([{ key: "sttModel", label: "Transcription model" }, { key: "ttsModel", label: "Speech model" }, { key: "voice", label: "Voice" }, { key: "language", label: "Language" }] as const).map(({ key, label }) => <label key={key}>{label}<input list={key === "sttModel" || key === "ttsModel" ? "orchestrator-voice-models" : undefined} defaultValue={state?.settings[key] || ""} key={`${key}-${state?.settings[key]}`} onBlur={e => { if (api && e.target.value !== (state?.settings[key] || ""))
        void action(() => api.configure({ [key]: e.target.value }), `${label} saved.`); }}/></label>)}<label>Monitoring interval (seconds)<input type="number" min="5" defaultValue={state?.settings.monitoringIntervalSeconds || 30} onBlur={e => { if (api)
        void action(() => api.configure({ monitoringIntervalSeconds: Number(e.target.value) }), "Monitoring interval saved."); }}/></label><label>Spending limit (USD)<input type="number" min="0" step="0.1" defaultValue={state?.settings.spendingLimit ?? ""} placeholder="Optional" onBlur={e => { if (api)
        void action(() => api.configure({ spendingLimit: e.target.value === "" ? null : Number(e.target.value) }), "Spending limit saved."); }}/></label><label>Microphone<select value={state?.settings.microphoneId || ""} onChange={event => { if (api)
        void action(() => api.configure({ microphoneId: event.target.value }), "Microphone saved."); }}><option value="">System default</option>{devices.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Microphone ${index + 1}`}</option>)}</select></label><button onClick={() => void navigator.mediaDevices.enumerateDevices().then(items => setDevices(items.filter(item => item.kind === "audioinput"))).catch(error => setNote(String(error)))}>Refresh microphones</button></details><details className="voice-settings"><summary>Remembered preferences & usage</summary><p className="settings-description">Only preferences you explicitly save are remembered.</p>{state?.preferences?.map(item => <p key={item.id}>{item.text} <button disabled={!api} onClick={() => void action(() => api!.preferences({ operation: "forget", id: item.id }), "Preference removed.")}>Forget</button></p>)}<label>New preference<input value={preference} onChange={event => setPreference(event.target.value)}/></label><button disabled={!api || !preference.trim()} onClick={() => void action(async () => { const result = await api!.preferences({ operation: "remember", text: preference }); if (result.ok)
        setPreference(""); return result; }, "Preference saved.")}>Remember</button><p className="settings-description">Session usage: {Object.entries(state?.usage || {}).map(([kind, cost]) => `${kind} $${typeof cost === "number" ? cost.toFixed(4) : "0.0000"}`).join(" · ")}</p></details>{note && <p role="status" className="settings-note">{note}</p>}
  </section>;
}
