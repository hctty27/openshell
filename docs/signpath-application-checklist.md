# SignPath Foundation application checklist — OpenShell

Updated 2026-11-07. **Repository readiness checklist only — not proof of application, approval, or a signed release.** Verify the latest release status at https://github.com/hctty27/openshell/releases.

## Completed in source control

- [x] Public, actively maintained MIT-licensed Windows x64 project with installer and portable ZIP.
- [x] Publish [Code signing policy](../CODE_SIGNING_POLICY.md), [Privacy policy](../PRIVACY.md), and third-party review links in the READMEs and new [website source](../website/).
- [x] Document authors, reviewers, signing approver, manual approval requirement, and use of user-configured network services.
- [x] Integrate SignPath signing of the first-party `OpenShell.exe` and NSIS installer with publisher, version, Authenticode timestamp, and installed-EXE checks.
- [x] Restrict signing to real `main` release runs; PR and manual build previews never submit a signing request. Optional `SIGNPATH_REQUIRED=true` prevents an accidentally unsigned official release after signing is enabled.
- [x] Configure the [artifact XML](../.signpath/artifact-configurations/initial.xml) to require exactly **one** matching OpenShell binary per request.
- [x] Generate Go/npm CycloneDX inventories and record native Rust ZMODEM release hashes; automated inventories are **not** license clearance.
- [x] Current native-only Windows packaging excludes `lrzsz-win32` binaries and `msys-2.0.dll`. Keep any unresolved historical binary/source attribution in the [historical review](third-party-review.md), not as a claim that current installers still bundle MSYS2.

## Maintainer actions before submitting the application

- [ ] Verify that each GitHub and SignPath author, reviewer and approver uses MFA. This cannot be confirmed through the public repository.
- [ ] Verify team roles and require member review of contributions from outside the trusted committer set.
- [ ] Read the latest [SignPath Foundation eligibility terms](https://signpath.org/terms). SignPath reviews maintenance/reputation and Foundation approval is discretionary.
- [ ] Inspect the actual current installer/portable ZIP on Windows, including upgrades from old MSYS2/lrzsz installations, uninstall behavior and third-party notices.
- [ ] Finish license/notice review for the **current** Go, npm and **Rust** dependencies. The existing SBOM includes Go and npm, but does not yet fully inventory/clear the Rust transitive graph. The historical MSYS2 3.4.9 correspondence issue remains documented for older releases.
- [ ] Verify the [website](https://openshell.testnb.me/) really serves the policies and download links after Cloudflare Pages deployment. Links exist in `website/index.html`, but repository files alone do not prove production deployment.
- [ ] Review any privacy policy changes arising from website analytics, auto-updaters or new network features.
- [ ] Submit the application at https://signpath.org/apply. Do not represent the project as approved until SignPath confirms it.

## SignPath portal and release setup **after approval**

- [ ] Create or activate SignPath project `openshell` tied to `https://github.com/hctty27/openshell`, with the GitHub trusted build system, GitHub App and origin verification.
- [ ] Configure a `release-signing` policy that only accepts intended `main` builds, uses the Foundation certificate, and **requires a human approval for every signing request**.
- [ ] Upload the reviewed `initial.xml` as artifact configuration `initial`. Confirm the product-name/version restrictions match EXE and NSIS binaries and each signing request selects exactly one file.
- [ ] Set GitHub Actions secret `SIGNPATH_API_TOKEN`, repository variable `SIGNPATH_ORGANIZATION_ID`, and optionally `SIGNPATH_PROJECT_SLUG`, `SIGNPATH_SIGNING_POLICY_SLUG`, `SIGNPATH_ARTIFACT_CONFIGURATION_SLUG`. Never commit credentials.
- [ ] Once ready to enforce signatures, set GitHub Actions variable `SIGNPATH_REQUIRED=true`. This prevents unsigned official releases if the token is missing; unset it only when intentionally allowing unsigned releases.
- [ ] Run a new controlled release. Approve both the EXE and installer requests manually, verify signer, timestamp, product name/version and installed EXE using Windows Authenticode.
- [ ] Evaluate additional signing coverage for first-party `zmodem/rz.exe`, `zmodem/sz.exe` and `zmodem/native/zmodem-sidecar.exe`; the current release workflow signs only the app and installer.
- [ ] Publish the actual signed/unsigned state in the release notes; never silently overwrite previously published unsigned assets.

## Source / verification references

- Source: https://github.com/hctty27/openshell
- Current Windows workflow: [windows-release.yml](../.github/workflows/windows-release.yml)
- Artifact rules: [initial.xml](../.signpath/artifact-configurations/initial.xml)
- SBOM: [sbom.md](sbom.md)
- Third-party review: [third-party-review.md](third-party-review.md)
- SignPath policy: https://signpath.org/terms
- SignPath GitHub connector: https://docs.signpath.io/trusted-build-systems/github

## 中文结论

目前能在代码仓库内完成的发布防护、签名配置和申请材料可以先准备；**Foundation 审批、账号 MFA、API Token、实际官网部署确认及首次真实签名**必须由账户维护者完成。原生 Rust ZMODEM 已移除随包分发的 MSYS2 DLL，但新 Rust 依赖的授权核对仍然需要完成。
