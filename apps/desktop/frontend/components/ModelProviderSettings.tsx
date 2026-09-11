import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import type { ProviderModel, ModelProvider, ModelProviderList } from '../types';
import './modelProviderSettings.css';

const empty = () => ({ name: '', baseUrl: '', apiKey: '', apiMode: 'auto', models: [] as ProviderModel[] });
export function ModelProviderSettings() {
  const [list, setList] = useState<ModelProviderList>({ profiles: [], models: [], defaultModel: null });
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null), [form, setForm] = useState(empty);
  const [modelId, setModelId] = useState(''), [discovered, setDiscovered] = useState<{ id: string; label: string }[]>([]);
  const [discoveryNote, setDiscoveryNote] = useState('');
  const revision = useRef(0);
  const api = window.vibe?.modelProviders;
  async function refresh() {
    try {
      if (!api) throw new Error('Provider settings are unavailable in this build.');
      setList(await api.list());
    } catch (value) { setError(value instanceof Error ? value.message : 'Could not load Provider settings.'); }
    finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); return () => { revision.current++; }; }, []);
  function edit(profile?: ModelProvider) {
    revision.current++; setBusy(false); setError(''); setDiscovered([]); setDiscoveryNote(''); setModelId('');
    setEditing(profile?.id || 'new');
    setForm(profile ? { name: profile.name, baseUrl: profile.baseUrl, apiKey: '', apiMode: profile.apiMode, models: profile.models.map(model => ({ ...model })) } : empty());
  }
  function cancel() { revision.current++; setEditing(null); setForm(empty()); setError(''); setBusy(false); }
  async function save(event: FormEvent) {
    event.preventDefault(); if (!api || busy) return;
    const seq = ++revision.current; setBusy(true); setError('');
    try {
      const result = await api.upsert({ ...form, ...(editing !== 'new' && editing ? { id: editing } : {}) });
      if (seq !== revision.current) return;
      if (!result.ok) throw new Error(result.message || 'Could not save provider.');
      cancel(); await refresh();
    } catch (value) { if (seq === revision.current) setError(value instanceof Error ? value.message : 'Could not save provider.'); }
    finally { if (seq === revision.current) setBusy(false); }
  }
  async function discover() {
    if (!api || busy) return;
    const seq = ++revision.current; setBusy(true); setError(''); setDiscoveryNote('');
    try {
      const result = await api.discoverModels({ id: editing === 'new' ? undefined : editing || undefined, baseUrl: form.baseUrl, apiKey: form.apiKey, apiMode: form.apiMode });
      if (seq !== revision.current) return;
      if (!result.ok) throw new Error(result.error || 'Could not load models.');
      setDiscovered(result.models || []);
      setDiscoveryNote(`${result.models?.length || 0} models found. Add the models you want to use below.`);
    } catch (value) { if (seq === revision.current) setError(value instanceof Error ? value.message : 'Could not load models.'); }
    finally { if (seq === revision.current) setBusy(false); }
  }
  function addModel() {
    const id = modelId.trim(); if (!id || form.models.some(model => model.id === id)) return;
    setForm(current => ({ ...current, models: [...current.models, { id, label: discovered.find(row => row.id === id)?.label || id, contextWindow: 32768, reasoning: false, imageInput: false }] }));
    setModelId('');
  }
  function updateModel(index: number, patch: Partial<ProviderModel>) {
    setForm(current => ({ ...current, models: current.models.map((model, at) => index === at ? { ...model, ...patch } : model) }));
  }
  async function action(operation: () => Promise<{ ok: boolean; message?: string }>) {
    if (busy) return; setBusy(true); setError('');
    try { const result = await operation(); if (!result.ok) throw new Error(result.message); await refresh(); }
    catch (value) { setError(value instanceof Error ? value.message : 'Could not update settings.'); }
    finally { setBusy(false); }
  }
  return <section className="settings-section model-provider-settings" aria-labelledby="model-provider-settings-title">
    <h3 className="settings-section-title" id="model-provider-settings-title">Models & providers</h3>
    <p className="settings-description">Configure each provider and model once, then use it with Open Claude Code or Open Codex. Restart existing panes to load model changes.</p>
    {error && <p className="form-error" role="alert">{error}</p>}
    {loading ? <p>Loading providers…</p> : editing === null ? <>
      {!list.profiles.length && <p className="provider-empty">Add an API provider and choose models for both Open Claude Code and Open Codex.</p>}
      <ul className="provider-list">{list.profiles.map(profile => <li key={profile.id} className="provider-row">
        <div className="provider-row-main"><div className="provider-row-title"><span className="provider-name">{profile.name}</span></div>
          <span className="provider-url">{profile.baseUrl}</span><span className="provider-model">{profile.models.map(model => model.label).join(', ')}</span>
          {profile.hasKey && !profile.encrypted && <span className="settings-note">System key encryption is unavailable; the saved key uses a local protected file.</span>}
        </div>
        <div className="provider-row-actions"><button type="button" disabled={busy} aria-label={`Edit ${profile.name}`} onClick={() => edit(profile)}><Pencil size={14}/></button>
          <button type="button" disabled={busy} aria-label={`Remove ${profile.name}`} onClick={() => void action(() => api!.remove(profile.id))}><Trash2 size={14}/></button></div>
      </li>)}</ul>
      <button type="button" className="provider-add-button" onClick={() => edit()}><Plus size={14}/> Add provider</button>
      {!!list.models.length && <label className="model-provider-field">Default model<select aria-label="Shared default model" value={list.defaultModel || ''} disabled={busy} onChange={event => void action(() => api!.setDefault(event.target.value))}>
        {list.models.map(model => <option key={model.key} value={model.key}>{model.label} · {model.providerName}</option>)}
      </select></label>}
    </> : <form onSubmit={save} className="model-provider-provider-form">
      <fieldset disabled={busy}>
        <label className="model-provider-field">Provider name<input required maxLength={80} value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} placeholder="My provider"/></label>
        <label className="model-provider-field">API base URL<input required type="url" value={form.baseUrl} onChange={event => { revision.current++; setDiscovered([]); setDiscoveryNote(''); setForm({ ...form, baseUrl: event.target.value }); }} placeholder="https://api.example.com/v1"/></label>
        <label className="model-provider-field">API key<input type="password" autoComplete="new-password" value={form.apiKey} onChange={event => setForm({ ...form, apiKey: event.target.value })} placeholder={editing === 'new' ? 'Optional for local servers' : 'Leave blank to keep the saved key'}/></label>
        <label className="model-provider-field">API format<select value={form.apiMode} onChange={event => setForm({ ...form, apiMode: event.target.value })}>
          <option value="auto">Automatic</option><option value="responses">Responses</option><option value="chat-completions">Chat Completions</option><option value="anthropic">Anthropic Messages</option>
        </select></label>
        <div className="model-provider-model-add"><label className="model-provider-field">Model ID<input list="model-provider-discovered-models" value={modelId} onChange={event => setModelId(event.target.value)} placeholder="provider/model-name" onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addModel(); } }}/></label>
          <button type="button" disabled={!modelId.trim()} onClick={addModel}>Add model</button><button type="button" disabled={!form.baseUrl} onClick={() => void discover()}>Load models</button></div>
        <datalist id="model-provider-discovered-models">{discovered.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}</datalist>
        {discoveryNote && <p className="settings-note" role="status">{discoveryNote}</p>}
        <div className="model-provider-models">{form.models.map((model, index) => <div className="model-provider-model" key={model.id}>
          <div className="model-provider-model-heading"><strong>{model.id}</strong><button type="button" aria-label={`Remove model ${model.id}`} onClick={() => setForm({ ...form, models: form.models.filter((_, at) => at !== index) })}><Trash2 size={13}/></button></div>
          <label className="model-provider-field">Display name<input value={model.label} onChange={event => updateModel(index, { label: event.target.value })}/></label>
          <label className="model-provider-field">Context window (tokens)<input type="number" min={4096} max={2000000} step={1} value={model.contextWindow} onChange={event => updateModel(index, { contextWindow: Number(event.target.value) })}/></label>
          <div className="model-provider-model-features"><label><input type="checkbox" checked={model.reasoning} onChange={event => updateModel(index, { reasoning: event.target.checked })}/> Reasoning effort</label>
            <label><input type="checkbox" checked={model.imageInput} onChange={event => updateModel(index, { imageInput: event.target.checked })}/> Image input</label></div>
        </div>)}</div>
      </fieldset>
      <div className="provider-form-actions"><button type="submit" disabled={busy || !form.models.length}>{busy ? 'Working…' : 'Save provider'}</button><button type="button" onClick={cancel}>Cancel</button></div>
    </form>}
  </section>;
}
