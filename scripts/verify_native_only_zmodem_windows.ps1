#Requires -Version 5.1
param([string]$TargetDir = "dist/native-zmodem-preview/zmodem")

$ErrorActionPreference = "Stop"
$target = [IO.Path]::GetFullPath($TargetDir)
foreach ($required in @("rz.exe", "sz.exe", "native/zmodem-sidecar.exe")) {
    $file = Join-Path $target $required
    if (!(Test-Path -LiteralPath $file -PathType Leaf)) {
        throw "Missing required native Rust ZMODEM helper: $file"
    }
}
foreach ($forbidden in @(
    "native/rz.exe", "native/sz.exe", "native/msys-2.0.dll",
    "lrzsz-win32-source.zip", "COPYING-lrzsz.txt"
)) {
    if (Test-Path -LiteralPath (Join-Path $target $forbidden)) {
        throw "Native-only package contains obsolete lrzsz/MSYS2 dependency: $forbidden"
    }
}

# Refuse to distribute even a stray copy of MSYS2 or old lrzsz from a
# previously reused build directory. Only the two first-party wrappers,
# Rust sidecar and its optional generated inventory may be present.
$allowed = @(
    "rz.exe",
    "sz.exe",
    "native/zmodem-sidecar.exe",
    "BUNDLED_COMPONENTS.json"
)
foreach ($file in (Get-ChildItem -LiteralPath $target -File -Recurse)) {
    $relative = $file.FullName.Substring($target.TrimEnd('\').Length + 1).Replace('\', '/')
    if ($relative -notin $allowed) {
        throw "Unexpected ZMODEM file in native-only distribution: $relative"
    }
}
$manifestFile = Join-Path $target "BUNDLED_COMPONENTS.json"
if (Test-Path -LiteralPath $manifestFile -PathType Leaf) {
    $manifest = Get-Content -LiteralPath $manifestFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.bundleMode -ne "rust-native-only" -or $manifest.msys2Bundled -ne $false -or
        $manifest.lrzszWin32Bundled -ne $false) {
        throw "Native-only bundle manifest reports an invalid engine"
    }
    foreach ($entry in @($manifest.files)) {
        $file = Join-Path $target $entry.path
        if ($entry.path -notin $allowed -or !(Test-Path -LiteralPath $file -PathType Leaf)) {
            throw "Invalid native ZMODEM manifest entry: $($entry.path)"
        }
        $sha = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($sha -ne $entry.sha256) {
            throw "Native ZMODEM bundle manifest SHA-256 mismatch: $($entry.path)"
        }
    }
}

foreach ($name in @("rz.exe", "sz.exe")) {
    $file = Join-Path $target $name
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $file
    $start.Arguments = "--version"
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = [Diagnostics.Process]::Start($start)
    if ($null -eq $process) { throw "Failed to start native wrapper $name" }
    try {
        if (-not $process.WaitForExit(15000)) {
            $process.Kill()
            throw "Native wrapper $name timed out"
        }
        $output = $process.StandardOutput.ReadToEnd() + $process.StandardError.ReadToEnd()
        if ($process.ExitCode -ne 0 -or $output -notmatch 'OpenShell native Rust ZMODEM') {
            throw "$name did not launch Rust sidecar (code $($process.ExitCode)): $output"
        }
        Write-Host "PASS Rust-only $name -> native sidecar"
    } finally { $process.Dispose() }
}
