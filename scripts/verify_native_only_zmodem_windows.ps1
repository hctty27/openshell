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
