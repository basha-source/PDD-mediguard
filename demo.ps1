<#
.SYNOPSIS
    Starts the entire MediGuard stack in ONE terminal, for an Expo Go demo.

.DESCRIPTION
    dev.ps1 opens a window per service, which is fine while developing but
    unusable on a projector. This script instead runs the ML service, the API
    and the web dashboard as hidden background processes, then hands this
    terminal to Expo -- Expo needs a real TTY to draw the QR code and to accept
    its interactive keys (a/r/j), so it is the one process that must stay in the
    foreground.

    Two things it does that starting the services by hand does not:

      * It rewrites EXPO_PUBLIC_BACKEND_URL with this machine's current LAN IP.
        Expo inlines that value into the bundle at start time, so a stale IP
        silently breaks every backend call until Expo is restarted.

      * It waits for the ML service to report ready:true before Expo boots. The
        assistant index takes ~15s to warm, and scanning the QR before that
        finishes is exactly how you end up demoing an error message.

.PARAMETER Tunnel
    Route Expo through its tunnel instead of the LAN. Slower, but campus Wi-Fi
    often isolates clients from each other, which makes LAN mode fail silently.

.PARAMETER NoWeb
    Skip the web dashboard (saves memory; the Expo demo does not need it).

.PARAMETER Restart
    Kill anything already listening on 8000/4000/3000 and start it fresh.
    Without this, an already-running service is reused as-is.

.EXAMPLE
    pnpm demo
    pnpm demo -Tunnel
#>
param(
    [switch]$Tunnel,
    [switch]$NoWeb,
    [switch]$Restart
)

$ErrorActionPreference = 'Stop'
$root   = $PSScriptRoot
$logDir = Join-Path $root '.logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }

# Processes this script started, and therefore must clean up. A service that was
# already running is deliberately left alone -- it is not ours to kill.
$script:owned = @()

# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------

function Get-Listener {
    param([int]$Port)
    try {
        return Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop |
               Select-Object -First 1
    } catch {
        return $null
    }
}

function Stop-Port {
    param([int]$Port)
    $c = Get-Listener -Port $Port
    if ($c) {
        Write-Host "  stopping existing listener on $Port (pid $($c.OwningProcess))" -ForegroundColor DarkYellow
        & taskkill /T /F /PID $c.OwningProcess 2>&1 | Out-Null
        Start-Sleep -Milliseconds 800
    }
}

function Get-LanIPv4 {
    # The adapter with a default gateway is the one actually carrying traffic --
    # picking by name breaks on Wi-Fi/Ethernet swaps, and picking the first
    # address returns a Hyper-V or WSL virtual switch instead of the real NIC.
    $cfg = Get-NetIPConfiguration |
           Where-Object { $_.IPv4DefaultGateway -and $_.IPv4Address } |
           Select-Object -First 1
    if ($cfg) { return $cfg.IPv4Address.IPAddress }

    return (Get-NetIPAddress -AddressFamily IPv4 |
            Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' } |
            Select-Object -First 1).IPAddress
}

function Set-BackendUrl {
    param([string]$EnvFile, [string]$Url)

    $lines   = Get-Content $EnvFile
    $current = ($lines | Where-Object { $_ -match '^\s*EXPO_PUBLIC_BACKEND_URL=' }) -replace '^\s*EXPO_PUBLIC_BACKEND_URL=', ''

    if ($current -eq $Url) {
        Write-Host "  backend url already correct: $Url" -ForegroundColor DarkGray
        return
    }

    # Only the live assignment is touched; commented-out URLs (the Render one)
    # are left exactly where they are so they stay available to switch back to.
    $updated = $lines | ForEach-Object {
        if ($_ -match '^\s*EXPO_PUBLIC_BACKEND_URL=') { "EXPO_PUBLIC_BACKEND_URL=$Url" } else { $_ }
    }
    [System.IO.File]::WriteAllLines($EnvFile, $updated, (New-Object System.Text.UTF8Encoding $false))
    Write-Host "  backend url: $current -> $Url" -ForegroundColor Yellow
}

function Start-Bg {
    param([string]$Name, [string]$Dir, [string]$Command, [int]$Port)

    if (-not $Restart) {
        $existing = Get-Listener -Port $Port
        if ($existing) {
            Write-Host "  $Name already running on $Port (pid $($existing.OwningProcess)) - reusing" -ForegroundColor DarkGray
            return
        }
    }

    $log = Join-Path $logDir "$Name.log"
    # cmd.exe hosts the command so one redirect captures stdout and stderr into a
    # single interleaved log; Start-Process cannot send both to the same file.
    $p = Start-Process -FilePath 'cmd.exe' `
                       -ArgumentList '/c', "$Command > `"$log`" 2>&1" `
                       -WorkingDirectory $Dir -WindowStyle Hidden -PassThru
    $script:owned += $p
    Write-Host "  started $Name (log: .logs\$Name.log)" -ForegroundColor Green
}

