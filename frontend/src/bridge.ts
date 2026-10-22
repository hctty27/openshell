import { t } from "./i18n";
import * as bindings from "../wailsjs/go/main/App";
import type {
  AppState,
  SessionRequest,
  Session,
  APIRequest,
  APIProfile,
  Group,
  XshellImportPreview,
  XshellImportResult,
  Ref,
  ConnectResult,
  ChatRequest,
  ChatResponse,
  Proposal,
  CommandResult,
  AutoSnapshot,
} from "./types";
type Backend = {
  StartAutomatic(req: ChatRequest, taskID: string): Promise<AutoSnapshot>;
  ResumeAutomatic(
    taskID: string,
    approvedProposalID: string,
    extend: boolean,
  ): Promise<AutoSnapshot>;
  StopAutomatic(taskID: string): Promise<void>;
  State(): Promise<AppState>;
  PreviewXshellImport(): Promise<XshellImportPreview>;
  ImportXshell(token: string, ids: string[], conflict: "skip" | "rename"): Promise<XshellImportResult>;
  SaveSession(req: SessionRequest): Promise<Session>;
  DeleteSession(id: string): Promise<void>;
  SaveGroup(group: Group): Promise<Group>;
  DeleteGroup(id: string): Promise<void>;
  SavePreference(key: string, value: string): Promise<void>;
  SaveAPI(req: APIRequest): Promise<APIProfile>;
  DeleteAPI(id: string): Promise<void>;
  TestAPI(req: APIRequest): Promise<void>;
  ChoosePrivateKey(): Promise<string>;
  Connect(
    tabID: string,
    sessionID: string,
    secret: string,
  ): Promise<ConnectResult>;
  TrustHost(id: string): Promise<void>;
  OpenTerminal(ref: Ref, cols: number, rows: number): Promise<void>;
  WriteTerminal(ref: Ref, data: string): Promise<void>;
  ResizeTerminal(ref: Ref, cols: number, rows: number): Promise<void>;
  Disconnect(ref: Ref): Promise<void>;
  CloseTab(id: string): Promise<void>;
  PreviewContext(
    ref: Ref,
    text: string,
  ): Promise<{ text: string; truncated: boolean }>;
  ClearChat(id: string): Promise<void>;
  CancelChat(id: string): Promise<void>;
  Chat(req: ChatRequest): Promise<ChatResponse>;
  Continue(req: ChatRequest): Promise<ChatResponse>;
  ReviseProposal(
    id: string,
    command: string,
    cwd: string,
    seconds: number,
  ): Promise<Proposal>;
  ConfirmCommand(id: string): Promise<CommandResult>;
  CancelCommand(id: string): Promise<void>;
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
