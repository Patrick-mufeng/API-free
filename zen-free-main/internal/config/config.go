// Package config loads, normalizes and atomically saves config.json.
//
// The file is JSON with // and /* */ comments (a typo in a field name is an
// error rather than a silent default). The API key is a single string so the
// API-free panel can read it with its auth{file,field,format} reader, which
// only understands one string field.
package config

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

type Upstream struct {
	// Zen is the upstream base; the anonymous lane lives under /v1.
	Zen string `json:"zen"`
}

type Models struct {
	// RefreshSeconds is the live catalog (S1) refresh cadence.
	RefreshSeconds int `json:"refresh_seconds"`
	// MetadataRefreshHours is the models.dev (S2) refresh cadence.
	MetadataRefreshHours int `json:"metadata_refresh_hours"`
	// MetadataCacheDays is how long the on-disk models.dev cache is trusted
	// without a successful refresh.
	MetadataCacheDays int `json:"metadata_cache_days"`
	// Exclude lists model ids (exact match) or prefixes ending in "*" that
	// must never be exposed — Muse models speak the Responses API, which this
	// service does not carry.
	Exclude []string `json:"exclude"`
}

type Limits struct {
	RequestBodyMB         int `json:"request_body_mb"`
	RequestTimeoutSeconds int `json:"request_timeout_seconds"`
	HeaderTimeoutSeconds  int `json:"header_timeout_seconds"`
	BodyIdleSeconds       int `json:"body_idle_seconds"`
	MaxRetries            int `json:"max_retries"`
}

type Config struct {
	// Listen is the bind address. Loopback only — the service injects no
	// upstream credential of yours, but the panel proxy trusts this port.
	Listen   string   `json:"listen"`
	APIKey   string   `json:"api_key"`
	DataDir  string   `json:"data_dir"`
	Upstream Upstream `json:"upstream"`
	Models   Models   `json:"models"`
	Limits   Limits   `json:"limits"`
}

func Default() Config {
	return Config{
		Listen:  "127.0.0.1:8020",
		DataDir: "data",
		Upstream: Upstream{
			Zen: "https://opencode.ai/zen",
		},
		Models: Models{
			RefreshSeconds:       300,
			MetadataRefreshHours: 24,
			MetadataCacheDays:    7,
			Exclude:              []string{"muse-spark*"},
		},
		Limits: Limits{
			RequestBodyMB:         32,
			RequestTimeoutSeconds: 600,
			HeaderTimeoutSeconds:  180,
			BodyIdleSeconds:       300,
			MaxRetries:            2,
		},
	}
}

// Load reads path, applies defaults and fills in an API key when the file
// does not carry one yet. A newly generated key is written back immediately so
// the panel can read it before the first client ever calls.
func Load(path string) (Config, error) {
	cfg := Default()
	raw, err := os.ReadFile(path)
	switch {
	case err == nil:
		clean := stripJSONComments(raw)
		decoder := json.NewDecoder(bytes.NewReader(clean))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&cfg); err != nil {
			return cfg, fmt.Errorf("%s: %w", path, err)
		}
	case errors.Is(err, os.ErrNotExist):
		// First run: keep defaults and write the file below.
	default:
		return cfg, err
	}
	cfg.applyDefaults()

	generated := false
	if cfg.APIKey == "" {
		key, err := generateKey()
		if err != nil {
			return cfg, err
		}
		cfg.APIKey, generated = key, true
	}
	if err := cfg.Validate(); err != nil {
		return cfg, err
	}
	if generated || !fileExists(path) {
		if err := Save(path, cfg); err != nil {
			return cfg, fmt.Errorf("write %s: %w", path, err)
		}
	}
	return cfg, nil
}

func (cfg *Config) applyDefaults() {
	def := Default()
	if cfg.Listen == "" {
		cfg.Listen = def.Listen
	}
	if cfg.DataDir == "" {
		cfg.DataDir = def.DataDir
	}
	if cfg.Upstream.Zen == "" {
		cfg.Upstream.Zen = def.Upstream.Zen
	}
	if cfg.Models.RefreshSeconds <= 0 {
		cfg.Models.RefreshSeconds = def.Models.RefreshSeconds
	}
	if cfg.Models.MetadataRefreshHours <= 0 {
		cfg.Models.MetadataRefreshHours = def.Models.MetadataRefreshHours
	}
	if cfg.Models.MetadataCacheDays <= 0 {
		cfg.Models.MetadataCacheDays = def.Models.MetadataCacheDays
	}
	if cfg.Models.Exclude == nil {
		cfg.Models.Exclude = def.Models.Exclude
	}
	if cfg.Limits.RequestBodyMB <= 0 {
		cfg.Limits.RequestBodyMB = def.Limits.RequestBodyMB
	}
	if cfg.Limits.RequestTimeoutSeconds <= 0 {
		cfg.Limits.RequestTimeoutSeconds = def.Limits.RequestTimeoutSeconds
	}
	if cfg.Limits.HeaderTimeoutSeconds <= 0 {
		cfg.Limits.HeaderTimeoutSeconds = def.Limits.HeaderTimeoutSeconds
	}
	if cfg.Limits.BodyIdleSeconds <= 0 {
		cfg.Limits.BodyIdleSeconds = def.Limits.BodyIdleSeconds
	}
	if cfg.Limits.MaxRetries < 0 {
		cfg.Limits.MaxRetries = 0
	}
}

