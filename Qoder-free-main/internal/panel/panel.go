// Package panel serves the embedded admin UI and its JSON API under /panel.
// The panel is unauthenticated by design: it binds to loopback together with
// the rest of the service, while client traffic on /v1/* keeps the API key.
package panel

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"qoder-free/internal/accounts"
	"qoder-free/internal/config"
	"qoder-free/internal/pool"
	"qoder-free/internal/stats"
	"qoder-free/internal/worker"
)

// Version is the release identifier shown in the panel and startup log.
// Release builds override it via:
//
//	go build -ldflags "-X qoder-free/internal/panel.Version=vX.Y.Z" ./cmd/server
var Version = "0.1.0"

type Panel struct {
	Cfg     config.Config
	CfgPath string
	Store   *accounts.Store
	Pool    *pool.Pool
	Manager *worker.Manager
	Stats   *stats.Recorder
	Start   time.Time

	ring *LogRing

	quotaMu    sync.Mutex
	quotaCache map[string]*worker.Quota
	quotaAt    map[string]time.Time
}

func New(cfg config.Config, cfgPath string, store *accounts.Store, pl *pool.Pool, manager *worker.Manager, statsRecorder *stats.Recorder, logs io.Writer) *Panel {
	ring, _ := logs.(*LogRing)
	return &Panel{
		Cfg:        cfg,
		CfgPath:    cfgPath,
		Store:      store,
		Pool:       pl,
		Manager:    manager,
		Stats:      statsRecorder,
		Start:      time.Now(),
		ring:       ring,
		quotaCache: map[string]*worker.Quota{},
		quotaAt:    map[string]time.Time{},
	}
}

// StartQuotaLoop refreshes cached quota for ready accounts every 5 minutes
// so the accounts table always has credits to show without blocking requests.
func (p *Panel) StartQuotaLoop(ctx context.Context) {
	refresh := func() {
		for _, acct := range p.Store.List() {
			if !acct.Enabled || !p.Manager.Running(acct.ID) {
				continue
			}
			if entry := p.Pool.Get(acct.ID); entry == nil || !entry.Ready {
				continue
			}
			url, ok := p.Manager.URL(acct.ID)
			if !ok {
				continue
			}
			cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
			quota, err := p.Manager.Client(acct.ID).Quota(cctx, url, false)
			cancel()
			if err == nil && quota != nil {
				// Skip empty buckets: workers report zeros before the first warm login.
				if totalQ, _, _ := quota.Remaining(); totalQ > 0 || quota.IsQuotaExceeded {
					p.quotaMu.Lock()
					p.quotaCache[acct.ID] = quota
					p.quotaAt[acct.ID] = time.Now()
					p.quotaMu.Unlock()
				}
			}
		}
	}
	refresh()
	go func() {
		ticker := time.NewTicker(5 * time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				refresh()
			}
		}
	}()
}

func (p *Panel) cachedQuota(id string) (*worker.Quota, string) {
	p.quotaMu.Lock()
	defer p.quotaMu.Unlock()
	return p.quotaCache[id], p.quotaAt[id].Format("15:04:05")
}

// Logs returns the io.Writer the app mirrors its log output into.
func (p *Panel) Logs() io.Writer {
	if p.ring == nil {
		p.ring = NewLogRing()
	}
	return p.ring
}

// ---- log ring ----

const ringCapacity = 800

// LogEntry is one classified log line served to the panel.
type LogEntry struct {
	ID   int    `json:"id"`
	Ch   string `json:"ch"` // chat | worker | sys
	Text string `json:"text"`
	TS   string `json:"ts"`
}

type LogRing struct {
	mu     sync.Mutex
	lines  []LogEntry
	nextID int
}

func NewLogRing() *LogRing { return &LogRing{lines: make([]LogEntry, 0, ringCapacity)} }

// classify maps a log line to a panel channel.
func classifyLine(line string) string {
	switch {
	case strings.HasPrefix(line, "[chat]"):
		return "chat"
	case strings.HasPrefix(line, "[worker]"), strings.HasPrefix(line, "[warm]"):
		return "sys"
	case strings.HasPrefix(line, "[qod_"):
		return "worker"
	default:
		return "sys"
	}
}

func (r *LogRing) Write(p []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for len(p) > 0 {
		idx := -1
		for i, b := range p {
			if b == '\n' {
				idx = i
				break
			}
		}
		if idx < 0 {
			if len(p) > 0 {
				r.appendLocked(string(p))
			}
			break
		}
		line := strings.TrimRight(string(p[:idx]), "\r")
		r.appendLocked(line)
		p = p[idx+1:]
	}
	return len(p), nil
}

