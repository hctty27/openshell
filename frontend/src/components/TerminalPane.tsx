import { useTranslation } from "react-i18next";
import { message, type DisplayText } from "../i18n/message";
import { t } from "../i18n";
import { useEffect, useRef, useState, type CSSProperties } from "react";
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
import type { Tab, Ref, Theme, TerminalTheme } from "../types";
import { resolveTerminalTheme } from "../terminalThemes";
import { parseOsc7Directory, parseOsc1337Directory, parseOscTitleDirectory } from "../terminalCwd";
import { useDialogs } from "./DialogProvider";
interface Props {
  tab: Tab;
  disconnectBehavior?: import("../types").DisconnectBehavior;
  localShell?: import("../types").LocalShell;
  preserveHistory?: boolean;
  showDisconnectReason?: boolean;
  active: boolean;
  visible?: boolean;
  onActivate?: () => void;
  fontSize: number;
  theme: Theme;
  terminalTheme?: TerminalTheme;
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
  onDirectoryChange?(ref: Ref, directory: string): void;
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
  const scrollbackSnapshot = useRef("");
  const localSequence = useRef(0);
  const terminalMode = p.tab.status === "connected" && p.tab.ref ? "ssh"
    : p.tab.ref && p.tab.everConnected && ["disconnected", "error"].includes(p.tab.status)
      ? (p.tab.localFallbackPending || p.disconnectBehavior === "retain" || p.disconnectBehavior === "close" ? "offline" : "local")
      : "none";
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [regexMode, setRegexMode] = useState(false);
  const resolvedTheme = resolveTerminalTheme(p.theme, p.terminalTheme, p.tab.session.terminalTheme);
  const callbacks = useRef(p);
  callbacks.current = p;
  useEffect(() => {
    const ref = p.tab.ref;
    if (terminalMode === "none" || !container.current) return;
    const local = terminalMode === "local";
    const localID = `${p.tab.id}:${++localSequence.current}`;
    let pastePending = false;
    let disposed = false;
    let lastReceivedSequence = 0;
    let lastProcessedSequence = 0;
    let lastAcknowledgedSequence = 0;
    let acknowledgementScheduled = false;
    const acknowledge = () => {
      if (acknowledgementScheduled || local || !ref) return;
      acknowledgementScheduled = true;
      queueMicrotask(() => {
        acknowledgementScheduled = false;
        if (lastProcessedSequence <= lastAcknowledgedSequence) return;
        lastAcknowledgedSequence = lastProcessedSequence;
        void api.AcknowledgeTerminalOutput(ref, lastAcknowledgedSequence).catch(() => {});
      });
    };
    const term = new Terminal({
      fontFamily: 'Cascadia Mono,Consolas,"Microsoft YaHei",monospace',
      fontSize: p.fontSize,
      theme: resolveTerminalTheme(
        callbacks.current.theme,
        callbacks.current.terminalTheme,
        callbacks.current.tab.session.terminalTheme,
      ),
      overviewRuler: { width: 14 },
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
    if (scrollbackSnapshot.current && p.preserveHistory !== false) {
      term.write(scrollbackSnapshot.current + "\r\n");
    }
    if (local && p.showDisconnectReason !== false) {
      term.write(`\r\n\x1b[90m[${t("terminal:remoteConnectionClosed")}]\x1b[0m\r\n`);
    }
    const reportDirectory = (directory: string | null) => {
      if (!disposed && directory && ref && terminalMode === "ssh") callbacks.current.onDirectoryChange?.(ref, directory);
      return Boolean(directory);
    };
    const cwdHooks = [
      term.parser.registerOscHandler(7, payload => reportDirectory(parseOsc7Directory(payload))),
      term.parser.registerOscHandler(1337, payload => reportDirectory(parseOsc1337Directory(payload))),
      // Return false to preserve normal title handling in xterm.js.
      term.parser.registerOscHandler(0, title => {
        reportDirectory(parseOscTitleDirectory(title, callbacks.current.tab.home));
        return false;
      }),
      term.parser.registerOscHandler(2, title => {
        reportDirectory(parseOscTitleDirectory(title, callbacks.current.tab.home));
        return false;
      }),
    ];
    let opened = false;
    let lastSize = "";
    const same = (r: Ref) =>
      !!ref && r.tabId === ref.tabId && r.generation === ref.generation;
    const off = listen(local ? "local:output" : "ssh:output", (payload) => {
      if (disposed || terminalMode === "offline") return;
      if (local ? (payload.tabId !== p.tab.id || payload.terminalId !== localID) : !same(payload.ref)) return;
      const bytes = Uint8Array.from(atob(payload.data), (c) => c.charCodeAt(0));
      const sequence = !local && typeof payload.sequence === "number" ? payload.sequence : 0;
      lastReceivedSequence = Math.max(lastReceivedSequence, sequence);
      // Go pauses reading at the high watermark and resumes only when
      // xterm.js has actually parsed the acknowledged bytes.
      term.write(bytes, () => {
        lastProcessedSequence = Math.max(lastProcessedSequence, sequence);
        acknowledge();
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
            if (local) await api.WriteLocalTerminal(p.tab.id, localID, btoa(binary));
            else if (ref) await api.WriteTerminal(ref, btoa(binary));
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
      if (terminalMode === "offline") return;
      inputQueue.push(data);
      scheduleInput();
    });
    const sendResize = () => {
      if (!opened || disposed) return;
      const size = `${term.cols}x${term.rows}`;
      if (size === lastSize) return;
      lastSize = size;
      if (local) void api.ResizeLocalTerminal(p.tab.id, localID, term.cols, term.rows).catch(() => {});
      else if (ref) void api.ResizeTerminal(ref, term.cols, term.rows).catch(() => {});
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
          terminalMode === "offline" ||
          (!local && (currentRef?.tabId !== ref?.tabId ||
          currentRef?.sessionId !== ref?.sessionId ||
          currentRef?.generation !== ref?.generation))
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
    let resizeScheduled = false;
    let measuredWidth = 0;
    let measuredHeight = 0;
    const resize = () => {
      if (resizeScheduled) return;
      resizeScheduled = true;
      requestAnimationFrame(() => {
        resizeScheduled = false;
        const element = container.current;
        if (disposed || !(callbacks.current.visible ?? callbacks.current.active) || !element) return;
        const { clientWidth, clientHeight } = element;
        if (!clientWidth || !clientHeight ||
            (clientWidth === measuredWidth && clientHeight === measuredHeight)) return;
        measuredWidth = clientWidth;
        measuredHeight = clientHeight;
        addon.fit();
      });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container.current);
    requestAnimationFrame(() => {
      if (disposed) return;
      addon.fit();
      measuredWidth = container.current?.clientWidth ?? 0;
      measuredHeight = container.current?.clientHeight ?? 0;
      const cols = Math.max(term.cols, 20);
      const rows = Math.max(term.rows, 5);
      if (terminalMode === "offline") return;
      (local ? api.StartLocalTerminal(p.tab.id, localID, p.localShell ?? "powershell", cols, rows)
        : api.OpenTerminal(ref!, cols, rows))
        .then(() => {
          if (disposed) return;
          opened = true;
          lastSize = `${cols}x${rows}`;
          sendResize();
          if (callbacks.current.active) term.focus();
        })
        .catch((e) => {
          // A reconnect can cancel a pending ConPTY launch or SSH open.
          // The old pane must never report that expected cancellation as a failure.
          if (disposed) return;
          if (local) {
            const reason = errorText(e);
            if (
              reason.includes("terminal connection changed") ||
              reason.includes("terminal tab no longer exists") ||
              reason.includes("SSH must disconnect before starting the local terminal")
            ) return;
            term.write(`\r\n${t("terminal:localShellStartFailed")}: ${reason}\r\n`);
            callbacks.current.onNotice(e);
          } else callbacks.current.onError(e);
        });
    });
    return () => {
      disposed = true;
      // Unmounting intentionally discards any remaining terminal render buffer.
      // Release its backend credits so the SSH reader cannot remain blocked.
      lastProcessedSequence = lastReceivedSequence;
      acknowledge();
      inputQueue.length = 0;
      observer.disconnect();
      off();
      if (local) void api.CloseLocalTerminal(p.tab.id, localID).catch(() => {});
      paneElement.removeEventListener("mousedown", onMouseDown, true);
      paneElement.removeEventListener("auxclick", onAuxClick, true);
      document.removeEventListener("mouseup", onMouseUp, true);
      paneElement.removeEventListener("contextmenu", onContextMenu, true);
      input.dispose();
      for (const hook of cwdHooks) hook.dispose();
      resizeSubscription.dispose();
      selection.dispose();
      const buffer = term.buffer.normal;
      if (buffer) {
        const lines: string[] = [];
        for (let index = Math.max(0, buffer.length - 10000); index < buffer.length; index++) {
          const line = buffer.getLine(index);
          if (line) lines.push(line.translateToString(true));
        }
        // xterm includes unused screen rows in the normal buffer. Restoring
        // those rows on every reconnect would push the next prompt far below
        // the last meaningful output.
        let start = 0;
        let end = lines.length;
        while (start < end && !lines[start].trim()) start++;
        while (end > start && !lines[end - 1].trim()) end--;
        scrollbackSnapshot.current = p.preserveHistory !== false
          ? lines.slice(start, end).join("\r\n").slice(-1048576)
          : "";
      }
      term.dispose();
      logAddons.current = [];
      webglAddon.current = null;
      webglFailed.current = false;
      searchAddon.current = null;
      terminal.current = null;
      fit.current = null;
    };
  }, [p.tab.ref?.generation, p.tab.id, terminalMode, p.localShell]);
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
    if (!(p.visible ?? p.active)) {
      // Avoid repeatedly destroying GPU contexts during quick tab and split changes.
      // Long-idle tabs still free the context to respect WebView2's GPU limits.
      const timer = window.setTimeout(() => {
        webglAddon.current?.dispose();
        webglAddon.current = null;
      }, 1500);
      return () => window.clearTimeout(timer);
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
  }, [p.visible ?? p.active, p.tab.ref?.generation, terminalMode]);
  useEffect(() => {
    if (terminal.current) {
      terminal.current.options.fontSize = p.fontSize;
      fit.current?.fit();
    }
  }, [p.fontSize]);
  useEffect(() => {
    if (terminal.current) terminal.current.options.theme = resolvedTheme;
  }, [resolvedTheme]);
  useEffect(() => {
    if (p.visible ?? p.active) {
      requestAnimationFrame(() => {
        if (callbacks.current.visible ?? callbacks.current.active) fit.current?.fit();
      });
    }
  }, [p.visible ?? p.active]);
  useEffect(() => {
    if (p.active) {
      requestAnimationFrame(() => {
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
    <div data-tab-id={p.tab.id} className={`terminal-pane ${(p.visible ?? p.active) ? "visible" : ""} ${p.active ? "active" : ""}`}
      aria-label={t("terminal:terminal", { name: p.tab.session.name })}
      style={{ "--terminal-background": resolvedTheme.background } as CSSProperties}>
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
