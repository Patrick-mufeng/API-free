// Package catalog is the S1/S2/S3 model directory with the free decision.
//
//	S1  live GET {zen}/v1/models          — what exists right now
//	S2  models.dev cost metadata          — what is free (cached on disk)
//	S3  compile-time verified list        — bootstrap while S1 is pending
//
// A model is exposed only when S1 says it exists (or S1 is still pending) and
// the S2 verdict allows it. The decision order is deprecation-first: a ready
// metadata verdict always wins, and the "free" name only counts while metadata
// cannot speak — otherwise a delisted-but-still-cataloged id like
// deepseek-v4-flash-free stays exposed forever.
//
// Ported from opencode2dsh (MIT, (c) FishBottle7) legacy/internal/catalog and
// packages/plugin/src/adapter/catalog.ts, keeping the TypeScript side's
// deprecation-first fix and the 7-day metadata cache TTL.
package catalog

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"zen-free/internal/compat"
)

type Decision struct {
	Allowed    bool   `json:"allowed"`
	Source     string `json:"source"`
	Known      bool   `json:"known"`
	Deprecated bool   `json:"deprecated,omitempty"`
}

type Snapshot struct {
	Status    string           `json:"status"`
	Total     int              `json:"total"`
	Exposed   int              `json:"exposed"`
	UpdatedAt *time.Time       `json:"updated_at,omitempty"`
	LastError string           `json:"last_error,omitempty"`
	Source    string           `json:"source"`
	Metadata  MetadataSnapshot `json:"metadata"`
}

type Options struct {
	BaseURL        string
	APIKey         string
	RefreshSeconds int
	Exclude        []string
	Metadata       *Metadata
	Logger         *slog.Logger
	Client         *http.Client
	StartupRetry   time.Duration
}

type Catalog struct {
	mu        sync.RWMutex
	zen       map[string]bool
	updatedAt time.Time
	lastError string

	baseURL        string
	apiKey         string
	refreshSeconds int
	exclude        []string
	metadata       *Metadata
	logger         *slog.Logger
	client         *http.Client
	startupRetry   time.Duration
}

func New(opts Options) *Catalog {
	client := opts.Client
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	retry := opts.StartupRetry
	if retry <= 0 {
		retry = 15 * time.Second
	}
	return &Catalog{
		zen:            map[string]bool{},
		baseURL:        strings.TrimRight(opts.BaseURL, "/"),
		apiKey:         opts.APIKey,
		refreshSeconds: opts.RefreshSeconds,
		exclude:        opts.Exclude,
		metadata:       opts.Metadata,
		logger:         opts.Logger,
		client:         client,
		startupRetry:   retry,
	}
}

func (c *Catalog) Replace(models []string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.zen = make(map[string]bool, len(models))
	for _, model := range models {
		c.zen[model] = true
	}
	c.updatedAt = time.Now()
	c.lastError = ""
}

func (c *Catalog) recordError(err error) {
	c.mu.Lock()
	c.lastError = err.Error()
	c.mu.Unlock()
}

// List is every candidate id: the live catalog once S1 has succeeded, the
// static bootstrap list while it is still pending.
func (c *Catalog) List() []string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if len(c.zen) == 0 {
		return staticFreeList()
	}
	models := make([]string, 0, len(c.zen))
	for model := range c.zen {
		models = append(models, model)
	}
	sort.Strings(models)
	return models
}

// Exposed is what /v1/models serves: candidates the decision allows and the
// catalog can actually route (exclusions, e.g. Responses-only models, dropped).
func (c *Catalog) Exposed() []string {
	out := make([]string, 0, 16)
	for _, model := range c.List() {
		if c.IsExcluded(model) || !c.Decision(model).Allowed {
			continue
		}
		out = append(out, model)
	}
	return out
}

// IsExcluded reports whether the operator's exclude list rules the model out.
// Entries match exactly, or by prefix when they end in "*".
func (c *Catalog) IsExcluded(model string) bool {
	for _, pattern := range c.exclude {
		if pattern == "" {
			continue
		}
		if strings.HasSuffix(pattern, "*") {
			if strings.HasPrefix(model, strings.TrimSuffix(pattern, "*")) {
				return true
			}
			continue
		}
		if pattern == model {
			return true
		}
	}
	return false
}

// Supported reports whether the model can be routed. A pending catalog has no
// upstream snapshot to contradict a request, so it stays permissive — matching
// the reference implementation's pre-refresh behaviour.
func (c *Catalog) Supported(model string) bool {
	if c.IsExcluded(model) {
		return false
	}
	c.mu.RLock()
	defer c.mu.RUnlock()
	if len(c.zen) == 0 {
		return true
	}
	return c.zen[model]
}

