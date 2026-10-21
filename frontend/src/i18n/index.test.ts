import { expect, test } from "vitest";
import { i18n, initializeI18n, resources } from ".";
import { normalizeLanguage } from "./languages";
test("defaults to English and uses bundled Chinese resources", async () => {
  expect(normalizeLanguage(undefined)).toBe("en");
  expect(normalizeLanguage("fr")).toBe("en");
  expect(normalizeLanguage("zh-CN")).toBe("zh-CN");
  await initializeI18n("en");
  expect(i18n.t("common:close")).toBe("Close");
  await initializeI18n("zh-CN");
  expect(i18n.t("common:close")).toBe("关闭");
  expect(document.documentElement.lang).toBe("zh-CN");
});
test("both languages have matching keys and interpolation parameters", () => {
  for (const ns of Object.keys(resources.en)) {
    const en = resources.en[ns as keyof typeof resources.en];
    const zh = resources["zh-CN"][ns as keyof typeof resources.en];
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en)) {
      const params = (text: string) =>
        text.match(/{{\s*\w+\s*}}/g)?.sort() ?? [];
      expect(params((zh as Record<string, string>)[key])).toEqual(
        params((en as Record<string, string>)[key]),
      );
    }
  }
});
test("missing Chinese translation falls back to English", async () => {
  await initializeI18n("zh-CN");
  i18n.addResource("en", "common", "fallbackProbe", "English fallback");
  expect(i18n.t("common:fallbackProbe" as never)).toBe("English fallback");
});
