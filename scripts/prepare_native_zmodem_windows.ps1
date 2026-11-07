param(
    [string]$TargetDir = "build/bin/zmodem",
    [string]$Sidecar = "experiments/native-zmodem/target/release/zmodem-sidecar.exe"
)

$ErrorActionPreference = "Stop"
$target = [IO.Path]::GetFullPath($TargetDir)
$sidecarFile = [IO.Path]::GetFullPath($Sidecar)
if (!(Test-Path -LiteralPath $sidecarFile -PathType Leaf)) {
    throw "Rust ZMODEM sidecar not built: $sidecarFile"
}
if ((Get-Item -LiteralPath $sidecarFile).Length -le 0) {
    throw "Rust ZMODEM sidecar is empty: $sidecarFile"
}

# Fail closed: a reused staging directory must never retain legacy binaries,
# a previous MSYS2 DLL, or an out-of-date license/source archive.
if (Test-Path -LiteralPath $target) {
    Remove-Item -LiteralPath $target -Recurse -Force
}
$native = Join-Path $target "native"
New-Item -ItemType Directory -Path $native -Force | Out-Null

$launcher = Join-Path $target "openshell-zmodem-launcher.exe"
# Reuse the reviewed Windows version resource from the Wails executable build.
# This gives both first-party rz/sz wrappers the same ProductName/ProductVersion
# required by the SignPath Foundation signing policy.
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$resource = Join-Path $repoRoot "rsrc_windows_amd64.syso"
$launcherResource = Join-Path $repoRoot "cmd/zmodem-launcher/rsrc_windows_amd64.syso"
if (Test-Path -LiteralPath $launcherResource) {
    throw "Stale launcher version resource must not be reused: $launcherResource"
}
try {
    if (Test-Path -LiteralPath $resource -PathType Leaf) {
        Copy-Item -LiteralPath $resource -Destination $launcherResource
    } else {
        Write-Warning "Wails version resource was not generated; unsigned developer wrappers may lack product metadata"
    }
    & go build -mod=readonly -trimpath -ldflags '-s -w -H windowsgui' -o $launcher ./cmd/zmodem-launcher
    if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $launcher -PathType Leaf)) {
        throw "Unable to build native-only Windows ZMODEM launcher"
    }
} finally {
    Remove-Item -LiteralPath $launcherResource -Force -ErrorAction SilentlyContinue
}
try {
    foreach ($name in @("rz.exe", "sz.exe")) {
        Copy-Item -LiteralPath $launcher -Destination (Join-Path $target $name) -Force
    }
} finally {
    Remove-Item -LiteralPath $launcher -Force -ErrorAction SilentlyContinue
}
Copy-Item -LiteralPath $sidecarFile -Destination (Join-Path $native "zmodem-sidecar.exe") -Force

Write-Host "Windows ZMODEM uses Rust only: $target"
