import type { Tab } from "../../types";

export function isActiveRemoteSession(tab: Tab): boolean {
  return tab.status === "connected" || tab.status === "connecting" ||
    tab.status === "reconnecting";
}

export function hasInterruptibleWork(tab: Tab, hasTransfers: (ref: Tab["ref"]) => boolean): boolean {
  return tab.chatBusy || tab.executing || !!tab.proposal ||
    !!(tab.autoRun && ["ready", "running", "awaiting_confirmation", "limit"].includes(tab.autoRun.status)) ||
    hasTransfers(tab.ref);
}

export function sessionLabel(tab: Tab): string {
  return `${tab.session.name} · ${tab.session.username}@${tab.session.host}:${tab.session.port}`;
}
