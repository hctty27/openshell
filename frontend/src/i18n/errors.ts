import { i18n, t } from ".";
import {
  renderMessage,
  type LocalizedMessage,
  type MessageKey,
} from "./message";
export interface AppErrorPayload {
  code: string;
  params?: Record<string, string | number | boolean>;
  detail?: string;
}
const prefix = "OPENSHELL_ERROR:";
function rawText(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  return String(value);
}
export function decodeAppError(value: unknown): AppErrorPayload | null {
  const text = rawText(value);
  if (!text.startsWith(prefix)) return null;
  try {
    const data: unknown = JSON.parse(text.slice(prefix.length));
    if (
      !data ||
      typeof data !== "object" ||
      !("code" in data) ||
      typeof data.code !== "string"
    )
      return null;
    const payload = data as AppErrorPayload;
    if (payload.detail !== undefined && typeof payload.detail !== "string")
      return null;
    if (
      payload.params !== undefined &&
      (!payload.params ||
        typeof payload.params !== "object" ||
        Array.isArray(payload.params) ||
        Object.values(payload.params).some(
          (value) => !["string", "number", "boolean"].includes(typeof value),
        ))
    )
      return null;
    return payload;
  } catch {
    return null;
  }
}
// detailText renders a wrapped cause. Backend errors can wrap coded errors
// several levels deep (apperror.Wrap of an apperror), so known codes are
// translated all the way down instead of leaking OPENSHELL_ERROR JSON.
function detailText(detail: string, depth: number): string {
  const nested = depth < 6 ? decodeAppError(detail) : null;
  if (!nested) return detail;
  const known = i18n.exists(nested.code, { ns: "errors" });
  const summary = known
    ? t(`errors:${nested.code}` as MessageKey, nested.params)
    : t("errors:unknown");
  if (nested.detail) return `${summary}: ${detailText(nested.detail, depth + 1)}`;
  return known ? summary : `${summary}: ${nested.code}`;
}

export function errorText(value: unknown): string {
  if (
    value &&
    typeof value === "object" &&
    "key" in value &&
    typeof value.key === "string"
  )
    return renderMessage(value as LocalizedMessage);
  const payload = decodeAppError(value);
  if (!payload) return `${t("errors:unknown")}: ${rawText(value)}`;
  const known = i18n.exists(payload.code, { ns: "errors" });
  const summary = known
    ? t(`errors:${payload.code}` as MessageKey, payload.params)
    : t("errors:unknown");
  const detail = payload.detail ? detailText(payload.detail, 0) : "";
  return detail
    ? `${summary}: ${detail}`
    : known
      ? summary
      : `${summary}: ${payload.code}`;
}

const importSkipCodes = {
  "too large": "errors:xshellPreviewTooLarge",
  "unsafe path": "errors:xshellPreviewUnsafePath",
  "size limit": "errors:xshellPreviewSizeLimit",
  "invalid connection": "errors:backupInvalidConnection",
} as const;

export function importIssueText(value: string): string {
  const split = value.lastIndexOf(": ");
  if (split < 0) return value;
  const name = value.slice(0, split);
  const reason = value.slice(split + 2);
  if (reason.startsWith(prefix)) return `${name}: ${errorText(reason)}`;
  const code = importSkipCodes[reason as keyof typeof importSkipCodes];
  return code ? `${name}: ${t(code)}` : value;
}

export function reasonText(value: {
  reasonCode?: string;
  reasonParams?: Record<string, string | number>;
  reason?: string;
}): string {
  if (value.reasonCode && i18n.exists(value.reasonCode, { ns: "errors" }))
    return t(`errors:${value.reasonCode}` as MessageKey, value.reasonParams);
  if (value.reason?.startsWith(prefix)) return errorText(value.reason);
  return value.reason ?? "";
}
