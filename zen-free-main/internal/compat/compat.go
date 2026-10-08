// Package compat owns every fact about the upstream (OpenCode Zen) request
// shape this service has to reproduce. When the upstream changes its gate,
// this is the only file that should need editing.
//
// Verified against the live upstream on 2026-10-08 (cmd/server -probe and
// scripts/verify.md):
//
//	GET  /v1/models          + Bearer public                -> 200 (87 models)
//	POST /v1/chat/completions plain, no tools               -> 403 FreeTierError
//	POST /v1/chat/completions stream + bash/read tools,
//	     canonical ses_ session id                          -> 200 SSE
//	POST /v1/chat/completions same body, legacy ses_<24hex>  -> 403 FreeTierError
//
// Ported from opencode2dsh (MIT, (c) FishBottle7): adapter/ids.ts
// (canonicalSessionID, disguiseHeaders), adapter/messages.ts
// (ensureFreeLaneShape) and legacy/internal/{ids,convert}. The Go sidecar
// never received the two 2026-09 gate fixes; this file is where they live now.
package compat

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"regexp"
	"runtime"
	"sort"
	"strings"

	"zen-free/internal/jsonx"
)

const (
	// AnonymousKey is the literal credential the anonymous free lane accepts;
	// there is no account and no per-user key.
	AnonymousKey = "public"

	// CLIUserAgentVersion is the OpenCode CLI version this service presents.
	CLIUserAgentVersion = "1.18.31"

	GateToolBash = "bash"
	GateToolRead = "read"
)

var (
	// canonicalSessionRE is OpenCode's official session id shape: the free
	// tier rejects anything else with 403 FreeTierError since 2026-09-16.
	canonicalSessionRE = regexp.MustCompile(`^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$`)

	base62Alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

	base62Base = big.NewInt(62)

	// reasoningLadder is the set of reasoning_effort values the upstream
	// accepts (live-probed: any other value is a hard 400).
	reasoningLadder = []string{"minimal", "low", "medium", "high", "xhigh", "max"}

	// reasoningVendorHints flag endpoints that require thinking to be
	// replayed with assistant tool calls.
	reasoningVendorHints = []string{"moonshot", "kimi", "deepseek", "mimo", "xiaomimimo"}
)

// UserAgent is the CLI-identical user agent. The upstream inspects neither it
// nor any other header beyond the session shape; presenting the CLI's values
// keeps the traffic same-shaped as the official client.
func UserAgent() string {
	return fmt.Sprintf("opencode/%s (%s %s; %s)", CLIUserAgentVersion, runtime.GOOS, runtime.GOARCH, runtime.Version())
}

// IsCanonicalSessionID reports whether id already has the official shape.
func IsCanonicalSessionID(id string) bool {
	return canonicalSessionRE.MatchString(id)
}

// CanonicalSessionID maps any conversation signal to the official session
// shape. An already-canonical id passes through unchanged so a client that
// speaks the shape keeps its upstream prompt-cache affinity; everything else
// (including the retired sidecar's ses_<24hex> form) is hashed into it
// deterministically, so the same conversation keeps a stable session.
// It is a pure function of the signal: callers that have no signal at all pass
// a random one (see DeriveRequestIDs), which keeps "what shape does this carry"
// and "where does the identity come from" separate.
func CanonicalSessionID(signal string) string {
	if IsCanonicalSessionID(signal) {
		return signal
	}
	sum := sha256.Sum256([]byte("ses\x00" + signal))
	return "ses_" + hex.EncodeToString(sum[:6]) + base62Fixed(new(big.Int).SetBytes(sum[6:16]), 14)
}

// base62Fixed renders value as exactly width base62 digits, most significant
// first (ids.ts base62Fixed).
func base62Fixed(value *big.Int, width int) string {
	out := make([]byte, width)
	mod := new(big.Int)
	n := new(big.Int).Set(value)
	for i := width - 1; i >= 0; i-- {
		n.DivMod(n, base62Base, mod)
		out[i] = base62Alphabet[mod.Int64()]
	}
	return string(out)
}

// StableID is sha256("prefix\x00value") truncated to 12 bytes: stable and not
// reversible from the upstream side.
func StableID(prefix, value string) string {
	sum := sha256.Sum256([]byte(prefix + "\x00" + value))
	return prefix + "_" + hex.EncodeToString(sum[:12])
}

func RandomID(prefix string, size int) string {
	buf := make([]byte, size)
	if _, err := rand.Read(buf); err != nil {
		panic(fmt.Sprintf("crypto/rand failed: %v", err))
	}
	return prefix + "_" + hex.EncodeToString(buf)
}

// RequestIDs are the correlation ids sent upstream with every request.
type RequestIDs struct {
	Session       string
	Request       string
	Project       string
	ParentSession string
}

