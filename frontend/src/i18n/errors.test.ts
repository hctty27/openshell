import { expect, test } from "vitest";
import { initializeI18n } from ".";
import { decodeAppError, errorText, importIssueText, reasonText } from "./errors";
test("Wails string and Error rejections are decoded and translated", async () => {
  const wire =
    'OPENSHELL_ERROR:{"code":"apiHttpStatus","params":{"status":429}}';
  expect(decodeAppError(wire)?.code).toBe("apiHttpStatus");
  await initializeI18n("en");
  expect(errorText(new Error(wire))).toContain("HTTP 429");
  await initializeI18n("zh-CN");
  expect(errorText(wire)).toContain("返回 HTTP 429");
});
test("unknown or malformed errors preserve diagnostic details", async () => {
  await initializeI18n("en");
  expect(errorText(new Error("socket closed"))).toContain("socket closed");
  expect(errorText("OPENSHELL_ERROR:bad")).toContain("OPENSHELL_ERROR:bad");
  expect(
    errorText('OPENSHELL_ERROR:{"code":"future","detail":"diagnostic"}'),
  ).toContain("diagnostic");
  expect(
    decodeAppError('OPENSHELL_ERROR:{"code":"apiHttpStatus","params":42}'),
  ).toBeNull();
});
test("reason codes translate while unknown server text is retained", async () => {
  await initializeI18n("en");
  expect(
    reasonText({ reasonCode: "taskCompleted", reason: "任务已完成" }),
  ).toBe("Task completed");
  await initializeI18n("zh-CN");
  expect(
    reasonText({ reasonCode: "taskCompleted", reason: "Task completed" }),
  ).toBe("任务已完成");
  expect(reasonText({ reasonCode: "future", reason: "raw detail" })).toBe(
    "raw detail",
  );
});

test("import warnings retain filenames but localize known reasons", async () => {
  await initializeI18n("en");
  expect(importIssueText("sample.xsh: too large")).toBe("sample.xsh: File is too large");
  expect(importIssueText("backup.json: invalid connection")).toBe("backup.json: Invalid connection settings");
  await initializeI18n("zh-CN");
  expect(importIssueText("sample.xsh: too large")).toBe("sample.xsh: 文件过大");
  expect(importIssueText("backup.json: invalid connection")).toBe("backup.json: 连接配置无效");
  expect(importIssueText("custom.xsh: unexpected diagnostic")).toBe(
    "custom.xsh: unexpected diagnostic",
  );
});

test("structured SFTP failures render in the active language", async () => {
  const wire = 'OPENSHELL_ERROR:{"code":"sftpTransferSourceFileChangedDuringUpload"}';
  await initializeI18n("en");
  expect(errorText(wire)).toBe("source file changed during upload");
  await initializeI18n("zh-CN");
  expect(errorText(wire)).toBe("上传期间源文件发生了变化");
  const wrapped = 'file.xsh: OPENSHELL_ERROR:{"code":"xshellImportMissingHost"}';
  expect(importIssueText(wrapped)).toBe("file.xsh: 缺少主机地址");
});
