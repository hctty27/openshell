export interface ModelSelection {
  providerId: string;
  modelId: string;
}

const storageKey = "openshell.ai.last-model";

export function readLastModel(): ModelSelection {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return { providerId: "", modelId: "" };
    const value: unknown = JSON.parse(raw);
    if (
      value && typeof value === "object" &&
      "providerId" in value && "modelId" in value &&
      typeof value.providerId === "string" && typeof value.modelId === "string"
    ) {
      return { providerId: value.providerId, modelId: value.modelId };
    }
  } catch { /* WebView storage may be unavailable. */ }
  return { providerId: "", modelId: "" };
}

export function saveLastModel(selection: ModelSelection): void {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(selection));
  } catch { /* The in-memory selection remains usable. */ }
}
