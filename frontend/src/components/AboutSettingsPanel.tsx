import { Browser, Clipboard } from "@wailsio/runtime";
import { Bug, Check, Copy, ExternalLink, Github, Globe } from "lucide-react";
import { useState } from "react";
import packageManifest from "../../package.json";
import { t } from "../i18n";

const APP_VERSION = import.meta.env.VITE_APP_VERSION || packageManifest.version;
const CONTACT_EMAIL = "ynk27.nb@gmail.com";
const PROJECT_URL = "https://github.com/hctty27/openshell";

const links = [
  { label: "settings:aboutWebsite", url: "https://openshell.testnb.me", icon: Globe },
  { label: "settings:aboutRepository", url: PROJECT_URL, icon: Github },
  { label: "settings:aboutReportIssue", url: `${PROJECT_URL}/issues`, icon: Bug },
] as const;

type Status = "copied" | "copyFailed" | "openFailed" | null;

export default function AboutSettingsPanel() {
  const [status, setStatus] = useState<Status>(null);

  const openLink = async (url: string) => {
    setStatus(null);
    try {
      await Browser.OpenURL(url);
    } catch {
      setStatus("openFailed");
    }
  };

  const copyEmail = async () => {
    setStatus(null);
    try {
      await Clipboard.SetText(CONTACT_EMAIL);
      setStatus("copied");
    } catch {
      setStatus("copyFailed");
    }
  };

  return (
    <section className="settings-panel settings-about" aria-labelledby="settings-about-title">
      <div className="settings-panel-heading">
        <h3 id="settings-about-title">{t("settings:about")}</h3>
      </div>

      <div className="settings-about-product">
        <img src="/app-icon.svg" alt="" aria-hidden="true" />
        <div>
          <strong>OpenShell</strong>
          <p>{t("settings:aboutDescription")}</p>
          <p>{t("settings:version")} v{APP_VERSION}</p>
        </div>
      </div>

      <div className="settings-about-group">
        <h4>{t("settings:aboutProjectInfo")}</h4>
        <dl className="settings-about-details">
          <div>
            <dt>{t("settings:aboutDeveloper")}</dt>
            <dd>hctty27</dd>
          </div>
          <div>
            <dt>{t("settings:aboutEmail")}</dt>
            <dd className="settings-about-email">
              <button
                type="button"
                className="settings-about-text-link"
                onClick={() => void openLink(`mailto:${CONTACT_EMAIL}`)}
                title={t("settings:aboutSendEmail")}
              >
                {CONTACT_EMAIL}
                <ExternalLink size={13} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="settings-about-copy"
                onClick={() => void copyEmail()}
                title={t("settings:aboutCopyEmail")}
                aria-label={t("settings:aboutCopyEmail")}
              >
                {status === "copied" ? <Check size={14} /> : <Copy size={14} />}
              </button>
            </dd>
          </div>
          <div>
            <dt>{t("settings:aboutLicense")}</dt>
            <dd>
              <button
                type="button"
                className="settings-about-text-link"
                onClick={() => void openLink(`${PROJECT_URL}/blob/main/LICENSE`)}
              >
                MIT License
                <ExternalLink size={13} aria-hidden="true" />
              </button>
            </dd>
          </div>
        </dl>
      </div>

      <div className="settings-about-group">
        <h4>{t("settings:aboutLinks")}</h4>
        <ul className="settings-about-links">
          {links.map(({ label, url, icon: Icon }) => (
            <li key={url}>
              <button type="button" onClick={() => void openLink(url)}>
                <Icon size={16} aria-hidden="true" />
                <span>{t(label)}</span>
                <ExternalLink size={14} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      </div>

      {status && (
        <p className="settings-about-feedback" role="status">
          {t(status === "copied" ? "settings:aboutCopied" : status === "copyFailed" ? "settings:aboutCopyFailed" : "settings:aboutOpenFailed")}
        </p>
      )}
      <p className="settings-about-footer">{t("settings:aboutFooter")}</p>
    </section>
  );
}
