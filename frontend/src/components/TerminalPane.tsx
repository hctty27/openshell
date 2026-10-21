import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api, listen, errorText } from "../bridge";
import type { Tab, Ref } from "../types";
interface Props {
  tab: Tab;
  active: boolean;
  fontSize: number;
  onError(text: string): void;
  onSelection(text: string): void;
}
export default function TerminalPane(p: Props) {
  const container = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const callbacks = useRef(p);
  callbacks.current = p;
  useEffect(() => {
    const ref = p.tab.ref;
    if (!ref || p.tab.status !== "connected" || !container.current) return;
    let disposed = false,
      pending = 0,
      overloaded = false;
    const term = new Terminal({
      fontFamily: 'Cascadia Mono,Consolas,"Microsoft YaHei",monospace',
      fontSize: p.fontSize,
      theme: {
        background: "#0b1017",
        foreground: "#d0d9e5",
        cursor: "#67d8b6",
        selectionBackground: "#2d5a6b99",
        black: "#15202b",
        red: "#f0828a",
        green: "#79d9af",
        yellow: "#e6ca89",
        blue: "#79b5ef",
        magenta: "#bb9ae5",
        cyan: "#74d4d5",
        white: "#dce5ed",
      },
      cursorBlink: true,
      scrollback: 10000,
      allowProposedApi: false,
    });
    const addon = new FitAddon();
    term.loadAddon(addon);
    terminal.current = term;
    fit.current = addon;
    term.open(container.current);
    const same = (r: Ref) =>
      r.tabId === ref.tabId && r.generation === ref.generation;
    const off = listen("ssh:output", (payload) => {
      if (disposed || !same(payload.ref) || overloaded) return;
      const bytes = Uint8Array.from(atob(payload.data), (c) => c.charCodeAt(0));
      pending += bytes.length;
      if (pending > 2 * 1024 * 1024) {
        overloaded = true;
        callbacks.current.onError(
          "终端输出超过处理上限，已断开连接；请限制日志输出量后重连",
        );
        api.Disconnect(ref);
        return;
      }
      term.write(bytes, () => {
        pending -= bytes.length;
      });
    });
    const input = term.onData((data) => {
      const bytes = new TextEncoder().encode(data);
      let encoded = "";
      for (const b of bytes) encoded += String.fromCharCode(b);
      api
        .WriteTerminal(ref, btoa(encoded))
        .catch((e) => callbacks.current.onError(errorText(e)));
    });
    const resizeSubscription = term.onResize(({ cols, rows }) =>
      api.ResizeTerminal(ref, cols, rows).catch(() => {}),
    );
    const selection = term.onSelectionChange(() =>
      callbacks.current.onSelection(term.getSelection()),
    );
    let resizeTimer: ReturnType<typeof setTimeout>;
    const resize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (disposed || !container.current?.offsetWidth) return;
        addon.fit();
        api.ResizeTerminal(ref, term.cols, term.rows).catch(() => {});
      }, 80);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container.current);
    requestAnimationFrame(() => {
      if (disposed) return;
      addon.fit();
      api
        .OpenTerminal(ref, Math.max(term.cols, 20), Math.max(term.rows, 5))
        .then(() => term.focus())
        .catch((e) => callbacks.current.onError(errorText(e)));
    });
    return () => {
      disposed = true;
      clearTimeout(resizeTimer);
      observer.disconnect();
      off();
      input.dispose();
      resizeSubscription.dispose();
      selection.dispose();
      term.dispose();
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
    if (p.active) {
      requestAnimationFrame(() => {
        fit.current?.fit();
        terminal.current?.focus();
      });
    }
  }, [p.active]);
  return (
    <div
      className={`terminal-pane ${p.active ? "active" : ""}`}
      ref={container}
      aria-label={`终端 ${p.tab.session.name}`}
    />
  );
}
