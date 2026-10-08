package worker

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Health mirrors daemon.mjs GET /health.
type Health struct {
	OK             bool   `json:"ok"`
	Ready          bool   `json:"ready"`
	Hot            bool   `json:"hot"`
	UID            string `json:"uid"`
	Endpoint       string `json:"endpoint"`
	InFlight       int    `json:"inFlight"`
	MaxInFlight    int    `json:"maxInFlight"`
	LastError      string `json:"lastError"`
	HasAuthManager bool   `json:"hasAuthManager"`
	BootMode       string `json:"bootMode"`
	Catalog        struct {
		Ready bool   `json:"ready"`
		Error string `json:"error"`
	} `json:"catalog"`
	Quota struct {
		Ready bool   `json:"ready"`
		Error string `json:"error"`
	} `json:"quota"`
	Login struct {
		Status  string `json:"status"`
		AuthURL string `json:"authUrl"`
		Message string `json:"message"`
	} `json:"login"`
}

// ModelEntry is one catalog row from GET /admin/models.
type ModelEntry struct {
	ID            string   `json:"id"`
	MappedKey     string   `json:"mapped_key"`
	NativeModel   string   `json:"native_model"`
	DisplayName   string   `json:"display_name"`
	IsReasoning   bool     `json:"is_reasoning"`
	IsMaxMode     bool     `json:"is_max_mode"`
	MaxOutput     int      `json:"max_output_tokens"`
	DefaultWindow int      `json:"default_context_window"`
	MaxWindow     int      `json:"largest_context_window"`
	PriceFactor   *float64 `json:"price_factor"`
	Tags          []string `json:"tags"`
}

// LimitedTimeFree mirrors the Qoder client's own free signal: the
// `limited_time_free` tag in the catalog entry.
func (m ModelEntry) LimitedTimeFree() bool {
	for _, tag := range m.Tags {
		if strings.EqualFold(strings.TrimSpace(tag), "limited_time_free") {
			return true
		}
	}
	return false
}

// IsFree reports whether the model costs no credits: limited-time-free tag or
// a zero/negative price factor (same derivation as the upstream CLI).
func (m ModelEntry) IsFree() bool {
	if m.LimitedTimeFree() {
		return true
	}
	return m.PriceFactor != nil && *m.PriceFactor <= 0
}

// CreditsLabel renders the billing badge: "0" for free models, "x1"/"x0.5"
// style multiplier otherwise, "" when the catalog declares no factor.
func (m ModelEntry) CreditsLabel() string {
	if m.LimitedTimeFree() {
		return "0"
	}
	if m.PriceFactor == nil {
		return ""
	}
	factor := *m.PriceFactor
	if factor <= 0 {
		return "0"
	}
	return "x" + strconv.FormatFloat(factor, 'f', -1, 64)
}

// Quota mirrors GET /admin/quota {quota: {...}}.
type Quota struct {
	UserQuota      *QuotaBlock `json:"userQuota"`
	AddOnQuota     *QuotaBlock `json:"addOnQuota"`
	OrgPackage     *QuotaBlock `json:"orgResourcePackage"`
	IsQuotaExceeded bool       `json:"isQuotaExceeded"`
	FetchedAt      string      `json:"fetchedAt"`
}

type QuotaBlock struct {
	Total      float64 `json:"total"`
	Used       float64 `json:"used"`
	Remaining  float64 `json:"remaining"`
	Percentage float64 `json:"percentage"`
	Unit       string  `json:"unit"`
	Available  *bool   `json:"available"`
}

// Remaining aggregates available buckets, mirroring the upstream CLI.
func (q *Quota) Remaining() (total, remaining float64, ok bool) {
	if q == nil {
		return 0, 0, false
	}
	blocks := []*QuotaBlock{q.UserQuota, q.AddOnQuota, q.OrgPackage}
	any := false
	for _, block := range blocks {
		if block == nil || (block.Available != nil && !*block.Available) {
			continue
		}
		any = true
		total += block.Total
		remaining += block.Remaining
	}
	return total, remaining, any
}

// LoginState mirrors GET /admin/login/status {login: {...}}.
type LoginState struct {
	Status  string `json:"status"`
	AuthURL string `json:"authUrl"`
	Message string `json:"message"`
}

// ErrorKind classifies worker failures for pool cooldown decisions. Names
// mirror worker/src/errors.mjs.
type ErrorKind string

