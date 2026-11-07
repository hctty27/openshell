#Requires -Version 5.1
param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Version,
    [switch]$NativeHelper
)

$ErrorActionPreference = "Stop"
$fullPath = [IO.Path]::GetFullPath($Path)
if (!(Test-Path -LiteralPath $fullPath -PathType Leaf)) {
    throw "Signed Windows executable not found: $fullPath"
}

$signature = Get-AuthenticodeSignature -LiteralPath $fullPath
if ($signature.Status -ne "Valid" -or !$signature.SignerCertificate) {
    throw "Invalid or missing Authenticode signature for $fullPath ($($signature.Status))"
}

$publisher = $signature.SignerCertificate.GetNameInfo(
    [System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,
    $false
)
if ($publisher -ne "SignPath Foundation") {
    throw "Unexpected signing publisher for $($fullPath): $publisher"
}

$metadata = (Get-Item -LiteralPath $fullPath).VersionInfo
if ($NativeHelper -and [IO.Path]::GetFileName($fullPath) -notin @("rz.exe", "sz.exe", "zmodem-sidecar.exe")) {
    throw "Unexpected first-party ZMODEM helper: $fullPath"
}
if ($metadata.ProductName -ne "OpenShell" -or $metadata.ProductVersion -ne $Version) {
    throw "Invalid product metadata for $($fullPath): name=$($metadata.ProductName), version=$($metadata.ProductVersion), expected=$Version"
}

if (!$signature.TimeStamperCertificate) {
    throw "Missing Authenticode timestamp for $fullPath"
}

Write-Host "Signature verified: $fullPath"
Write-Host "  Publisher: $publisher"
Write-Host "  Product: $($metadata.ProductName) $($metadata.ProductVersion)"
Write-Host "  Timestamp authority: $($signature.TimeStamperCertificate.Subject)"
