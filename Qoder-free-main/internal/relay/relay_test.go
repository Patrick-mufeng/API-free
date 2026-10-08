package relay

import (
	"net/http/httptest"
	"strings"
	"testing"
)

// TestRelayStreamTerminatesEachEventWithBlankLine SSE 规范要求**空行**终止事件。
//
// 回归（这是一个真实报障的根因）：flushFrame 先前只写 "data: {...}\n" 而不补空行，
// 于是整条流在解析器看来是「一个永不结束的事件」——curl 直接把字节打出来看着正常，
// 但任何按规范解析的客户端（Vercel AI SDK、标准 EventSource/SSE parser）在连接
// 关闭前拿不到任何完整事件，表现为「零增量、finishReason=other」。
// ZCode 客户端报的 `empty_model_response / suspiciousEmpty` 就是这个。
func TestRelayStreamTerminatesEachEventWithBlankLine(t *testing.T) {
	upstream := strings.Join([]string{
		`data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant"}}]}`,
		``,
		`data: {"id":"c1","choices":[{"index":0,"delta":{"content":"你好"}}]}`,
		``,
		`data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`,
		``,
		`data: [DONE]`,
		``,
	}, "\n")

	rec := httptest.NewRecorder()
	if _, err := RelayStream(rec, strings.NewReader(upstream)); err != nil {
		t.Fatalf("RelayStream: %v", err)
	}
	body := rec.Body.String()

	// 每个 data: 行后面必须紧跟一个空行。
	events := 0
	lines := strings.Split(body, "\n")
	for i, line := range lines {
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		events++
		if i+1 >= len(lines) || lines[i+1] != "" {
			t.Fatalf("data line %q is not terminated by a blank line; body=%q", line, body)
		}
	}
	if events != 4 {
		t.Fatalf("want 4 data events, got %d; body=%q", events, body)
	}
	if !strings.HasSuffix(body, "data: [DONE]\n\n") {
		t.Fatalf("stream must end with a terminated [DONE] event; body=%q", body)
	}
	if c := strings.Count(body, "\n\n"); c != 4 {
		t.Fatalf("want 4 blank-line event terminators, got %d; body=%q", c, body)
	}
}

// TestRelayStreamPassesContentThrough 内容分片必须原样转发（含 usage 行）。
func TestRelayStreamPassesContentThrough(t *testing.T) {
	upstream := strings.Join([]string{
		`data: {"id":"c1","choices":[{"index":0,"delta":{"reasoning_content":"想"}}]}`,
		``,
		`data: {"id":"c1","choices":[{"index":0,"delta":{"content":"答案"}}]}`,
		``,
		`data: {"id":"c1","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}`,
		``,
		`data: [DONE]`,
		``,
	}, "\n")

	rec := httptest.NewRecorder()
	usage, err := RelayStream(rec, strings.NewReader(upstream))
	if err != nil {
		t.Fatalf("RelayStream: %v", err)
	}
	body := rec.Body.String()
	for _, want := range []string{`"reasoning_content":"想"`, `"content":"答案"`, `"total_tokens":12`} {
		if !strings.Contains(body, want) {
			t.Errorf("body missing %s; got %q", want, body)
		}
	}
	if usage.TotalTokens != 12 {
		t.Errorf("usage.TotalTokens = %d, want 12", usage.TotalTokens)
	}
}
