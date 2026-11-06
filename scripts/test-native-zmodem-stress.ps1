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

    [ValidateRange(1, 10)]
    [int]$LatencyMS = 3,

    [string]$ReportDir = "",

    [switch]$SkipBaseline
)

$ErrorActionPreference = "Stop"

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
    -SkipBaseline:$SkipBaseline

if (-not $?) { throw "Native ZMODEM stress lab failed" }
