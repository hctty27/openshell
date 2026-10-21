import { useEffect, useId, useRef, useState } from "react";
import {
  Folder,
  FolderOpen,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Server,
  Trash2,
  X,
} from "lucide-react";
import type { Group, Session } from "../types";

interface Props {
  sessions: Session[];
  groups: Group[];
  openedSessionIds: string[];
  onConnect(session: Session): void;
  onOpenNewTab(session: Session): void;
  onEdit(session: Session): void;
  onDelete(session: Session): void;
  onNew(): void;
  onNewGroup(): void;
  onClose(): void;
}

interface ContextMenu {
  session: Session;
  x: number;
  y: number;
}

export default function SessionPicker(p: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const [query, setQuery] = useState("");
  const [groupId, setGroupId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    searchRef.current?.focus();
    return () => {
      if (dialog.open && typeof dialog.close === "function") dialog.close();
    };
  }, []);

  const term = query.trim().toLocaleLowerCase();
  const visible = p.sessions.filter((session) => {
    const matches = [session.name, session.host, session.username, String(session.port)]
      .some((value) => value.toLocaleLowerCase().includes(term));
    return matches && (term !== "" || groupId === null || session.groupId === groupId);
  });
  const selected = visible.find((session) => session.id === selectedId);
  const groups = [{ id: "", name: "默认分组" }, ...p.groups];
  const opened = new Set(p.openedSessionIds);

  const openContextMenu = (event: React.MouseEvent, session: Session) => {
    event.preventDefault();
    const bounds = dialogRef.current?.getBoundingClientRect();
    const x = event.clientX - (bounds?.left ?? 0);
    const y = event.clientY - (bounds?.top ?? 0);
    setSelectedId(session.id);
    setContextMenu({
      session,
      x: Math.max(8, Math.min(x, (bounds?.width ?? 720) - 188)),
      y: Math.max(8, Math.min(y, (bounds?.height ?? 480) - 155)),
    });
  };

  return (
    <dialog
      ref={dialogRef}
      className="session-picker"
      aria-labelledby={titleId}
      aria-modal="true"
      onCancel={(event) => {
        event.preventDefault();
        p.onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) p.onClose();
        else if (contextMenu && !(event.target as HTMLElement).closest(".session-picker__menu")) {
          setContextMenu(null);
        }
      }}
    >
      <header className="session-picker__header">
        <div className="session-picker__heading">
          <Server size={19} />
          <h2 id={titleId}>会话管理</h2>
        </div>
        <button type="button" aria-label="关闭会话管理" title="关闭" onClick={p.onClose}>
          <X size={18} />
        </button>
      </header>
      <div className="session-picker__toolbar">
        <label className="session-picker__search">
          <Search size={16} aria-hidden="true" />
          <input
            ref={searchRef}
            aria-label="搜索会话"
            placeholder="搜索名称、主机地址、用户名或端口"
            value={query}
            autoComplete="off"
            onChange={(event) => {
              setQuery(event.target.value);
              setSelectedId("");
              setContextMenu(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && selected) {
                event.preventDefault();
                p.onConnect(selected);
              }
            }}
          />
        </label>
        <button type="button" className="session-picker__new-folder" title="新建分组" aria-label="新建分组" onClick={p.onNewGroup}>
          <Plus size={14} />
          新建分组
        </button>
      </div>
      <div className="session-picker__main">
        <nav className="session-picker__folders" aria-label="会话分组">
          <button
            type="button"
            className={groupId === null ? "active" : ""}
            aria-pressed={groupId === null}
            onClick={() => {
              setGroupId(null);
              setSelectedId("");
              setContextMenu(null);
            }}
          >
            <FolderOpen size={16} />
            <span>所有会话</span>
            <small>{p.sessions.length}</small>
          </button>
          {groups.map((group) => (
            <button
              type="button"
              key={group.id}
              className={groupId === group.id ? "active" : ""}
              aria-pressed={groupId === group.id}
              onClick={() => {
                setGroupId(group.id);
                setSelectedId("");
                setContextMenu(null);
              }}
            >
              <Folder size={15} />
              <span>{group.name}</span>
              <small>{p.sessions.filter((session) => session.groupId === group.id).length}</small>
            </button>
          ))}
        </nav>
        <div className="session-picker__list">
          <div className="session-picker__columns" aria-hidden="true">
            <span>名称</span>
            <span>主机地址</span>
            <span>用户名</span>
            <span>端口</span>
          </div>
          <div className="session-picker__rows" role="list" aria-label="SSH 会话列表">
            {visible.map((session) => (
              <div key={session.id} role="listitem" className="session-picker__item">
                <button
                  type="button"
                  className={"session-picker__row" + (selectedId === session.id ? " selected" : "")}
                  aria-label={"选择会话 " + session.name}
                  aria-pressed={selectedId === session.id}
                  title={"双击连接 " + session.name}
                  onClick={() => setSelectedId(session.id)}
                  onDoubleClick={() => p.onConnect(session)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      p.onConnect(session);
                    }
                  }}
                  onContextMenu={(event) => openContextMenu(event, session)}
                >
                  <span className="session-picker__name">
                    <Server size={15} />
                    <span>{session.name}</span>
                    {opened.has(session.id) && <i className="session-picker__opened" title="已打开" />}
                  </span>
                  <span title={session.host}>{session.host}</span>
                  <span title={session.username}>{session.username}</span>
                  <span>{session.port}</span>
                </button>
                <button
                  type="button"
                  className="session-picker__more"
                  aria-label={"更多操作 " + session.name}
                  title="更多操作"
                  onClick={(event) => {
                    if (contextMenu?.session.id === session.id) {
                      setContextMenu(null);
                      return;
                    }
                    const bounds = dialogRef.current?.getBoundingClientRect();
                    const rect = event.currentTarget.getBoundingClientRect();
                    setSelectedId(session.id);
                    setContextMenu({
                      session,
                      x: Math.max(8, Math.min(rect.right - (bounds?.left ?? 0) - 180, (bounds?.width ?? 720) - 188)),
                      y: Math.max(8, Math.min(rect.bottom - (bounds?.top ?? 0), (bounds?.height ?? 480) - 155)),
                    });
                  }}
                >
                  <MoreHorizontal size={16} />
                </button>
              </div>
            ))}
            {!visible.length && (
              <div className="session-picker__empty">
                <Server size={25} />
                <p>{p.sessions.length === 0 ? "还没有保存的 SSH 会话" : "没有找到匹配的会话"}</p>
                <span>{p.sessions.length === 0 ? "点击下方「新建」添加服务器" : "试试其他关键词或文件夹"}</span>
              </div>
            )}
          </div>
        </div>
      </div>
      {contextMenu && (
        <div className="session-picker__menu" role="menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
          <button type="button" role="menuitem" onClick={() => p.onConnect(contextMenu.session)}>
            <Server size={14} />连接
          </button>
          <button type="button" role="menuitem" onClick={() => p.onOpenNewTab(contextMenu.session)}>
            <Plus size={14} />在新标签中打开
          </button>
          <button type="button" role="menuitem" onClick={() => p.onEdit(contextMenu.session)}>
            <Pencil size={14} />编辑
          </button>
          <button type="button" role="menuitem" className="danger" onClick={() => { setContextMenu(null); p.onDelete(contextMenu.session); }}>
            <Trash2 size={14} />删除
          </button>
        </div>
      )}
      <footer className="session-picker__footer">
        <span>双击会话连接，或选中后按 Enter</span>
        <div>
          <button type="button" className="secondary" onClick={p.onNew}>
            <Plus size={15} />新建
          </button>
          <button type="button" className="secondary" onClick={p.onClose}>取消</button>
          <button type="button" className="primary" disabled={!selected} onClick={() => selected && p.onConnect(selected)}>
            连接
          </button>
        </div>
      </footer>
    </dialog>
  );
}
