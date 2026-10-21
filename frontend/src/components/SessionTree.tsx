import { t } from "../i18n";
import { useTranslation } from "react-i18next";
import {
  useCallback,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
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
import FloatingContextMenu, {
  type ContextMenuAction,
} from "./FloatingContextMenu";
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
  useTranslation();
  const settingsTitle = t("common:settings");
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [contextMenu, setContextMenu] = useState<{
    kind: "root" | "group" | "session";
    id: string;
    anchor: HTMLElement;
    x: number;
    y: number;
  } | null>(null);
  const [selected, setSelected] = useState<{
    kind: "root" | "group" | "session";
    id: string;
  }>({
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
  const groups = [{ id: "", name: t("common:defaultFolder") }, ...p.groups];
  const selectedSession =
    selected.kind === "session"
      ? p.sessions.find((session) => session.id === selected.id)
      : undefined;
  const selectedGroup =
    selected.kind === "group"
      ? groups.find((group) => group.id === selected.id)
      : undefined;
  const detailsName =
    selectedSession?.name ?? selectedGroup?.name ?? t("sessions:allSessions");
  const detailsRows: [string, string][] = selectedSession
    ? [
        [t("common:name"), selectedSession.name],
        [t("common:type"), t("common:sshSession")],
        [t("common:host2"), selectedSession.host],
        [t("common:port"), String(selectedSession.port)],
        [t("common:protocol"), "SSH"],
        [t("common:username"), selectedSession.username],
        [
          t("common:authentication"),
          selectedSession.authType === "key"
            ? t("common:key")
            : t("common:password2"),
        ],
        [
          t("common:folder2"),
          groups.find((g) => g.id === selectedSession.groupId)?.name ??
            t("common:defaultFolder"),
        ],
      ]
    : [
        [t("common:name"), detailsName],
        [
          t("common:type"),
          selectedGroup ? t("common:folder3") : t("sessions:sessionDirectory"),
        ],
        [
          t("sessions:sessions"),
          String(
            selectedGroup
              ? p.sessions.filter((s) => s.groupId === selectedGroup.id).length
              : p.sessions.length,
          ),
        ],
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
    const anchor =
      event.currentTarget.querySelector<HTMLButtonElement>(
        ".tree-root-label, .group-select, .session-open",
      ) ?? event.currentTarget;
    showContextMenu(kind, id, anchor, event.clientX, event.clientY);
  };
  const openWithKeyboard = (
    event: KeyboardEvent<HTMLButtonElement>,
    kind: "root" | "group" | "session",
    id: string,
  ) => {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10"))
      return;
    event.preventDefault();
    event.stopPropagation();
    const bounds = event.currentTarget.getBoundingClientRect();
    showContextMenu(
      kind,
      id,
      event.currentTarget,
      bounds.left + 20,
      bounds.bottom,
    );
  };
  const targetGroup = groups.find((group) => group.id === contextMenu?.id);
  const targetSession = p.sessions.find(
    (session) => session.id === contextMenu?.id,
  );
  const menuItems: ContextMenuAction[] =
    contextMenu?.kind === "root"
      ? [
          {
            label: t("common:newSshSession"),
            icon: Plus,
            onSelect: () => p.onEdit(),
          },
          {
            label: t("common:newFolder"),
            icon: FolderPlus,
            onSelect: p.onGroup,
          },
        ]
      : contextMenu?.kind === "group" && targetGroup
        ? [
            {
              label: t("common:newSshSession"),
              icon: Plus,
              onSelect: () => p.onCreateInGroup(targetGroup.id),
            },
            ...(targetGroup.id
              ? [
                  {
                    label: t("common:rename"),
                    icon: Pencil,
                    separatorBefore: true,
                    onSelect: () => p.onRenameGroup(targetGroup),
                  },
                  {
                    label: t("common:deleteFolder"),
                    icon: Trash2,
                    danger: true,
                    onSelect: () => p.onDeleteGroup(targetGroup),
                  },
                ]
              : []),
          ]
        : contextMenu?.kind === "session" && targetSession
          ? [
              {
                label: t("common:connect"),
                icon: Plug,
                onSelect: () => p.onOpen(targetSession),
              },
              {
                label: t("common:editSession"),
                icon: Pencil,
                onSelect: () => p.onEdit(targetSession),
              },
              {
                label: t("common:deleteSession"),
                icon: Trash2,
                separatorBefore: true,
                danger: true,
                onSelect: () => p.onDelete(targetSession),
              },
            ]
          : [];
  const resizeDetails = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const start = event.clientY;
    const height = detailsHeight;
    const move = (e: PointerEvent) =>
      setDetailsHeight(
        Math.max(170, Math.min(440, height + start - e.clientY)),
      );
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
          OpenShell<span>{t("common:workspaceLabel")}</span>
        </strong>
        <span className="version">0.1</span>
      </div>
      <div className="sidebar-heading">
        <span>{t("common:sessions")}</span>
        <div>
          <button title={t("common:newFolder")} onClick={p.onGroup}>
            <FolderPlus size={16} />
          </button>
          <button title={t("common:newSession")} onClick={() => p.onEdit()}>
            <Plus size={18} />
          </button>
        </div>
      </div>
      <div className="search">
        <Search size={15} />
        <input
          placeholder={t("sessions:searchSessions2")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="session-list">
        <div
          className={
            "tree-root" + (selected.kind === "root" ? " selected" : "")
          }
          onContextMenu={(event) => openWithMouse(event, "root", "")}
        >
          <button
            className="tree-toggle"
            title={
              rootCollapsed
                ? t("sessions:expandAllSessions")
                : t("sessions:collapseAllSessions")
            }
            onClick={() => setRootCollapsed((value) => !value)}
          >
            <ChevronDown size={14} className={rootCollapsed ? "rotated" : ""} />
          </button>
          <button
            className="tree-root-label"
            aria-pressed={selected.kind === "root"}
            onKeyDown={(event) => openWithKeyboard(event, "root", "")}
            onClick={() => {
              setSelected({ kind: "root", id: "" });
              closeContextMenu();
            }}
          >
            <Folder size={15} />
            <span>{t("sessions:allSessions")}</span>
          </button>
        </div>
        {(!rootCollapsed || !!query) && (
          <div className="tree-groups">
            {groups
              .filter((g) => !query || visible.some((s) => s.groupId === g.id))
              .map((g) => (
                <div key={g.id} className="group">
                  <div
                    className={
                      "group-heading" +
                      (selected.kind === "group" && selected.id === g.id
                        ? " selected"
                        : "")
                    }
                    onContextMenu={(event) =>
                      openWithMouse(event, "group", g.id)
                    }
                  >
                    <button
                      className="tree-toggle"
                      title={
                        collapsed[g.id]
                          ? t("sessions:expandFolder") + g.name
                          : t("sessions:collapseFolder") + g.name
                      }
                      onClick={() =>
                        setCollapsed((old) => ({ ...old, [g.id]: !old[g.id] }))
                      }
                    >
                      <ChevronDown
                        size={13}
                        className={collapsed[g.id] ? "rotated" : ""}
                      />
                    </button>
                    <button
                      className="group-select"
                      aria-label={t("sessions:selectFolder") + g.name}
                      aria-pressed={
                        selected.kind === "group" && selected.id === g.id
                      }
                      onKeyDown={(event) =>
                        openWithKeyboard(event, "group", g.id)
                      }
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
                          className={
                            "session-row" +
                            (selected.kind === "session" && selected.id === s.id
                              ? " selected"
                              : "") +
                            (p.active === s.id ? " active" : "")
                          }
                          onContextMenu={(event) =>
                            openWithMouse(event, "session", s.id)
                          }
                        >
                          <button
                            className="session-open"
                            title={t("sessions:doubleClickToConnect") + s.name}
                            aria-label={t("sessions:selectSession2") + s.name}
                            aria-pressed={
                              selected.kind === "session" &&
                              selected.id === s.id
                            }
                            onKeyDown={(event) =>
                              openWithKeyboard(event, "session", s.id)
                            }
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
                <p>{t("sessions:addYourFirstServer")}</p>
                <button onClick={() => p.onEdit()}>
                  {t("common:newSshSession")}
                  <Plus size={13} />
                </button>
              </div>
            )}
            {!!query && !visible.length && p.sessions.length > 0 && (
              <div className="sidebar-empty">
                {t("sessions:noMatchingSessions2")}
              </div>
            )}
          </div>
        )}
      </div>
      <div
        className="details-resizer"
        role="separator"
        aria-label={t("sessions:resizeSessionDetails")}
        aria-orientation="horizontal"
        onPointerDown={resizeDetails}
      />
      <section
        className="session-details"
        style={{ height: detailsHeight }}
        data-testid="session-details"
      >
        <div className="details-heading">
          <span>{t("common:details")}</span>
          <small>
            {selectedSession
              ? "SSH"
              : selectedGroup
                ? t("common:folder3")
                : t("common:directory")}
          </small>
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
          {t("sessions:localWorkspace")}
        </span>
        <button title={settingsTitle} onClick={p.onSettings}>
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
