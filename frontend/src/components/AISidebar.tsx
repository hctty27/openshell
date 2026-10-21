import { useState, useEffect, useRef } from "react";
import {
  Sparkles,
  PanelRightClose,
  Trash2,
  Send,
  Square,
  Paperclip,
  X,
  ArrowUpRight,
  Check,
  AlertCircle,
  ChevronDown,
  Terminal,
  LoaderCircle,
} from "lucide-react";
import type { Tab, APIProfile, Proposal, ChatMode } from "../types";
import CommandProposal from "./CommandProposal";
interface Props {
  tab: Tab | undefined;
  profiles: APIProfile[];
  profileID: string;
  onProfile(id: string): void;
  onHide(): void;
  onSettings(): void;
  onSend(text: string, mode: ChatMode, context: string): void;
  onAutoContinue?(): void;
  onStop(): void;
  onClear(): void;
  onPreview(): void;
  context: string;
  onClearContext(): void;
  onConfirm(): void;
  onCancel(): void;
  onRevise(command: string, cwd: string, seconds: number): Promise<void>;
}
export default function AISidebar(p: Props) {
  const [input, setInput] = useState("");
  const [modes, setModes] = useState<Record<string, ChatMode>>({});
  const selectedMode = modes[p.tab?.id ?? ""] ?? "confirm";
  const end = useRef<HTMLDivElement>(null);
  const profile = p.profiles.find((v) => v.id === p.profileID);
  const automatic = p.tab?.autoRun;
  const automaticActive =
    !!automatic &&
    ["ready", "running", "awaiting_confirmation", "limit"].includes(
      automatic.status,
    );
  const mode: ChatMode = profile?.toolsEnabled ? selectedMode : "chat";
  const busy =
    !!p.tab?.chatBusy ||
    !!p.tab?.executing ||
    automatic?.status === "running" ||
    automatic?.status === "ready";
  const blocked =
    !p.tab ||
    p.tab.status !== "connected" ||
    !profile ||
    busy ||
    !!p.tab.proposal;
  useEffect(() => {
    end.current?.scrollIntoView?.({ behavior: "smooth" });
  }, [p.tab?.messages, p.tab?.proposal]);
  useEffect(() => setInput(""), [p.tab?.id]);
  const send = (text = input) => {
    if (blocked || !text.trim()) return;
    p.onSend(text, mode, p.context);
    setInput("");
  };
  return (
    <aside className="ai-sidebar">
      <header className="ai-header">
        <span className="ai-icon">
          <Sparkles size={17} />
        </span>
        <strong>AI 助手</strong>
        <span className="beta-label">BETA</span>
        <div>
          <button
            title="清空对话"
            disabled={busy || automaticActive || !!p.tab?.proposal}
            onClick={p.onClear}
          >
            <Trash2 size={15} />
          </button>
          <button title="收起 AI" onClick={p.onHide}>
            <PanelRightClose size={17} />
          </button>
        </div>
      </header>
      <div className="model-picker">
        {p.profiles.length ? (
          <>
            <span className="status-dot" />
            <select
              aria-label="当前模型"
              disabled={automaticActive}
              value={p.profileID}
              onChange={(e) => p.onProfile(e.target.value)}
            >
              {p.profiles.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name} · {v.model}
                </option>
              ))}
            </select>
            <ChevronDown size={13} />
          </>
        ) : (
          <button onClick={p.onSettings}>
            配置你的 AI API <ArrowUpRight size={14} />
          </button>
        )}
      </div>
      <div className="ai-conversation">
        {!p.tab?.messages.length && (
          <div className="ai-welcome">
            <div className="ai-welcome-icon">
              <Sparkles size={27} />
            </div>
            <h3>你的服务器助手</h3>
            <p>
              描述问题，让 AI 帮你分析日志、
              <br />
              生成命令并处理服务器任务。
            </p>
            <div className="suggestions">
              {[
                "检查服务器运行状态",
                "帮我排查 Redis 启动失败",
                "查看磁盘空间占用",
              ].map((text) => (
                <button
                  key={text}
                  disabled={blocked}
                  onClick={() => send(text)}
                >
                  <Terminal size={14} />
                  {text}
                  <ArrowUpRight size={13} />
                </button>
              ))}
            </div>
            <div className="ai-explainer">
              <Check size={13} />
              <span>
                命令由你确认后执行
                <br />
                使用你自己的模型与 API
              </span>
            </div>
          </div>
        )}
        {p.tab?.messages.map((m) => (
          <div key={m.id} className={`message ${m.role}`}>
            <div className="message-label">
              {m.role === "user"
                ? "你"
                : m.role === "result"
                  ? "执行结果"
                  : "AI 助手"}
              {m.incomplete && <span> · 输出未完成</span>}
            </div>
            {m.role === "result" && m.result ? (
              <>
                <div
                  className={`result-status ${m.result.status === "completed" ? "ok" : ""}`}
                >
                  {m.result.status === "completed" ? (
                    <Check size={14} />
                  ) : (
                    <AlertCircle size={14} />
                  )}
                  <strong>
                    {m.result.status === "completed"
                      ? "执行完成"
                      : m.result.status === "unknown"
                        ? "结果未知"
                        : "执行失败"}
                  </strong>
                  <span>
                    退出码 {m.result.exitCode ?? "未知"} ·{" "}
                    {(m.result.durationMillis / 1000).toFixed(2)}s
                  </span>
                </div>
                {m.result.reason && (
                  <p className="small muted">
                    {(
                      {
                        timed_out: "已超时，远端进程是否结束尚未确认",
                        cancelled: "已停止等待，远端进程是否结束尚未确认",
                        connection_lost: "连接中断，无法确认远端结果",
                      } as Record<string, string>
                    )[m.result.reason] ?? m.result.reason}
                  </p>
                )}
                {m.command && (
                  <code className="executed-command">{m.command}</code>
                )}
                <pre className="result-output">
                  {m.result.stdout || "(无标准输出)"}
                  {m.result.stderr && `\n[stderr]\n${m.result.stderr}`}
                </pre>
                {m.result.truncated && (
                  <p className="small muted">输出超过上限，已截断。</p>
                )}
              </>
            ) : (
              <div className="message-body">
                {m.text ||
                  (p.tab?.chatBusy &&
                  m.id === p.tab.messages.at(-1)?.id &&
                  m.role === "assistant" ? (
                    <LoaderCircle size={14} className="spin" />
                  ) : (
                    "本次回复未返回文本"
                  ))}
              </div>
            )}
          </div>
        ))}
        {p.tab?.proposal && (
          <CommandProposal
            key={p.tab.proposal.id}
            proposal={p.tab.proposal}
            host={`${p.tab.session.host}:${p.tab.session.port}`}
            username={p.tab.session.username}
            executing={p.tab.executing}
            onConfirm={p.onConfirm}
            onCancel={p.onCancel}
            onRevise={p.onRevise}
            readOnly={automaticActive}
            confirmDisabled={automatic?.status === "limit"}
          />
        )}
        <div ref={end} />
      </div>
      <div className="ai-composer">
        {automatic && (
          <div className="auto-progress" role="status">
            <strong>
              自动执行 · 本轮 {automatic.roundSteps}/{automatic.limit} · 累计{" "}
              {automatic.steps} 条
            </strong>
            <span>
              {automatic.reason ||
                (p.tab?.executing ? "命令执行中" : "正在处理任务")}
            </span>
            {automatic.status === "limit" && (
              <button className="secondary" onClick={p.onAutoContinue}>
                继续下一轮
              </button>
            )}
            {automaticActive && (
              <small>
                范围：
                {automatic.allowChanges ? "允许修改操作" : "仅检查自动执行"} ·
                目标固定在当前任务服务器
              </small>
            )}
          </div>
        )}
        {p.tab && (
          <div className="target-line">
            <span
              className={`status-dot ${p.tab.status === "connected" ? "" : "offline"}`}
            />
            <span title={`${p.tab.session.username}@${p.tab.session.host}`}>
              {p.tab.session.name}
            </span>
            <code title={p.tab.cwd}>{p.tab.cwd || "目录未获取"}</code>
          </div>
        )}
        {p.context && (
          <div className="attachment">
            <Paperclip size={13} />
            <span>已附加终端文本 · {p.context.length} 字符</span>
            <button title="移除终端文本" onClick={p.onClearContext}>
              <X size={13} />
            </button>
          </div>
        )}
        <div className="composer-box">
          <textarea
            aria-label="发送给 AI"
            placeholder={
              p.tab ? "描述你想完成的操作…" : "连接服务器后开始对话…"
            }
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={!p.tab || busy || automaticActive}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                send();
              }
            }}
          />
          <div className="composer-tools">
            <button
              title="附加终端输出"
              disabled={!p.tab || p.tab.status !== "connected" || busy}
              onClick={p.onPreview}
            >
              <Paperclip size={16} />
            </button>
            <select
              className="mode-select"
              aria-label="AI 模式"
              value={mode}
              disabled={busy || automaticActive || !!p.tab?.proposal}
              onChange={(e) =>
                p.tab &&
                setModes({ ...modes, [p.tab.id]: e.target.value as ChatMode })
              }
            >
              <option value="chat">普通对话</option>
              <option value="confirm" disabled={!profile?.toolsEnabled}>
                确认执行
              </option>
              <option value="auto" disabled={!profile?.toolsEnabled}>
                自动执行
              </option>
            </select>
            {busy || automaticActive ? (
              <button
                title="停止任务"
                className="send-button"
                onClick={p.onStop}
              >
                <Square size={14} />
              </button>
            ) : (
              <button
                title="发送消息"
                className="send-button"
                disabled={blocked || !input.trim()}
                onClick={() => send()}
              >
                <Send size={15} />
              </button>
            )}
          </div>
        </div>
        <p className="composer-note">
          {p.tab?.proposal
            ? "请先执行或拒绝当前提议"
            : "Enter 发送 · Shift + Enter 换行"}
        </p>
      </div>
    </aside>
  );
}
