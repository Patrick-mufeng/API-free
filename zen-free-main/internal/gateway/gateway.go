// Package gateway is the OpenAI-compatible surface: /v1/models,
// /v1/chat/completions and /healthz, plus the upstream call path.
//
// The upstream body always streams (stream: true) because that is half of the
// free-lane gate; a client asking for a non-streaming answer gets the stream
// assembled back into one chat.completion here. That also means one code path
// accounts for usage, and the endpoint can retry until the first byte is
// committed to the client.
package gateway

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"zen-free/internal/catalog"
	"zen-free/internal/compat"
	"zen-free/internal/config"
	"zen-free/internal/jsonx"
	"zen-free/internal/usage"
)

const version = "0.1.0"

// Version reports the build version.
func Version() string { return version }

type Gateway struct {
	cfg     config.Config
	log     *slog.Logger
	client  *http.Client
	catalog *catalog.Catalog
	usage   *usage.Store

	started  time.Time
	inflight atomic.Int64

	stateMu          sync.Mutex
	rateLimitedUntil time.Time
	lastRateLimitAt  time.Time
	lastError        string
	lastErrorAt      time.Time
}

// Status is the runtime view the panel API serves.
type Status struct {
	Version         string     `json:"version"`
	UptimeSeconds   int64      `json:"uptime_sec"`
	Inflight        int64      `json:"inflight"`
	RateLimited     bool       `json:"rate_limited"`
	RateLimitUntil  *time.Time `json:"rate_limit_until,omitempty"`
	LastRateLimitAt *time.Time `json:"last_rate_limit_at,omitempty"`
	LastError       string     `json:"last_error,omitempty"`
	LastErrorAt     *time.Time `json:"last_error_at,omitempty"`
}

func New(cfg config.Config, log *slog.Logger, cat *catalog.Catalog, store *usage.Store) *Gateway {
	transport := &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		// The upstream is TLS-only and long-lived streams share one host.
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          32,
		MaxIdleConnsPerHost:   16,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   15 * time.Second,
		ExpectContinueTimeout: time.Second,
		// Covers a cold model start before the first byte of the response.
		ResponseHeaderTimeout: time.Duration(cfg.Limits.HeaderTimeoutSeconds) * time.Second,
	}
	return &Gateway{
		cfg:     cfg,
		log:     log,
		client:  &http.Client{Transport: transport},
		catalog: cat,
		usage:   store,
		started: time.Now(),
	}
}

func (g *Gateway) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/models", g.authenticate(g.handleModels))
	mux.HandleFunc("POST /v1/chat/completions", g.authenticate(g.handleInference))
	mux.HandleFunc("GET /healthz", g.handleHealth)
	return mux
}

func (g *Gateway) Status() Status {
	g.stateMu.Lock()
	defer g.stateMu.Unlock()
	status := Status{
		Version:       version,
		UptimeSeconds: int64(time.Since(g.started).Seconds()),
		Inflight:      g.inflight.Load(),
		LastError:     g.lastError,
	}
	if !g.lastErrorAt.IsZero() {
		at := g.lastErrorAt.UTC()
		status.LastErrorAt = &at
	}
	if !g.lastRateLimitAt.IsZero() {
		at := g.lastRateLimitAt.UTC()
		status.LastRateLimitAt = &at
	}
	if time.Now().Before(g.rateLimitedUntil) {
		until := g.rateLimitedUntil.UTC()
		status.RateLimited, status.RateLimitUntil = true, &until
	}
	return status
}

func (g *Gateway) authenticate(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		candidates := []string{strings.TrimSpace(r.Header.Get("x-api-key"))}
		if auth := r.Header.Get("Authorization"); strings.HasPrefix(strings.ToLower(auth), "bearer ") {
			candidates = append(candidates, strings.TrimSpace(auth[7:]))
		}
		valid := false
		for _, candidate := range candidates {
			if len(candidate) == len(g.cfg.APIKey) && subtle.ConstantTimeCompare([]byte(candidate), []byte(g.cfg.APIKey)) == 1 {
				valid = true
			}
		}
		if !valid {
			writeAPIError(w, http.StatusUnauthorized, "invalid local API key", "authentication_error", "")
			return
		}
		next(w, r)
	}
}

