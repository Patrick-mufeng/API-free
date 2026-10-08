# API-free 停止：先停五个服务，再关掉面板
# 用法：双击项目根目录的 stop.bat
$ErrorActionPreference = 'Continue'
$panelDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$BASE = 'http://127.0.0.1:9000'

$alive = $false
try { $alive = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "$BASE/api/health").StatusCode -eq 200 } catch { }

if ($alive) {
    foreach ($svc in 'workbuddy', 'qoder', 'zen', 'cline', 'cmdgo') {
        try {
            Invoke-RestMethod -Method Post -TimeoutSec 30 "$BASE/api/services/$svc/stop" | Out-Null
            Write-Host "      $svc 已停止"
        } catch {
            Write-Host "      $svc 未停止（可能本来就没跑）：$($_.Exception.Message)" -ForegroundColor DarkGray
        }
    }
} else {
    Write-Host '[=] 面板未在运行，跳过服务停止' -ForegroundColor DarkGray
}

$conn = Get-NetTCPConnection -LocalPort 9000 -State Listen -ErrorAction SilentlyContinue
if ($conn) {
    Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
    Write-Host '      面板已关闭'
} else {
    Write-Host '[=] 面板进程不存在' -ForegroundColor DarkGray
}
Write-Host '已全部停止。' -ForegroundColor Green
