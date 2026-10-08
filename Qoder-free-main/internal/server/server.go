// Package server exposes the OpenAI-compatible API, /healthz, and mounts the
// admin panel. Chat requests pick an account from the pool, forward the
// OpenAI-shaped payload to the account's worker, and relay SSE frames.
package server

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"qoder-free/internal/accounts"
	"qoder-free/internal/config"
	"qoder-free/internal/pool"
	"qoder-free/internal/relay"
	"qoder-free/internal/stats"
	"qoder-free/internal/worker"
)

type Server struct {
	Cfg      config.Config
	Store    *accounts.Store
	Pool     *pool.Pool
	Manager  *worker.Manager
	Panel    http.Handler
	Stats    *stats.Recorder

	mu          sync.Mutex
	modelsCache map[string]modelsCacheEntry
}

type modelsCacheEntry struct {
	fetchedAt time.Time
	entries   []worker.ModelEntry
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/chat/completions", s.withAuth(s.handleChat))
	mux.HandleFunc("/v1/models", s.withAuth(s.handleModels))
	mux.HandleFunc("/healthz", s.handleHealthz)
	mux.Handle("/panel", s.Panel)
	mux.Handle("/panel/", s.Panel)
	return mux
}

func (s *Server) withAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.Cfg.APIKey == "" {
			next(w, r)
			return
		}
		_, token, ok := strings.Cut(r.Header.Get("Authorization"), " ")
		token = strings.TrimSpace(token)
		if !ok || token == "" {
			w.Header().Set("WWW-Authenticate", `Bearer realm="qoder-free"`)
			writeError(w, http.StatusUnauthorized, "missing_api_key", "Provide Authorization: Bearer <api key>.")
			return
		}
		if subtle.ConstantTimeCompare([]byte(token), []byte(s.Cfg.APIKey)) != 1 {
			writeError(w, http.StatusUnauthorized, "invalid_api_key", "API key does not match.")
			return
		}
		next(w, r)
	}
}

// ---- chat ----

type chatMeta struct {
	Model       string          `json:"model"`
	Messages    json.RawMessage `json:"messages"`
	Stream      bool            `json:"stream"`
	Metadata    json.RawMessage `json:"metadata"`
}

func (s *Server) handleChat(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method", "POST only")
		return
	}
	body := io.LimitReader(r.Body, int64(s.Cfg.RequestBodyCapMB)<<20)
	raw, err := io.ReadAll(body)
	if err != nil {
		writeError(w, http.StatusBadRequest, "read_body", err.Error())
		return
	}
	var meta chatMeta
	if json.Unmarshal(raw, &meta) != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", "Body must be an OpenAI chat completion JSON object.")
		return
	}
	if strings.TrimSpace(meta.Model) == "" {
		writeError(w, http.StatusBadRequest, "missing_model", "model is required")
		return
	}

	region, model := splitRegion(meta.Model)
	requestID := newRequestID()
	stickyKey := ""
	if s.Cfg.SessionSticky {
		stickyKey = sessionKey(meta)
	}

	var lastErr error
	tried := map[string]bool{}
	for attempt := 0; attempt < s.Cfg.MaxRetryAccounts; attempt++ {
		accountID := ""
		if attempt == 0 && stickyKey != "" {
			if bound, ok := s.Pool.Lookup(stickyKey); ok {
				entry := s.Pool.Get(bound)
				if entry != nil && entry.Healthy() && (region == "" || entry.Region == region) {
					accountID = bound
				}
			}
		}
		if accountID == "" {
			entry := s.Pool.Pick(tried, region)
			if entry == nil {
				break
			}
			accountID = entry.ID
		}
		tried[accountID] = true
		acct, ok := s.Store.Get(accountID)
		if !ok || !acct.Enabled {
			continue
		}
		if !s.Pool.Acquire(accountID) {
			continue
		}
		status := s.attempt(r.Context(), w, acct, model, region, requestID, raw, stickyKey, meta.Stream)
		s.Pool.Release(accountID)
		switch status {
		case attemptDone, attemptClientError:
			return
		default:
			lastErr = s.lastAttemptError(accountID)
		}
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("no healthy Qoder account available")
	}
	writeError(w, http.StatusBadGateway, "no_available_account", lastErr.Error())
}

