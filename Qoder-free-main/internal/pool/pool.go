// Package pool keeps per-account runtime state (readiness, cooldowns,
// in-flight leases, success counters) and picks accounts for requests.
package pool

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type Kind string

const (
	KindNone      Kind = ""
	KindSoft      Kind = "soft"      // rate limit / busy
	KindQuota     Kind = "quota"     // credits exhausted until reset
	KindBreaker   Kind = "breaker"   // repeated hard failures
	KindAuth      Kind = "auth"      // needs login
	KindDisabled  Kind = "disabled"
)

type Entry struct {
	ID          string    `json:"id"`
	Region      string    `json:"region"`
	Enabled     bool      `json:"enabled"`
	Priority    int       `json:"priority"`
	Ready       bool      `json:"-"`
	UID         string    `json:"-"`
	InFlight    int64     `json:"-"`
	MaxInFlight int       `json:"-"`

	SuccessCount int64     `json:"success_count"`
	ErrTotal     int64     `json:"err_total"`
	LastErr      string    `json:"last_err"`
	LastErrKind  Kind      `json:"last_err_kind"`
	LastSuccess  time.Time `json:"last_success"`

	CoolKind Kind       `json:"cool_kind"`
	Until    time.Time  `json:"until"`
	Fails    int        `json:"fails"`

	LastUsed string `json:"last_used"`
	usedSeq  uint64
}

func (e *Entry) Cooling() bool {
	return e.CoolKind != KindNone && time.Now().Before(e.Until)
}

func (e *Entry) HasCapacity() bool {
	return e.MaxInFlight <= 0 || e.InFlight < int64(e.MaxInFlight)
}

// Healthy reports whether the entry may serve right now.
func (e *Entry) Healthy() bool {
	return e.Enabled && e.Ready && !e.Cooling() && e.HasCapacity()
}

type SyncItem struct {
	ID          string
	Region      string
	Enabled     bool
	MaxInFlight int
	Priority    int
}

type stickyBinding struct {
	accountID string
	expires   time.Time
}

type Pool struct {
	mu sync.Mutex
	entries map[string]*Entry
	seq     uint64

	stickyEnabled bool
	stickyTTL     time.Duration
	sticky        map[string]stickyBinding

	softBase    time.Duration
	softMax     time.Duration
	breakerAt   int
	breakerBase time.Duration

	statePath string
	dirty     bool
}

func New(statePath string, stickyEnabled bool, stickyTTL, softBase, softMax, breakerBase time.Duration, breakerAt int) *Pool {
	if breakerAt <= 0 {
		breakerAt = 3
	}
	return &Pool{
		entries:       map[string]*Entry{},
		stickyEnabled: stickyEnabled,
		stickyTTL:     stickyTTL,
		sticky:        map[string]stickyBinding{},
		softBase:      softBase,
		softMax:       softMax,
		breakerAt:     breakerAt,
		breakerBase:   breakerBase,
		statePath:     statePath,
	}
}

// Sync reconciles pool entries with the account list: adds missing accounts,
// drops removed ones, refreshes static fields (region/enabled/maxInFlight).
func (p *Pool) Sync(items []SyncItem) {
	p.mu.Lock()
	defer p.mu.Unlock()
	seen := map[string]bool{}
	for _, it := range items {
		seen[it.ID] = true
		entry := p.entries[it.ID]
		if entry == nil {
			entry = &Entry{ID: it.ID}
			p.entries[it.ID] = entry
		}
		entry.Region = it.Region
		entry.Enabled = it.Enabled
		entry.MaxInFlight = it.MaxInFlight
		entry.Priority = it.Priority
		if !it.Enabled {
			entry.CoolKind = KindDisabled
			entry.Until = time.Now().Add(100 * time.Hour)
		} else if entry.CoolKind == KindDisabled {
			entry.CoolKind = KindNone
			entry.Until = time.Time{}
		}
	}
	for id := range p.entries {
		if !seen[id] {
			delete(p.entries, id)
		}
	}
	p.dirty = true
}

func (p *Pool) Get(id string) *Entry {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.entries[id]
}

func (p *Pool) Snapshot() []Entry {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make([]Entry, 0, len(p.entries))
	for _, entry := range p.entries {
		out = append(out, *entry)
	}
	return out
}