func (g *Gateway) handleModels(w http.ResponseWriter, _ *http.Request) {
	now := time.Now().Unix()
	exposed := g.catalog.Exposed()
	data := make([]map[string]any, 0, len(exposed))
	for _, model := range exposed {
		entry := map[string]any{"id": model, "object": "model", "created": now, "owned_by": "opencode-zen"}
		if price, ok := g.catalog.Price(model); ok {
			if price.ContextWindow != nil {
				entry["context_window"] = *price.ContextWindow
			}
			if price.MaxOutput != nil {
				entry["max_output"] = *price.MaxOutput
			}
			if price.Reasoning {
				entry["reasoning"] = true
			}
			if len(price.EffortValues) > 0 {
				entry["supported_efforts"] = price.EffortValues
			}
		}
		data = append(data, entry)
	}
	writeJSON(w, http.StatusOK, map[string]any{"object": "list", "data": data})
}

func (g *Gateway) handleHealth(w http.ResponseWriter, _ *http.Request) {
	catalogSnapshot := g.catalog.Snapshot()
	today, total := g.usage.Today(), g.usage.Total()
	status := g.Status()

	issues := make([]string, 0, 4)
	httpStatus := http.StatusOK
	health := "ok"
	switch catalogSnapshot.Status {
	case "pending":
		health, httpStatus = "starting", http.StatusServiceUnavailable
		issues = append(issues, "model_catalog_pending")
	case "empty":
		health, httpStatus = "degraded", http.StatusServiceUnavailable
		issues = append(issues, "model_catalog_empty")
	case "stale":
		health = "degraded"
		issues = append(issues, "model_catalog_stale")
	}
	if !catalogSnapshot.Metadata.Ready {
		issues = append(issues, "metadata_pending")
		if health == "ok" {
			health = "degraded"
		}
	}
	if status.RateLimited {
		issues = append(issues, "upstream_rate_limited")
		if health == "ok" {
			health = "degraded"
		}
	}

	writeJSON(w, httpStatus, map[string]any{
		"status":     health,
		"ready":      httpStatus == http.StatusOK,
		"version":    version,
		"anonymous":  true,
		"uptime_sec": status.UptimeSeconds,
		"inflight":   status.Inflight,
		"models":     catalogSnapshot,
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
		"rate_limit": map[string]any{
			"limited":         status.RateLimited,
			"until":           status.RateLimitUntil,
			"last_limited_at": status.LastRateLimitAt,
		},
		"last_error": status.LastError,
		"issues":     issues,
	})
}

func (g *Gateway) handleInference(w http.ResponseWriter, r *http.Request) {
	g.inflight.Add(1)
	defer g.inflight.Add(-1)

	started := time.Now()
	maxBody := int64(g.cfg.Limits.RequestBodyMB) << 20
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBody))
	if err != nil {
		g.recordFailure("", started, "")
		writeAPIError(w, http.StatusBadRequest, "request body is too large or unreadable", "invalid_request_error", "")
		return
	}
	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		g.recordFailure("", started, "")
		writeAPIError(w, http.StatusBadRequest, "request body must be a JSON object", "invalid_request_error", "")
		return
	}
	model := jsonx.StringAt(payload, "model")
	if model == "" {
		g.recordFailure("", started, "")
		writeAPIError(w, http.StatusBadRequest, "model is required", "invalid_request_error", "model")
		return
	}
	if !g.catalog.Supported(model) {
		// Record the refusal without a model name: nothing was consumed, and a
		// zero-token row in the panel's model distribution would read as a bug.
		g.recordFailure("", started, "")
		writeAPIError(w, http.StatusBadRequest,
			fmt.Sprintf("model %q is not in the anonymous Zen catalog (%s)", model, g.catalog.Reason(model)),
			"invalid_request_error", "model")
		return
	}
	if decision := g.catalog.Decision(model); !decision.Allowed {
		g.recordFailure("", started, "")
		writeAPIError(w, http.StatusBadRequest,
			fmt.Sprintf("model %q is not on the free anonymous lane (%s)", model, decision.Source),
			"invalid_request_error", "model")
		return
	}

	clientStream := jsonx.BoolAt(payload, "stream")
	requestIDs := compat.DeriveRequestIDs(r.Header, payload)
	notes := compat.Prepare(payload)
	if !clientStream {
		// The assembled response hides the extra chunk, so a non-streaming
		// client is the one place we can ask for usage unconditionally.
		if _, exists := payload["stream_options"]; !exists {
			payload["stream_options"] = map[string]any{"include_usage": true}
		}
	}
	upstreamBody, err := json.Marshal(payload)
	if err != nil {
		g.recordFailure(model, started, "request could not be encoded")
		writeAPIError(w, http.StatusBadRequest, "request contains unsupported JSON values", "invalid_request_error", "")
		return
	}

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	if !clientStream {
		timeout := time.Duration(g.cfg.Limits.RequestTimeoutSeconds) * time.Second
		ctx, cancel = context.WithTimeout(r.Context(), timeout)
		defer cancel()
	}

	resp, err := g.doUpstream(ctx, upstreamBody, requestIDs)
	if err != nil {
		reason := friendlyTransportError(err)
		g.recordFailure(model, started, reason)
		g.recordError(reason)
		g.log.Warn("upstream request failed",
			"component", "upstream", "event", "request_failed", "request_id", requestIDs.Request, "model", model, "error", err.Error())
		writeAPIError(w, http.StatusBadGateway, reason, "upstream_error", requestIDs.Request)
		return
	}
	defer resp.Body.Close()
	w.Header().Set("x-request-id", requestIDs.Request)

	if resp.StatusCode/100 != 2 {
		// Read the error once: the message goes to the client, the log and the
		// per-model health note the panel shows.
		errorBody, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
		message, kind, _ := parseUpstreamError(errorBody, resp.StatusCode)
		g.recordFailure(model, started, message)
		g.noteUpstreamStatus(resp, model, requestIDs.Request, message, kind)
		copyErrorResponse(w, resp, errorBody, requestIDs.Request)
		return
	}

	g.log.Debug("upstream accepted request",
		"component", "upstream", "event", "request_accepted", "request_id", requestIDs.Request, "model", model,
		"stream", clientStream, "session", requestIDs.Session, "notes", strings.Join(notes, ","))

	if clientStream {
		g.streamToClient(cancel, w, resp, model, started, requestIDs.Request)
		return
	}
	g.assembleToClient(w, resp, model, started, requestIDs.Request)
}