// DeriveRequestIDs prefers whatever session identity the client already
// carries (so a client with its own conversation id keeps one upstream
// session), then the conversation seed — the first user turn keep a multi-turn
// conversation stable as its history grows while separating conversations that
// start differently. Every path ends in the canonical shape.
func DeriveRequestIDs(headers http.Header, body map[string]any) RequestIDs {
	signal := jsonx.FirstString(headerAt(headers,
		"x-opencode-session",
		"x-session-affinity",
		"X-Session-Id",
		"x-session-id",
		"conversation-id",
	), jsonx.StringAt(body, "conversation_id"), jsonx.StringAt(body, "metadata", "session_id"))
	if signal == "" {
		signal = conversationSeed(body)
	}
	if signal == "" {
		signal = jsonx.StringAt(body, "previous_response_id")
	}
	// No conversation identity at all: a random session keeps two such requests
	// from sharing upstream prompt cache, matching the reference behaviour.
	if signal == "" || signal == "{}" {
		signal = RandomID("fallback", 16)
	}
	projectSignal := jsonx.FirstString(headerAt(headers, "x-opencode-project"), jsonx.StringAt(body, "metadata", "project_id"))
	if projectSignal == "" {
		projectSignal = "zen-free:default-project"
	}
	return RequestIDs{
		Session:       CanonicalSessionID(signal),
		Request:       RandomID("req", 16),
		Project:       StableID("prj", projectSignal),
		ParentSession: jsonx.FirstString(headerAt(headers, "x-parent-session-id"), jsonx.StringAt(body, "metadata", "parent_session_id")),
	}
}

func headerAt(headers http.Header, names ...string) string {
	for _, name := range names {
		if value := strings.TrimSpace(headers.Get(name)); value != "" {
			return value
		}
	}
	return ""
}

func conversationSeed(body map[string]any) string {
	if input, ok := body["input"].(string); ok && input != "" {
		return input
	}
	for _, field := range []string{"messages", "input"} {
		for _, raw := range jsonx.SliceAt(body, field) {
			item, ok := raw.(map[string]any)
			if !ok || jsonx.StringAt(item, "role") != "user" {
				continue
			}
			encoded, err := json.Marshal(item["content"])
			if err == nil && len(encoded) > 0 && string(encoded) != "null" {
				return string(encoded)
			}
		}
	}
	return ""
}

// SetDisguiseHeaders stamps the CLI-identical correlation headers on an
// outgoing upstream request.
func SetDisguiseHeaders(req *http.Request, ids RequestIDs) {
	req.Header.Set("User-Agent", UserAgent())
	req.Header.Set("x-opencode-client", "cli")
	req.Header.Set("x-opencode-session", ids.Session)
	// OpenCode 1.18.x sends these affinity headers to preserve
	// provider-side prompt/session affinity; the legacy
	// x-opencode-session header stays for older Zen deployments.
	req.Header.Set("x-session-affinity", ids.Session)
	req.Header.Set("X-Session-Id", ids.Session)
	req.Header.Set("x-opencode-request", ids.Request)
	req.Header.Set("x-opencode-project", ids.Project)
	if ids.ParentSession != "" {
		req.Header.Set("x-parent-session-id", ids.ParentSession)
	}
}

func gateTool(name string) map[string]any {
	return map[string]any{
		"type": "function",
		"function": map[string]any{
			"name":        name,
			"description": "Reserved for the host runtime; do not call it.",
			"parameters":  map[string]any{"type": "object", "properties": map[string]any{}},
		},
	}
}

// Prepare rewrites an outgoing chat-completions payload so it satisfies the
// free-lane gate, and returns human-readable notes for the request log:
//
//   - the body must stream (stream: true)
//   - tools must contain function tools named bash AND read
//   - reasoning_effort must use an upstream-honored spelling
//   - assistant tool-call turns must replay reasoning_content
//
// The first two are the 2026-09 gate (messages.ts ensureFreeLaneShape); a
// plain chat carries no tools at all, so the injected stubs get
// tool_choice:"none" to keep the model from ever calling them. A client's own
// tool list and tool_choice are left untouched.
func Prepare(payload map[string]any) []string {
	notes := make([]string, 0, 5)

	notes = append(notes, normalizeClientToolSpellings(payload)...)

	if stream, _ := payload["stream"].(bool); !stream {
		payload["stream"] = true
		notes = append(notes, "stream_forced")
	}

	tools, _ := payload["tools"].([]any)
	names := make(map[string]bool, len(tools))
	for _, raw := range tools {
		tool, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		if name := jsonx.StringAt(tool, "function", "name"); name != "" {
			names[name] = true
		}
	}
	missing := make([]string, 0, 2)
	for _, name := range []string{GateToolBash, GateToolRead} {
		if !names[name] {
			missing = append(missing, name)
		}
	}
	if len(missing) > 0 {
		for _, name := range missing {
			tools = append(tools, gateTool(name))
		}
		payload["tools"] = tools
		notes = append(notes, "gate_tools_added:"+strings.Join(missing, "+"))
		if len(names) == 0 {
			payload["tool_choice"] = "none"
			notes = append(notes, "tool_choice_none")
		}
	}

	if note := sanitizeReasoningEffort(payload); note != "" {
		notes = append(notes, note)
	}
	if normalizeToolReasoningHistory(payload, jsonx.StringAt(payload, "model")) {
		notes = append(notes, "reasoning_replay")
	}
	return notes
}