func (p *Pool) Counts() (healthy, total int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, entry := range p.entries {
		total++
		if entry.Healthy() {
			healthy++
		}
	}
	return healthy, total
}

// Pick selects the weightiest healthy entry, excluding tried IDs and,
// when region is non-empty, entries of other regions.
func (p *Pool) Pick(exclude map[string]bool, region string) *Entry {
	p.mu.Lock()
	defer p.mu.Unlock()
	var best *Entry
	var bestWeight float64
	for _, entry := range p.entries {
		if !entry.Healthy() || exclude[entry.ID] {
			continue
		}
		if region != "" && entry.Region != region {
			continue
		}
		weight := p.weightLocked(entry)
		if best == nil || weight > bestWeight {
			best, bestWeight = entry, weight
		}
	}
	if best != nil {
		p.seq++
		best.usedSeq = p.seq
		best.LastUsed = time.Now().UTC().Format(time.RFC3339)
	}
	return best
}

func (p *Pool) weightLocked(entry *Entry) float64 {
	weight := 1.0
	if entry.SuccessCount+entry.ErrTotal == 0 {
		weight += 1.5 // unproven accounts get a fair shot
	} else {
		weight += 3.0 * float64(entry.SuccessCount) / float64(entry.SuccessCount+entry.ErrTotal)
	}
	if !entry.LastSuccess.IsZero() {
		idleHours := time.Since(entry.LastSuccess).Hours()
		if idleHours > 10 {
			idleHours = 10
		}
		weight += idleHours * 0.3
	}
	if entry.Priority > 0 {
		weight += float64(entry.Priority) / 100.0
	}
	return weight
}

