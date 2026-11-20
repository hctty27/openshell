import type { AIConversation } from "../../types";
import { belongsToConversationScope } from "./conversationScope";

export interface PromptHistoryNavigation {
  index: number;
  draft: string;
  entries: string[];
}

export function emptyPromptHistoryNavigation(): PromptHistoryNavigation {
  return { index: -1, draft: "", entries: [] };
}

// Prefer the selected conversation, then other conversations from the same AI scope.
// Existing conversation persistence is the source of truth; never include assistant output.
export function collectPromptHistory(
  conversations: AIConversation[],
  selectedID: string,
  terminalScopeId?: string,
  limit = 100,
): string[] {
  const matching = conversations.filter(item => belongsToConversationScope(item, terminalScopeId));
  const selected = matching.find(item => item.id === selectedID);
  const rest = matching
    .filter(item => item.id !== selectedID)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const entries: string[] = [];
  for (const conversation of selected ? [selected, ...rest] : rest) {
    for (let i = conversation.messages.length - 1; i >= 0; i--) {
      const message = conversation.messages[i];
      if (message.role === "user" && message.content.trim()) {
        entries.push(message.content);
        if (entries.length >= limit) return entries;
      }
    }
  }
  return entries;
}

export function navigatePromptHistory(
  navigation: PromptHistoryNavigation,
  direction: "up" | "down",
  message: string,
  availableEntries: () => string[],
): { navigation: PromptHistoryNavigation; message: string } | null {
  if (navigation.index === -1) {
    if (direction === "down") return null;
    const entries = availableEntries();
    if (!entries.length) return null;
    return { navigation: { index: 0, draft: message, entries }, message: entries[0] };
  }
  const index = navigation.index + (direction === "up" ? 1 : -1);
  if (index >= navigation.entries.length) return null;
  if (index < 0) {
    return { navigation: emptyPromptHistoryNavigation(), message: navigation.draft };
  }
  return { navigation: { ...navigation, index }, message: navigation.entries[index] };
}
