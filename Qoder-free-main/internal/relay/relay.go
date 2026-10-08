// Package relay pipes worker SSE frames to the HTTP client while scraping
// usage and detecting mid-stream errors. Worker frames are already
// OpenAI-shaped (chat.completion.chunk + data: [DONE]), so frames pass
// through unmodified.
package relay

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

type Usage struct {
	PromptTokens     int64  `json:"prompt_tokens"`
	CompletionTokens int64  `json:"completion_tokens"`
	TotalTokens      int64  `json:"total_tokens"`
	Source           string `json:"source"`
	Credits          any    `json:"credits,omitempty"`
}

// MidStreamError reports an error frame observed after the stream started.
type MidStreamError struct {
	Status  int
	Code    string
	Message string
}

func (e *MidStreamError) Error() string {
	if e.Code != "" {
		return e.Code + ": " + e.Message
	}
	return e.Message
}

func SetSSEHeaders(w http.ResponseWriter) {
	header := w.Header()
	header.Set("Content-Type", "text/event-stream")
	header.Set("Cache-Control", "no-cache")
	header.Set("Connection", "keep-alive")
	header.Set("X-Accel-Buffering", "no")
}

// RelayStream copies SSE frames from body to w until [DONE] or EOF.
// It returns the usage scraped from the final chunk, if any.
func RelayStream(w http.ResponseWriter, body io.Reader) (Usage, error) {
	SetSSEHeaders(w)
	flusher, _ := w.(http.Flusher)
	reader := bufio.NewReaderSize(body, 64*1024)
	var usage Usage
	var streamErr *MidStreamError

	writeLine := func(line string) error {
		if _, err := io.WriteString(w, line+"\n"); err != nil {
			return err
		}
		if flusher != nil {
			flusher.Flush()
		}
		return nil
	}

	var frame []string
	flushFrame := func() error {
		if len(frame) == 0 {
			return nil
		}
		data := dataPayload(frame)
		frame = frame[:0]
		if data == "" {
			return nil
		}
		// 每条 data 行之后必须补一个**空行**——SSE 规范用空行终止事件，
		// 只写 "data: {...}\n" 而不写 "\n" 会让整个流变成「一个永不结束的事件」：
		// curl 直接把字节打出来看着是好的，但任何按规范解析的客户端（Vercel AI SDK、
		// 标准 EventSource/SSE parser）在连接关闭前都拿不到任何完整事件，
		// 表现为「零增量、finishReason=other」——ZCode 报的 empty_model_response 就是这个。
		emit := func(line string) error {
			if err := writeLine(line); err != nil {
				return err
			}
			return writeLine("")
		}
		if data == "[DONE]" {
			return emit("data: [DONE]")
		}
		if parsed, ok := parseChunk(data); ok {
			if err := looksLikeError(parsed); err != nil && streamErr == nil {
				streamErr = err
			}
			if u, ok := extractUsage(parsed); ok {
				usage = u
			}
		}
		return emit("data: " + data)
	}

	for {
		line, err := reader.ReadString('\n')
		trimmed := strings.TrimRight(line, "\r\n")
		switch {
		case trimmed == "":
			// blank line ends an SSE frame
			if flushErr := flushFrame(); flushErr != nil {
				return usage, flushErr
			}
		case strings.HasPrefix(trimmed, "data:"):
			frame = append(frame, strings.TrimSpace(strings.TrimPrefix(trimmed, "data:")))
		default:
			// event:/id:/retry: or comments — forward verbatim
			if writeErr := writeLine(trimmed); writeErr != nil {
				return usage, writeErr
			}
		}
		if err != nil {
			if flushErr := flushFrame(); flushErr != nil {
				return usage, flushErr
			}
			if err != io.EOF {
				return usage, err
			}
			break
		}
	}
	if usage.TotalTokens == 0 && usage.PromptTokens == 0 && usage.CompletionTokens == 0 {
		usage.Source = "none"
	}
	if streamErr != nil {
		return usage, streamErr
	}
	return usage, nil
}

func dataPayload(lines []string) string {
	for _, line := range lines {
		if line != "" {
			return line
		}
	}
	return ""
}

func parseChunk(data string) (map[string]any, bool) {
	var parsed map[string]any
	if json.Unmarshal([]byte(data), &parsed) != nil || parsed == nil {
		return nil, false
	}
	return parsed, true
}

func looksLikeError(parsed map[string]any) *MidStreamError {
	raw, ok := parsed["error"]
	if !ok {
		return nil
	}
	err := &MidStreamError{Status: 502, Message: fmt.Sprint(raw)}
	if obj, ok := raw.(map[string]any); ok {
		if code, ok := obj["code"].(string); ok {
			err.Code = code
		}
		if msg, ok := obj["message"].(string); ok {
			err.Message = msg
		}
		if status, ok := obj["status"].(float64); ok {
			err.Status = int(status)
		}
	}
	return err
}

func extractUsage(parsed map[string]any) (Usage, bool) {
	raw, ok := parsed["usage"]
	if !ok {
		return Usage{}, false
	}
	obj, ok := raw.(map[string]any)
	if !ok {
		return Usage{}, false
	}
	toInt := func(v any) int64 {
		if f, ok := v.(float64); ok {
			return int64(f)
		}
		return 0
	}
	usage := Usage{
		PromptTokens:     toInt(obj["prompt_tokens"]),
		CompletionTokens: toInt(obj["completion_tokens"]),
		TotalTokens:      toInt(obj["total_tokens"]),
	}
	if source, ok := obj["source"].(string); ok {
		usage.Source = source
	}
	if credits, ok := obj["credits"]; ok {
		usage.Credits = credits
	}
	if usage.TotalTokens == 0 {
		usage.TotalTokens = usage.PromptTokens + usage.CompletionTokens
	}
	return usage, true
}
