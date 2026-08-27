import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Check, Pencil, Plus, Trash2, X } from "lucide-react";

export interface SettingsDialogProps {
  // Shown as a dismissible note at the top when the dialog was opened as a
  // detour (e.g. "Open Claude Code" clicked with no provider configured).
  hint?: string | null;
  onClose: () => void;
}

// window.vibe.claudeProviders is typed in electron.d.ts on newer builds. The
// structural copies here keep this component compiling (and safely no-op) on
// older preload builds where the bridge is absent.
interface ClaudeProviderProfile {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  smallFastModel: string;
  hasKey: boolean;
  encrypted: boolean;
  createdAt: number;
  updatedAt: number;
}

interface ClaudeProvidersApi {
  list: () => Promise<{
    profiles: ClaudeProviderProfile[];
    defaultProfileId: string | null;
    hasCustomProfile: boolean;
  }>;
  upsert: (profile: {
    id?: string;
    name: string;
    baseUrl: string;
    apiKey?: string;
    model: string;
    smallFastModel?: string;
  }) => Promise<{ ok: boolean; profile?: ClaudeProviderProfile; message?: string }>;
  remove: (id: string) => Promise<{ ok: boolean; message?: string }>;
  setDefault: (id: string | null) => Promise<{ ok: boolean; message?: string }>;
  test: (payload: {
    id?: string;
    baseUrl?: string;
    apiKey?: string;
  }) => Promise<{ ok: boolean; models?: { id: string; label: string }[]; error?: string }>;
}

function claudeProvidersApi(): ClaudeProvidersApi | undefined {
  const vibe = window.vibe as Record<string, unknown> | undefined;
  return vibe?.claudeProviders as ClaudeProvidersApi | undefined;
}

interface ProviderFormState {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  smallFastModel: string;
}

const EMPTY_FORM: ProviderFormState = {
  name: "",
  baseUrl: "",
  apiKey: "",
  model: "",
  smallFastModel: ""
};

type TestState =
  | { status: "idle" }
  | { status: "testing" }
  | { status: "ok"; modelCount: number }
  | { status: "error"; message: string };

