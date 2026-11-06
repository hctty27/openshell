#Requires -Version 5.1
param(
    [Parameter(Mandatory=$true)][string]$Installer,
    [switch]$VerifySigned,
    [string]$Version
)

$ErrorActionPreference = "Stop"
if ($VerifySigned -and [string]::IsNullOrWhiteSpace($Version)) { throw "Version is required for signed installer validation" }
$installerFile = [IO.Path]::GetFullPath($Installer)
if (!(Test-Path -LiteralPath $installerFile -PathType Leaf)) {
    throw "Installer not found: $installerFile"
}
$testRoot = Join-Path $env:RUNNER_TEMP "openshell-native-upgrade-test"
$installation = Join-Path $testRoot "OpenShell"
if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
$native = Join-Path $installation "zmodem\native"
New-Item -ItemType Directory -Force -Path $native | Out-Null
foreach ($name in @("rz.exe", "sz.exe", "msys-2.0.dll")) {
    Set-Content -LiteralPath (Join-Path $native $name) -Value "obsolete fixture"
}
Set-Content -LiteralPath (Join-Path $installation "zmodem\COPYING-lrzsz.txt") -Value "obsolete fixture"
try {
    # NSIS /D= must be the last argument, with no quotes around the path.
    $process = Start-Process -FilePath $installerFile -ArgumentList @("/S", "/D=$installation") -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Silent upgrade failed with exit code $($process.ExitCode)" }
    foreach ($forbidden in @(
        "zmodem/native/rz.exe", "zmodem/native/sz.exe",
        "zmodem/native/msys-2.0.dll", "zmodem/COPYING-lrzsz.txt"
    )) {
        if (Test-Path -LiteralPath (Join-Path $installation $forbidden)) {
            throw "Upgrade left obsolete Windows lrzsz/MSYS2 component: $forbidden"
        }
    }
    ./scripts/verify_native_only_zmodem_windows.ps1 -TargetDir (Join-Path $installation "zmodem")
    if (!(Test-Path -LiteralPath (Join-Path $installation "OpenShell.exe") -PathType Leaf)) {
        throw "Upgraded OpenShell.exe is missing"
    }
    if ($VerifySigned) {
        ./scripts/verify_windows_signature.ps1 -Path (Join-Path $installation "OpenShell.exe") -Version $Version
    }
    Write-Host "PASS: Native Rust-only NSIS upgrade removed all old ZMODEM helpers"
} finally {
    $uninstaller = Join-Path $installation "Uninstall.exe"
    if (Test-Path -LiteralPath $uninstaller -PathType Leaf) {
        $process = Start-Process -FilePath $uninstaller -ArgumentList "/S" -Wait -PassThru
        if ($process.ExitCode -ne 0) {
            Write-Warning "Test uninstaller exited with $($process.ExitCode)"
        }
    }
    if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
}
