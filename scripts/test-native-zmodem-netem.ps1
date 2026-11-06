#Requires -Version 5.1
[CmdletBinding()]
param(
    [ValidateRange(1, 5)]
    [int]$Rounds = 5,

    [ValidateSet("0.1", "1")]
    [string]$LossPercent = "0.1",

    [switch]$IncludeFaults,

    [string]$ReportDir = "",

    [switch]$SkipBaseline
)

$ErrorActionPreference = "Stop"

# The Docker SSH lab is loopback-only. NET_ADMIN is granted only to its
# temporary container; netem configures that container's eth0 egress.
& (Join-Path $PSScriptRoot "test-native-zmodem.ps1") `
    -LatencyMS 0 `
    -SkipFaultTests `
    -StressNetemAB `
    -StressNetemRounds $Rounds `
    -StressNetemLossPercent $LossPercent `
    -StressNetemFaults:$IncludeFaults `
    -StressReportDir $ReportDir `
    -SkipBaseline:$SkipBaseline

if (-not $?) { throw "Native ZMODEM netem lab failed" }