export function SettingsDialog({ hint, onClose }: SettingsDialogProps): JSX.Element {
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<ClaudeProviderProfile[]>([]);
  const [defaultProfileId, setDefaultProfileId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id?: string } | "new" | null>(null);
  const [hintDismissed, setHintDismissed] = useState(false);
  const [form, setForm] = useState<ProviderFormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testState, setTestState] = useState<TestState>({ status: "idle" });
  // Token guarding the async test: switching forms (or cancelling) bumps it so
  // a late result can never land on a form it wasn't started from.
  const testSeqRef = useRef(0);

  const refresh = useCallback(async () => {
    const api = claudeProvidersApi();
    if (!api) {
      setListError("Claude provider management isn't available in this build of vibeTerminal.");
      setLoading(false);
      return;
    }
    try {
      const result = await api.list();
      setProfiles(result.profiles);
      setDefaultProfileId(result.defaultProfileId);
      setListError(null);
    } catch (error) {
      setListError(error instanceof Error ? error.message : "The provider list could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  const editingProfile =
    editing !== null && editing !== "new" && editing.id
      ? profiles.find((profile) => profile.id === editing.id) ?? null
      : null;

  function openNewForm() {
    testSeqRef.current += 1;
    setEditing("new");
    setForm(EMPTY_FORM);
    setFormError(null);
    setTestState({ status: "idle" });
  }

  function openEditForm(profile: ClaudeProviderProfile) {
    testSeqRef.current += 1;
    setEditing({ id: profile.id });
    setForm({
      name: profile.name,
      baseUrl: profile.baseUrl,
      apiKey: "",
      model: profile.model,
      smallFastModel: profile.smallFastModel
    });
    setFormError(null);
    setTestState({ status: "idle" });
  }

  function validateForm(): string | null {
    if (!form.name.trim()) {
      return "Name is required.";
    }
    const baseUrl = form.baseUrl.trim();
    if (!baseUrl) {
      return "Base URL is required.";
    }
    if (!/^https?:\/\//i.test(baseUrl)) {
      return "Base URL must start with http:// or https://.";
    }
    if (!form.model.trim()) {
      return "Model is required.";
    }
    // A blank key means "keep the saved one" only when there is a saved one.
    const hasStoredKey = editingProfile?.hasKey ?? false;
    const addingNew = editing === "new" || editing === null || !editing.id;
    if (!form.apiKey.trim() && (addingNew || !hasStoredKey)) {
      return "API key is required.";
    }
    return null;
  }

  async function handleTest() {
    const api = claudeProvidersApi();
    if (!api || testState.status === "testing") {
      return;
    }
    setFormError(null);
    setTestState({ status: "testing" });
    const seq = ++testSeqRef.current;
    try {
      const payload: { id?: string; baseUrl?: string; apiKey?: string } = {
        baseUrl: form.baseUrl.trim() || undefined
      };
      if (editing !== null && editing !== "new" && editing.id) {
        payload.id = editing.id;
      }
      if (form.apiKey.trim()) {
        payload.apiKey = form.apiKey.trim();
      }
      const result = await api.test(payload);
      if (seq !== testSeqRef.current) {
        return;
      }
      if (result.ok) {
        setTestState({ status: "ok", modelCount: result.models?.length ?? 0 });
      } else {
        setTestState({ status: "error", message: result.error || "Connection failed." });
      }
    } catch (error) {
      if (seq !== testSeqRef.current) {
        return;
      }
      setTestState({
        status: "error",
        message: error instanceof Error ? error.message : "Connection failed."
      });
    }
  }

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const api = claudeProvidersApi();
    if (!api || saving) {
      return;
    }
    const validationError = validateForm();
    if (validationError) {
      setFormError(validationError);
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const payload: {
        id?: string;
        name: string;
        baseUrl: string;
        apiKey?: string;
        model: string;
        smallFastModel?: string;
      } = {
        name: form.name.trim(),
        baseUrl: form.baseUrl.trim(),
        model: form.model.trim()
      };
      if (editing !== null && editing !== "new" && editing.id) {
        payload.id = editing.id;
      }
      if (form.apiKey.trim()) {
        payload.apiKey = form.apiKey.trim();
      }
      if (form.smallFastModel.trim()) {
        payload.smallFastModel = form.smallFastModel.trim();
      }
      const result = await api.upsert(payload);
      if (!result.ok) {
        setFormError(result.message || "The provider could not be saved.");
        return;
      }
      testSeqRef.current += 1;
      setEditing(null);
      await refresh();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "The provider could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(profile: ClaudeProviderProfile) {
    const api = claudeProvidersApi();
    if (!api || !window.confirm(`Delete provider '${profile.name}'?`)) {
      return;
    }
    try {
      const result = await api.remove(profile.id);
      if (!result.ok) {
        setListError(result.message || "The provider could not be deleted.");
        return;
      }
      if (editing !== null && editing !== "new" && editing.id === profile.id) {
        testSeqRef.current += 1;
        setEditing(null);
      }
      await refresh();
    } catch (error) {
      setListError(
        error instanceof Error ? error.message : "The provider could not be deleted."
      );
    }
  }

  async function handleSetDefault(profile: ClaudeProviderProfile) {
    const api = claudeProvidersApi();
    if (!api) {
      return;
    }
    try {
      const result = await api.setDefault(profile.id);
      if (!result.ok) {
        setListError(result.message || "The default provider could not be changed.");
        return;
      }
      await refresh();
    } catch (error) {
      setListError(
        error instanceof Error
          ? error.message
          : "The default provider could not be changed."
      );
    }
  }

  const formBusy = saving || testState.status === "testing";

  return (
    <div className="confirmation-backdrop" onClick={onClose}>
      <section
        className="confirmation-dialog settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="settings-header">
          <h2 id="settings-dialog-title">Settings</h2>
          <button
            type="button"
            className="settings-close"
            aria-label="Close settings"
            onClick={onClose}
          >
            <X size={15} />
          </button>
        </header>

        {hint && !hintDismissed && (
          <p className="settings-hint">
            <span>{hint}</span>
            <button
              type="button"
              className="settings-hint-dismiss"
              aria-label="Dismiss note"
              onClick={() => setHintDismissed(true)}
            >
              <X size={12} />
            </button>
          </p>
        )}

        <div className="settings-body">
          <section className="settings-section" aria-labelledby="settings-claude-providers-title">
            <h3 className="settings-section-title" id="settings-claude-providers-title">
              Claude providers
            </h3>

            {loading ? (
              <p className="settings-note">Loading providers…</p>
            ) : editing === null ? (
              <>
                {listError && (
                  <p className="form-error" role="alert">
                    {listError}
                  </p>
                )}
                {profiles.length === 0 ? (
                  <p className="provider-empty">
                    No custom providers yet. Add one to run Claude Code against Kimi, GLM, DeepSeek,
                    or any Anthropic-compatible endpoint — no Anthropic login needed.
                  </p>
                ) : (
                  <ul className="provider-list">
                    {profiles.map((profile) => (
                      <li className="provider-row" key={profile.id}>
                        <div className="provider-row-main">
                          <div className="provider-row-title">
                            <span className="provider-name">{profile.name}</span>
                            {defaultProfileId === profile.id && (
                              <span className="provider-default-badge">Default</span>
                            )}
                          </div>
                          <span className="provider-url" title={profile.baseUrl}>
                            {profile.baseUrl}
                          </span>
                          <span className="provider-model">{profile.model}</span>
                        </div>
                        <div className="provider-row-actions">
                          {defaultProfileId !== profile.id && (
                            <button type="button" onClick={() => void handleSetDefault(profile)}>
                              <Check size={13} />
                              Set default
                            </button>
                          )}
                          <button type="button" onClick={() => openEditForm(profile)}>
                            <Pencil size={13} />
                            Edit
                          </button>
                          <button
                            type="button"
                            className="danger"
                            onClick={() => void handleDelete(profile)}
                          >
                            <Trash2 size={13} />
                            Delete
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
                <button type="button" className="provider-add" onClick={openNewForm}>
                  <Plus size={14} />
                  Add provider
                </button>
              </>
            ) : (
              <form className="provider-form" noValidate onSubmit={(event) => void handleSave(event)}>
                <h4 className="provider-form-title">
                  {editing === "new" ? "Add provider" : "Edit provider"}
                </h4>

                <div className="form-row">
                  <label className="form-label" htmlFor="settings-provider-name">
                    Name
                  </label>
                  <input
                    id="settings-provider-name"
                    className="form-input"
                    type="text"
                    maxLength={60}
                    autoFocus
                    value={form.name}
                    onChange={(event) =>
                      setForm((previous) => ({ ...previous, name: event.target.value }))
                    }
                  />
                </div>

                <div className="form-row">
                  <label className="form-label" htmlFor="settings-provider-base-url">
                    Base URL
                  </label>
                  <input
                    id="settings-provider-base-url"
                    className="form-input"
                    type="text"
                    placeholder="https://api.moonshot.cn/anthropic"
                    value={form.baseUrl}
                    onChange={(event) =>
                      setForm((previous) => ({ ...previous, baseUrl: event.target.value }))
                    }
                  />
                </div>

                <div className="form-row">
                  <label className="form-label" htmlFor="settings-provider-api-key">
                    API key
                  </label>
                  <input
                    id="settings-provider-api-key"
                    className="form-input"
                    type="password"
                    autoComplete="off"
                    placeholder={
                      editingProfile?.hasKey
                        ? "•••••••• (saved — leave blank to keep)"
                        : "Paste the API key"
                    }
                    value={form.apiKey}
                    onChange={(event) =>
                      setForm((previous) => ({ ...previous, apiKey: event.target.value }))
                    }
                  />
                </div>

                <div className="form-row">
                  <label className="form-label" htmlFor="settings-provider-model">
                    Model
                  </label>
                  <input
                    id="settings-provider-model"
                    className="form-input"
                    type="text"
                    placeholder="kimi-k2-0905-preview"
                    value={form.model}
                    onChange={(event) =>
                      setForm((previous) => ({ ...previous, model: event.target.value }))
                    }
                  />
                </div>

                <div className="form-row">
                  <label className="form-label" htmlFor="settings-provider-small-fast-model">
                    Small/fast model
                  </label>
                  <input
                    id="settings-provider-small-fast-model"
                    className="form-input"
                    type="text"
                    placeholder="optional"
                    value={form.smallFastModel}
                    onChange={(event) =>
                      setForm((previous) => ({ ...previous, smallFastModel: event.target.value }))
                    }
                  />
                </div>

                {formError && (
                  <p className="form-error" role="alert">
                    {formError}
                  </p>
                )}
                {testState.status === "ok" && (
                  <p className="form-success" role="status">
                    {testState.modelCount > 0
                      ? `Connected — ${testState.modelCount} models available`
                      : "Connected, but the endpoint listed no models."}
                  </p>
                )}
                {testState.status === "error" && (
                  <p className="form-error" role="alert">
                    {testState.message}
                  </p>
                )}

                <div className="form-actions">
                  <button type="button" disabled={formBusy} onClick={() => void handleTest()}>
                    {testState.status === "testing" ? "Testing…" : "Test connection"}
                  </button>
                  <button type="submit" disabled={formBusy}>
                    {saving ? "Saving…" : "Save"}
                  </button>
                  <button
                    type="button"
                    disabled={formBusy}
                    onClick={() => {
                      testSeqRef.current += 1;
                      setEditing(null);
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}
          </section>
        </div>
      </section>
    </div>
  );
}