const (
	ErrKindQuota          ErrorKind = "quota"
	ErrKindRateLimit      ErrorKind = "rate_limit"
	ErrKindAuth           ErrorKind = "auth"
	ErrKindNotReady       ErrorKind = "not_ready"
	ErrKindUnavailable    ErrorKind = "unavailable"
	ErrKindModelMissing   ErrorKind = "model_not_available"
	ErrKindInvalidRequest ErrorKind = "invalid_request"
	ErrKindTransport      ErrorKind = "transport"
)

// WorkerError is a classified failure from a worker call.
type WorkerError struct {
	Kind       ErrorKind
	Status     int
	Code       string
	Message    string
	RetryAfter time.Duration
	Body       string
}

func (e *WorkerError) Error() string {
	if e.Code != "" {
		return fmt.Sprintf("%s: %s", e.Code, e.Message)
	}
	return e.Message
}

// Client speaks the worker HTTP contract for one account at a time.
type Client struct {
	HTTP      *http.Client
	APIKey    string
	AccountID string
}

func (m *Manager) Client(accountID string) Client {
	return Client{HTTP: m.client, APIKey: m.APIKey, AccountID: accountID}
}

func (c Client) do(ctx context.Context, method, url string, body []byte, contentType string) (*http.Response, error) {
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, url, reader)
	if err != nil {
		return nil, err
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	if c.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.APIKey)
	}
	if c.AccountID != "" {
		req.Header.Set("X-Qoder-Account", c.AccountID)
	}
	return c.HTTP.Do(req)
}

func (c Client) GetJSON(ctx context.Context, path string, out any) error {
	resp, err := c.do(ctx, http.MethodGet, path, nil, "")
	if err != nil {
		return &WorkerError{Kind: ErrKindTransport, Message: err.Error()}
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 300 {
		return classify(resp.StatusCode, raw)
	}
	if out != nil && len(raw) > 0 {
		if err := json.Unmarshal(raw, out); err != nil {
			return fmt.Errorf("decode %s: %w", path, err)
		}
	}
	return nil
}

func (c Client) PostJSON(ctx context.Context, path string, body []byte) (json.RawMessage, error) {
	resp, err := c.do(ctx, http.MethodPost, path, body, "application/json")
	if err != nil {
		return nil, &WorkerError{Kind: ErrKindTransport, Message: err.Error()}
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 300 {
		return nil, classify(resp.StatusCode, raw)
	}
	return json.RawMessage(raw), nil
}

// Probe fetches /health without decoding failures as errors.
func (m *Manager) Probe(ctx context.Context, accountID string) (*Health, error) {
	url, ok := m.URL(accountID)
	if !ok {
		return nil, ErrNotRunning
	}
	var health Health
	client := Client{HTTP: &http.Client{Timeout: 3 * time.Second}, APIKey: m.APIKey, AccountID: accountID}
	if err := client.GetJSON(ctx, strings.TrimRight(url, "/")+"/health", &health); err != nil {
		return nil, err
	}
	return &health, nil
}

// Health is Probe without the manager receiver.
func (c Client) Health(ctx context.Context, url string) (*Health, error) {
	var health Health
	if err := c.GetJSON(ctx, strings.TrimRight(url, "/")+"/health", &health); err != nil {
		return nil, err
	}
	return &health, nil
}

// Models fetches the account catalog.
func (c Client) Models(ctx context.Context, url string, refresh bool) ([]ModelEntry, error) {
	path := strings.TrimRight(url, "/") + "/admin/models"
	if refresh {
		path += "?refresh=1"
	}
	var payload struct {
		Data []ModelEntry `json:"data"`
	}
	if err := c.GetJSON(ctx, path, &payload); err != nil {
		return nil, err
	}
	return payload.Data, nil
}

// Quota fetches the account quota snapshot.
func (c Client) Quota(ctx context.Context, url string, refresh bool) (*Quota, error) {
	path := strings.TrimRight(url, "/") + "/admin/quota"
	if refresh {
		path += "?refresh=1"
	}
	var payload struct {
		Quota *Quota `json:"quota"`
	}
	if err := c.GetJSON(ctx, path, &payload); err != nil {
		return nil, err
	}
	return payload.Quota, nil
}

// LoginStatus returns the daemon login state.
func (c Client) LoginStatus(ctx context.Context, url string) (*LoginState, error) {
	var payload struct {
		Login LoginState `json:"login"`
	}
	if err := c.GetJSON(ctx, strings.TrimRight(url, "/")+"/admin/login/status", &payload); err != nil {
		return nil, err
	}
	return &payload.Login, nil
}

// LoginDevice starts the device-code login and returns the auth URL.
func (c Client) LoginDevice(ctx context.Context, url string) (*LoginState, error) {
	raw, err := c.PostJSON(ctx, strings.TrimRight(url, "/")+"/admin/login/device", []byte("{}"))
	if err != nil {
		return nil, err
	}
	var state LoginState
	if json.Unmarshal(raw, &state) != nil {
		return nil, fmt.Errorf("decode login/device response")
	}
	return &state, nil
}

// Rewarm asks the daemon to rebuild its hot context.
func (c Client) Rewarm(ctx context.Context, url string) error {
	_, err := c.PostJSON(ctx, strings.TrimRight(url, "/")+"/admin/rewarm", []byte("{}"))
	return err
}

// Checkin runs the daily check-in (cn accounts).
func (c Client) Checkin(ctx context.Context, url string) (json.RawMessage, error) {
	return c.PostJSON(ctx, strings.TrimRight(url, "/")+"/admin/checkin", []byte("{}"))
}

// Chat posts an OpenAI-shaped payload; the caller relays the raw response.
func (c Client) Chat(ctx context.Context, url, requestID string, payload []byte) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(url, "/")+"/v1/chat/completions", bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if c.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.APIKey)
	}
	if c.AccountID != "" {
		req.Header.Set("X-Qoder-Account", c.AccountID)
	}
	if requestID != "" {
		req.Header.Set("X-Request-Id", requestID)
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, &WorkerError{Kind: ErrKindTransport, Message: err.Error()}
	}
	if resp.StatusCode >= 300 {
		defer resp.Body.Close()
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		return nil, classify(resp.StatusCode, raw)
	}
	return resp, nil
}

