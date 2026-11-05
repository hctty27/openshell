import { describe, expect, it } from "vitest";
import type { AIProvider } from "../../types";
import { resolveAIModelSelection } from "./modelFallback";

const providers: AIProvider[] = [
  { id: "a", name: "A", baseUrl: "https://a.test", hasKey: true,
    models: [{ id: "a1", name: "A1" }, { id: "a2", name: "A2" }] },
  { id: "b", name: "B", baseUrl: "https://b.test", hasKey: true,
    models: [{ id: "b1", name: "B1" }] },
];

describe("resolveAIModelSelection", () => {
  it("preserves an available historical model", () => {
    expect(resolveAIModelSelection(providers, { providerId: "a", modelId: "a2" },
      { providerId: "b", modelId: "b1" })).toEqual({ providerId: "a", modelId: "a2" });
  });

  it("prefers a remaining model from the original API", () => {
    expect(resolveAIModelSelection(providers, { providerId: "a", modelId: "deleted" },
      { providerId: "b", modelId: "b1" })).toEqual({ providerId: "a", modelId: "a1" });
  });

  it("falls back to the last available selection when the original API is removed", () => {
    expect(resolveAIModelSelection(providers, { providerId: "deleted", modelId: "old" },
      { providerId: "b", modelId: "b1" })).toEqual({ providerId: "b", modelId: "b1" });
  });

  it("uses the first configured model when recent selection is also unavailable", () => {
    expect(resolveAIModelSelection(providers, { providerId: "deleted", modelId: "old" },
      { providerId: "deleted", modelId: "recent" })).toEqual({ providerId: "a", modelId: "a1" });
  });

  it("returns null when no configured models remain", () => {
    expect(resolveAIModelSelection([], { providerId: "deleted", modelId: "old" },
      { providerId: "a", modelId: "a1" })).toBeNull();
  });
});
