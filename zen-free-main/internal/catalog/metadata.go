package catalog

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"zen-free/internal/jsonx"
)

const (
	metadataDefaultURL = "https://models.dev/api.json"
	metadataTimeout    = 30 * time.Second
)

// Price is one model's models.dev entry, reduced to what this service needs:
// the free verdict (cost), the deprecation flag, and the capability fields the
// panel's model table shows.
type Price struct {
	ID            string   `json:"id"`
	Input         *float64 `json:"input_cost,omitempty"`
	Output        *float64 `json:"output_cost,omitempty"`
	Deprecated    bool     `json:"deprecated,omitempty"`
	Reasoning     bool     `json:"reasoning,omitempty"`
	EffortValues  []string `json:"effort_values,omitempty"`
	ContextWindow *int     `json:"context_window,omitempty"`
	MaxOutput     *int     `json:"max_output,omitempty"`
	Modalities    []string `json:"modalities,omitempty"`
}

type MetadataSnapshot struct {
	Ready       bool       `json:"ready"`
	Models      int        `json:"models"`
	UpdatedAt   *time.Time `json:"updated_at,omitempty"`
	NextRefresh *time.Time `json:"next_refresh,omitempty"`
	Stale       bool       `json:"stale"`
	LastError   string     `json:"last_error,omitempty"`
}

type metadataCache struct {
	UpdatedAt time.Time        `json:"updated_at"`
	Models    map[string]Price `json:"models"`
}

// Metadata is the S2 store: models.dev pricing metadata, cached on disk so a
// cold start with no network still knows which models are free.
type Metadata struct {
	mu        sync.RWMutex
	models    map[string]Price
	updatedAt time.Time
	lastError string

	cachePath       string
	endpoint        string
	client          *http.Client
	refreshInterval time.Duration
	cacheTTL        time.Duration
	logger          *slog.Logger
}

func NewMetadata(cachePath string, refreshHours, cacheDays int, logger *slog.Logger) *Metadata {
	if refreshHours <= 0 {
		refreshHours = 24
	}
	if cacheDays <= 0 {
		cacheDays = 7
	}
	store := &Metadata{
		models:          map[string]Price{},
		cachePath:       cachePath,
		endpoint:        metadataDefaultURL,
		client:          &http.Client{Timeout: metadataTimeout},
		refreshInterval: time.Duration(refreshHours) * time.Hour,
		cacheTTL:        time.Duration(cacheDays) * 24 * time.Hour,
		logger:          logger,
	}
	if err := store.loadCache(); err != nil && !errors.Is(err, os.ErrNotExist) {
		store.lastError = "load metadata cache: " + err.Error()
	}
	return store
}

func (m *Metadata) Start(ctx context.Context) {
	go func() {
		m.refreshAndLog(ctx)
		ticker := time.NewTicker(m.refreshInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				m.refreshAndLog(ctx)
			}
		}
	}()
}

func (m *Metadata) refreshAndLog(ctx context.Context) {
	if err := m.Refresh(ctx); err != nil {
		if m.logger != nil {
			m.logger.Warn("models.dev metadata refresh failed",
				"component", "models", "event", "metadata_refresh_failed", "error", err.Error())
		}
		return
	}
	if m.logger != nil {
		m.logger.Info("models.dev metadata refreshed",
			"component", "models", "event", "metadata_refreshed", "models", len(m.models))
	}
}

func (m *Metadata) Refresh(ctx context.Context) error {
	data, err := m.fetch(ctx)
	if err != nil {
		return m.recordError(err)
	}
	models, err := decodeModelsDev(data)
	if err != nil {
		return m.recordError(err)
	}
	now := time.Now().UTC()
	if m.cachePath != "" {
		if err := saveMetadataCache(m.cachePath, metadataCache{UpdatedAt: now, Models: models}); err != nil {
			return m.recordError(err)
		}
	}
	m.mu.Lock()
	m.models, m.updatedAt, m.lastError = models, now, ""
	m.mu.Unlock()
	return nil
}

