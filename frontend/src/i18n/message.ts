import { i18n } from ".";
type Resources = typeof import(".").resources.en;
export type MessageKey = {
  [N in keyof Resources]: `${N}:${Extract<keyof Resources[N], string>}`;
}[keyof Resources];
export interface LocalizedMessage {
  key: MessageKey;
  values?: Record<string, string | number>;
}
export type DisplayText = string | LocalizedMessage;
export function message(
  key: MessageKey,
  values?: LocalizedMessage["values"],
): LocalizedMessage {
  return { key, values };
}
export function renderMessage(value: DisplayText): string {
  return typeof value === "string"
    ? value
    : String(i18n.t(value.key, value.values));
}
