# Code signing policy — OpenShell

> **Current status (2026-11-05):** OpenShell v1.0.0 for Windows x64 is **unsigned**. SignPath Foundation approval and the first signed release have **not** been confirmed. This document describes the proposed policy; publishing it does not grant a certificate or change the status of earlier releases.

Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/) **only if the project is accepted and the release has actually been signed**.

## Project and official distribution

- Source: https://github.com/hctty27/openshell (MIT).
- Official downloads: https://github.com/hctty27/openshell/releases.
- Supported release platform: Windows x64, installation executable and portable ZIP.
- The status of each download (signed or unsigned) must be disclosed in its own Release notes. Signing a later version does not retroactively sign v1.0.0.

## Scope: what may be signed

- Only OpenShell's own release binaries produced from the reviewed repository: the Wails-generated `OpenShell.exe` and the NSIS `OpenShell-vX.Y.Z-windows-x64-Setup.exe`.
- The portable ZIP is an archive containing OpenShell's executable and third-party ZMODEM helpers; it is **not itself Authenticode-signed**.
- Bundled upstream `zmodem/native/rz.exe`, `zmodem/native/sz.exe` and `zmodem/native/msys-2.0.dll` are third-party binaries. They must **not** be submitted for signing with OpenShell's SignPath Foundation certificate. Their redistribution/license obligations must be independently satisfied. See [third-party review](docs/third-party-review.md).
- All signed PE files must carry matching `OpenShell` product name and build version metadata, enforced in the SignPath artifact configuration.

## Team roles

| Role | Member | Responsibility |
| --- | --- | --- |
| Authors / trusted committers | [@hctty27](https://github.com/hctty27) | Maintain source and build scripts |
| Reviewers | [@hctty27](https://github.com/hctty27) | Review changes proposed by contributors outside the trusted committer set before merge |
| Release signing approver | [@hctty27](https://github.com/hctty27) | Review the exact release and explicitly approve or deny each SignPath signing request |

Any additional maintainer must be listed here before being granted signing authority. Every member must enable multi-factor authentication for both GitHub and SignPath. Account MFA status cannot be verified from this public repository and remains a required operator check.

## Release signing safeguards

1. Build only from a reviewed immutable commit on `main` using GitHub-hosted Actions; CI must pass before public packaging.
2. Configure SignPath's **trusted GitHub build system** and **origin verification** for `https://github.com/hctty27/openshell`. Restrict release signing to the intended branch and project.
3. Require **manual approval for every release signing request** in the SignPath `release-signing` policy. A successful CI run is not signing approval.
4. Submit separate first-party OpenShell executable and installer artifacts from the workflow to SignPath; do not re-sign third-party programs.
5. Enforce product name and product version in the SignPath artifact configuration; verify the signed `OpenShell.exe` and NSIS installer have a valid Authenticode signature, expected certificate publisher, and valid timestamp before publishing them as signed.
6. Never replace published release binaries without creating a new release; publish the source commit, version, and truthful signing status. A signing failure must not be described as a signed release.

The existing GitHub Actions workflow implements conditional SignPath requests; it publishes unsigned artifacts if signing is not configured. The required SignPath account, Foundation approval, trusted-build policy, manual approval setting, and uploaded artifact configuration must be confirmed outside this repository before enabling signing.

## Privacy, installation and reporting

- [Privacy policy](PRIVACY.md) details local storage, user-directed SSH/SFTP connections, user-configured AI providers, and local diagnostics.
- [Third-party licensing and distribution review](docs/third-party-review.md) records open compliance work; do not treat it as certification.
- The Windows installer creates per-user program files, shortcuts, and uninstall entries. Uninstall removes installed program files/shortcuts but does **not** promise to delete stored profiles, SSH credentials, or AI history; see the privacy policy.
- Report ordinary issues at https://github.com/hctty27/openshell/issues without posting secrets or diagnostics containing sensitive content. Report suspected misuse of a SignPath Foundation certificate to support@signpath.io.

## References

- [SignPath Foundation conditions](https://signpath.org/terms)
- [SignPath project and signing-policy configuration](https://docs.signpath.io/projects)

---

## 中文说明

当前 `v1.0.0` 是**未签名**的 Windows 正式版，SignPath Foundation 尚未确认批准。本文件是待执行的签名政策，不代表已经拿到证书。

- 仅对 OpenShell 自己构建的 `OpenShell.exe` 和 NSIS 安装包申请签名，不对打包的第三方 `rz/sz` 或 `msys-2.0.dll` 使用项目证书。
- 仓库维护者、外部贡献审核者、签名审批者目前均为 [@hctty27](https://github.com/hctty27)，需要自行确认已开启 GitHub 和 SignPath MFA。
- 每次正式版签名需要由审批者在 SignPath **人工批准**，并验证来源、版本元数据和签名。
- 用户数据行为见 [隐私政策](PRIVACY.md)，第三方授权待核事项见 [审查记录](docs/third-party-review.md)。