func (m *Metadata) fetch(ctx context.Context) ([]byte, error) {
	refreshCtx, cancel := context.WithTimeout(ctx, metadataTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(refreshCtx, http.MethodGet, m.endpoint, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	resp, err := m.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return nil, fmt.Errorf("models.dev returned HTTP %d", resp.StatusCode)
	}
	return io.ReadAll(io.LimitReader(resp.Body, 32<<20))
}

func (m *Metadata) recordError(err error) error {
	m.mu.Lock()
	m.lastError = err.Error()
	m.mu.Unlock()
	return err
}

// Decide is the free verdict, deprecation first. A ready metadata verdict
// always wins; the "free" name only counts while metadata cannot speak
// (store not ready, or the id missing from models.dev).
func (m *Metadata) Decide(model string) Decision {
	m.mu.RLock()
	price, exists := m.models[model]
	ready := m.readyLocked()
	m.mu.RUnlock()

	nameFree := isFreeModel(model)
	fallback := func(source string) Decision {
		if nameFree {
			return Decision{Allowed: true, Source: "name_free"}
		}
		return Decision{Allowed: false, Source: source}
	}
	if !ready {
		return fallback("metadata_pending")
	}
	if !exists {
		return fallback("metadata_model_missing")
	}
	if price.Deprecated {
		return Decision{Allowed: false, Source: "metadata_deprecated", Known: true, Deprecated: true}
	}
	if price.Input != nil && price.Output != nil && *price.Input == 0 && *price.Output == 0 {
		source := "metadata_free"
		if nameFree {
			source = "name_and_metadata_free"
		}
		return Decision{Allowed: true, Source: source, Known: true}
	}
	if price.Input == nil || price.Output == nil {
		return Decision{Allowed: false, Source: "metadata_cost_unknown"}
	}
	return Decision{Allowed: false, Source: "metadata_paid", Known: true}
}

func (m *Metadata) Price(model string) (Price, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	price, ok := m.models[model]
	return price, ok
}

// Ready reports whether the store may speak for a model right now.
func (m *Metadata) Ready() bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.readyLocked()
}

func (m *Metadata) readyLocked() bool {
	if m.updatedAt.IsZero() || len(m.models) == 0 {
		return false
	}
	return time.Since(m.updatedAt) <= m.cacheTTL
}

func (m *Metadata) Snapshot() MetadataSnapshot {
	m.mu.RLock()
	defer m.mu.RUnlock()
	snapshot := MetadataSnapshot{
		Ready:     m.readyLocked(),
		Models:    len(m.models),
		LastError: m.lastError,
	}
	if !m.updatedAt.IsZero() {
		updated := m.updatedAt.UTC()
		next := updated.Add(m.refreshInterval)
		snapshot.UpdatedAt, snapshot.NextRefresh = &updated, &next
		snapshot.Stale = time.Since(updated) > m.refreshInterval
	}
	return snapshot
}

func (m *Metadata) loadCache() error {
	if m.cachePath == "" {
		return nil
	}
	file, err := os.Open(m.cachePath)
	if err != nil {
		return err
	}
	defer file.Close()
	var cache metadataCache
	if err := json.NewDecoder(io.LimitReader(file, 32<<20)).Decode(&cache); err != nil {
		return err
	}
	if cache.UpdatedAt.IsZero() || len(cache.Models) == 0 {
		return errors.New("metadata cache is empty or missing updated_at")
	}
	m.mu.Lock()
	m.models, m.updatedAt = cache.Models, cache.UpdatedAt.UTC()
	m.mu.Unlock()
	return nil
}

