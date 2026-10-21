import { reasonText } from "../i18n/errors";
import { useTranslation } from "react-i18next";
import { t } from "../i18n";
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
  useTranslation();
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
        <strong>{t("common:aiAssistant")}</strong>
        <span className="beta-label">{t("ai:betaLabel")}</span>
        <div>
          <button
            title={t("ai:clearChat")}
            disabled={busy || automaticActive || !!p.tab?.proposal}
            onClick={p.onClear}
          >
            <Trash2 size={15} />
          </button>
          <button title={t("ai:collapseAi")} onClick={p.onHide}>
            <PanelRightClose size={17} />
          </button>
        </div>
      </header>
      <div className="ai-conversation">
        {!p.tab?.messages.length && (
          <div className="ai-welcome">
            <div className="ai-welcome-icon">
              <Sparkles size={27} />
            </div>
            <h3>{t("ai:yourServerAssistant")}</h3>
            <p>
              {t("ai:describeAProblemLetAiAnalyzeLogs")}
              <br />
              {t("ai:proposeCommandsAndHandleServerTasks")}
            </p>
            <div className="suggestions">
              {[
                t("ai:checkServerHealth"),
                t("ai:checkDiskUsage"),
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
                {t("ai:reviewCommandsBeforeRunning")}
                <br />
                {t("ai:useYourOwnModelAndApi")}
              </span>
            </div>
          </div>
        )}
        {p.tab?.messages.map((m) => (
          <div key={m.id} className={`message ${m.role}`}>
            <div className="message-label">
              {m.role === "user"
                ? t("ai:you")
                : m.role === "result"
                  ? t("ai:commandResult")
                  : t("common:aiAssistant")}
              {m.incomplete && <span> {t("ai:incompleteOutput")}</span>}
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
                      ? t("ai:completed")
                      : m.result.status === "unknown"
                        ? t("ai:resultUnknown")
                        : t("ai:failed")}
                  </strong>
                  <span>
                    {t("ai:exitCodeValue", {
                      code: m.result.exitCode ?? t("common:unknown"),
                      seconds: (m.result.durationMillis / 1000).toFixed(2),
                    })}
                  </span>
                </div>
                {m.result.reason && (
                  <p className="small muted">{reasonText(m.result)}</p>
                )}
                {m.command && (
                  <code className="executed-command">{m.command}</code>
                )}
                <pre className="result-output">
                  {m.result.stdout || t("ai:noStandardOutput")}
                  {m.result.stderr && `\n[stderr]\n${m.result.stderr}`}
                </pre>
                {m.result.truncated && (
                  <p className="small muted">
                    {t("ai:outputLimitReachedContentTruncated")}
                  </p>
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
                    t("common:noTextReturned")
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
              {t("ai:automaticProgress", {
                round: automatic.roundSteps,
                limit: automatic.limit,
                count: automatic.steps,
              })}
            </strong>
            <span>
              {reasonText(automatic) ||
                (p.tab?.executing
                  ? t("ai:runningCommand")
                  : t("ai:processingTask"))}
            </span>
            {automatic.status === "limit" && (
              <button className="secondary" onClick={p.onAutoContinue}>
                {t("ai:nextRound")}
              </button>
            )}
            {automaticActive && (
              <small>
                {t("ai:scope")}
                {automatic.allowChanges
                  ? t("ai:changesAllowed")
                  : t("ai:automaticInspectionOnly")}{" "}
                {t("ai:targetFixedToThisTaskSServer")}
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
            <code title={p.tab.cwd}>
              {p.tab.cwd || t("ai:directoryUnavailable")}
            </code>
          </div>
        )}
        {p.context && (
          <div className="attachment">
            <Paperclip size={13} />
            <span>{t("ai:attachedText", { count: p.context.length })}</span>
            <button
              title={t("ai:removeTerminalText")}
              onClick={p.onClearContext}
            >
              <X size={13} />
            </button>
          </div>
        )}
        <div className="composer-box">
          <textarea
            aria-label={t("ai:sendToAi")}
            placeholder={
              p.tab
                ? t("ai:describeWhatYouWantToDo")
                : t("ai:connectToAServerToStartChatting")
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
              title={t("ai:attachTerminalOutput")}
              disabled={!p.tab || p.tab.status !== "connected" || busy}
              onClick={p.onPreview}
            >
              <Paperclip size={16} />
            </button>
            <select
              className="mode-select"
              aria-label={t("ai:aiMode")}
              value={mode}
              disabled={busy || automaticActive || !!p.tab?.proposal}
              onChange={(e) =>
                p.tab &&
                setModes({ ...modes, [p.tab.id]: e.target.value as ChatMode })
              }
            >
              <option value="chat">{t("ai:chat")}</option>
              <option value="confirm" disabled={!profile?.toolsEnabled}>
                {t("ai:confirmMode")}
              </option>
              <option value="auto" disabled={!profile?.toolsEnabled}>
                {t("ai:automatic")}
              </option>
            </select>
            {p.profiles.length ? (
              <div className="composer-model">
                <span className="status-dot" />
                <select
                  aria-label={t("ai:currentModel")}
                  title={
                    profile
                      ? `${profile.name} · ${profile.model}`
                      : t("ai:selectAiModel")
                  }
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
                <ChevronDown size={12} />
              </div>
            ) : (
              <button className="composer-model-config" onClick={p.onSettings}>
                {t("ai:configureModel")}
                <ArrowUpRight size={12} />
              </button>
            )}
            {busy || automaticActive ? (
              <button
                title={t("ai:stopTask")}
                className="send-button"
                onClick={p.onStop}
              >
                <Square size={14} />
              </button>
            ) : (
              <button
                title={t("ai:sendMessage")}
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
            ? t("ai:runOrRejectThePendingProposalFirst")
            : t("ai:enterToSendShiftEnterForANew")}
        </p>
      </div>
    </aside>
  );
}
