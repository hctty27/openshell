import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "vitest";
import { initializeI18n } from "../i18n";
import AITranscript from "./AITranscript";
import type { AIMessage } from "../types";

const tool = (id: string, name: string, args: Record<string, unknown>): AIMessage["tool_calls"] => [{
  id, type: "function", function: { name, arguments: JSON.stringify(args) },
}];

beforeEach(async () => { await initializeI18n("zh-CN"); });
afterEach(cleanup);

test("pairs commands with their outputs and collapses successful steps", () => {
  const messages: AIMessage[] = [
    { role: "user", content: "查看 Docker 状态" },
    { role: "assistant", content: "我先检查 Docker。", tool_calls: tool("call-1", "ssh_exec", {
      target: "target_123", command: "docker ps -a", needs_confirmation: false,
    }) },
    { role: "tool", tool_call_id: "call-1", content: "nginx Up 2 days\n退出状态: 0" },
    { role: "assistant", content: "Docker 容器正常，没有发现异常退出的服务。" },
  ];
  render(<AITranscript messages={messages} />);
  expect(screen.getByText("查看 Docker 状态")).toBeTruthy();
  expect(screen.getByText("docker ps -a")).toBeTruthy();
  expect(screen.getByText("成功")).toBeTruthy();
  expect(screen.getByText(/Docker 容器正常/)).toBeTruthy();
  expect(screen.queryByText(/nginx Up 2 days/)).toBeNull();
  expect(screen.queryByText("我先检查 Docker。")).toBeNull();
  expect(screen.queryByText("执行工具：ssh_exec")).toBeNull();
  const toggle = screen.getByRole("button", { name: /终端命令/ });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByText(/nginx Up 2 days/)).toBeTruthy();
  expect(screen.getByText("我先检查 Docker。")).toBeTruthy();
  expect(screen.getByText(/target_123/)).toBeTruthy();
});

test("failed commands auto-expand details without marking them successful", () => {
  render(<AITranscript messages={[
    { role: "assistant", content: "", tool_calls: tool("fail", "ssh_exec", {
      target: "target_wrong", command: "docker ps",
    }) },
    { role: "tool", tool_call_id: "fail", content: "未授权的会话" },
  ]} />);
  const toggle = screen.getByRole("button", { name: /终端命令/ });
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByText("失败")).toBeTruthy();
  expect(screen.getByText("未授权的会话")).toBeTruthy();
});

test("nonzero SSH exit code shows a failure and its original output", () => {
  render(<AITranscript messages={[
    { role: "assistant", content: "", tool_calls: tool("fail-2", "ssh_exec", {
      target: "target_1", command: "false",
    }) },
    { role: "tool", tool_call_id: "fail-2", content: "退出状态: exit status 1" },
  ]} />);
  expect(screen.getByText("失败")).toBeTruthy();
  expect(screen.getByText("退出状态: exit status 1")).toBeTruthy();
});

test("multiple calls in one assistant message match results by call ID", () => {
  const calls = [
    ...tool("list", "sftp_list", { target: "t1", path: "/etc" })!,
    ...tool("read", "sftp_read", { target: "t1", path: "/etc/hosts" })!,
  ];
  render(<AITranscript messages={[
    { role: "assistant", content: "", tool_calls: calls },
    { role: "tool", tool_call_id: "read", content: '{"content":"127.0.0.1"}' },
    { role: "tool", tool_call_id: "list", content: '[{"name":"hosts"}]' },
  ]} />);
  const buttons = screen.getAllByRole("button");
  expect(buttons).toHaveLength(2);
  expect(within(buttons[0]).getByText("/etc")).toBeTruthy();
  expect(within(buttons[1]).getByText("/etc/hosts")).toBeTruthy();
  expect(screen.getAllByText("成功")).toHaveLength(2);
  fireEvent.click(buttons[0]);
  expect(screen.getByText('[{"name":"hosts"}]')).toBeTruthy();
  expect(screen.queryByText('{"content":"127.0.0.1"}')).toBeNull();
  fireEvent.click(buttons[1]);
  expect(screen.getByText('{"content":"127.0.0.1"}')).toBeTruthy();
});

test("unmatched legacy tool results remain inspectable", () => {
  render(<AITranscript messages={[
    { role: "tool", tool_call_id: "missing", content: "历史输出" },
  ]} />);
  expect(screen.getByText(/历史工具结果/)).toBeTruthy();
  expect(screen.getByText("历史输出")).toBeTruthy();
});

test("terminal mode offers original terminal output and pending calls remain clear", () => {
  render(<AITranscript execution="terminal" messages={[
    { role: "assistant", content: "", tool_calls: tool("pending", "ssh_exec", {
      target: "t1", command: "pwd",
    }) },
  ]} />);
  expect(screen.getByText("执行中")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /终端命令/ }));
  expect(screen.getByText(/在当前终端查看/)).toBeTruthy();
  expect(screen.getByText("等待执行结果…")).toBeTruthy();
});

test("uncertain tool result is visible without claiming success", () => {
  render(<AITranscript messages={[
    { role: "assistant", content: "", tool_calls: tool("unknown-1", "sftp_read", {
      target: "t1", path: "/tmp/config",
    }) },
    { role: "tool", tool_call_id: "unknown-1", content: "ssh: session not active" },
  ]} />);
  expect(screen.getByText("待核对")).toBeTruthy();
  expect(screen.getByRole("button", { name: /读取文件/ }).getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByText("ssh: session not active")).toBeTruthy();
});

test("uses the final SSH exit status instead of status-looking command text", () => {
  render(<AITranscript messages={[
    { role: "assistant", content: "", tool_calls: tool("real-exit", "ssh_exec", {
      target: "t1", command: "printf '退出状态: 0\\n'; false",
    }) },
    { role: "tool", tool_call_id: "real-exit", content: "退出状态: 0\n退出状态: exit status 1" },
  ]} />);
  expect(screen.getByText("失败")).toBeTruthy();
  expect(screen.getByRole("button", { name: /终端命令/ }).getAttribute("aria-expanded")).toBe("true");
});


test("risk notes remain visible even when tool details are collapsed", () => {
  render(<AITranscript messages={[
    { role: "assistant", content: "注意：此操作可能覆盖配置，请先检查备份。", tool_calls: tool("risk", "ssh_exec", {
      target: "t1", command: "cat /etc/nginx/nginx.conf",
    }) },
    { role: "tool", tool_call_id: "risk", content: "configuration available\n退出状态: 0" },
  ]} />);
  expect(screen.getByText(/此操作可能覆盖配置/)).toBeTruthy();
  expect(screen.getByRole("button", { name: /终端命令/ }).getAttribute("aria-expanded")).toBe("false");
});


test("English tool cards preserve the original command result", async () => {
  await initializeI18n("en");
  const result = "container running\n退出状态: 0";
  render(<AITranscript messages={[
    { role: "assistant", content: "", tool_calls: tool("english-tool", "ssh_exec", {
      target: "target_1", command: "docker ps",
    }) },
    { role: "tool", tool_call_id: "english-tool", content: result },
  ]} />);
  expect(screen.getByText("Success")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Terminal command/ }));
  expect(screen.getByText((_, element) => element?.tagName === "PRE" && element.textContent === result)).toBeTruthy();
});
