import { useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, ChevronDown, ChevronRight, Clock3, FilePenLine, FileText, FolderOpen, Terminal } from "lucide-react";
import type { AIMessage, AIToolCall } from "../types";

interface ToolStep {
  call: AIToolCall;
  result?: AIMessage;
}

type TranscriptEntry =
  | { kind: "message"; id: string; message: AIMessage }
  | { kind: "tools"; id: string; steps: ToolStep[]; note: string }
  | { kind: "orphan"; id: string; message: AIMessage };

function buildTranscript(messages: AIMessage[]): TranscriptEntry[] {
  const results = new Map<string, AIMessage[]>();
  for (const message of messages) {
    if (message.role !== "tool" || !message.tool_call_id) continue;
    const bucket = results.get(message.tool_call_id) ?? [];
    bucket.push(message);
    results.set(message.tool_call_id, bucket);
  }

  const consumed = new Set<AIMessage>();
  const entries: TranscriptEntry[] = [];
  for (const [index, message] of messages.entries()) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      if (!consumed.has(message)) {
        entries.push({ kind: "orphan", id: `orphan-${index}`, message });
      }
      continue;
    }
    if (message.role === "assistant" && message.tool_calls?.length) {
      const steps = message.tool_calls.map(call => {
        const result = results.get(call.id)?.shift();
        if (result) consumed.add(result);
        return { call, result };
      });
      entries.push({ kind: "tools", id: `tools-${index}`, steps, note: message.content });
      continue;
    }
    if (message.content) entries.push({ kind: "message", id: `message-${index}`, message });
  }

  // Tool responses may be emitted after other messages; render any unmatched
  // ones as collapsible legacy records rather than losing conversation data.
  const rendered = new Set<AIMessage>();
  return entries.filter(entry => {
    if (entry.kind !== "orphan") return true;
    if (consumed.has(entry.message) || rendered.has(entry.message)) return false;
    rendered.add(entry.message);
    return true;
  });
}

function toolArgs(call: AIToolCall): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(call.function.arguments);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function stringArg(value: unknown): string {
  return typeof value === "string" ? value : "";
}

type ToolState = "running" | "success" | "failed" | "unknown";

function toolState(call: AIToolCall, result?: AIMessage): ToolState {
  if (!result) return "running";
  const output = result.content.trim();
  if (call.function.name === "ssh_exec") {
    // Use only the final exit-status line appended by the executor, not
    // a similarly worded string printed by the command itself.
    const status = output.match(/(?:^|\n)退出状态:\s*(?:exit status\s*)?(-?\d+)\s*$/i);
    if (status) return Number(status[1]) === 0 ? "success" : "failed";
  }

  if (/^(未授权|会话目标已过期|执行失败|终端执行失败|终端命令|命令长度无效|缺少文件修订号|AI 写入内容超过|文件超过|任务已取消|未知工具|invalid|error:)/i.test(output)) {
    return "failed";
  }
  if (call.function.name === "sftp_write") {
    return output.startsWith("保存成功") ? "success" : "unknown";
  }
  if (call.function.name === "sftp_list" || call.function.name === "sftp_read") {
    try {
      JSON.parse(output);
      return "success";
    } catch {
      return "unknown";
    }
  }
  return "unknown";
}

function toolTitle(call: AIToolCall): { label: string; detail: string } {
  const args = toolArgs(call);
  const path = stringArg(args.path);
  switch (call.function.name) {
    case "ssh_exec":
      return { label: "终端命令", detail: stringArg(args.command) || "命令参数不可解析" };
    case "sftp_list":
      return { label: "查看目录", detail: path || "/" };
    case "sftp_read":
      return { label: "读取文件", detail: path || "文件路径未知" };
    case "sftp_write":
      return { label: "修改文件", detail: path || "文件路径未知" };
    default:
      return { label: call.function.name, detail: "" };
  }
}

function AIToolCard({ step, execution, note }: {
  step: ToolStep;
  execution: "independent" | "terminal";
  note?: string;
}) {
  const { call, result } = step;
  const state = toolState(call, result);
  const [expanded, setExpanded] = useState(state === "failed" || state === "unknown");
  useEffect(() => {
    if (state === "failed" || state === "unknown") setExpanded(true);
  }, [state]);
  const title = toolTitle(call);
  const statusLabel = state === "success" ? "成功" :
    state === "failed" ? "失败" : state === "running" ? "执行中" : "待核对";
  const Icon = call.function.name === "ssh_exec" ? Terminal :
    call.function.name === "sftp_list" ? FolderOpen :
      call.function.name === "sftp_write" ? FilePenLine : FileText;
  const StatusIcon = state === "success" ? CheckCircle2 :
    state === "failed" ? AlertCircle : Clock3;
  const id = `ai-tool-detail-${call.id}`;

  return (
    <div className={`ai-step-card ai-step-card--${state}`}>
      <button type="button" className="ai-step-summary"
        aria-expanded={expanded} aria-controls={id}
        onClick={() => setExpanded(value => !value)}
        title={title.detail}>
        <Icon size={14} aria-hidden="true" className="ai-step-icon" />
        <span className="ai-step-label">
          <span className="ai-step-action">{title.label}</span>
          {title.detail && <code className="ai-step-command">{title.detail}</code>}
        </span>
        <span className="ai-step-status"><StatusIcon size={13} aria-hidden="true" />{statusLabel}</span>
        {expanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
      </button>
      {expanded && (
        <div id={id} className="ai-step-detail">
          {note?.trim() && <p className="ai-step-note">{note.trim()}</p>}
          {call.function.name === "ssh_exec" && execution === "terminal" &&
            <p className="ai-step-hint">命令执行过程也可以在当前终端查看。</p>}
          <div className="ai-step-detail-heading">调用参数</div>
          <pre>{call.function.arguments}</pre>
          <div className="ai-step-detail-heading">执行结果</div>
          <pre>{result?.content || (state === "running" ? "等待执行结果…" : "无输出")}</pre>
        </div>
      )}
    </div>
  );
}

export default function AITranscript({ messages, execution = "independent" }: {
  messages: AIMessage[];
  execution?: "independent" | "terminal";
}) {
  const entries = buildTranscript(messages);
  return (
    <>
      {entries.map(entry => {
        if (entry.kind === "tools") {
          return (
            <div key={entry.id} className="ai-step-group" aria-label="执行记录">
              {entry.steps.map((step, index) => (
                <AIToolCard key={step.call.id || index} step={step} execution={execution}
                  note={index === 0 ? entry.note : undefined} />
              ))}
            </div>
          );
        }
        if (entry.kind === "orphan") {
          return (
            <details key={entry.id} className="ai-step-orphan">
              <summary>历史工具结果（查看详情）</summary>
              <pre>{entry.message.content}</pre>
            </details>
          );
        }
        return entry.message.role === "user" ? (
          <div className="ai-message ai-message--user" key={entry.id}>
            <pre>{entry.message.content}</pre>
          </div>
        ) : (
          <div className="ai-message ai-message--assistant" key={entry.id}>
            <pre>{entry.message.content}</pre>
          </div>
        );
      })}
    </>
  );
}
