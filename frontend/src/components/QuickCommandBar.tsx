import { Settings2 } from "lucide-react";
import type { QuickCommand, QuickCommandLayout, Tab } from "../types";

interface Props {
  tab?: Tab;
  commands: QuickCommand[];
  layout: QuickCommandLayout;
  onManage(): void;
  onRun(command: QuickCommand): void;
}

export function visibleQuickCommands(commands: QuickCommand[], tab?: Tab) {
  if (!tab) return [];
  return commands.filter((command) =>
    command.scope === "global" ||
    (command.scope === "group" && command.scopeId === tab.session.groupId) ||
    (command.scope === "session" && command.scopeId === tab.session.id),
  );
}

export default function QuickCommandBar({ tab, commands, layout, onManage, onRun }: Props) {
  const visible = visibleQuickCommands(commands, tab);
  return (
    <div className="quick-command-bar" aria-label="快速命令栏">
      <button
        type="button"
        className="quick-command-manage"
        onClick={onManage}
        title="管理快速命令"
      >
        <Settings2 size={14} />
        <span>管理</span>
      </button>
      <div
        className={`quick-command-list ${layout}`}
        aria-label="命令按钮"
        onWheel={(event) => {
          if (layout !== "single") return;
          const el = event.currentTarget;
          if (el.scrollWidth > el.clientWidth && Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
            el.scrollLeft += event.deltaY;
          }
        }}
      >
        {visible.length === 0 && (
          <span className="quick-command-empty">暂无快捷命令，点击「管理」添加</span>
        )}
        {visible.map((command) => (
          <button
            key={command.id}
            type="button"
            className="quick-command-button"
            title={`${command.category || "常用"} · ${command.command}${command.mode === "insert" ? "（仅填入）" : ""}`}
            disabled={tab?.status !== "connected" || !tab.ref}
            onClick={() => onRun(command)}
          >
            {command.name}
          </button>
        ))}
      </div>
    </div>
  );
}
