// API-free 统一面板 · 聚合后端
// 静态托管 ui/dist + 服务注册表 + 进程监督（真·启停 / 崩溃自动拉起 / PID 收编）
package main

import (
	"flag"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"api-free/panel/internal/events"
	"api-free/panel/internal/registry"
	"api-free/panel/internal/server"
	"api-free/panel/internal/stats"
	"api-free/panel/internal/supervisor"
)

// 首次运行时写入的默认注册表（与 data/services.json 同构）
const defaultRegistry = `{
  "services": [
    { "id": "workbuddy", "name": "WorkBuddy-free", "dir": "../workbuddy-free-main",
      "command": "go", "args": ["run", "./cmd/server", "-config", "config.json"],
      "env": {}, "port": 7863, "health": "/healthz",
      "auth": { "file": "../workbuddy-free-main/config.json", "field": "api_key", "format": "json" } },
    { "id": "qoder", "name": "Qoder-free", "dir": "../Qoder-free-main",
      "command": "bin\\qoder-free.exe", "args": [],
      "env": {}, "port": 8210, "health": "/v1/models",
      "auth": { "file": "../Qoder-free-main/config.json", "field": "api_key", "format": "json" } },
    { "id": "cline", "name": "Cline-free", "dir": "../cline-free-main",
      "command": "node", "args": ["start.mjs"],
      "env": { "PORT": "8787" }, "port": 8787, "health": "/v1/health",
      "auth": { "file": "../cline-free-main/.env.local", "field": "API_KEY", "format": "env" } },
    { "id": "cmdgo", "name": "cmdgo-bridge", "dir": "../cmdgo-bridge-main",
      "command": "node", "args": ["dist/index.js"],
      "env": {}, "port": 8014, "health": "/health",
      "auth": { "file": "~/.cmdgo-bridge/config.json", "field": "apiKey", "format": "json" } }
  ]
}
`

func main() {
	addr := flag.String("addr", "127.0.0.1:9000", "面板监听地址")
	dataDir := flag.String("data", "data", "数据目录（services.json、日志）")
	distDir := flag.String("dist", "ui/dist", "前端构建产物目录")
	noAutoRestart := flag.Bool("no-autorestart", false, "关闭崩溃自动拉起")
	flag.Parse()

	regPath := filepath.Join(*dataDir, "services.json")
	if _, err := os.Stat(regPath); os.IsNotExist(err) {
		_ = os.MkdirAll(*dataDir, 0o755)
		if err := os.WriteFile(regPath, []byte(defaultRegistry), 0o644); err != nil {
			log.Fatalf("写入默认注册表失败: %v", err)
		}
		log.Printf("已生成默认注册表 %s", regPath)
	}
	reg, err := registry.Load(regPath)
	if err != nil {
		log.Fatalf("加载注册表: %v", err)
	}

	panelRoot, _ := filepath.Abs(".")
	sup := supervisor.New(reg, panelRoot, *dataDir, !*noAutoRestart)
	sup.Adopt() // PID 收编：端口已通的服务标记为外部运行

	// M3：统计采集器（启动 8s 后首轮，之后每 5 分钟一轮；仅拉运行中的服务）
	collector, err := stats.New(filepath.Join(*dataDir, "stats.db"), *addr)
	if err != nil {
		log.Fatalf("初始化统计库: %v", err)
	}
	defer collector.Close()
	time.AfterFunc(8*time.Second, func() { collector.PullAll(sup.IsRunning) })
	go func() {
		for range time.Tick(5 * time.Minute) {
			collector.PullAll(sup.IsRunning)
		}
	}()

	handler := server.New(sup, *distDir, reg, panelRoot, collector, !*noAutoRestart)
	log.Printf("API-free 面板已启动: http://%s （监督 %d 个服务，自动拉起=%v）", *addr, len(reg.Services), !*noAutoRestart)
	events.Add("[panel] 面板启动，监督 " + strconv.Itoa(len(reg.Services)) + " 个服务")
	log.Fatal(http.ListenAndServe(*addr, handler))
}
