import { renderMessage, type DisplayText } from "../i18n/message";
import { useTranslation } from "react-i18next";
import { message } from "../i18n/message";
import { t } from "../i18n";
import { useState } from "react";
import { ArrowDown, ArrowUp, Plus, Save, Trash2, X } from "lucide-react";
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
  const [category, setCategory] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>("");
  const [success, setSuccess] = useState<DisplayText>("");
  const categories = [
    ...new Set(p.commands.map((c) => c.category || t("common:general"))),
  ];
  const listed = p.commands.filter(
    (c) => !category || (c.category || t("common:general")) === category,
  );
  const edit = (command: QuickCommand) => {
    setDraft({ ...command });
    setError("");
    setSuccess("");
  };
  const persist = async (next: QuickCommand[], message: DisplayText) => {
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      await p.onSave(next);
      setSuccess(message);
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
      ? p.commands.map((c) => (c.id === draft.id ? item : c))
      : [...p.commands, item];
    if (await persist(next, message("terminal:commandSaved")))
      setDraft(empty());
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
        p.commands.filter((c) => c.id !== item.id),
        message("terminal:commandDeleted"),
      )
    ) {
      if (draft.id === item.id) setDraft(empty());
    }
  };
  const move = async (item: QuickCommand, direction: -1 | 1) => {
    const i = p.commands.findIndex((c) => c.id === item.id);
    const filteredIndex = listed.findIndex((c) => c.id === item.id);
    const neighbor = listed[filteredIndex + direction];
    const j = neighbor ? p.commands.findIndex((c) => c.id === neighbor.id) : -1;
    if (i < 0 || j < 0) return;
    const next = [...p.commands];
    [next[i], next[j]] = [next[j], next[i]];
    await persist(next, message("terminal:orderUpdated"));
  };
  return (
    <ModalSurface
      className="quick-manager"
      aria-label={t("terminal:manageQuickCommands")}
      onDismiss={p.onClose}
      locked={busy}
    >
        <header className="quick-manager-header">
          <div>
            <span className="eyebrow">{t("terminal:quickCommandsLabel")}</span>
            <h2>{t("terminal:manageQuickCommands")}</h2>
          </div>
          <button title={t("common:close")} disabled={busy} onClick={p.onClose}>
            <X size={19} />
          </button>
        </header>
        <div className="quick-manager-body">
          <aside className="quick-manager-side">
            <div className="quick-manager-side-head">
              <strong>
                {t("terminal:commandListTitle", { count: p.commands.length })}
              </strong>
              <button
                title={t("terminal:addCommand")}
                disabled={busy}
                onClick={() => edit(empty())}
              >
                <Plus size={16} />
              </button>
            </div>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              aria-label={t("terminal:filterCommandCategories")}
            >
              <option value="">{t("terminal:allCategories")}</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <div className="quick-manager-items">
              {listed.length === 0 && (
                <p className="muted small">{t("terminal:noCommands")}</p>
              )}
              {listed.map((item) => (
                <div
                  key={item.id}
                  className={`quick-manager-item ${draft.id === item.id ? "selected" : ""}`}
                >
                  <button
                    className="quick-manager-item-label"
                    disabled={busy}
                    onClick={() => edit(item)}
                  >
                    <strong>{item.name}</strong>
                    <small>
                      {item.category || t("common:general")} ·{" "}
                      {item.scope === "global"
                        ? t("common:global")
                        : item.scope === "group"
                          ? t("common:folder")
                          : t("common:session")}
                    </small>
                  </button>
                  <button
                    title={t("terminal:moveUp")}
                    disabled={busy || listed[0]?.id === item.id}
                    onClick={() => move(item, -1)}
                  >
                    <ArrowUp size={13} />
                  </button>
                  <button
                    title={t("terminal:moveDown")}
                    disabled={busy || listed.at(-1)?.id === item.id}
                    onClick={() => move(item, 1)}
                  >
                    <ArrowDown size={13} />
                  </button>
                </div>
              ))}
            </div>
          </aside>
          <div className="quick-manager-editor">
            <h3>
              {draft.id ? t("terminal:editCommand") : t("terminal:addCommand")}
            </h3>
            <label>
              {t("terminal:buttonName")}
              <input
                value={draft.name}
                maxLength={40}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder={t("terminal:eGCheckMemory")}
              />
            </label>
            <label>
              {t("terminal:command")}
              <textarea
                rows={3}
                maxLength={16384}
                value={draft.command}
                onChange={(e) =>
                  setDraft({ ...draft, command: e.target.value })
                }
                placeholder={t("terminal:eGFreeH")}
              />
            </label>
            <p className="muted small">
              {t("terminal:quickCommandNewlineHint")}
            </p>
            <div className="quick-manager-fields">
              <label>
                {t("terminal:category")}
                <input
                  list="quick-command-categories"
                  value={draft.category}
                  maxLength={40}
                  onChange={(e) =>
                    setDraft({ ...draft, category: e.target.value })
                  }
                />
                <datalist id="quick-command-categories">
                  {categories.map((c) => (
                    <option key={c} value={c} />
                  ))}
                </datalist>
              </label>
              <label>
                {t("terminal:scope")}
                <select
                  value={draft.scope}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      scope: e.target.value as QuickCommand["scope"],
                      scopeId: "",
                    })
                  }
                >
                  <option value="global">{t("terminal:allServers")}</option>
                  <option value="group">{t("terminal:serverFolder")}</option>
                  <option value="session">{t("terminal:sshSession")}</option>
                </select>
              </label>
            </div>
            {draft.scope === "group" && (
              <label>
                {t("terminal:targetFolder")}
                <select
                  value={draft.scopeId}
                  onChange={(e) =>
                    setDraft({ ...draft, scopeId: e.target.value })
                  }
                >
                  <option value="">{t("terminal:selectAFolder")}</option>
                  {p.groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {draft.scope === "session" && (
              <label>
                {t("terminal:targetSession")}
                <select
                  value={draft.scopeId}
                  onChange={(e) =>
                    setDraft({ ...draft, scopeId: e.target.value })
                  }
                >
                  <option value="">{t("terminal:selectASession")}</option>
                  {p.sessions.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="checkbox">
              <input
                type="checkbox"
                checked={draft.confirm}
                onChange={(e) =>
                  setDraft({ ...draft, confirm: e.target.checked })
                }
              />
              {t("terminal:confirmBeforeEachRun")}
            </label>
            <p className="muted small">
              {t("terminal:commandsGoToTheActiveSshTerminalExit")}
            </p>
            {!!error && (
              <p className="form-error" role="alert">
                {errorText(error)}
              </p>
            )}
            {success && (
              <p className="form-success">{renderMessage(success)}</p>
            )}
            <div className="quick-manager-actions">
              {draft.id && (
                <button
                  className="danger"
                  disabled={busy}
                  onClick={() => remove(draft)}
                >
                  <Trash2 size={15} /> {t("common:delete")}
                </button>
              )}
              <button
                className="secondary"
                disabled={busy}
                onClick={() => edit(empty())}
              >
                <Plus size={15} /> {t("common:new")}
              </button>
              <button
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
