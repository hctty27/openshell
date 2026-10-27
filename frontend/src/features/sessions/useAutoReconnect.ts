import { useEffect, useRef, type RefObject } from "react";
import { api } from "../../bridge";
import { decodeAppError } from "../../i18n/errors";
import { message } from "../../i18n/message";
import type { HostChallenge, Ref, Tab } from "../../types";

interface Options {
  tabs: Tab[];
  tabsRef: RefObject<Tab[]>;
  update(tabID: string, change: (tab: Tab) => Tab): void;
  enabled: boolean;
  maxReconnectAttempts: number;
  onChallenge(host: HostChallenge, tab: Tab): void;
  restoreConversation(ref: Ref, conversationID: string): Promise<void>;
}

export function useAutoReconnect({
  tabs, tabsRef, update, enabled, maxReconnectAttempts, onChallenge, restoreConversation,
}: Options) {
  const reconnectTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const reconnectInFlight = useRef(new Set<string>());
  const stopRetryTimer = (tabID: string) => {
    const timer = reconnectTimers.current.get(tabID);
    if (timer !== undefined) clearTimeout(timer);
    reconnectTimers.current.delete(tabID);
  };
  useEffect(() => () => {
    for (const timer of reconnectTimers.current.values()) clearTimeout(timer);
    reconnectTimers.current.clear();
  }, []);
  useEffect(() => {
    for (const tab of tabs) {
      if (tab.status === "reconnecting" && !enabled) {
        stopRetryTimer(tab.id);
        update(tab.id, t => ({ ...t, status: "disconnected", error: message("common:reconnectStopped") }));
        continue;
      }
      if (tab.status !== "reconnecting" || tab.manualDisconnected) {
        stopRetryTimer(tab.id);
        continue;
      }
      if (reconnectTimers.current.has(tab.id) || reconnectInFlight.current.has(tab.id)) continue;
      const nextAttempt = (tab.retryCount ?? 0) + 1;
      const limit = maxReconnectAttempts;
      if (limit > 0 && nextAttempt > limit) {
        update(tab.id, t => ({ ...t, status: "disconnected", error: message("common:reconnectStopped") }));
        continue;
      }
      const expectedGeneration = tab.ref?.generation;
      const intervals = [1000, 2000, 5000, 10000, 20000, 30000];
      const timer = setTimeout(async () => {
        reconnectTimers.current.delete(tab.id);
        const current = tabsRef.current.find(t => t.id === tab.id);
        if (!current || current.status !== "reconnecting" ||
            current.manualDisconnected || current.ref?.generation !== expectedGeneration) return;
        reconnectInFlight.current.add(tab.id);
        try {
          const result = await api.Reconnect(tab.id, tab.session.id);
          const latest = tabsRef.current.find(t => t.id === tab.id);
          if (!latest || latest.manualDisconnected || latest.status !== "reconnecting") {
            await api.Disconnect(result.ref).catch(() => {});
            return;
          }
          if (result.challenge) {
            update(tab.id, t => ({ ...t, status: "disconnected", error: message("common:reconnectStopped") }));
            onChallenge(result.challenge, latest);
            return;
          }
          update(tab.id, t => ({
            ...t, ref: result.ref, conversationID: result.conversationId,
            status: "connected", everConnected: true, home: result.home, cwd: result.home,
            retryCount: 0, error: "", manualDisconnected: false,
          }));
          if (result.conversationId) await restoreConversation(result.ref, result.conversationId);
        } catch (error) {
          const code = decodeAppError(error)?.code;
          const authenticationErrors = new Set([
            "sshAuthentication", "couldNotReadLoginCredentialsEnterThemAgain",
            "fingerprintChanged", "fingerprintFirst",
            "privateKeyInvalid", "privateKeyRead",
          ]);
          const requiresAuthentication = (code !== undefined && authenticationErrors.has(code)) ||
            /authenticat|credential|password|passphrase|fingerprint|private.key/i.test(String(error));
          update(tab.id, t => t.status !== "reconnecting" || t.manualDisconnected ? t : ({
            ...t, status: requiresAuthentication ? "disconnected" : "reconnecting",
            retryCount: nextAttempt, error,
          }));
        } finally {
          reconnectInFlight.current.delete(tab.id);
        }
      }, intervals[Math.min(nextAttempt - 1, intervals.length - 1)]);
      reconnectTimers.current.set(tab.id, timer);
    }
    for (const [tabID] of reconnectTimers.current) {
      if (!tabs.some(t => t.id === tabID && t.status === "reconnecting" && !t.manualDisconnected)) stopRetryTimer(tabID);
    }
  }, [tabs, enabled, maxReconnectAttempts]);
  return { stopRetryTimer };
}
