import { useTranslation } from "react-i18next";
import { message, type DisplayText } from "../i18n/message";
import { t } from "../i18n";
import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { api, listen, errorText } from "../bridge";
import {
  BrowserOpenURL,
  ClipboardGetText,
  ClipboardSetText,
} from "../../wailsjs/runtime/runtime";
import type { Tab, Ref, Theme } from "../types";
import { terminalThemes } from "../terminalThemes";
import { useDialogs } from "./DialogProvider";
interface Props {
  tab: Tab;
  active: boolean;
  visible?: boolean;
  onActivate?: () => void;
  fontSize: number;
  theme: Theme;
  autoCopySelection: boolean;
  rightClickPaste: boolean;
  middleClickPaste?: boolean;
  logHighlights?: boolean;
  confirmMultilinePaste: boolean;
  onNotice(text: unknown): void;
  commandFocusVersion?: number;
  searchFocusVersion?: number;
  onError(text: unknown): void;
  onSelection(text: string): void;
}
export default function TerminalPane(p: Props) {
  useTranslation();
  const dialogs = useDialogs();
  const dialogsRef = useRef(dialogs);
  dialogsRef.current = dialogs;
  const container = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const searchAddon = useRef<SearchAddon | null>(null);
  const logAddons = useRef<SearchAddon[]>([]);
  const webglAddon = useRef<WebglAddon | null>(null);
  const webglFailed = useRef(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [regexMode, setRegexMode] = useState(false);
  const callbacks = useRef(p);
  callbacks.current = p;
  useEffect(() => {
    const ref = p.tab.ref;
    if (!ref || p.tab.status !== "connected" || !container.current) return;
    let pastePending = false;
    let disposed = false,
      pending = 0,
      overloaded = false;
    const term = new Terminal({
      fontFamily: 'Cascadia Mono,Consolas,"Microsoft YaHei",monospace',
      fontSize: p.fontSize,
      theme: terminalThemes[callbacks.current.theme],
      overviewRuler: { width: 6 },
      minimumContrastRatio: 4.5,
      cursorBlink: true,
      scrollback: 10000,
      allowProposedApi: false,
    });
    const addon = new FitAddon();
    term.loadAddon(addon);
    const search = new SearchAddon();
    term.loadAddon(search);
    searchAddon.current = search;
    term.loadAddon(new WebLinksAddon((_event, url) => {
      if (/^https?:\/\//i.test(url)) BrowserOpenURL(url);
    }));
    terminal.current = term;
    fit.current = addon;
    term.open(container.current);
    let opened = false;
    let lastSize = "";
    const same = (r: Ref) =>
      r.tabId === ref.tabId && r.generation === ref.generation;
    const off = listen("ssh:output", (payload) => {
      if (disposed || !same(payload.ref) || overloaded) return;
      const bytes = Uint8Array.from(atob(payload.data), (c) => c.charCodeAt(0));
      pending += bytes.length;
      if (pending > 2 * 1024 * 1024) {
        overloaded = true;
        callbacks.current.onError(
          message(
            "terminal:terminalOutputExceededTheProcessingLimitDisconnectedLimit",
          ),
        );
        api.Disconnect(ref);
        return;
      }
      term.write(bytes, () => {
        pending -= bytes.length;
      });
    });
    const encoder = new TextEncoder();
    const inputQueue: string[] = [];
    let inputFlushing = false;
    let inputScheduled = false;
    const flushInput = async () => {
      if (inputFlushing || disposed) return;
      inputFlushing = true;
      try {
        while (inputQueue.length && !disposed) {
          const bytes = encoder.encode(inputQueue.splice(0).join(""));
          for (let offset = 0; offset < bytes.length && !disposed; offset += 64 * 1024) {
            const chunk = bytes.subarray(offset, offset + 64 * 1024);
            let binary = "";
            for (let i = 0; i < chunk.length; i += 8192) {
              binary += String.fromCharCode(...chunk.subarray(i, i + 8192));
            }
            await api.WriteTerminal(ref, btoa(binary));
          }
        }
      } catch (error) {
        inputQueue.length = 0;
        if (!disposed) callbacks.current.onError(error);
      } finally {
        inputFlushing = false;
        if (inputQueue.length && !disposed) scheduleInput();
      }
    };
    const scheduleInput = () => {
      if (inputScheduled) return;
      inputScheduled = true;
      queueMicrotask(() => {
        inputScheduled = false;
        void flushInput();
      });
    };
    const input = term.onData((data) => {
      inputQueue.push(data);
      scheduleInput();
    });
    const sendResize = () => {
      if (!opened || disposed) return;
      const size = `${term.cols}x${term.rows}`;
      if (size === lastSize) return;
      lastSize = size;
      void api.ResizeTerminal(ref, term.cols, term.rows).catch(() => {});
    };
    const resizeSubscription = term.onResize(sendResize);
    const selection = term.onSelectionChange(() =>
      callbacks.current.onSelection(term.getSelection()),
    );
    let selectingWithMouse = false;
    const paneElement = container.current.parentElement ?? container.current;
    const onMouseDown = (event: MouseEvent) => {
      if ((event.target as HTMLElement).closest(".terminal-find, .terminal-transfer-indicator")) return;
      if (callbacks.current.visible ?? callbacks.current.active) callbacks.current.onActivate?.();
      if (
        event.button === 1 && callbacks.current.middleClickPaste &&
        callbacks.current.active && term.modes.mouseTrackingMode === "none"
      ) {
        event.preventDefault();
        void pasteFromClipboard();
        return;
      }
      selectingWithMouse =
        event.button === 0 &&
        callbacks.current.active &&
        (term.modes.mouseTrackingMode === "none" ||
          event.shiftKey);
    };
    const onMouseUp = (event: MouseEvent) => {
      if (event.button !== 0 || !selectingWithMouse) return;
      selectingWithMouse = false;
      setTimeout(() => {
        if (
          disposed ||
          !callbacks.current.active ||
          !callbacks.current.autoCopySelection
        )
          return;
        const text = term.getSelection();
        if (!text) return;
        void ClipboardSetText(text)
          .then((success) => {
            if (!success)
              callbacks.current.onNotice(
                message("terminal:failedToCopySelection"),
              );
          })
          .catch((error) => callbacks.current.onNotice(error));
      }, 0);
    };
    const pasteFromClipboard = async () => {
      if (pastePending || disposed || !callbacks.current.active) return;
      pastePending = true;
      try {
        const text = await ClipboardGetText();
        if (disposed || !callbacks.current.active || !text) return;
        if (callbacks.current.confirmMultilinePaste && /[\r\n]/.test(text)) {
          const accepted = await dialogsRef.current.confirm({
            title: message("terminal:confirmMultilinePaste"),
            description: message(
              "terminal:targetTheClipboardContainsMultipleLinesPastingMay",
              { name: callbacks.current.tab.session.name },
            ),
            preview: text,
            tone: "warning",
            confirmLabel: message("terminal:paste"),
          });
          if (!accepted) return;
        }
        const currentRef = callbacks.current.tab.ref;
        if (
          disposed ||
          !callbacks.current.active ||
          currentRef?.tabId !== ref.tabId ||
          currentRef?.sessionId !== ref.sessionId ||
          currentRef?.generation !== ref.generation
        ) return;
        term.focus();
        term.paste(text);
      } catch (error) {
        if (!disposed) callbacks.current.onNotice(error);
      } finally {
        pastePending = false;
      }
    };
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown" || !callbacks.current.active) return true;
      if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey) return true;
      switch (event.key.toLowerCase()) {
        case "f":
          event.preventDefault();
          setSearchOpen(true);
          return false;
        case "c": {
          event.preventDefault();
          const selected = term.getSelection();
          if (selected) {
            void ClipboardSetText(selected).catch((error) => callbacks.current.onNotice(error));
          }
          return false;
        }
        case "v":
          event.preventDefault();
          void pasteFromClipboard();
          return false;
        default:
          return true;
      }
    });
    const onContextMenu = (event: MouseEvent) => {
      if (!callbacks.current.active || !callbacks.current.rightClickPaste) return;
      if ((event.target as HTMLElement).closest(".terminal-find")) return;
      if (term.modes.mouseTrackingMode !== "none") return;
      event.preventDefault();
      event.stopPropagation();
      void pasteFromClipboard();
    };
    const onAuxClick = (event: MouseEvent) => {
      if (
        event.button === 1 && callbacks.current.middleClickPaste &&
        callbacks.current.active && term.modes.mouseTrackingMode === "none" &&
        !(event.target as HTMLElement).closest(".terminal-find")
      ) event.preventDefault();
    };
    paneElement.addEventListener("mousedown", onMouseDown, true);
    paneElement.addEventListener("auxclick", onAuxClick, true);
    document.addEventListener("mouseup", onMouseUp, true);
    paneElement.addEventListener("contextmenu", onContextMenu, true);
    let resizeTimer: ReturnType<typeof setTimeout>;
    const resize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (disposed || !(callbacks.current.visible ?? callbacks.current.active) || !container.current?.offsetWidth) return;
        addon.fit();
      }, 80);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container.current);
    requestAnimationFrame(() => {
      if (disposed) return;
      addon.fit();
      const cols = Math.max(term.cols, 20);
      const rows = Math.max(term.rows, 5);
      api
        .OpenTerminal(ref, cols, rows)
        .then(() => {
          if (disposed) return;
          opened = true;
          lastSize = `${cols}x${rows}`;
          sendResize();
          if (callbacks.current.active) term.focus();
        })
        .catch((e) => callbacks.current.onError(e));
    });
    return () => {
      disposed = true;
      inputQueue.length = 0;
      clearTimeout(resizeTimer);
      observer.disconnect();
      off();
      paneElement.removeEventListener("mousedown", onMouseDown, true);
      paneElement.removeEventListener("auxclick", onAuxClick, true);
      document.removeEventListener("mouseup", onMouseUp, true);
      paneElement.removeEventListener("contextmenu", onContextMenu, true);
      input.dispose();
      resizeSubscription.dispose();
      selection.dispose();
      term.dispose();
      logAddons.current = [];
      webglAddon.current = null;
      webglFailed.current = false;
      searchAddon.current = null;
      terminal.current = null;
      fit.current = null;
    };
  }, [p.tab.ref?.generation, p.tab.id]);
  useEffect(() => {
    const term = terminal.current;
    if (!term) return;
    for (const addon of logAddons.current) addon.dispose();
    logAddons.current = [];
    if (!p.logHighlights) return;
    const viewportY = term.buffer.active.viewportY;
    const severityRules = [
      { expression: "\\b(?:ERROR|FATAL|FAILED|FAIL)\\b", foreground: "#ad2935", background: "#973344", ruler: "#e75d67" },
      { expression: "\\bWARN(?:ING)?\\b", foreground: "#855d18", background: "#8c671f", ruler: "#e4ac47" },
    ];
    for (const rule of severityRules) {
      const addon = new SearchAddon({ highlightLimit: 250 });
      term.loadAddon(addon);
      logAddons.current.push(addon);
      addon.findNext(rule.expression, {
        regex: true,
        caseSensitive: false,
        decorations: {
          matchBackground: rule.background,
          matchOverviewRuler: rule.ruler,
          activeMatchBackground: rule.background,
          activeMatchColorOverviewRuler: rule.ruler,
        },
      });
      addon.clearActiveDecoration();
    }
    term.clearSelection();
    term.scrollToLine(viewportY);
    return () => {
      for (const addon of logAddons.current) addon.dispose();
      logAddons.current = [];
    };
  }, [p.logHighlights, p.tab.ref?.generation]);
  useEffect(() => {
    const term = terminal.current;
    if (!term) return;
    if (!p.active) {
      webglAddon.current?.dispose();
      webglAddon.current = null;
      return;
    }
    if (webglAddon.current || webglFailed.current) return;
    let addon: WebglAddon | null = null;
    try {
      addon = new WebglAddon();
      const activeAddon = addon;
      addon.onContextLoss(() => {
        activeAddon.dispose();
        if (webglAddon.current === activeAddon) webglAddon.current = null;
        webglFailed.current = true;
      });
      term.loadAddon(addon);
      webglAddon.current = addon;
    } catch {
      addon?.dispose();
      webglFailed.current = true;
    }
  }, [p.active, p.tab.ref?.generation]);
  useEffect(() => {
    if (terminal.current) {
      terminal.current.options.fontSize = p.fontSize;
      fit.current?.fit();
    }
  }, [p.fontSize]);
  useEffect(() => {
    if (terminal.current)
      terminal.current.options.theme = terminalThemes[p.theme];
  }, [p.theme]);
  useEffect(() => {
    if (p.visible && !p.active) {
      requestAnimationFrame(() => fit.current?.fit());
    }
  }, [p.visible, p.active]);
  useEffect(() => {
    if (p.active) {
      requestAnimationFrame(() => {
        fit.current?.fit();
        if (searchOpen) searchInput.current?.focus();
        else terminal.current?.focus();
      });
    }
  }, [p.active, searchOpen]);
  useEffect(() => {
    if (p.active && p.commandFocusVersion && !searchOpen) terminal.current?.focus();
  }, [p.commandFocusVersion]);
  useEffect(() => {
    if (p.active && p.searchFocusVersion) setSearchOpen(true);
  }, [p.searchFocusVersion]);
  const closeSearch = () => {
    searchAddon.current?.clearDecorations();
    setSearchOpen(false);
    terminal.current?.focus();
  };
  const searchOptions = (regex: boolean) => ({
    regex,
    decorations: {
      matchOverviewRuler: "#d59d54",
      activeMatchColorOverviewRuler: "#7bcbb2",
      matchBackground: "#806127",
      activeMatchBackground: "#16745f",
    },
  });
  const find = (forward: boolean) => {
    if (!searchText) return;
    if (regexMode) {
      try { new RegExp(searchText); } catch { return; }
    }
    if (forward) searchAddon.current?.findNext(searchText, searchOptions(regexMode));
    else searchAddon.current?.findPrevious(searchText, searchOptions(regexMode));
  };
  const highlightLogs = () => {
    const pattern = "ERROR|WARN(?:ING)?|FATAL|FAIL(?:ED)?";
    setSearchText(pattern);
    setRegexMode(true);
    setSearchOpen(true);
    searchAddon.current?.findNext(pattern, searchOptions(true));
  };
  return (
    <div className={`terminal-pane ${(p.visible ?? p.active) ? "visible" : ""} ${p.active ? "active" : ""}`}
      aria-label={t("terminal:terminal", { name: p.tab.session.name })}>
      <div className="terminal-surface" ref={container} />
      {p.active && searchOpen && (
        <div className="terminal-find">
          <input
            ref={searchInput}
            value={searchText}
            aria-label={t("terminal:findInTerminal")}
            placeholder={t("terminal:findInTerminal")}
            onChange={(event) => {
              const next = event.target.value;
              setSearchText(next);
              if (next) searchAddon.current?.findNext(next, {
                ...searchOptions(regexMode), incremental: true,
              });
              else searchAddon.current?.clearDecorations();
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") closeSearch();
              else if (event.key === "Enter") {
                event.preventDefault();
                find(!event.shiftKey);
              }
            }}
          />
          <button type="button"
            className={regexMode ? "selected" : ""}
            title={t("terminal:regexSearch")} aria-label={t("terminal:regexSearch")}
            aria-pressed={regexMode}
            onClick={() => {
              const next = !regexMode;
              setRegexMode(next);
              if (searchText) searchAddon.current?.findNext(searchText, searchOptions(next));
            }}>.*</button>
          <button type="button" className="terminal-log-preset" title={t("terminal:highlightLogLevels")}
            aria-label={t("terminal:highlightLogLevels")} onClick={highlightLogs}>
            {t("terminal:logs")}
          </button>
          <button type="button" title={t("terminal:previousMatch")} aria-label={t("terminal:previousMatch")}
            onClick={() => find(false)}>↑</button>
          <button type="button" title={t("terminal:nextMatch")} aria-label={t("terminal:nextMatch")}
            onClick={() => find(true)}>↓</button>
          <button type="button" title={t("terminal:closeSearch")} aria-label={t("terminal:closeSearch")}
            onClick={closeSearch}>×</button>
        </div>
      )}
    </div>
  );
}
