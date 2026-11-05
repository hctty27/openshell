import { useCallback, useEffect, useState } from "react";
import { api } from "../bridge";
import { t } from "../i18n";
import type { DiagnosticsSnapshot } from "../features/diagnostics/types";

type View = "overview" | "logs" | "performance";

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export default function DiagnosticsSettingsPanel() {
  const [view, setView] = useState<View>("overview");
  const [snapshot, setSnapshot] = useState<DiagnosticsSnapshot | null>(null);
  const [error, setError] = useState("");
  const [exportPath, setExportPath] = useState("");
  const [exporting, setExporting] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const next = await api.DiagnosticsSnapshot();
      setSnapshot(next);
      setError("");
    } catch {
      setError(t("settings:diagnosticsUnavailable"));
    }
  }, []);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const next = await api.DiagnosticsSnapshot();
        if (active) { setSnapshot(next); setError(""); }
      } catch {
        if (active) setError(t("settings:diagnosticsUnavailable"));
      }
    };
    void load();
    const timer = setInterval(() => { void load(); }, 5000);
    return () => { active = false; clearInterval(timer); };
  }, []);

  const exportReport = async () => {
    setExporting(true);
    setExportPath("");
    try {
      setExportPath(await api.DiagnosticsExport());
      setError("");
    } catch {
      setError(t("settings:diagnosticsExportFailed"));
    } finally {
      setExporting(false);
    }
  };

  return (
    <section className="settings-panel" aria-labelledby="settings-diagnostics-title">
      <div className="settings-panel-heading">
        <h3 id="settings-diagnostics-title">{t("settings:diagnostics")}</h3>
        <p>{t("settings:diagnosticsDescription")}</p>
      </div>
      <div className="settings-control-row">
        <div className="settings-control-copy">
          <label>{t("settings:diagnosticsStorage")}</label>
          <p>{t("settings:diagnosticsPrivacy")}</p>
        </div>
        <strong>{snapshot?.diskEnabled ? t("settings:diagnosticsLocal") : t("settings:diagnosticsUnavailable")}</strong>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {([
          ["overview", "diagnosticsOverview"],
          ["logs", "diagnosticsLogs"],
          ["performance", "diagnosticsPerformance"],
        ] as const).map(([id, key]) => (
          <button key={id} type="button" className={view === id ? "primary" : "secondary"} onClick={() => setView(id)}>
            {t(`settings:${key}`)}
          </button>
        ))}
      </div>
      {view === "overview" && (
        <div className="settings-control-row">
          <div className="settings-control-copy">
            <label>{t("settings:diagnosticsGoHeap")}</label>
            <p>{t("settings:diagnosticsGoHeapDescription")}</p>
          </div>
          <strong>{snapshot ? formatBytes(snapshot.heapBytes) : "—"}</strong>
          <div className="settings-control-copy">
            <label>{t("settings:diagnosticsGoroutines")}</label>
          </div>
          <strong>{snapshot?.goroutines ?? "—"}</strong>
          <div className="settings-control-copy">
            <label>{t("settings:diagnosticsRecorded")}</label>
          </div>
          <strong>{snapshot?.recorded ?? "—"}</strong>
          <div className="settings-control-copy">
            <label>{t("settings:diagnosticsDropped")}</label>
          </div>
          <strong>{snapshot?.dropped ?? "—"}</strong>
        </div>
      )}
      {view === "logs" && (
        <div style={{ display: "grid", gap: 8, maxHeight: 240, overflowY: "auto" }}>
          {snapshot?.events.slice(-30).reverse().map((event, index) => (
            <div key={`${event.time}-${index}`} className="settings-control-row">
              <div className="settings-control-copy">
                <label>{event.level} · {event.module}/{event.operation}</label>
                <p>{new Date(event.time).toLocaleTimeString()} · {event.status} · {event.durationMs ?? 0}ms</p>
              </div>
            </div>
          ))}
          {!snapshot?.events.length && <p>{t("settings:diagnosticsEmpty")}</p>}
        </div>
      )}
      {view === "performance" && (
        <div style={{ display: "grid", gap: 8, maxHeight: 240, overflowY: "auto" }}>
          {snapshot?.operations.slice(0, 20).map(item => (
            <div key={`${item.module}/${item.operation}`} className="settings-control-row">
              <div className="settings-control-copy">
                <label>{item.module}/{item.operation}</label>
                <p>{t("settings:diagnosticsSamples")}: {item.count}</p>
              </div>
              <strong>P95 {item.p95Ms.toFixed(0)}ms</strong>
            </div>
          ))}
          {!snapshot?.operations.length && <p>{t("settings:diagnosticsEmpty")}</p>}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" onClick={() => void refresh()}>{t("settings:diagnosticsRefresh")}</button>
        <button type="button" className="primary" disabled={exporting} onClick={() => void exportReport()}>
          {t("settings:diagnosticsExport")}
        </button>
      </div>
      {exportPath && <p style={{ overflowWrap: "anywhere" }}>{t("settings:diagnosticsExported")}: {exportPath}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </section>
  );
}
