// Command server runs the OpenCode Zen anonymous-lane service: an
// OpenAI-compatible endpoint on a loopback port that the API-free panel can
// supervise like any other service.
//
//	go build -o bin/zen-free.exe ./cmd/server
//	bin/zen-free.exe -config config.json      # serve (panel does this for you)
//	bin/zen-free.exe -probe                   # acceptance test against the live upstream
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"html"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"zen-free/internal/catalog"
	"zen-free/internal/config"
	"zen-free/internal/gateway"
	"zen-free/internal/obs"
	"zen-free/internal/panelapi"
	"zen-free/internal/usage"
)

func main() {
	configPath := flag.String("config", "config.json", "path to config.json")
	listen := flag.String("listen", "", "override the configured listen address (must stay loopback)")
	verbose := flag.Bool("verbose", false, "log debug level")
	probe := flag.Bool("probe", false, "run the live upstream acceptance checks and exit")
	verifyModels := flag.Bool("verify-models", false, "with -probe: check every advertised model with one real request each")
	flag.Parse()

	if *probe {
		os.Exit(runProbe(*configPath, *verbose, *verifyModels))
	}

	cfg, err := config.Load(*configPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "zen-free: %v\n", err)
		os.Exit(1)
	}
	if *listen != "" {
		cfg.Listen = *listen
		if err := cfg.Validate(); err != nil {
			fmt.Fprintf(os.Stderr, "zen-free: %v\n", err)
			os.Exit(1)
		}
	}

	level := slog.LevelInfo
	if *verbose {
		level = slog.LevelDebug
	}
	ring := obs.NewRing(500)
	logger := obs.NewLogger(ring, level)

	dataDir, err := cfg.ResolveDataDir(*configPath)
	if err != nil {
		logger.Error("cannot create the data directory", "component", "startup", "error", err.Error())
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	metadata := catalog.NewMetadata(
		dataDir+string(os.PathSeparator)+"models.dev.json",
		cfg.Models.MetadataRefreshHours,
		cfg.Models.MetadataCacheDays,
		logger,
	)
	cat := catalog.New(catalog.Options{
		BaseURL:        cfg.Upstream.Zen,
		APIKey:         "public",
		RefreshSeconds: cfg.Models.RefreshSeconds,
		Exclude:        cfg.Models.Exclude,
		Metadata:       metadata,
		Logger:         logger,
	})
	store := usage.Open(dataDir + string(os.PathSeparator) + "usage.json")
	gw := gateway.New(cfg, logger, cat, store)

	// One dispatcher, not overlapping mux patterns: /panel/* is the management
	// API, / is the human-readable summary, everything else is the gateway.
	gatewayHandler := gw.Handler()
	panelHandler := panelapi.New(cfg, *configPath, cat, store, ring, gw).Handler()
	rootHandler := handleRoot(cfg, cat)

	mux := http.NewServeMux()
	mux.Handle("/panel/", panelHandler)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" {
			rootHandler(w, r)
			return
		}
		gatewayHandler.ServeHTTP(w, r)
	})

	listener, err := net.Listen("tcp", cfg.Listen)
	if err != nil {
		logger.Error("cannot bind", "component", "startup", "listen", cfg.Listen, "error", err.Error())
		os.Exit(1)
	}

	server := &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 15 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	metadata.Start(ctx)
	cat.Start(ctx)
	go store.Run(ctx, 15*time.Second)

	logger.Info("zen-free listening",
		"component", "startup", "event", "listening", "listen", cfg.Listen,
		"version", gateway.Version(), "upstream", config.RedactURL(cfg.Upstream.Zen),
		"config", *configPath, "data_dir", dataDir, "exclude", cfg.Models.Exclude)

	errCh := make(chan error, 1)
	go func() {
		if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	select {
	case err := <-errCh:
		logger.Error("server stopped", "component", "startup", "error", err.Error())
		stop()
	case <-ctx.Done():
	}

	logger.Info("shutting down", "component", "startup", "event", "shutdown")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	_ = server.Shutdown(shutdownCtx)
	_ = store.Flush()
}

// handleRoot answers the service root with a short human-readable summary —
// the panel's "open the original panel" link lands here. It lists the models
// that are free right now, because "which models can I actually call" is the
// first question this page gets asked.
func handleRoot(cfg config.Config, cat *catalog.Catalog) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		exposed := cat.Exposed()
		snapshot := cat.Snapshot()

		var modelList strings.Builder
		for _, model := range exposed {
			detail := ""
			if price, ok := cat.Price(model); ok {
				parts := make([]string, 0, 2)
				if price.ContextWindow != nil {
					parts = append(parts, fmt.Sprintf("上下文 %dK", *price.ContextWindow/1000))
				}
				if price.Reasoning {
					parts = append(parts, "推理")
				}
				if len(parts) > 0 {
					detail = " <span class=dim>" + strings.Join(parts, " · ") + "</span>"
				}
			}
			fmt.Fprintf(&modelList, "<li><code>%s</code>%s</li>", html.EscapeString(model), detail)
		}
		if len(exposed) == 0 {
			modelList.WriteString("<li class=dim>暂时没有可用的免费模型（上游目录状态：" + html.EscapeString(snapshot.Status) + "）</li>")
		}

		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprintf(w, `<!doctype html><meta charset="utf-8"><title>zen-free</title>
<style>body{font:14px/1.7 system-ui,sans-serif;max-width:680px;margin:48px auto;padding:0 20px;color:#222}
code{background:#f2f2f4;padding:2px 6px;border-radius:5px}h1{font-size:20px}
ul{padding-left:20px;columns:2;column-gap:28px}li{margin:2px 0;break-inside:avoid}.dim{color:#888;font-size:12.5px}
.note{color:#666;font-size:12.5px}</style>
<h1>zen-free %s</h1>
<p>OpenCode Zen 匿名免费通道的本地反代服务。没有账号、没有密钥池，上游鉴权就是字面量 <code>public</code>。</p>
<h2 style="font-size:15px;margin-bottom:6px">当前可用的免费模型（%d 个）</h2>
<ul>%s</ul>
<p class="note">上游目录共 %d 个模型，其余判定为付费或已下架，调用会返回 400 并写明原因；
走 Responses 协议的 Muse 系列不在本服务范围内。免费判定 = 上游实时目录 ∩ models.dev cost 为 0。</p>
<ul style="columns:1">
<li>OpenAI 兼容入口：<code>http://%s/v1</code></li>
<li>模型列表：<code>GET /v1/models</code>（只含上面这些）</li>
<li>管理接口：<code>/panel/api/overview</code>、<code>/panel/api/stats</code>、<code>/panel/api/models</code>（<code>?all=1</code> 看全部）、<code>/panel/api/logs</code></li>
<li>健康检查：<code>GET /healthz</code></li>
</ul>
<p class="note">上游：<code>%s</code>　管理请回到 API-free 面板（127.0.0.1:9000）。</p>`,
			gateway.Version(), len(exposed), modelList.String(), snapshot.Total, cfg.Listen, cfg.Upstream.Zen)
	}
}
