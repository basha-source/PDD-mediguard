# Launches every MediGuard service in its own terminal window.
# Expo needs a real TTY for the QR code, so it cannot share a Turbo pane.
param(
    [switch]$NoMl  # skip the Python ML service
)

$root = $PSScriptRoot

function Start-Service-Window {
    param([string]$Title, [string]$Dir, [string]$Command)
    Start-Process powershell -ArgumentList @(
        '-NoExit', '-Command',
        "`$Host.UI.RawUI.WindowTitle = '$Title'; Set-Location '$Dir'; $Command"
    )
    Write-Host "  started $Title" -ForegroundColor Green
}

Write-Host "Starting MediGuard..." -ForegroundColor Cyan

Start-Service-Window 'MediGuard API'    "$root\apps\backend" 'pnpm dev'
Start-Service-Window 'MediGuard Web'    "$root\apps\web"     'pnpm dev'


# The MiniLM weights and the assistant index are already on disk, but
# sentence-transformers still HEADs huggingface.co on every load to check for a
# newer revision. On a campus network that request is reset rather than refused,
# so it burns ~28s in httpx retries before falling back to the cache -- pure dead
# time on each ML restart. HF_HUB_OFFLINE tells it to trust the cache and skip
# the check. Unset it when you deliberately want to pull a new model.
if (-not $NoMl) {
    Start-Service-Window 'MediGuard ML' "$root\apps\ml-service" '.\.venv\Scripts\Activate.ps1; $env:HF_HUB_OFFLINE=1; $env:TRANSFORMERS_OFFLINE=1; python -m uvicorn app.main:app --reload --port 8000'
}

# Mobile last so its window lands on top with the QR visible.
Start-Service-Window 'MediGuard Mobile (Expo)' "$root\apps\mobile" 'pnpm expo start'

Write-Host "`nAll services launched. Scan the QR in the 'MediGuard Mobile (Expo)' window." -ForegroundColor Cyan
