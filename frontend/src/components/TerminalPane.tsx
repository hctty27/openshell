import { useTranslation } from "react-i18next";
import { Sparkles, X } from "lucide-react";
import { message } from "../i18n/message";
import { t } from "../i18n";
import { memo, useEffect, useRef, useState, type CSSProperties } from "react";
import { Terminal } from "@xterm/xterm";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { api, errorText, listen } from "../bridge";
import { terminalOutputDispatcher } from "../features/terminal/terminalOutputDispatcher";
import { TerminalOutputAcknowledger } from "../features/terminal/terminalOutputAcknowledger";
import { recordTerminalWrite } from "../features/diagnostics/collector";
import { Browser, Clipboard, Events } from "@wailsio/runtime";
import type { Tab, Ref, Theme, TerminalTheme, DisconnectBehavior, LocalShell } from "../types";
import { resolveTerminalTheme } from "../terminalThemes";
import { buildRemoteCdCommand, decideCloneDirectoryAction, parseOsc7Directory, parseOsc1337Directory, parseOscTitleDirectory } from "../terminalCwd";
import { useDialogs } from "./DialogProvider";
import { attachImeFocusRecovery } from "../features/terminal/imeFocusRecovery";
import { getTerminalEdgeBackground } from "../features/terminal/edgeBackground";
import { calculateGridCenteringCorrection, calculateTerminalGeometry } from "../features/terminal/terminalGeometry";
const TERMINAL_SCROLLBAR_WIDTH = 8;

interface Props {
  tab: Tab;
  disconnectBehavior?: DisconnectBehavior;
  localShell?: LocalShell;
  preserveHistory?: boolean;
  showDisconnectReason?: boolean;
  active: boolean;
  visible?: boolean;
  paneBounds?: { left: number; top: number; width: number; height: number };
  onUndock?: () => void;
  onActivate?: () => void;
  fontSize: number;
  theme: Theme;
  terminalTheme?: TerminalTheme;
  autoCopySelection: boolean;
  rightClickPaste: boolean;
  logHighlights?: boolean;
  confirmMultilinePaste: boolean;
  onNotice(text: unknown): void;
  onRemoteOutput?(ref: Ref, bytes: Uint8Array): void;
  onUserInput?(ref: Ref): void;
  commandFocusVersion?: number;
  searchOpen: boolean;
  onSearchOpenChange(open: boolean): void;
  transferFocusRequest?: { ref: Ref };
  onError(text: unknown): void;
  onSelection?(text: string): void;
  onDirectoryChange?(ref: Ref, directory: string): void;
  onAlternateScreenChange?(ref: Ref, alternate: boolean): void;
  aiControlled?: boolean;
  onTakeControl?(): void;
}
export default function TerminalPane(p: Props) {
  const callbackProps = useRef(p);
  callbackProps.current = p;
  return <MemoizedTerminalPane {...p} callbackProps={callbackProps} />;
}

