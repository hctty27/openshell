# OpenShell website policy links / 官网政策入口

**Deployment status:** This repository does not contain the source or deployment configuration for https://openshell.testnb.me/. The following is a **copyable snippet only**; it is NOT published to the production website.

## Suggested footer HTML

```html
<nav aria-label="OpenShell policies">
  <a href="https://github.com/hctty27/openshell/blob/main/CODE_SIGNING_POLICY.md">Code signing policy</a>
  <a href="https://github.com/hctty27/openshell/blob/main/PRIVACY.md">Privacy policy / 隐私政策</a>
  <a href="https://github.com/hctty27/openshell/blob/main/docs/third-party-review.md">Third-party licenses / 第三方许可</a>
</nav>
<p>OpenShell v1.0.0 Windows downloads are currently unsigned. SignPath Foundation approval is not yet confirmed.</p>
```

Also add the same links near the download section, because SignPath asks for a **Code signing policy** reference on the project home page and release/download pages. Existing GitHub README and future GitHub Releases already include links.

## Deployment verification

- [ ] Identify the actual website source repository or server directory and the owner of its deployment process.
- [ ] Insert the policy links into the website footer and download section, respecting existing styles and accessibility.
- [ ] Deploy to the website and verify all policy links open, including on mobile.
- [ ] Keep the unsigned statement until an approved, signed release is actually published.
- [ ] If the website later adds telemetry, analytics, forms or external services, review and update its privacy disclosure separately from the desktop application's policy.

## 中文说明

本仓库中没有 `openshell.testnb.me` 的网站源码或发布配置，无法直接修改线上官网。上述代码只是一段待部署的页脚链接模板；部署完成前不能在 SignPath 申请中声称官网已修改。
