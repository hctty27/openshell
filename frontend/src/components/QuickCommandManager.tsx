import { renderMessage, type DisplayText } from "../i18n/message";
import { useTranslation } from "react-i18next";
import { message } from "../i18n/message";
import { t } from "../i18n";
import { useState, type DragEvent, type KeyboardEvent } from "react";
import { GripVertical, Plus, Save, Search, Trash2, X } from "lucide-react";
import type { Group, QuickCommand, Session } from "../types";
import { errorText } from "../bridge";
import { useDialogs } from "./DialogProvider";
import ModalSurface from "./ModalSurface";

interface Props {
  commands: QuickCommand[];
  groups: Group[];
  sessions: Session[];
  onSave(commands: QuickCommand[]): Promise<void>;
  onClose(): void;
}

const empty = (): QuickCommand => ({
  id: "",
  name: "",
  command: "",
  category: "",
  scope: "global",
  scopeId: "",
  confirm: false,
});

export default function QuickCommandManager(p: Props) {
  useTranslation();
  const dialogs = useDialogs();
  const [draft, setDraft] = useState<QuickCommand>(empty);
  const [query, setQuery] = useState("");
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>("");
  const [success, setSuccess] = useState<DisplayText>("");

  const search = query.trim().toLocaleLowerCase();
  const listed = p.commands.filter(
    (command) =>
      !search ||
      command.name.toLocaleLowerCase().includes(search) ||
      command.command.toLocaleLowerCase().includes(search),
  );

  const edit = (command: QuickCommand) => {
    setDraft({ ...command });
    setError("");
    setSuccess("");
  };

  const persist = async (next: QuickCommand[], feedback: DisplayText) => {
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      await p.onSave(next);
      setSuccess(feedback);
      return true;
    } catch (e) {
      setError(e);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    const item = {
      ...draft,
      name: draft.name.trim(),
      // Keep the legacy field for existing saved commands and backend validation.
      category: draft.category.trim() || t("common:general"),
    };
    delete item.mode;
    if (!item.name || Array.from(item.name).length > 40) {
      setError(message("terminal:nameMustBe140Characters"));
      return;
    }
    if (
      !item.command.trim() ||
      new TextEncoder().encode(item.command).length > 16 * 1024 ||
      /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(item.command)
    ) {
      setError(message("terminal:commandMustBeNonemptyUpTo16384Bytes"));
      return;
    }
    if (Array.from(item.category).length > 40) {
      setError(message("terminal:categoryMustBeAtMost40Characters"));
      return;
    }
    if (item.scope !== "global" && !item.scopeId) {
      setError(message("terminal:selectATargetSessionOrFolder"));
      return;
    }
    if (!item.id && p.commands.length >= 200) {
      setError(message("terminal:saveUpTo200Commands"));
      return;
    }
    if (!item.id) item.id = crypto.randomUUID();
    const next = draft.id
      ? p.commands.map((command) => (command.id === draft.id ? item : command))
      : [...p.commands, item];
    if (await persist(next, message("terminal:commandSaved"))) {
      setDraft(empty());
    }
  };

  const remove = async (item: QuickCommand) => {
    if (
      !(await dialogs.confirm({
        title: message("terminal:deleteQuickCommand"),
        description: message("terminal:deleteThisCannotBeUndone", {
          name: item.name,
        }),
        tone: "danger",
        confirmLabel: message("terminal:deleteCommand"),
      }))
    )
      return;

    if (
      await persist(
        p.commands.filter((command) => command.id !== item.id),
        message("terminal:commandDeleted"),
      )
    ) {
      if (draft.id === item.id) setDraft(empty());
    }
  };

  const reorder = async (sourceId: string, targetId: string) => {
    if (busy || search || sourceId === targetId) return;
    const from = p.commands.findIndex((command) => command.id === sourceId);
    const to = p.commands.findIndex((command) => command.id === targetId);
    if (from < 0 || to < 0) return;
    const next = [...p.commands];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    await persist(next, message("terminal:orderUpdated"));
  };

  const moveWithKeyboard = (event: KeyboardEvent<HTMLButtonElement>, item: QuickCommand) => {
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    event.preventDefault();
    event.stopPropagation();
    if (busy || search) return;
    const index = p.commands.findIndex((command) => command.id === item.id);
    const neighbor = p.commands[index + (event.key === "ArrowUp" ? -1 : 1)];
    if (neighbor) void reorder(item.id, neighbor.id);
  };

  const startDrag = (event: DragEvent<HTMLButtonElement>, item: QuickCommand) => {
    if (busy || search) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", item.id);
    setDraggingId(item.id);
    setDropTargetId(null);
  };

  const finishDrag = () => {
    setDraggingId(null);
    setDropTargetId(null);
  };

  return (
    <ModalSurface
      className="quick-manager"
      aria-label={t("terminal:manageQuickCommands")}
      onDismiss={p.onClose}
      locked={busy}
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
          event.preventDefault();
          event.stopPropagation();
          if (!busy) void save();
        }
      }}
    >
      <header className="quick-manager-header">
        <h2>{t("terminal:manageQuickCommands")}</h2>
        <button
          type="button"
          className="quick-manager-close"
          title={t("common:close")}
          aria-label={t("common:close")}
          disabled={busy}
          onClick={p.onClose}
        >
          <X size={18} />
        </button>
      </header>
      <div className="quick-manager-body">
        <aside className="quick-manager-side">
          <div className="quick-manager-side-head">
            <strong>{t("terminal:commandListTitle", { count: p.commands.length })}</strong>
            <button
              type="button"
              className="quick-manager-add"
              title={t("terminal:addCommand")}
              aria-label={t("terminal:addCommand")}
              disabled={busy}
              onClick={() => edit(empty())}
            >
              <Plus size={16} />
            </button>
          </div>
          <label className="quick-manager-search">
            <Search size={15} aria-hidden="true" />
            <input
              type="search"
              aria-label={t("terminal:searchCommands")}
              placeholder={t("terminal:searchCommands")}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div className="quick-manager-items">
            {listed.length === 0 && (
              <p className="muted small">
                {search ? t("terminal:noMatchingCommands") : t("terminal:noCommands")}
              </p>
            )}
            {listed.map((item) => (
              <div
                key={item.id}
                className={[
                  "quick-manager-item",
                  draft.id === item.id ? "selected" : "",
                  draggingId === item.id ? "dragging" : "",
                  dropTargetId === item.id ? "drop-target" : "",
                ].filter(Boolean).join(" ")}
                onDragOver={(event) => {
                  if (busy || search || !draggingId || draggingId === item.id) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  setDropTargetId(item.id);
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const sourceId = draggingId;
                  finishDrag();
                  if (sourceId) void reorder(sourceId, item.id);
                }}
              >
                <button
                  type="button"
                  className="quick-manager-item-label"
                  disabled={busy}
                  onClick={() => edit(item)}
                >
                  <strong>{item.name}</strong>
                  <small title={item.command}>{item.command.replace(/[\r\n]+/g, " ↵ ")}</small>
                </button>
                <button
                  type="button"
                  className="quick-manager-drag-handle"
                  aria-label={t("terminal:reorderCommand", { name: item.name })}
                  title={t("terminal:reorderHint")}
                  draggable={!busy && !search}
                  disabled={busy || !!search}
                  onDragStart={(event) => startDrag(event, item)}
                  onDragEnd={finishDrag}
                  onKeyDown={(event) => moveWithKeyboard(event, item)}
                >
                  <GripVertical size={15} />
                </button>
              </div>
            ))}
          </div>
        </aside>
        <div className="quick-manager-editor">
          <h3>{draft.id ? t("terminal:editCommand") : t("terminal:addCommand")}</h3>
          <label>
            {t("terminal:buttonName")}
            <input
              value={draft.name}
              maxLength={40}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              placeholder={t("terminal:eGCheckMemory")}
            />
          </label>
          <label>
            {t("terminal:command")}
            <textarea
              rows={4}
              maxLength={16384}
              value={draft.command}
              onChange={(event) => setDraft({ ...draft, command: event.target.value })}
              placeholder={t("terminal:eGFreeH")}
              spellCheck={false}
            />
          </label>
          <p className="muted small quick-manager-hint">
            {t("terminal:quickCommandNewlineHint")}
          </p>
          <label>
            {t("terminal:scope")}
            <select
              value={draft.scope}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  scope: event.target.value as QuickCommand["scope"],
                  scopeId: "",
                })
              }
            >
              <option value="global">{t("terminal:allServers")}</option>
              <option value="group">{t("terminal:serverFolder")}</option>
              <option value="session">{t("terminal:sshSession")}</option>
            </select>
          </label>
          {draft.scope === "group" && (
            <label>
              {t("terminal:targetFolder")}
              <select
                value={draft.scopeId}
                onChange={(event) => setDraft({ ...draft, scopeId: event.target.value })}
              >
                <option value="">{t("terminal:selectAFolder")}</option>
                {p.groups.map((group) => (
                  <option key={group.id} value={group.id}>{group.name}</option>
                ))}
              </select>
            </label>
          )}
          {draft.scope === "session" && (
            <label>
              {t("terminal:targetSession")}
              <select
                value={draft.scopeId}
                onChange={(event) => setDraft({ ...draft, scopeId: event.target.value })}
              >
                <option value="">{t("terminal:selectASession")}</option>
                {p.sessions.map((session) => (
                  <option key={session.id} value={session.id}>{session.name}</option>
                ))}
              </select>
            </label>
          )}
          <label className="checkbox">
            <input
              type="checkbox"
              checked={draft.confirm}
              onChange={(event) => setDraft({ ...draft, confirm: event.target.checked })}
            />
            {t("terminal:confirmBeforeEachRun")}
          </label>
          <p className="muted small quick-manager-hint">
            {t("terminal:commandsGoToTheActiveSshTerminalExit")}
          </p>
          {!!error && (
            <p className="form-error" role="alert">{errorText(error)}</p>
          )}
          {success && <p className="form-success">{renderMessage(success)}</p>}
          <div className="quick-manager-actions">
            {draft.id && (
              <button
                type="button"
                className="danger"
                disabled={busy}
                onClick={() => remove(draft)}
              >
                <Trash2 size={15} /> {t("common:delete")}
              </button>
            )}
            <button
              type="button"
              className="primary"
              disabled={busy || !draft.name.trim() || !draft.command}
              onClick={save}
            >
              <Save size={15} /> {t("terminal:saveCommand")}
            </button>
          </div>
        </div>
      </div>
    </ModalSurface>
  );
}
