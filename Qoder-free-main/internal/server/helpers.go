package server

import (
	"crypto/rand"
	"encoding/json"
	"net/http"

	"qoder-free/internal/worker"
)

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]any{
			"message": message,
			"type":    code,
			"code":    code,
		},
	})
}

// writeUpstreamError forwards a worker 4xx error body as an OpenAI-style error.
func writeUpstreamError(w http.ResponseWriter, status int, werr *worker.WorkerError) {
	writeError(w, status, werr.Code, werr.Message)
}

func cryptoRead(raw []byte) (int, error) {
	return rand.Read(raw)
}
