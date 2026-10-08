package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"

	"zen-free/internal/compat"
	"zen-free/internal/config"
	"zen-free/internal/gateway"
)

// runProbe is the acceptance test for this service: it drives the live
// upstream through the same compat layer the gateway uses, so a green run
// means the gate-carrying request shape really is accepted. It exits non-zero
// when the gate shape stops working, which is the signal to re-check
// internal/compat.
func runProbe(configPath string, verbose bool, verifyModels bool) int {
	cfg, err := config.Load(configPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "zen-free -probe: %v\n", err)
		return 1
	}
	zen := strings.TrimRight(cfg.Upstream.Zen, "/")
	client := &http.Client{
		Timeout: 90 * time.Second,
		Transport: &http.Transport{
			Proxy:                 http.ProxyFromEnvironment,
			ForceAttemptHTTP2:     true,
			TLSHandshakeTimeout:   15 * time.Second,
			ResponseHeaderTimeout: 90 * time.Second,
		},
	}

	fmt.Printf("zen-free %s · 上游形状自检\n", gateway.Version())
	fmt.Printf("config   %s\n", configPath)
	fmt.Printf("upstream %s\n", config.RedactURL(zen))
	fmt.Printf("user-agent %s\n\n", compat.UserAgent())

	failures := 0

	// 1) the live catalog (S1)
	models, status, err := fetchModels(context.Background(), client, zen)
	switch {
	case err != nil:
		fmt.Printf("[FAIL] GET /v1/models        %v\n", err)
		failures++
	default:
		fmt.Printf("[ ok ] GET /v1/models        HTTP %d, %d 个模型\n", status, len(models))
		free := freeLooking(models)
		fmt.Printf("       免费候选 %d 个：%s\n", len(free), strings.Join(truncateList(free, 8), ", "))
	}
	if len(models) == 0 {
		fmt.Println("\n目录为空，后续检查无法进行。")
		return 1
	}

	model := pickModel(models)
	fmt.Printf("       自检模型：%s\n\n", model)

	// 2) the gate-carrying shape: stream + bash/read tools + canonical session
	body := map[string]any{
		"model":      model,
		"messages":   []any{map[string]any{"role": "user", "content": "只回复两个字：收到"}},
		"max_tokens": 32,
	}
	notes := compat.Prepare(body)
	ids := compat.DeriveRequestIDs(http.Header{}, body)
	fmt.Printf("       compat.Prepare 改写：%s\n", strings.Join(notes, ", "))
	fmt.Printf("       会话 id：%s（canonical=%v）\n\n", ids.Session, compat.IsCanonicalSessionID(ids.Session))

	streamResult, streamBody := postChat(context.Background(), client, zen, body, ids)
	switch {
	case streamResult.StatusCode/100 == 2:
		fmt.Printf("[ ok ] 门禁形状（stream + bash/read + canonical session）  HTTP %d\n", streamResult.StatusCode)
		summarizeStream(streamBody, verbose)
	default:
		fmt.Printf("[FAIL] 门禁形状（stream + bash/read + canonical session）  HTTP %d\n", streamResult.StatusCode)
		fmt.Printf("       %s\n", truncateText(string(streamBody), 300))
		fmt.Println("       → internal/compat 的上游形状已经过时，请对照 opencode2dsh 的最新版本调整。")
		failures++
	}

	// 3) the retired sidecar's session shape must still be rejected: it proves
	// the canonical-session half of the gate is the thing that matters.
	legacyIDs := ids
	legacyIDs.Session = compat.StableID("ses", "probe-legacy-session")
	legacyResult, legacyBody := postChat(context.Background(), client, zen, body, legacyIDs)
	switch {
	case legacyResult.StatusCode == http.StatusForbidden:
		fmt.Printf("[ ok ] 旧会话形状（ses_<24hex>）仍被上游拒绝  HTTP 403（说明 canonical 修复是必需的）\n")
		fmt.Printf("       %s\n", truncateText(string(legacyBody), 200))
	case legacyResult.StatusCode/100 == 2:
		fmt.Printf("[warn] 旧会话形状也被接受了  HTTP %d — 上游可能放宽了会话校验，canonical 仍无害\n", legacyResult.StatusCode)
		failures++
	default:
		fmt.Printf("[warn] 旧会话形状返回 HTTP %d（预期 403）\n", legacyResult.StatusCode)
		failures++
	}

	// 4) a non-streaming client must still be served (the gateway assembles
	// the forced upstream stream back into one response).
	nonStreamBody := map[string]any{
		"model":      model,
		"messages":   []any{map[string]any{"role": "user", "content": "只回复两个字：收到"}},
		"max_tokens": 32,
		"stream":     false,
	}
	compat.Prepare(nonStreamBody)
	nonStreamBody["stream_options"] = map[string]any{"include_usage": true}
	nonStreamIDs := compat.DeriveRequestIDs(http.Header{}, nonStreamBody)
	result, raw := postChat(context.Background(), client, zen, nonStreamBody, nonStreamIDs)
	switch {
	case result.StatusCode/100 == 2:
		fmt.Printf("[ ok ] 非流式请求（上游仍按流式发送）  HTTP %d\n", result.StatusCode)
		if verbose {
			fmt.Printf("       %s\n", truncateText(string(raw), 300))
		}
	default:
		fmt.Printf("[FAIL] 非流式请求  HTTP %d\n", result.StatusCode)
		fmt.Printf("       %s\n", truncateText(string(raw), 300))
		failures++
	}

	// 5) optionally verify every model we advertise: the free lane's per-model
	// availability fluctuates (an upstream "Endpoint is unavailable" is
	// routine), so this is the answer to "which of these can I actually use
	// right now". It is deliberately manual — it spends one real request per
	// model and therefore its share of the IP-based quota.
	if verifyModels {
		fmt.Println()
		usable, unusable := verifyAllModels(context.Background(), client, zen, cfg, verbose)
		fmt.Printf("\n可用 %d 个：%s\n", len(usable), strings.Join(usable, ", "))
		if len(unusable) > 0 {
			fmt.Printf("不可用 %d 个：%s\n", len(unusable), strings.Join(unusable, ", "))
			fmt.Println("（这些是上游当下不可用，不是本地判定问题；过一阵再跑一次通常会变）")
		}
	}

	fmt.Println()
	if failures == 0 {
		fmt.Println("上游形状自检全部通过。")
		return 0
	}
	fmt.Printf("%d 项未通过。\n", failures)
	return 1
}