function Wait-Port {
    param([string]$Name, [int]$Port, [int]$TimeoutSec = 90)

    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        if (Get-Listener -Port $Port) { return $true }
        Start-Sleep -Milliseconds 500
    }
    Write-Host "  WARNING: $Name did not open port $Port within ${TimeoutSec}s - check .logs\$Name.log" -ForegroundColor Red
    return $false
}

function Wait-MlReady {
    param([int]$TimeoutSec = 240)

    # /health is deliberately cheap and answers from the first second, so it
    # reports "warming" long before it reports "ready". Poll for ready:true --
    # an open port here means nothing.
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $spin     = @('|', '/', '-', '\')
    $i        = 0
    while ((Get-Date) -lt $deadline) {
        try {
            $h = Invoke-RestMethod -Uri 'http://localhost:8000/health' -TimeoutSec 5
            if ($h.ready) {
                Write-Host "`r  ML ready in $($h.warmup.seconds)s - $($h.warmup.chunks) chunks, $($h.index.model)   " -ForegroundColor Green
                return $true
            }
        } catch { }
        Write-Host "`r  warming the assistant index... $($spin[$i % 4])" -NoNewline -ForegroundColor DarkGray
        $i++
        Start-Sleep -Milliseconds 500
    }
    Write-Host "`r  WARNING: ML service not ready after ${TimeoutSec}s - check .logs\ml.log" -ForegroundColor Red
    return $false
}

function Stop-All {
    if ($script:owned.Count -eq 0) { return }
    Write-Host "`nShutting down background services..." -ForegroundColor Cyan
    foreach ($p in $script:owned) {
        # /T because cmd.exe is only the wrapper -- the node/python child is what
        # actually holds the port.
        try { & taskkill /T /F /PID $p.Id 2>&1 | Out-Null } catch { }
    }
    Write-Host "Done." -ForegroundColor Cyan
}

# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------

try {
    Write-Host "`nMediGuard demo launcher" -ForegroundColor Cyan
    Write-Host   "-----------------------" -ForegroundColor Cyan

    if ($Restart) {
        Write-Host "`n[0/4] Clearing ports" -ForegroundColor White
        Stop-Port 8000; Stop-Port 4000; Stop-Port 3000
    }

    # 1. Network -----------------------------------------------------------
    Write-Host "`n[1/4] Network" -ForegroundColor White
    $ip = Get-LanIPv4
    if (-not $ip) { throw "Could not determine a LAN IPv4 address. Are you connected to a network?" }
    Write-Host "  this machine: $ip"
    Set-BackendUrl -EnvFile (Join-Path $root 'apps\mobile\.env') -Url "http://${ip}:4000"

    # 2. Background services ------------------------------------------------
    Write-Host "`n[2/4] Starting services" -ForegroundColor White

    # No --reload here: a file-save would re-run the 15s warmup mid-demo.
    Start-Bg -Name 'ml' -Port 8000 -Dir (Join-Path $root 'apps\ml-service') `
             -Command '.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 0.0.0.0 --port 8000'

    Start-Bg -Name 'api' -Port 4000 -Dir (Join-Path $root 'apps\backend') -Command 'pnpm dev'

    if (-not $NoWeb) {
        Start-Bg -Name 'web' -Port 3000 -Dir (Join-Path $root 'apps\web') -Command 'pnpm dev'
    }

    # 3. Readiness ----------------------------------------------------------
    Write-Host "`n[3/4] Waiting for services" -ForegroundColor White
    Wait-Port -Name 'api' -Port 4000 -TimeoutSec 90 | Out-Null
    if (-not $NoWeb) { Wait-Port -Name 'web' -Port 3000 -TimeoutSec 90 | Out-Null }
    Wait-MlReady -TimeoutSec 240 | Out-Null

    Write-Host ""
    Write-Host "  API   http://${ip}:4000" -ForegroundColor Green
    if (-not $NoWeb) { Write-Host "  Web   http://localhost:3000" -ForegroundColor Green }
    Write-Host "  ML    http://localhost:8000/health" -ForegroundColor Green

    # 4. Expo, in the foreground -------------------------------------------
    Write-Host "`n[4/4] Starting Expo - scan the QR with Expo Go" -ForegroundColor White
    Write-Host "      (phone must be on the same Wi-Fi as $ip)" -ForegroundColor DarkGray
    Write-Host "      Ctrl+C stops Expo and shuts everything down.`n" -ForegroundColor DarkGray

    Set-Location (Join-Path $root 'apps\mobile')
    if ($Tunnel) { & pnpm exec expo start --tunnel } else { & pnpm exec expo start }
}
finally {
    Stop-All
}
