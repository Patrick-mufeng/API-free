// Package config loads runtime configuration from a JSON file with QF_* env overrides.
package config

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type Config struct {
	Listen        string `json:"listen"`          // e.g. 127.0.0.1:8210
	APIKey        string `json:"api_key"`         // Bearer key for /v1/* and /panel/api/*; empty generated on first boot
	DataDir       string `json:"data_dir"`        // accounts, homes, state, stats
	WorkerBasePort int   `json:"worker_base_port"` // first port for per-account workers
	NodeBinary    string `json:"node_binary"`     // node executable
	WorkerDaemon  string `json:"worker_daemon"`   // path to worker/src/daemon.mjs
	QoderCLIJS    string `json:"qoder_cli_js"`    // global bundle qodercli.js
	QoderCNCLIJS  string `json:"qoder_cn_cli_js"` // cn bundle qoderclicn.js
	PlainTemplate string `json:"plain_template"`  // worker/last-plain.sample.json
	ProxyURL      string `json:"proxy_url"`       // optional upstream proxy passed to workers

	MaxRetryAccounts int `json:"max_retry_accounts"` // rotate attempts per chat request
	MaxInFlight      int `json:"max_in_flight"`      // default per-account concurrency

	CooldownSoftSeconds    int `json:"cooldown_soft_seconds"`     // rate-limit base cooldown
	CooldownSoftMaxSeconds int `json:"cooldown_soft_max_seconds"` // exponential backoff cap
	BreakerThreshold       int `json:"breaker_threshold"`         // consecutive failures before breaker
	BreakerCooldownSeconds int `json:"breaker_cooldown_seconds"`

	SessionSticky    bool `json:"session_sticky"`     // bind conversation to one account
	SessionTTLSeconds int `json:"session_ttl_seconds"`

	StatsEnabled  bool `json:"stats_enabled"`
	StatsKeepDays int  `json:"stats_keep_days"`

	RequestBodyCapMB int `json:"request_body_cap_mb"` // /v1/chat/completions body cap
}

func Defaults() Config {
	return Config{
		Listen:                 "127.0.0.1:8210",
		DataDir:                "./data",
		WorkerBasePort:         33100,
		NodeBinary:             "node",
		WorkerDaemon:           "worker/src/daemon.mjs",
		PlainTemplate:          "worker/last-plain.sample.json",
		MaxRetryAccounts:       3,
		MaxInFlight:            4,
		CooldownSoftSeconds:    600,
		CooldownSoftMaxSeconds: 7200,
		BreakerThreshold:       3,
		BreakerCooldownSeconds: 1800,
		SessionSticky:          true,
		SessionTTLSeconds:      1800,
		StatsEnabled:           true,
		StatsKeepDays:          30,
		RequestBodyCapMB:       32,
	}
}

// Load reads defaults, then the JSON file when present, then QF_* env vars.
func Load(path string) (Config, error) {
	cfg := Defaults()
	raw, err := os.ReadFile(path)
	if err == nil {
		if err := json.Unmarshal(raw, &cfg); err != nil {
			return cfg, fmt.Errorf("parse %s: %w", path, err)
		}
	} else if !os.IsNotExist(err) {
		return cfg, err
	}
	applyEnv(&cfg)
	normalize(&cfg)
	return cfg, nil
}

