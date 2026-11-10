"use strict";

const LATEST_RELEASE_URL = "https://github.com/hctty27/openshell/releases/latest";
const RELEASE_API_URL = "https://api.github.com/repos/hctty27/openshell/releases/latest";

const translations = {
  zh: {
    skip: "跳转到主要内容", navFeatures: "功能", navPreview: "产品预览", navTrust: "隐私与安全", navDownload: "下载", headerCta: "立即下载",
    heroTag: "免费开源 · Windows x64", heroLine1: "服务器管理，", heroLine2: "尽在一个工作空间。",
    heroDescription: "将 SSH 多会话终端、SFTP 文件管理、Rust 原生 ZMODEM 与可选 AI 助手整合到同一个 Windows 工作空间。",
    heroDownload: "下载 Windows 版", heroSource: "查看源代码", heroTrust: "MIT 开源许可", heroNoAccount: "无需注册账号",
    heroLatest: "获取最新版本", previewLabel: "真实产品界面", previewAlt: "OpenShell Windows SSH 工作空间，展示终端与 SFTP 文件管理",
    featuresEyebrow: "BUILT FOR YOUR WORKFLOW", featuresHeading: "连接、操作、传输，一处完成。",
    featuresIntro: "从多服务器终端到远程文件传输，再到 AI 辅助操作，让日常运维保持连贯。",
    f1Title: "多会话 SSH 终端", f1Text: "管理多台服务器，使用标签、左右与上下分屏、输出搜索和异常重连。",
    f2Title: "内置 SFTP 文件管理器", f2Text: "批量上传下载、远程编辑、目录同步预览，以及传输任务取消与重试。",
    f3Title: "可选 AI 助手与终端 AI", f3Text: "配置兼容的模型 API，使用全局助手处理多会话任务，或让终端 AI 在当前 SSH Shell 中协助操作。",
    f4Title: "Rust 原生 ZMODEM", f4Text: "Windows 使用 Rust 原生 sidecar 处理 rz/sz；远端安装 trzsz 后也可使用 trz/tsz。",
    f5Title: "Xshell 迁移与快捷命令", f5Text: "导入 Xshell SSH 会话，并管理全局、文件夹或会话级快捷命令。",
    f6Title: "本地优先与透明安全", f6Text: "会话保存在本机，敏感凭据使用 Windows 凭据管理器；AI 请求仅发送到你配置的模型服务。",
    workflowEyebrow: "ONE WORKSPACE", workflowHeading: "连接服务器，\n专注完成工作。",
    workflowBody: "连接服务器、管理终端、浏览远程目录、传输文件，并在需要时使用 AI 辅助操作。OpenShell 让这些工作发生在同一个窗口内。",
    workflowDocs: "阅读使用文档", wf1Title: "连接", wf1Desc: "SSH 会话与安全主机验证",
    wf2Title: "操作", wf2Desc: "终端分屏、搜索和快捷命令", wf3Title: "传输", wf3Desc: "SFTP 管理、远程编辑与任务队列",
    wf4Title: "辅助", wf4Desc: "全局 AI 助手、终端 AI 与诊断工具", trustEyebrow: "OPEN BY DESIGN", trustHeading: "透明，才能值得信赖。",
    trustIntro: "公开源代码、明确数据流向和发布签名状态。安全不是一句营销口号。",
    trust1Title: "免费开源", trust1Text: "代码公开可审查，开发与发布记录可追溯。",
    trust2Stat: "本地", trust2Title: "本地存储与诊断", trust2Text: "会话数据留在设备上。AI 请求仅在启用并配置模型时发往所选服务。",
    trust3Stat: "透明", trust3Title: "真实的签名状态", trust3Text: "发布页披露 Windows 安装包的实际签名状态。请逐版核实。",
    privacyLink: "隐私政策 ↗", signingLink: "代码签名政策 ↗", licenseLink: "第三方组件许可 ↗",
    downloadEyebrow: "GET OPENSHELL", downloadHeading: "准备好开始了吗？",
    downloadDescription: "Windows x64 · 免费下载 · 无需登录", releaseFallback: "GitHub 最新版本",
    setupTitle: "Windows 安装版", setupDesc: "推荐 · 安装后从开始菜单启动",
    portableTitle: "Windows 便携版", portableDesc: "解压即用 · 请保留 zmodem 目录",
    downloadNote: "下载前查看对应 Release 的签名状态与更新说明。未签名版本可能触发 Windows 安全提示。需要 WebView2 Runtime。",
    allReleases: "查看全部版本 ↗", webview: "WebView2 运行环境 ↗",
    footerTagline: "专注连接，轻装前行。", footerFeedback: "反馈问题", footerPrivacy: "隐私政策", footerSigning: "签名政策"
  },
  en: {
    skip: "Skip to main content", navFeatures: "Features", navPreview: "Preview", navTrust: "Privacy & security", navDownload: "Download", headerCta: "Download",
    heroTag: "Free & open source · Windows x64", heroLine1: "Your servers.", heroLine2: "One workspace.",
    heroDescription: "Bring multi-session SSH, split terminals, SFTP, native Rust ZMODEM and optional AI assistance into one focused Windows workspace.",
    heroDownload: "Download for Windows", heroSource: "View source code", heroTrust: "MIT licensed", heroNoAccount: "No account required",
    heroLatest: "Get the latest release", previewLabel: "Actual application interface", previewAlt: "OpenShell Windows SSH workspace with terminal and SFTP file management",
    featuresEyebrow: "BUILT FOR YOUR WORKFLOW", featuresHeading: "Connect. Operate. Transfer.",
    featuresIntro: "Keep server sessions, remote files, native transfers and optional AI assistance in one workflow.",
    f1Title: "Multi-session SSH terminals", f1Text: "Manage servers with tabs, horizontal and vertical splits, output search, and reconnection.",
    f2Title: "Built-in SFTP file manager", f2Text: "Batch transfers, remote editing, directory-sync previews, and transfer cancellation and retry.",
    f3Title: "Optional AI assistant & Terminal AI", f3Text: "Connect a compatible model API for multi-session tasks or AI assistance inside the active SSH terminal.",
    f4Title: "Native Rust ZMODEM", f4Text: "Use the Rust-native Windows sidecar for rz/sz; trz/tsz is also supported when installed on the remote host.",
    f5Title: "Xshell import & quick commands", f5Text: "Import Xshell SSH sessions and manage reusable global, folder, or session-level commands.",
    f6Title: "Local-first data handling", f6Text: "Sessions stay on your device, credentials use Windows Credential Manager, and AI requests go to the model service you configure.",
    workflowEyebrow: "ONE WORKSPACE", workflowHeading: "Connect. Operate.\nStay in flow.",
    workflowBody: "Connect to servers, manage terminals, browse remote files, transfer data and use AI assistance when needed—all in one window.",
    workflowDocs: "Read the documentation", wf1Title: "Connect", wf1Desc: "SSH sessions and host-key verification",
    wf2Title: "Operate", wf2Desc: "Split panes, search and quick commands", wf3Title: "Transfer", wf3Desc: "SFTP, remote editing and transfer queue",
    wf4Title: "Assist", wf4Desc: "Global AI assistant, Terminal AI and diagnostics", trustEyebrow: "OPEN BY DESIGN", trustHeading: "Trust starts with transparency.",
    trustIntro: "Public source code, clear data flows and honest signing disclosures—not just security promises.",
    trust1Title: "Free and open source", trust1Text: "Reviewable source, traceable changes and public release history.",
    trust2Stat: "Local", trust2Title: "Local data and diagnostics", trust2Text: "Sessions stay on your device. AI messages go only to the provider you configure when you use AI.",
    trust3Stat: "Clear", trust3Title: "Accurate signing disclosure", trust3Text: "Each Release discloses its actual Windows signing status. Verify each version individually.",
    privacyLink: "Privacy policy ↗", signingLink: "Code signing policy ↗", licenseLink: "Third-party licenses ↗",
    downloadEyebrow: "GET OPENSHELL", downloadHeading: "Ready to get started?",
    downloadDescription: "Windows x64 · Free to download · No login required", releaseFallback: "Latest GitHub release",
    setupTitle: "Windows installer", setupDesc: "Recommended · Launch from the Start menu",
    portableTitle: "Windows portable ZIP", portableDesc: "Extract and run · Keep the zmodem folder",
    downloadNote: "Check the Release notes for signing status before downloading. Unsigned builds may trigger Windows security warnings. WebView2 Runtime is required.",
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
    }
  });
  document.querySelectorAll("[data-i18n-alt]").forEach((element) => {
    element.setAttribute("alt", words[element.dataset.i18nAlt] || "");
  });
  const description = language === "zh"
    ? "OpenShell — 免费开源的 Windows SSH 工作空间，集成多会话终端、SFTP、Rust 原生 ZMODEM 与可选 AI 助手。"
    : "OpenShell is a free, open-source Windows SSH workspace with multi-session terminals, SFTP, native Rust ZMODEM, Xshell import and optional AI assistance.";
  document.title = language === "zh"
    ? "OpenShell — AI 辅助的 Windows SSH 工作空间"
    : "OpenShell — AI-assisted SSH workspace for Windows";
  document.querySelector('meta[name="description"]').content = description;
  document.querySelector('meta[property="og:title"]').content = document.title;
  document.querySelector('meta[property="og:description"]').content = description;
  document.querySelector('meta[name="twitter:title"]').content = document.title;
  document.querySelector('meta[name="twitter:description"]').content = description;
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
