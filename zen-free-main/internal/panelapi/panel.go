// Package panelapi serves the management endpoints the API-free panel reads.
// It is loopback-only by virtue of the listener; the shapes follow the
// existing services where that costs nothing (stats series, logs entries,
// models rows) so the panel side needs as little new code as possible.
package panelapi

import (
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"strings"

	"zen-free/internal/catalog"
	"zen-free/internal/config"
	"zen-free/internal/gateway"
	"zen-free/internal/obs"
	"zen-free/internal/usage"
)

type Server struct {
	cfg        config.Config
	configPath string
	catalog    *catalog.Catalog
	usage      *usage.Store
	ring       *obs.Ring
	gateway    *gateway.Gateway
}

func New(cfg config.Config, configPath string, cat *catalog.Catalog, store *usage.Store, ring *obs.Ring, gw *gateway.Gateway) *Server {
	return &Server{cfg: cfg, configPath: configPath, catalog: cat, usage: store, ring: ring, gateway: gw}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /panel/api/overview", s.handleOverview)
	mux.HandleFunc("GET /panel/api/stats", s.handleStats)
	mux.HandleFunc("GET /panel/api/models", s.handleModels)
	mux.HandleFunc("GET /panel/api/logs", s.handleLogs)
	mux.HandleFunc("GET /panel/api/config", s.handleConfigGet)
	mux.HandleFunc("POST /panel/api/config", s.handleConfigSave)
	return mux
}

func (s *Server) handleOverview(w http.ResponseWriter, _ *http.Request) {
	status := s.gateway.Status()
	snapshot := s.catalog.Snapshot()
	today, total := s.usage.Today(), s.usage.Total()

	note := "匿名免费通道：没有账号池，免费额度按出口 IP 限流"
	if status.RateLimited {
		note = "上游正在按 IP 限流，稍后再试或更换网络出口"
	} else if snapshot.Status == "pending" {
		note = "模型目录尚未就绪，正在连上游；当前仅暴露已验证的静态名单"
	} else if !snapshot.Metadata.Ready {
		note = "models.dev 免费判定元数据未就绪，暂时按名称判断免费模型"
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"ok":         true,
		"svc":        "zen-free",
		"version":    status.Version,
		"note":       note,
		"uptime_sec": status.UptimeSeconds,
		"inflight":   status.Inflight,
		"upstream": map[string]any{
			"zen":       s.cfg.Upstream.Zen,
			"anonymous": true,
		},
		"models_total":       snapshot.Total,
		"models_exposed":     snapshot.Exposed,
		"catalog":            snapshot,
		"rate_limited":       status.RateLimited,
		"rate_limit_until":   status.RateLimitUntil,
		"last_rate_limit_at": status.LastRateLimitAt,
		"last_error":         status.LastError,
		"last_error_at":      status.LastErrorAt,
		"today": map[string]any{
			"requests": today.Requests,
			"failures": today.Failures,
			"input":    today.Input,
			"output":   today.Output,
		},
		"total": map[string]any{
			"requests": total.Requests,
			"failures": total.Failures,
			"input":    total.Input,
			"output":   total.Output,
		},
	})
}

// handleStats answers the shape the panel's pullDaily reads:
// series[].{key,prompt_tokens,completion_tokens,requests,failures}.
// The by_model / by_account rows are translated to the field names the panel's
// usage tab renders, so that tab works without a service-specific branch.
func (s *Server) handleStats(w http.ResponseWriter, r *http.Request) {
	days := parseRange(r.URL.Query().Get("range"))
	series := s.usage.Series(days)
	rows := make([]map[string]any, 0, len(series))
	var window usage.Day
	for _, day := range series {
		window.Input += day.Input
		window.Output += day.Output
		window.Requests += day.Requests
		window.Failures += day.Failures
		rows = append(rows, map[string]any{
			"key":               day.Date,
			"prompt_tokens":     day.Input,
			"completion_tokens": day.Output,
			"requests":          day.Requests,
			"failures":          day.Failures,
		})
	}
	total := s.usage.Total()
	if len(rows) == 0 {
		window = total
	}

	byModel := s.usage.TopModels(20, days)
	modelRows := make([]map[string]any, 0, len(byModel))
	for _, row := range byModel {
		modelRows = append(modelRows, map[string]any{
			"model":             row.Model,
			"name":              row.Model,
			"prompt_tokens":     row.Input,
			"completion_tokens": row.Output,
			"total_tokens":      row.Input + row.Output,
			"requests":          row.Requests,
			"failures":          row.Failures,
		})
	}

	/* 匿名通道没有账号：如实给一行「同一条共享通道」，而不是留空让面板
	   在「账号用量」里显示「区间内没有调用记录」——那会与上面的用量自相矛盾。 */
	accountRows := []map[string]any{}
	if window.Requests > 0 {
		accountRows = append(accountRows, map[string]any{
			"label":             "匿名通道（共享，无账号）",
			"prompt_tokens":     window.Input,
			"completion_tokens": window.Output,
			"total_tokens":      window.Input + window.Output,
			"requests":          window.Requests,
			"failures":          window.Failures,
		})
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"range":  r.URL.Query().Get("range"),
		"series": rows,
		"totals": map[string]any{
			"prompt_tokens":     window.Input,
			"completion_tokens": window.Output,
			"total_tokens":      window.Input + window.Output,
			"requests":          window.Requests,
			"failures":          window.Failures,
		},
		"by_model":     modelRows,
		"by_account":   accountRows,
		"unit":         "day",
		"covered_days": len(rows),
		"grand": map[string]any{
			"prompt_tokens":     total.Input,
			"completion_tokens": total.Output,
			"total_tokens":      total.Input + total.Output,
			"requests":          total.Requests,
			"failures":          total.Failures,
		},
	})
}