// decodeModelsDev reads the OpenCode provider section of models.dev,
// preferring the exact "opencode"/"opencode-zen" key over any other key that
// merely contains the word.
func decodeModelsDev(data []byte) (map[string]Price, error) {
	var providers map[string]json.RawMessage
	if err := json.Unmarshal(data, &providers); err != nil {
		return nil, fmt.Errorf("decode models.dev: %w", err)
	}
	keys := make([]string, 0, len(providers))
	for key := range providers {
		keys = append(keys, key)
	}
	sort.SliceStable(keys, func(i, j int) bool {
		left, right := metadataProviderRank(keys[i]), metadataProviderRank(keys[j])
		if left == right {
			return keys[i] < keys[j]
		}
		return left < right
	})
	for _, key := range keys {
		if metadataProviderRank(key) > 1 {
			continue
		}
		var provider map[string]any
		if json.Unmarshal(providers[key], &provider) != nil {
			continue
		}
		if metadataProviderRank(key) == 1 {
			identity := strings.ToLower(jsonx.FirstString(jsonx.StringAt(provider, "id"), jsonx.StringAt(provider, "name")))
			if !strings.Contains(identity, "opencode") {
				continue
			}
		}
		models := jsonx.MapAt(provider, "models")
		if len(models) == 0 {
			continue
		}
		result := make(map[string]Price, len(models))
		for id, raw := range models {
			model, _ := raw.(map[string]any)
			modelID := jsonx.FirstString(jsonx.StringAt(model, "id"), id)
			result[modelID] = Price{
				ID:            modelID,
				Input:         jsonx.NumberAt(model, "cost", "input"),
				Output:        jsonx.NumberAt(model, "cost", "output"),
				Deprecated:    metadataDeprecated(model),
				Reasoning:     jsonx.BoolAt(model, "reasoning"),
				EffortValues:  decodeEffortValues(model["reasoning_options"]),
				ContextWindow: intPointer(jsonx.NumberAt(model, "limit", "context")),
				MaxOutput:     intPointer(jsonx.NumberAt(model, "limit", "output")),
				Modalities:    decodeModalities(jsonx.AnyAt(model, "modalities", "input")),
			}
		}
		if len(result) > 0 {
			return result, nil
		}
	}
	return nil, errors.New("models.dev contains no OpenCode model metadata")
}

func metadataProviderRank(key string) int {
	lower := strings.ToLower(key)
	if lower == "opencode" || lower == "opencode-zen" || lower == "opencode_zen" {
		return 0
	}
	if strings.Contains(lower, "opencode") {
		return 1
	}
	return 2
}

func metadataDeprecated(model map[string]any) bool {
	if jsonx.BoolAt(model, "deprecated") {
		return true
	}
	status := strings.ToLower(jsonx.FirstString(jsonx.StringAt(model, "status"), jsonx.StringAt(model, "lifecycle")))
	if status == "deprecated" || status == "retired" || status == "disabled" {
		return true
	}
	return model["deprecated_at"] != nil || model["retirement_date"] != nil
}

// decodeEffortValues reads models.dev `reasoning_options`: an array of
// {type:"effort"|"toggle"|"budget_tokens", values:[...]} entries. Only the
// effort entries carry the upstream-honored spellings.
func decodeEffortValues(raw any) []string {
	options, ok := raw.([]any)
	if !ok {
		return nil
	}
	values := make([]string, 0, 4)
	for _, option := range options {
		entry, ok := option.(map[string]any)
		if !ok || jsonx.StringAt(entry, "type") != "effort" {
			continue
		}
		for _, value := range jsonx.SliceAt(entry, "values") {
			text, ok := value.(string)
			if ok && text != "" && !containsString(values, text) {
				values = append(values, text)
			}
		}
	}
	return values
}

// decodeModalities reads models.dev `modalities.input`. nil means the metadata
// declares nothing, which is different from an empty list.
func decodeModalities(raw any) []string {
	kinds, ok := raw.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(kinds))
	for _, kind := range kinds {
		text, ok := kind.(string)
		if ok && text != "" && !containsString(out, text) {
			out = append(out, text)
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func intPointer(value *float64) *int {
	if value == nil {
		return nil
	}
	integer := int(*value)
	return &integer
}

func saveMetadataCache(path string, cache metadataCache) error {
	data, err := json.MarshalIndent(cache, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	temp, err := os.CreateTemp(dir, ".models-dev-*.tmp")
	if err != nil {
		return err
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)
	if _, err = temp.Write(data); err == nil {
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
		return nil
	}
	return os.Rename(tempPath, path)
}
