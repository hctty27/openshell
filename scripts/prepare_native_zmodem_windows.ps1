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
& go build -mod=readonly -trimpath -ldflags '-s -w -H windowsgui' -o $launcher ./cmd/zmodem-launcher
if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $launcher -PathType Leaf)) {
    throw "Unable to build native-only Windows ZMODEM launcher"
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
