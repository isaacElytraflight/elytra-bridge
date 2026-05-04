$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Resolve-Path (Join-Path $ScriptDir "..\..")
Set-Location $Root

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Write-Error "Docker CLI not found. Install Docker Desktop or Docker Engine."
  exit 1
}

try {
  docker info *> $null
} catch {
  Write-Error "Docker daemon not running. Start Docker Desktop."
  exit 1
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "Node.js not found. Install Node.js 20+."
  exit 1
}

$ApplicationDir = Join-Path $Root "application"
Set-Location $ApplicationDir

if (-not (Test-Path "node_modules")) {
  Write-Host "Installing npm dependencies (first run only; may take a minute)..."
  npm install
}

Write-Host ""
Write-Host "Starting Elytra Bridge backend + frontend dev servers."
Write-Host "Opening http://localhost:5173 in a few seconds."
Write-Host "Press Ctrl+C here to stop."
Write-Host ""

Start-Job -ScriptBlock {
  Start-Sleep -Seconds 4
  Start-Process "http://localhost:5173"
} | Out-Null

npm run dev