type attemptStatus int

const (
	attemptDone attemptStatus = iota
	attemptClientError
	attemptRetry
)

func (s *Server) attempt(ctx context.Context, w http.ResponseWriter, acct accounts.Account, model, region, requestID string, rawBody []byte, stickyKey string, stream bool) attemptStatus {
	if err := s.ensureWarm(acct); err != nil {
		s.Pool.NoteError(acct.ID, pool.KindBreaker, err.Error(), 0)
		log.Printf("[chat] account %s not warm: %v", acct.ID, err)
		return attemptRetry
	}
	url, _ := s.Manager.URL(acct.ID)
	payload := buildChatPayload(rawBody, model, stream)
	client := s.Manager.Client(acct.ID)
	started := time.Now()
	resp, err := client.Chat(ctx, url, requestID, payload)
	if err != nil {
		kind := pool.KindBreaker
		if werr, ok := err.(*worker.WorkerError); ok {
			switch werr.Kind {
			case worker.ErrKindRateLimit:
				kind = pool.KindSoft
			case worker.ErrKindQuota:
				kind = pool.KindQuota
			case worker.ErrKindAuth:
				kind = pool.KindAuth
			case worker.ErrKindInvalidRequest, worker.ErrKindModelMissing:
				kind = pool.KindNoRetry
			}
			retry := werr.RetryAfter
			s.Pool.NoteError(acct.ID, kind, werr.Error(), retry)
			if werr.Kind == worker.ErrKindInvalidRequest {
				status := http.StatusBadRequest
				if werr.Status >= 400 && werr.Status < 500 {
					status = werr.Status
				}
				writeUpstreamError(w, status, werr)
				return attemptClientError
			}
			log.Printf("[chat] account %s attempt failed: %v", acct.ID, werr)
			return attemptRetry
		}
		s.Pool.NoteError(acct.ID, kind, err.Error(), 0)
		log.Printf("[chat] account %s attempt failed: %v", acct.ID, err)
		return attemptRetry
	}
	defer resp.Body.Close()

	// Remember sticky binding on success.
	if stickyKey != "" {
		s.Pool.Bind(stickyKey, acct.ID)
	}

	if stream {
		usage, relayErr := relay.RelayStream(w, resp.Body)
		latency := time.Since(started).Milliseconds()
		s.recordUsage(acct, modelFromPayload(payload), usage, latency, relayErr)
		if relayErr != nil {
			var mid *relay.MidStreamError
			if asMid(relayErr, &mid) {
				s.Pool.NoteError(acct.ID, pool.KindSoft, mid.Message, 0)
			}
			return attemptDone // headers already sent; nothing more we can do
		}
		s.Pool.NoteSuccess(acct.ID)
		return attemptDone
	}

	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	latency := time.Since(started).Milliseconds()
	usage := usageFromJSON(raw)
	s.recordUsage(acct, modelFromPayload(payload), usage, latency, nil)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(raw)
	s.Pool.NoteSuccess(acct.ID)
	return attemptDone
}

func asMid(err error, target **relay.MidStreamError) bool {
	mid, ok := err.(*relay.MidStreamError)
	if ok {
		*target = mid
	}
	return ok
}

// ensureWarm spawns the worker when needed and waits until it can serve.
func (s *Server) ensureWarm(acct accounts.Account) error {
	if s.Manager.Running(acct.ID) {
		if health, err := s.Manager.Probe(context.Background(), acct.ID); err == nil && health.HasAuthManager {
			s.Pool.SetReady(acct.ID, true, health.UID)
			return nil
		}
	}
	if err := s.Manager.Start(acct.ID, acct.Region, acct.Home, coalesce(acct.MaxInFlight, s.Cfg.MaxInFlight)); err != nil {
		return err
	}
	health, err := s.Manager.WaitHealthy(context.Background(), acct.ID, true, 90*time.Second)
	if err != nil {
		return err
	}
	s.Pool.SetReady(acct.ID, true, health.UID)
	return nil
}

