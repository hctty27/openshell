import { t } from "./i18n";
import * as bindings from "../wailsjs/go/main/App";
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
    go?: { main?: { App: Backend } };
    runtime?: {
      EventsOn(name: string, callback: (payload: any) => void): () => void;
    };
  }
}
export const desktop = !!window.go?.main?.App;
export const api = new Proxy({} as Backend, {
  get:
    (_, name) =>
    (...args: unknown[]) => {
      const backend = window.go?.main?.App;
      if (!backend)
        return Promise.reject(
          new Error(t("common:useThisFeatureInTheWindowsDesktopApp")),
        );
      return (
        bindings[name as keyof typeof bindings] as (
          ...args: unknown[]
        ) => Promise<unknown>
      )(...args);
    },
});
export function listen(
  name: string,
  callback: (payload: any) => void,
): () => void {
  return window.runtime?.EventsOn(name, callback) ?? (() => {});
}
export { errorText } from "./i18n/errors";
