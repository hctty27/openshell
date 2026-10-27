import { useTranslation } from "react-i18next";
import { t } from "../i18n";
import type { OperationStep } from "../types";

// Journal is observation-only. It never resumes or retries remote commands.
export default function OperationTimeline({ steps }: { steps: OperationStep[] }) {
  useTranslation();
  if (!steps.length) return null;
  return (
    <details className="ops-timeline" data-testid="ops-timeline">
      <summary>
        {t("ai:opsTimelineTitle")} · {steps.length} {t("ai:opsTimelineSteps")}
      </summary>
      <div className="ops-timeline__items">
        {steps.map((step) => {
          const uncertain = step.status === "unknown" || step.status === "running";
          return (
            <div className="ops-timeline__item" key={step.id}>
              <div className="ops-timeline__head">
                <strong>#{step.sequence} · {step.targets.map(x => x.tabId).join(", ")}</strong>
                <span className={uncertain ? "ops-timeline__warning" : ""}>
                  {t(({
                    awaiting_confirmation: "ai:opsStepAwaiting",
                    running: "ai:opsStepRunning",
                    completed: "ai:opsStepCompleted",
                    failed: "ai:opsStepFailed",
                    unknown: "ai:opsStepUnknown",
                    cancelled: "ai:opsStepCancelled",
                    superseded: "ai:opsStepSuperseded",
                    expired: "ai:opsStepExpired",
                  } as const)[step.status])}
                </span>
              </div>
              <code title={step.command}>{step.command}</code>
              <span className="ops-timeline__details">
                {step.risk === "high" ? t("ai:opsRiskHigh") : step.risk === "low" ? t("ai:opsRiskLow") : t("ai:opsRiskRead")}
                {step.verificationStatus === "pending" ? " · " + t("ai:opsVerificationPending") : ""}
              </span>
              {uncertain && <span className="ops-timeline__warning">{t("ai:opsUnknownNoRetry")}</span>}
            </div>
          );
        })}
      </div>
    </details>
  );
}
