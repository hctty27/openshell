#Requires -Version 5.1
[CmdletBinding()]
param(
    [ValidateSet("all", "large", "repeat", "parallel", "latency")]
    [string]$Profile = "all",

    [ValidateRange(1, 128)]
    [int]$LargeMiB = 128,

    [ValidateRange(1, 50)]
    [int]$Rounds = 30,

    [ValidateRange(1, 4)]
    [int]$Workers = 3,

    [ValidateRange(0, 10)]
    [int]$LatencyMS = 3,

    [string]$ReportDir = "",

    [switch]$Diagnostics,

    [ValidateSet(0, 4, 8, 16, 32)]
    [int]$WireBatchKiB = 16,

    [switch]$SkipBaseline
)

$ErrorActionPreference = "Stop"

# Keep the experimental batch setting process-local and restore it even if
# Docker, Go or Rust exits with an error. Zero uses the original per-frame path.
$batchEnvironmentName = "OPENSHELL_ZMODEM_WIRE_BATCH_BYTES"
$previousBatchValue = [Environment]::GetEnvironmentVariable($batchEnvironmentName, "Process")
try {
    [Environment]::SetEnvironmentVariable($batchEnvironmentName, "$($WireBatchKiB * 1024)", "Process")

    # Reuse the existing ephemeral Docker SSH fixture and its strict host-key pinning.
    # The stress suite must never fall back to a user's production SSH profile.
    & (Join-Path $PSScriptRoot "test-native-zmodem.ps1") `
        -LatencyMS 0 `
        -SkipFaultTests `
        -StressProfile $Profile `
        -StressLargeMiB $LargeMiB `
        -StressRounds $Rounds `
        -StressWorkers $Workers `
        -StressLatencyMS $LatencyMS `
        -StressReportDir $ReportDir `
        -StressDiagnostics:$Diagnostics `
        -SkipBaseline:$SkipBaseline

    if (-not $?) { throw "Native ZMODEM stress lab failed" }

}
finally {
    [Environment]::SetEnvironmentVariable($batchEnvironmentName, $previousBatchValue, "Process")
}