// streamToClient passes the upstream SSE through byte for byte while a tap
// reads usage and the body-idle watchdog guards against a tunnel that stands
// but never speaks. cancel unblocks the read when the watchdog fires.
func (g *Gateway) streamToClient(cancel context.CancelFunc, w http.ResponseWriter, resp *http.Response, model string, started time.Time, requestID string) {
	flusher, _ := w.(http.Flusher)
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	if flusher != nil {
		flusher.Flush()
	}

	tap := newSSETap()
	watchdog := newIdleWatchdog(time.Duration(g.cfg.Limits.BodyIdleSeconds)*time.Second, func() {
		g.log.Warn("upstream stream went idle; cancelling",
			"component", "stream", "event", "stream_idle_timeout", "request_id", requestID, "model", model)
		cancel()
	})
	defer watchdog.Stop()

	buf := make([]byte, 32<<10)
	for {
		n, err := resp.Body.Read(buf)
		if n > 0 {
			watchdog.Touch()
			_, _ = tap.Write(buf[:n])
			if _, writeErr := w.Write(buf[:n]); writeErr != nil {
				g.finishStream(model, started, tap, "client disconnected: "+writeErr.Error())
				return
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				tap.Finish()
				g.finishStream(model, started, tap, "")
				return
			}
			if errors.Is(err, context.Canceled) {
				// Either the client hung up or the idle watchdog pulled the
				// plug; the watchdog knows which.
				tap.Finish()
				reason := "client disconnected before the stream finished"
				if watchdog.Fired() {
					reason = fmt.Sprintf("upstream stream idle for more than %ds", g.cfg.Limits.BodyIdleSeconds)
				}
				g.finishStream(model, started, tap, reason)
				return
			}
			g.finishStream(model, started, tap, "stream ended with an error: "+err.Error())
			return
		}
	}
}

func (g *Gateway) finishStream(model string, started time.Time, tap *sseTap, failure string) {
	if failure != "" {
		g.recordFailure(model, started, failure)
		g.recordError(failure)
		g.log.Debug("stream finished with a failure",
			"component", "stream", "event", "stream_failed", "model", model, "error", failure,
			"duration_ms", time.Since(started).Milliseconds())
		return
	}
	g.recordSuccess(model, started, tap.usageIn, tap.usageOut)
	g.log.Debug("stream finished",
		"component", "stream", "event", "stream_finished", "model", model,
		"input_tokens", tap.usageIn, "output_tokens", tap.usageOut, "usage_reported", tap.usageSeen,
		"duration_ms", time.Since(started).Milliseconds())
}

func (g *Gateway) assembleToClient(w http.ResponseWriter, resp *http.Response, model string, started time.Time, requestID string) {
	tap := newSSETap()
	if _, err := io.Copy(tap, io.LimitReader(resp.Body, 64<<20)); err != nil {
		g.recordFailure(model, started, "failed to read upstream response")
		g.recordError("failed to read upstream response: " + err.Error())
		writeAPIError(w, http.StatusBadGateway, "failed to read upstream response", "upstream_error", requestID)
		return
	}
	tap.Finish()
	g.recordSuccess(model, started, tap.usageIn, tap.usageOut)
	writeJSON(w, http.StatusOK, tap.Response(model))
}

