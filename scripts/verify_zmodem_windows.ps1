param([string]$TargetDir = "build/bin/zmodem")

$ErrorActionPreference = "Stop"
$target = [IO.Path]::GetFullPath($TargetDir)

foreach ($name in @("rz.exe", "sz.exe")) {
    $launcher = Join-Path $target $name
    $original = Join-Path (Join-Path $target "native") $name
    foreach ($file in @($launcher, $original)) {
        if (!(Test-Path -LiteralPath $file -PathType Leaf)) {
            throw "Missing ZMODEM executable: $file"
        }
    }
    $bytes = [IO.File]::ReadAllBytes($launcher)
    if ($bytes.Length -lt 256) { throw "Invalid launcher: $launcher" }
    $headerOffset = [BitConverter]::ToInt32($bytes, 0x3c)
    if ($headerOffset -lt 0 -or $headerOffset + 96 -ge $bytes.Length) {
        throw "Invalid PE header: $launcher"
    }
    # PE32 and PE32+ both store the subsystem at optional-header offset 0x44.
    $subsystem = [BitConverter]::ToUInt16($bytes, $headerOffset + 24 + 0x44)
    if ($subsystem -ne 2) {
        throw "ZMODEM launcher is not Windows GUI subsystem (value $subsystem): $launcher"
    }

    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $launcher
    $start.Arguments = "--version"
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = [Diagnostics.Process]::Start($start)
    if ($null -eq $process) { throw "Failed to start ZMODEM helper: $launcher" }
    try {
        if (-not $process.WaitForExit(15000)) {
            $process.Kill()
            throw "ZMODEM helper did not exit: $launcher"
        }
        $output = $process.StandardOutput.ReadToEnd() + $process.StandardError.ReadToEnd()
        if ($process.ExitCode -ne 0) {
            throw "ZMODEM --version failed with $($process.ExitCode): $output"
        }
        if ([string]::IsNullOrWhiteSpace($output)) {
            throw "ZMODEM --version produced no output: $launcher"
        }
        Write-Host "$name through hidden launcher: $($output.Trim())"
    } finally {
        $process.Dispose()
    }
}