// verifyAllModels asks the live upstream for every model this service exposes,
// one minimal gate-shaped request each. Returns the usable and unusable ids.
func verifyAllModels(ctx context.Context, client *http.Client, zen string, cfg config.Config, verbose bool) ([]string, []string) {
	ids, _, err := fetchModels(ctx, client, zen)
	if err != nil {
		fmt.Printf("      无法读取上游目录：%v\n", err)
		return nil, nil
	}

	// The exposed set is the local decision applied to the live catalog; the
	// probe cannot import it without duplicating the rules, so it asks the
	// running service when one is up, and otherwise checks the free-named ids.
	exposed := freeLooking(ids)
	if local, err := fetchLocalModels(cfg); err == nil && len(local) > 0 {
		exposed = local
		fmt.Printf("按本服务 /v1/models 的暴露清单逐个验证 %d 个模型（每个一次极小请求，约需 1 分钟）\n", len(exposed))
	} else {
		fmt.Printf("本服务未在运行，改为验证 %d 个名字含 free 的模型\n", len(exposed))
	}

	usable := make([]string, 0, len(exposed))
	unusable := make([]string, 0, len(exposed))
	for _, model := range exposed {
		body := map[string]any{
			"model":      model,
			"messages":   []any{map[string]any{"role": "user", "content": "hi"}},
			"max_tokens": 8,
		}
		compat.Prepare(body)
		ids := compat.DeriveRequestIDs(http.Header{}, body)
		started := time.Now()
		resp, raw := postChat(ctx, client, zen, body, ids)
		elapsed := time.Since(started).Milliseconds()
		if resp.StatusCode/100 == 2 {
			fmt.Printf("  [ ok ] %-30s %dms\n", model, elapsed)
			usable = append(usable, model)
		} else {
			message := truncateText(extractMessage(raw), 120)
			fmt.Printf("  [FAIL] %-30s HTTP %d · %s\n", model, resp.StatusCode, message)
			unusable = append(unusable, fmt.Sprintf("%s(%d)", model, resp.StatusCode))
		}
		if verbose {
			fmt.Printf("         body: %s\n", truncateText(string(raw), 200))
		}
		select {
		case <-ctx.Done():
			return usable, unusable
		case <-time.After(400 * time.Millisecond):
		}
	}
	return usable, unusable
}

// fetchLocalModels asks a running instance what it currently exposes.
func fetchLocalModels(cfg config.Config) ([]string, error) {
	client := &http.Client{Timeout: 5 * time.Second}
	req, err := http.NewRequest(http.MethodGet, "http://"+cfg.Listen+"/v1/models", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+cfg.APIKey)
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("local /v1/models returned HTTP %d", resp.StatusCode)
	}
	var payload struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&payload); err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(payload.Data))
	for _, item := range payload.Data {
		ids = append(ids, item.ID)
	}
	return ids, nil
}