func applyEnv(cfg *Config) {
	str := func(key string, dst *string) {
		if v := strings.TrimSpace(os.Getenv(key)); v != "" {
			*dst = v
		}
	}
	intv := func(key string, dst *int) {
		if v := strings.TrimSpace(os.Getenv(key)); v != "" {
			if n, err := strconv.Atoi(v); err == nil && n > 0 {
				*dst = n
			}
		}
	}
	str("QF_LISTEN", &cfg.Listen)
	str("QF_API_KEY", &cfg.APIKey)
	str("QF_DATA_DIR", &cfg.DataDir)
	intv("QF_WORKER_BASE_PORT", &cfg.WorkerBasePort)
	str("QF_NODE_BINARY", &cfg.NodeBinary)
	str("QF_WORKER_DAEMON", &cfg.WorkerDaemon)
	str("QF_QODER_CLI_JS", &cfg.QoderCLIJS)
	str("QF_QODER_CN_CLI_JS", &cfg.QoderCNCLIJS)
	str("QF_PLAIN_TEMPLATE", &cfg.PlainTemplate)
	str("QF_PROXY_URL", &cfg.ProxyURL)
	intv("QF_MAX_RETRY_ACCOUNTS", &cfg.MaxRetryAccounts)
	intv("QF_MAX_IN_FLIGHT", &cfg.MaxInFlight)
	intv("QF_COOLDOWN_SOFT_SECONDS", &cfg.CooldownSoftSeconds)
	intv("QF_COOLDOWN_SOFT_MAX_SECONDS", &cfg.CooldownSoftMaxSeconds)
	intv("QF_BREAKER_THRESHOLD", &cfg.BreakerThreshold)
	intv("QF_BREAKER_COOLDOWN_SECONDS", &cfg.BreakerCooldownSeconds)
	intv("QF_SESSION_TTL_SECONDS", &cfg.SessionTTLSeconds)
	if v := strings.TrimSpace(os.Getenv("QF_SESSION_STICKY")); v != "" {
		cfg.SessionSticky = v == "1" || strings.EqualFold(v, "true")
	}
	if v := strings.TrimSpace(os.Getenv("QF_STATS_ENABLED")); v != "" {
		cfg.StatsEnabled = v == "1" || strings.EqualFold(v, "true")
	}
}

func normalize(cfg *Config) {
	cfg.Listen = strings.TrimSpace(cfg.Listen)
	if cfg.Listen == "" {
		cfg.Listen = "127.0.0.1:8210"
	}
	cfg.DataDir = strings.TrimSpace(cfg.DataDir)
	if cfg.DataDir == "" {
		cfg.DataDir = "./data"
	}
	if cfg.MaxRetryAccounts <= 0 {
		cfg.MaxRetryAccounts = 1
	}
	if cfg.MaxRetryAccounts > 16 {
		cfg.MaxRetryAccounts = 16
	}
	if cfg.MaxInFlight <= 0 {
		cfg.MaxInFlight = 4
	}
	if cfg.CooldownSoftSeconds <= 0 {
		cfg.CooldownSoftSeconds = 600
	}
	if cfg.CooldownSoftMaxSeconds < cfg.CooldownSoftSeconds {
		cfg.CooldownSoftMaxSeconds = cfg.CooldownSoftSeconds
	}
	if cfg.BreakerThreshold <= 0 {
		cfg.BreakerThreshold = 3
	}
	if cfg.BreakerCooldownSeconds <= 0 {
		cfg.BreakerCooldownSeconds = 1800
	}
	if cfg.SessionTTLSeconds <= 0 {
		cfg.SessionTTLSeconds = 1800
	}
	if cfg.StatsKeepDays <= 0 {
		cfg.StatsKeepDays = 30
	}
	if cfg.RequestBodyCapMB <= 0 {
		cfg.RequestBodyCapMB = 32
	}
	if cfg.WorkerBasePort <= 0 {
		cfg.WorkerBasePort = 33100
	}
}

// Save writes config back atomically (used when generating api_key).
func Save(path string, cfg Config) error {
	raw, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// EnsureAPIKey returns the configured key or generates a sk- key and persists it.
func EnsureAPIKey(path string, cfg *Config) (bool, error) {
	if strings.TrimSpace(cfg.APIKey) != "" {
		return false, nil
	}
	raw := make([]byte, 24)
	if _, err := rand.Read(raw); err != nil {
		return false, err
	}
	cfg.APIKey = "sk-" + base64.RawURLEncoding.EncodeToString(raw)
	return true, Save(path, *cfg)
}

// AccountsDir / HomesDir / StateFile / StatsFile standard data paths.
func (c Config) AccountsDir() string { return filepath.Join(c.DataDir, "accounts") }
func (c Config) HomesDir() string    { return filepath.Join(c.DataDir, "homes") }
func (c Config) StateFile() string   { return filepath.Join(c.DataDir, "state.json") }
func (c Config) StatsFile() string   { return filepath.Join(c.DataDir, "stats.json") }
