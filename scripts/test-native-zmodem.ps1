#Requires -Version 5.1
[CmdletBinding()]
param(
    [ValidateRange(0, 10)]
    [int]$LatencyMS = 2,

    [switch]$SkipFaultTests,

    [ValidateSet("none", "all", "large", "repeat", "parallel", "latency")]
    [string]$StressProfile = "none",

    [ValidateRange(1, 128)]
    [int]$StressLargeMiB = 128,

    [ValidateRange(1, 50)]
    [int]$StressRounds = 30,

    [ValidateRange(1, 4)]
    [int]$StressWorkers = 3,

    [ValidateRange(0, 10)]
    [int]$StressLatencyMS = 3,

    [string]$StressReportDir = "",

    [switch]$StressDiagnostics,

    [switch]$StressBatchMatrix,

    [ValidateRange(1, 10)]
    [int]$StressMatrixRounds = 5,

    [switch]$StressLargeAB,

    [ValidateRange(1, 10)]
    [int]$StressLargeABRounds = 5,

    [switch]$SkipBaseline
)

$ErrorActionPreference = "Stop"

# A PowerShell transcript does not reliably preserve all native go test
# output on Windows PowerShell 5.1. Keep a separate persistent diagnostic log.
function Invoke-NativeZmodemGoTest {
    param(
        [Parameter(Mandatory = $true)][string]$Pattern,
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$LogDirectory,
        [string]$Timeout = "10m",
        [switch]$CaptureProfile
    )

    [void][IO.Directory]::CreateDirectory($LogDirectory)
    $safeName = $Name -replace '[^a-zA-Z0-9_-]', '-'
    $logPath = Join-Path $LogDirectory "$safeName.log"
    $previousPreference = $ErrorActionPreference
    $exitCode = 1
    try {
        # On Windows PowerShell 5.1 redirected native stderr is surfaced as
        # error records; do not let Stop abort the test before saving output.
        $ErrorActionPreference = "Continue"
        # Protocol/PTY integration tests run independently of Go Vet. This is
        # not a permanent disable: CI still runs "go vet ./..." separately.
        $goArguments = @("test", "-vet=off", "-count=1", "-timeout=$Timeout", "-v", "./internal/ssh", "-run", $Pattern)
        if ($CaptureProfile) {
            $cpuProfile = Join-Path $LogDirectory "$safeName.cpu.pprof"
            $traceFile = Join-Path $LogDirectory "$safeName.trace"
            $goArguments += @("-cpuprofile", $cpuProfile, "-trace", $traceFile)
        }
        & go @goArguments 2>&1 | Tee-Object -FilePath $logPath
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousPreference
    }
    if ($exitCode -ne 0) {
        throw "$Name failed (go test exit code $exitCode); full output: $logPath"
    }
}

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw "Run this script in native Windows PowerShell, not WSL or Linux PowerShell."
}

foreach ($command in @("docker", "go", "cargo")) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
        throw "Missing tool: $command. Install Docker Desktop (Linux containers), Go and Rust first."
    }
}