// classify turns a worker error body into a WorkerError. Error JSON shape:
// {"error":{"code","message","kind","retry_after"}} with kind mirroring errors.mjs.
func classify(status int, raw []byte) *WorkerError {
	kind := kindFromStatus(status)
	code := ""
	message := strings.TrimSpace(string(raw))
	retryAfter := time.Duration(0)
	var parsed struct {
		Error struct {
			Code       string `json:"code"`
			Message    string `json:"message"`
			Kind       string `json:"kind"`
			RetryAfter any    `json:"retry_after"`
		} `json:"error"`
	}
	if json.Unmarshal(raw, &parsed) == nil && (parsed.Error.Message != "" || parsed.Error.Code != "") {
		code = parsed.Error.Code
		message = parsed.Error.Message
		if parsed.Error.Kind != "" {
			kind = ErrorKind(parsed.Error.Kind)
		}
		retryAfter = parseRetryAfter(parsed.Error.RetryAfter)
	}
	if len(message) > 512 {
		message = message[:512]
	}
	if kind == ErrKindUnavailable && status == http.StatusServiceUnavailable && code == "" {
		// keep unavailable
	}
	return &WorkerError{Kind: kind, Status: status, Code: code, Message: message, RetryAfter: retryAfter, Body: string(raw)}
}

func kindFromStatus(status int) ErrorKind {
	switch {
	case status == http.StatusTooManyRequests:
		return ErrKindRateLimit
	case status == http.StatusPaymentRequired || status == 402:
		return ErrKindQuota
	case status == http.StatusUnauthorized || status == http.StatusForbidden:
		return ErrKindAuth
	case status == http.StatusServiceUnavailable || status == 503:
		return ErrKindNotReady
	case status == http.StatusNotFound || status == 404:
		return ErrKindModelMissing
	case status == http.StatusBadRequest || status == 422:
		return ErrKindInvalidRequest
	default:
		return ErrKindUnavailable
	}
}

// parseRetryAfter accepts seconds (number or numeric string).
func parseRetryAfter(v any) time.Duration {
	switch value := v.(type) {
	case float64:
		if value > 0 {
			return time.Duration(value * float64(time.Second))
		}
	case string:
		if n, err := strconv.ParseFloat(strings.TrimSpace(value), 64); err == nil && n > 0 {
			return time.Duration(n * float64(time.Second))
		}
	}
	return 0
}
