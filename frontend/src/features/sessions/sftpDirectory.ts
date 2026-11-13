import type { Tab } from "../../types";

export function resolveSFTPInitialDirectory(
  rememberedDirectory: string | undefined,
  tab: Pick<Tab, "cwd" | "cwdReported" | "cloneCwd">,
): string {
  return rememberedDirectory || (tab.cwdReported ? tab.cwd : tab.cloneCwd ?? tab.cwd);
}