// normalizeClientToolSpellings renames the camelCase tool fields some clients
// put on the wire to the OpenAI names the upstream validates.
//
// Live-probed 2026-10-08: given `toolCalls` on an assistant turn (and/or
// `toolCallId` on a tool turn), the upstream answers
// 400 [invalid_request_error] "invalid request" — it sees an assistant turn
// that never called a tool, so the tool result behind it references a call that
// does not exist. ZCode sends exactly that spelling (its model-io record for an
// openai-chat-completions provider contains 30× toolCallId / 30× toolCalls and
// zero snake_case), which is why "connecting ZCode to this service" failed
// while the same conversation in the canonical spelling works.
//
// The canonical name always wins; the client's extra field is left in place
// because the upstream ignores unknown members on a message.
func normalizeClientToolSpellings(payload map[string]any) []string {
	messages, _ := payload["messages"].([]any)
	renamed := make(map[string]bool, 2)
	for _, raw := range messages {
		message, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		if _, exists := message["tool_calls"]; !exists {
			if calls, exists := message["toolCalls"]; exists {
				message["tool_calls"] = calls
				renamed["toolCalls"] = true
			}
		}
		if _, exists := message["tool_call_id"]; !exists {
			if id, exists := message["toolCallId"]; exists {
				message["tool_call_id"] = id
				renamed["toolCallId"] = true
			}
		}
	}
	if len(renamed) == 0 {
		return nil
	}
	names := make([]string, 0, len(renamed))
	for name := range renamed {
		names = append(names, name)
	}
	sort.Strings(names)
	return []string{"client_fields_renamed:" + strings.Join(names, "+")}
}

// sanitizeReasoningEffort keeps the wire spelling inside what the upstream
// accepts: the ladder passes through, "off"/"none" becomes "none" (the only
// spelling that actually stops an always-think model), and anything else is
// dropped rather than risk a hard 400.
func sanitizeReasoningEffort(payload map[string]any) string {
	raw, exists := payload["reasoning_effort"]
	if !exists || raw == nil {
		return ""
	}
	value, ok := raw.(string)
	if !ok {
		delete(payload, "reasoning_effort")
		return "reasoning_effort_dropped:not_a_string"
	}
	normalized := strings.ToLower(strings.TrimSpace(value))
	switch {
	case normalized == "off" || normalized == "none":
		payload["reasoning_effort"] = "none"
		return "reasoning_effort:none"
	case contains(reasoningLadder, normalized):
		payload["reasoning_effort"] = normalized
		return ""
	default:
		delete(payload, "reasoning_effort")
		return "reasoning_effort_dropped:" + normalized
	}
}

// normalizeToolReasoningHistory ensures every assistant tool-call turn carries
// reasoning_content. Clients routinely drop that non-standard field while
// keeping tool_calls, which makes the next thinking-mode request invalid on
// the vendors whose compatible endpoints replay thinking.
func normalizeToolReasoningHistory(payload map[string]any, model string) bool {
	if !shouldNormalizeToolReasoningHistory(model, payload) {
		return false
	}
	messages, _ := payload["messages"].([]any)
	changed := false
	for _, raw := range messages {
		message, ok := raw.(map[string]any)
		if !ok || jsonx.StringAt(message, "role") != "assistant" || len(jsonx.SliceAt(message, "tool_calls")) == 0 {
			continue
		}
		if reasoning, ok := message["reasoning_content"].(string); ok && strings.TrimSpace(reasoning) != "" {
			continue
		}
		reasoning, _ := message["reasoning"].(string)
		if strings.TrimSpace(reasoning) == "" {
			reasoning = "tool call"
		}
		message["reasoning_content"] = reasoning
		changed = true
	}
	return changed
}

func shouldNormalizeToolReasoningHistory(model string, payload map[string]any) bool {
	return isReasoningVendorIdentifier(model) || requestEnablesReasoning(payload)
}

func isReasoningVendorIdentifier(value string) bool {
	value = strings.ToLower(value)
	for _, hint := range reasoningVendorHints {
		if strings.Contains(value, hint) {
			return true
		}
	}
	return false
}

func requestEnablesReasoning(payload map[string]any) bool {
	for _, key := range []string{"reasoning_effort", "reasoning", "thinking", "effort"} {
		value, exists := payload[key]
		if !exists || value == nil {
			continue
		}
		switch typed := value.(type) {
		case string:
			mode := strings.ToLower(strings.TrimSpace(typed))
			if mode != "" && mode != "none" && mode != "disabled" {
				return true
			}
		case bool:
			if typed {
				return true
			}
		case map[string]any:
			mode := strings.ToLower(strings.TrimSpace(jsonx.FirstString(jsonx.StringAt(typed, "type"), jsonx.StringAt(typed, "effort"))))
			if mode == "none" || mode == "disabled" {
				continue
			}
			return true
		default:
			return true
		}
	}
	return false
}

func contains(values []string, value string) bool {
	for _, item := range values {
		if item == value {
			return true
		}
	}
	return false
}
