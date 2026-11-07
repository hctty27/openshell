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
# Generate a launcher-specific PE resource. Go picks up .syso files only
# when they are present in the actual package directory at build time.
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$launcherResource = Join-Path $repoRoot "cmd/zmodem-launcher/rsrc_windows_amd64.syso"
$wails = Join-Path (go env GOPATH).Trim() "bin/wails3.exe"
if (!(Test-Path -LiteralPath $wails -PathType Leaf)) {
    throw "Wails CLI is required to embed Windows helper version resources: $wails"
}
if (Test-Path -LiteralPath $launcherResource) {
    throw "Stale launcher version resource must not be reused: $launcherResource"
}
try {
    & $wails generate syso -manifest build/windows/wails.exe.manifest -icon build/windows/icon.ico -info build/windows/info.json -arch amd64 -out $launcherResource
    if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $launcherResource -PathType Leaf)) {
        throw "Failed to generate Windows launcher version resource"
    }
    Write-Host "Generated launcher resource: $launcherResource ($((Get-Item $launcherResource).Length) bytes)"
    $packageInfo = (& go list -json ./cmd/zmodem-launcher | ConvertFrom-Json)
    if ($LASTEXITCODE -ne 0 -or "rsrc_windows_amd64.syso" -notin @($packageInfo.SysoFiles)) {
        throw "Go package did not recognize launcher resource: $(@($packageInfo.SysoFiles) -join ', ')"
    }
    & go build -mod=readonly -trimpath -ldflags '-s -w -H windowsgui' -o $launcher ./cmd/zmodem-launcher
    if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $launcher -PathType Leaf)) {
        throw "Unable to build native-only Windows ZMODEM launcher"
    }
    $resourceInfo = (Get-Item -LiteralPath $launcher).VersionInfo
    Write-Host "Built launcher PE metadata: ProductName=$($resourceInfo.ProductName); ProductVersion=$($resourceInfo.ProductVersion); FileVersion=$($resourceInfo.FileVersion)"
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
