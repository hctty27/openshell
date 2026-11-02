import { useEffect, useState } from "react";
import { Copy, Minus, Settings, Square, SquareTerminal, X } from "lucide-react";
import { Window } from "@wailsio/runtime";
import { nativeDesktop } from "../bridge";
import { t } from "../i18n";
import type { Tab } from "../types";
import TransferCenter from "./TransferCenter";

interface Props {
  tabs: Tab[];
  onSettings(): void;
  onNotice(error: unknown): void;
}

export default function WindowTitleBar({ tabs, onSettings, onNotice }: Props) {
  const [maximised, setMaximised] = useState(false);

  useEffect(() => {
    if (!nativeDesktop) return;
    let active = true;
    const syncWindowState = () => {
      void Window.IsMaximised().then(value => {
        if (active) setMaximised(value);
      }).catch(() => {});
    };
    syncWindowState();
    window.addEventListener("resize", syncWindowState);
    return () => {
      active = false;
      window.removeEventListener("resize", syncWindowState);
    };
  }, []);

  const toggleMaximise = () => {
    if (nativeDesktop) void (maximised ? Window.Restore() : Window.Maximise()).catch(onNotice);
  };

  return (
    <header className="window-titlebar">
      <div className="window-titlebar-brand" onDoubleClick={toggleMaximise}>
        <SquareTerminal size={15} aria-hidden="true" />
        <span>OpenShell</span>
      </div>
      <div className="window-titlebar-drag-area" onDoubleClick={toggleMaximise} aria-hidden="true" />
      <div className="window-titlebar-actions">
        <TransferCenter tabs={tabs} onNotice={onNotice} />
        <button type="button" className="window-titlebar-settings"
          title={t("common:settings")} aria-label={t("common:settings")}
          onClick={onSettings}>
          <Settings size={16} aria-hidden="true" />
        </button>
      </div>
      {nativeDesktop && (
        <div className="window-titlebar-controls">
          <button type="button" className="window-control"
            title={t("common:minimizeWindow")} aria-label={t("common:minimizeWindow")}
            onClick={() => { if (nativeDesktop) void Window.Minimise().catch(onNotice); }}>
            <Minus size={15} aria-hidden="true" />
          </button>
          <button type="button" className="window-control"
            title={t(maximised ? "common:restoreWindow" : "common:maximizeWindow")}
            aria-label={t(maximised ? "common:restoreWindow" : "common:maximizeWindow")}
            onClick={toggleMaximise}>
            {maximised ? <Copy size={13} aria-hidden="true" /> : <Square size={13} aria-hidden="true" />}
          </button>
          <button type="button" className="window-control window-control-close"
            title={t("common:closeWindow")} aria-label={t("common:closeWindow")}
            onClick={() => { if (nativeDesktop) void Window.Close().catch(onNotice); }}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      )}
    </header>
  );
}
