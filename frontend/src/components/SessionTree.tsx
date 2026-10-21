import { useCallback, useState, type KeyboardEvent, type MouseEvent } from "react";
import {
  Search,
  Plus,
  FolderPlus,
  Folder,
  Server,
  Pencil,
  Trash2,
  Plug,
  ChevronDown,
  Settings,
  Network,
} from "lucide-react";
import type { Session, Group } from "../types";
import FloatingContextMenu, { type ContextMenuAction } from "./FloatingContextMenu";
interface Props {
  sessions: Session[];
  groups: Group[];
  active: string;
  onOpen(s: Session): void;
  onEdit(s?: Session): void;
  onCreateInGroup(groupId: string): void;
  onDelete(s: Session): void;
  onGroup(): void;
  onRenameGroup(g: Group): void;
  onDeleteGroup(g: Group): void;
  onSettings(): void;
}
export default function SessionTree(p: Props) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [contextMenu, setContextMenu] = useState<{
    kind: "root" | "group" | "session";
    id: string;
    anchor: HTMLElement;
    x: number;
    y: number;
  } | null>(null);
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
  const closeContextMenu = useCallback(() => setContextMenu(null), []);
  const showContextMenu = (
    kind: "root" | "group" | "session",
    id: string,
    anchor: HTMLElement,
    x: number,
    y: number,
  ) => {
    setSelected({ kind, id });
    setContextMenu({ kind, id, anchor, x, y });
  };
  const openWithMouse = (
    event: MouseEvent<HTMLElement>,
    kind: "root" | "group" | "session",
    id: string,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const anchor = event.currentTarget.querySelector<HTMLButtonElement>(
      ".tree-root-label, .group-select, .session-open",
    ) ?? event.currentTarget;
    showContextMenu(kind, id, anchor, event.clientX, event.clientY);
  };
  const openWithKeyboard = (
    event: KeyboardEvent<HTMLButtonElement>,
    kind: "root" | "group" | "session",
    id: string,
  ) => {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    event.preventDefault();
    event.stopPropagation();
    const bounds = event.currentTarget.getBoundingClientRect();
    showContextMenu(kind, id, event.currentTarget, bounds.left + 20, bounds.bottom);
  };
  const targetGroup = groups.find((group) => group.id === contextMenu?.id);
  const targetSession = p.sessions.find((session) => session.id === contextMenu?.id);
  const menuItems: ContextMenuAction[] = contextMenu?.kind === "root" ? [
    { label: "新建 SSH 会话", icon: Plus, onSelect: () => p.onEdit() },
    { label: "新建分组", icon: FolderPlus, onSelect: p.onGroup },
  ] : contextMenu?.kind === "group" && targetGroup ? [
    { label: "新建 SSH 会话", icon: Plus, onSelect: () => p.onCreateInGroup(targetGroup.id) },
    ...(targetGroup.id ? [
      { label: "重命名", icon: Pencil, separatorBefore: true, onSelect: () => p.onRenameGroup(targetGroup) },
      { label: "删除分组", icon: Trash2, danger: true, onSelect: () => p.onDeleteGroup(targetGroup) },
    ] : []),
  ] : contextMenu?.kind === "session" && targetSession ? [
    { label: "连接", icon: Plug, onSelect: () => p.onOpen(targetSession) },
    { label: "编辑会话", icon: Pencil, onSelect: () => p.onEdit(targetSession) },
    { label: "删除会话", icon: Trash2, separatorBefore: true, danger: true, onSelect: () => p.onDelete(targetSession) },
  ] : [];
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
        <img className="brand-icon" src="/app-icon.svg" alt="OpenShell" />
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
        <div className={"tree-root" + (selected.kind === "root" ? " selected" : "")}
          onContextMenu={(event) => openWithMouse(event, "root", "")}>
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
            onKeyDown={(event) => openWithKeyboard(event, "root", "")}
            onClick={() => { setSelected({ kind: "root", id: "" }); closeContextMenu(); }}
          >
            <Folder size={15} />
            <span>所有会话</span>
          </button>
        </div>
        {(!rootCollapsed || !!query) && (
          <div className="tree-groups">
            {groups.filter((g) => !query || visible.some((s) => s.groupId === g.id)).map((g) => (
              <div key={g.id} className="group">
                <div className={"group-heading" + (selected.kind === "group" && selected.id === g.id ? " selected" : "")}
                  onContextMenu={(event) => openWithMouse(event, "group", g.id)}>
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
                    onKeyDown={(event) => openWithKeyboard(event, "group", g.id)}
                    onClick={() => {
                      setSelected({ kind: "group", id: g.id });
                      closeContextMenu();
                    }}
                  >
                    <Folder size={14} />
                    <span>{g.name}</span>
                  </button>
                </div>
                {(!collapsed[g.id] || !!query) &&
                  visible
                    .filter((s) => s.groupId === g.id)
                    .map((s) => (
                      <div
                        key={s.id}
                        className={"session-row" + (selected.kind === "session" && selected.id === s.id ? " selected" : "") + (p.active === s.id ? " active" : "")}
                        onContextMenu={(event) => openWithMouse(event, "session", s.id)}
                      >
                        <button
                          className="session-open"
                          title={"双击连接 " + s.name}
                          aria-label={"选中会话 " + s.name}
                          aria-pressed={selected.kind === "session" && selected.id === s.id}
                          onKeyDown={(event) => openWithKeyboard(event, "session", s.id)}
                          onDoubleClick={() => p.onOpen(s)}
                          onClick={() => {
                            setSelected({ kind: "session", id: s.id });
                            closeContextMenu();
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
      {contextMenu && menuItems.length > 0 && (
        <FloatingContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          anchor={contextMenu.anchor}
          items={menuItems}
          onClose={closeContextMenu}
        />
      )}
    </aside>
  );
}