// doUpstream retries only until a response is committed to the client: a
// retryable status (429/5xx) or a transport error moves to the next attempt, a
// deterministic client-side status is handed straight back so the caller sees
// the upstream's own words (region blocks, invalid model, ...).
func (g *Gateway) doUpstream(ctx context.Context, body []byte, requestIDs compat.RequestIDs) (*http.Response, error) {
	attempts := g.cfg.Limits.MaxRetries + 1
	endpoint := strings.TrimRight(g.cfg.Upstream.Zen, "/") + "/v1/chat/completions"

	var lastResp *http.Response
	var lastErr error
	for attempt := 1; attempt <= attempts; attempt++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
		if err != nil {
			return nil, err
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json, text/event-stream")
		compat.SetDisguiseHeaders(req, requestIDs)
		req.Header.Set("Authorization", "Bearer "+compat.AnonymousKey)

		resp, err := g.client.Do(req)
		if err == nil && resp.StatusCode/100 == 2 {
			return resp, nil
		}
		if lastResp != nil {
			drainAndClose(lastResp.Body)
		}
		lastResp, lastErr = resp, err

		if err != nil {
			if ctx.Err() != nil {
				return nil, err
			}
		} else if !retryableStatus(resp.StatusCode) {
			return resp, nil
		}
		if attempt == attempts {
			break
		}
		wait := retryDelay(attempt, lastResp)
		if wait < 0 {
			// Retry-After asks for longer than this request is worth waiting:
			// hand the response back and let the client decide.
			return lastResp, nil
		}
		g.log.Debug("retrying upstream request",
			"component", "upstream", "event", "request_retry", "request_id", requestIDs.Request, "attempt", attempt, "wait_ms", wait.Milliseconds())
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(wait):
		}
	}
	if lastResp != nil {
		return lastResp, nil
	}
	if lastErr != nil {
		return nil, lastErr
	}
	return nil, errors.New("upstream request failed without a response")
}

const maxRetryAfterWait = 10 * time.Second

// retryDelay returns the wait before the next attempt, or -1 when the upstream
// asked for a longer pause than this request should absorb.
func retryDelay(attempt int, resp *http.Response) time.Duration {
	delay := min(500*time.Millisecond*time.Duration(1<<(attempt-1)), 5*time.Second)
	if resp == nil {
		return delay
	}
	if retryAfter := parseRetryAfter(resp.Header.Get("Retry-After")); retryAfter > 0 {
		if retryAfter > maxRetryAfterWait {
			return -1
		}
		if retryAfter > delay {
			return retryAfter
		}
	}
	return delay
}

func retryableStatus(status int) bool {
	switch status {
	case http.StatusRequestTimeout, http.StatusTooManyRequests,
		http.StatusInternalServerError, http.StatusBadGateway,
		http.StatusServiceUnavailable, http.StatusGatewayTimeout:
		return true
	default:
		return false
	}
}

func parseRetryAfter(value string) time.Duration {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0
	}
	if seconds, err := strconv.Atoi(value); err == nil {
		if seconds <= 0 {
			return 0
		}
		return time.Duration(seconds) * time.Second
	}
	if when, err := http.ParseTime(value); err == nil {
		if delta := time.Until(when); delta > 0 {
			return delta
		}
	}
	return 0
}

// noteUpstreamStatus records what the upstream said. Every rejection is logged
// at warn level with the upstream's own message, because "the free lane
// rejected this model" is exactly the thing to be able to look up afterwards.
func (g *Gateway) noteUpstreamStatus(resp *http.Response, model, requestID, message, kind string) {
	if resp.StatusCode == http.StatusTooManyRequests {
		until := time.Now().Add(parseRetryAfter(resp.Header.Get("Retry-After")))
		g.stateMu.Lock()
		g.rateLimitedUntil, g.lastRateLimitAt = until, time.Now()
		g.stateMu.Unlock()
	}
	g.log.Warn("upstream rejected the request",
		"component", "upstream", "event", "upstream_error_response", "request_id", requestID, "model", model,
		"status", resp.StatusCode, "kind", kind, "reason", message,
		"retry_after", resp.Header.Get("Retry-After"))
}

// recordSuccess and recordFailure feed the usage ledger; the reason becomes the
// model's liveness note (see usage.Health), so it should carry the upstream's
// own wording whenever there is one.
func (g *Gateway) recordSuccess(model string, started time.Time, input, output int64) {
	g.usage.Record(started, model, input, output, "")
}

