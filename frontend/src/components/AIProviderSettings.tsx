import { useEffect, useState, type FormEvent } from "react";
import { Check, Plus, Trash2 } from "lucide-react";
import { api, errorText } from "../bridge";
import { t } from "../i18n";
import type { AIModel, AIProvider } from "../types";
import { notifyAIProvidersChanged } from "../features/ai/providerEvents";
import { useDialogs } from "./DialogProvider";
import AIBehaviorSettings from "./AIBehaviorSettings";

type AISection = "providers" | "context" | "execution";

interface Props {
  onDirtyChange?(dirty: boolean): void;
}

const blankProvider = (): AIProvider => ({
  id: "", name: "", baseUrl: "", hasKey: false, models: [],
});

function providerSignature(provider: AIProvider, key: string): string {
  return JSON.stringify({
    name: provider.name,
    baseUrl: provider.baseUrl,
    models: provider.models.map(model => ({ id: model.id, contextWindow: model.contextWindow })),
    key,
  });
}

export default function AIProviderSettings({ onDirtyChange }: Props) {
  const dialogs = useDialogs();
  const [section, setSection] = useState<AISection>("providers");
  const [providers, setProviders] = useState<AIProvider[]>([]);
  const [draft, setDraft] = useState<AIProvider>(blankProvider);
  const [key, setKey] = useState("");
  const [baseline, setBaseline] = useState(() => providerSignature(blankProvider(), ""));
  const [runtimeDirty, setRuntimeDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const providerDirty = providerSignature(draft, key) !== baseline;
  const dirty = section === "providers" ? providerDirty : runtimeDirty;

  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);

  const edit = (provider?: AIProvider) => {
    const next = provider ? { ...provider, models: provider.models.map(model => ({ ...model })) } : blankProvider();
    setDraft(next);
    setKey("");
    setBaseline(providerSignature(next, ""));
    setError("");
    setSuccess("");
  };

  useEffect(() => {
    let active = true;
    void api.AIProviders()
      .then(items => {
        if (!active) return;
        setProviders(items);
        if (items.length > 0) edit(items[0]);
      })
      .catch(err => { if (active) setError(errorText(err)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const confirmDiscard = () => dialogs.confirm({
    title: t("settings:aiUnsavedChangesTitle"),
    description: t("settings:aiUnsavedChangesDescription"),
    confirmLabel: t("settings:discardSessionChanges"),
    cancelLabel: t("settings:continueEditing"),
    tone: "warning",
  });

  const selectProvider = async (provider?: AIProvider) => {
    if (busy || loading) return;
    if (providerDirty && !(await confirmDiscard())) return;
    edit(provider);
  };

  const selectSection = async (next: AISection) => {
    if (next === section || busy) return;
    if (dirty && !(await confirmDiscard())) return;
    if (section === "providers") {
      edit(providers.find(item => item.id === draft.id));
    } else {
      setRuntimeDirty(false);
    }
    setSection(next);
  };

  const updateModel = (index: number, patch: Partial<AIModel>) => {
    setDraft(current => ({
      ...current,
      models: current.models.map((model, i) => i === index ? { ...model, ...patch } : model),
    }));
    setSuccess("");
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || loading) return;
    setError("");
    setSuccess("");
    const models = draft.models.map(model => ({
      id: model.id.trim(),
      name: model.id.trim(),
      contextWindow: model.contextWindow,
    }));
    if (models.length === 0 || models.some(model => !model.id)) {
      setError(t("settings:aiModelAtLeastOne"));
      return;
    }
    if (new Set(models.map(model => model.id)).size !== models.length) {
      setError(t("settings:aiModelDuplicate"));
      return;
    }
    if (models.some(model => model.contextWindow !== undefined && (
      !Number.isInteger(model.contextWindow) || model.contextWindow < 4096 || model.contextWindow > 262144
    ))) {
      setError(t("settings:aiModelWindowInvalid"));
      return;
    }
    setBusy(true);
    try {
      const saved = await api.AISaveProvider({
        provider: { ...draft, name: draft.name.trim(), baseUrl: draft.baseUrl.trim(), models },
        apiKey: key.trim(),
      });
      setProviders(current => [...current.filter(item => item.id !== saved.id), saved]);
      edit(saved);
      setSuccess(t("settings:aiProviderSaved"));
      notifyAIProvidersChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!draft.id || busy || loading) return;
    const confirmed = await dialogs.confirm({
      title: t("settings:deleteAiApiProfile"),
      description: t("settings:deleteThisApiProfileAndItsSavedKey"),
      confirmLabel: t("settings:deleteProfile"),
      cancelLabel: t("common:cancel"),
      tone: "danger",
    });
    if (!confirmed) return;
    setBusy(true);
    setError("");
    try {
      await api.AIDeleteProvider(draft.id);
      const remaining = providers.filter(item => item.id !== draft.id);
      setProviders(remaining);
      edit(remaining[0]);
      notifyAIProvidersChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-panel settings-ai-providers" aria-labelledby="settings-ai-title">
      <div className="settings-panel-heading">
        <h3 id="settings-ai-title">{t("settings:aiSettings")}</h3>
        <p>{t("settings:aiDescription")}</p>
      </div>
      <div className="settings-ai-tabs" role="tablist" aria-label={t("settings:aiSettings")}>
        {([
          ["providers", t("settings:aiProvidersTab")],
          ["context", t("settings:aiContextTab")],
          ["execution", t("settings:aiExecutionTab")],
        ] as const).map(([value, label]) => (
          <button key={value} type="button" role="tab" aria-selected={section === value}
            className={section === value ? "active" : ""}
            onClick={() => void selectSection(value)}>{label}</button>
        ))}
      </div>
      {section === "providers" ? (
        <div className="settings-ai-provider-layout">
          <div className="settings-ai-provider-list" aria-label={t("settings:aiProviderList")}>
            {loading && <p className="muted small">{t("settings:aiLoading")}</p>}
            {providers.map(provider => (
              <button type="button" key={provider.id} disabled={busy || loading}
                className={draft.id === provider.id ? "settings-ai-provider-item is-selected" : "settings-ai-provider-item"}
                onClick={() => void selectProvider(provider)}>
                <strong title={provider.name}>{provider.name}</strong>
                <span>{provider.models.length} {t("settings:aiModelCount")}</span>
              </button>
            ))}
            <button type="button" className="settings-ai-provider-add" disabled={busy || loading}
              onClick={() => void selectProvider()}>
              <Plus size={14} aria-hidden="true" /> {t("settings:aiAddProvider")}
            </button>
          </div>
          <form className="settings-ai-provider-form" onSubmit={save}>
            <h4>{draft.id ? t("settings:aiEditProvider") : t("settings:aiAddProvider")}</h4>
            <label>
              {t("settings:profileName")}
              <input value={draft.name} disabled={busy || loading} maxLength={100}
                onChange={event => setDraft(current => ({ ...current, name: event.target.value }))}
                placeholder={t("settings:enterApiProfileName")} required />
            </label>
            <label>
              Base URL
              <input type="url" value={draft.baseUrl} disabled={busy || loading}
                onChange={event => setDraft(current => ({ ...current, baseUrl: event.target.value }))}
                placeholder="https://api.example.com/v1" required />
            </label>
            <label>
              API Key
              <input type="password" value={key} disabled={busy || loading} autoComplete="new-password"
                onChange={event => setKey(event.target.value)}
                placeholder={draft.hasKey ? t("settings:keySavedLeaveEmptyToKeepIt") : "sk-..."}
                required={!draft.hasKey} />
            </label>
            <div className="settings-ai-model-heading">
              <strong>{t("settings:aiModels")}</strong>
              <button type="button" disabled={busy || loading} onClick={() => {
                setDraft(current => ({ ...current, models: [...current.models, { id: "", name: "" }] }));
                setSuccess("");
              }}>
                <Plus size={14} aria-hidden="true" /> {t("settings:aiAddModel")}
              </button>
            </div>
            <div className="settings-ai-model-list">
              {draft.models.length === 0 && <p className="muted small">{t("settings:aiModelAtLeastOne")}</p>}
              {draft.models.map((model, index) => (
                <div className="settings-ai-model-row" key={index}>
                  <input aria-label={t("settings:aiModelId")} placeholder={t("settings:aiModelId")}
                    value={model.id} disabled={busy || loading}
                    onChange={event => updateModel(index, { id: event.target.value, name: event.target.value })} />
                  <input type="number" aria-label={t("settings:aiModelContextWindow")}
                    title={t("settings:aiContextWindowHint")} placeholder="32768"
                    min={4096} max={262144} step={1} value={model.contextWindow ?? ""}
                    disabled={busy || loading}
                    onChange={event => updateModel(index, { contextWindow: event.target.value ? Number(event.target.value) : undefined })} />
                  <button type="button" className="settings-ai-model-remove"
                    aria-label={t("settings:aiRemoveModel")} title={t("settings:aiRemoveModel")}
                    disabled={busy || loading}
                    onClick={() => setDraft(current => ({
                      ...current,
                      models: current.models.filter((_, i) => i !== index),
                    }))}>
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
            <p className="muted small">{t("settings:aiContextWindowHint")}</p>
            {error && <p className="form-error" role="alert">{error}</p>}
            {success && <p className="form-success"><Check size={14} />{success}</p>}
            <div className="settings-ai-provider-actions">
              {draft.id && (
                <button type="button" className="settings-ai-delete" disabled={busy || loading}
                  onClick={() => void remove()}>
                  <Trash2 size={14} aria-hidden="true" />{t("settings:deleteProfile")}
                </button>
              )}
              <button type="submit" className="primary" disabled={busy || loading}>
                {t("settings:saveProfile")}
              </button>
            </div>
          </form>
        </div>
      ) : (
        <AIBehaviorSettings key={section} section={section} onDirtyChange={setRuntimeDirty} />
      )}
    </section>
  );
}
