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
  const visible = p.sessions.filter((s) =>
    [s.name, s.host, s.username].some((v) =>
      v.toLowerCase().includes(query.toLowerCase()),
    ),
  );
  const groups = [{ id: "", name: "默认分组" }, ...p.groups];
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
        <kbd>/</kbd>
      </div>
      <div className="session-list">
        {groups.map((g) => (
          <div key={g.id} className="group">
            <div className="group-heading">
              <button
                onClick={() =>
                  setCollapsed({ ...collapsed, [g.id]: !collapsed[g.id] })
                }
              >
                <ChevronDown
                  size={13}
                  className={collapsed[g.id] ? "rotated" : ""}
                />
                <Folder size={14} />
                <span>{g.name}</span>
                <small>
                  {visible.filter((s) => s.groupId === g.id).length}
                </small>
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
            {!collapsed[g.id] &&
              visible
                .filter((s) => s.groupId === g.id)
                .map((s) => (
                  <div
                    key={s.id}
                    className={`session-row ${p.active === s.id ? "selected" : ""}`}
                  >
                    <button
                      className="session-open"
                      title="双击连接服务器"
                      onDoubleClick={() => p.onOpen(s)}
                      onClick={() => setMenu("")}
                    >
                      <Server size={17} />
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
      </div>
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
