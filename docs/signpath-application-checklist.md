# SignPath Foundation application checklist — OpenShell

Updated 2026-11-05. **This is a readiness checklist, not an application or approval confirmation.** The maintainer must complete the account and website actions below.

## Completed in repository

- [x] Public maintained MIT project with a released Windows x64 installer and portable ZIP.
- [x] Publish [Code signing policy](../CODE_SIGNING_POLICY.md) and [Privacy policy](../PRIVACY.md), link them from both READMEs.
- [x] Document the current unsigned status accurately and list signing roles, their GitHub member account, manual approval rule, approved artifact scope and user-initiated network transfers.
- [x] Record actual bundled ZMODEM artifacts, pinned upstream SHA-256 and outstanding third-party license checks in [third-party review](third-party-review.md).
- [x] Existing workflow has conditional SignPath request code and Authenticode validity checks; unsigned releases continue working without an API token.
- [x] Automated [CycloneDX dependency SBOM and ZMODEM binary hash manifest](sbom.md); license metadata gaps remain visible and do not count as clearance.
- [x] Record [historical MSYS2 3.4.9 candidate license texts](../third_party/msys2-runtime-3.4.9/README.md) and pin the exact bundled DLL SHA-256. Corresponding-source verification remains open.

## Maintainer verification required before applying

- [ ] Confirm GitHub and SignPath **MFA** is enabled for every author/reviewer/approver. Public repository APIs cannot confirm this.
- [ ] Verify reviewers' and approver's names/roles and that every contribution from outside the trusted committer set receives review.
- [ ] Review [SignPath Foundation eligibility](https://signpath.org/terms), project reputation, maintenance and executable restrictions; obtain Foundation approval (not guaranteed).
- [ ] Complete the [third-party review](third-party-review.md), especially `msys-2.0.dll` and full Go/npm dependency notices; confirm no prohibited proprietary bundled code.
- [ ] Deploy [website policy links](website-policy-links.md) on the separately hosted [OpenShell website](https://openshell.testnb.me/), and verify the actual footer/download section displays **Code signing policy** and **Privacy policy** links. The website's source is not in this repository; publishing the snippet alone does not complete this step.
- [ ] Confirm privacy accuracy for any website, analytics, new updater, or externally hosted features that may not be in the reviewed desktop repository.
- [ ] Perform a native Windows installer, portable and upgrade acceptance test and preserve evidence.

## SignPath portal setup after approval

- [ ] Create SignPath project `openshell` with repository URL `https://github.com/hctty27/openshell`; configure the trusted GitHub Actions build-system connector and origin verification.
- [ ] Configure `release-signing` with a Foundation certificate, approved submits, branch restriction to `main`, and **at least one human approval required for each signing request**.
- [ ] Upload the reviewed XML from `.signpath/artifact-configurations/initial.xml` as artifact configuration `initial`; align both the EXE and installer metadata restrictions, especially product name and version.
- [ ] Set GitHub Actions secret `SIGNPATH_API_TOKEN` and required repository variables (`SIGNPATH_ORGANIZATION_ID`, `SIGNPATH_PROJECT_SLUG`, `SIGNPATH_SIGNING_POLICY_SLUG`, `SIGNPATH_ARTIFACT_CONFIGURATION_SLUG`) without committing credentials.
- [ ] Run a controlled test release and inspect every SignPath signing request's origin, approvals, version metadata, and the actual signed executable/installer using Windows Authenticode verification.
- [ ] Confirm the **installed** executable preserves its original signed bytes. Record if any included upstream binaries have independent signatures, and do not sign them as first-party artifacts.
- [ ] Publish release notes with true signing status and the Code signing policy; do not silently replace old unsigned assets.

## Suggested application facts (verify before submission)

- Project: OpenShell
- Source: https://github.com/hctty27/openshell
- License: MIT (first-party source); bundled upstream OSS licensing is documented separately and still under review.
- Owner and maintainer: https://github.com/hctty27
- Release: https://github.com/hctty27/openshell/releases/tag/v1.0.0 (unsigned)
- Builds: `.github/workflows/ci.yml` and `.github/workflows/windows-release.yml`
- Product: free and open-source Windows x64 SSH/SFTP client, with multi-session terminals, split panes, file transfer and optional user-configured AI providers.
- Policy: [Code signing policy](../CODE_SIGNING_POLICY.md); privacy: [Privacy policy](../PRIVACY.md)

Official entry: https://signpath.org/apply

---

## 中文提醒

**文档与代码提交不等于申请或审核通过。** 需要维护者在 GitHub / SignPath 账户开启 MFA、确认审批人、核对第三方许可证、在独立官网添加政策入口、配置 SignPath 受信任构建与每次人工签名审批，最后自行提交申请。

目前 OpenShell v1.0.0 仍然是未签名版本；后续若开始签名，必须在对应 Release 明确说明，不能修改历史记录造成误导。
