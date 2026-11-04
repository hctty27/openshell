import type { AIConversation } from "../../types";

// Legacy conversations did not persist a scope; preserve their original execution context.
export function belongsToConversationScope(conversation: AIConversation, terminalScopeId?: string): boolean {
  if (conversation.scope === "global") return terminalScopeId === undefined;
  if (conversation.scope === "terminal") {
    // Older duplicate tabs used "sessionId:tabId". Keep those histories visible
    // under the session without allowing them to cross into other sessions.
    return terminalScopeId !== undefined &&
      (conversation.scopeId === terminalScopeId ||
        conversation.scopeId?.startsWith(`${terminalScopeId}:`) === true);
  }
  if (conversation.execution === "terminal") {
    return terminalScopeId !== undefined &&
      conversation.targetSessionIds?.length === 1 &&
      conversation.targetSessionIds[0] === terminalScopeId;
  }
  return terminalScopeId === undefined;
}
