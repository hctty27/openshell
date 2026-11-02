import { t } from "./i18n";
import { Call, Events } from "@wailsio/runtime";
import type {
  AppState,
  SessionRequest,
  Session,
  Group,
  XshellImportPreview,
  XshellImportResult,
  Ref,
  ConnectResult,
  SFTPEntry,
  SFTPPaths,
  SFTPTask,
  SFTPDocument,
  SFTPSyncPreview,
} from "./types";
type Backend = {
  SFTPHome(ref: Ref): Promise<SFTPPaths>;
  SFTPChooseDirectory(): Promise<string>;
  SFTPList(ref: Ref, side: string, directory: string): Promise<SFTPEntry[]>;
  SFTPOperate(ref: Ref, side: string, operation: string, source: string, argument: string): Promise<void>;
  SFTPTransfer(ref: Ref, direction: string, source: string, destination: string, overwrite: boolean, resume: boolean): Promise<SFTPTask>;
  SFTPTransfers(ref: Ref): Promise<SFTPTask[]>;
  SFTPCancel(taskID: string): Promise<void>;
  SFTPReadRemoteText(ref: Ref, path: string): Promise<SFTPDocument>;
  SFTPSaveRemoteText(ref: Ref, path: string, revision: string, content: string): Promise<SFTPDocument>;
  SFTPPreviewSync(ref: Ref, direction: string, localDir: string, remoteDir: string): Promise<SFTPSyncPreview>;
  SFTPBatchChmod(ref: Ref, side: string, paths: string[], mode: string): Promise<number>;
  SFTPEnsureDirectory(ref: Ref, side: string, directory: string): Promise<void>;
  State(): Promise<AppState>;
  SetCloseGuardReady(ready: boolean): Promise<void>;
  QuitConfirmed(): Promise<void>;
  PreviewXshellImport(): Promise<XshellImportPreview>;
  PreviewSessionBackup(): Promise<XshellImportPreview>;
  ExportSessionBackup(): Promise<string>;
  ImportXshell(token: string, ids: string[], conflict: "skip" | "rename"): Promise<XshellImportResult>;
  SaveSession(req: SessionRequest): Promise<Session>;
  DuplicateSession(id: string): Promise<Session>;
  DeleteSession(id: string): Promise<void>;
  SaveGroup(group: Group): Promise<Group>;
  DeleteGroup(id: string): Promise<void>;
  SavePreference(key: string, value: string): Promise<void>;
  ChoosePrivateKey(): Promise<string>;
  Connect(
    tabID: string,
    sessionID: string,
    secret: string,
  ): Promise<ConnectResult>;
  TrustHost(id: string): Promise<void>;
  OpenTerminal(ref: Ref, cols: number, rows: number): Promise<void>;
  StartLocalTerminal(tabID: string, terminalID: string, shell: string, cols: number, rows: number): Promise<void>;
  WriteLocalTerminal(tabID: string, terminalID: string, data: string): Promise<void>;
  ResizeLocalTerminal(tabID: string, terminalID: string, cols: number, rows: number): Promise<void>;
  CloseLocalTerminal(tabID: string, terminalID: string): Promise<void>;
  WriteTerminal(ref: Ref, data: string): Promise<void>;
  AcknowledgeTerminalOutput(ref: Ref, sequence: number): Promise<void>;
  CancelZmodem(ref: Ref): Promise<void>;
  ZmodemLocalPlaces(): Promise<{ home: string; roots: string[] }>;
  SubmitZmodemSelection(ref: Ref, id: number, paths: string[]): Promise<void>;
  ResizeTerminal(ref: Ref, cols: number, rows: number): Promise<void>;
  CancelConnecting(tabID: string): Promise<void>;
  Reconnect(tabID: string, sessionID: string): Promise<ConnectResult>;
  Disconnect(ref: Ref): Promise<void>;
  CloseTab(id: string): Promise<void>;
};
declare global {
  interface Window {
    go?: { main?: { App?: Backend } };
    runtime?: { EventsOn?: (name: string, callback: (payload: any) => void) => () => void };
  }
}

export const nativeDesktop = typeof window !== "undefined" &&
  typeof (window as Window & { chrome?: { webview?: { postMessage?: unknown } } })
    .chrome?.webview?.postMessage === "function";

const fixtureBackend = import.meta.env.DEV ? window.go?.main?.App : undefined;
export const desktop = nativeDesktop || Boolean(fixtureBackend);

export const api = new Proxy({} as Backend, {
  get: (_, name) => (...args: unknown[]) => {
    if (fixtureBackend) {
      const method = fixtureBackend[name as keyof Backend];
      if (typeof method !== "function") {
        return Promise.reject(new Error(`Unavailable browser fixture method: ${String(name)}`));
      }
      return (method as (...values: unknown[]) => Promise<unknown>)(...args);
    }
    return nativeDesktop
      ? Call.ByName(`main.App.${String(name)}`, ...args) as Promise<unknown>
      : Promise.reject(new Error(t("common:useThisFeatureInTheWindowsDesktopApp")));
  },
});

export function listen(name: string, callback: (payload: any) => void): () => void {
  if (fixtureBackend && window.runtime?.EventsOn) return window.runtime.EventsOn(name, callback);
  if (!nativeDesktop) return () => {};
  return Events.On(name, event => callback(event.data));
}
export { errorText } from "./i18n/errors";
