import { useTranslation } from "react-i18next";
import { t } from "../i18n";
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
  useTranslation();
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
    const matches = [
      session.name,
      session.host,
      session.username,
      String(session.port),
    ].some((value) => value.toLocaleLowerCase().includes(term));
    return (
      matches &&
      (term !== "" || groupId === null || session.groupId === groupId)
    );
  });
  const selected = visible.find((session) => session.id === selectedId);
  const groupLabel = (group: Group) => {
    const parts = [group.name];
    const seen = new Set<string>([group.id]);
    let parent = group.parentId;
    while (parent && !seen.has(parent)) {
      const folder = p.groups.find((item) => item.id === parent);
      if (!folder) break;
      parts.unshift(folder.name);
      seen.add(parent);
      parent = folder.parentId;
    }
    return parts.join(" / ");
  };
  const groups = [{ id: "", name: t("common:defaultFolder") }, ...p.groups.map((group) => ({ ...group, name: groupLabel(group) }))];
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
        else if (
          contextMenu &&
          !(event.target as HTMLElement).closest(".session-picker__menu")
        ) {
          setContextMenu(null);
        }
      }}
    >
      <header className="session-picker__header">
        <div className="session-picker__heading">
          <Server size={19} />
          <h2 id={titleId}>{t("common:sessions")}</h2>
        </div>
        <button
          type="button"
          aria-label={t("sessions:closeSessionManager")}
          title={t("common:close")}
          onClick={p.onClose}
        >
          <X size={18} />
        </button>
      </header>
      <div className="session-picker__toolbar">
        <label className="session-picker__search">
          <Search size={16} aria-hidden="true" />
          <input
            ref={searchRef}
            aria-label={t("sessions:searchSessions")}
            placeholder={t("sessions:searchByNameHostUsernameOrPort")}
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
        <button
          type="button"
          className="session-picker__new-folder"
          title={t("common:newFolder")}
          aria-label={t("common:newFolder")}
          onClick={p.onNewGroup}
        >
          <Plus size={14} />
          {t("common:newFolder")}
        </button>
      </div>
      <div className="session-picker__main">
        <nav
          className="session-picker__folders"
          aria-label={t("sessions:sessionFolders")}
        >
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
            <span>{t("sessions:allSessions")}</span>
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
              <small>
                {
                  p.sessions.filter((session) => session.groupId === group.id)
                    .length
                }
              </small>
            </button>
          ))}
        </nav>
        <div className="session-picker__list">
          <div className="session-picker__columns" aria-hidden="true">
            <span>{t("common:name")}</span>
            <span>{t("common:host")}</span>
            <span>{t("common:username")}</span>
            <span>{t("common:port")}</span>
          </div>
          <div
            className="session-picker__rows"
            role="list"
            aria-label={t("sessions:sshSessionList")}
          >
            {visible.map((session) => (
              <div
                key={session.id}
                role="listitem"
                className="session-picker__item"
              >
                <button
                  type="button"
                  className={
                    "session-picker__row" +
                    (selectedId === session.id ? " selected" : "")
                  }
                  aria-label={t("sessions:selectSession") + session.name}
                  aria-pressed={selectedId === session.id}
                  title={t("sessions:doubleClickToConnect") + session.name}
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
                    {opened.has(session.id) && (
                      <i
                        className="session-picker__opened"
                        title={t("sessions:open")}
                      />
                    )}
                  </span>
                  <span title={session.host}>{session.host}</span>
                  <span title={session.username}>{session.username}</span>
                  <span>{session.port}</span>
                </button>
                <button
                  type="button"
                  className="session-picker__more"
                  aria-label={t("sessions:moreActions") + session.name}
                  title={t("common:moreActions")}
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
                      x: Math.max(
                        8,
                        Math.min(
                          rect.right - (bounds?.left ?? 0) - 180,
                          (bounds?.width ?? 720) - 188,
                        ),
                      ),
                      y: Math.max(
                        8,
                        Math.min(
                          rect.bottom - (bounds?.top ?? 0),
                          (bounds?.height ?? 480) - 155,
                        ),
                      ),
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
                <p>
                  {p.sessions.length === 0
                    ? t("sessions:noSavedSshSessions")
                    : t("sessions:noMatchingSessions")}
                </p>
                <span>
                  {p.sessions.length === 0
                    ? t("sessions:clickNewBelowToAddAServer")
                    : t("sessions:tryADifferentKeywordOrFolder")}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
      {contextMenu && (
        <div
          className="session-picker__menu"
          role="menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => p.onConnect(contextMenu.session)}
          >
            <Server size={14} />
            {t("common:connect")}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => p.onOpenNewTab(contextMenu.session)}
          >
            <Plus size={14} />
            {t("sessions:openInNewTab")}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => p.onEdit(contextMenu.session)}
          >
            <Pencil size={14} />
            {t("common:edit2")}
          </button>
          <button
            type="button"
            role="menuitem"
            className="danger"
            onClick={() => {
              setContextMenu(null);
              p.onDelete(contextMenu.session);
            }}
          >
            <Trash2 size={14} />
            {t("common:delete")}
          </button>
        </div>
      )}
      <footer className="session-picker__footer">
        <span>{t("sessions:doubleClickToConnectOrSelectAndPress")}</span>
        <div>
          <button type="button" className="secondary" onClick={p.onNew}>
            <Plus size={15} />
            {t("common:new")}
          </button>
          <button type="button" className="secondary" onClick={p.onClose}>
            {t("common:cancel")}
          </button>
          <button
            type="button"
            className="primary"
            disabled={!selected}
            onClick={() => selected && p.onConnect(selected)}
          >
            {t("common:connect")}
          </button>
        </div>
      </footer>
    </dialog>
  );
}
