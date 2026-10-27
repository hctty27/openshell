import { useTranslation } from "react-i18next";
import { t } from "../i18n";
import { Settings2 } from "lucide-react";
import type { QuickCommand, QuickCommandLayout, Tab } from "../types";

interface Props {
  tab?: Tab;
  commands: QuickCommand[];
  layout: QuickCommandLayout;
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
  layout,
  onManage,
  onRun,
}: Props) {
  useTranslation();
  const visible = visibleQuickCommands(commands, tab);
  return (
    <div
      className={`quick-command-bar ${layout}`}
      aria-label={t("terminal:quickCommands")}
    >
      <button
        type="button"
        className="quick-command-manage"
        onClick={onManage}
        title={t("terminal:manageQuickCommands")}
      >
        <Settings2 size={14} />
        <span>{t("common:manage")}</span>
      </button>
      <div
        className={`quick-command-list ${layout}`}
        aria-label={t("terminal:commandButtons")}
        onWheel={(event) => {
          if (layout !== "single") return;
          const el = event.currentTarget;
          if (
            el.scrollWidth > el.clientWidth &&
            Math.abs(event.deltaY) > Math.abs(event.deltaX)
          ) {
            el.scrollLeft += event.deltaY;
          }
        }}
      >
        {visible.length === 0 && (
          <span className="quick-command-empty">
            {t("terminal:noQuickCommandsClickManageToAddOne")}
          </span>
        )}
        {visible.map((command) => (
          <button
            key={command.id}
            type="button"
            className="quick-command-button"
            title={t("terminal:message", {
              category: command.category || t("common:general"),
              command: command.command,
            })}
            disabled={tab?.status !== "connected" || !tab?.ref}
            onClick={() => onRun(command)}
          >
            {command.name}
          </button>
        ))}
      </div>
    </div>
  );
}
