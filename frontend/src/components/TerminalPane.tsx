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
  fontSize: number;
  theme: Theme;
  autoCopySelection: boolean;
  rightClickPaste: boolean;
  confirmMultilinePaste: boolean;
  onNotice(text: unknown): void;
  commandFocusVersion?: number;
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
  const searchInput = useRef<HTMLInputElement>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchText, setSearchText] = useState("");
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
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      // Keep the default renderer when WebGL is unavailable.
    }
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
      selectingWithMouse =
        event.button === 0 &&
        callbacks.current.active &&
        (term.modes.mouseTrackingMode === "none" || event.shiftKey);
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
          const selected = term.getSelection();
          if (!selected) return true;
          event.preventDefault();
          void ClipboardSetText(selected).catch((error) => callbacks.current.onNotice(error));
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
      if (term.modes.mouseTrackingMode !== "none") return;
      event.preventDefault();
      event.stopPropagation();
      void pasteFromClipboard();
    };
    paneElement.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("mouseup", onMouseUp, true);
    paneElement.addEventListener("contextmenu", onContextMenu, true);
    let resizeTimer: ReturnType<typeof setTimeout>;
    const resize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (disposed || !container.current?.offsetWidth) return;
        addon.fit();
      }, 80);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container.current);
    requestAnimationFrame(() => {
      if (disposed) return;
      addon.fit();
      api
        .OpenTerminal(ref, Math.max(term.cols, 20), Math.max(term.rows, 5))
        .then(() => {
          opened = true;
          lastSize = `${term.cols}x${term.rows}`;
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
      document.removeEventListener("mouseup", onMouseUp, true);
      paneElement.removeEventListener("contextmenu", onContextMenu, true);
      input.dispose();
      resizeSubscription.dispose();
      selection.dispose();
      term.dispose();
      searchAddon.current = null;
      terminal.current = null;
      fit.current = null;
    };
  }, [p.tab.ref?.generation, p.tab.id]);
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
    if (p.active) {
      requestAnimationFrame(() => {
        fit.current?.fit();
        if (searchOpen) searchInput.current?.focus();
        else terminal.current?.focus();
      });
    }
  }, [p.active, searchOpen]);
  useEffect(() => {
    if (p.active && p.commandFocusVersion) terminal.current?.focus();
  }, [p.commandFocusVersion]);
  const closeSearch = () => {
    searchAddon.current?.clearDecorations();
    setSearchOpen(false);
    terminal.current?.focus();
  };
  const find = (forward: boolean) => {
    if (!searchText) return;
    if (forward) searchAddon.current?.findNext(searchText);
    else searchAddon.current?.findPrevious(searchText);
  };
  return (
    <div className={`terminal-pane ${p.active ? "active" : ""}`}
      aria-label={t("terminal:terminal", { name: p.tab.session.name })}>
      <div className="terminal-surface" ref={container} />
      {p.active && searchOpen && (
        <div className="terminal-find">
          <input
            ref={searchInput}
            value={searchText}
            aria-label="Search terminal output"
            placeholder="Find in terminal"
            onChange={(event) => {
              const next = event.target.value;
              setSearchText(next);
              if (next) searchAddon.current?.findNext(next, { incremental: true });
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
          <button type="button" title="Previous match" aria-label="Previous match"
            onClick={() => find(false)}>↑</button>
          <button type="button" title="Next match" aria-label="Next match"
            onClick={() => find(true)}>↓</button>
          <button type="button" title="Close search" aria-label="Close search"
            onClick={closeSearch}>×</button>
        </div>
      )}
    </div>
  );
}