// extractMessage pulls the upstream's reason out of either error envelope.
func extractMessage(body []byte) string {
	var parsed map[string]any
	if json.Unmarshal(body, &parsed) != nil {
		return strings.TrimSpace(string(body))
	}
	for _, path := range [][]string{{"error", "message"}, {"message"}} {
		current := any(parsed)
		for _, key := range path {
			object, ok := current.(map[string]any)
			if !ok {
				current = nil
				break
			}
			current = object[key]
		}
		if text, ok := current.(string); ok && strings.TrimSpace(text) != "" {
			return text
		}
	}
	return strings.TrimSpace(string(body))
}

func fetchModels(ctx context.Context, client *http.Client, zen string) ([]string, int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, zen+"/v1/models", nil)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Authorization", "Bearer "+compat.AnonymousKey)
	req.Header.Set("User-Agent", compat.UserAgent())
	req.Header.Set("x-opencode-client", "cli")
	resp, err := client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if resp.StatusCode/100 != 2 {
		return nil, resp.StatusCode, fmt.Errorf("HTTP %d: %s", resp.StatusCode, truncateText(string(body), 200))
	}
	var payload struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, resp.StatusCode, err
	}
	ids := make([]string, 0, len(payload.Data))
	for _, item := range payload.Data {
		ids = append(ids, item.ID)
	}
	sort.Strings(ids)
	return ids, resp.StatusCode, nil
}

func postChat(ctx context.Context, client *http.Client, zen string, body map[string]any, ids compat.RequestIDs) (*http.Response, []byte) {
	encoded, err := json.Marshal(body)
	if err != nil {
		return &http.Response{StatusCode: 0, Status: "encode error"}, []byte(err.Error())
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, zen+"/v1/chat/completions", bytes.NewReader(encoded))
	if err != nil {
		return &http.Response{StatusCode: 0, Status: "request error"}, []byte(err.Error())
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	compat.SetDisguiseHeaders(req, ids)
	req.Header.Set("Authorization", "Bearer "+compat.AnonymousKey)
	resp, err := client.Do(req)
	if err != nil {
		return &http.Response{StatusCode: 0, Status: "transport error"}, []byte(err.Error())
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	return resp, raw
}

// summarizeStream reports what the stream actually carried: text, reasoning,
// and whether the upstream volunteered usage (which decides whether streaming
// requests can be accounted for by tokens).
func summarizeStream(raw []byte, verbose bool) {
	var text, reasoning strings.Builder
	toolCalls := 0
	usageSeen := false
	chunks := 0
	scanner := bufio.NewScanner(bytes.NewReader(raw))
	scanner.Buffer(make([]byte, 64<<10), 8<<20)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "" || data == "[DONE]" {
			continue
		}
		var chunk map[string]any
		if json.Unmarshal([]byte(data), &chunk) != nil {
			continue
		}
		chunks++
		if usage, ok := chunk["usage"].(map[string]any); ok && len(usage) > 0 {
			usageSeen = true
			fmt.Printf("       用量：%v\n", usage)
		}
		choices, _ := chunk["choices"].([]any)
		for _, rawChoice := range choices {
			choice, _ := rawChoice.(map[string]any)
			delta, _ := choice["delta"].(map[string]any)
			if content, ok := delta["content"].(string); ok {
				text.WriteString(content)
			}
			if think, ok := delta["reasoning_content"].(string); ok {
				reasoning.WriteString(think)
			}
			if calls, ok := delta["tool_calls"].([]any); ok {
				toolCalls += len(calls)
			}
		}
	}
	fmt.Printf("       %d 个 chunk；正文 %q；思考 %d 字；工具调用帧 %d；stream 携带 usage=%v\n",
		chunks, truncateText(text.String(), 60), len([]rune(reasoning.String())), toolCalls, usageSeen)
	if verbose {
		fmt.Printf("       %s\n", truncateText(string(raw), 400))
	}
}

func freeLooking(models []string) []string {
	out := make([]string, 0, len(models))
	for _, model := range models {
		if strings.Contains(strings.ToLower(model), "free") || model == "big-pickle" {
			out = append(out, model)
		}
	}
	return out
}

func pickModel(models []string) string {
	for _, model := range models {
		if model == "big-pickle" {
			return model
		}
	}
	for _, model := range models {
		if strings.Contains(model, "flash-free") || strings.HasSuffix(model, "-free") {
			return model
		}
	}
	return models[0]
}

func truncateList(items []string, max int) []string {
	if len(items) <= max {
		return items
	}
	return append(items[:max:max], fmt.Sprintf("… 共 %d 个", len(items)))
}

func truncateText(text string, max int) string {
	text = strings.Join(strings.Fields(text), " ")
	runes := []rune(text)
	if len(runes) <= max {
		return text
	}
	return string(runes[:max]) + "…"
}
