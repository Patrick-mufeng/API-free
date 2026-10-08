package gateway

import (
	"encoding/json"
	"strings"
	"testing"
)

// The upstream always streams (the gate requires it), so a non-streaming
// client is served by assembling the deltas. This is that assembly.
func TestSSETapAssemblesChatCompletion(t *testing.T) {
	tap := newSSETap()
	stream := strings.Join([]string{
		`data: {"id":"chatcmpl-x","object":"chat.completion.chunk","created":1791444870,"model":"big-pickle","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}`,
		`data: {"id":"chatcmpl-x","model":"big-pickle","choices":[{"index":0,"delta":{"reasoning_content":"先想一下"},"finish_reason":null}]}`,
		`data: {"id":"chatcmpl-x","model":"big-pickle","choices":[{"index":0,"delta":{"content":"收到"},"finish_reason":null}]}`,
		`data: {"id":"chatcmpl-x","model":"big-pickle","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"wea","arguments":"{\"ci"}}]},"finish_reason":null}]}`,
		`data: {"id":"chatcmpl-x","model":"big-pickle","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"name":"ther","arguments":"ty\":\"sf\"}"}}]},"finish_reason":"tool_calls"}]}`,
		`data: {"id":"chatcmpl-x","model":"big-pickle","choices":[],"usage":{"prompt_tokens":11,"completion_tokens":22,"total_tokens":33}}`,
		`data: [DONE]`,
		``,
	}, "\n\n")

	if _, err := tap.Write([]byte(stream)); err != nil {
		t.Fatalf("write: %v", err)
	}
	tap.Finish()

	response := tap.Response("big-pickle")
	choices := response["choices"].([]map[string]any)
	if len(choices) != 1 {
		t.Fatalf("expected one choice, got %d", len(choices))
	}
	choice := choices[0]
	if choice["finish_reason"] != "tool_calls" {
		t.Fatalf("finish_reason = %v", choice["finish_reason"])
	}
	message := choice["message"].(map[string]any)
	if message["content"] != "收到" {
		t.Fatalf("content = %q", message["content"])
	}
	if message["reasoning_content"] != "先想一下" {
		t.Fatalf("reasoning_content = %q", message["reasoning_content"])
	}
	calls := message["tool_calls"].([]map[string]any)
	if len(calls) != 1 {
		t.Fatalf("expected one tool call, got %d", len(calls))
	}
	function := calls[0]["function"].(map[string]any)
	if function["name"] != "weather" {
		t.Fatalf("a fragmented tool name must be glued, got %q", function["name"])
	}
	if function["arguments"] != `{"city":"sf"}` {
		t.Fatalf("fragmented arguments must be concatenated, got %q", function["arguments"])
	}
	if response["object"] != "chat.completion" {
		t.Fatalf("object = %v", response["object"])
	}
	usage := response["usage"].(map[string]any)
	if usage["prompt_tokens"] != int64(11) || usage["completion_tokens"] != int64(22) || usage["total_tokens"] != int64(33) {
		t.Fatalf("usage = %v", usage)
	}
	if tap.usageIn != 11 || tap.usageOut != 22 || !tap.usageSeen {
		t.Fatalf("tapped usage = %d/%d seen=%v", tap.usageIn, tap.usageOut, tap.usageSeen)
	}

	// The assembled body must be valid JSON a client can parse.
	if _, err := json.Marshal(response); err != nil {
		t.Fatalf("assembled response is not marshalable: %v", err)
	}
}

// A chunk split across two reads (the common case on a real socket) must be
// buffered until its terminator arrives.
func TestSSETapBuffersPartialFrames(t *testing.T) {
	tap := newSSETap()
	part1 := `data: {"id":"c","model":"m","choices":[{"index":0,"delta":{"content":"he`
	part2 := `llo"}}]}`
	if _, err := tap.Write([]byte(part1)); err != nil {
		t.Fatalf("write: %v", err)
	}
	if tap.content.String() != "" {
		t.Fatalf("an incomplete frame must not be consumed, got %q", tap.content.String())
	}
	if _, err := tap.Write([]byte(part2 + "\n\n")); err != nil {
		t.Fatalf("write: %v", err)
	}
	if tap.content.String() != "hello" {
		t.Fatalf("content = %q", tap.content.String())
	}
}

// Zen sends the running totals on every chunk; the accumulator keeps the last
// (largest) values rather than summing them.
func TestSSETapKeepsLargestUsage(t *testing.T) {
	tap := newSSETap()
	for _, usage := range []string{
		`{"prompt_tokens":5,"completion_tokens":1,"total_tokens":6}`,
		`{"prompt_tokens":5,"completion_tokens":9,"total_tokens":14}`,
		`{"prompt_tokens":5,"completion_tokens":9,"total_tokens":14}`,
	} {
		if _, err := tap.Write([]byte(`data: {"id":"c","choices":[],"usage":` + usage + "}\n\n")); err != nil {
			t.Fatalf("write: %v", err)
		}
	}
	if tap.usageIn != 5 || tap.usageOut != 9 || tap.usageTotal != 14 {
		t.Fatalf("usage must keep the largest values, got %d/%d/%d", tap.usageIn, tap.usageOut, tap.usageTotal)
	}
}

func TestSSETapHandlesCRLFAndComments(t *testing.T) {
	tap := newSSETap()
	frame := ": keep-alive\r\nevent: message\r\ndata: {\"id\":\"c\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ok\"}}]}\r\n\r\n"
	if _, err := tap.Write([]byte(frame)); err != nil {
		t.Fatalf("write: %v", err)
	}
	if tap.content.String() != "ok" {
		t.Fatalf("content = %q", tap.content.String())
	}
}

// Without usage in the stream the assembled response must omit it rather than
// claim zeros.
func TestSSETapOmitsUsageWhenAbsent(t *testing.T) {
	tap := newSSETap()
	if _, err := tap.Write([]byte(`data: {"id":"c","choices":[{"index":0,"delta":{"content":"x"},"finish_reason":"stop"}]}` + "\n\n")); err != nil {
		t.Fatalf("write: %v", err)
	}
	response := tap.Response("m")
	if _, present := response["usage"]; present {
		t.Fatal("usage must be omitted when the upstream never reported it")
	}
}