// Validate refuses a non-loopback bind: the panel proxy injects this
// service's key and the free lane is meant to stay local.
func (cfg Config) Validate() error {
	host, _, err := net.SplitHostPort(cfg.Listen)
	if err != nil {
		return fmt.Errorf("listen %q: %w", cfg.Listen, err)
	}
	if err := checkLoopbackHost(host); err != nil {
		return err
	}
	if strings.TrimSpace(cfg.APIKey) == "" {
		return errors.New("api_key must not be empty")
	}
	return nil
}

func checkLoopbackHost(host string) error {
	if host == "" {
		return errors.New("listen host must not be empty")
	}
	if strings.EqualFold(host, "localhost") {
		return nil
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return fmt.Errorf("listen host %q is not loopback (the service must not be exposed)", host)
	}
	if !ip.IsLoopback() {
		return fmt.Errorf("listen host %q is not loopback (the service must not be exposed)", host)
	}
	return nil
}

// ResolveDataDir returns the data directory (absolute), creating it.
func (cfg Config) ResolveDataDir(configPath string) (string, error) {
	dir := cfg.DataDir
	if !filepath.IsAbs(dir) {
		base := filepath.Dir(configPath)
		dir = filepath.Join(base, dir)
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	return dir, nil
}

func generateKey() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("generate api_key: %w", err)
	}
	return "zen-free-" + base64.RawURLEncoding.EncodeToString(buf), nil
}

// Save writes the config atomically (temp file + rename, with the Windows
// rename-over-existing dance) so a crash never truncates it.
func Save(path string, cfg Config) error {
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	temp, err := os.CreateTemp(dir, ".config-*.tmp")
	if err != nil {
		return err
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)
	if err := temp.Chmod(0o600); err == nil {
		_, err = temp.Write(data)
	}
	if err == nil {
		err = temp.Sync()
	}
	if closeErr := temp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if runtime.GOOS == "windows" {
		backup := path + ".replace"
		_ = os.Remove(backup)
		if _, statErr := os.Stat(path); statErr == nil {
			if err := os.Rename(path, backup); err != nil {
				return err
			}
		}
		if err := os.Rename(tempPath, path); err != nil {
			_ = os.Rename(backup, path)
			return err
		}
		_ = os.Remove(backup)
		return os.Chmod(path, 0o600)
	}
	if err := os.Rename(tempPath, path); err != nil {
		return err
	}
	return os.Chmod(path, 0o600)
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// stripJSONComments removes // and /* */ comments while leaving string
// literals (and therefore URLs) untouched.
func stripJSONComments(input []byte) []byte {
	var out []byte
	inString := false
	escaped := false
	for i := 0; i < len(input); i++ {
		ch := input[i]
		if inString {
			out = append(out, ch)
			switch {
			case escaped:
				escaped = false
			case ch == '\\':
				escaped = true
			case ch == '"':
				inString = false
			}
			continue
		}
		if ch == '"' {
			inString = true
			out = append(out, ch)
			continue
		}
		if ch == '/' && i+1 < len(input) {
			switch input[i+1] {
			case '/':
				for i < len(input) && input[i] != '\n' {
					i++
				}
				out = append(out, '\n')
				continue
			case '*':
				i += 2
				for i+1 < len(input) && !(input[i] == '*' && input[i+1] == '/') {
					i++
				}
				i++
				continue
			}
		}
		out = append(out, ch)
	}
	return out
}

// RedactURL keeps credentials out of logs.
func RedactURL(raw string) string {
	at := strings.LastIndex(raw, "@")
	if at < 0 {
		return raw
	}
	scheme := strings.Index(raw, "//")
	if scheme < 0 || scheme+2 > at {
		return raw
	}
	return raw[:scheme+2] + "***@" + raw[at+1:]
}