// Decision merges the S2 verdict with the S3 vouch. A known metadata verdict
// (paid, or free) wins, with one exception: an id on the compile-time verified
// list stays allowed when metadata either cannot speak or only says
// "deprecated" — the hy3-free case, which kept working upstream after
// models.dev flagged it and only died when it left the Zen catalog.
func (c *Catalog) Decision(model string) Decision {
	if c.metadata != nil {
		decision := c.metadata.Decide(model)
		if isStaticFreeModel(model) && !decision.Allowed && (!decision.Known || decision.Source == "metadata_deprecated") {
			return Decision{Allowed: true, Source: "static_verified"}
		}
		return decision
	}
	if isStaticFreeModel(model) {
		return Decision{Allowed: true, Source: "static_verified"}
	}
	if isFreeModel(model) {
		return Decision{Allowed: true, Source: "name_fallback"}
	}
	return Decision{Allowed: false, Source: "metadata_pending"}
}

// Reason explains, in one line, why a model is not exposed — for the panel's
// model table and for support questions.
func (c *Catalog) Reason(model string) string {
	if c.IsExcluded(model) {
		return "excluded by this service (non-chat upstream protocol)"
	}
	if !c.Supported(model) {
		return "not in the live upstream catalog"
	}
	return c.Decision(model).Source
}

func (c *Catalog) Snapshot() Snapshot {
	c.mu.RLock()
	pending := len(c.zen) == 0
	total := len(c.zen)
	updatedAt := c.updatedAt
	lastError := c.lastError
	c.mu.RUnlock()

	snapshot := Snapshot{Total: total, UpdatedAt: timeOrNil(updatedAt), LastError: lastError}
	switch {
	case pending:
		snapshot.Status = "pending"
		snapshot.Source = "static"
		snapshot.Total = len(staticFreeModels)
		snapshot.Exposed = len(c.Exposed())
	case c.staleLocked():
		snapshot.Status = "stale"
		snapshot.Source = "live"
		snapshot.Exposed = len(c.Exposed())
	default:
		snapshot.Status = "ready"
		snapshot.Source = "live"
		snapshot.Exposed = len(c.Exposed())
	}
	if snapshot.Exposed == 0 && !pending {
		snapshot.Status = "empty"
	}
	if c.metadata != nil {
		snapshot.Metadata = c.metadata.Snapshot()
	}
	return snapshot
}

func (c *Catalog) staleLocked() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.updatedAt.IsZero() {
		return false
	}
	return time.Since(c.updatedAt) > time.Duration(max(2*c.refreshSeconds, 120))*time.Second
}

// Start runs the refresh loop: a startup phase that retries quickly while the
// catalog is still empty (VPN/TUN reconnects and slow DNS must not leave the
// service with only the static list for five minutes), then the regular
// cadence.
func (c *Catalog) Start(ctx context.Context) {
	go func() {
		for {
			err := c.Refresh(ctx)
			wait := time.Duration(c.refreshSeconds) * time.Second
			if err != nil && len(c.List()) == 0 {
				wait = c.startupRetry
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(wait):
			}
		}
	}()
}

func (c *Catalog) Refresh(ctx context.Context) error {
	refreshCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	models, status, err := FetchModels(refreshCtx, c.client, c.baseURL, c.apiKey)
	if err != nil {
		c.recordError(err)
		if c.logger != nil {
			c.logger.Warn("model catalog refresh failed",
				"component", "models", "event", "catalog_refresh_failed", "status", status, "error", err.Error())
		}
		return err
	}
	c.Replace(models)
	if c.logger != nil {
		c.logger.Info("model catalog refreshed",
			"component", "models", "event", "catalog_refreshed", "total", len(models), "exposed", len(c.Exposed()))
	}
	return nil
}

type modelsResponse struct {
	Data []struct {
		ID string `json:"id"`
	} `json:"data"`
}

// FetchModels is the S1 live listing. It uses the CLI-shaped request (user
// agent + anonymous key) because the same lane serves it.
func FetchModels(ctx context.Context, client *http.Client, baseURL, key string) ([]string, int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(baseURL, "/")+"/v1/models", nil)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("User-Agent", compat.UserAgent())
	req.Header.Set("x-opencode-client", "cli")
	resp, err := client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return nil, resp.StatusCode, fmt.Errorf("models endpoint returned HTTP %d", resp.StatusCode)
	}
	var payload modelsResponse
	if err := json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(&payload); err != nil {
		return nil, resp.StatusCode, err
	}
	models := make([]string, 0, len(payload.Data))
	for _, item := range payload.Data {
		if item.ID != "" {
			models = append(models, item.ID)
		}
	}
	if len(models) == 0 {
		return nil, resp.StatusCode, errors.New("models endpoint returned an empty list")
	}
	return models, resp.StatusCode, nil
}

// Price exposes the S2 capability record for a model (context window, output
// limit, reasoning ladder, input modalities) so the API layers can describe
// what a model can do without reaching into the metadata store.
func (c *Catalog) Price(model string) (Price, bool) {
	if c.metadata == nil {
		return Price{}, false
	}
	return c.metadata.Price(model)
}

// ExcludePatterns returns the configured exclusion list (exact ids, or
// prefixes ending in "*").
func (c *Catalog) ExcludePatterns() []string { return append([]string(nil), c.exclude...) }

func timeOrNil(value time.Time) *time.Time {
	if value.IsZero() {
		return nil
	}
	utc := value.UTC()
	return &utc
}
