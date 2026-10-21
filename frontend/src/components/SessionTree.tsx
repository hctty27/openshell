import { useState } from "react";
import {
  Search,
  Plus,
  FolderPlus,
  Folder,
  Server,
  MoreHorizontal,
  ChevronDown,
  Terminal,
  Settings,
  Network,
} from "lucide-react";
import type { Session, Group } from "../types";
interface Props {
  sessions: Session[];
  groups: Group[];
  active: string;
  onOpen(s: Session): void;
  onEdit(s?: Session): void;
  onDelete(s: Session): void;
  onGroup(): void;
  onRenameGroup(g: Group): void;
  onDeleteGroup(g: Group): void;
  onSettings(): void;
}
export default function SessionTree(p: Props) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState("");
  const [selected, setSelected] = useState<{ kind: "root" | "group" | "session"; id: string }>({
    kind: "root",
    id: "",
  });
  const [rootCollapsed, setRootCollapsed] = useState(false);
  const [detailsHeight, setDetailsHeight] = useState(244);
  const visible = p.sessions.filter((s) =>
    [s.name, s.host, s.username].some((v) =>
      v.toLowerCase().includes(query.toLowerCase()),
    ),
  );
  const groups = [{ id: "", name: "默认分组" }, ...p.groups];
  const selectedSession = selected.kind === "session"
    ? p.sessions.find((session) => session.id === selected.id)
    : undefined;
  const selectedGroup = selected.kind === "group"
    ? groups.find((group) => group.id === selected.id)
    : undefined;
  const detailsName = selectedSession?.name ?? selectedGroup?.name ?? "所有会话";
  const detailsRows: [string, string][] = selectedSession
    ? [
        ["名称", selectedSession.name],
        ["类型", "SSH 会话"],
        ["主机", selectedSession.host],
        ["端口", String(selectedSession.port)],
        ["协议", "SSH"],
        ["用户名", selectedSession.username],
        ["认证方式", selectedSession.authType === "key" ? "密钥" : "密码"],
        ["所属分组", groups.find((g) => g.id === selectedSession.groupId)?.name ?? "默认分组"],
      ]
    : [
        ["名称", detailsName],
        ["类型", selectedGroup ? "文件夹" : "会话目录"],
        ["子会话", String(selectedGroup
          ? p.sessions.filter((s) => s.groupId === selectedGroup.id).length
          : p.sessions.length)],
      ];
  const resizeDetails = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const start = event.clientY;
    const height = detailsHeight;
    const move = (e: PointerEvent) =>
      setDetailsHeight(Math.max(170, Math.min(440, height + start - e.clientY)));
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  };
  return (
    <aside className="session-sidebar">
      <div className="brand">
        <span className="brand-icon">
          <Terminal size={19} />
        </span>
        <strong>
          OpenShell<span>WORKSPACE</span>
        </strong>
        <span className="version">0.1</span>
      </div>
      <div className="sidebar-heading">
        <span>会话管理</span>
        <div>
          <button title="新建分组" onClick={p.onGroup}>
            <FolderPlus size={16} />
          </button>
          <button title="新建会话" onClick={() => p.onEdit()}>
            <Plus size={18} />
          </button>
        </div>
      </div>
      <div className="search">
        <Search size={15} />
        <input
          placeholder="搜索会话…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="session-list">
        <div className={"tree-root" + (selected.kind === "root" ? " selected" : "")}>
          <button
            className="tree-toggle"
            title={rootCollapsed ? "展开所有会话" : "折叠所有会话"}
            onClick={() => setRootCollapsed((value) => !value)}
          >
            <ChevronDown size={14} className={rootCollapsed ? "rotated" : ""} />
          </button>
          <button
            className="tree-root-label"
            aria-pressed={selected.kind === "root"}
            onClick={() => { setSelected({ kind: "root", id: "" }); setMenu(""); }}
          >
            <Folder size={15} />
            <span>所有会话</span>
          </button>
          <small>{visible.length}</small>
        </div>
        {(!rootCollapsed || !!query) && (
          <div className="tree-groups">
            {groups.filter((g) => !query || visible.some((s) => s.groupId === g.id)).map((g) => (
              <div key={g.id} className="group">
                <div className={"group-heading" + (selected.kind === "group" && selected.id === g.id ? " selected" : "")}>
                  <button
                    className="tree-toggle"
                    title={collapsed[g.id] ? "展开分组 " + g.name : "折叠分组 " + g.name}
                    onClick={() => setCollapsed((old) => ({ ...old, [g.id]: !old[g.id] }))}
                  >
                    <ChevronDown
                      size={13}
                      className={collapsed[g.id] ? "rotated" : ""}
                    />
                  </button>
                  <button
                    className="group-select"
                    aria-label={"选中分组 " + g.name}
                    aria-pressed={selected.kind === "group" && selected.id === g.id}
                    onClick={() => {
                      setSelected({ kind: "group", id: g.id });
                      setMenu("");
                    }}
                  >
                    <Folder size={14} />
                    <span>{g.name}</span>
                    <small>{visible.filter((s) => s.groupId === g.id).length}</small>
                  </button>
                  {g.id && (
                    <button
                      title={`管理分组 ${g.name}`}
                      onClick={() => setMenu(menu === `g${g.id}` ? "" : `g${g.id}`)}
                    >
                      <MoreHorizontal size={15} />
                    </button>
                  )}
                </div>
                {menu === `g${g.id}` && (
                  <div className="row-menu">
                    <button
                      onClick={() => {
                        p.onRenameGroup(g);
                        setMenu("");
                      }}
                    >
                      重命名
                    </button>
                    <button
                      onClick={() => {
                        p.onDeleteGroup(g);
                        setMenu("");
                      }}
                    >
                      删除分组
                    </button>
                  </div>
                )}
                {(!collapsed[g.id] || !!query) &&
                  visible
                    .filter((s) => s.groupId === g.id)
                    .map((s) => (
                      <div
                        key={s.id}
                        className={"session-row" + (selected.kind === "session" && selected.id === s.id ? " selected" : "") + (p.active === s.id ? " active" : "")}
                      >
                        <button
                          className="session-open"
                          title={"双击连接 " + s.name}
                          aria-label={"选中会话 " + s.name}
                          aria-pressed={selected.kind === "session" && selected.id === s.id}
                          onDoubleClick={() => p.onOpen(s)}
                          onClick={() => {
                            setSelected({ kind: "session", id: s.id });
                            setMenu("");
                          }}
                        >
                          <Server size={15} />
                          <span>
                            <strong>{s.name}</strong>
                            <small>
                              {s.username}@{s.host}:{s.port}
                            </small>
                          </span>
                        </button>
                        <button
                          title={`管理 ${s.name}`}
                          onClick={() => setMenu(menu === s.id ? "" : s.id)}
                        >
                          <MoreHorizontal size={16} />
                        </button>
                        {menu === s.id && (
                          <div className="row-menu">
                            <button
                              onClick={() => {
                                p.onOpen(s);
                                setMenu("");
                              }}
                            >
                              连接
                            </button>
                            <button
                              onClick={() => {
                                p.onEdit(s);
                                setMenu("");
                              }}
                            >
                              编辑
                            </button>
                            <button
                              className="danger-text"
                              onClick={() => {
                                p.onDelete(s);
                                setMenu("");
                              }}
                            >
                              删除
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
              </div>
            ))}
            {!p.sessions.length && (
              <div className="sidebar-empty">
                <Network size={25} />
                <p>添加你的第一台服务器</p>
                <button onClick={() => p.onEdit()}>
                  新建 SSH 会话 <Plus size={13} />
                </button>
          </div>
        )}
        {!!query && !visible.length && p.sessions.length > 0 && (
          <div className="sidebar-empty">没有匹配的会话</div>
        )}
          </div>
        )}
      </div>
      <div
        className="details-resizer"
        role="separator"
        aria-label="调整会话详情高度"
        aria-orientation="horizontal"
        onPointerDown={resizeDetails}
      />
      <section className="session-details" style={{ height: detailsHeight }} data-testid="session-details">
        <div className="details-heading">
          <span>详细信息</span>
          <small>{selectedSession ? "SSH" : selectedGroup ? "文件夹" : "目录"}</small>
        </div>
        <div className="details-body">
          <div className="details-identity">
            {selectedSession ? <Server size={17} /> : <Folder size={17} />}
            <strong title={detailsName}>{detailsName}</strong>
          </div>
          <dl className="details-properties">
            {detailsRows.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd title={value}>{value}</dd>
              </div>
            ))}
          </dl>
        </div>
        {selectedSession && (
          <div className="details-actions">
            <button onClick={() => p.onOpen(selectedSession)}>连接</button>
            <button onClick={() => p.onEdit(selectedSession)}>编辑</button>
          </div>
        )}
      </section>
      <div className="sidebar-footer">
        <span>
          <i className="status-dot" />
          本地工作空间
        </span>
        <button title="设置" onClick={p.onSettings}>
          <Settings size={17} />
        </button>
      </div>
    </aside>
  );
}
