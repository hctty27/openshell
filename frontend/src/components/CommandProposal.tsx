import { useTranslation } from "react-i18next";
import { t } from "../i18n";
import { useState } from "react";
import { Play, Square, ShieldCheck, Check, Clock, Code2 } from "lucide-react";
import type { Proposal, PreflightReport } from "../types";
interface Props {
  proposal: Proposal;
  host: string;
  username: string;
  targetNames?: Record<string, string>;
  executing: boolean;
  readOnly?: boolean;
  confirmDisabled?: boolean;
  onPreflight?(): Promise<PreflightReport>;
  onConfirm(): void;
  onCancel(): void;
  onRevise(command: string, cwd: string, seconds: number): Promise<void>;
}
export default function CommandProposal(p: Props) {
  useTranslation();
  const [command, setCommand] = useState(p.proposal.command);
  const [cwd, setCwd] = useState(p.proposal.cwd);
  const [seconds, setSeconds] = useState(p.proposal.timeoutSeconds);
  const parallel = !!p.proposal.targets?.length;
  const [preflightAcknowledged, setPreflightAcknowledged] = useState(false);
  const highRisk = p.proposal.plan?.risk === "high";
  const [preflight, setPreflight] = useState<PreflightReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState(false);
  const inspect = async () => {
    if (!p.onPreflight || checking || p.executing) return;
    setChecking(true);
    setCheckError(false);
    setPreflight(null);
    try {
      const report = await p.onPreflight();
      if (report.proposalId === p.proposal.id) setPreflight(report);
      else setCheckError(true);
    } catch {
      setCheckError(true);
    } finally {
      setChecking(false);
    }
  };
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
        {parallel
          ? p.proposal.targets!.map(ref => p.targetNames?.[ref.tabId] ?? ref.tabId).join(" · ")
          : `${p.username}@${p.host}`}
      </div>
      {p.proposal.plan && p.proposal.plan.risk !== "read" && (
        <div className="ops-plan" role="group" aria-label={t("ai:opsPlanTitle")}>
          <strong>{t("ai:opsPlanTitle")} · {highRisk ? t("ai:opsRiskHigh") : t("ai:opsRiskLow")}</strong>
          <ol className="ops-plan__steps">
            <li>
              {t("ai:opsStepPreflight")} ({t("ai:opsPreflightNotVerified")})
              <ul className="ops-plan__checks">
                {p.proposal.plan.preflight.map(check => (
                  <li key={check}>{check === "target" ? t("ai:opsCheckTarget")
                    : check === "impact" ? t("ai:opsCheckImpact")
                    : check === "environment" ? t("ai:opsCheckEnvironment")
                    : check === "backup" ? t("ai:opsCheckBackup")
                    : check === "rollback" ? t("ai:opsCheckRollback")
                    : check}</li>
                ))}
              </ul>
            </li>
            <li>{t("ai:opsStepExecute")}</li>
            {p.proposal.plan.verificationRequired && <li>{t("ai:opsStepVerify")}</li>}
          </ol>
          {highRisk && p.onPreflight && (
            <div className="ops-preflight">
              <button type="button" className="secondary" disabled={checking || p.executing}
                onClick={() => void inspect()}>
                {checking ? t("ai:opsPreflightChecking") : t("ai:opsPreflightRun")}
              </button>
              {checkError && <span role="alert">{t("ai:opsPreflightError")}</span>}
              {preflight && (
                <div role="status" className="ops-preflight__results">
                  <strong>{preflight.ready ? t("ai:opsPreflightProbePassed") : t("ai:opsPreflightProbeFailed")}</strong>
                  {preflight.checks.map((check, i) => (
                    <div key={check.ref.tabId + check.key + i}>
                      {p.targetNames?.[check.ref.tabId] ?? check.ref.tabId}
                      {" · "}{check.key === "connection" ? t("ai:opsProbeConnection")
                        : check.key === "identity" ? t("ai:opsProbeIdentity")
                        : t("ai:opsProbeCapacity")}
                      {" · "}{check.status === "passed" ? t("ai:opsProbePassed")
                        : check.status === "warning" ? t("ai:opsProbeWarning")
                        : t("ai:opsProbeFailed")}
                    </div>
                  ))}
                  <small>{t("ai:opsProbeNotApproval")}</small>
                </div>
              )}
            </div>
          )}
          {highRisk && (
            <label className="ops-plan__ack">
              <input type="checkbox" checked={preflightAcknowledged}
                disabled={p.executing} onChange={e => setPreflightAcknowledged(e.target.checked)} />
              <span>{t("ai:opsAcknowledgePreflight")}</span>
            </label>
          )}
        </div>
      )}
      <textarea
        aria-label={t("ai:pendingCommand")}
        className="command-editor"
        value={command}
        disabled={p.executing}
        readOnly={p.readOnly || parallel}
        onChange={(e) => setCommand(e.target.value)}
        spellCheck={false}
      />
      <label className="inline-field">
        {t("common:directory")}
        <input
          aria-label={t("ai:workingDirectory")}
          value={cwd}
          disabled={p.executing || parallel}
          readOnly={p.readOnly || parallel}
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
          disabled={p.executing || parallel}
          readOnly={p.readOnly || parallel}
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
            {dirty && !parallel ? (
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
                disabled={p.confirmDisabled || (highRisk && !preflightAcknowledged)}
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
