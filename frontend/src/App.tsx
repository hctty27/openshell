import { useState, useEffect, useRef } from "react";
import {
  Terminal,
  Plus,
  X,
  PanelRightOpen,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Copy,
  Sparkles,
  ArrowRight,
  Server,
  ShieldCheck,
  LoaderCircle,
  AlertCircle,
  FolderOpen,
} from "lucide-react";
import { api, desktop, listen, errorText } from "./bridge";
import type {
  Session,
  Group,
  APIProfile,
  AppState,
  Tab,
  Ref,
  HostChallenge,
  ChatMessage,
  SessionRequest,
  ChatRequest,
  Theme,
} from "./types";
import SessionTree from "./components/SessionTree";
import SettingsDialog from "./components/SettingsDialog";
import TerminalPane from "./components/TerminalPane";
import AISidebar from "./components/AISidebar";
const initial: AppState = {
  sessions: [],
  groups: [],
  profiles: [],
  fontSize: "14",
  activeProfile: "",
  version: "0.1.6",
};
const id = () => crypto.randomUUID();
export default function App() {
  const [state, setState] = useState(initial),
    [tabs, setTabs] = useState<Tab[]>([]),
    [activeID, setActiveID] = useState(""),
    [showAI, setShowAI] = useState(true),
    [showSessions, setShowSessions] = useState(true),
    [fontSize, setFontSize] = useState(14),
    [theme, setTheme] = useState<Theme>("dark"),
    [profileID, setProfileID] = useState(""),
    [dialog, setDialog] = useState<{
      kind: "session" | "settings";
      session?: Session;
    } | null>(null),
    [toast, setToast] = useState(""),
    [aiWidth, setAIWidth] = useState(370),
    [sessionWidth, setSessionWidth] = useState(235),
    [challenge, setChallenge] = useState<{
      host: HostChallenge;
      tab: Tab;
      secret: string;
    } | null>(null),
    [login, setLogin] = useState<{ tab: Tab; secret: string } | null>(null),
    [preview, setPreview] = useState<{
      tabID: string;
      text: string;
      truncated: boolean;
    } | null>(null),
    [attachments, setAttachments] = useState<Record<string, string>>({});
  const tabsRef = useRef(tabs),
    streamIDs = useRef<Record<string, string>>({}),
    selections = useRef<Record<string, string>>({});
  tabsRef.current = tabs;
  const active = tabs.find((t) => t.id === activeID);
  const update = (tabID: string, fn: (tab: Tab) => Tab) =>
    setTabs((old) => old.map((t) => (t.id === tabID ? fn(t) : t)));
  const notify = (error: unknown) => setToast(errorText(error));
  const refresh = async () => {
    try {
      const data = await api.State();
      setState(data);
      setTheme(data.theme === "light" ? "light" : "dark");
      if (data.fontSize)
        setFontSize(Math.max(11, Math.min(24, Number(data.fontSize) || 14)));
      setProfileID((old) =>
        data.profiles.some((p) => p.id === old)
          ? old
          : data.profiles.some((p) => p.id === data.activeProfile)
            ? data.activeProfile
            : (data.profiles[0]?.id ?? ""),
      );
    } catch (e) {
      if (desktop) notify(e);
    }
  };
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    refresh();
    const off = listen("ssh:disconnected", (ref: Ref) =>
      update(ref.tabId, (t) =>
        t.ref?.generation === ref.generation
          ? {
              ...t,
              status: "disconnected",
              chatBusy: false,
              error: t.error || "连接已断开，请重连",
              proposal: null,
            }
          : t,
      ),
    );
    const end = listen("ssh:terminal-ended", (ref: Ref) =>
      update(ref.tabId, (t) =>
        t.ref?.generation === ref.generation
          ? { ...t, status: "disconnected", error: "终端进程已结束，请重连" }
          : t,
      ),
    );
    const delta = listen("ai:delta", (payload: { ref: Ref; text: string }) => {
      const messageID = streamIDs.current[payload.ref.tabId];
      if (messageID)
        update(payload.ref.tabId, (t) =>
          t.ref?.generation === payload.ref.generation
            ? {
                ...t,
                messages: t.messages.map((m) =>
                  m.id === messageID
                    ? { ...m, text: m.text + payload.text }
                    : m,
                ),
              }
            : t,
        );
    });
    return () => {
      off();
      end();
      delta();
    };
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 7000);
    return () => clearTimeout(timer);
  }, [toast]);
  const connect = async (tab: Tab, secret = "") => {
    update(tab.id, (t) => ({
      ...t,
      status: "connecting",
      error: "",
      proposal: null,
      messages: [],
      chatBusy: false,
    }));
    try {
      const result = await api.Connect(tab.id, tab.session.id, secret);
      if (!tabsRef.current.some((t) => t.id === tab.id)) {
        await api.CloseTab(tab.id);
        return;
      }
      if (result.challenge) {
        setChallenge({ host: result.challenge, tab, secret });
        update(tab.id, (t) => ({
          ...t,
          ref: result.ref,
          status: "disconnected",
        }));
        return;
      }
      update(tab.id, (t) => ({
        ...t,
        ref: result.ref,
        status: "connected",
        home: result.home,
        cwd: result.home,
        error: "",
      }));
    } catch (e) {
      update(tab.id, (t) => ({ ...t, status: "error", error: errorText(e) }));
      notify(e);
    }
  };
  const open = (session: Session) => {
    const tab: Tab = {
      id: id(),
      session,
      ref: null,
      status: "disconnected",
      home: "",
      cwd: "",
      messages: [],
      proposal: null,
      chatBusy: false,
      executing: false,
      error: "",
    };
    setTabs((old) => [...old, tab]);
    setActiveID(tab.id);
    if (session.authType === "password" && !session.credentialRef)
      setLogin({ tab, secret: "" });
    else setTimeout(() => connect(tab), 0);
  };
  const close = async (tab: Tab) => {
    if (
      (tab.chatBusy || tab.executing || tab.proposal) &&
      !confirm(
        "此标签仍有 AI 任务或待处理提议。关闭将停止等待，远端进程可能继续运行。仍要关闭？",
      )
    )
      return;
    try {
      await api.CloseTab(tab.id);
      setTabs((old) => old.filter((t) => t.id !== tab.id));
      if (activeID === tab.id) {
        const rest = tabsRef.current.filter((t) => t.id !== tab.id);
        setActiveID(rest.at(-1)?.id ?? "");
      }
      delete streamIDs.current[tab.id];
      delete selections.current[tab.id];
      setAttachments((old) => {
        const next = { ...old };
        delete next[tab.id];
        return next;
      });
    } catch (e) {
      notify(e);
    }
  };
  const removeSession = async (s: Session) => {
    if (tabs.some((t) => t.session.id === s.id)) {
      notify("请先关闭此会话的终端标签");
      return;
    }
    if (!confirm(`删除会话“${s.name}”？`)) return;
    try {
      await api.DeleteSession(s.id);
      await refresh();
    } catch (e) {
      notify(e);
    }
  };
  const saveSession = async (req: SessionRequest) => {
    try {
      await api.SaveSession(req);
    } finally {
      await refresh();
    }
  };
  const group = async (g?: Group) => {
    const name = prompt(g ? "修改分组名称" : "新建分组名称", g?.name ?? "");
    if (!name?.trim()) return;
    try {
      await api.SaveGroup({ id: g?.id ?? "", name: name.trim() });
      await refresh();
    } catch (e) {
      notify(e);
    }
  };
  const deleteGroup = async (g: Group) => {
    if (!confirm(`删除分组“${g.name}”？会话将移到默认分组。`)) return;
    try {
      await api.DeleteGroup(g.id);
      await refresh();
    } catch (e) {
      notify(e);
    }
  };
  const requestFor = (
    tab: Tab,
    text: string,
    operate: boolean,
    context = "",
  ): ChatRequest => ({
    ref: tab.ref!,
    profileId: profileID,
    text: tab.cwd ? `${text}\n\n当前 AI 工作目录：${tab.cwd}` : text,
    context,
    operate,
  });
  const chat = async (
    tab: Tab,
    text: string,
    operate: boolean,
    context = "",
    continuation = false,
  ) => {
    if (!tab.ref) return;
    const messageID = id();
    streamIDs.current[tab.id] = messageID;
    update(tab.id, (t) => ({
      ...t,
      chatBusy: true,
      messages: [
        ...t.messages,
        ...(continuation ? [] : [{ id: id(), role: "user" as const, text }]),
        { id: messageID, role: "assistant", text: "" },
      ],
      error: "",
    }));
    setAttachments((old) => ({ ...old, [tab.id]: "" }));
    try {
      const response = await (continuation ? api.Continue : api.Chat)(
        requestFor(tab, text, operate, context),
      );
      update(tab.id, (t) =>
        t.ref?.generation === tab.ref?.generation
          ? {
              ...t,
              chatBusy: false,
              messages: t.messages.map((m) =>
                m.id === messageID
                  ? {
                      ...m,
                      text:
                        response.text ||
                        (response.proposal
                          ? "已生成命令提议"
                          : "本次回复未返回文本"),
                    }
                  : m,
              ),
              proposal: response.proposal ?? null,
            }
          : t,
      );
    } catch (e) {
      update(tab.id, (t) => ({
        ...t,
        chatBusy: false,
        messages: t.messages.map((m) =>
          m.id === messageID
            ? { ...m, incomplete: true, text: m.text || errorText(e) }
            : m,
        ),
      }));
      notify(e);
    } finally {
      delete streamIDs.current[tab.id];
    }
  };
  const confirmCommand = async () => {
    if (!active?.proposal) return;
    const tab = active,
      p = active.proposal;
    update(tab.id, (t) => ({ ...t, executing: true }));
    try {
      const result = await api.ConfirmCommand(p.id);
      update(tab.id, (t) => ({
        ...t,
        executing: false,
        proposal: null,
        messages: [
          ...t.messages,
          { id: id(), role: "result", text: "", result },
        ],
      }));
      if (
        result.status !== "unknown" &&
        tabsRef.current.some((t) => t.id === tab.id) &&
        tab.ref
      )
        await chat(tab, "", true, "", true);
    } catch (e) {
      update(tab.id, (t) => ({ ...t, executing: false, proposal: null }));
      notify(e);
    }
  };
  const cancelCommand = async () => {
    if (!active?.proposal) return;
    try {
      await api.CancelCommand(active.proposal.id);
      if (!active.executing)
        update(active.id, (t) => ({
          ...t,
          proposal: null,
          messages: [
            ...t.messages,
            { id: id(), role: "result", text: "已拒绝执行，命令未启动。" },
          ],
        }));
    } catch (e) {
      notify(e);
    }
  };
  const stop = () => {
    if (!active) return;
    if (active.executing) cancelCommand();
    else api.CancelChat(active.id).catch(notify);
  };
  const clear = async () => {
    if (!active) return;
    try {
      await api.ClearChat(active.id);
      update(active.id, (t) => ({ ...t, messages: [], proposal: null }));
    } catch (e) {
      notify(e);
    }
  };
  const previewContext = async () => {
    if (!active?.ref) return;
    try {
      const value = await api.PreviewContext(
        active.ref,
        selections.current[active.id] ?? "",
      );
      setPreview({ tabID: active.id, ...value });
    } catch (e) {
      notify(e);
    }
  };
  const drag = (kind: "ai" | "sessions", event: React.PointerEvent) => {
    const start = event.clientX,
      width = kind === "ai" ? aiWidth : sessionWidth;
    event.currentTarget.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent) => {
      if (kind === "ai")
        setAIWidth(Math.max(310, Math.min(620, width + start - e.clientX)));
      else
        setSessionWidth(
          Math.max(190, Math.min(360, width + e.clientX - start)),
        );
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
  };
  return (
    <div
      className="app"
      style={
        {
          "--session-width": `${sessionWidth}px`,
          "--ai-width": `${aiWidth}px`,
        } as React.CSSProperties
      }
    >
      {showSessions && (
        <>
          <SessionTree
            sessions={state.sessions}
            groups={state.groups}
            active={active?.session.id ?? ""}
            onOpen={open}
            onEdit={(session) => {
              if (session && tabs.some((t) => t.session.id === session.id)) {
                notify("请先关闭此会话的终端标签，再编辑连接信息");
                return;
              }
              setDialog({ kind: "session", session });
            }}
            onDelete={removeSession}
            onGroup={() => group()}
            onRenameGroup={group}
            onDeleteGroup={deleteGroup}
            onSettings={() => setDialog({ kind: "settings" })}
          />
          <div
            className="splitter"
            onPointerDown={(e) => drag("sessions", e)}
          />
        </>
      )}
      <main className="workspace">
        <header className="workspace-header">
          <button
            title={showSessions ? "收起会话" : "展开会话"}
            onClick={() => setShowSessions(!showSessions)}
          >
            {showSessions ? (
              <PanelLeftClose size={17} />
            ) : (
              <PanelLeftOpen size={17} />
            )}
          </button>
          <span className="workspace-label">SSH 终端</span>
          <span className="header-divider" />
          <span className="muted">{active?.session.name ?? "工作空间"}</span>
          <div className="header-right">
            <span className="local-badge">LOCAL</span>
            {!showAI && (
              <button title="展开 AI" onClick={() => setShowAI(true)}>
                <PanelRightOpen size={18} />
              </button>
            )}
          </div>
        </header>
        <div className="tab-strip">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`terminal-tab ${activeID === tab.id ? "active" : ""}`}
            >
              <button onClick={() => setActiveID(tab.id)}>
                <span
                  className={`status-dot ${tab.status === "connected" ? "" : tab.status === "connecting" ? "connecting" : "offline"}`}
                />
                <span>{tab.session.name}</span>
                {tab.status === "connecting" && (
                  <LoaderCircle size={12} className="spin" />
                )}
              </button>
              <button
                title={`关闭 ${tab.session.name}`}
                onClick={() => close(tab)}
              >
                <X size={12} />
              </button>
            </div>
          ))}
          <button
            className="new-tab"
            title="新建会话"
            onClick={() => setDialog({ kind: "session" })}
          >
            <Plus size={16} />
          </button>
        </div>
        {!tabs.length ? (
          <div className="workspace-empty">
            <div className="terminal-emblem">
              <Terminal size={41} strokeWidth={1.3} />
              <span />
            </div>
            <span className="eyebrow">A LIGHTER WAY TO CONNECT</span>
            <h1>连接服务器，开始工作。</h1>
            <p>
              专注的终端，顺手的 AI。
              <br />
              你的会话、模型与操作，都由你掌握。
            </p>
            <button
              className="primary"
              onClick={() => setDialog({ kind: "session" })}
            >
              <Plus size={16} />
              新建 SSH 会话
              <ArrowRight size={15} />
            </button>
            <div className="welcome-features">
              <span>
                <Server size={15} />
                会话管理
              </span>
              <span>
                <Terminal size={15} />
                SSH 终端
              </span>
              <span>
                <Sparkles size={15} />
                自定义 AI
              </span>
            </div>
            <div className="empty-shortcut">从左侧双击会话，快速打开连接</div>
            {!desktop && (
              <div className="preview-notice">
                界面预览 · 真实连接请使用 Windows 桌面应用
              </div>
            )}
          </div>
        ) : (
          <>
            <div className="terminal-toolbar">
              <span>
                <Server size={13} />
                {active?.session.username}@{active?.session.host}:
                {active?.session.port}
              </span>
              <div>
                <button
                  title="重新认证连接"
                  disabled={active?.status === "connecting"}
                  onClick={() =>
                    active && setLogin({ tab: active, secret: "" })
                  }
                >
                  <ShieldCheck size={14} />
                </button>
                <button
                  title="重新连接"
                  disabled={active?.status === "connecting"}
                  onClick={() => active && connect(active)}
                >
                  <RefreshCw size={14} />
                </button>
                <button
                  title="发送选中内容或近期输出给 AI"
                  disabled={active?.status !== "connected"}
                  onClick={() => {
                    setShowAI(true);
                    previewContext();
                  }}
                >
                  <Sparkles size={14} />
                </button>
              </div>
            </div>
            <div className="terminal-container">
              {tabs.map((tab) => (
                <TerminalPane
                  key={tab.id}
                  tab={tab}
                  active={tab.id === activeID}
                  fontSize={fontSize}
                  theme={theme}
                  onError={(text) => {
                    update(tab.id, (t) => ({
                      ...t,
                      status: "error",
                      error: text,
                    }));
                    if (tab.ref) api.Disconnect(tab.ref).catch(() => {});
                    notify(text);
                  }}
                  onSelection={(text) => {
                    selections.current[tab.id] = text;
                  }}
                />
              ))}
              {active?.status === "connecting" && (
                <div className="terminal-overlay">
                  <LoaderCircle size={23} className="spin" />
                  <p>正在连接 {active.session.host}…</p>
                </div>
              )}
              {active?.status !== "connected" &&
                active?.status !== "connecting" && (
                  <div className="terminal-connect-state">
                    <span className="status-dot offline" />
                    <span>{active?.error || "会话未连接"}</span>
                    <button onClick={() => active && connect(active)}>
                      连接
                    </button>
                  </div>
                )}
            </div>
          </>
        )}
        <footer className="workspace-status">
          <span>
            <i
              className={`status-dot ${active?.status === "connected" ? "" : "offline"}`}
            />
            {active?.status === "connected"
              ? "SSH 已连接"
              : active?.status === "connecting"
                ? "连接中"
                : "未连接"}
            {active?.status === "connected" && (
              <>
                <span className="status-sep" />
                UTF-8
                <span className="status-sep" />
                xterm-256color
              </>
            )}
          </span>
          <span>
            OpenShell <span className="status-sep" />
            v0.1.6
          </span>
        </footer>
      </main>
      {showAI && (
        <>
          <div className="splitter" onPointerDown={(e) => drag("ai", e)} />
          <AISidebar
            tab={active}
            profiles={state.profiles}
            profileID={profileID}
            onProfile={(value) => {
              setProfileID(value);
              api.SavePreference("activeProfile", value).catch(notify);
            }}
            onHide={() => setShowAI(false)}
            onSettings={() => setDialog({ kind: "settings" })}
            onSend={(text, operate, context) =>
              active && chat(active, text, operate, context)
            }
            onStop={stop}
            onClear={clear}
            onPreview={previewContext}
            context={active ? (attachments[active.id] ?? "") : ""}
            onClearContext={() =>
              active && setAttachments({ ...attachments, [active.id]: "" })
            }
            onConfirm={confirmCommand}
            onCancel={cancelCommand}
            onRevise={async (command, cwd, seconds) => {
              if (!active?.proposal) return;
              try {
                const p = await api.ReviseProposal(
                  active.proposal.id,
                  command,
                  cwd,
                  seconds,
                );
                update(active.id, (t) => ({ ...t, proposal: p }));
              } catch (e) {
                notify(e);
              }
            }}
          />
        </>
      )}
      {dialog && (
        <SettingsDialog
          key={`${dialog.kind}-${dialog.session?.id ?? ""}`}
          {...dialog}
          groups={state.groups}
          profiles={state.profiles}
          fontSize={fontSize}
          theme={theme}
          onTheme={setTheme}
          onClose={() => setDialog(null)}
          onSession={saveSession}
          onRefresh={refresh}
          onFont={setFontSize}
        />
      )}
      {login && (
        <div className="modal-backdrop">
          <section className="compact-dialog" role="dialog" aria-modal="true">
            <ShieldCheck className="dialog-icon" size={24} />
            <h2>连接 {login.tab.session.name}</h2>
            <p className="muted">
              {login.tab.session.username}@{login.tab.session.host}:
              {login.tab.session.port}
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const value = login;
                setLogin(null);
                connect(value.tab, value.secret);
              }}
            >
              <label>
                {login.tab.session.authType === "key"
                  ? "私钥口令（未加密可留空）"
                  : "登录密码"}
                <input
                  autoFocus
                  type="password"
                  value={login.secret}
                  onChange={(e) =>
                    setLogin({ ...login, secret: e.target.value })
                  }
                />
              </label>
              <p className="small muted">仅用于本次连接，不保存到配置。</p>
              <footer>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setLogin(null)}
                >
                  取消
                </button>
                <button className="primary" type="submit">
                  连接
                </button>
              </footer>
            </form>
          </section>
        </div>
      )}
      {challenge && (
        <div className="modal-backdrop">
          <section className="compact-dialog" role="dialog" aria-modal="true">
            <ShieldCheck className="dialog-icon" size={25} />
            <h2>
              {challenge.host.changed ? "服务器指纹已变化" : "确认服务器指纹"}
            </h2>
            <p className="muted">{challenge.host.address}</p>
            <code className="fingerprint">{challenge.host.fingerprint}</code>
            <p>
              {challenge.host.changed
                ? "连接已阻止。请核验服务器重装或密钥变化原因，第一版不直接覆盖已信任指纹。"
                : "请与服务器管理员或已知记录核对指纹，确认后保存并继续连接。"}
            </p>
            <footer>
              <button className="secondary" onClick={() => setChallenge(null)}>
                取消
              </button>
              {!challenge.host.changed && (
                <button
                  className="primary"
                  onClick={async () => {
                    const value = challenge;
                    setChallenge(null);
                    try {
                      await api.TrustHost(value.host.id);
                      await connect(value.tab, value.secret);
                    } catch (e) {
                      notify(e);
                    }
                  }}
                >
                  信任并连接
                </button>
              )}
            </footer>
          </section>
        </div>
      )}
      {preview && (
        <div className="modal-backdrop">
          <section className="context-dialog" role="dialog" aria-modal="true">
            <header>
              <div>
                <span className="eyebrow">CONTEXT PREVIEW</span>
                <h2>发送终端文本给 AI</h2>
              </div>
              <button title="关闭预览" onClick={() => setPreview(null)}>
                <X size={18} />
              </button>
            </header>
            <p className="muted small">
              仅发送下方文本。常见敏感字段已尝试遮盖，请检查内容。
              {preview.truncated ? "内容已截断。" : ""}
            </p>
            <textarea
              aria-label="终端文本预览"
              value={preview.text}
              onChange={(e) => setPreview({ ...preview, text: e.target.value })}
            />
            <footer>
              <button className="secondary" onClick={() => setPreview(null)}>
                取消
              </button>
              <button
                className="primary"
                onClick={() => {
                  setAttachments((old) => ({
                    ...old,
                    [preview.tabID]: preview.text,
                  }));
                  setShowAI(true);
                  setPreview(null);
                }}
              >
                附加到对话
              </button>
            </footer>
          </section>
        </div>
      )}
      {toast && (
        <div className="toast" role="alert">
          <AlertCircle size={16} />
          <span>{toast}</span>
          <button title="关闭提示" onClick={() => setToast("")}>
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
