import type { Plugin } from "vite";

// Content-Security-Policy for the packaged app. Only applied to production
// builds: the Vite dev server needs inline scripts for React Fast Refresh.
//
// - Scripts only come from the app bundle and the Wails runtime, both served
//   from the app origin. No inline scripts and no eval.
// - Inline styles stay allowed: React style props, xterm.js and CodeMirror
//   set element styles at run time.
// - connect-src 'self' covers the Wails IPC (fetch to /wails/runtime and its
//   same-origin WebSocket). AI providers and SSH are reached from Go, never
//   from the page.
// - Go-side ExecJS (event dispatch) uses WebView2 ExecuteScript, which CSP
//   does not restrict.
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

export function contentSecurityPolicy(): Plugin {
  return {
    name: "openshell-csp",
    apply: "build",
    transformIndexHtml() {
      return [{
        tag: "meta",
        attrs: { "http-equiv": "Content-Security-Policy", content: CONTENT_SECURITY_POLICY },
        injectTo: "head-prepend",
      }];
    },
  };
}
