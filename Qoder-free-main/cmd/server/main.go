// Command server runs Qoder-free: an OpenAI-compatible gateway in front of
// per-account Qoder CLI workers, with an embedded admin panel.
package main

import (
	"context"
	"flag"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"qoder-free/internal/accounts"
	"qoder-free/internal/config"
	"qoder-free/internal/panel"
	"qoder-free/internal/pool"
	"qoder-free/internal/server"
	"qoder-free/internal/stats"
	"qoder-free/internal/worker"
)

func main() {
	configPath := flag.String("config", "config.json", "path to config.json")
	flag.Parse()

	cfg, err := config.Load(*configPath)
	if err != nil {
		log.Fatalf("load config: %v", err)
	}
	generated, err := config.EnsureAPIKey(*configPath, &cfg)
	if err != nil {
		log.Fatalf("ensure api key: %v", err)
	}
	if generated {
		log.Printf("[security] generated API key (saved to %s): %s", *configPath, cfg.APIKey)
	}
	if err := os.MkdirAll(cfg.DataDir, 0o755); err != nil {
		log.Fatalf("create data dir: %v", err)
	}

	store, err := accounts.Open(cfg.AccountsDir(), cfg.HomesDir())
	if err != nil {
		log.Fatalf("open accounts: %v", err)
	}

	logRing := panel.NewLogRing()
	log.SetOutput(io.MultiWriter(os.Stderr, logRing))

	manager := worker.NewManager(logRing)
	manager.NodeBinary = cfg.NodeBinary
	manager.DaemonPath = cfg.WorkerDaemon
	manager.CLIJS = cfg.QoderCLIJS
	manager.CLICNJS = cfg.QoderCNCLIJS
	manager.PlainTemplate = cfg.PlainTemplate
	manager.APIKey = cfg.APIKey
	manager.ProxyURL = cfg.ProxyURL
	manager.BasePort = cfg.WorkerBasePort

	var statsRecorder *stats.Recorder
	if cfg.StatsEnabled {
		statsRecorder, err = stats.Open(cfg.StatsFile(), cfg.StatsKeepDays)
		if err != nil {
			log.Printf("stats disabled: %v", err)
		}
	}

	softBase := time.Duration(cfg.CooldownSoftSeconds) * time.Second
	softMax := time.Duration(cfg.CooldownSoftMaxSeconds) * time.Second
	breakerBase := time.Duration(cfg.BreakerCooldownSeconds) * time.Second
	pl := pool.New(cfg.StateFile(), cfg.SessionSticky, time.Duration(cfg.SessionTTLSeconds)*time.Second, softBase, softMax, breakerBase, cfg.BreakerThreshold)

	pnl := panel.New(cfg, *configPath, store, pl, manager, statsRecorder, logRing)

	srv := &server.Server{
		Cfg:     cfg,
		Store:   store,
		Pool:    pl,
		Manager: manager,
		Panel:   pnl.Handler(),
		Stats:   statsRecorder,
	}

	httpServer := &http.Server{
		Addr:              cfg.Listen,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 30 * time.Second,
		ReadTimeout:       60 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go srv.WarmLoop(ctx)
	go pnl.StartQuotaLoop(ctx)

	go func() {
		log.Printf("qoder-free %s listening on http://%s", panel.Version, cfg.Listen)
		log.Printf("panel: http://%s/panel/  api base: http://%s/v1", cfg.Listen, cfg.Listen)
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("http server: %v", err)
		}
	}()

	<-ctx.Done()
	log.Printf("shutting down...")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = httpServer.Shutdown(shutdownCtx)
	manager.StopAll()
	_ = pl.Flush()
}