func coalesce(v, def int) int {
	if v > 0 {
		return v
	}
	return def
}

// buildChatPayload whitelists OpenAI fields the worker understands, mirroring
// cli2api's BuildChatPayload: unknown fields are dropped, raw JSON preserved.
func buildChatPayload(raw []byte, model string, stream bool) []byte {
	var in struct {
		Messages              json.RawMessage `json:"messages"`
		MaxTokens             json.RawMessage `json:"max_tokens"`
		MaxCompletionTokens   json.RawMessage `json:"max_completion_tokens"`
		Temperature           json.RawMessage `json:"temperature"`
		TopP                  json.RawMessage `json:"top_p"`
		Stop                  json.RawMessage `json:"stop"`
		ParallelToolCalls     *bool           `json:"parallel_tool_calls"`
		ResponseFormat        json.RawMessage `json:"response_format"`
		Tools                 json.RawMessage `json:"tools"`
		ToolChoice            json.RawMessage `json:"tool_choice"`
		IsReasoning           *bool           `json:"is_reasoning"`
		EnableThinking        *bool           `json:"enable_thinking"`
		EnableReasoning       *bool           `json:"enable_reasoning"`
		Thinking              json.RawMessage `json:"thinking"`
		ReasoningEffort       json.RawMessage `json:"reasoning_effort"`
		ReasoningBudgetTokens json.RawMessage `json:"reasoning_budget_tokens"`
	}
	_ = json.Unmarshal(raw, &in)
	payload := map[string]any{
		"model":    model,
		"messages": in.Messages,
		"stream":   stream,
	}
	set := func(key string, rawField json.RawMessage) {
		if len(rawField) > 0 {
			payload[key] = json.RawMessage(rawField)
		}
	}
	if len(in.MaxCompletionTokens) > 0 {
		payload["max_tokens"] = json.RawMessage(in.MaxCompletionTokens)
	} else {
		set("max_tokens", in.MaxTokens)
	}
	set("temperature", in.Temperature)
	set("top_p", in.TopP)
	set("stop", in.Stop)
	set("response_format", in.ResponseFormat)
	set("tools", in.Tools)
	set("tool_choice", in.ToolChoice)
	set("thinking", in.Thinking)
	set("reasoning_effort", in.ReasoningEffort)
	set("reasoning_budget_tokens", in.ReasoningBudgetTokens)
	if in.ParallelToolCalls != nil {
		payload["parallel_tool_calls"] = *in.ParallelToolCalls
	}
	if in.IsReasoning != nil {
		payload["is_reasoning"] = *in.IsReasoning
	}
	if in.EnableThinking != nil {
		payload["enable_thinking"] = *in.EnableThinking
	}
	if in.EnableReasoning != nil {
		payload["enable_reasoning"] = *in.EnableReasoning
	}
	out, err := json.Marshal(payload)
	if err != nil {
		return raw
	}
	return out
}

func peekStream(payload []byte) bool {
	var probe struct {
		Stream bool `json:"stream"`
	}
	_ = json.Unmarshal(payload, &probe)
	return probe.Stream
}

func modelFromPayload(payload []byte) string {
	var probe struct {
		Model string `json:"model"`
	}
	_ = json.Unmarshal(payload, &probe)
	return probe.Model
}

func usageFromJSON(raw []byte) relay.Usage {
	var parsed struct {
		Usage struct {
			PromptTokens     int64  `json:"prompt_tokens"`
			CompletionTokens int64  `json:"completion_tokens"`
			TotalTokens      int64  `json:"total_tokens"`
			Source           string `json:"source"`
		} `json:"usage"`
	}
	if json.Unmarshal(raw, &parsed) != nil {
		return relay.Usage{Source: "none"}
	}
	u := relay.Usage{
		PromptTokens:     parsed.Usage.PromptTokens,
		CompletionTokens: parsed.Usage.CompletionTokens,
		TotalTokens:      parsed.Usage.TotalTokens,
		Source:           parsed.Usage.Source,
	}
	if u.Source == "" {
		u.Source = "upstream"
	}
	return u
}

