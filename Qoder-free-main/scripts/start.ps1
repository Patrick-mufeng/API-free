$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Test-Path "config.json")) {
  Copy-Item "config.example.json" "config.json"
  Write-Host "[start] created config.json (api_key 会在首次启动时生成)"
}

if (-not (Test-Path "worker/node_modules")) {
  Write-Host "[start] installing worker deps..."
  npm ci --prefix worker
}

if (-not (Test-Path "bin/qoder-free.exe")) {
  Write-Host "[start] building..."
  go build -o bin/qoder-free.exe ./cmd/server
}

Write-Host "[start] starting qoder-free..."
& .\bin\qoder-free.exe
