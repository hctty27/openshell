#Requires -Version 5.1
param(
    [Parameter(Mandatory = $true)][string]$TargetDir,
    [Parameter(Mandatory = $true)][string]$Version
)

$ErrorActionPreference = "Stop"
$root = [IO.Path]::GetFullPath($TargetDir)
if (!(Test-Path -LiteralPath $root -PathType Container)) {
    throw "Signed ZMODEM helper directory does not exist: $root"
}

$expected = @("rz.exe", "sz.exe", "native/zmodem-sidecar.exe")
$files = @(Get-ChildItem -LiteralPath $root -File -Recurse | ForEach-Object {
    $_.FullName.Substring($root.TrimEnd('\', '/').Length + 1).Replace('\', '/')
})
$allowed = @($expected) + @("BUNDLED_COMPONENTS.json")
if ($files.Count -lt $expected.Count -or $files.Count -gt $allowed.Count -or
    @($files | Where-Object { $_ -notin $allowed }).Count -gt 0) {
    throw "Signed ZMODEM helper set differs from expected files: $($files -join ', ')"
}

foreach ($name in $expected) {
    $file = Join-Path $root $name
    if (!(Test-Path -LiteralPath $file -PathType Leaf)) {
        throw "Required signed ZMODEM helper is missing: $name"
    }
    ./scripts/verify_windows_signature.ps1 -Path $file -Version $Version -NativeHelper
}

Write-Host "PASS: all three first-party ZMODEM helpers have valid, timestamped signatures"
