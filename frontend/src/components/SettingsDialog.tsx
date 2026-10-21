import { useState } from "react";
import {
  X,
  Server,
  KeyRound,
  SlidersHorizontal,
  FolderOpen,
  Plus,
  Trash2,
  Check,
  LoaderCircle,
} from "lucide-react";
import { api, errorText } from "../bridge";
import type {
  Session,
  Group,
  APIProfile,
  SessionRequest,
  APIRequest,
  Theme,
  QuickCommandLayout,
} from "../types";
interface Props {
  kind: "session" | "settings";
  session?: Session;
  groups: Group[];
  profiles: APIProfile[];
  fontSize: number;
  theme: Theme;
  onTheme(theme: Theme): void;
  quickCommandLayout: QuickCommandLayout;
  onQuickCommandLayout(layout: QuickCommandLayout): void;
  onClose(): void;
  onSession(req: SessionRequest): Promise<void>;
  onRefresh(): Promise<void>;
  onFont(n: number): void;
}
const emptySession: Session = {
  id: "",
  groupId: "",
  name: "",
  host: "",
  port: 22,
  username: "root",
  authType: "password",
  privateKeyPath: "",
  credentialRef: "",
};
const emptyProfile: APIProfile = {
  id: "",
  name: "自定义 API",
  baseUrl: "https://api.example.com/v1",
  model: "",
  secretRef: "",
  toolsEnabled: true,
};
export default function SettingsDialog(p: Props) {
  const [tab, setTab] = useState(
    p.kind === "session" ? "session" : "appearance",
  );
  const [session, setSession] = useState({ ...emptySession, ...p.session });
  const [secret, setSecret] = useState("");
  const [saveSecret, setSaveSecret] = useState(!!p.session?.credentialRef);
  const [profile, setProfile] = useState<APIProfile>(
    p.profiles[0] ? { ...p.profiles[0] } : { ...emptyProfile },
  );
  const [key, setKey] = useState("");
  const [memoryOnly, setMemoryOnly] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);
  const field = (name: keyof Session, value: string | number) =>
    setSession({ ...session, [name]: value });
  const run = async (fn: () => Promise<void>, message = "") => {
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      await fn();
      setSuccess(message);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const apiRequest = (): APIRequest => ({ profile, key, memoryOnly });
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) p.onClose();
      }}
    >
      <section role="dialog" aria-modal="true" className="settings-dialog">
        <header>
          <div>
            <span className="eyebrow">WORKSPACE SETTINGS</span>
            <h2>
              {p.kind === "session"
                ? p.session
                  ? "编辑会话"
                  : "新建 SSH 会话"
                : "工作空间设置"}
            </h2>
          </div>
          <button title="关闭" disabled={busy} onClick={p.onClose}>
            <X size={19} />
          </button>
        </header>
        {p.kind === "settings" && (
          <nav className="settings-tabs">
            <button
              className={tab === "appearance" ? "active" : ""}
              onClick={() => setTab("appearance")}
            >
              <SlidersHorizontal size={15} />
              外观
            </button>
            <button
              className={tab === "api" ? "active" : ""}
              onClick={() => setTab("api")}
            >
              <KeyRound size={15} />
              AI API
            </button>
          </nav>
        )}
        <div className="settings-body">
          {tab === "session" && (
            <>
              <div className="form-note">
                <Server size={17} />
                <span>保存连接信息，双击会话即可连接服务器。</span>
              </div>
              <label>
                会话名称
                <input
                  value={session.name}
                  onChange={(e) => field("name", e.target.value)}
                  placeholder="例如：香港服务器"
                />
              </label>
              <div className="form-row">
                <label className="flex-grow">
                  主机地址
                  <input
                    autoFocus
                    value={session.host}
                    onChange={(e) => field("host", e.target.value)}
                    placeholder="IP 地址或域名"
                  />
                </label>
                <label className="port-field">
                  端口
                  <input
                    type="number"
                    min="1"
                    max="65535"
                    value={session.port}
                    onChange={(e) => field("port", Number(e.target.value))}
                  />
                </label>
              </div>
              <div className="form-row">
                <label>
                  用户名
                  <input
                    value={session.username}
                    onChange={(e) => field("username", e.target.value)}
                  />
                </label>
                <label>
                  分组
                  <select
                    value={session.groupId}
                    onChange={(e) => field("groupId", e.target.value)}
                  >
                    <option value="">默认分组</option>
                    {p.groups.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label>
                认证方式
                <select
                  value={session.authType}
                  onChange={(e) => {
                    field("authType", e.target.value);
                    setSecret("");
                    setSaveSecret(false);
                  }}
                >
                  <option value="password">密码</option>
                  <option value="key">私钥</option>
                </select>
              </label>
              {session.authType === "key" && (
                <label>
                  私钥文件
                  <div className="input-with-button">
                    <input
                      value={session.privateKeyPath}
                      onChange={(e) => field("privateKeyPath", e.target.value)}
                      placeholder="选择本地私钥文件"
                    />
                    <button
                      title="选择私钥文件"
                      onClick={() =>
                        run(async () => {
                          const path = await api.ChoosePrivateKey();
                          if (path) field("privateKeyPath", path);
                        })
                      }
                    >
                      <FolderOpen size={17} />
                    </button>
                  </div>
                </label>
              )}
              <label>
                {session.authType === "key" ? "私钥口令（可留空）" : "登录密码"}
                <input
                  type="password"
                  autoComplete="new-password"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  placeholder={
                    session.credentialRef
                      ? "已保存凭据，留空保持不变"
                      : "不保存时可在连接时输入"
                  }
                />
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={saveSecret}
                  onChange={(e) => setSaveSecret(e.target.checked)}
                />
                保存到 Windows 凭据管理器
              </label>
              <p className="muted small">
                密码和私钥口令不会写入普通配置文件。
              </p>
            </>
          )}
          {tab === "api" && (
            <>
              <div className="api-presets">
                <select
                  aria-label="API 配置"
                  value={profile.id}
                  onChange={(e) => {
                    setProfile({
                      ...p.profiles.find((v) => v.id === e.target.value)!,
                    });
                    setKey("");
                    setError("");
                    setSuccess("");
                  }}
                >
                  {!profile.id && <option value="">新配置</option>}
                  {p.profiles.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </select>
                <button
                  title="新建 API 配置"
                  onClick={() => {
                    setProfile({ ...emptyProfile });
                    setKey("");
                    setSuccess("");
                  }}
                >
                  <Plus size={17} />
                </button>
                {profile.id && (
                  <button
                    title="删除 API 配置"
                    onClick={() => {
                      if (confirm("删除此 API 配置及其保存的密钥？"))
                        run(async () => {
                          await api.DeleteAPI(profile.id);
                          await p.onRefresh();
                          setProfile({ ...emptyProfile });
                          setKey("");
                        });
                    }}
                  >
                    <Trash2 size={16} />
                  </button>
                )}
              </div>
              <div className="form-note">
                <KeyRound size={17} />
                <span>OpenAI 兼容接口</span>
              </div>
              <label>
                配置名称
                <input
                  value={profile.name}
                  onChange={(e) =>
                    setProfile({ ...profile, name: e.target.value })
                  }
                />
              </label>
              <label>
                Base URL
                <input
                  value={profile.baseUrl}
                  onChange={(e) =>
                    setProfile({ ...profile, baseUrl: e.target.value })
                  }
                  placeholder="https://your-api.com/v1"
                />
              </label>
              <label>
                API Key
                <input
                  type="password"
                  autoComplete="new-password"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder={
                    profile.secretRef
                      ? "已保存密钥，留空保持不变"
                      : "sk-…（本地无鉴权服务可留空）"
                  }
                />
              </label>
              <label>
                模型名称
                <input
                  value={profile.model}
                  onChange={(e) =>
                    setProfile({ ...profile, model: e.target.value })
                  }
                  placeholder="填写接口提供的模型 ID"
                />
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={profile.toolsEnabled}
                  onChange={(e) =>
                    setProfile({ ...profile, toolsEnabled: e.target.checked })
                  }
                />
                启用工具调用（AI 操作服务器）
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={memoryOnly}
                  onChange={(e) => setMemoryOnly(e.target.checked)}
                />
                密钥仅本次使用
              </label>
              <p className="muted small">
                不支持工具调用的接口可关闭此项，使用普通对话。远程地址使用
                HTTPS，本机服务可使用 HTTP。
              </p>
            </>
          )}
          {tab === "appearance" && (
            <>
              <div className="form-note">
                <SlidersHorizontal size={17} />
                <span>主题与终端设置会应用到整个工作空间。</span>
              </div>
              <label>
                主题
                <select
                  value={p.theme}
                  onChange={(e) => p.onTheme(e.target.value as Theme)}
                >
                  <option value="dark">深色</option>
                  <option value="light">浅色</option>
                </select>
              </label>
              <label>
                快速命令栏布局
                <select aria-label="快速命令栏布局" value={p.quickCommandLayout} onChange={(e) => p.onQuickCommandLayout(e.target.value as QuickCommandLayout)}>
                  <option value="single">单行横向滚动（默认）</option>
                  <option value="multi">多行自动换行</option>
                </select>
              </label>
              <label>
                字体大小
                <div className="font-control">
                  <input
                    type="range"
                    min="11"
                    max="24"
                    value={p.fontSize}
                    onChange={(e) => p.onFont(Number(e.target.value))}
                  />
                  <span>{p.fontSize} px</span>
                </div>
              </label>
              <div className="terminal-sample">
                <span>root@server</span>:<b>~</b>$ systemctl status redis
                <br />
                <i>● redis.service — Ready to accept connections</i>
                <br />
                OpenShell · 中文终端预览
              </div>
              <p className="muted small">
                终端采用系统等宽字体，支持 UTF-8、256 色和 10,000 行滚动历史。
              </p>
            </>
          )}
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
          {success && (
            <div className="form-success">
              <Check size={15} />
              {success}
            </div>
          )}
        </div>
        <footer>
          <button className="secondary" disabled={busy} onClick={p.onClose}>
            关闭
          </button>
          <div>
            {tab === "api" && (
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  run(() => api.TestAPI(apiRequest()), "连接成功，模型已响应")
                }
              >
                测试连接
              </button>
            )}
            {tab === "session" && (
              <button
                className="primary"
                disabled={busy}
                onClick={() => {
                  if (!session.host.trim() || !session.username.trim()) {
                    setError("请填写主机地址和用户名");
                    return;
                  }
                  if (session.port < 1 || session.port > 65535) {
                    setError("端口必须在 1–65535 之间");
                    return;
                  }
                  if (session.authType === "key" && !session.privateKeyPath) {
                    setError("请选择私钥文件");
                    return;
                  }
                  run(async () => {
                    await p.onSession({ session, secret, saveSecret });
                    p.onClose();
                  });
                }}
              >
                {busy ? <LoaderCircle size={15} className="spin" /> : null}
                保存会话
              </button>
            )}
            {tab === "api" && (
              <button
                className="primary"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    const saved = await api.SaveAPI(apiRequest());
                    setProfile(saved);
                    setKey("");
                    await p.onRefresh();
                  }, "配置已保存")
                }
              >
                {busy ? <LoaderCircle size={15} className="spin" /> : null}
                保存配置
              </button>
            )}
            {tab === "appearance" && (
              <button
                className="primary"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await api.SavePreference("fontSize", String(p.fontSize));
                    await api.SavePreference("theme", p.theme);
                    await api.SavePreference("quickCommandLayout", p.quickCommandLayout);
                  }, "外观已保存")
                }
              >
                保存外观
              </button>
            )}
          </div>
        </footer>
      </section>
    </div>
  );
}
