// Package server 面板自身 API + ui/dist 静态托管。
package server

import (
	"encoding/json"
	"io/fs"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"api-free/panel/internal/events"
	"api-free/panel/internal/proxy"
	"api-free/panel/internal/registry"
	"api-free/panel/internal/stats"
	"api-free/panel/internal/supervisor"
	"api-free/panel/internal/svcinfo"
)

func New(sup *supervisor.Supervisor, distDir string, reg *registry.File, panelRoot string, collector *stats.Collector, autoRestart bool) http.Handler {
	mux := http.NewServeMux()

	// 面板事件流（日志页）
	mux.HandleFunc("GET /api/events", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, 200, map[string]any{"events": events.Snapshot()})
	})
	// 服务注册表（设置页）
	mux.HandleFunc("GET /api/registry", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, 200, map[string]any{
			"services":    reg.Services,
			"autoRestart": autoRestart,
			"version":     "0.1.0",
		})
	})

	// M2：API 代理 /api/svc/{id}/* → 各服务（注入鉴权，SSE 直通）
	svcProxy := proxy.New(reg, panelRoot)
	mux.Handle("/api/svc/", svcProxy)

	// 跨服务运行时信息（账号数/积分/任务进度/冷却告警）——四家口径不同，统一在这里归一
	infoCol := svcinfo.New(reg, svcProxy.KeyFor, sup.IsRunning)
	mux.HandleFunc("GET /api/svcinfo", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, 200, infoCol.Report())
	})

	// 接入信息：地址 / 模型列表 / 脱敏密钥（「怎么调用」页签用）
	mux.HandleFunc("GET /api/access", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, infoCol.Access(r.Host))
	})
	// 明文密钥：只认本机请求。哪天面板被 -addr 0.0.0.0 暴露出去，这个口子也不会跟着泄钥。
	mux.HandleFunc("GET /api/access/{id}/key", func(w http.ResponseWriter, r *http.Request) {
		if !isLoopback(r.RemoteAddr) {
			writeJSON(w, 403, map[string]any{"error": "密钥仅对本机开放"})
			return
		}
		id := r.PathValue("id")
		key := svcProxy.KeyFor(id)
		if key == "" {
			writeJSON(w, 404, map[string]any{"error": "读不到密钥：注册表里没有该服务的鉴权来源，或密钥文件不可读"})
			return
		}
		writeJSON(w, 200, map[string]any{"svc": id, "key": key})
	})

	// M3：统计读模型 + 手动刷新
	if collector != nil {
		mux.HandleFunc("GET /api/stats", func(w http.ResponseWriter, r *http.Request) {
			days := 30
			if d, err := strconv.Atoi(r.URL.Query().Get("days")); err == nil && d > 0 && d <= 90 {
				days = d
			}
			writeJSON(w, 200, collector.Summary(days))
		})
		mux.HandleFunc("POST /api/stats/refresh", func(w http.ResponseWriter, _ *http.Request) {
			okN, failN := collector.PullAll(sup.IsRunning)
			writeJSON(w, 200, map[string]any{"ok": failN == 0, "pulled": okN, "failed": failN})
		})
	}

	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, 200, map[string]any{"ok": true})
	})
	mux.HandleFunc("GET /api/services", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, 200, map[string]any{"services": sup.Snapshot()})
	})
	mux.HandleFunc("POST /api/services/{id}/start", func(w http.ResponseWriter, r *http.Request) {
		ctl(w, r, sup, "start")
	})
	mux.HandleFunc("POST /api/services/{id}/stop", func(w http.ResponseWriter, r *http.Request) {
		ctl(w, r, sup, "stop")
	})
	mux.HandleFunc("POST /api/services/{id}/restart", func(w http.ResponseWriter, r *http.Request) {
		ctl(w, r, sup, "restart")
	})

	// 静态托管（SPA 回退到 index.html）
	if st, err := os.Stat(distDir); err == nil && st.IsDir() {
		sub, _ := fs.Sub(os.DirFS(distDir), ".")
		fileServer := http.FileServerFS(sub)
		mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
			p := filepath.Join(distDir, filepath.Clean(strings.TrimPrefix(r.URL.Path, "/")))
			if r.URL.Path != "/" && !strings.HasSuffix(p, string(os.PathSeparator)) {
				if _, err := os.Stat(p); err == nil {
					fileServer.ServeHTTP(w, r)
					return
				}
			}
			// 回退 index.html
			index, err := os.ReadFile(filepath.Join(distDir, "index.html"))
			if err != nil {
				http.NotFound(w, r)
				return
			}
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = w.Write(index)
		})
	}
	return withCORS(mux)
}

func ctl(w http.ResponseWriter, r *http.Request, sup *supervisor.Supervisor, action string) {
	id := r.PathValue("id")
	var err error
	switch action {
	case "start":
		err = sup.Start(id)
	case "stop":
		err = sup.Stop(id)
	case "restart":
		err = sup.Restart(id)
	}
	if err != nil {
		writeJSON(w, 409, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "services": sup.Snapshot()})
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Access-Control-Allow-Origin", "*")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			if r.Method == http.MethodOptions {
				w.WriteHeader(204)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

// isLoopback 判断请求是否来自本机（密钥接口的准入条件）。
func isLoopback(remoteAddr string) bool {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		host = remoteAddr
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
