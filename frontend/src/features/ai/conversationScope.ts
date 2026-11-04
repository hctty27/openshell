import type { AIConversation } from "../../types";

// Legacy conversations did not persist a scope; preserve their original execution context.
export function belongsToConversationScope(conversation: AIConversation, terminalScopeId?: string): boolean {
  if (conversation.scope === "global") return terminalScopeId === undefined;
  if (conversation.scope === "terminal") {
    return terminalScopeId !== undefined && conversation.scopeId === terminalScopeId;
  }
  if (conversation.execution === "terminal") {
    return terminalScopeId !== undefined &&
      conversation.targetSessionIds?.length === 1 &&
      conversation.targetSessionIds[0] === terminalScopeId;
  }
  return terminalScopeId === undefined;
}
