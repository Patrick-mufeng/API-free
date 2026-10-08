// Package stats aggregates per-day token usage by model and account,
// persisted to data/stats.json with a rolling retention window.
package stats

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

type Record struct {
	Model      string
	AccountID  string
	Prompt     int64
	Completion int64
	Requests   int64
	Failures   int64
	LatencyMS  int64
}

type bucket struct {
	Requests   int64            `json:"requests"`
	Failures   int64            `json:"failures"`
	Prompt     int64            `json:"prompt_tokens"`
	Completion int64            `json:"completion_tokens"`
	ByModel    map[string]*cell `json:"by_model"`
	ByAccount  map[string]*cell `json:"by_account"`
}

type cell struct {
	Requests   int64 `json:"requests"`
	Failures   int64 `json:"failures"`
	Prompt     int64 `json:"prompt_tokens"`
	Completion int64 `json:"completion_tokens"`
}

type file struct {
	Days    map[string]*bucket `json:"days"`
	Grand   bucket             `json:"grand"`
	SavedAt string             `json:"saved_at"`
}

type Recorder struct {
	mu       sync.Mutex
	path     string
	keepDays int
	data     file
}

func Open(path string, keepDays int) (*Recorder, error) {
	r := &Recorder{path: path, keepDays: keepDays, data: file{Days: map[string]*bucket{}}}
	raw, err := os.ReadFile(path)
	if err == nil {
		_ = json.Unmarshal(raw, &r.data)
		if r.data.Days == nil {
			r.data.Days = map[string]*bucket{}
		}
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	return r, nil
}

func (r *Recorder) Add(rec Record) {
	r.mu.Lock()
	defer r.mu.Unlock()
	day := time.Now().Format("2006-01-02")
	b := r.data.Days[day]
	if b == nil {
		b = &bucket{ByModel: map[string]*cell{}, ByAccount: map[string]*cell{}}
		r.data.Days[day] = b
	}
	b.Requests += rec.Requests
	b.Failures += rec.Failures
	b.Prompt += rec.Prompt
	b.Completion += rec.Completion
	get := func(m map[string]*cell, key string) *cell {
		if key == "" {
			key = "unknown"
		}
		c := m[key]
		if c == nil {
			c = &cell{}
			m[key] = c
		}
		return c
	}
	get(b.ByModel, rec.Model).Requests += rec.Requests
	get(b.ByModel, rec.Model).Failures += rec.Failures
	get(b.ByModel, rec.Model).Prompt += rec.Prompt
	get(b.ByModel, rec.Model).Completion += rec.Completion
	get(b.ByAccount, rec.AccountID).Requests += rec.Requests
	get(b.ByAccount, rec.AccountID).Failures += rec.Failures
	get(b.ByAccount, rec.AccountID).Prompt += rec.Prompt
	get(b.ByAccount, rec.AccountID).Completion += rec.Completion

	r.data.Grand.Requests += rec.Requests
	r.data.Grand.Failures += rec.Failures
	r.data.Grand.Prompt += rec.Prompt
	r.data.Grand.Completion += rec.Completion
	r.pruneLocked()
	_ = r.saveLocked()
}

func (r *Recorder) pruneLocked() {
	if r.keepDays <= 0 || len(r.data.Days) <= r.keepDays {
		return
	}
	keys := make([]string, 0, len(r.data.Days))
	for day := range r.data.Days {
		keys = append(keys, day)
	}
	sort.Strings(keys)
	for _, day := range keys[:len(keys)-r.keepDays] {
		delete(r.data.Days, day)
	}
}

func (r *Recorder) saveLocked() error {
	if err := os.MkdirAll(filepath.Dir(r.path), 0o755); err != nil {
		return err
	}
	r.data.SavedAt = time.Now().UTC().Format(time.RFC3339)
	raw, err := json.MarshalIndent(r.data, "", "  ")
	if err != nil {
		return err
	}
	tmp := r.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, r.path)
}

// Report summarizes a range: today | 7d | 30d | all.
func (r *Recorder) Report(rangeName string) map[string]any {
	r.mu.Lock()
	defer r.mu.Unlock()
	days := r.collectDays(rangeName)
	totals := bucket{ByModel: map[string]*cell{}, ByAccount: map[string]*cell{}}
	series := make([]map[string]any, 0, len(days))
	for _, day := range days {
		b := r.data.Days[day]
		mergeBucket(&totals, b)
		series = append(series, map[string]any{
			"day":               day,
			"requests":          b.Requests,
			"failures":          b.Failures,
			"prompt_tokens":     b.Prompt,
			"completion_tokens": b.Completion,
		})
	}
	grand := map[string]any{
		"requests":          r.data.Grand.Requests,
		"failures":          r.data.Grand.Failures,
		"prompt_tokens":     r.data.Grand.Prompt,
		"completion_tokens": r.data.Grand.Completion,
	}
	return map[string]any{
		"range":      rangeName,
		"totals":     totals,
		"series":     series,
		"by_model":   ranked(totals.ByModel),
		"by_account": ranked(totals.ByAccount),
		"grand":      grand,
	}
}

func (r *Recorder) collectDays(rangeName string) []string {
	keys := make([]string, 0, len(r.data.Days))
	for day := range r.data.Days {
		keys = append(keys, day)
	}
	sort.Sort(sort.Reverse(sort.StringSlice(keys)))
	limit := len(keys)
	switch rangeName {
	case "today":
		limit = 1
	case "7d":
		limit = 7
	case "30d":
		limit = 30
	}
	if limit > len(keys) {
		limit = len(keys)
	}
	out := keys[:limit]
	sort.Strings(out)
	return out
}

func mergeBucket(dst *bucket, src *bucket) {
	if src == nil {
		return
	}
	dst.Requests += src.Requests
	dst.Failures += src.Failures
	dst.Prompt += src.Prompt
	dst.Completion += src.Completion
	mergeCells(dst.ByModel, src.ByModel)
	mergeCells(dst.ByAccount, src.ByAccount)
}

func mergeCells(dst, src map[string]*cell) {
	for key, c := range src {
		target := dst[key]
		if target == nil {
			target = &cell{}
			dst[key] = target
		}
		target.Requests += c.Requests
		target.Failures += c.Failures
		target.Prompt += c.Prompt
		target.Completion += c.Completion
	}
}

type rankedRow struct {
	Key        string `json:"key"`
	Requests   int64  `json:"requests"`
	Prompt     int64  `json:"prompt_tokens"`
	Completion int64  `json:"completion_tokens"`
}

func ranked(cells map[string]*cell) []rankedRow {
	rows := make([]rankedRow, 0, len(cells))
	for key, c := range cells {
		rows = append(rows, rankedRow{
			Key:        key,
			Requests:   c.Requests,
			Prompt:     c.Prompt,
			Completion: c.Completion,
		})
	}
	sort.Slice(rows, func(i, j int) bool {
		return rows[i].Prompt+rows[i].Completion > rows[j].Prompt+rows[j].Completion
	})
	return rows
}
