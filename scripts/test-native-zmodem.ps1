#Requires -Version 5.1
[CmdletBinding()]
param(
    [ValidateRange(0, 10)]
    [int]$LatencyMS = 2,

    [switch]$SkipFaultTests
)

$ErrorActionPreference = "Stop"

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

$variableNames = @(
    "OPENSHELL_ZMODEM_CROSS_OS_PTY",
    "OPENSHELL_ZMODEM_LIVE_SSH_ADDR",
    "OPENSHELL_ZMODEM_LIVE_SSH_USER",
    "OPENSHELL_ZMODEM_LIVE_SSH_KEY",
    "OPENSHELL_ZMODEM_LIVE_SSH_HOSTKEY",
    "OPENSHELL_ZMODEM_LIVE_SIDECAR",
    "OPENSHELL_ZMODEM_CROSS_OS_LATENCY_MS"
)
$previous = @{}
foreach ($name in $variableNames) {
    $previous[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
}

[void][IO.Directory]::CreateDirectory($tempDir)
Push-Location $repoRoot
try {
    Write-Host "[1/5] Build native Windows Rust sidecar"
    Push-Location (Join-Path $repoRoot "experiments\native-zmodem")
    try {
        & cargo generate-lockfile
        if ($LASTEXITCODE -ne 0) { throw "cargo generate-lockfile failed" }
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
    & docker run --detach --rm --name $container -p '127.0.0.1::22' $image | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Docker Linux SSH fixture failed to start" }
    $started = $true

    $deadline = (Get-Date).AddSeconds(75)
    $healthy = $false
    while ((Get-Date) -lt $deadline) {
        $status = & docker inspect --format '{{.State.Health.Status}}' $container 2>$null
        if ($LASTEXITCODE -ne 0) { throw "Linux SSH container stopped before becoming ready" }
        if ("$status".Trim() -eq "healthy") {
            $healthy = $true
            break
        }
        if ("$status".Trim() -eq "unhealthy") {
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

    Write-Host "[4/5] Real Windows Go + Rust to Linux SSH PTY: 8 SHA-256 transfers"
    & go test -count=1 -timeout=10m -v ./internal/ssh -run '^TestNativeZmodemCrossOSInteractivePTY$'
    if ($LASTEXITCODE -ne 0) { throw "Windows to Linux native ZMODEM interop failed" }

    if (-not $SkipFaultTests) {
        Write-Host "[5/5] Live SSH cancellation, deadline and disconnect: 3 scenarios"
        & go test -count=1 -timeout=10m -v ./internal/ssh -run '^TestNativeZmodemLiveInterruptedInteractivePTY$'
        if ($LASTEXITCODE -ne 0) { throw "Windows to Linux live fault-injection failed" }
    }
    else {
        Write-Host "[5/5] Fault-injection skipped by explicit request"
    }

    Write-Host "PASS: native Windows sidecar and real Linux OpenSSH/SFTP ZMODEM tests"
}
catch {
    if ($started) {
        Write-Warning "Docker Linux SSH fixture diagnostics:"
        & docker logs $container 2>&1 | Out-Host
    }
    throw
}
finally {
    if ($started) {
        & docker rm --force $container *> $null
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "Could not automatically remove test container: $container"
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
