// Package usage keeps the per-day, per-model request counters the panel's
// stats tab reads. The panel itself stores the cross-service series; this
// service only has to report its own daily rows.
package usage

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

type ModelStat struct {
	Input    int64 `json:"input"`
	Output   int64 `json:"output"`
	Requests int64 `json:"requests"`
	Failures int64 `json:"failures"`
}

// Day is one local calendar day. The JSON field names are what the panel's
// pullDaily reads (key/prompt_tokens/completion_tokens/requests/failures are
// produced by the panel API layer, not here).
type Day struct {
	Date     string                `json:"date"`
	Input    int64                 `json:"input"`
	Output   int64                 `json:"output"`
	Requests int64                 `json:"requests"`
	Failures int64                 `json:"failures"`
	ByModel  map[string]*ModelStat `json:"by_model,omitempty"`
}

// Health is the per-model liveness note the panel shows: the free lane's
// per-model availability genuinely fluctuates (an upstream "Endpoint is
// unavailable" is common and transient), so a model that just failed should
// say so instead of silently looking fine.
type Health struct {
	LastError   string `json:"last_error,omitempty"`
	LastErrorAt string `json:"last_error_at,omitempty"`
	LastOKAt    string `json:"last_ok_at,omitempty"`
	Failures    int64  `json:"failures"`
	OKs         int64  `json:"oks"`
}

type file struct {
	UpdatedAt   string            `json:"updated_at"`
	Days        map[string]*Day   `json:"days"`
	ModelHealth map[string]Health `json:"model_health,omitempty"`
}

type Store struct {
	mu     sync.Mutex
	days   map[string]*Day
	health map[string]Health
	path   string
	dirty  bool
}

// Open loads the usage file (missing or unreadable starts empty — counters are
// diagnostics, never a reason to fail startup).
func Open(path string) *Store {
	store := &Store{days: map[string]*Day{}, health: map[string]Health{}, path: path}
	raw, err := os.ReadFile(path)
	if err != nil {
		return store
	}
	var parsed file
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return store
	}
	for date, day := range parsed.Days {
		if day != nil {
			store.days[date] = day
		}
	}
	for model, health := range parsed.ModelHealth {
		store.health[model] = health
	}
	return store
}

// Record adds one finished request. A failed request still counts as a request
// and a failure, with no tokens; reason carries the upstream's own wording so
// the panel can show why a model just failed (empty reason = success).
func (s *Store) Record(when time.Time, model string, input, output int64, reason string) {
	date := when.Format("2006-01-02")
	stamp := when.Format(time.RFC3339)
	s.mu.Lock()
	defer s.mu.Unlock()
	day := s.days[date]
	if day == nil {
		day = &Day{Date: date, ByModel: map[string]*ModelStat{}}
		s.days[date] = day
	}
	if day.ByModel == nil {
		day.ByModel = map[string]*ModelStat{}
	}
	ok := reason == ""
	day.Requests++
	if !ok {
		day.Failures++
	}
	day.Input += input
	day.Output += output
	if model == "" {
		s.dirty = true
		return
	}
	stat := day.ByModel[model]
	if stat == nil {
		stat = &ModelStat{}
		day.ByModel[model] = stat
	}
	stat.Requests++
	if !ok {
		stat.Failures++
	}
	stat.Input += input
	stat.Output += output

	health := s.health[model]
	if ok {
		health.LastOKAt = stamp
		// The note means "the most recent attempt failed"; a success clears it
		// while the failure counter keeps the history.
		health.LastError, health.LastErrorAt = "", ""
		health.OKs++
	} else {
		health.LastError, health.LastErrorAt = reason, stamp
		health.Failures++
	}
	s.health[model] = health
	s.dirty = true
}

// HealthOf returns the liveness note for one model.
func (s *Store) HealthOf(model string) Health {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.health[model]
}

// AllHealth returns a copy of every model's liveness note.
func (s *Store) AllHealth() map[string]Health {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make(map[string]Health, len(s.health))
	for model, health := range s.health {
		out[model] = health
	}
	return out
}

