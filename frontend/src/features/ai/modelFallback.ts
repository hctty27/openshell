import type { AIProvider } from "../../types";
import type { ModelSelection } from "./modelSelection";

export function resolveAIModelSelection(
  providers: AIProvider[],
  requested: ModelSelection,
  recent: ModelSelection,
): ModelSelection | null {
  const exists = ({ providerId, modelId }: ModelSelection) =>
    providers.some(provider =>
      provider.id === providerId && provider.models.some(model => model.id === modelId),
    );

  if (exists(requested)) return requested;

  const originalProvider = providers.find(provider => provider.id === requested.providerId);
  if (originalProvider?.models.length) {
    return { providerId: originalProvider.id, modelId: originalProvider.models[0].id };
  }

  if (exists(recent)) return recent;

  const first = providers.find(provider => provider.models.length > 0);
  return first ? { providerId: first.id, modelId: first.models[0].id } : null;
}
