import { CircleAlert, CircleCheck, LoaderCircle, RefreshCw, Terminal, Unplug } from "lucide-react";
import { t } from "../i18n";
import type { Tab } from "../types";

interface Props {
  status: Tab["status"] | "disconnected";
  localShell?: boolean;
  size?: number;
}

export default function ConnectionStatusIcon({ status, localShell = false, size = 14 }: Props) {
  const state = status === "disconnected" && localShell ? "local" : status;
  const labels: Record<typeof state, string> = {
    connected: t("common:sshConnected"),
    connecting: t("common:connecting2"),
    reconnecting: t("common:reconnecting"),
    disconnected: t("common:disconnected"),
    error: t("common:connectionFailed"),
    local: t("common:localTerminal"),
  };
  const icons = {
    connected: <CircleCheck size={size} strokeWidth={2.2} />,
    connecting: <LoaderCircle size={size} strokeWidth={2.2} className="spin" />,
    reconnecting: <RefreshCw size={size} strokeWidth={2.2} className="spin" />,
    disconnected: <Unplug size={size} strokeWidth={2} />,
    error: <CircleAlert size={size} strokeWidth={2.2} />,
    local: <Terminal size={size} strokeWidth={2} />,
  };
  return <span className={`connection-state connection-state-${state}`}
    role="img" aria-label={labels[state]} title={labels[state]}>{icons[state]}</span>;
}
