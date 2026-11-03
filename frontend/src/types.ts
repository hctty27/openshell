export interface Session {
  id: string;
  groupId: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: string;
  privateKeyPath: string;
  useSSHConfig?: boolean;
  proxyJump?: string;
  localForwards?: LocalForward[];
  credentialRef: string;
  terminalTheme?: TerminalTheme;
  createdAt?: string;
  updatedAt?: string;
}
export interface LocalForward {
  bindHost: string;
  bindPort: number;
  targetHost: string;
  targetPort: number;
}
export interface Group {
  id: string;
  name: string;
  parentId?: string;
}
export interface XshellImportPreview {
  source?: "xshell" | "openshell";
  token: string;
  entries: { id: string; folder: string; session: Session; warning?: string }[];
  skipped: string[];
}
export interface XshellImportResult {
  imported: number;
  skipped: number;
}
export interface Ref {
  tabId: string;
  sessionId: string;
  generation: number;
}
export interface Tab {
  id: string;
  session: Session;
  ref: Ref | null;
  status: "connecting" | "connected" | "reconnecting" | "disconnected" | "error";
  manualDisconnected?: boolean;
  localFallbackPending?: boolean;
  everConnected?: boolean;
  retryCount?: number;
  home: string;
  cwd: string;
  cwdReported?: boolean;
  cloneCwd?: string;
  error: unknown;
}
export type Theme = "dark" | "light";
export type TerminalTheme = "follow" | "classic" | "dark" | "light";
export type DisconnectBehavior = "local" | "retain" | "close";
export type LocalShell = "powershell" | "pwsh" | "cmd" | "wsl";
export type QuickCommandLayout = "single" | "multi";
export interface QuickCommand {
  id: string;
  name: string;
  command: string;
  category: string;
  scope: "global" | "group" | "session";
  scopeId: string;
  mode?: "run" | "insert"; // Legacy persisted action.
  confirm: boolean;
}
export interface AIModel {
  id: string;
  name: string;
}
export interface AIProvider {
  id: string;
  name: string;
  baseUrl: string;
  hasKey: boolean;
  models: AIModel[];
}
export interface AIToolCall {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}
export interface AIMessage {
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  tool_calls?: AIToolCall[];
  tool_call_id?: string;
}
export interface AIConversation {
  id: string;
  title: string;
  providerId: string;
  modelId: string;
  mode: "review" | "auto";
  targetNames: string[];
  targetSessionIds?: string[];
  messages: AIMessage[];
  updatedAt: string;
}
export interface AIStartResponse {
  taskId: string;
  conversationId: string;
}
export interface AppState {
  aiSidebarMode?: "pinned" | "auto-hide";
  aiSidebarWidth?: number;
  aiVisible?: boolean;
  language?: import("./i18n/languages").Language;
  quickCommands?: QuickCommand[];
  quickCommandLayout?: QuickCommandLayout;
  autoCopySelection?: boolean;
  rightClickPaste?: boolean;
  confirmMultilinePaste?: boolean;
  logHighlights?: boolean;
  splitRatio?: number;
  sessionSidebarMode?: "pinned" | "auto-hide";
  sessionSidebarWidth?: number;
  sessionDetailsExpanded?: boolean;
  keepAliveSeconds?: number;
  autoReconnect?: boolean;
  maxReconnectAttempts?: number;
  showDisconnectReason?: boolean;
  disconnectBehavior?: DisconnectBehavior;
  localShell?: LocalShell;
  preserveTerminalHistory?: boolean;
  confirmActiveDisconnect?: boolean;
  sessions: Session[];
  groups: Group[];
  fontSize: string;
  theme?: Theme;
  terminalTheme?: TerminalTheme;
  version: string;
}
export interface HostChallenge {
  id: string;
  address: string;
  fingerprint: string;
  changed: boolean;
}
export interface ConnectResult {
  ref: Ref;
  home: string;
  challenge?: HostChallenge;
}
export interface SessionRequest {
  session: Session;
  secret: string;
  saveSecret: boolean;
}
export interface SFTPEntry {
  name: string;
  path: string;
  isDir: boolean;
  isSymlink: boolean;
  size: number;
  modified: number;
  mode: string;
}
export interface SFTPPaths {
  local: string;
  remote: string;
}
export interface SFTPTask {
  id: string;
  ref: Ref;
  direction: "upload" | "download";
  source: string;
  destination: string;
  name: string;
  bytes: number;
  total: number;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  overwrite: boolean;
  resume: boolean;
  error: string;
  created: number;
}

export interface SFTPDocument {
  path: string;
  content: string;
  revision: string;
  size: number;
}
interface SFTPSyncAction {
  relative: string;
  source: string;
  destination: string;
  operation: "copy" | "conflict" | "skip";
  reason: string;
  size: number;
}
export interface SFTPSyncPreview {
  direction: "upload" | "download";
  localDir: string;
  remoteDir: string;
  actions: SFTPSyncAction[];
  skipped: number;
  bytes: number;
}

