"use strict";

const LATEST_RELEASE_URL = "https://github.com/hctty27/openshell/releases/latest";
const RELEASE_API_URL = "https://api.github.com/repos/hctty27/openshell/releases/latest";

const translations = {
  zh: {
    skip: "跳转到主要内容", navFeatures: "功能", navPreview: "产品预览", navTrust: "隐私与安全", navDownload: "下载", headerCta: "立即下载",
    heroTag: "免费开源 · Windows x64", heroLine1: "你的服务器，", heroLine2: "尽在掌控。",
    heroDescription: "将 SSH 终端、SFTP 文件管理与可选的 AI 助手放在同一个工作空间。连接更顺手，操作更专注。",
    heroDownload: "下载 Windows 版", heroSource: "查看源代码", heroTrust: "MIT 开源许可", heroNoAccount: "无需注册账号",
    heroLatest: "获取最新版本", previewLabel: "真实产品截图", previewAlt: "OpenShell SSH 终端和 SFTP 文件管理器界面",
    featuresEyebrow: "BUILT FOR YOUR WORKFLOW", featuresHeading: "更少切换，更多专注。",
    featuresIntro: "从连接服务器到管理文件，把日常操作整合到一个轻量工作空间。",
    f1Title: "多会话 SSH 终端", f1Text: "标签管理、左右与上下分屏、断线重连，让多台服务器始终有序。",
    f2Title: "完整的 SFTP 文件管理", f2Text: "上传、下载、远程编辑、传输队列与目录同步预览，文件操作无需换软件。",
    f3Title: "按需启用的 AI 助手", f3Text: "接入你自己的模型 API，结合终端上下文进行辅助分析；不配置 AI 也能完整使用 SSH/SFTP。",
    f4Title: "熟悉又高效的操作", f4Text: "快速命令、终端搜索、Xshell 会话导入、rz/sz 与 trzsz，减少重复操作。",
    f5Title: "本地优先的设计", f5Text: "会话存储在本机，敏感凭据由 Windows 凭据管理器保存；诊断报告不会自动上传。",
    f6Title: "简单、克制的工作空间", f6Text: "可调整的布局和中英文界面，让终端始终是工作重点。",
    workflowEyebrow: "ONE WORKSPACE", workflowHeading: "从连接到交付，\n不必来回切换。",
    workflowBody: "连接服务器、浏览远程目录、编辑配置、传输文件。OpenShell 让这些工作发生在同一个窗口内。",
    workflowDocs: "阅读使用文档", wf1Title: "连接", wf1Desc: "SSH 会话与安全主机验证",
    wf2Title: "操作", wf2Desc: "终端分屏、搜索和快捷命令", wf3Title: "传输", wf3Desc: "SFTP 管理、远程编辑与任务队列",
    wf4Title: "扩展", wf4Desc: "可选 AI 辅助与诊断工具", trustEyebrow: "OPEN BY DESIGN", trustHeading: "透明，才能值得信赖。",
    trustIntro: "公开源代码、明确数据流向和发布签名状态。安全不是一句营销口号。",
    trust1Title: "免费开源", trust1Text: "代码公开可审查，开发与发布记录可追溯。",
    trust2Stat: "本地", trust2Title: "本地存储与诊断", trust2Text: "会话数据留在设备上。AI 请求仅在启用并配置模型时发往所选服务。",
    trust3Stat: "透明", trust3Title: "真实的签名状态", trust3Text: "发布页披露 Windows 安装包是否签名。当前 v1.0.0 尚未签名。",
    privacyLink: "隐私政策 ↗", signingLink: "代码签名政策 ↗", licenseLink: "第三方组件许可 ↗",
    downloadEyebrow: "GET OPENSHELL", downloadHeading: "准备好开始了吗？",
    downloadDescription: "Windows x64 · 免费下载 · 无需登录", releaseFallback: "GitHub 最新版本",
    setupTitle: "Windows 安装版", setupDesc: "推荐 · 安装后从开始菜单启动",
    portableTitle: "Windows 便携版", portableDesc: "解压即用 · 请保留 zmodem 目录",
    downloadNote: "下载前请查看 Release 的签名状态和更新说明。v1.0.0 未签名，Windows 可能显示安全提示。需要 WebView2 Runtime。",
    allReleases: "查看全部版本 ↗", webview: "WebView2 运行环境 ↗",
    footerTagline: "专注连接，轻装前行。", footerFeedback: "反馈问题", footerPrivacy: "隐私政策", footerSigning: "签名政策"
  },
  en: {
    skip: "Skip to main content", navFeatures: "Features", navPreview: "Preview", navTrust: "Privacy & security", navDownload: "Download", headerCta: "Download",
    heroTag: "Free & open source · Windows x64", heroLine1: "Your servers.", heroLine2: "Your command.",
    heroDescription: "SSH terminals, SFTP file management, and an optional AI assistant in one workspace. Less friction, more focus.",
    heroDownload: "Download for Windows", heroSource: "View source code", heroTrust: "MIT licensed", heroNoAccount: "No account required",
    heroLatest: "Get the latest release", previewLabel: "Actual application screenshot", previewAlt: "OpenShell SSH terminal and SFTP file manager interface",
    featuresEyebrow: "BUILT FOR YOUR WORKFLOW", featuresHeading: "Less switching. More doing.",
    featuresIntro: "From SSH connections to remote files, streamline daily server work in one lightweight app.",
    f1Title: "Multi-session SSH terminals", f1Text: "Tabs, side-by-side and stacked splits, and reconnection keep your servers organized.",
    f2Title: "Built-in SFTP file manager", f2Text: "Upload, download, edit remote files, manage transfers, and preview directory sync without changing apps.",
    f3Title: "Optional AI assistant", f3Text: "Connect your own model API to work with terminal context. SSH and SFTP work fully without AI configured.",
    f4Title: "Familiar, efficient tools", f4Text: "Quick commands, terminal search, Xshell import, rz/sz, and trzsz reduce repetitive work.",
    f5Title: "Local-first by design", f5Text: "Session data stays on your device; sensitive credentials use Windows Credential Manager. Diagnostics are not uploaded automatically.",
    f6Title: "A focused workspace", f6Text: "Adjustable layouts and bilingual UI keep your terminal front and center.",
    workflowEyebrow: "ONE WORKSPACE", workflowHeading: "Connect. Work. Ship.\nStay in flow.",
    workflowBody: "Connect to a server, explore directories, edit configuration and transfer files—all from the same window.",
    workflowDocs: "Read the documentation", wf1Title: "Connect", wf1Desc: "SSH sessions and host-key verification",
    wf2Title: "Operate", wf2Desc: "Split panes, search and quick commands", wf3Title: "Transfer", wf3Desc: "SFTP, remote editing and transfer queue",
    wf4Title: "Extend", wf4Desc: "Optional AI support and diagnostics", trustEyebrow: "OPEN BY DESIGN", trustHeading: "Trust starts with transparency.",
    trustIntro: "Public source code, clear data flows and honest signing disclosures—not just security promises.",
    trust1Title: "Free and open source", trust1Text: "Reviewable source, traceable changes and public release history.",
    trust2Stat: "Local", trust2Title: "Local data and diagnostics", trust2Text: "Sessions stay on your device. AI messages go only to the provider you configure when you use AI.",
    trust3Stat: "Clear", trust3Title: "Accurate signing disclosure", trust3Text: "Each Release discloses signing status. The v1.0.0 Windows downloads are unsigned.",
    privacyLink: "Privacy policy ↗", signingLink: "Code signing policy ↗", licenseLink: "Third-party licenses ↗",
    downloadEyebrow: "GET OPENSHELL", downloadHeading: "Ready to get started?",
    downloadDescription: "Windows x64 · Free to download · No login required", releaseFallback: "Latest GitHub release",
    setupTitle: "Windows installer", setupDesc: "Recommended · Launch from the Start menu",
    portableTitle: "Windows portable ZIP", portableDesc: "Extract and run · Keep the zmodem folder",
    downloadNote: "Check the Release notes for signing status before downloading. v1.0.0 is unsigned and Windows may show a security warning. WebView2 Runtime is required.",
    allReleases: "All releases ↗", webview: "WebView2 Runtime ↗",
    footerTagline: "Stay connected. Stay focused.", footerFeedback: "Report an issue", footerPrivacy: "Privacy", footerSigning: "Code signing"
  }
};