// Series returns the last n days, oldest first. Days without traffic are
// omitted (the panel fills the gaps).
func (s *Store) Series(n int) []Day {
	s.mu.Lock()
	defer s.mu.Unlock()
	dates := make([]string, 0, len(s.days))
	for date := range s.days {
		dates = append(dates, date)
	}
	sort.Strings(dates)
	if n > 0 && len(dates) > n {
		dates = dates[len(dates)-n:]
	}
	out := make([]Day, 0, len(dates))
	for _, date := range dates {
		out = append(out, *cloneDay(s.days[date]))
	}
	return out
}

// Total is the all-time rollup, Today the current local day.
func (s *Store) Total() Day {
	s.mu.Lock()
	defer s.mu.Unlock()
	total := Day{Date: "total"}
	for _, day := range s.days {
		total.Input += day.Input
		total.Output += day.Output
		total.Requests += day.Requests
		total.Failures += day.Failures
	}
	return total
}

func (s *Store) Today() Day {
	date := time.Now().Format("2006-01-02")
	s.mu.Lock()
	defer s.mu.Unlock()
	if day := s.days[date]; day != nil {
		return *cloneDay(day)
	}
	return Day{Date: date}
}

// TopModels flattens the by-model counters across the window.
func (s *Store) TopModels(n int, days int) []ModelRollup {
	s.mu.Lock()
	defer s.mu.Unlock()
	dates := make([]string, 0, len(s.days))
	for date := range s.days {
		dates = append(dates, date)
	}
	sort.Strings(dates)
	if days > 0 && len(dates) > days {
		dates = dates[len(dates)-days:]
	}
	rollups := map[string]*ModelRollup{}
	for _, date := range dates {
		for model, stat := range s.days[date].ByModel {
			rollup := rollups[model]
			if rollup == nil {
				rollup = &ModelRollup{Model: model}
				rollups[model] = rollup
			}
			rollup.Input += stat.Input
			rollup.Output += stat.Output
			rollup.Requests += stat.Requests
			rollup.Failures += stat.Failures
		}
	}
	out := make([]ModelRollup, 0, len(rollups))
	for _, rollup := range rollups {
		out = append(out, *rollup)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Requests != out[j].Requests {
			return out[i].Requests > out[j].Requests
		}
		return out[i].Model < out[j].Model
	})
	if n > 0 && len(out) > n {
		out = out[:n]
	}
	return out
}

type ModelRollup struct {
	Model    string `json:"model"`
	Input    int64  `json:"input"`
	Output   int64  `json:"output"`
	Requests int64  `json:"requests"`
	Failures int64  `json:"failures"`
}

func (s *Store) Flush() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.flushLocked()
}

func (s *Store) flushLocked() error {
	if !s.dirty || s.path == "" {
		return nil
	}
	payload := file{UpdatedAt: time.Now().Format(time.RFC3339), Days: s.days, ModelHealth: s.health}
	data, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	dir := filepath.Dir(s.path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	temp, err := os.CreateTemp(dir, ".usage-*.tmp")
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
	if err := os.Rename(tempPath, s.path); err != nil {
		// Windows refuses to rename over an existing file only when a handle
		// is held; retry once after removing the target.
		if removeErr := os.Remove(s.path); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
			return err
		}
		if err := os.Rename(tempPath, s.path); err != nil {
			return err
		}
	}
	s.dirty = false
	return nil
}

// Run flushes periodically and once more when ctx ends.
func (s *Store) Run(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			_ = s.Flush()
			return
		case <-ticker.C:
			_ = s.Flush()
		}
	}
}

func cloneDay(day *Day) *Day {
	out := *day
	if day.ByModel != nil {
		out.ByModel = make(map[string]*ModelStat, len(day.ByModel))
		for model, stat := range day.ByModel {
			copied := *stat
			out.ByModel[model] = &copied
		}
	}
	return &out
}
