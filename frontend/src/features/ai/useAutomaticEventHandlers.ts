import { useEffect, type RefObject } from "react";
import { listen } from "../../bridge";
import { reasonText } from "../../i18n/errors";
import { t as tr } from "../../i18n";
import type { AutoEvent, Ref, Tab } from "../../types";

interface Options {
  streamIDs: RefObject<Record<string, string>>;
  update(tabID: string, transform: (tab: Tab) => Tab): void;
}

export function useAutomaticEventHandlers({ streamIDs, update }: Options) {
  useEffect(() => {
    const autoEvent = listen("auto:event", (event: AutoEvent) => {
      const s = event.state;
      update(s.ref.tabId, (t) => {
        if (
          t.ref?.generation !== s.ref.generation ||
          t.ref.sessionId !== s.ref.sessionId ||
          t.autoRun?.id !== s.id
        )
          return t;
        if (event.kind === "thinking" && event.messageId)
          streamIDs.current[s.ref.tabId] = event.messageId;
        const terminal = ["completed", "stopped", "error"].includes(s.status);
        const next = { ...t, autoRun: s };
        if (event.kind === "thinking") {
          next.chatBusy = true;
          next.messages = [
            ...t.messages,
            { id: event.messageId!, role: "assistant", text: "" },
          ];
        } else if (event.kind === "reply") {
          next.chatBusy = false;
          next.proposal = s.proposal ?? null;
          next.messages = t.messages.map((m) =>
            m.id === event.messageId
              ? {
                  ...m,
                  text:
                    event.text ||
                    (s.proposal
                      ? tr("common:commandProposalReady")
                      : tr("common:noTextReturned")),
                }
              : m,
          );
        } else if (event.kind === "executing") {
          next.executing = true;
          next.proposal = s.proposal ?? null;
        } else if (event.kind === "result") {
          next.executing = false;
          next.proposal = null;
          next.messages = [
            ...t.messages,
            {
              id: crypto.randomUUID(),
              role: "result",
              text: "",
              result: event.result,
              command: s.proposal?.command,
            },
          ];
        }
        if (terminal) {
          next.chatBusy = false;
          next.executing = false;
          next.proposal = null;
          next.messages = next.messages.map((m) =>
            m.id === event.messageId && !m.text && m.role === "assistant"
              ? {
                  ...m,
                  text: reasonText(s) || tr("common:taskEnded"),
                  incomplete: s.status !== "completed",
                }
              : m,
          );
          delete streamIDs.current[s.ref.tabId];
        }
        if (t.conversationID) next.messages = t.messages;
        return next;
      });
    });
    const delta = listen("ai:delta", (payload: { ref: Ref; text: string }) => {
      const messageID = streamIDs.current[payload.ref.tabId];
      if (messageID)
        update(payload.ref.tabId, (t) =>
          t.ref?.generation === payload.ref.generation
            ? {
                ...t,
                messages: t.messages.map((m) =>
                  m.id === messageID
                    ? { ...m, text: m.text + payload.text }
                    : m,
                ),
              }
            : t,
        );
    });
    return () => {
      delta();
      autoEvent();
    };
  }, []);
}
