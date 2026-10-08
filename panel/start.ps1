# API-free 启动：拉起聚合面板，再由面板启动四个服务
# 用法：双击项目根目录的 start.bat，或在此目录执行 powershell -File start.ps1
$ErrorActionPreference = 'Continue'
$panelDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $panelDir

$BASE = 'http://127.0.0.1:9000'
$SVCS = @('workbuddy', 'qoder', 'cline', 'cmdgo')

if (-not (Test-Path 'bin\panel.exe')) {
    Write-Host '[!] 找不到 bin\panel.exe，请先编译： go build -o bin\panel.exe .\cmd\panel' -ForegroundColor Red
    exit 1
}

function Test-Panel {
    try {
        return (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "$BASE/api/health").StatusCode -eq 200
    } catch { return $false }
}

# 1) 面板
if (Test-Panel) {
    Write-Host '[=] 面板已在运行' -ForegroundColor DarkGray
} else {
    Write-Host '[1/3] 启动面板 ...'
    # 注意：必须用 panel 目录作为工作目录（data/、ui/dist/、服务目录都是相对路径）
    Start-Process -FilePath (Join-Path $panelDir 'bin\panel.exe') -WorkingDirectory $panelDir -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $panelDir 'data\panel.out.log') `
        -RedirectStandardError (Join-Path $panelDir 'data\panel.err.log')
    $ready = $false
    foreach ($i in 1..30) {
        Start-Sleep -Milliseconds 700
        if (Test-Panel) { $ready = $true; break }
    }
    if (-not $ready) {
        Write-Host '[!] 面板 20 秒内没起来，看 panel\data\panel.err.log' -ForegroundColor Red
        exit 1
    }
    Write-Host '      面板已就绪'
}

# 2) 四个服务（经面板 API 启动，这样进程归面板托管、崩溃会自动拉起）
Write-Host '[2/3] 启动四个服务 ...'
$snap = (Invoke-RestMethod "$BASE/api/services").services
foreach ($svc in $SVCS) {
    $cur = $snap | Where-Object { $_.id -eq $svc }
    if ($cur -and $cur.status -eq 'running') {
        Write-Host "      $svc 已在运行" -ForegroundColor DarkGray
        continue
    }
    try {
        Invoke-RestMethod -Method Post -TimeoutSec 90 "$BASE/api/services/$svc/start" | Out-Null
        Write-Host "      $svc 启动指令已下发"
    } catch {
        Write-Host "      $svc 启动失败：$($_.Exception.Message)" -ForegroundColor Yellow
    }
}

# 3) 等服务就绪（workbuddy 是 go run，首次编译可能要 40 秒以上）
Write-Host '[3/3] 等待端口就绪 ...'
$allUp = $false
foreach ($i in 1..25) {
    Start-Sleep -Seconds 3
    $snap = (Invoke-RestMethod "$BASE/api/services").services
    $down = @($snap | Where-Object { $_.status -ne 'running' })
    if ($down.Count -eq 0) { $allUp = $true; break }
}
Write-Host ''
$snap = (Invoke-RestMethod "$BASE/api/services").services
$snap | Select-Object id, name, port, status, managed | Format-Table -AutoSize

if ($allUp) { Write-Host '全部服务已就绪。' -ForegroundColor Green }
else { Write-Host '仍有服务未就绪，见上表与面板「日志」页。' -ForegroundColor Yellow }

Write-Host "面板地址：$BASE" -ForegroundColor Green
Start-Process $BASE
