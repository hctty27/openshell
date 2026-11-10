# OpenShell Website

Cloudflare Pages project: [openshell-site](https://openshell-site.pages.dev/) (GitHub-connected, `main` branch). Custom-domain cutover is managed separately after the Pages site is verified.

独立的 OpenShell 官网源码（纯 HTML / CSS / JavaScript），部署到 Cloudflare Pages。它不依赖桌面客户端的 React、Wails、Go 或构建流程。

## 本地预览

在仓库根目录：

```bash
python -m http.server 8788 --directory website
```

访问 http://localhost:8788 。不要直接双击 `index.html`，否则部分浏览器的本地脚本和资源行为可能与线上不同。

```bash
python website/scripts/check_site.py
node --check website/app.js
```

## Cloudflare Pages 接入

1. Cloudflare Dashboard → **Workers & Pages** → **Create application** → **Pages** → **Connect to Git**。
2. 授权 GitHub 仓库 `hctty27/openshell`。
3. 生产分支设为 `main`，按下面的参数配置，保存并部署：

| 参数 | 值 |
| --- | --- |
| Framework preset | None |
| Root directory | `website` |
| Build command | `exit 0` |
| Build output directory | `.` |
| Production branch | `main` |
| 环境变量 | 不需要 |

4. 在 Pages 项目中设置 **Build watch paths**：监听 `website/*` 与 `website/**/*`，避免每次 SSH 客户端代码提交都重新部署网站。产品截图通过 `raw.githubusercontent.com` 直接加载，截图文件更新不需要重新构建 Pages。
5. 首次使用 Cloudflare 生成的 `*.pages.dev` 地址预览，确认样式、移动端、语言切换和下载入口。
6. 在 **Custom domains** 中添加 `openshell.testnb.me`，按 Cloudflare 的提示迁移现有 DNS 指向。先确认当前官网的原有源站可回滚，再切换流量；不要在未验证 Pages 项目之前直接删除现有 DNS。

注意：仓库代码推送本身**不会**创建你的 Cloudflare Pages 项目，也不会改变 DNS；这两项需要在 Cloudflare 账户中操作。

## 部署行为

- 静态产物：`website/index.html`、`styles.css`、`app.js`、`assets/logo.svg`、`_headers`、`robots.txt`、`sitemap.xml`。
- 产品截图直接引用仓库公开的 `docs/screenshots/*.png`，不复制二进制文件到 `website/`。官网 Hero 使用 `01-workspace-overview.png`，SSH 功能卡片使用 `02-split-terminals.png`，产品展示区使用 `03` 至 `06` 四张真实界面截图；Open Graph 与 Twitter 卡片使用 `github-social-preview.png`。当前已批准截图按原始 PNG 保留，不做打码、模糊、裁剪或二次编码。素材清单见 [截图资源说明](../docs/screenshots/README.md)。
- 下载入口优先使用 GitHub 最新**非预发布** Release 的 Windows x64 安装版和便携版文件；GitHub API 请求超时/限流时回退到 `/releases/latest`。网站不处理软件分发文件，也不会上传用户数据。
- 中/英文内容在 `app.js` 的 `translations` 中维护；首次访问按照浏览器语言选择，也可以手动切换，偏好仅存浏览器本地。
- 代码签名状态不应根据版本号自行推断。网站不再把 `v1.0.0` 的历史状态写成当前最新版本状态；所有版本均以对应 GitHub Release 的签名声明及实际 Authenticode 验证为准。
- `_headers` 配置安全响应头，部署后请检查 Cloudflare Pages 实际响应包含预期头部。
- 不使用 cookie banner、Analytics 或第三方统计 SDK。若后续接入分析功能，需要同步核对 [Privacy policy](../PRIVACY.md)。

## 站点结构

```
website/
├── index.html
├── styles.css
├── app.js
├── assets/
│   └── logo.svg
├── scripts/
│   └── check_site.py
├── _headers
├── robots.txt
└── sitemap.xml
```

## 正式版发布与网站解耦

桌面客户端继续使用仓库根目录下的 `.github/release-version.txt` 触发正式版 Release；官网只读 GitHub Releases 的公开接口。不修改版本标记时，即使官网合并进 `main`，也不会重复发布桌面软件。

**线上状态核验：** Pages 项目源配置已记录，但当前自定义域名的实际上线内容、DNS 切换与政策链接应独立核验；不能仅根据此 README 判定线上部署成功。
