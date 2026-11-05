import { useCallback, useEffect, useState } from "react";
import { Download, LoaderCircle, RefreshCw } from "lucide-react";
import { api } from "../bridge";
import { t } from "../i18n";
import type { DiagnosticsSnapshot } from "../features/diagnostics/types";

type View = "overview" | "logs" | "performance";

const tabs = [
  { id: "overview", label: "diagnosticsOverview" },
  { id: "logs", label: "diagnosticsLogs" },
  { id: "performance", label: "diagnosticsPerformance" },
] as const;

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return String(Math.round(bytes / 1024)) + " KiB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MiB";
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export default function DiagnosticsSettingsPanel() {
  const [view, setView] = useState<View>("overview");
  const [snapshot, setSnapshot] = useState<DiagnosticsSnapshot | null>(null);
  const [error, setError] = useState("");
  const [exportPath, setExportPath] = useState("");
  const [exporting, setExporting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      setSnapshot(await api.DiagnosticsSnapshot());
      setError("");
    } catch {
      setError(t("settings:diagnosticsUnavailable"));
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    let pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const next = await api.DiagnosticsSnapshot();
        if (active) {
          setSnapshot(next);
          setError("");
        }
      } catch {
        if (active) setError(t("settings:diagnosticsUnavailable"));
      } finally {
        pending = false;
      }
    };
    void load();
    const timer = setInterval(() => { void load(); }, 5000);
    return () => { active = false; clearInterval(timer); };
  }, []);

  const exportReport = async () => {
    if (exporting) return;
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

  const metrics = [
    { label: t("settings:diagnosticsGoHeap"), value: snapshot ? formatBytes(snapshot.heapBytes) : "—", description: t("settings:diagnosticsGoHeapDescription") },
    { label: t("settings:diagnosticsGoroutines"), value: snapshot?.goroutines.toLocaleString() ?? "—" },
    { label: t("settings:diagnosticsRecorded"), value: snapshot?.recorded.toLocaleString() ?? "—" },
    { label: t("settings:diagnosticsDropped"), value: snapshot?.dropped.toLocaleString() ?? "—" },
  ];
  const events = (snapshot?.events ?? []).slice(-30).reverse();
  const operations = [...(snapshot?.operations ?? [])].sort((a, b) => b.p95Ms - a.p95Ms).slice(0, 20);

  return (
    <section className="settings-panel settings-diagnostics" aria-labelledby="settings-diagnostics-title">
      <div className="settings-panel-heading">
        <h3 id="settings-diagnostics-title">{t("settings:diagnostics")}</h3>
        <p>{t("settings:diagnosticsDescription")}</p>
      </div>

      <div className="settings-diagnostics-storage">
        <div className="settings-diagnostics-storage-copy">
          <strong>{t("settings:diagnosticsStorage")}</strong>
          <p>{t("settings:diagnosticsPrivacy")}</p>
        </div>
        <span className="settings-diagnostics-storage-status">
          {snapshot ? (snapshot.diskEnabled ? t("settings:diagnosticsLocal") : t("settings:diagnosticsUnavailable")) : "—"}
        </span>
      </div>

      <div className="settings-diagnostics-tabs" role="tablist" aria-label={t("settings:diagnostics")}>
        {tabs.map(tab => (
          <button
            key={tab.id}
            id={"settings-diagnostics-tab-" + tab.id}
            type="button"
            role="tab"
            aria-selected={view === tab.id}
            aria-controls="settings-diagnostics-panel"
            className={view === tab.id ? "active" : ""}
            onClick={() => setView(tab.id)}
          >
            {t("settings:" + tab.label)}
          </button>
        ))}
      </div>

      <div
        id="settings-diagnostics-panel"
        className="settings-diagnostics-content"
        role="tabpanel"
        aria-labelledby={"settings-diagnostics-tab-" + view}
      >
        {view === "overview" && (
          <div className="settings-diagnostics-metrics">
            {metrics.map(metric => (
              <div className="settings-diagnostics-metric" key={metric.label}>
                <span className="settings-diagnostics-metric-label">{metric.label}</span>
                <strong className="settings-diagnostics-metric-value">{metric.value}</strong>
                {metric.description && <span className="settings-diagnostics-metric-description">{metric.description}</span>}
              </div>
            ))}
          </div>
        )}
        {view === "logs" && (
          <div className="settings-diagnostics-list" aria-live="off">
            {events.map((event, index) => (
              <div className="settings-diagnostics-log" key={event.time + "-" + index}>
                <div className="settings-diagnostics-log-header">
                  <span className="settings-diagnostics-log-name" title={event.module + "/" + event.operation}>
                    {event.module}/{event.operation}
                  </span>
                  <span
                    className="settings-diagnostics-level"
                    data-level={event.level}
                    data-status={event.status}
                  >
                    {event.level}
                  </span>
                </div>
                <div className="settings-diagnostics-log-detail">
                  <span>{formatTime(event.time)} · {event.status}{event.code ? " · " + event.code : ""}</span>
                  {event.durationMs != null && <span>{Math.round(event.durationMs)} ms</span>}
                </div>
              </div>
            ))}
            {events.length === 0 && <p className="settings-diagnostics-empty">{t("settings:diagnosticsEmpty")}</p>}
          </div>
        )}
        {view === "performance" && (
          <div className="settings-diagnostics-list" aria-live="off">
            {operations.map(item => (
              <div className="settings-diagnostics-operation" key={item.module + "/" + item.operation}>
                <div className="settings-diagnostics-operation-header">
                  <strong title={item.module + "/" + item.operation}>{item.module}/{item.operation}</strong>
                  <span>{t("settings:diagnosticsSamples")}: {item.count.toLocaleString()}</span>
                </div>
                <div className="settings-diagnostics-operation-metrics">
                  <span>P50 <strong>{item.p50Ms.toFixed(0)} ms</strong></span>
                  <span>P95 <strong>{item.p95Ms.toFixed(0)} ms</strong></span>
                  <span>MAX <strong>{item.maxMs.toFixed(0)} ms</strong></span>
                </div>
              </div>
            ))}
            {operations.length === 0 && <p className="settings-diagnostics-empty">{t("settings:diagnosticsEmpty")}</p>}
          </div>
        )}
      </div>

      <div className="settings-diagnostics-toolbar">
        <button type="button" className="secondary" disabled={refreshing} onClick={() => void refresh()}>
          {refreshing ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}
          {t("settings:diagnosticsRefresh")}
        </button>
        <button type="button" className="primary" disabled={exporting} onClick={() => void exportReport()}>
          {exporting ? <LoaderCircle size={14} className="spin" /> : <Download size={14} />}
          {t("settings:diagnosticsExport")}
        </button>
      </div>
      {exportPath && <p className="settings-diagnostics-exported">{t("settings:diagnosticsExported")}: {exportPath}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </section>
  );
}
