# Opens the local dev backend port to devices on your private network, so Expo Go
# on a phone can reach the Node API running on this machine.
#
# Run from an ADMIN PowerShell:
#   powershell -ExecutionPolicy Bypass -File D:\PDD\mediguard\scripts\allow-dev-port.ps1
#
# Remove it again when you are done developing:
#   powershell -ExecutionPolicy Bypass -File D:\PDD\mediguard\scripts\allow-dev-port.ps1 -Remove

param(
    [int]$Port = 4000,
    [switch]$Remove
)

$ErrorActionPreference = "Stop"
$name = "MediGuard dev backend"

$isAdmin = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Error "This must be run from an elevated (Run as administrator) PowerShell."
    exit 1
}

# Always clear any existing rule of this name first. An earlier attempt may have
# created one without a port restriction, which would allow ALL inbound TCP.
$existing = Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue
if ($existing) {
    $existing | Remove-NetFirewallRule
    Write-Host "Removed $($existing.Count) existing '$name' rule(s)." -ForegroundColor Yellow
}

if ($Remove) {
    Write-Host "Done - no firewall rule for '$name' remains." -ForegroundColor Green
    exit 0
}

$params = @{
    DisplayName = $name
    Description = "Local development only. Allows devices on the private network to reach the MediGuard Node API."
    Direction   = "Inbound"
    Protocol    = "TCP"
    LocalPort   = $Port
    Action      = "Allow"
    Profile     = "Private"
}
New-NetFirewallRule @params | Out-Null

Get-NetFirewallRule -DisplayName $name |
    Select-Object DisplayName, Enabled, Direction, Action, Profile |
    Format-Table -AutoSize

Get-NetFirewallRule -DisplayName $name |
    Get-NetFirewallPortFilter |
    Select-Object Protocol, LocalPort |
    Format-Table -AutoSize

Write-Host "Allowed TCP $Port inbound on the Private profile only." -ForegroundColor Green
