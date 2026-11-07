#Requires -Version 5.1
param(
    [Parameter(Mandatory = $true)][string]$TargetDir,
    [Parameter(Mandatory = $true)][string]$Version
)

$ErrorActionPreference = "Stop"
foreach ($name in @("rz.exe", "sz.exe", "native/zmodem-sidecar.exe")) {
    $path = Join-Path ([IO.Path]::GetFullPath($TargetDir)) $name
    if (!(Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Native helper is missing: $path"
    }
    $info = (Get-Item -LiteralPath $path).VersionInfo
    if ($info.ProductName -ne "OpenShell" -or $info.ProductVersion -ne $Version) {
        throw "Invalid native helper product metadata for ${name}: name=$($info.ProductName), version=$($info.ProductVersion), expected OpenShell $Version"
    }
    Write-Host "PASS: $name product metadata = OpenShell $Version"
}
