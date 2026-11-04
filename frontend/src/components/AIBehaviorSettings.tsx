import { useEffect, useState, type FormEvent } from "react";
import { Check } from "lucide-react";
import { api, errorText } from "../bridge";
import type { AIRuntimeSettings } from "../types";
import { t } from "../i18n";

export const AI_RUNTIME_SETTINGS_CHANGED = "openshell:ai-runtime-settings-changed";

export const defaultAIRuntimeSettings: AIRuntimeSettings = {
  autoCompact: true,
  compactThreshold: 90,
  maxSteps: 12,
  taskTimeoutMinutes: 10,
  keepRecentTurns: 6,
};

const thresholds = [80, 85, 90, 95];
const steps = [6, 12, 20, 30, 50];
const minutes = [5, 10, 20, 30, 60];
const turns = [2, 4, 6, 10, 20];

export default function AIBehaviorSettings() {
  const [settings, setSettings] = useState<AIRuntimeSettings>(defaultAIRuntimeSettings);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let active = true;
    api.AIRuntimeSettings()
      .then(value => { if (active) setSettings(value); })
      .catch(err => { if (active) setError(errorText(err)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const change = (value: Partial<AIRuntimeSettings>) => {
    setSettings(previous => ({ ...previous, ...value }));
    setSaved(false);
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || loading) return;
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      await api.AISaveRuntimeSettings(settings);
      setSaved(true);
      window.dispatchEvent(new Event(AI_RUNTIME_SETTINGS_CHANGED));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return <section className="settings-ai-runtime" aria-labelledby="settings-ai-runtime-title">
    <h4 id="settings-ai-runtime-title">{t("settings:aiRuntimeTitle")}</h4>
    <p className="muted small">{t("settings:aiRuntimeDescription")}</p>
    <form onSubmit={save}>
      <div className="settings-ai-runtime-row">
        <label htmlFor="ai-auto-compact">{t("settings:aiAutoCompact")}</label>
        <input id="ai-auto-compact" type="checkbox" checked={settings.autoCompact}
          disabled={loading || busy} onChange={e => change({ autoCompact: e.target.checked })} />
      </div>
      <div className="settings-ai-runtime-row">
        <label htmlFor="ai-compact-threshold">{t("settings:aiCompactThreshold")}</label>
        <select id="ai-compact-threshold" value={settings.compactThreshold}
          disabled={loading || busy || !settings.autoCompact}
          onChange={e => change({ compactThreshold: Number(e.target.value) })}>
          {thresholds.map(value => <option key={value} value={value}>{value}%</option>)}
        </select>
      </div>
      <div className="settings-ai-runtime-row">
        <label htmlFor="ai-max-steps">{t("settings:aiMaxSteps")}</label>
        <select id="ai-max-steps" value={settings.maxSteps} disabled={loading || busy}
          onChange={e => change({ maxSteps: Number(e.target.value) })}>
          {steps.map(value => <option key={value} value={value}>{value}</option>)}
        </select>
      </div>
      <div className="settings-ai-runtime-row">
        <label htmlFor="ai-task-timeout">{t("settings:aiTaskTimeout")}</label>
        <select id="ai-task-timeout" value={settings.taskTimeoutMinutes} disabled={loading || busy}
          onChange={e => change({ taskTimeoutMinutes: Number(e.target.value) })}>
          {minutes.map(value => <option key={value} value={value}>{value} {t("settings:aiMinutes")}</option>)}
        </select>
      </div>
      <details className="settings-ai-runtime-advanced">
        <summary>{t("settings:aiAdvancedSettings")}</summary>
        <div className="settings-ai-runtime-row">
          <label htmlFor="ai-keep-turns">{t("settings:aiKeepRecentTurns")}</label>
          <select id="ai-keep-turns" value={settings.keepRecentTurns} disabled={loading || busy}
            onChange={e => change({ keepRecentTurns: Number(e.target.value) })}>
            {turns.map(value => <option key={value} value={value}>{value} {t("settings:aiTurns")}</option>)}
          </select>
        </div>
      </details>
      <p className="muted small">{t("settings:aiRuntimeSafetyNote")}</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      {saved && <p className="form-success"><Check size={14} />{t("settings:aiRuntimeSaved")}</p>}
      <div className="settings-ai-runtime-actions">
        <button type="submit" className="primary" disabled={loading || busy}>
          {t("settings:saveAIBehavior")}
        </button>
      </div>
    </form>
  </section>;
}
