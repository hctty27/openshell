import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { initializeI18n } from "../i18n";
import GeneralSettingsPanel from "./GeneralSettingsPanel";
import ConnectionSettingsPanel from "./ConnectionSettingsPanel";
import TerminalSettingsPanel from "./TerminalSettingsPanel";

beforeEach(() => initializeI18n("zh-CN"));
afterEach(cleanup);

test("general settings delegate language, backup and theme actions", () => {
  const onLanguage = vi.fn(async () => {});
  const onExportSessionBackup = vi.fn(async () => {});
  const onImportSessionBackup = vi.fn(async () => {});
  const onTheme = vi.fn();
  const onLanguageError = vi.fn();

  render(
    <GeneralSettingsPanel
      language="zh-CN"
      onLanguage={onLanguage}
      onLanguageError={onLanguageError}
      onExportSessionBackup={onExportSessionBackup}
      onImportSessionBackup={onImportSessionBackup}
      theme="dark"
      onTheme={onTheme}
    />,
  );

  fireEvent.change(screen.getByLabelText("界面语言"), { target: { value: "en" } });
  fireEvent.click(screen.getByRole("button", { name: "浅色" }));
  fireEvent.click(screen.getByRole("button", { name: "导出备份" }));
  fireEvent.click(screen.getByRole("button", { name: "恢复备份" }));

  expect(onLanguage).toHaveBeenCalledWith("en");
  expect(onTheme).toHaveBeenCalledWith("light");
  expect(onExportSessionBackup).toHaveBeenCalledOnce();
  expect(onImportSessionBackup).toHaveBeenCalledOnce();
  expect(onLanguageError).toHaveBeenCalledWith("");
});

test("connection settings keep the local shell conditional on disconnect behavior", () => {
  const setAutoReconnect = vi.fn();
  const setDisconnectBehavior = vi.fn();
  const props = {
    keepAliveSeconds: 30,
    setKeepAliveSeconds: vi.fn(),
    autoReconnect: true,
    setAutoReconnect,
    maxReconnectAttempts: 10,
    setMaxReconnectAttempts: vi.fn(),
    showDisconnectReason: true,
    setShowDisconnectReason: vi.fn(),
    disconnectBehavior: "local",
    setDisconnectBehavior,
    localShell: "powershell",
    setLocalShell: vi.fn(),
    preserveTerminalHistory: true,
    setPreserveTerminalHistory: vi.fn(),
    confirmActiveDisconnect: true,
    setConfirmActiveDisconnect: vi.fn(),
  };
  const { rerender } = render(<ConnectionSettingsPanel {...props} />);
  expect(screen.getByLabelText("默认本地 Shell")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("SSH 断开后的操作"), {
    target: { value: "retain" },
  });
  expect(setDisconnectBehavior).toHaveBeenCalledWith("retain");
  rerender(<ConnectionSettingsPanel {...props} disconnectBehavior="retain" />);
  expect(screen.queryByLabelText("默认本地 Shell")).toBeNull();
});

test("terminal settings display multiline paste confirmation only when right-click paste is enabled", () => {
  const props = {
    theme: "dark" as const,
    terminalTheme: "follow" as const,
    onTerminalTheme: vi.fn(),
    fontSize: 14,
    onFont: vi.fn(),
    quickCommandLayout: "single" as const,
    onQuickCommandLayout: vi.fn(),
    logHighlights: false,
    onLogHighlights: vi.fn(),
    autoCopySelection: true,
    onAutoCopySelection: vi.fn(),
    rightClickPaste: false,
    onRightClickPaste: vi.fn(),
    confirmMultilinePaste: true,
    onConfirmMultilinePaste: vi.fn(),
  };
  const { rerender } = render(<TerminalSettingsPanel {...props} />);
  expect(screen.queryByLabelText("多行粘贴前确认")).toBeNull();
  fireEvent.click(screen.getByLabelText("鼠标右键粘贴"));
  expect(props.onRightClickPaste).toHaveBeenCalledWith(true);
  rerender(<TerminalSettingsPanel {...props} rightClickPaste />);
  expect(screen.getByLabelText("多行粘贴前确认")).toBeTruthy();
});
