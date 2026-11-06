import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { initializeI18n } from "../i18n";
import GeneralSettingsPanel from "./GeneralSettingsPanel";
import AppearanceSettingsPanel from "./AppearanceSettingsPanel";
import ConnectionSettingsPanel from "./ConnectionSettingsPanel";
import TerminalSettingsPanel from "./TerminalSettingsPanel";

beforeEach(() => initializeI18n("zh-CN"));
afterEach(cleanup);

test("general settings delegate language and session backup actions", () => {
  const onLanguage = vi.fn(async () => {});
  const onExportSessionBackup = vi.fn(async () => {});
  const onImportSessionBackup = vi.fn(async () => {});
  const onLanguageError = vi.fn();

  render(
    <GeneralSettingsPanel
      language="zh-CN"
      onLanguage={onLanguage}
      onLanguageError={onLanguageError}
      onExportSessionBackup={onExportSessionBackup}
      onImportSessionBackup={onImportSessionBackup}
    />,
  );

  fireEvent.change(screen.getByLabelText("界面语言"), { target: { value: "en" } });
  fireEvent.click(screen.getByRole("button", { name: "导出备份" }));
  fireEvent.click(screen.getByRole("button", { name: "恢复备份" }));

  expect(onLanguage).toHaveBeenCalledWith("en");
  expect(onExportSessionBackup).toHaveBeenCalledOnce();
  expect(onImportSessionBackup).toHaveBeenCalledOnce();
  expect(onLanguageError).toHaveBeenCalledWith("");
});

test("appearance settings delegate theme, palette and font controls", () => {
  const onTheme = vi.fn();
  const onTerminalTheme = vi.fn();
  const onFont = vi.fn();
  render(
    <AppearanceSettingsPanel
      theme="dark"
      onTheme={onTheme}
      terminalTheme="follow"
      onTerminalTheme={onTerminalTheme}
      fontSize={14}
      onFont={onFont}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "浅色" }));
  fireEvent.change(screen.getByLabelText("终端配色方案"), { target: { value: "classic" } });
  fireEvent.change(screen.getByLabelText("字体大小"), { target: { value: "17" } });
  expect(onTheme).toHaveBeenCalledWith("light");
  expect(onTerminalTheme).toHaveBeenCalledWith("classic");
  expect(onFont).toHaveBeenCalledWith(17);
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
    disconnectBehavior: "local" as const,
    setDisconnectBehavior,
    localShell: "powershell" as const,
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
  expect(screen.queryByLabelText("快速命令栏布局")).toBeNull();
  expect(screen.queryByLabelText("ZMODEM 传输引擎")).toBeNull();
  fireEvent.click(screen.getByLabelText("鼠标右键粘贴"));
  expect(props.onRightClickPaste).toHaveBeenCalledWith(true);
  rerender(<TerminalSettingsPanel {...props} rightClickPaste />);
  expect(screen.getByLabelText("多行粘贴前确认")).toBeTruthy();
});

