export const languages = [
  { value: "en", label: "English" },
  { value: "zh-CN", label: "简体中文" },
] as const;
export type Language = (typeof languages)[number]["value"];
export function normalizeLanguage(value: unknown): Language {
  return value === "zh-CN" ? value : "en";
}
