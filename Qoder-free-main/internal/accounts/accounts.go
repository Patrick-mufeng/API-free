// Package accounts persists one JSON file per Qoder account under data/accounts.
// Upstream credentials never live here: they stay inside the account home
// (<DataDir>/homes/<id>/.qoder[-cn]) owned by the per-account worker.
package accounts

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

type Account struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Region      string `json:"region"` // cn | global
	Enabled     bool   `json:"enabled"`
	AuthType    string `json:"auth_type"` // none | oauth
	Priority    int    `json:"priority"`
	MaxInFlight int    `json:"max_inflight"`
	Home        string `json:"home"`
	CreatedAt   string `json:"created_at"`
}

type Store struct {
	mu   sync.Mutex
	dir  string
	homes string
	list []Account
}

func Open(dir, homesDir string) (*Store, error) {
	s := &Store{dir: dir, homes: homesDir}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	entries, err := filepath.Glob(filepath.Join(dir, "*.json"))
	if err != nil {
		return nil, err
	}
	for _, path := range entries {
		raw, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var acct Account
		if json.Unmarshal(raw, &acct) != nil || acct.ID == "" {
			continue
		}
		s.list = append(s.list, acct)
	}
	sort.Slice(s.list, func(i, j int) bool { return s.list[i].ID < s.list[j].ID })
	return s, nil
}

func (s *Store) List() []Account {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Account, len(s.list))
	copy(out, s.list)
	return out
}

func (s *Store) Get(id string) (Account, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, acct := range s.list {
		if acct.ID == id {
			return acct, true
		}
	}
	return Account{}, false
}

// Create registers a new account and allocates its home directory.
func (s *Store) Create(name, region string, priority, maxInFlight int) (Account, error) {
	region = strings.ToLower(strings.TrimSpace(region))
	if region != "cn" && region != "global" {
		return Account{}, fmt.Errorf("region must be cn or global")
	}
	if strings.TrimSpace(name) == "" {
		switch region {
		case "cn":
			name = "Qoder CN"
		default:
			name = "Qoder"
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	id := newID()
	acct := Account{
		ID:          id,
		Name:        name,
		Region:      region,
		Enabled:     true,
		AuthType:    "none",
		Priority:    priority,
		MaxInFlight: maxInFlight,
		Home:        filepath.Join(s.homes, id),
		CreatedAt:   time.Now().UTC().Format(time.RFC3339),
	}
	if err := os.MkdirAll(acct.Home, 0o755); err != nil {
		return Account{}, err
	}
	if err := s.saveLocked(acct); err != nil {
		return Account{}, err
	}
	s.list = append(s.list, acct)
	sort.Slice(s.list, func(i, j int) bool { return s.list[i].ID < s.list[j].ID })
	return acct, nil
}

func (s *Store) Update(id string, mutate func(*Account)) (Account, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.list {
		if s.list[i].ID != id {
			continue
		}
		acct := s.list[i]
		mutate(&acct)
		if err := s.saveLocked(acct); err != nil {
			return Account{}, err
		}
		s.list[i] = acct
		return acct, nil
	}
	return Account{}, fmt.Errorf("account %s not found", id)
}

func (s *Store) Delete(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := s.list[:0]
	for _, acct := range s.list {
		if acct.ID == id {
			_ = os.Remove(filepath.Join(s.dir, id+".json"))
			continue
		}
		out = append(out, acct)
	}
	s.list = out
	return nil
}

func (s *Store) saveLocked(acct Account) error {
	raw, err := json.MarshalIndent(acct, "", "  ")
	if err != nil {
		return err
	}
	path := filepath.Join(s.dir, acct.ID+".json")
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func newID() string {
	raw := make([]byte, 6)
	if _, err := rand.Read(raw); err != nil {
		return fmt.Sprintf("qod_%d", time.Now().UnixNano())
	}
	return "qod_" + hex.EncodeToString(raw)
}
