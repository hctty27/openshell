import { useEffect, useState, type FormEvent } from "react";
import { Check, Plus, Trash2 } from "lucide-react";
import { api, errorText } from "../bridge";
import { t } from "../i18n";
import type { AIProvider } from "../types";
import { notifyAIProvidersChanged } from "../features/ai/providerEvents";
import { useDialogs } from "./DialogProvider";
import AIBehaviorSettings from "./AIBehaviorSettings";

const blankProvider = (): AIProvider => ({
  id: "", name: "", baseUrl: "", hasKey: false, models: [],
});

export default function AIProviderSettings() {
  const dialogs = useDialogs();
  const [providers, setProviders] = useState<AIProvider[]>([]);
  const [draft, setDraft] = useState<AIProvider>(blankProvider);
  const [key, setKey] = useState("");
  const [modelText, setModelText] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  useEffect(() => {
    let active = true;
    api.AIProviders()
      .then(items => {
        if (active) setProviders(items ?? []);
      })
      .catch(e => {
        if (active) setError(errorText(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  const edit = (provider?: AIProvider) => {
    setDraft(provider ? { ...provider } : blankProvider());
    setKey("");
    setModelText((provider?.models ?? []).map(model => model.contextWindow ? model.id + " | " + model.contextWindow : model.id).join("\n"));
    setError("");
    setSuccess("");
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const rows = modelText.split(/[\r\n,]+/).map(value => value.trim()).filter(Boolean);
      const models = [...new Map(rows.map(row => {
        const [id, rawWindow, ...extra] = row.split("|").map(value => value.trim());
        const contextWindow = rawWindow ? Number(rawWindow) : undefined;
        if (!id || extra.length || (rawWindow && (!Number.isInteger(contextWindow) || contextWindow! < 4096 || contextWindow! > 262144))) {
          throw new Error(t("settings:aiModelWindowInvalid"));
        }
        return [id, { id, name: id, contextWindow }] as const;
      })).values()];
      const saved = await api.AISaveProvider({
        provider: { ...draft, name: draft.name.trim(), baseUrl: draft.baseUrl.trim(), models },
        apiKey: key.trim(),
      });
      setProviders(current => [...current.filter(item => item.id !== saved.id), saved]);
      edit(saved);
      setSuccess(t("settings:aiProviderSaved"));
      notifyAIProvidersChanged();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!draft.id || busy) return;
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
      setProviders(current => current.filter(item => item.id !== draft.id));
      edit();
      notifyAIProvidersChanged();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-panel settings-ai-providers" aria-labelledby="settings-ai-models-title">
      <div className="settings-panel-heading">
        <h3 id="settings-ai-models-title">{t("settings:aiModels")}</h3>
        <p>{t("settings:aiDescription")}</p>
      </div>
      <div className="settings-ai-provider-list" aria-label={t("settings:aiProviderList")}>
        {loading && <p className="muted small">{t("settings:aiLoading")}</p>}
        {providers.map(provider => (
          <button type="button" key={provider.id} disabled={busy}
            className={draft.id === provider.id ? "settings-ai-provider-item is-selected" : "settings-ai-provider-item"}
            onClick={() => edit(provider)}>
            <strong>{provider.name}</strong>
            <span>{provider.models.length} {t("settings:aiModelCount")}</span>
          </button>
        ))}
        <button type="button" className="settings-ai-provider-add" disabled={busy}
          onClick={() => edit()}>
          <Plus size={14} aria-hidden="true" /> {t("settings:aiAddProvider")}
        </button>
      </div>
      <form className="settings-ai-provider-form" onSubmit={save}>
        <h4>{draft.id ? t("settings:aiEditProvider") : t("settings:aiAddProvider")}</h4>
        <label>
          {t("settings:profileName")}
          <input value={draft.name} disabled={busy} maxLength={100}
            onChange={event => setDraft(old => ({ ...old, name: event.target.value }))}
            placeholder="My API" required />
        </label>
        <label>
          Base URL
          <input type="url" value={draft.baseUrl} disabled={busy}
            onChange={event => setDraft(old => ({ ...old, baseUrl: event.target.value }))}
            placeholder="https://api.example.com/v1" required />
        </label>
        <label>
          API Key
          <input type="password" value={key} disabled={busy} autoComplete="new-password"
            onChange={event => setKey(event.target.value)}
            placeholder={draft.hasKey ? t("settings:keySavedLeaveEmptyToKeepIt") : "sk-..."}
            required={!draft.hasKey} />
        </label>
        <label>
          {t("settings:aiModelIDs")}
          <textarea value={modelText} disabled={busy} rows={4}
            onChange={event => setModelText(event.target.value)}
            placeholder={"model-one | 262144\nmodel-two | 32768"} required />
        </label>
        <p className="muted small">{t("settings:aiModelIDsHelp")}</p>
        {error && <p className="form-error" role="alert">{error}</p>}
        {success && <p className="form-success"><Check size={14} />{success}</p>}
        <div className="settings-ai-provider-actions">
          {draft.id && (
            <button type="button" className="settings-ai-delete" disabled={busy}
              onClick={() => void remove()}>
              <Trash2 size={14} aria-hidden="true" />{t("settings:deleteProfile")}
            </button>
          )}
          <button type="submit" className="primary" disabled={busy || loading}>
            {t("settings:saveProfile")}
          </button>
        </div>
      </form>
      <AIBehaviorSettings />
    </section>
  );
}
