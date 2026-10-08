package panel

import (
	_ "embed"
	"net/http"
	"os"
	"path/filepath"
)

//go:embed index.html
var indexHTML []byte

//go:embed app.js
var appJS []byte

func (p *Panel) serveIndex(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Frame-Options", "DENY")
	_, _ = w.Write(indexHTML)
}

func (p *Panel) serveApp(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	_, _ = w.Write(appJS)
}

// staticFile serves an optional file from disk (unused by default; kept for
// local iteration without rebuilding).
func staticFile(name, contentType string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		raw, err := os.ReadFile(filepath.Join("internal", "panel", name))
		if err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", contentType)
		_, _ = w.Write(raw)
	}
}
