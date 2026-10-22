import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import type { Language } from "./languages";
import enCommon from "../locales/en/common.json";
import enSessions from "../locales/en/sessions.json";
import enSettings from "../locales/en/settings.json";
import enTerminal from "../locales/en/terminal.json";
import enAI from "../locales/en/ai.json";
import enErrors from "../locales/en/errors.json";
import enSFTP from "../locales/en/sftp.json";
import zhCommon from "../locales/zh-CN/common.json";
import zhSessions from "../locales/zh-CN/sessions.json";
import zhSettings from "../locales/zh-CN/settings.json";
import zhTerminal from "../locales/zh-CN/terminal.json";
import zhAI from "../locales/zh-CN/ai.json";
import zhErrors from "../locales/zh-CN/errors.json";
import zhSFTP from "../locales/zh-CN/sftp.json";
export const resources = {
  en: {
    common: enCommon,
    sessions: enSessions,
    settings: enSettings,
    terminal: enTerminal,
    ai: enAI,
    errors: enErrors,
    sftp: enSFTP,
  },
  "zh-CN": {
    common: zhCommon,
    sessions: zhSessions,
    settings: zhSettings,
    terminal: zhTerminal,
    ai: zhAI,
    errors: zhErrors,
    sftp: zhSFTP,
  },
};
export const i18n = i18next.createInstance();
const ready = i18n.use(initReactI18next).init({
  resources,
  lng: "en",
  fallbackLng: "en",
  supportedLngs: ["en", "zh-CN"],
  load: "currentOnly",
  defaultNS: "common",
  initAsync: false,
  interpolation: { escapeValue: false },
});
i18n.on("languageChanged", (language) => {
  document.documentElement.lang = language;
});
export async function initializeI18n(language: Language): Promise<void> {
  await ready;
  await i18n.changeLanguage(language);
  document.documentElement.lang = language;
}
export function t(
  key: import("./message").MessageKey,
  values?: Record<string, unknown>,
): string {
  return String(i18n.t(key, values));
}