func (s *Server) lastAttemptError(accountID string) error {
	for _, entry := range s.Pool.Snapshot() {
		if entry.ID == accountID && entry.LastErr != "" {
			return fmt.Errorf("account %s: %s", accountID, entry.LastErr)
		}
	}
	return fmt.Errorf("account %s failed", accountID)
}

// sessionKey mirrors workbuddy-free's sticky keys: metadata ids first, then
// a digest of system + first user text.
func sessionKey(meta chatMeta) string {
	if len(meta.Metadata) > 0 {
		var md map[string]any
		if json.Unmarshal(meta.Metadata, &md) == nil {
			for _, key := range []string{"conversation_id", "conversationId", "user_id", "sessionId"} {
				if v, ok := md[key].(string); ok && strings.TrimSpace(v) != "" {
					return "m:" + strings.TrimSpace(v)
				}
			}
		}
	}
	var probe struct {
		ConversationID string `json:"conversation_id"`
	}
	if json.Unmarshal(meta.Metadata, &probe) == nil && probe.ConversationID != "" {
		return "b:" + probe.ConversationID
	}
	var messages []struct {
		Role    string          `json:"role"`
		Content json.RawMessage `json:"content"`
	}
	if json.Unmarshal(meta.Messages, &messages) != nil {
		return ""
	}
	system, firstUser := "", ""
	for _, message := range messages {
		text := flattenContent(message.Content)
		if message.Role == "system" || message.Role == "developer" {
			system += text + "\n"
			continue
		}
		if message.Role == "user" && firstUser == "" {
			firstUser = text
		}
	}
	if firstUser == "" {
		return ""
	}
	digest := sha256.Sum256([]byte(system + firstUser))
	return "d:" + hex.EncodeToString(digest[:8])
}

func flattenContent(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return text
	}
	var parts []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &parts) == nil {
		out := ""
		for _, part := range parts {
			if part.Type == "text" || part.Type == "" {
				out += part.Text
			}
		}
		return out
	}
	return ""
}

// splitRegion strips an optional "cn:" / "global:" prefix.
func splitRegion(model string) (region, bare string) {
	bare = model
	if strings.HasPrefix(bare, "cn:") {
		return "cn", strings.TrimPrefix(bare, "cn:")
	}
	if strings.HasPrefix(bare, "global:") {
		return "global", strings.TrimPrefix(bare, "global:")
	}
	return "", bare
}

func newRequestID() string {
	raw := make([]byte, 8)
	if _, err := cryptoRead(raw); err != nil {
		return fmt.Sprintf("req_%d", time.Now().UnixNano())
	}
	return "req_" + hex.EncodeToString(raw)
}

// ---- models ----

func (s *Server) handleModels(w http.ResponseWriter, r *http.Request) {
	type modelOut struct {
		ID      string `json:"id"`
		Object  string `json:"object"`
		OwnedBy string `json:"owned_by"`
	}
	seen := map[string]bool{}
	out := []modelOut{}
	add := func(id string) {
		if id == "" || seen[id] {
			return
		}
		seen[id] = true
		out = append(out, modelOut{ID: id, Object: "model", OwnedBy: "qoder-free"})
	}
	for _, acct := range s.Store.List() {
		if !acct.Enabled {
			continue
		}
		entries := s.accountModels(r.Context(), acct)
		prefix := ""
		if acct.Region == "cn" {
			prefix = "cn:"
		} else if acct.Region == "global" {
			prefix = "global:"
		}
		for _, entry := range entries {
			add(entry.ID)
			if prefix != "" {
				add(prefix + entry.ID)
			}
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"object": "list", "data": out})
}