function TerminalPaneImpl(p: Props & { callbackProps: { current: Props } }) {
  useTranslation();
  const dialogs = useDialogs();
  const dialogsRef = useRef(dialogs);
  dialogsRef.current = dialogs;
  const container = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const refit = useRef<(() => void) | null>(null);
  const refreshEdgeBackground = useRef<() => void>(() => {});
  const imePositionRecovery = useRef<ReturnType<typeof attachImeFocusRecovery> | null>(null);
  const searchAddon = useRef<SearchAddon | null>(null);
  const logAddons = useRef<SearchAddon[]>([]);
  const webglAddon = useRef<WebglAddon | null>(null);
  const webglFailed = useRef(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const scrollbackSnapshot = useRef("");
  const localSequence = useRef(0);
  const cloneCwdSent = useRef(false);
  const nativeTransferActive = useRef(false);
  const nativeTransferIDs = useRef(new Set<string>());
  const terminalMode = p.tab.status === "connected" && p.tab.ref ? "ssh"
    : p.tab.ref && p.tab.everConnected && ["disconnected", "error"].includes(p.tab.status)
      ? (p.tab.localFallbackPending || p.disconnectBehavior === "retain" || p.disconnectBehavior === "close" ? "offline" : "local")
      : "none";
  const searchOpen = p.searchOpen;
  const [searchText, setSearchText] = useState("");
  const [regexMode, setRegexMode] = useState(false);
  const resolvedTheme = resolveTerminalTheme(p.theme, p.terminalTheme, p.tab.session.terminalTheme);
  const callbacks = p.callbackProps;
  useEffect(() => {
    const ref = p.tab.ref;
    if (terminalMode === "none" || !container.current) return;
    const local = terminalMode === "local";
    const localID = `${p.tab.id}:${++localSequence.current}`;
    let pastePending = false;
    let disposed = false;
    let lastReceivedSequence = 0;
    const acknowledger = new TerminalOutputAcknowledger(sequence => {
      if (local) {
        void api.AcknowledgeLocalTerminalOutput(p.tab.id, localID, sequence).catch(() => {});
      } else if (ref) {
        void api.AcknowledgeTerminalOutput(ref, sequence).catch(() => {});
      }
    });
    const term = new Terminal({
      fontFamily: 'Cascadia Mono,Consolas,"Microsoft YaHei",monospace',
      fontSize: p.fontSize,
      theme: resolveTerminalTheme(
        callbacks.current.theme,
        callbacks.current.terminalTheme,
        callbacks.current.tab.session.terminalTheme,
      ),
      scrollbar: { width: TERMINAL_SCROLLBAR_WIDTH },
      minimumContrastRatio: 4.5,
      cursorBlink: true,
      // Prefer text selection in mouse-aware TUIs; Alt forwards mouse actions.
      mouseEventsRequireAlt: true,
      scrollback: 10000,
      allowProposedApi: false,
    });
    const search = new SearchAddon();
    term.loadAddon(search);
    searchAddon.current = search;
    term.loadAddon(new WebLinksAddon((_event, url) => {
      if (/^https?:\/\//i.test(url)) {
        void Browser.OpenURL(url).catch((error) => callbacks.current.onNotice(error));
      }
    }));
    terminal.current = term;
    term.options.disableStdin = nativeTransferActive.current;
    term.open(container.current);
    let alignmentFrame = 0;
    const getScrollbarTrack = () =>
      term.element?.querySelector<HTMLElement>(".xterm-scrollbar.xterm-vertical") ?? null;
    const correctGridPosition = () => {
      alignmentFrame = 0;
      const surface = container.current;
      const xterm = term.element;
      const screen = term.screenElement;
      const track = getScrollbarTrack();
      if (disposed || !surface || !xterm || !screen || !track) return;
      const outer = surface.getBoundingClientRect();
      const grid = screen.getBoundingClientRect();
      const scrollbar = track.getBoundingClientRect();
      if (grid.width <= 0 || grid.height <= 0 || scrollbar.width <= 0) return;
      const correction = calculateGridCenteringCorrection({
        surfaceLeft: outer.left,
        surfaceTop: outer.top,
        surfaceBottom: outer.bottom,
        gridLeft: grid.left,
        gridRight: grid.right,
        gridTop: grid.top,
        gridBottom: grid.bottom,
        scrollbarLeft: scrollbar.left,
      });
      if (!correction) return;
      // Adjust the root's existing padding; never transform the screen or scrollbar.
      if (Math.abs(correction.x) > 0.25) {
        const left = Number.parseFloat(xterm.style.paddingLeft) || 0;
        xterm.style.paddingLeft = `${Math.max(0, left + correction.x)}px`;
      }
      if (Math.abs(correction.y) > 0.25) {
        const top = Number.parseFloat(xterm.style.paddingTop) || 0;
        xterm.style.paddingTop = `${Math.max(0, top + correction.y)}px`;
      }
    };
    const applyGeometry = () => {
      const surface = container.current;
      const xterm = term.element;
      const cell = term.dimensions?.css.cell;
      if (disposed || !surface || !xterm || !cell) return;
      const outer = surface.getBoundingClientRect();
      const track = getScrollbarTrack()?.getBoundingClientRect();
      const reservedWidth = track && track.width > 0 && track.left >= outer.left && track.left < outer.right
        ? outer.right - track.left
        : TERMINAL_SCROLLBAR_WIDTH;
      const layout = calculateTerminalGeometry({
        width: surface.clientWidth,
        height: surface.clientHeight,
        cellWidth: cell.width,
        cellHeight: cell.height,
        scrollbarWidth: reservedWidth,
      });
      if (!layout) return;
      xterm.style.paddingLeft = `${layout.left}px`;
      xterm.style.paddingTop = `${layout.top}px`;
      if (term.cols !== layout.cols || term.rows !== layout.rows) {
        term.resize(layout.cols, layout.rows);
      }
      if (alignmentFrame) cancelAnimationFrame(alignmentFrame);
      alignmentFrame = requestAnimationFrame(correctGridPosition);
    };
    refit.current = applyGeometry;
    let edgeBackgroundFrame = 0;
    let edgeBackgroundPending = false;
    let appliedEdgeBackground: string | null = null;
    const syncEdgeBackground = () => {
      // Background terminals continue parsing and ACKing output, but need no
      // extra CSS updates until they become visible again.
      if (disposed || edgeBackgroundPending || !(callbacks.current.visible ?? callbacks.current.active)) return;
      edgeBackgroundPending = true;
      const frame = requestAnimationFrame(() => {
        edgeBackgroundPending = false;
        edgeBackgroundFrame = 0;
        const surface = container.current;
        if (disposed || !surface || !(callbacks.current.visible ?? callbacks.current.active)) return;
        const theme = resolveTerminalTheme(
          callbacks.current.theme,
          callbacks.current.terminalTheme,
          callbacks.current.tab.session.terminalTheme,
        );
        const color = getTerminalEdgeBackground(term, theme);
        if (color === appliedEdgeBackground) return;
        if (color) surface.style.setProperty("--terminal-edge-background", color);
        else surface.style.removeProperty("--terminal-edge-background");
        appliedEdgeBackground = color;
      });
      // Keep the pending flag correct even when tests invoke rAF synchronously.
      if (edgeBackgroundPending) edgeBackgroundFrame = frame;
    };
    refreshEdgeBackground.current = syncEdgeBackground;
    const bufferListener = term.buffer.onBufferChange(buffer => {
      syncEdgeBackground();
      if (!disposed && ref && !local) {
        callbacks.current.onAlternateScreenChange?.(ref, buffer.type === "alternate");
      }
    });
    if (ref && !local) callbacks.current.onAlternateScreenChange?.(ref, term.buffer.active.type === "alternate");
    const imeRecovery = attachImeFocusRecovery(
      navigator.userAgent.includes("Windows") ? term.textarea : undefined,
      () => callbacks.current.active,
      () => { if (!disposed) term.focus(); },
    );
    imePositionRecovery.current = imeRecovery;
    const offImeWindowEvents = navigator.userAgent.includes("Windows")
      ? (["common:WindowDidMove", "common:WindowDPIChanged", "common:WindowFocus"] as const).map(eventName =>
          Events.On(eventName, () => {
            if (disposed || !callbacks.current.active) return;
            if (eventName === "common:WindowFocus") {
              imeRecovery.onWindowActivated();
            } else {
              applyGeometry();
              imeRecovery.schedule();
            }
          }),
        )
      : [];
    if (scrollbackSnapshot.current && p.preserveHistory !== false) {
      term.write(scrollbackSnapshot.current + "\r\n");
    }
    if (local && p.showDisconnectReason !== false) {
      term.write(`\r\n\x1b[90m[${t("terminal:remoteConnectionClosed")}]\x1b[0m\r\n`);
    }
    let initialReportedDirectory: string | undefined;
    const reportDirectory = (directory: string | null) => {
      if (!disposed && directory && ref && terminalMode === "ssh") {
        initialReportedDirectory = directory;
        callbacks.current.onDirectoryChange?.(ref, directory);
      }
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
    const restoreClonedDirectory = () => {
      if (!opened || disposed || local || !ref || cloneCwdSent.current || term.buffer.active.type !== "normal") return;
      if (!callbacks.current.tab.ref || !same(callbacks.current.tab.ref)) return;

      const buffer = term.buffer.normal;
      const prompt = buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true) ?? "";
      const directory = callbacks.current.tab.cloneCwd ?? "";
      const action = decideCloneDirectoryAction(
        directory, callbacks.current.tab.home, prompt, initialReportedDirectory,
      );
      if (action === "wait") return;
      cloneCwdSent.current = true;
      if (action !== "send") return;

      const command = buildRemoteCdCommand(directory);
      if (!command) return;
      const bytes = new TextEncoder().encode(command);
      const binary = Array.from(bytes, byte => String.fromCharCode(byte)).join("");
      void api.WriteTerminal(ref, btoa(binary)).catch(error => {
        if (!disposed) callbacks.current.onNotice(error);
      });
    };
    const onOutput = (payload: { data: string; sequence?: number }) => {
      if (disposed || terminalMode === "offline") return;
      const bytes = Uint8Array.from(atob(payload.data), (c) => c.charCodeAt(0));
      if (!local && ref) callbacks.current.onRemoteOutput?.(ref, bytes);
      const sequence = typeof payload.sequence === "number" ? payload.sequence : 0;
      lastReceivedSequence = Math.max(lastReceivedSequence, sequence);
      // Go pauses reading at the high watermark and resumes only when
      // xterm.js has actually parsed the acknowledged bytes.
      const writeStarted = performance.now();
      term.write(bytes, () => {
        recordTerminalWrite(performance.now() - writeStarted);
        acknowledger.processedSequence(sequence);
        syncEdgeBackground();
        restoreClonedDirectory();
      });
    };
    const off = local
      ? terminalOutputDispatcher.onLocal(p.tab.id, localID, onOutput)
      : terminalOutputDispatcher.onSSH(ref!, onOutput);
    const encoder = new TextEncoder();
    const inputQueue: string[] = [];
    const matchesConnection = (candidate: Ref) =>
      !!ref && candidate.tabId === ref.tabId &&
      candidate.sessionId === ref.sessionId &&
      candidate.generation === ref.generation;
    const offNativeBatch = listen("ssh:native-zmodem-batch", (event: {
      ref?: Ref; id?: string; active: boolean; terminalSafe?: boolean; error?: string;
    }) => {
      if (!event?.ref || !matchesConnection(event.ref)) return;
      const transferID = event.id ?? "legacy";
      if (event.active) {
        nativeTransferIDs.current.add(transferID);
        nativeTransferActive.current = true;
        inputQueue.length = 0;
        term.options.disableStdin = true;
        return;
      }
      const terminalSafe = event.terminalSafe === true ||
        (event.terminalSafe == null && !event.error);
      if (terminalSafe) nativeTransferIDs.current.delete(transferID);
      else nativeTransferIDs.current.add(transferID);
      nativeTransferActive.current = nativeTransferIDs.current.size > 0;
      term.options.disableStdin = nativeTransferActive.current;
    });
    const offDisconnected = listen("ssh:disconnected", (disconnectedRef: Ref) => {
      if (!matchesConnection(disconnectedRef)) return;
      nativeTransferActive.current = false;
      nativeTransferIDs.current.clear();
      term.options.disableStdin = false;
    });
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
        const reason = errorText(error);
        if (!disposed && !reason.includes("native terminal input busy")) {
          callbacks.current.onError(error);
        }
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
      if (terminalMode === "offline" || nativeTransferActive.current ||
        (terminalMode === "ssh" && callbacks.current.aiControlled)) return;
      if (terminalMode === "ssh" && ref && data.length > 0) callbacks.current.onUserInput?.(ref);
      // Never inject an automatic cd after the user has started interacting.
      if (terminalMode === "ssh" && callbacks.current.tab.cloneCwd) cloneCwdSent.current = true;
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
    const resizeSubscription = term.onResize(() => {
      syncEdgeBackground();
      sendResize();
    });
    const selection = term.onSelectionChange(() =>
      callbacks.current.onSelection?.(term.getSelection()),
    );
    let selectingWithMouse = false;
    const copyToClipboard = (text: string) => {
      if (!text) return;
      void Clipboard.SetText(text).catch((error) => {
        if (!disposed) callbacks.current.onNotice(error);
      });
    };
    const paneElement = container.current.parentElement ?? container.current;
    const onMouseDown = (event: MouseEvent) => {
      if ((event.target as HTMLElement).closest(".terminal-find, .terminal-transfer-indicator, .terminal-pane-undock")) return;
      if (callbacks.current.visible ?? callbacks.current.active) callbacks.current.onActivate?.();
      // Clipboard gestures take priority over TUI mouse reporting when enabled.
      // Capture the button press before xterm.js sends it to the remote app.
      if (callbacks.current.active && !event.altKey && event.button === 2 && callbacks.current.rightClickPaste) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      selectingWithMouse =
        event.button === 0 &&
        callbacks.current.active &&
        (term.modes.mouseTrackingMode === "none" || !event.altKey);
    };
    const onMouseUp = (event: MouseEvent) => {
      // xterm.js can listen for mouseup on document while mouse tracking is on.
      // Suppress the release corresponding to a clipboard gesture as well.
      if (callbacks.current.active && !event.altKey && paneElement.contains(event.target as Node) &&
        event.button === 2 && callbacks.current.rightClickPaste) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
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
        copyToClipboard(text);
      }, 0);
    };
    const pasteFromClipboard = async () => {
      if (pastePending || disposed || !callbacks.current.active || callbacks.current.aiControlled ||
        nativeTransferActive.current) return;
      pastePending = true;
      try {
        const text = await Clipboard.Text();
        if (disposed || !callbacks.current.active || nativeTransferActive.current || !text) return;
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
          // The dialog owns focus until React has actually removed it.
          // Focusing xterm in the same microtask would leave the cursor unfocused.
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          if (!accepted) {
            if (!disposed && callbacks.current.active) term.focus();
            return;
          }
        }
        const currentRef = callbacks.current.tab.ref;
        if (
          disposed ||
          !callbacks.current.active ||
          terminalMode === "offline" ||
          nativeTransferActive.current ||
          (!local && (currentRef?.tabId !== ref?.tabId ||
          currentRef?.sessionId !== ref?.sessionId ||
          currentRef?.generation !== ref?.generation))
        ) return;
        term.focus();
        term.paste(text);
        // Keep typing in the same terminal after the paste and the TUI redraw.
        requestAnimationFrame(() => {
          if (!disposed && callbacks.current.active && terminal.current === term) term.focus();
        });
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
          callbacks.current.onSearchOpenChange(true);
          return false;
        case "c": {
          event.preventDefault();
          const selected = term.getSelection();
          copyToClipboard(selected);
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
      if (!callbacks.current.active || !callbacks.current.rightClickPaste || event.altKey) return;
      if ((event.target as HTMLElement).closest(".terminal-find, .terminal-transfer-indicator")) return;
      event.preventDefault();
      event.stopPropagation();
      void pasteFromClipboard();
    };
    paneElement.addEventListener("mousedown", onMouseDown, true);
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
        applyGeometry();
        syncEdgeBackground();
        if (callbacks.current.active) imeRecovery.schedule();
      });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container.current);
    const onWindowResize = () => {
      if (callbacks.current.visible ?? callbacks.current.active) applyGeometry();
      if (callbacks.current.active) imeRecovery.schedule();
    };
    window.addEventListener("resize", onWindowResize);
    requestAnimationFrame(() => {
      if (disposed) return;
      applyGeometry();
      syncEdgeBackground();
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
          restoreClonedDirectory();
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
      if (alignmentFrame) cancelAnimationFrame(alignmentFrame);
      if (edgeBackgroundFrame) cancelAnimationFrame(edgeBackgroundFrame);
      if (refreshEdgeBackground.current === syncEdgeBackground) refreshEdgeBackground.current = () => {};
      container.current?.style.removeProperty("--terminal-edge-background");
      // Unmounting discards outstanding xterm output. Release the Go
      // backpressure window immediately so the SSH reader cannot stay blocked.
      acknowledger.release(lastReceivedSequence);
      inputQueue.length = 0;
      observer.disconnect();
      window.removeEventListener("resize", onWindowResize);
      imeRecovery.dispose();
      offImeWindowEvents.forEach(off => off());
      if (imePositionRecovery.current === imeRecovery) imePositionRecovery.current = null;
      off();
      offNativeBatch();
      offDisconnected();
      if (local) void api.CloseLocalTerminal(p.tab.id, localID).catch(() => {});
      paneElement.removeEventListener("mousedown", onMouseDown, true);
      document.removeEventListener("mouseup", onMouseUp, true);
      paneElement.removeEventListener("contextmenu", onContextMenu, true);
      input.dispose();
      bufferListener.dispose();
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
      if (refit.current === applyGeometry) refit.current = null;
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
      refit.current?.();
      if (p.active) imePositionRecovery.current?.schedule();
    }
  }, [p.fontSize]);
  useEffect(() => {
    const term = terminal.current;
    if (!term) return;
    term.options.theme = resolvedTheme;
    refreshEdgeBackground.current();
  }, [resolvedTheme]);
  useEffect(() => {
    if (p.visible ?? p.active) {
      requestAnimationFrame(() => {
        if (callbacks.current.visible ?? callbacks.current.active) {
          refit.current?.();
          refreshEdgeBackground.current();
        }
      });
    }
  }, [p.visible ?? p.active]);
  useEffect(() => {
    if (p.active && p.paneBounds) imePositionRecovery.current?.schedule();
  }, [p.active, p.paneBounds?.left, p.paneBounds?.top, p.paneBounds?.width, p.paneBounds?.height]);
  useEffect(() => {
    if (p.active) {
      requestAnimationFrame(() => {
        if (searchOpen) searchInput.current?.focus();
        else {
          terminal.current?.focus();
          imePositionRecovery.current?.resume();
        }
      });
    }
  }, [p.active, searchOpen]);
  useEffect(() => {
    if (p.active && p.commandFocusVersion && !searchOpen) terminal.current?.focus();
  }, [p.commandFocusVersion]);
  useEffect(() => {
    const requested = p.transferFocusRequest?.ref;
    const current = p.tab.ref;
    if (!requested || !current || !p.active || p.tab.status !== "connected" || searchOpen ||
        requested.tabId !== current.tabId ||
        requested.sessionId !== current.sessionId ||
        requested.generation !== current.generation) return;

    const frame = requestAnimationFrame(() => {
      if (!callbacks.current.active || !document.hasFocus()) return;
      if (document.querySelector("dialog[open], [aria-modal='true']")) return;
      const focused = document.activeElement;
      if (focused && focused !== document.body && focused !== document.documentElement &&
          !container.current?.contains(focused)) return;
      terminal.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [p.transferFocusRequest, p.active, p.tab.ref, p.tab.status, searchOpen]);
  useEffect(() => {
    if (!searchOpen) searchAddon.current?.clearDecorations();
  }, [searchOpen]);
  const closeSearch = () => {
    callbacks.current.onSearchOpenChange(false);
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
    callbacks.current.onSearchOpenChange(true);
    searchAddon.current?.findNext(pattern, searchOptions(true));
  };
  return (
    <div data-tab-id={p.tab.id} className={`terminal-pane ${(p.visible ?? p.active) ? "visible" : ""} ${p.active ? "active" : ""}`}
      aria-label={t("terminal:terminal", { name: p.tab.session.name })}
      style={{ "--terminal-background": resolvedTheme.background,
        ...(p.paneBounds ? { left: p.paneBounds.left, top: p.paneBounds.top,
          width: p.paneBounds.width, height: p.paneBounds.height } : {}),
      } as CSSProperties}>
      <div className="terminal-surface" ref={container} />
      {p.aiControlled && (
        <div className="terminal-ai-control" role="status">
          <Sparkles size={14} aria-hidden="true" />
          <span>{t("ai:terminalInUse", { name: p.tab.session.name })}</span>
          <button type="button" onClick={() => callbacks.current.onTakeControl?.()}
            title={t("ai:stopAiAndTakeControl")}>{t("ai:takeControl")}</button>
        </div>
      )}
      {p.paneBounds && p.onUndock && (
        <button type="button" className="terminal-pane-undock"
          title={t("terminal:undockPane")} aria-label={t("terminal:undockPane")}
          onMouseDown={event => event.stopPropagation()}
          onClick={() => callbacks.current.onUndock?.()}><X size={13}/></button>
      )}
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

const MemoizedTerminalPane = memo(TerminalPaneImpl, (a, b) =>
  a.tab === b.tab &&
  a.disconnectBehavior === b.disconnectBehavior &&
  a.localShell === b.localShell &&
  a.preserveHistory === b.preserveHistory &&
  a.showDisconnectReason === b.showDisconnectReason &&
  a.active === b.active &&
  a.visible === b.visible &&
  a.fontSize === b.fontSize &&
  a.theme === b.theme &&
  a.terminalTheme === b.terminalTheme &&
  a.autoCopySelection === b.autoCopySelection &&
  a.rightClickPaste === b.rightClickPaste &&
  a.logHighlights === b.logHighlights &&
  a.confirmMultilinePaste === b.confirmMultilinePaste &&
  a.aiControlled === b.aiControlled &&
  a.commandFocusVersion === b.commandFocusVersion &&
  a.searchOpen === b.searchOpen &&
  a.transferFocusRequest === b.transferFocusRequest &&
  Boolean(a.onUndock) === Boolean(b.onUndock) &&
  a.paneBounds?.left === b.paneBounds?.left &&
  a.paneBounds?.top === b.paneBounds?.top &&
  a.paneBounds?.width === b.paneBounds?.width &&
  a.paneBounds?.height === b.paneBounds?.height
);
