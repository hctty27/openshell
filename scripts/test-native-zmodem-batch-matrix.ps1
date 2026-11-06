#Requires -Version 5.1
[CmdletBinding()]
param(
    [ValidateRange(1, 10)]
    [int]$Rounds = 5,

    [string]$ReportDir = "",

    [switch]$SkipBaseline
)

$ErrorActionPreference = "Stop"

# The matrix owns the sidecar batch setting for each sample. Reset the
# inherited value for the ordinary baseline and restore it when finished.
$environmentName = "OPENSHELL_ZMODEM_WIRE_BATCH_BYTES"
$previousValue = [Environment]::GetEnvironmentVariable($environmentName, "Process")
try {
    [Environment]::SetEnvironmentVariable($environmentName, "0", "Process")
    & (Join-Path $PSScriptRoot "test-native-zmodem.ps1") `
        -LatencyMS 0 `
        -SkipFaultTests `
        -StressBatchMatrix `
        -StressMatrixRounds $Rounds `
        -StressReportDir $ReportDir `
        -SkipBaseline:$SkipBaseline
    if (-not $?) { throw "Native ZMODEM batch matrix failed" }
}
finally {
    [Environment]::SetEnvironmentVariable($environmentName, $previousValue, "Process")
}
