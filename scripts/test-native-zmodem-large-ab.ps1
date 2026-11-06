#Requires -Version 5.1
[CmdletBinding()]
param(
    [ValidateRange(1, 10)]
    [int]$Rounds = 5,

    [string]$ReportDir = "",

    [switch]$Diagnostics,

    [switch]$SkipBaseline
)

$ErrorActionPreference = "Stop"
$variable = "OPENSHELL_ZMODEM_WIRE_BATCH_BYTES"
$original = [Environment]::GetEnvironmentVariable($variable, "Process")
try {
    [Environment]::SetEnvironmentVariable($variable, "0", "Process")
    & (Join-Path $PSScriptRoot "test-native-zmodem.ps1") `
        -LatencyMS 0 `
        -SkipFaultTests `
        -StressLargeAB `
        -StressLargeABRounds $Rounds `
        -StressReportDir $ReportDir `
        -StressDiagnostics:$Diagnostics `
        -SkipBaseline:$SkipBaseline
    if (-not $?) { throw "Native ZMODEM large A/B failed" }
}
finally {
    [Environment]::SetEnvironmentVariable($variable, $original, "Process")
}
