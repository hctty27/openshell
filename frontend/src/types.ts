export interface Session {
  id: string;
  groupId: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: string;
  privateKeyPath: string;
  credentialRef: string;
  createdAt?: string;
  updatedAt?: string;
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
export interface APIProfile {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  secretRef: string;
  toolsEnabled: boolean;
}
export interface Ref {
  tabId: string;
  sessionId: string;
  generation: number;
}
export interface Proposal {
  id: string;
  ref: Ref;
  command: string;
  purpose: string;
  cwd: string;
  timeoutSeconds: number;
  status: string;
}
export interface CommandResult {
  status: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMillis: number;
  truncated: boolean;
  reason: string;
  reasonCode?: string;
  reasonParams?: Record<string, string | number>;
}
export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "result";
  text: string;
  incomplete?: boolean;
  result?: CommandResult;
  command?: string;
}
export interface Tab {
  id: string;
  session: Session;
  ref: Ref | null;
  status: "connecting" | "connected" | "disconnected" | "error";
  home: string;
  cwd: string;
  messages: ChatMessage[];
  proposal: Proposal | null;
  autoRun?: AutoSnapshot;
  chatBusy: boolean;
  executing: boolean;
  error: unknown;
}
export type Theme = "dark" | "light";
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
export type ChatMode = "chat" | "confirm" | "auto";
export interface AutoSnapshot {
  id: string;
  ref: Ref;
  status:
    | "ready"
    | "running"
    | "awaiting_confirmation"
    | "limit"
    | "completed"
    | "stopped"
    | "error";
  steps: number;
  roundSteps: number;
  limit: number;
  allowChanges: boolean;
  reason: string;
  reasonCode?: string;
  reasonParams?: Record<string, string | number>;
  proposal?: Proposal;
}
export interface AutoEvent {
  kind: string;
  state: AutoSnapshot;
  messageId?: string;
  text?: string;
  result?: CommandResult;
}
export interface AppState {
  language?: import("./i18n/languages").Language;
  autoCommandLimit?: number;
  autoAllowChanges?: boolean;
  quickCommands?: QuickCommand[];
  quickCommandLayout?: QuickCommandLayout;
  autoCopySelection?: boolean;
  rightClickPaste?: boolean;
  confirmMultilinePaste?: boolean;
  sessions: Session[];
  groups: Group[];
  profiles: APIProfile[];
  fontSize: string;
  theme?: Theme;
  activeProfile: string;
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
export interface ChatRequest {
  ref: Ref;
  profileId: string;
  text: string;
  context: string;
  operate: boolean;
}
export interface ChatResponse {
  text: string;
  proposal?: Proposal;
}
export interface SessionRequest {
  session: Session;
  secret: string;
  saveSecret: boolean;
}
export interface APIRequest {
  profile: APIProfile;
  key: string;
  memoryOnly: boolean;
}
