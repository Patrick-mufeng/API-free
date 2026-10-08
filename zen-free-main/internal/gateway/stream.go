package gateway

import (
	"bytes"
	"encoding/json"
	"strings"
	"time"

	"zen-free/internal/jsonx"
)

// sseTap consumes the upstream SSE byte stream without modifying it. It serves
// two callers: the pass-through path reads usage and the finish reason out of
// it, and the non-stream path uses the accumulated deltas to rebuild a single
// chat.completion response (the upstream body must always stream — that is
// half of the free-lane gate — so a non-streaming client is served by
// assembling the stream here).
type sseTap struct {
	buffer []byte

	id      string
	model   string
	created int64

	content   strings.Builder
	reasoning strings.Builder

	tools     map[int]*toolCall
	toolOrder []int

	finish string

	usageIn    int64
	usageOut   int64
	usageTotal int64
	usageSeen  bool
}

type toolCall struct {
	id   string
	name string
	args strings.Builder
}

func newSSETap() *sseTap {
	return &sseTap{tools: map[int]*toolCall{}}
}

// Write appends bytes and consumes every complete SSE frame.
func (t *sseTap) Write(data []byte) (int, error) {
	t.buffer = append(t.buffer, data...)
	for {
		index, width := nextSSEBoundary(t.buffer)
		if index < 0 {
			break
		}
		t.consumeFrame(t.buffer[:index+width])
		// Compact in place: the frame is gone, the remainder stays.
		remaining := copy(t.buffer, t.buffer[index+width:])
		t.buffer = t.buffer[:remaining]
	}
	return len(data), nil
}

// Finish consumes a trailing frame that never got its blank-line terminator.
func (t *sseTap) Finish() {
	if len(t.buffer) > 0 {
		t.consumeFrame(t.buffer)
		t.buffer = nil
	}
}

func nextSSEBoundary(data []byte) (int, int) {
	lf := bytes.Index(data, []byte("\n\n"))
	crlf := bytes.Index(data, []byte("\r\n\r\n"))
	switch {
	case lf < 0 && crlf < 0:
		return -1, 0
	case lf < 0:
		return crlf, 4
	case crlf < 0:
		return lf, 2
	case crlf < lf:
		return crlf, 4
	default:
		return lf, 2
	}
}

func (t *sseTap) consumeFrame(frame []byte) {
	var dataLines []string
	for _, rawLine := range strings.Split(string(frame), "\n") {
		line := strings.TrimSuffix(rawLine, "\r")
		switch {
		case line == "", strings.HasPrefix(line, ":"):
			continue
		case strings.HasPrefix(line, "data:"):
			dataLines = append(dataLines, strings.TrimSpace(strings.TrimPrefix(line, "data:")))
		}
	}
	if len(dataLines) == 0 {
		return
	}
	data := strings.Join(dataLines, "\n")
	if data == "[DONE]" {
		return
	}
	var value map[string]any
	if err := json.Unmarshal([]byte(data), &value); err != nil {
		return
	}
	t.consumeChunk(value)
}

func (t *sseTap) consumeChunk(value map[string]any) {
	if t.id == "" {
		t.id = jsonx.StringAt(value, "id")
		t.model = jsonx.StringAt(value, "model")
		t.created = int64(jsonx.IntAt(value, "created"))
	}
	if usage := jsonx.MapAt(value, "usage"); len(usage) > 0 {
		in := firstNonZero64(jsonx.IntAt(usage, "prompt_tokens"), jsonx.IntAt(usage, "input_tokens"))
		out := firstNonZero64(jsonx.IntAt(usage, "completion_tokens"), jsonx.IntAt(usage, "output_tokens"))
		total := firstNonZero64(jsonx.IntAt(usage, "total_tokens"), int(in+out))
		// The stream's final chunk carries the totals; keep the largest seen.
		if in > t.usageIn {
			t.usageIn = in
		}
		if out > t.usageOut {
			t.usageOut = out
		}
		if total > t.usageTotal {
			t.usageTotal = total
		}
		t.usageSeen = true
	}
	for _, raw := range jsonx.SliceAt(value, "choices") {
		choice, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		delta := jsonx.MapAt(choice, "delta")
		if text := jsonx.StringAt(delta, "content"); text != "" {
			t.content.WriteString(text)
		}
		if reasoning := jsonx.FirstString(jsonx.StringAt(delta, "reasoning_content"), jsonx.StringAt(delta, "reasoning")); reasoning != "" {
			t.reasoning.WriteString(reasoning)
		}
		for _, rawCall := range jsonx.SliceAt(delta, "tool_calls") {
			call, ok := rawCall.(map[string]any)
			if !ok {
				continue
			}
			index := jsonx.IntAt(call, "index")
			entry := t.tools[index]
			if entry == nil {
				entry = &toolCall{}
				t.tools[index] = entry
				t.toolOrder = append(t.toolOrder, index)
			}
			if id := jsonx.StringAt(call, "id"); id != "" {
				entry.id = id
			}
			if name := jsonx.StringAt(call, "function", "name"); name != "" {
				entry.name = mergeToolName(entry.name, name)
			}
			if args := jsonx.StringAt(call, "function", "arguments"); args != "" {
				entry.args.WriteString(args)
			}
		}
		if finish := jsonx.StringAt(choice, "finish_reason"); finish != "" {
			t.finish = finish
		}
	}
}

// mergeToolName glues fragmented function names, matching the reference's
// tolerant merge (some providers stream the name in pieces).
func mergeToolName(current, fragment string) string {
	switch {
	case current == "" || fragment == current:
		return fragment
	case strings.HasPrefix(fragment, current):
		return fragment
	default:
		return current + fragment
	}
}

// Response rebuilds the single chat.completion a non-streaming client asked
// for out of the accumulated deltas.
func (t *sseTap) Response(requestModel string) map[string]any {
	message := map[string]any{"role": "assistant", "content": t.content.String()}
	if reasoning := t.reasoning.String(); reasoning != "" {
		message["reasoning_content"] = reasoning
	}
	if len(t.toolOrder) > 0 {
		calls := make([]map[string]any, 0, len(t.toolOrder))
		for _, index := range t.toolOrder {
			call := t.tools[index]
			calls = append(calls, map[string]any{
				"index":    index,
				"id":       call.id,
				"type":     "function",
				"function": map[string]any{"name": call.name, "arguments": call.args.String()},
			})
		}
		message["tool_calls"] = calls
	}
	finish := t.finish
	if finish == "" {
		finish = "stop"
	}
	model := t.model
	if model == "" {
		model = requestModel
	}
	id := t.id
	if id == "" {
		id = "chatcmpl-" + time.Now().UTC().Format("20060102150405")
	}
	created := t.created
	if created == 0 {
		created = time.Now().Unix()
	}
	response := map[string]any{
		"id":      id,
		"object":  "chat.completion",
		"created": created,
		"model":   model,
		"choices": []map[string]any{{
			"index":         0,
			"message":       message,
			"finish_reason": finish,
		}},
	}
	if t.usageSeen {
		total := t.usageTotal
		if total == 0 {
			total = t.usageIn + t.usageOut
		}
		response["usage"] = map[string]any{
			"prompt_tokens":     t.usageIn,
			"completion_tokens": t.usageOut,
			"total_tokens":      total,
		}
	}
	return response
}

func firstNonZero64(values ...int) int64 {
	for _, value := range values {
		if value != 0 {
			return int64(value)
		}
	}
	return 0
}