func (g *Gateway) recordFailure(model string, started time.Time, reason string) {
	g.usage.Record(started, model, 0, 0, reason)
}

// friendlyTransportError turns a Go transport error into something a client can
// act on; the raw error keeps going to the log.
func friendlyTransportError(err error) string {
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return "upstream timed out before answering"
	case errors.Is(err, context.Canceled):
		return "request cancelled before the upstream answered"
	default:
		return "upstream unreachable: " + err.Error()
	}
}

func (g *Gateway) recordError(message string) {
	g.stateMu.Lock()
	g.lastError, g.lastErrorAt = message, time.Now()
	g.stateMu.Unlock()
}

func drainAndClose(body io.ReadCloser) {
	if body == nil {
		return
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(body, 64<<10))
	_ = body.Close()
}

// copyErrorResponse hands the upstream's own words back to the client inside
// the standard OpenAI envelope.
//
// The upstream uses more than one error shape — {"error":{"message":…}} for
// provider failures and {"type":"error","error":{…}} for auth/free-tier
// rejections. Passing that through verbatim makes a client that looks for
// error.message fall back to a generic "provider rejected the request", which
// tells the user nothing. The message text, the status and Retry-After are the
// upstream's; only the envelope is ours.
func copyErrorResponse(w http.ResponseWriter, resp *http.Response, body []byte, requestID string) {
	if retryAfter := resp.Header.Get("Retry-After"); retryAfter != "" {
		w.Header().Set("Retry-After", retryAfter)
	}
	w.Header().Set("Content-Type", "application/json")
	if requestID != "" {
		w.Header().Set("x-request-id", requestID)
	}
	w.Header().Set("x-upstream-status", strconv.Itoa(resp.StatusCode))
	message, kind, code := parseUpstreamError(body, resp.StatusCode)
	writeJSONStatus(w, resp.StatusCode, map[string]any{"error": map[string]any{
		"message": message, "type": kind, "param": nil, "code": code,
	}})
}

// parseUpstreamError digs the human-readable reason out of whichever envelope
// the upstream used, and classifies it. It never returns an empty message: a
// client showing nothing is worse than showing the plain HTTP status text.
func parseUpstreamError(body []byte, status int) (message, kind string, code any) {
	fallbackMessage := http.StatusText(status)
	if fallbackMessage == "" {
		fallbackMessage = "upstream request failed"
	}
	fallbackCode := strconv.Itoa(status)
	if len(body) == 0 {
		return fallbackMessage, "upstream_error", fallbackCode
	}
	var parsed map[string]any
	if json.Unmarshal(body, &parsed) != nil {
		text := strings.TrimSpace(string(body))
		if len(text) > 400 {
			text = text[:400]
		}
		if text == "" {
			text = fallbackMessage
		}
		return text, "upstream_error", fallbackCode
	}
	errObj := jsonx.MapAt(parsed, "error")
	message = jsonx.FirstString(jsonx.StringAt(errObj, "message"), jsonx.StringAt(parsed, "message"))
	if message == "" {
		message = fallbackMessage
	}
	kind = jsonx.FirstString(jsonx.StringAt(errObj, "type"), jsonx.StringAt(parsed, "type"))
	switch kind {
	case "", "error":
		kind = classifyUpstreamStatus(status)
	}
	if raw := jsonx.AnyAt(errObj, "code"); raw != nil {
		code = raw
	} else if raw := jsonx.AnyAt(parsed, "code"); raw != nil {
		code = raw
	} else {
		code = fallbackCode
	}
	return message, kind, code
}

// classifyUpstreamStatus maps an HTTP status to the type name the free lane's
// own vocabulary uses (AuthError / FreeTierError reach us as-is instead).
func classifyUpstreamStatus(status int) string {
	switch status {
	case http.StatusUnauthorized, http.StatusForbidden:
		return "authentication_error"
	case http.StatusTooManyRequests:
		return "rate_limit_error"
	case http.StatusNotFound:
		return "not_found_error"
	case http.StatusBadRequest, http.StatusRequestEntityTooLarge:
		return "invalid_request_error"
	default:
		if status >= 500 {
			return "upstream_unavailable"
		}
		return "upstream_error"
	}
}

func writeAPIError(w http.ResponseWriter, status int, message, kind, param string) {
	writeJSONStatus(w, status, map[string]any{"error": map[string]any{
		"message": message, "type": kind, "param": nullIfEmpty(param), "code": nil,
	}})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	writeJSONStatus(w, status, value)
}

func writeJSONStatus(w http.ResponseWriter, status int, value any) {
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func nullIfEmpty(value string) any {
	if value == "" {
		return nil
	}
	return value
}