func (s *Server) accountModels(ctx context.Context, acct accounts.Account) []worker.ModelEntry {
	s.mu.Lock()
	cached, ok := s.modelsCache[acct.ID]
	s.mu.Unlock()
	if ok && time.Since(cached.fetchedAt) < time.Minute {
		return cached.entries
	}
	if !s.Manager.Running(acct.ID) {
		return nil
	}
	url, ok := s.Manager.URL(acct.ID)
	if !ok {
		return nil
	}
	client := s.Manager.Client(acct.ID)
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	entries, err := client.Models(ctx, url, false)
	if err != nil {
		return nil
	}
	s.mu.Lock()
	if s.modelsCache == nil {
		s.modelsCache = map[string]modelsCacheEntry{}
	}
	s.modelsCache[acct.ID] = modelsCacheEntry{fetchedAt: time.Now(), entries: entries}
	s.mu.Unlock()
	return entries
}

// ---- healthz ----

func (s *Server) handleHealthz(w http.ResponseWriter, r *http.Request) {
	healthy, total := s.Pool.Counts()
	writeJSON(w, http.StatusOK, map[string]any{
		"healthy":  healthy,
		"total":    total,
		"service":  "qoder-free",
	})
}

// ---- warm loop ----

// WarmLoop keeps workers alive: starts missing ones, refreshes readiness,
// and restarts crashed daemons with a 30s retry backoff.
func (s *Server) WarmLoop(ctx context.Context) {
	lastAttempt := map[string]time.Time{}
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	refresh := func() {
		list := s.Store.List()
		items := make([]pool.SyncItem, 0, len(list))
		for _, acct := range list {
			items = append(items, pool.SyncItem{
				ID: acct.ID, Region: acct.Region, Enabled: acct.Enabled,
				MaxInFlight: coalesce(acct.MaxInFlight, s.Cfg.MaxInFlight), Priority: acct.Priority,
			})
		}
		s.Pool.Sync(items)
		for _, acct := range list {
			if !acct.Enabled {
				continue
			}
			if s.Manager.Running(acct.ID) {
				if health, err := s.Manager.Probe(ctx, acct.ID); err == nil {
					s.Pool.SetReady(acct.ID, health.HasAuthManager, health.UID)
					if health.HasAuthManager && health.UID != "" && acct.AuthType != "oauth" {
						_, _ = s.Store.Update(acct.ID, func(a *accounts.Account) { a.AuthType = "oauth" })
					}
					continue
				}
				continue // process alive but busy; exit handler will clean up on death
			}
			if when, seen := lastAttempt[acct.ID]; seen && time.Since(when) < 30*time.Second {
				continue
			}
			lastAttempt[acct.ID] = time.Now()
			if err := s.Manager.Start(acct.ID, acct.Region, acct.Home, coalesce(acct.MaxInFlight, s.Cfg.MaxInFlight)); err != nil {
				log.Printf("[warm] start %s: %v", acct.ID, err)
				continue
			}
			go func(acct accounts.Account) {
				health, err := s.Manager.WaitHealthy(ctx, acct.ID, true, 120*time.Second)
				if err != nil {
					log.Printf("[warm] %s not ready: %v", acct.ID, err)
					return
				}
				s.Pool.SetReady(acct.ID, true, health.UID)
				log.Printf("[warm] account %s ready (uid=%s)", acct.ID, health.UID)
			}(acct)
		}
		go func() {
			_ = s.Pool.Flush()
		}()
	}
	refresh()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			refresh()
			s.Pool.StickyGC()
		}
	}
}

func (s *Server) recordUsage(acct accounts.Account, model string, usage relay.Usage, latencyMS int64, err error) {
	if s.Stats == nil {
		return
	}
	rec := stats.Record{
		Model:      model,
		AccountID:  acct.ID,
		Prompt:     usage.PromptTokens,
		Completion: usage.CompletionTokens,
		Requests:   1,
		LatencyMS:  latencyMS,
	}
	if err != nil {
		rec.Failures = 1
	}
	s.Stats.Add(rec)
}