// handleModels serves the panel's model tab. By default it lists exactly what
// /v1/models exposes (the free, routable set) so the table agrees with the
// service card and the access tab; ?all=1 adds every candidate in the upstream
// catalog with the reason it is withheld, which is the diagnostic view.
func (s *Server) handleModels(w http.ResponseWriter, r *http.Request) {
	all := r.URL.Query().Get("all") == "1" || r.URL.Query().Get("all") == "true"
	models := s.catalog.Exposed()
	if all {
		models = s.catalog.List()
	}
	rows := make([]map[string]any, 0, len(models))
	health := s.usage.AllHealth()
	for _, model := range models {
		decision := s.catalog.Decision(model)
		excluded := s.catalog.IsExcluded(model)
		exposed := decision.Allowed && !excluded
		row := map[string]any{
			"id":           model,
			"display_name": model,
			"source":       decision.Source,
			"free":         decision.Allowed,
			"exposed":      exposed,
			"billing":      billingLabel(decision, excluded),
		}
		// Per-model liveness: the free lane's availability genuinely
		// fluctuates, so a model that just failed says so instead of looking
		// as usable as the rest.
		if note, ok := health[model]; ok {
			if note.LastError != "" {
				row["last_error"] = note.LastError
				row["last_error_at"] = note.LastErrorAt
			}
			if note.LastOKAt != "" {
				row["last_ok_at"] = note.LastOKAt
			}
			if note.Failures > 0 {
				row["failures"] = note.Failures
			}
		}
		if price, ok := s.catalog.Price(model); ok {
			if price.ContextWindow != nil {
				row["context_window"] = *price.ContextWindow
			}
			if price.MaxOutput != nil {
				row["max_output"] = *price.MaxOutput
			}
			row["is_reasoning"] = price.Reasoning
			row["supports_reasoning"] = price.Reasoning
			if price.Reasoning {
				row["default_effort"] = "off"
				row["can_disable_thinking"] = true
			}
			if len(price.EffortValues) > 0 {
				row["supported_efforts"] = price.EffortValues
			}
			if len(price.Modalities) > 0 {
				row["input_modalities"] = price.Modalities
			}
			row["deprecated"] = price.Deprecated
		}
		if !exposed {
			row["reason"] = reasonFor(decision, excluded, s.catalog.Reason(model))
		}
		rows = append(rows, row)
	}
	sort.SliceStable(rows, func(i, j int) bool {
		left, _ := rows[i]["exposed"].(bool)
		right, _ := rows[j]["exposed"].(bool)
		if left != right {
			return left
		}
		return rows[i]["id"].(string) < rows[j]["id"].(string)
	})
	writeJSON(w, http.StatusOK, map[string]any{
		"models": rows,
		"total":  len(s.catalog.List()),
		"note":   "默认只列本服务暴露的免费模型；加 ?all=1 可看上游目录里的全部候选与未暴露原因",
	})
}

// billingLabel is the short, truthful per-model tag the panel shows. It never
// says "free" for a model the decision withheld.
func billingLabel(decision catalog.Decision, excluded bool) string {
	switch {
	case excluded:
		return "不承载"
	case decision.Allowed:
		return "免费"
	case decision.Source == "metadata_paid":
		return "付费"
	case decision.Source == "metadata_deprecated":
		return "已下架"
	case decision.Source == "metadata_cost_unknown":
		return "计价未知"
	case decision.Source == "metadata_model_missing":
		return "元数据缺失"
	default:
		return "不可用"
	}
}

