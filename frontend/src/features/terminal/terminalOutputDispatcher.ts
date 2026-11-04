import { listen } from "../../bridge";
import type { Ref } from "../../types";

export interface SSHOutput {
  ref: Ref;
  data: string;
  sequence?: number;
}

export interface LocalOutput {
  tabId: string;
  terminalId: string;
  data: string;
  sequence?: number;
}

type OutputHandler<T> = (event: T) => void;
type EventListener = (name: string, handler: (payload: any) => void) => () => void;

const sshKey = (ref: Ref) => `${ref.tabId}\0${ref.sessionId}\0${ref.generation}`;
const localKey = (tabId: string, terminalId: string) => `${tabId}\0${terminalId}`;

/**
 * One Wails output listener per transport, regardless of terminal count.
 * Output remains scoped to the full SSH connection generation or local PTY ID.
 */
export class TerminalOutputDispatcher {
  private readonly sshHandlers = new Map<string, Set<OutputHandler<SSHOutput>>>();
  private readonly localHandlers = new Map<string, Set<OutputHandler<LocalOutput>>>();
  private offSSH: (() => void) | null = null;
  private offLocal: (() => void) | null = null;

  constructor(private readonly subscribe: EventListener) {}

  onSSH(ref: Ref, handler: OutputHandler<SSHOutput>): () => void {
    const key = sshKey(ref);
    const handlers = this.sshHandlers.get(key) ?? new Set<OutputHandler<SSHOutput>>();
    handlers.add(handler);
    this.sshHandlers.set(key, handlers);
    if (!this.offSSH) {
      this.offSSH = this.subscribe("ssh:output", event => {
        if (!event?.ref) return;
        const listeners = this.sshHandlers.get(sshKey(event.ref));
        if (listeners) for (const listener of listeners) listener(event);
      });
    }
    return () => {
      handlers.delete(handler);
      if (!handlers.size) this.sshHandlers.delete(key);
      if (!this.sshHandlers.size && this.offSSH) {
        const off = this.offSSH;
        this.offSSH = null;
        off();
      }
    };
  }

  onLocal(tabId: string, terminalId: string, handler: OutputHandler<LocalOutput>): () => void {
    const key = localKey(tabId, terminalId);
    const handlers = this.localHandlers.get(key) ?? new Set<OutputHandler<LocalOutput>>();
    handlers.add(handler);
    this.localHandlers.set(key, handlers);
    if (!this.offLocal) {
      this.offLocal = this.subscribe("local:output", event => {
        if (!event?.tabId || !event?.terminalId) return;
        const listeners = this.localHandlers.get(localKey(event.tabId, event.terminalId));
        if (listeners) for (const listener of listeners) listener(event);
      });
    }
    return () => {
      handlers.delete(handler);
      if (!handlers.size) this.localHandlers.delete(key);
      if (!this.localHandlers.size && this.offLocal) {
        const off = this.offLocal;
        this.offLocal = null;
        off();
      }
    };
  }
}

export const terminalOutputDispatcher = new TerminalOutputDispatcher(listen);