$dockerOS = & docker info --format '{{.OSType}}' 2>$null
if ($LASTEXITCODE -ne 0 -or "$dockerOS".Trim() -ne "linux") {
    throw "Docker Desktop is not running with the Linux containers engine."
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$dockerContext = Join-Path $repoRoot "experiments\native-zmodem\docker-ssh-lab"
$sidecar = Join-Path $repoRoot "experiments\native-zmodem\target\release\zmodem-sidecar.exe"

$unique = [guid]::NewGuid().ToString("N").Substring(0, 12)
$container = "openshell-zmodem-lab-$unique"
$image = "openshell-native-zmodem-ssh-lab:local"
$tempDir = Join-Path ([IO.Path]::GetTempPath()) "openshell-zmodem-lab-$unique"
$privateKey = Join-Path $tempDir "client_ed25519"
$hostPublicKey = Join-Path $tempDir "host_ed25519.pub"
$started = $false
$containerAttempted = $false

$variableNames = @(
    "OPENSHELL_ZMODEM_CROSS_OS_PTY",
    "OPENSHELL_ZMODEM_LIVE_SSH_ADDR",
    "OPENSHELL_ZMODEM_LIVE_SSH_USER",
    "OPENSHELL_ZMODEM_LIVE_SSH_KEY",
    "OPENSHELL_ZMODEM_LIVE_SSH_HOSTKEY",
    "OPENSHELL_ZMODEM_LIVE_SIDECAR",
    "OPENSHELL_ZMODEM_CROSS_OS_LATENCY_MS",
    "OPENSHELL_ZMODEM_STRESS",
    "OPENSHELL_ZMODEM_STRESS_PROFILE",
    "OPENSHELL_ZMODEM_STRESS_LARGE_MIB",
    "OPENSHELL_ZMODEM_STRESS_ROUNDS",
    "OPENSHELL_ZMODEM_STRESS_WORKERS",
    "OPENSHELL_ZMODEM_STRESS_LATENCY_MS",
    "OPENSHELL_ZMODEM_STRESS_REPORT",
    "OPENSHELL_ZMODEM_BATCH_MATRIX",
    "OPENSHELL_ZMODEM_MATRIX_ROUNDS",
    "OPENSHELL_ZMODEM_MATRIX_REPORT",
    "OPENSHELL_ZMODEM_LARGE_AB",
    "OPENSHELL_ZMODEM_LARGE_AB_ROUNDS",
    "OPENSHELL_ZMODEM_LARGE_AB_REPORT",
    "OPENSHELL_ZMODEM_RX_DIAG"
)
$previous = @{}
foreach ($name in $variableNames) {
    $previous[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
}

[void][IO.Directory]::CreateDirectory($tempDir)
Push-Location $repoRoot
try {
    Write-Host "[preflight] Verify downloaded Go module integrity"
    & go mod verify
    if ($LASTEXITCODE -ne 0) {
        throw "Go module integrity check failed. Inspect local GOMODCACHE; do not treat any previous cached test PASS as a clean environment."
    }

    Write-Host "[1/5] Build native Windows Rust sidecar"
    Push-Location (Join-Path $repoRoot "experiments\native-zmodem")
    try {
        # Reuse the local dependency lock on repeat runs instead of updating
        # the crates.io index every time the integration suite starts.
        if (-not (Test-Path -LiteralPath "Cargo.lock" -PathType Leaf)) {
            & cargo generate-lockfile
            if ($LASTEXITCODE -ne 0) { throw "cargo generate-lockfile failed" }
        }
        & cargo test --locked --bin zmodem-sidecar
        if ($LASTEXITCODE -ne 0) { throw "Rust sidecar unit tests failed" }
        & cargo build --locked --release --bin zmodem-sidecar
        if ($LASTEXITCODE -ne 0) { throw "Windows Rust sidecar build failed" }
    }
    finally {
        Pop-Location
    }
    if (-not (Test-Path -LiteralPath $sidecar -PathType Leaf)) {
        throw "Expected Windows sidecar EXE not found: $sidecar"
    }

    Write-Host "[2/5] Build isolated Linux OpenSSH + lrzsz test container"
    & docker build -t $image $dockerContext
    if ($LASTEXITCODE -ne 0) { throw "Docker Linux SSH fixture build failed" }

    Write-Host "[3/5] Start localhost-only Linux SSH and generate ephemeral keys"
    # Keep an exited container long enough to inspect its status and logs.
    # It is removed in finally whether the test succeeds or fails.
    $containerAttempted = $true
    & docker run --detach --name $container -p '127.0.0.1::22' $image | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Docker Linux SSH fixture failed to start" }
    $started = $true

    $deadline = (Get-Date).AddSeconds(75)
    $healthy = $false
    while ((Get-Date) -lt $deadline) {
        $stateLine = & docker inspect --format '{{.State.Status}}|{{.State.Health.Status}}' $container 2>$null
        if ($LASTEXITCODE -ne 0) { throw "Linux SSH container disappeared before becoming ready" }
        $parts = "$stateLine".Trim().Split([char]'|')
        if ($parts.Count -ne 2) { throw "Invalid Docker container health response: $stateLine" }
        if ($parts[0] -ne "running") { throw "Linux SSH container stopped before becoming ready (status=$($parts[0]))" }
        if ($parts[1] -eq "healthy") {
            $healthy = $true
            break
        }
        if ($parts[1] -eq "unhealthy") {
            throw "Linux SSH container became unhealthy"
        }
        Start-Sleep -Milliseconds 1000
    }
    if (-not $healthy) { throw "Timed out waiting for Linux SSH container health" }

    & docker cp "$($container):/run/openshell-zmodem-lab/client_ed25519" $privateKey
    if ($LASTEXITCODE -ne 0) { throw "Failed to copy test-only SSH client key" }
    & docker cp "$($container):/etc/ssh/ssh_host_ed25519_key.pub" $hostPublicKey
    if ($LASTEXITCODE -ne 0) { throw "Failed to copy pinned SSH server host public key" }

    $portLines = @(& docker port $container '22/tcp')
    if ($LASTEXITCODE -ne 0) { throw "Failed to retrieve loopback port" }
    $port = $null
    foreach ($line in $portLines) {
        if ($line -match '^127\.0\.0\.1:(\d+)$') {
            $port = [int]$Matches[1]
            break
        }
    }
    if (-not $port) { throw "Container did not publish its SSH port on 127.0.0.1 only" }

    [Environment]::SetEnvironmentVariable("OPENSHELL_ZMODEM_CROSS_OS_PTY", "1", "Process")
    [Environment]::SetEnvironmentVariable("OPENSHELL_ZMODEM_LIVE_SSH_ADDR", "127.0.0.1:$port", "Process")
    [Environment]::SetEnvironmentVariable("OPENSHELL_ZMODEM_LIVE_SSH_USER", "zmodemlab", "Process")
    [Environment]::SetEnvironmentVariable("OPENSHELL_ZMODEM_LIVE_SSH_KEY", $privateKey, "Process")
    [Environment]::SetEnvironmentVariable("OPENSHELL_ZMODEM_LIVE_SSH_HOSTKEY", $hostPublicKey, "Process")
    [Environment]::SetEnvironmentVariable("OPENSHELL_ZMODEM_LIVE_SIDECAR", $sidecar, "Process")
    [Environment]::SetEnvironmentVariable("OPENSHELL_ZMODEM_CROSS_OS_LATENCY_MS", "$LatencyMS", "Process")

    $diagnosticsDir = Join-Path $repoRoot "tmp/native-zmodem-stress/logs/$unique"
    if (-not $SkipBaseline) {
        Write-Host "[4/5] Real Windows Go + Rust to Linux SSH PTY: 8 SHA-256 transfers"
        Invoke-NativeZmodemGoTest -Pattern '^TestNativeZmodemCrossOSInteractivePTY$' -Name 'cross-os-pty' -LogDirectory $diagnosticsDir
    }
    else {
        Write-Host "[4/5] Baseline SHA-256 roundtrips skipped by explicit request"
    }

    if (-not $SkipFaultTests) {
        Write-Host "[5/5] Live SSH cancellation, deadline and disconnect: 3 scenarios"
        Invoke-NativeZmodemGoTest -Pattern '^TestNativeZmodemLiveInterruptedInteractivePTY$' -Name 'interruptions' -LogDirectory $diagnosticsDir
    }
    else {
        Write-Host "[5/5] Fault-injection skipped by explicit request"
    }

    if ($StressProfile -ne "none") {
        if ($StressReportDir -eq "") {
            $StressReportDir = Join-Path $repoRoot 'tmp/native-zmodem-stress'
        }
        $reportDirectory = [IO.Path]::GetFullPath($StressReportDir)
        [void][IO.Directory]::CreateDirectory($reportDirectory)
        $reportFile = Join-Path $reportDirectory "native-zmodem-$(Get-Date -Format 'yyyyMMdd-HHmmss')-$unique.json"

        [Environment]::SetEnvironmentVariable("OPENSHELL_ZMODEM_STRESS", "1", "Process")
        [Environment]::SetEnvironmentVariable("OPENSHELL_ZMODEM_STRESS_PROFILE", $StressProfile, "Process")
        [Environment]::SetEnvironmentVariable("OPENSHELL_ZMODEM_STRESS_LARGE_MIB", "$StressLargeMiB", "Process")
        [Environment]::SetEnvironmentVariable("OPENSHELL_ZMODEM_STRESS_ROUNDS", "$StressRounds", "Process")
        [Environment]::SetEnvironmentVariable("OPENSHELL_ZMODEM_STRESS_WORKERS", "$StressWorkers", "Process")
        [Environment]::SetEnvironmentVariable("OPENSHELL_ZMODEM_STRESS_LATENCY_MS", "$StressLatencyMS", "Process")
        [Environment]::SetEnvironmentVariable("OPENSHELL_ZMODEM_STRESS_REPORT", $reportFile, "Process")

        Write-Host "[stress] Windows native Rust vs real Linux PTY: $StressProfile"
        Invoke-NativeZmodemGoTest -Pattern '^TestNativeZmodemStressInteractivePTY$' -Name "stress-$StressProfile" -LogDirectory $diagnosticsDir -Timeout "60m" -CaptureProfile:$StressDiagnostics
        if ($StressDiagnostics) {
            Write-Host "Go CPU/Trace profiles: $diagnosticsDir"
        }
        if (-not (Test-Path -LiteralPath $reportFile -PathType Leaf)) {
            throw "Native ZMODEM stress report was not generated: $reportFile"
        }
        $report = Get-Content -LiteralPath $reportFile -Raw | ConvertFrom-Json
        $records = @($report.results)
        if ($records.Count -eq 0) { throw "Stress report contains no transfer results: $reportFile" }
        Write-Host "Native ZMODEM stress throughput summary (MiB/s):"
        $records | Group-Object profile, protocol, direction | ForEach-Object {
            $speeds = @($_.Group | Where-Object { $_.checksumOK })
            $statistics = $speeds | Measure-Object -Property miBPerSecond -Average -Minimum -Maximum
            [PSCustomObject]@{
                Profile = $_.Group[0].profile
                Protocol = $_.Group[0].protocol
                Direction = $_.Group[0].direction
                Passed = "$($speeds.Count)/$($_.Count)"
                AvgMiBps = [math]::Round($statistics.Average, 2)
                MinMiBps = [math]::Round($statistics.Minimum, 2)
                MaxMiBps = [math]::Round($statistics.Maximum, 2)
            }
        } | Format-Table -AutoSize | Out-Host
        $nativeStageRecords = @($records | Where-Object {
            $_.protocol -eq "native" -and $_.checksumOK -and $null -ne $_.stagesMs
        })
        if ($nativeStageRecords.Count -gt 0) {
            Write-Host "Native ZMODEM stage timing (average ms, test-only instrumentation):"
            $nativeStageRecords | Group-Object profile, direction | ForEach-Object {
                $group = $_.Group
                [PSCustomObject]@{
                    Profile = $group[0].profile
                    Direction = $group[0].direction
                    Samples = $group.Count
                    Prepare = [math]::Round(($group | ForEach-Object { [double]$_.stagesMs.prepare } | Measure-Object -Average).Average, 1)
                    Protocol = [math]::Round(($group | ForEach-Object { [double]$_.stagesMs.protocol } | Measure-Object -Average).Average, 1)
                    RemoteConfirm = [math]::Round(($group | ForEach-Object { [double]$_.stagesMs.remoteConfirm } | Measure-Object -Average).Average, 1)
                    RestorePublish = [math]::Round(($group | ForEach-Object { [double]$_.stagesMs.restorePublish } | Measure-Object -Average).Average, 1)
                }
            } | Format-Table -AutoSize | Out-Host
        }
        Write-Host "PASS: stress report written to $reportFile"
    }

    if ($StressBatchMatrix) {
        if ($StressReportDir -eq "") {
            $StressReportDir = Join-Path $repoRoot 'tmp/native-zmodem-stress'
        }
        $matrixDir = [IO.Path]::GetFullPath($StressReportDir)
        [void][IO.Directory]::CreateDirectory($matrixDir)
        $matrixFile = Join-Path $matrixDir "native-zmodem-matrix-$(Get-Date -Format 'yyyyMMdd-HHmmss')-$unique.json"
        [Environment]::SetEnvironmentVariable("OPENSHELL_ZMODEM_BATCH_MATRIX", "1", "Process")
        [Environment]::SetEnvironmentVariable("OPENSHELL_ZMODEM_MATRIX_ROUNDS", "$StressMatrixRounds", "Process")
        [Environment]::SetEnvironmentVariable("OPENSHELL_ZMODEM_MATRIX_REPORT", $matrixFile, "Process")

        Write-Host "[matrix] Alternating 0/4/8/16/32 KiB across 0/1/3/5 ms ($StressMatrixRounds rounds each)"
        Invoke-NativeZmodemGoTest -Pattern '^TestNativeZmodemBatchMatrixInteractivePTY$' -Name 'batch-matrix' -LogDirectory $diagnosticsDir -Timeout '60m'

        if (-not (Test-Path -LiteralPath $matrixFile -PathType Leaf)) {
            throw "Native ZMODEM batch matrix JSON missing: $matrixFile"
        }
        $matrixResult = Get-Content -LiteralPath $matrixFile -Raw | ConvertFrom-Json
        $cases = @($matrixResult.cases)
        $expectedCases = 4 * 5 * $StressMatrixRounds
        if ($cases.Count -ne $expectedCases) {
            throw "Matrix incomplete: $($cases.Count)/$expectedCases test cases (report: $matrixFile)"
        }
        if (@($cases | Where-Object {
            $null -ne $_.error -or @($_.results).Count -ne 4 -or
            @($_.results | Where-Object { -not $_.checksumOK -or $_.error }).Count -ne 0
        }).Count -ne 0) {
            throw "Batch matrix has failed or incomplete transfers: $matrixFile"
        }

        Write-Host "Native upload A/B summary (median MiB/s, P95 elapsed ms):"
        $matrixResult.summaries |
            Where-Object { $_.protocol -eq 'native' -and $_.direction -eq 'upload' } |
            Select-Object latencyMs, wireBatchKiB, count,
                @{Name='MedianMiBps';Expression={[math]::Round($_.medianMiBPerSecond, 3)}},
                @{Name='P95ms';Expression={$_.p95DurationMs}},
                allChecksumsOK |
            Format-Table -AutoSize | Out-Host
        Write-Host "PASS: batch matrix JSON written to $matrixFile"
    }

    if ($StressLargeAB) {
        if ($StressReportDir -eq "") {
            $StressReportDir = Join-Path $repoRoot 'tmp/native-zmodem-stress'
        }
        $largeDir = [IO.Path]::GetFullPath($StressReportDir)
        [void][IO.Directory]::CreateDirectory($largeDir)
        $largeFile = Join-Path $largeDir "native-zmodem-large-ab-$(Get-Date -Format 'yyyyMMdd-HHmmss')-$unique.json"
        [Environment]::SetEnvironmentVariable("OPENSHELL_ZMODEM_LARGE_AB", "1", "Process")
        [Environment]::SetEnvironmentVariable("OPENSHELL_ZMODEM_LARGE_AB_ROUNDS", "$StressLargeABRounds", "Process")
        [Environment]::SetEnvironmentVariable("OPENSHELL_ZMODEM_LARGE_AB_REPORT", $largeFile, "Process")

        Write-Host "[large AB] 128 MiB 0/16/32 KiB, $StressLargeABRounds rounds"
        Invoke-NativeZmodemGoTest -Pattern '^TestNativeZmodemLargeABInteractivePTY$' -Name 'large-ab' -LogDirectory $diagnosticsDir -Timeout '60m' -CaptureProfile:$StressDiagnostics
        if (-not (Test-Path -LiteralPath $largeFile -PathType Leaf)) {
            throw "Large-file A/B report missing: $largeFile"
        }
        Write-Host "PASS: large A/B report written to $largeFile"
    }

    Write-Host "PASS: native Windows sidecar and real Linux OpenSSH/SFTP ZMODEM tests"
}
catch {
    $originalError = $_
    if ($containerAttempted) {
        Write-Warning "Docker Linux SSH fixture diagnostics:"
        try {
            & docker inspect --format '{{.State.Status}} | {{.State.ExitCode}} | {{.State.Error}}' $container 2>&1 | Out-Host
        }
        catch {
            Write-Warning "Docker inspect unavailable: $($_.Exception.Message)"
        }
        try {
            & docker logs $container 2>&1 | Out-Host
        }
        catch {
            Write-Warning "Docker logs unavailable: $($_.Exception.Message)"
        }
    }
    throw $originalError
}
finally {
    if ($containerAttempted) {
        try {
            & docker rm --force $container 2>$null | Out-Null
            if ($started -and $LASTEXITCODE -ne 0) {
                Write-Warning "Could not automatically remove test container: $container"
            }
        }
        catch {
            if ($started) {
                Write-Warning "Could not automatically remove test container: $container ($($_.Exception.Message))"
            }
        }
    }
    foreach ($name in $variableNames) {
        [Environment]::SetEnvironmentVariable($name, $previous[$name], "Process")
    }
    if (Test-Path -LiteralPath $tempDir) {
        Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    Pop-Location
}