func reasonFor(decision catalog.Decision, excluded bool, fallback string) string {
	if excluded {
		return "excluded by this service (non-chat upstream protocol)"
	}
	if decision.Source != "" {
		return decision.Source
	}
	return fallback
}

// handleLogs serves the ring buffer in the same entry shape the panel's log
// view reads for the other services.
func (s *Server) handleLogs(w http.ResponseWriter, _ *http.Request) {
	entries := s.ring.Snapshot()
	if entries == nil {
		entries = []obs.Entry{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"entries": entries,
		"note":    "本服务的运行日志即面板 data/logs/zen-free.log（stdout 重定向）",
	})
}

func (s *Server) handleConfigGet(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":     true,
		"path":   s.configPath,
		"config": s.cfg,
	})
}

// handleConfigSave applies the editable fields. The listen address and the API
// key are deliberately not editable here: the first would move the service
// under the panel's feet, the second is what the panel just authenticated
// with.
func (s *Server) handleConfigSave(w http.ResponseWriter, r *http.Request) {
	var patch map[string]any
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&patch); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "配置不是合法 JSON"})
		return
	}
	if _, present := patch["listen"]; present {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "listen 不能在线修改（会改变面板指向的端口）"})
		return
	}
	if _, present := patch["api_key"]; present {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "api_key 不能在线修改（面板用它读取本服务）"})
		return
	}

	next := s.cfg
	restartRequired := make([]string, 0, 2)
	if upstream, ok := patch["upstream"].(map[string]any); ok {
		if zen, ok := upstream["zen"].(string); ok && strings.TrimSpace(zen) != "" {
			next.Upstream.Zen = strings.TrimSpace(zen)
			restartRequired = append(restartRequired, "upstream.zen")
		}
	}
	if models, ok := patch["models"].(map[string]any); ok {
		if v, ok := intField(models, "refresh_seconds"); ok {
			next.Models.RefreshSeconds = v
			restartRequired = append(restartRequired, "models.refresh_seconds")
		}
		if v, ok := intField(models, "metadata_refresh_hours"); ok {
			next.Models.MetadataRefreshHours = v
			restartRequired = append(restartRequired, "models.metadata_refresh_hours")
		}
		if v, ok := intField(models, "metadata_cache_days"); ok {
			next.Models.MetadataCacheDays = v
		}
		if list, ok := models["exclude"].([]any); ok {
			exclude := make([]string, 0, len(list))
			for _, raw := range list {
				if text, ok := raw.(string); ok && strings.TrimSpace(text) != "" {
					exclude = append(exclude, strings.TrimSpace(text))
				}
			}
			next.Models.Exclude = exclude
			restartRequired = append(restartRequired, "models.exclude")
		}
	}
	if limits, ok := patch["limits"].(map[string]any); ok {
		if v, ok := intField(limits, "request_body_mb"); ok {
			next.Limits.RequestBodyMB = v
		}
		if v, ok := intField(limits, "request_timeout_seconds"); ok {
			next.Limits.RequestTimeoutSeconds = v
		}
		if v, ok := intField(limits, "header_timeout_seconds"); ok {
			next.Limits.HeaderTimeoutSeconds = v
		}
		if v, ok := intField(limits, "body_idle_seconds"); ok {
			next.Limits.BodyIdleSeconds = v
		}
		if v, ok := intField(limits, "max_retries"); ok {
			next.Limits.MaxRetries = v
			restartRequired = append(restartRequired, "limits.max_retries")
		}
	}

	if err := config.Save(s.configPath, next); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":               true,
		"path":             s.configPath,
		"restart_required": restartRequired,
		"note":             "已写入 config.json；标为 restart_required 的字段需重启本服务后生效",
		"config":           next,
	})
}

func intField(object map[string]any, key string) (int, bool) {
	value, exists := object[key]
	if !exists {
		return 0, false
	}
	switch typed := value.(type) {
	case float64:
		return int(typed), true
	case string:
		parsed, err := strconv.Atoi(strings.TrimSpace(typed))
		if err != nil {
			return 0, false
		}
		return parsed, true
	default:
		return 0, false
	}
}

func parseRange(value string) int {
	value = strings.TrimSpace(strings.ToLower(value))
	switch value {
	case "", "30d":
		return 30
	case "today", "1d":
		return 1
	case "7d":
		return 7
	}
	if strings.HasSuffix(value, "d") {
		if days, err := strconv.Atoi(strings.TrimSuffix(value, "d")); err == nil && days > 0 {
			return days
		}
	}
	return 30
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
