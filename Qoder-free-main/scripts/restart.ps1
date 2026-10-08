# Qoder-free 一键重启脚本（Windows）
# 文件必须保存为 UTF-8 with BOM：Windows PowerShell 5.1 对无 BOM 的 UTF-8 脚本
# 会按本地 ANSI（GBK）解析，中文输出会变成乱码。
$ErrorActionPreference = "Stop"
try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $OutputEncoding = [System.Text.Encoding]::UTF8
} catch { }

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Fail($msg) {
  Write-Host "[restart] $msg" -ForegroundColor Red
  exit 1
}

# ---- 1. 环境检查 ----
if (-not (Get-Command go -ErrorAction SilentlyContinue)) { Fail "未找到 go 命令，请先安装 Go 1.25+" }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail "未找到 node 命令，请先安装 Node.js 22+" }
if (-not (Test-Path "config.json")) {
  Copy-Item "config.example.json" "config.json"
  Write-Host "[restart] 已从 config.example.json 创建 config.json（api_key 首次启动自动生成）"
}
if (-not (Test-Path "worker/node_modules")) {
  Write-Host "[restart] 安装 worker 依赖（含 qodercli，首次约 1-2 分钟）..."
  npm ci --prefix worker
  if ($LASTEXITCODE -ne 0) { Fail "worker 依赖安装失败" }
}

# ---- 2. 先构建新二进制（失败则旧进程保持不动）----
Write-Host "[restart] 构建新二进制..."
go build -trimpath -ldflags "-s -w" -o "bin/qoder-free.new.exe" ./cmd/server
if ($LASTEXITCODE -ne 0) { Fail "构建失败，旧实例保持运行" }

# ---- 3. 停止旧实例（连 worker 子进程树一起结束）----
$old = Get-Process -Name "qoder-free" -ErrorAction SilentlyContinue
if ($old) {
  foreach ($p in $old) {
    Write-Host "[restart] 停止旧实例 PID $($p.Id)（含 worker 子进程）..."
    taskkill /F /T /PID $p.Id 2>$null | Out-Null
  }
  Start-Sleep -Milliseconds 800
} else {
  Write-Host "[restart] 没有正在运行的实例"
}

# ---- 4. 换上新二进制 ----
Move-Item -Force "bin/qoder-free.new.exe" "bin/qoder-free.exe"

# ---- 5. 后台启动，日志写入 logs/ ----
$logs = Join-Path $Root "logs"
New-Item -ItemType Directory -Force $logs | Out-Null
$outLog = Join-Path $logs "server.out.log"
$errLog = Join-Path $logs "server.err.log"
$proc = Start-Process -FilePath (Join-Path $Root "bin/qoder-free.exe") `
  -WorkingDirectory $Root `
  -WindowStyle Hidden `
  -RedirectStandardOutput $outLog `
  -RedirectStandardError $errLog `
  -PassThru
Write-Host "[restart] 已启动 PID $($proc.Id)，运行日志见 logs\server.err.log"

# ---- 6. 健康检查（监听地址从 config.json 读取）----
$listen = "127.0.0.1:8210"
try { $listen = (Get-Content "config.json" -Raw | ConvertFrom-Json).listen } catch { }
$parts = $listen -split ":"
$hostPart = if ($parts[0] -and $parts[0] -ne "0.0.0.0") { $parts[0] } else { "127.0.0.1" }
$health = "http://${hostPart}:$($parts[1])/healthz"

$ok = $false
foreach ($i in 1..30) {
  Start-Sleep -Milliseconds 500
  try {
    $h = Invoke-RestMethod -Uri $health -TimeoutSec 2
    $ok = $true
    break
  } catch { }
}
if ($ok) {
  Write-Host "[restart] 服务就绪：$health（healthy=$($h.healthy)/$($h.total)）"
} else {
  Write-Host "[restart] 警告：健康检查未通过，请查看 $errLog" -ForegroundColor Yellow
}
Write-Host "[restart] 面板地址：http://${hostPart}:$($parts[1])/panel/"
