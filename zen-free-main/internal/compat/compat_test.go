package compat

import (
	"net/http"
	"regexp"
	"strings"
	"testing"
)

func TestCanonicalSessionIDShape(t *testing.T) {
	pattern := regexp.MustCompile(`^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$`)
	inputs := []string{
		"", "hello", `[{"type":"text","text":"hi"}]`,
		// the retired sidecar's shape must be re-hashed, not passed through
		"ses_0123456789abcdef01234567",
		"prj_0123456789abcdef01234567",
		strings.Repeat("x", 500),
	}
	seen := map[string]string{}
	for _, input := range inputs {
		id := CanonicalSessionID(input)
		if !pattern.MatchString(id) {
			t.Fatalf("CanonicalSessionID(%q) = %q, does not match the canonical shape", input, id)
		}
		if !IsCanonicalSessionID(id) {
			t.Fatalf("IsCanonicalSessionID(%q) = false for a generated id", id)
		}
		if again := CanonicalSessionID(input); again != id {
			t.Fatalf("CanonicalSessionID(%q) is not deterministic: %q != %q", input, again, id)
		}
		if previous, ok := seen[id]; ok {
			t.Fatalf("distinct signals %q and %q collided", previous, input)
		}
		seen[id] = input
	}
}

func TestCanonicalSessionIDPassesOfficialShapeThrough(t *testing.T) {
	official := "ses_1a2b3c4d5e6fAbCdEfGhIjKlMn"
	if got := CanonicalSessionID(official); got != official {
		t.Fatalf("an already-canonical session must pass through unchanged, got %q", got)
	}
}

func TestDeriveRequestIDsFromConversationSeed(t *testing.T) {
	body := map[string]any{
		"messages": []any{
			map[string]any{"role": "system", "content": "be brief"},
			map[string]any{"role": "user", "content": "first turn"},
			map[string]any{"role": "user", "content": "second turn"},
		},
	}
	first := DeriveRequestIDs(http.Header{}, body)
	if !IsCanonicalSessionID(first.Session) {
		t.Fatalf("session %q is not canonical", first.Session)
	}
	// The seed is the first user turn, so growing the history keeps the session.
	body["messages"] = append(body["messages"].([]any), map[string]any{"role": "assistant", "content": "ok"})
	again := DeriveRequestIDs(http.Header{}, body)
	if again.Session != first.Session {
		t.Fatalf("session changed when history grew: %q != %q", again.Session, first.Session)
	}
	if again.Request == first.Request {
		t.Fatal("the per-request id must be fresh on every request")
	}
	// A client session header wins over the seed.
	header := http.Header{"X-Session-Id": []string{"client-session-1"}}
	fromHeader := DeriveRequestIDs(header, body)
	if fromHeader.Session == first.Session || !IsCanonicalSessionID(fromHeader.Session) {
		t.Fatalf("client session header was not honored: %q", fromHeader.Session)
	}
}

func TestPrepareAddsGateTools(t *testing.T) {
	payload := map[string]any{
		"model":    "big-pickle",
		"messages": []any{map[string]any{"role": "user", "content": "hi"}},
	}
	notes := Prepare(payload)

	if stream, _ := payload["stream"].(bool); !stream {
		t.Fatal("stream must be forced on: the free-lane gate requires a streaming body")
	}
	tools, _ := payload["tools"].([]any)
	if len(tools) != 2 {
		t.Fatalf("expected the two gate tools, got %d", len(tools))
	}
	names := map[string]bool{}
	for _, raw := range tools {
		tool := raw.(map[string]any)
		names[tool["function"].(map[string]any)["name"].(string)] = true
	}
	if !names[GateToolBash] || !names[GateToolRead] {
		t.Fatalf("gate tools missing: %v", names)
	}
	if payload["tool_choice"] != "none" {
		t.Fatalf("a payload that carried no tools must pin tool_choice=none, got %v", payload["tool_choice"])
	}
	if !contains(notes, "stream_forced") || !contains(notes, "tool_choice_none") {
		t.Fatalf("notes did not record the rewrite: %v", notes)
	}
}

func TestPrepareRespectsClientTools(t *testing.T) {
	payload := map[string]any{
		"model":    "big-pickle",
		"stream":   true,
		"messages": []any{map[string]any{"role": "user", "content": "hi"}},
		"tools": []any{
			map[string]any{"type": "function", "function": map[string]any{"name": "bash", "parameters": map[string]any{}}},
			map[string]any{"type": "function", "function": map[string]any{"name": "weather", "parameters": map[string]any{}}},
		},
		"tool_choice": "auto",
	}
	Prepare(payload)
	tools, _ := payload["tools"].([]any)
	if len(tools) != 3 {
		t.Fatalf("only the missing gate tool should be appended, got %d tools", len(tools))
	}
	if payload["tool_choice"] != "auto" {
		t.Fatalf("a client tool_choice must survive, got %v", payload["tool_choice"])
	}
}

