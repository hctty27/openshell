import { useTranslation } from "react-i18next";
import { t } from "../i18n";
import { Plus, Settings2 } from "lucide-react";
import type { QuickCommand, Tab } from "../types";

interface Props {
  tab?: Tab;
  commands: QuickCommand[];
  onManage(): void;
  onRun(command: QuickCommand): void;
}

/** @internal Testable visibility rule used by the command bar. */
export function visibleQuickCommands(commands: QuickCommand[], tab?: Tab) {
  if (!tab) return [];
  return commands.filter(
    (command) =>
      command.scope === "global" ||
      (command.scope === "group" && command.scopeId === tab.session.groupId) ||
      (command.scope === "session" && command.scopeId === tab.session.id),
  );
}

export default function QuickCommandBar({
  tab,
  commands,
  onManage,
  onRun,
}: Props) {
  useTranslation();
  const visible = visibleQuickCommands(commands, tab);
  return (
    <div
      className="quick-command-bar"
      aria-label={t("terminal:quickCommands")}
    >
      <div
        className="quick-command-list"
        aria-label={t("terminal:commandButtons")}
        onWheel={(event) => {
          const el = event.currentTarget;
          if (
            el.scrollWidth > el.clientWidth &&
            Math.abs(event.deltaY) > Math.abs(event.deltaX)
          ) {
            el.scrollLeft += event.deltaY;
          }
        }}
      >
        {visible.map((command) => (
          <button
            key={command.id}
            type="button"
            className="quick-command-button"
            title={command.command}
            disabled={tab?.status !== "connected" || !tab?.ref}
            onClick={() => onRun(command)}
          >
            {command.name}
          </button>
        ))}
      </div>
      <button
        type="button"
        className="quick-command-manage"
        onClick={onManage}
        title={t("terminal:manageQuickCommands")}
        aria-label={t("terminal:manageQuickCommands")}
      >
        {visible.length === 0
          ? <Plus size={15} aria-hidden="true" />
          : <Settings2 size={14} aria-hidden="true" />}
      </button>
    </div>
  );
}
