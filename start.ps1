# Polycode — start all services
# Usage: .\start.ps1  (optionally set $env:GROQ_API_KEY before running)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$cargo = "$env:USERPROFILE\.cargo\bin"

# ── Ask for GROQ key if not set ───────────────────────────────────────────────
if (-not $env:GROQ_API_KEY) {
    $key = Read-Host "Enter your GROQ_API_KEY (or press Enter to skip AI features)"
    if ($key) { $env:GROQ_API_KEY = $key }
}

Write-Host ""
Write-Host "Starting Polycode services..." -ForegroundColor Cyan
Write-Host ""

# ── Terminal 1: Module 1 — gRPC server (port 50051) ──────────────────────────
Start-Process powershell -ArgumentList "-NoExit", "-Command",
    "Set-Location '$root'; Write-Host '[Module 1] gRPC server on :50051' -ForegroundColor Green; python test_integration_v3.py"

Start-Sleep -Seconds 2

# ── Terminal 2: API Server (port 3000) ────────────────────────────────────────
Start-Process powershell -ArgumentList "-NoExit", "-Command",
    "Set-Location '$root'; `$env:GROQ_API_KEY = '$env:GROQ_API_KEY'; Write-Host '[API Server] on :3000' -ForegroundColor Green; & '.\target\x86_64-pc-windows-gnu\release\api_server.exe'"

Start-Sleep -Seconds 1

# ── Terminal 3: Chatbot — FastAPI (port 8080) ─────────────────────────────────
Start-Process powershell -ArgumentList "-NoExit", "-Command",
    "Set-Location '$root\chatbot'; `$env:GROQ_API_KEY = '$env:GROQ_API_KEY'; `$env:PYTHONPATH = '.'; Write-Host '[Chatbot] on :8080' -ForegroundColor Green; uvicorn main:app --reload --port 8080"

Start-Sleep -Seconds 1

# ── Terminal 4: UI dev server (port 5173) ─────────────────────────────────────
Start-Process powershell -ArgumentList "-NoExit", "-Command",
    "Set-Location '$root\ui'; Write-Host '[UI] on http://localhost:5173' -ForegroundColor Green; npm run dev"

Write-Host ""
Write-Host "All services starting. Open http://localhost:5173 in your browser." -ForegroundColor Cyan
Write-Host ""
Write-Host "Services:" -ForegroundColor Yellow
Write-Host "  Module 1 (gRPC)  :50051"
Write-Host "  API Server        :3000"
Write-Host "  Chatbot           :8080"
Write-Host "  UI                http://localhost:5173"