func (r *LogRing) appendLocked(line string) {
	if strings.TrimSpace(line) == "" {
		return
	}
	r.nextID++
	r.lines = append(r.lines, LogEntry{
		ID:   r.nextID,
		Ch:   classifyLine(line),
		Text: line,
		TS:   time.Now().Format("15:04:05"),
	})
	if len(r.lines) > ringCapacity {
		r.lines = r.lines[len(r.lines)-ringCapacity:]
	}
}

func (r *LogRing) Snapshot(after int) []LogEntry {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := []LogEntry{}
	for _, line := range r.lines {
		if line.ID > after {
			out = append(out, line)
		}
	}
	return out
}

// ---- HTTP ----

func (p *Panel) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/panel/{$}", p.serveIndex)
	mux.HandleFunc("/panel/app.js", p.serveApp)
	mux.HandleFunc("/panel/api/", p.route)
	return mux
}

func (p *Panel) route(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/panel/api/")
	parts := strings.Split(rest, "/")
	switch {
	case rest == "overview" && r.Method == http.MethodGet:
		p.handleOverview(w, r)
	case rest == "logs" && r.Method == http.MethodGet:
		after, _ := strconv.Atoi(r.URL.Query().Get("after"))
		entries := []LogEntry{}
		if p.ring != nil {
			entries = p.ring.Snapshot(after)
		}
		writeJSON(w, http.StatusOK, map[string]any{"entries": entries})
	case rest == "stats" && r.Method == http.MethodGet:
		if p.Stats == nil {
			writeJSON(w, http.StatusOK, map[string]any{"enabled": false})
			return
		}
		report := p.Stats.Report(r.URL.Query().Get("range"))
		report["enabled"] = true
		writeJSON(w, http.StatusOK, report)
	case rest == "models" && r.Method == http.MethodGet:
		p.handleModels(w, r)
	case rest == "config" && r.Method == http.MethodGet:
		visible := p.Cfg
		if visible.APIKey != "" {
			visible.APIKey = visible.APIKey[:8] + "…"
		}
		writeJSON(w, http.StatusOK, visible)
	case rest == "config" && r.Method == http.MethodPost:
		p.handleConfigSave(w, r)
	case rest == "config/api-key" && r.Method == http.MethodGet:
		// Returns the full key for the config page's copy button; the
		// config listing above stays masked so screenshots are safe.
		writeJSON(w, http.StatusOK, map[string]string{"api_key": p.Cfg.APIKey})
	case len(parts) == 1 && r.Method == http.MethodPost:
		p.handleAccountAction(w, r, parts[0], "")
	// accounts/{id}/{action} —— action 里允许再带一段（login/start、login/poll）。
	// 少了这条分支，面板前端（与原面板 app.js）发的 login/start 会落进 default
	// 变成 404 not_found，表现为「点登录没反应/添加账号失败」。
	case len(parts) == 4 && parts[0] == "accounts" && r.Method == http.MethodPost:
		p.handleAccountAction(w, r, parts[1], parts[2]+"/"+parts[3])
	case len(parts) == 3 && parts[0] == "accounts" && r.Method == http.MethodPost:
		p.handleAccountAction(w, r, parts[1], parts[2])
	case len(parts) == 3 && parts[0] == "accounts" && r.Method == http.MethodGet:
		p.handleAccountGet(w, r, parts[1], parts[2])
	case len(parts) == 2 && r.Method == http.MethodGet:
		p.handleAccountGet(w, r, parts[0], parts[1])
	default:
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not_found"})
	}
}

// ---- overview ----

func (p *Panel) handleOverview(w http.ResponseWriter, r *http.Request) {
	healthy, total := p.Pool.Counts()
	type accountRow struct {
		accounts.Account
		Ready      bool    `json:"ready"`
		UID        string  `json:"uid"`
		InFlight   int64   `json:"in_flight"`
		CoolKind   string  `json:"cool_kind"`
		CoolUntil  string  `json:"cool_until"`
		Success    int64   `json:"success_count"`
		Errors     int64   `json:"err_total"`
		LastErr    string  `json:"last_err"`
		LastErrKnd string  `json:"last_err_kind"`
		Running    bool    `json:"running"`
		Credits    float64 `json:"credits"`
		CredTotal  float64 `json:"credits_total"`
		QuotaAt    string  `json:"quota_at"`
		HasQuota   bool    `json:"has_quota"`
	}
	rows := []accountRow{}
	for _, acct := range p.Store.List() {
		row := accountRow{Account: acct, CoolKind: string(pool.KindNone)}
		if entry := p.Pool.Get(acct.ID); entry != nil {
			row.Ready = entry.Ready
			row.UID = entry.UID
			row.InFlight = entry.InFlight
			row.CoolKind = string(entry.CoolKind)
			if !entry.Until.IsZero() && time.Now().Before(entry.Until) {
				row.CoolUntil = entry.Until.Format(time.RFC3339)
			}
			row.Success = entry.SuccessCount
			row.Errors = entry.ErrTotal
			row.LastErr = entry.LastErr
			row.LastErrKnd = string(entry.LastErrKind)
		}
		row.Running = p.Manager.Running(acct.ID)
		if quota, at := p.cachedQuota(acct.ID); quota != nil {
			if totalQ, remainingQ, ok := quota.Remaining(); ok {
				row.Credits = remainingQ
				row.CredTotal = totalQ
				row.QuotaAt = at
				row.HasQuota = true
			}
		}
		rows = append(rows, row)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"version":      Version,
		"uptime_s":     int(time.Since(p.Start).Seconds()),
		"healthy":      healthy,
		"total":        total,
		"sticky_count": p.Pool.StickyCount(),
		"accounts":     rows,
	})
}

