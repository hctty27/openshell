param(
    [string]$TargetDir = "build/bin/zmodem"
)

$ErrorActionPreference = "Stop"
$version = "v0.12.21rc"
$expectedSha256 = "dace2db172b1b5a1e5998692760a75355b254e1826718d88bae7fa3a6de3c325"
$expectedRuntimeSha256 = "fb6136d849fb7a28a2d9aa7684394f6d20252942f129d2ea90ba709691a62bad"
$msys2CandidateCommit = "677ece60fc37b0c5d336db1e345a4c33ffff15f6"
$assetUrl = "https://github.com/trzsz/lrzsz-win32/releases/download/$version/lrzsz_0.12.21rc_windows_x86_64.zip"
$sourceUrl = "https://github.com/trzsz/lrzsz-win32/archive/2e46d4258035cea45262244f59c34d0db4fae2a7.zip"
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("openshell-lrzsz-" + [Guid]::NewGuid().ToString("N"))
$archive = Join-Path $tempRoot "lrzsz.zip"
$extractDir = Join-Path $tempRoot "lrzsz"
$sourceArchive = Join-Path $tempRoot "lrzsz-source.zip"
$sourceDir = Join-Path $tempRoot "source"
$target = [System.IO.Path]::GetFullPath($TargetDir)

New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
try {
    Invoke-WebRequest -Uri $assetUrl -OutFile $archive
    $actualSha256 = (Get-FileHash -Path $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualSha256 -ne $expectedSha256) {
        throw "Unexpected lrzsz archive checksum: $actualSha256"
    }
    Expand-Archive -Path $archive -DestinationPath $extractDir -Force

    $rzFile = Get-ChildItem $extractDir -Recurse -File -Filter rz.exe | Select-Object -First 1
    if ($null -eq $rzFile) { throw "rz.exe missing from verified lrzsz archive" }
    $sourceBinDir = $rzFile.Directory.FullName
    foreach ($file in @("rz.exe", "sz.exe", "msys-2.0.dll")) {
        if (!(Test-Path -LiteralPath (Join-Path $sourceBinDir $file) -PathType Leaf)) {
            throw "Required lrzsz file missing: $file"
        }
    }

    Invoke-WebRequest -Uri $sourceUrl -OutFile $sourceArchive
    Expand-Archive -Path $sourceArchive -DestinationPath $sourceDir -Force
    $copying = Get-ChildItem $sourceDir -Recurse -File -Filter COPYING | Select-Object -First 1
    if ($null -eq $copying) { throw "GPL COPYING missing from upstream source archive" }

    New-Item -ItemType Directory -Path $target -Force | Out-Null
    $native = Join-Path $target "native"
    New-Item -ItemType Directory -Path $native -Force | Out-Null
    foreach ($file in @("rz.exe", "sz.exe", "msys-2.0.dll")) {
        Copy-Item -LiteralPath (Join-Path $sourceBinDir $file) -Destination (Join-Path $native $file) -Force
    }
    $runtimeSha256 = (Get-FileHash -LiteralPath (Join-Path $native "msys-2.0.dll") -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($runtimeSha256 -ne $expectedRuntimeSha256) {
        throw "Unexpected bundled MSYS2 runtime checksum: $runtimeSha256"
    }
    $msys2LicenseDir = "third_party/msys2-runtime-3.4.9"
    $licenseFiles = @{
        "CYGWIN_LICENSE" = "CYGWIN_LICENSE-msys2.txt"
        "COPYING.LIB" = "COPYING-LGPLv3-msys2.txt"
        "COPYING" = "COPYING-GPLv3-msys2.txt"
    }
    foreach ($licenseFile in $licenseFiles.GetEnumerator()) {
        $licensePath = Join-Path $msys2LicenseDir $licenseFile.Key
        if (!(Test-Path -LiteralPath $licensePath -PathType Leaf)) { throw "Missing bundled MSYS2 license notice: $licensePath" }
        Copy-Item -LiteralPath $licensePath -Destination (Join-Path $target $licenseFile.Value) -Force
    }

    # rz/sz are console programs. trzsz-go starts them without CREATE_NO_WINDOW;
    # a Windows GUI-subsystem launcher forwards stdio and starts the unmodified
    # tools with CREATE_NO_WINDOW. The native filenames remain rz.exe / sz.exe,
    # which is significant to lrzsz protocol selection.
    $launcher = Join-Path $target "openshell-zmodem-launcher.exe"
    & go build -trimpath -ldflags '-s -w -H windowsgui' -o $launcher ./cmd/zmodem-launcher
    if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $launcher)) {
        throw "Unable to build headless ZMODEM launcher"
    }
    foreach ($name in @("rz.exe", "sz.exe")) {
        Copy-Item -LiteralPath $launcher -Destination (Join-Path $target $name) -Force
    }
    Remove-Item -LiteralPath $launcher -Force
    Copy-Item -LiteralPath $copying.FullName -Destination (Join-Path $target "COPYING-lrzsz.txt") -Force
    Copy-Item -LiteralPath $sourceArchive -Destination (Join-Path $target "lrzsz-win32-source.zip") -Force
    @"
Bundled ZMODEM helper tools (separate GPL-2.0 program) and OpenShell MIT-licensed Windows launchers
Upstream: https://github.com/trzsz/lrzsz-win32
Release: $version
Upstream source commit: 2e46d4258035cea45262244f59c34d0db4fae2a7
Source archive: lrzsz-win32-source.zip
License: COPYING-lrzsz.txt (GPL-2.0)
Includes msys-2.0.dll from upstream binary release.
MSYS2 runtime source and licensing: https://github.com/msys2/msys2-runtime
Runtime DLL version: 3.4.9
Runtime DLL SHA-256: $expectedRuntimeSha256
MSYS2 source candidate snapshot: https://github.com/msys2/msys2-runtime/tree/$msys2CandidateCommit
Reference license files from that immutable source snapshot: CYGWIN_LICENSE-msys2.txt, COPYING-LGPLv3-msys2.txt, COPYING-GPLv3-msys2.txt
Important: Candidate source snapshot has NOT been proven to match the exact upstream DLL build/package revision. No source-equivalence or license-clearance claim is made.
Upstream binary ZIP SHA-256: $expectedSha256

The unmodified upstream binaries are in native/. The top-level rz.exe and sz.exe
are OpenShell GUI-subsystem launchers that run those original programs without
opening a new console and forward standard input/output/error unchanged.

The OpenShell launcher source is cmd/zmodem-launcher/ (MIT).
"@ | Set-Content -LiteralPath (Join-Path $target "THIRD_PARTY_NOTICES.txt") -Encoding UTF8
    Write-Host "Bundled verified ZMODEM helpers in $target"
} finally {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
