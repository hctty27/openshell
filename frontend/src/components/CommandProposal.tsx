import { useTranslation } from "react-i18next";
import { t } from "../i18n";
import { useState } from "react";
import { Play, Square, ShieldCheck, Check, Clock, Code2 } from "lucide-react";
import type { Proposal } from "../types";
interface Props {
  proposal: Proposal;
  host: string;
  username: string;
  executing: boolean;
  readOnly?: boolean;
  confirmDisabled?: boolean;
  onConfirm(): void;
  onCancel(): void;
  onRevise(command: string, cwd: string, seconds: number): Promise<void>;
}
export default function CommandProposal(p: Props) {
  useTranslation();
  const [command, setCommand] = useState(p.proposal.command);
  const [cwd, setCwd] = useState(p.proposal.cwd);
  const [seconds, setSeconds] = useState(p.proposal.timeoutSeconds);
  const dirty =
    command !== p.proposal.command ||
    cwd !== p.proposal.cwd ||
    seconds !== p.proposal.timeoutSeconds;
  return (
    <section className="proposal">
      <div className="proposal-heading">
        <Code2 size={15} />
        <span>
          {p.executing
            ? t("ai:runningCommand")
            : t("ai:commandAwaitingConfirmation")}
        </span>
        <span className="proposal-badge">SSH</span>
      </div>
      <p>{p.proposal.purpose}</p>
      <div className="proposal-target">
        <ShieldCheck size={13} />
        {p.username}@{p.host}
      </div>
      <textarea
        aria-label={t("ai:pendingCommand")}
        className="command-editor"
        value={command}
        disabled={p.executing}
        readOnly={p.readOnly}
        onChange={(e) => setCommand(e.target.value)}
        spellCheck={false}
      />
      <label className="inline-field">
        {t("common:directory")}
        <input
          aria-label={t("ai:workingDirectory")}
          value={cwd}
          disabled={p.executing}
          readOnly={p.readOnly}
          onChange={(e) => setCwd(e.target.value)}
        />
      </label>
      <label className="inline-field">
        <Clock size={12} />
        <input
          aria-label={t("ai:commandTimeoutInSeconds")}
          type="number"
          min="1"
          max="600"
          value={seconds}
          disabled={p.executing}
          readOnly={p.readOnly}
          onChange={(e) => setSeconds(Number(e.target.value))}
        />
        <span>{t("ai:seconds")}</span>
      </label>
      <div className="proposal-actions">
        {p.executing ? (
          <button className="secondary" onClick={p.onCancel}>
            <Square size={12} />
            {t("common:stop")}
          </button>
        ) : (
          <>
            <button onClick={p.onCancel}>{t("common:reject")}</button>
            {dirty ? (
              <button
                className="primary"
                onClick={() => p.onRevise(command, cwd, seconds)}
              >
                <Check size={13} />
                {t("ai:updateProposal")}
              </button>
            ) : (
              <button
                className="primary"
                disabled={p.confirmDisabled}
                onClick={p.onConfirm}
              >
                <Play size={13} />
                {t("common:runCommand")}
              </button>
            )}
          </>
        )}
      </div>
      <small>{t("ai:runsIndependentlyOfTheManualTerminalSDirectory")}</small>
    </section>
  );
}
