# Code signing policy — OpenShell

> **Current status (2026-11-07):** The repository has a conditional SignPath workflow, but Foundation approval and the first signed release are **not confirmed**. The original v1.0.0 build is unsigned. Check each GitHub Release for its actual signing status; a policy file does not provide a certificate.

Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/) **only if the project is accepted and the release has actually been signed**.

## Project and official distribution

- Source: https://github.com/hctty27/openshell (MIT).
- Official downloads: https://github.com/hctty27/openshell/releases.
- Supported release platform: Windows x64, installation executable and portable ZIP.
- The status of each download (signed or unsigned) must be disclosed in its own Release notes. Signing a later version does not retroactively sign v1.0.0.

## Scope: what may be signed

- Only OpenShell's own release binaries produced from reviewed source: Wails `OpenShell.exe`, NSIS `OpenShell-vX.Y.Z-windows-x64-Setup.exe`, and the first-party Go/Rust ZMODEM executables `zmodem/rz.exe`, `zmodem/sz.exe`, and `zmodem/native/zmodem-sidecar.exe`.
- The portable ZIP is an archive of the app and first-party ZMODEM helpers; the ZIP container itself is **not Authenticode-signed**. When release signing is active, all four contained EXEs are verified before publication.
- Native ZMODEM helpers are built in OpenShell's workflow, not downloaded third-party EXEs. A dedicated SignPath configuration signs exactly those three binaries, before creating the ZIP/installer. Their Go/Rust dependencies remain subject to license obligations. Historical lrzsz-win32 and MSYS2 binaries are no longer shipped. See [third-party review](docs/third-party-review.md).
- The Wails EXE and NSIS installer must carry the expected `OpenShell` product name and release version, enforced by `initial.xml`. The Go/Rust helper executables currently lack the same Wails/NSIS version-resource metadata; `native-helpers.xml` instead constrains exact archive paths and verifies the SignPath Foundation publisher, timestamp and resulting release manifest hashes.

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
4. Submit three signing requests: one exact-path ZIP containing the three first-party ZMODEM helpers, one for `OpenShell.exe`, and one for the NSIS installer. Never sign upstream third-party programs with the OpenShell certificate.
5. Enforce product name and version for OpenShell/NSIS; verify all five signed executable files (three helpers, app, installer) have valid Authenticode signatures, the expected certificate publisher and timestamps. Regenerate the native helper SHA-256 manifest **after** signing and validate signed ZIP and installed NSIS payloads.
6. Only release builds from `main` can request SignPath signatures; pull-request and dry-run builds never submit signing requests. When `SIGNPATH_REQUIRED=true` is configured after approval, an absent token or missing organization ID fails a release instead of silently publishing unsigned artifacts.
7. Never replace published release binaries without creating a new release; publish the source commit, version, and truthful signing status. A signing failure must not be described as a signed release.

The GitHub Actions workflow implements conditional SignPath requests. Until the maintainer explicitly sets `SIGNPATH_REQUIRED=true`, it permits unsigned releases when the signing token is absent. The required SignPath account, Foundation approval, trusted-build policy, per-request manual approvals and uploaded artifact configuration must be confirmed outside this repository before enabling signing. The `initial.xml` configuration requires exactly one top-level OpenShell executable or installer per request. The separate `native-helpers.xml` configuration requires exactly the three first-party ZMODEM helpers at fixed paths. Both XML configurations must be uploaded to the SignPath portal before enabling a signed release.

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

原始 `v1.0.0` Windows 正式版**未签名**；后续各版本以 GitHub Release 说明和实际 Authenticode 验证为准。SignPath Foundation 是否批准仍未确认，本政策不代表已经取得证书。

- 代码工作流已扩展到 OpenShell 主程序、NSIS 安装包和三个自建 ZMODEM 辅助 EXE；签名前先检查三个辅助文件的固定路径，签名后重算 SHA-256，再验证安装版和便携版内的签名。旧版第三方 MSYS2/lrzsz 不在签名范围且不再随包分发。
- 仓库维护者、外部贡献审核者、签名审批者目前均为 [@hctty27](https://github.com/hctty27)，需要自行确认已开启 GitHub 和 SignPath MFA。
- 每次正式版签名需要由审批者在 SignPath **人工批准**，并验证来源、版本元数据和签名。
- 用户数据行为见 [隐私政策](PRIVACY.md)，第三方授权待核事项见 [审查记录](docs/third-party-review.md)。