function readStoredLanguage() {
  try {
    const saved = localStorage.getItem("openshell-website-language");
    return saved === "zh" || saved === "en" ? saved : null;
  } catch {
    return null;
  }
}

let currentLanguage = readStoredLanguage() || (navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en");
let currentVersion = null;

function setLanguage(language) {
  currentLanguage = language;
  document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
  const words = translations[language];
  document.querySelectorAll("[data-i18n]").forEach((element) => {
    const value = words[element.dataset.i18n];
    if (typeof value === "string") {
      element.textContent = value;
      if (element.dataset.i18n === "workflowHeading") {
        element.style.whiteSpace = "pre-line";
      }
    }
  });
  document.querySelectorAll("[data-i18n-alt]").forEach((element) => {
    element.setAttribute("alt", words[element.dataset.i18nAlt] || "");
  });
  document.querySelector('meta[name="description"]').content = language === "zh"
    ? "OpenShell — 免费开源的 Windows SSH/SFTP 客户端。多会话、分屏终端、文件传输和可选的 AI 助手。"
    : "OpenShell is a free, open-source SSH/SFTP client for Windows with tabs, split terminals, file transfer and optional AI assistance.";
  document.title = language === "zh"
    ? "OpenShell — 轻量、现代的 SSH 工作空间"
    : "OpenShell — A modern SSH workspace for Windows";
  const toggle = document.getElementById("language-toggle");
  toggle.textContent = language === "zh" ? "EN" : "中文";
  toggle.setAttribute("aria-label", language === "zh" ? "Switch to English" : "切换至简体中文");
  const docs = document.getElementById("documentation-link");
  docs.href = language === "zh"
    ? "https://github.com/hctty27/openshell/blob/main/README.zh-CN.md"
    : "https://github.com/hctty27/openshell/blob/main/README.md";
  if (currentVersion) updateVersionLabels(currentVersion);
  try { localStorage.setItem("openshell-website-language", language); } catch { /* storage may be disabled */ }
}

function updateVersionLabels(version) {
  document.getElementById("version-label").textContent = version;
  document.getElementById("release-pill").textContent = version + " · Windows x64";
}

function isValidGitHubAsset(asset, pattern) {
  return asset && typeof asset.name === "string" &&
    pattern.test(asset.name) &&
    typeof asset.browser_download_url === "string" &&
    /^https:\/\/github\.com\/hctty27\/openshell\/releases\/download\/[^/]+\/[^/?#]+$/.test(asset.browser_download_url);
}

async function loadLatestRelease() {
  if (typeof fetch !== "function") return;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const response = await fetch(RELEASE_API_URL, {
      headers: { "Accept": "application/vnd.github+json" },
      signal: controller.signal
    });
    if (!response.ok) return;
    const release = await response.json();
    if (!release || release.draft || release.prerelease || !/^v\d+\.\d+\.\d+$/.test(release.tag_name)) return;
    currentVersion = release.tag_name;
    updateVersionLabels(currentVersion);
    if (!Array.isArray(release.assets)) return;
    const setup = release.assets.find((asset) => isValidGitHubAsset(asset, /^OpenShell-v\d+\.\d+\.\d+-windows-x64-Setup\.exe$/));
    const portable = release.assets.find((asset) => isValidGitHubAsset(asset, /^OpenShell-v\d+\.\d+\.\d+-windows-x64-portable\.zip$/));
    if (setup) document.getElementById("setup-link").href = setup.browser_download_url;
    if (portable) document.getElementById("portable-link").href = portable.browser_download_url;
  } catch {
    // GitHub may be offline or rate-limited; links still open the releases page.
  } finally {
    clearTimeout(timeout);
  }
}

document.getElementById("language-toggle").addEventListener("click", () => {
  setLanguage(currentLanguage === "zh" ? "en" : "zh");
});
document.getElementById("copyright-year").textContent = String(new Date().getFullYear());
setLanguage(currentLanguage);
loadLatestRelease();