// Bind maps a sticky session key to an account.
func (p *Pool) Bind(key, accountID string) {
	if !p.stickyEnabled || key == "" {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.sticky[key] = stickyBinding{accountID: accountID, expires: time.Now().Add(p.stickyTTL)}
}

// Lookup returns the account bound to a sticky key, if still valid.
func (p *Pool) Lookup(key string) (string, bool) {
	if !p.stickyEnabled || key == "" {
		return "", false
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	binding, ok := p.sticky[key]
	if !ok || time.Now().After(binding.expires) {
		if ok {
			delete(p.sticky, key)
		}
		return "", false
	}
	binding.expires = time.Now().Add(p.stickyTTL)
	p.sticky[key] = binding
	entry := p.entries[binding.accountID]
	if entry == nil || !entry.Enabled {
		delete(p.sticky, key)
		return "", false
	}
	return binding.accountID, true
}

// Acquire takes an in-flight lease; returns false when the account is full.
func (p *Pool) Acquire(id string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	entry := p.entries[id]
	if entry == nil || !entry.HasCapacity() {
		return false
	}
	entry.InFlight++
	return true
}

func (p *Pool) Release(id string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if entry := p.entries[id]; entry != nil && entry.InFlight > 0 {
		entry.InFlight--
	}
}

// NoteSuccess clears cooldown state and records the win.
func (p *Pool) NoteSuccess(id string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	entry := p.entries[id]
	if entry == nil {
		return
	}
	entry.SuccessCount++
	entry.Fails = 0
	entry.LastSuccess = time.Now()
	entry.LastErr = ""
	entry.LastErrKind = KindNone
	if entry.CoolKind == KindSoft || entry.CoolKind == KindBreaker {
		entry.CoolKind = KindNone
		entry.Until = time.Time{}
	}
	p.dirty = true
}

// NoteError applies the cooldown policy for a failure kind.
func (p *Pool) NoteError(id string, kind Kind, message string, retryAfter time.Duration) {
	p.mu.Lock()
	defer p.mu.Unlock()
	entry := p.entries[id]
	if entry == nil {
		return
	}
	entry.ErrTotal++
	entry.LastErr = message
	entry.LastErrKind = kind
	p.dirty = true
	now := time.Now()
	switch kind {
	case KindAuth, KindInvalid, KindNoRetry:
		// request-level problems: no cooldown, just recorded
	case KindQuota:
		// credits exhausted: cool until tomorrow 04:00 local, same policy as upstream resets
		until := now.Add(24 * time.Hour)
		until = time.Date(until.Year(), until.Month(), until.Day(), 4, 0, 0, 0, until.Location())
		if until.Before(now) {
			until = until.Add(24 * time.Hour)
		}
		entry.CoolKind = KindQuota
		entry.Until = until
		entry.Fails = 0
	case KindSoft:
		base := p.softBase
		if retryAfter > 0 {
			base = retryAfter
			if base > p.softMax {
				base = p.softMax
			}
		}
		entry.Fails++
		mult := time.Duration(1) << min(entry.Fails-1, 8)
		until := now.Add(base * mult)
		if max := now.Add(p.softMax); until.After(max) {
			until = max
		}
		entry.CoolKind = KindSoft
		entry.Until = until
	default: // transport / unknown: count toward breaker
		entry.Fails++
		if entry.Fails >= p.breakerAt {
			mult := time.Duration(1) << min(entry.Fails-p.breakerAt, 4)
			until := now.Add(p.breakerBase * mult)
			entry.CoolKind = KindBreaker
			entry.Until = until
		}
	}
}

// Kind values used by NoteError beyond the exported constants.
const (
	KindInvalid Kind = "invalid_request" // client error: never retry
	KindNoRetry Kind = "no_retry"
)

// SetReady updates live readiness reported by the worker manager.
func (p *Pool) SetReady(id string, ready bool, uid string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if entry := p.entries[id]; entry != nil {
		entry.Ready = ready
		entry.UID = uid
		if ready && (entry.CoolKind == KindNone) {
			entry.Fails = 0
		}
	}
}

// StickyGC drops expired bindings.
func (p *Pool) StickyGC() {
	p.mu.Lock()
	defer p.mu.Unlock()
	now := time.Now()
	for key, binding := range p.sticky {
		if now.After(binding.expires) {
			delete(p.sticky, key)
		}
	}
}

// StickyCount reports the number of live sticky bindings.
func (p *Pool) StickyCount() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	now := time.Now()
	count := 0
	for key, binding := range p.sticky {
		if now.After(binding.expires) {
			delete(p.sticky, key)
			continue
		}
		count++
	}
	return count
}

type stateAccount struct {
	SuccessCount int64     `json:"success_count"`
	ErrTotal     int64     `json:"err_total"`
	LastErr      string    `json:"last_err"`
	LastErrKind  Kind      `json:"last_err_kind"`
	LastSuccess  time.Time `json:"last_success"`
	CoolKind     Kind      `json:"cool_kind"`
	Until        time.Time `json:"until"`
	Fails        int       `json:"fails"`
}

type stateFile struct {
	Accounts map[string]stateAccount `json:"accounts"`
}

// Flush persists counters and cooldowns; called periodically and on shutdown.
func (p *Pool) Flush() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.dirty {
		return nil
	}
	snap := stateFile{Accounts: map[string]stateAccount{}}
	for id, entry := range p.entries {
		snap.Accounts[id] = stateAccount{
			SuccessCount: entry.SuccessCount,
			ErrTotal:     entry.ErrTotal,
			LastErr:      entry.LastErr,
			LastErrKind:  entry.LastErrKind,
			LastSuccess:  entry.LastSuccess,
			CoolKind:     entry.CoolKind,
			Until:        entry.Until,
			Fails:        entry.Fails,
		}
	}
	raw, err := json.MarshalIndent(snap, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p.statePath), 0o755); err != nil {
		return err
	}
	tmp := p.statePath + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, p.statePath); err != nil {
		return err
	}
	p.dirty = false
	return nil
}

// Restore loads persisted counters; entries missing from disk start fresh.
func (p *Pool) Restore() {
	raw, err := os.ReadFile(p.statePath)
	if err != nil {
		return
	}
	var snap stateFile
	if json.Unmarshal(raw, &snap) != nil {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	for id, st := range snap.Accounts {
		if entry := p.entries[id]; entry != nil {
			entry.SuccessCount = st.SuccessCount
			entry.ErrTotal = st.ErrTotal
			entry.LastErr = st.LastErr
			entry.LastErrKind = st.LastErrKind
			entry.LastSuccess = st.LastSuccess
			entry.CoolKind = st.CoolKind
			entry.Until = st.Until
			entry.Fails = st.Fails
		}
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