// ---- account ops ----

func (p *Panel) handleAccountAction(w http.ResponseWriter, r *http.Request, id, action string) {
	acct, ok := p.Store.Get(id)
	if !ok && action != "" {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "account_not_found"})
		return
	}
	switch {
	case action == "": // create account
		var body struct {
			Name        string `json:"name"`
			Region      string `json:"region"`
			Priority    int    `json:"priority"`
			MaxInFlight int    `json:"max_inflight"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_json"})
			return
		}
		created, err := p.Store.Create(body.Name, body.Region, body.Priority, body.MaxInFlight)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		p.Pool.Sync(p.syncItems())
		p.syncAccount(created)
		writeJSON(w, http.StatusOK, created)
	case action == "delete":
		p.Manager.Stop(id)
		_ = p.Store.Delete(id)
		p.Pool.Sync(p.syncItems())
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	case action == "enable" || action == "disable":
		enabled := action == "enable"
		updated, err := p.Store.Update(id, func(a *accounts.Account) { a.Enabled = enabled })
		if err != nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
			return
		}
		if !enabled {
			p.Manager.Stop(id)
		}
		p.Pool.Sync(p.syncItems())
		if enabled {
			p.syncAccount(updated)
		}
		writeJSON(w, http.StatusOK, updated)
	case action == "login/start":
		p.managerAction(w, acct, func(ctx context.Context, url string) (any, error) {
			return p.Manager.Client(acct.ID).LoginDevice(ctx, url)
		})
	case action == "login/poll":
		p.handleLoginPoll(w, acct)
	case action == "rewarm":
		p.managerAction(w, acct, func(ctx context.Context, url string) (any, error) {
			if err := p.Manager.Client(acct.ID).Rewarm(ctx, url); err != nil {
				return nil, err
			}
			return map[string]any{"ok": true}, nil
		})
	case action == "checkin":
		p.managerAction(w, acct, func(ctx context.Context, url string) (any, error) {
			return p.Manager.Client(acct.ID).Checkin(ctx, url)
		})
	default:
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "unknown_action"})
	}
}

func (p *Panel) handleAccountGet(w http.ResponseWriter, r *http.Request, id, resource string) {
	acct, ok := p.Store.Get(id)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "account_not_found"})
		return
	}
	switch resource {
	case "quota":
		refresh := r.URL.Query().Get("refresh") == "1"
		p.managerAction(w, acct, func(ctx context.Context, url string) (any, error) {
			quota, err := p.Manager.Client(acct.ID).Quota(ctx, url, refresh)
			if err == nil && quota != nil {
				p.quotaMu.Lock()
				p.quotaCache[acct.ID] = quota
				p.quotaAt[acct.ID] = time.Now()
				p.quotaMu.Unlock()
			}
			return quota, err
		})
	case "login":
		p.handleLoginPoll(w, acct)
	default:
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "unknown_resource"})
	}
}

func (p *Panel) handleLoginPoll(w http.ResponseWriter, acct accounts.Account) {
	p.managerAction(w, acct, func(ctx context.Context, url string) (any, error) {
		state, err := p.Manager.Client(acct.ID).LoginStatus(ctx, url)
		if err != nil {
			return nil, err
		}
		if state.Status == "ok" && acct.AuthType != "oauth" {
			if _, err := p.Store.Update(acct.ID, func(a *accounts.Account) { a.AuthType = "oauth" }); err == nil {
				acct.AuthType = "oauth"
			}
		}
		return state, nil
	})
}

type managerFunc func(ctx context.Context, url string) (any, error)

func (p *Panel) managerAction(w http.ResponseWriter, acct accounts.Account, fn managerFunc) {
	if err := p.ensureRunning(acct); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": err.Error()})
		return
	}
	url, ok := p.Manager.URL(acct.ID)
	if !ok {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "worker not running"})
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	result, err := fn(ctx, url)
	if err != nil {
		status := http.StatusBadGateway
		if werr, ok := err.(*worker.WorkerError); ok && werr.Status >= 400 && werr.Status < 600 {
			status = werr.Status
		}
		writeJSON(w, status, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, result)
}

// ensureRunning starts the worker and waits until its HTTP server answers.
func (p *Panel) ensureRunning(acct accounts.Account) error {
	if p.Manager.Running(acct.ID) {
		return nil
	}
	maxInFlight := acct.MaxInFlight
	if maxInFlight <= 0 {
		maxInFlight = p.Cfg.MaxInFlight
	}
	if err := p.Manager.Start(acct.ID, acct.Region, acct.Home, maxInFlight); err != nil {
		return err
	}
	_, err := p.Manager.WaitHealthy(context.Background(), acct.ID, false, 120*time.Second)
	return err
}

// syncAccount warms a freshly created/enabled account in the background.
func (p *Panel) syncAccount(acct accounts.Account) {
	go func() {
		if !acct.Enabled {
			return
		}
		maxInFlight := acct.MaxInFlight
		if maxInFlight <= 0 {
			maxInFlight = p.Cfg.MaxInFlight
		}
		if err := p.Manager.Start(acct.ID, acct.Region, acct.Home, maxInFlight); err != nil {
			return
		}
		if health, err := p.Manager.WaitHealthy(context.Background(), acct.ID, false, 120*time.Second); err == nil {
			p.Pool.SetReady(acct.ID, health.HasAuthManager, health.UID)
		}
	}()
}

func (p *Panel) syncItems() []pool.SyncItem {
	list := p.Store.List()
	items := make([]pool.SyncItem, 0, len(list))
	for _, acct := range list {
		maxInFlight := acct.MaxInFlight
		if maxInFlight <= 0 {
			maxInFlight = p.Cfg.MaxInFlight
		}
		items = append(items, pool.SyncItem{
			ID: acct.ID, Region: acct.Region, Enabled: acct.Enabled,
			MaxInFlight: maxInFlight, Priority: acct.Priority,
		})
	}
	return items
}

// ---- models ----

func (p *Panel) handleModels(w http.ResponseWriter, r *http.Request) {
	type row struct {
		ID          string `json:"id"`
		Region      string `json:"region"`
		AccountID   string `json:"account_id"`
		DisplayName string `json:"display_name"`
		Reasoning   bool   `json:"is_reasoning"`
		Free        bool   `json:"free"`
		PriceLabel  string `json:"price_label"`
	}
	rows := []row{}
	for _, acct := range p.Store.List() {
		if !acct.Enabled || !p.Manager.Running(acct.ID) {
			continue
		}
		url, ok := p.Manager.URL(acct.ID)
		if !ok {
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		entries, err := p.Manager.Client(acct.ID).Models(ctx, url, false)
		cancel()
		if err != nil {
			continue
		}
		for _, entry := range entries {
			rows = append(rows, row{
				ID: entry.ID, Region: acct.Region, AccountID: acct.ID,
				DisplayName: entry.DisplayName, Reasoning: entry.IsReasoning,
				Free:       entry.IsFree(),
				PriceLabel: entry.CreditsLabel(),
			})
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"models": rows})
}

// ---- config ----

func (p *Panel) handleConfigSave(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_json"})
		return
	}
	updated := p.Cfg
	if v, ok := body["listen"].(string); ok && strings.TrimSpace(v) != "" {
		updated.Listen = strings.TrimSpace(v)
	}
	if v, ok := body["proxy_url"].(string); ok {
		updated.ProxyURL = strings.TrimSpace(v)
	}
	if v, ok := body["max_in_flight"].(float64); ok && v > 0 {
		updated.MaxInFlight = int(v)
	}
	if v, ok := body["max_retry_accounts"].(float64); ok && v > 0 {
		updated.MaxRetryAccounts = int(v)
	}
	if v, ok := body["cooldown_soft_seconds"].(float64); ok && v > 0 {
		updated.CooldownSoftSeconds = int(v)
	}
	if v, ok := body["session_sticky"].(bool); ok {
		updated.SessionSticky = v
	}
	if v, ok := body["stats_enabled"].(bool); ok {
		updated.StatsEnabled = v
	}
	if v, ok := body["stats_keep_days"].(float64); ok && v > 0 {
		updated.StatsKeepDays = int(v)
	}
	// api_key / listen are server-managed: shown read-only, edits go through config.json + restart.
	if err := config.Save(p.CfgPath, updated); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	p.Cfg = updated
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "config": updated})
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}