func TestSanitizeReasoningEffort(t *testing.T) {
	cases := []struct {
		in      any
		want    any
		present bool
		note    string
	}{
		{in: "off", want: "none", present: true, note: "reasoning_effort:none"},
		{in: "none", want: "none", present: true, note: "reasoning_effort:none"},
		{in: "HIGH", want: "high", present: true},
		{in: "ultra", present: false, note: "reasoning_effort_dropped:ultra"},
		{in: 42, present: false, note: "reasoning_effort_dropped:not_a_string"},
	}
	for _, tc := range cases {
		payload := map[string]any{"reasoning_effort": tc.in}
		note := sanitizeReasoningEffort(payload)
		got, present := payload["reasoning_effort"]
		if present != tc.present {
			t.Fatalf("reasoning_effort %v: present=%v, want %v", tc.in, present, tc.present)
		}
		if present && got != tc.want {
			t.Fatalf("reasoning_effort %v: got %v, want %v", tc.in, got, tc.want)
		}
		if note != tc.note {
			t.Fatalf("reasoning_effort %v: note %q, want %q", tc.in, note, tc.note)
		}
	}
}

func TestNormalizeToolReasoningHistory(t *testing.T) {
	payload := map[string]any{
		"model": "kimi-k2-free",
		"messages": []any{
			map[string]any{"role": "assistant", "tool_calls": []any{map[string]any{"id": "call_1"}}},
			map[string]any{"role": "assistant", "tool_calls": []any{map[string]any{"id": "call_2"}}, "reasoning": "already there"},
			map[string]any{"role": "assistant", "tool_calls": []any{map[string]any{"id": "call_3"}}, "reasoning_content": "kept"},
			map[string]any{"role": "assistant", "content": "no tool call"},
		},
	}
	if !normalizeToolReasoningHistory(payload, "kimi-k2-free") {
		t.Fatal("expected the rewrite to report a change")
	}
	messages := payload["messages"].([]any)
	if messages[0].(map[string]any)["reasoning_content"] != "tool call" {
		t.Fatalf("a tool-call turn without reasoning must get the placeholder, got %v", messages[0])
	}
	if messages[1].(map[string]any)["reasoning_content"] != "already there" {
		t.Fatalf("a legacy reasoning string must be promoted, got %v", messages[1])
	}
	if messages[2].(map[string]any)["reasoning_content"] != "kept" {
		t.Fatalf("an existing reasoning_content must not be overwritten, got %v", messages[2])
	}
	if _, touched := messages[3].(map[string]any)["reasoning_content"]; touched {
		t.Fatal("a turn without tool calls must be left alone")
	}

	// A model outside the reasoning vendors, with no explicit reasoning request,
	// must not be rewritten.
	plain := map[string]any{
		"model":    "big-pickle",
		"messages": []any{map[string]any{"role": "assistant", "tool_calls": []any{map[string]any{"id": "call_1"}}}},
	}
	if normalizeToolReasoningHistory(plain, "big-pickle") {
		t.Fatal("a non-reasoning vendor request must not be rewritten")
	}
}

func TestNormalizeClientToolSpellings(t *testing.T) {
	payload := map[string]any{
		"model": "space-bunny-free",
		"messages": []any{
			// ZCode's wire spelling: camelCase tool fields
			map[string]any{
				"role": "assistant", "content": "",
				"toolCalls": []any{map[string]any{"id": "call_1", "type": "function",
					"function": map[string]any{"name": "Bash", "arguments": "{}"}}},
				"providerId": "p", "modelId": "m",
			},
			map[string]any{"role": "tool", "toolCallId": "call_1", "toolName": "Bash", "isError": false, "content": "ok"},
			// a canonical turn must win over a stray camel field
			map[string]any{"role": "assistant", "tool_calls": []any{map[string]any{"id": "call_2"}}, "toolCalls": []any{map[string]any{"id": "WRONG"}}},
		},
	}
	notes := Prepare(payload)
	if !contains(notes, "client_fields_renamed:toolCallId+toolCalls") {
		t.Fatalf("rename was not reported: %v", notes)
	}
	messages := payload["messages"].([]any)
	assistant := messages[0].(map[string]any)
	if _, ok := assistant["tool_calls"]; !ok {
		t.Fatalf("toolCalls was not renamed: %v", assistant)
	}
	tool := messages[1].(map[string]any)
	if tool["tool_call_id"] != "call_1" {
		t.Fatalf("toolCallId was not renamed: %v", tool)
	}
	second := messages[2].(map[string]any)
	canonical := second["tool_calls"].([]any)[0].(map[string]any)
	if canonical["id"] != "call_2" {
		t.Fatalf("a canonical tool_calls must win over the camel spelling, got %v", canonical)
	}
}

func TestNormalizeClientToolSpellingsLeavesCanonicalAlone(t *testing.T) {
	payload := map[string]any{
		"messages": []any{
			map[string]any{"role": "assistant", "tool_calls": []any{map[string]any{"id": "call_1"}}},
			map[string]any{"role": "tool", "tool_call_id": "call_1", "content": "ok"},
		},
	}
	for _, note := range Prepare(payload) {
		if strings.HasPrefix(note, "client_fields_renamed") {
			t.Fatalf("canonical payload must not be rewritten: %s", note)
		}
	}
}
