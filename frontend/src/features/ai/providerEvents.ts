export const AI_PROVIDERS_CHANGED = "openshell:ai-providers-changed";

export function notifyAIProvidersChanged(): void {
  window.dispatchEvent(new Event(AI_PROVIDERS_CHANGED));
}
