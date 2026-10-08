// Package obs provides the service logger: structured JSON on stderr (which
// the panel captures into data/logs/<id>.log) plus an in-memory ring the
// /panel/api/logs endpoint serves.
package obs

import (
	"context"
	"log/slog"
	"os"
	"strings"
	"sync"
	"time"
)

// Entry is one ring-buffer log line. The field names match what the panel's
// log view reads (ts / ch / text).
type Entry struct {
	TS   string `json:"ts"`
	Ch   string `json:"ch"`
	Text string `json:"text"`
}

type Ring struct {
	mu    sync.Mutex
	items []Entry
	max   int
}

func NewRing(max int) *Ring {
	if max <= 0 {
		max = 500
	}
	return &Ring{max: max}
}

func (r *Ring) Add(ch, text string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.items = append(r.items, Entry{TS: time.Now().Format(time.RFC3339), Ch: ch, Text: text})
	if len(r.items) > r.max {
		r.items = append([]Entry(nil), r.items[len(r.items)-r.max:]...)
	}
}

// Snapshot returns the buffered lines oldest-first.
func (r *Ring) Snapshot() []Entry {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]Entry, len(r.items))
	copy(out, r.items)
	return out
}

type ringHandler struct {
	inner slog.Handler
	ring  *Ring
}

func (h *ringHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.inner.Enabled(ctx, level)
}

func (h *ringHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return &ringHandler{inner: h.inner.WithAttrs(attrs), ring: h.ring}
}

func (h *ringHandler) WithGroup(name string) slog.Handler {
	return &ringHandler{inner: h.inner.WithGroup(name), ring: h.ring}
}

func (h *ringHandler) Handle(ctx context.Context, record slog.Record) error {
	channel := "app"
	message := strings.ToLower(record.Message)
	var extras []string
	record.Attrs(func(attr slog.Attr) bool {
		switch attr.Key {
		case "component":
			channel = attr.Value.String()
		case "event":
			// The event name usually restates the message ("zen-free
			// listening" + event=listening, "model catalog refreshed" +
			// event=catalog_refreshed); keep it only when it adds a word.
			if !eventIsRedundant(message, attr.Value.String()) {
				extras = append(extras, attr.Value.String())
			}
		default:
			if attr.Value.Kind() == slog.KindString && attr.Value.String() != "" {
				extras = append(extras, attr.Key+"="+attr.Value.String())
			}
		}
		return true
	})
	text := record.Message
	if len(extras) > 0 {
		text += " · " + strings.Join(extras, " · ")
	}
	h.ring.Add(channel, text)
	return h.inner.Handle(ctx, record)
}

// eventIsRedundant reports whether the event name says nothing the message
// does not already say. message is expected to be lowercase.
func eventIsRedundant(message, event string) bool {
	if event == "" {
		return true
	}
	if strings.Contains(message, strings.ToLower(event)) {
		return true
	}
	for _, word := range strings.Split(strings.ToLower(event), "_") {
		if word == "" {
			continue
		}
		if !strings.Contains(message, word) {
			return false
		}
	}
	return true
}

// NewLogger returns a JSON logger on stderr that also feeds the ring.
func NewLogger(ring *Ring, level slog.Level) *slog.Logger {
	handler := slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: level})
	if ring == nil {
		return slog.New(handler)
	}
	return slog.New(&ringHandler{inner: handler, ring: ring})
}
