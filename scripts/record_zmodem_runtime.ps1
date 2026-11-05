param(
    [string]$TargetDir = 'build/bin/zmodem'
)

$ErrorActionPreference = 'Stop'
$target = [IO.Path]::GetFullPath($TargetDir)
$manifestPath = Join-Path $target 'BUNDLED_COMPONENTS.json'
$dllPath = Join-Path $target 'native/msys-2.0.dll'

if (!(Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'Missing ZMODEM manifest' }
if (!(Test-Path -LiteralPath $dllPath -PathType Leaf)) { throw 'Missing MSYS2 runtime DLL' }

$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$dllEntry = @($manifest.files | Where-Object { $_.path -eq 'native/msys-2.0.dll' })
if ($dllEntry.Count -ne 1) { throw 'Expected exactly one MSYS2 DLL manifest record' }

$sha = (Get-FileHash -LiteralPath $dllPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($sha -ne $dllEntry[0].sha256) { throw 'MSYS2 DLL SHA-256 does not match the manifest' }

$version = [Diagnostics.FileVersionInfo]::GetVersionInfo($dllPath)
$metadata = [ordered]@{
    sha256 = $sha
    fileVersion = [string]$version.FileVersion
    productVersion = [string]$version.ProductVersion
    productName = [string]$version.ProductName
    companyName = [string]$version.CompanyName
    fileDescription = [string]$version.FileDescription
    originalFilename = [string]$version.OriginalFilename
    legalCopyright = [string]$version.LegalCopyright
    sourcePackageStatus = 'historical-msys2-source-package-unmatched'
    licenseStatus = 'manual-review-required'
}

$manifest | Add-Member -NotePropertyName 'msys2RuntimeEvidence' -NotePropertyValue $metadata -Force
$manifest | ConvertTo-Json -Depth 15 | Set-Content -LiteralPath $manifestPath -Encoding utf8
Write-Host ('Bundled MSYS2 runtime metadata: ' + ($metadata | ConvertTo-Json -Compress))
Write-Host 'Runtime licensing/source correlation remains unresolved until a matching historical source package is verified.'
