// Package events 面板事件环形缓冲（启停/托管/统计拉取等），供日志页展示。
package events

import (
	"sync"
	"time"
)

type Event struct {
	T   string `json:"t"`
	Msg string `json:"msg"`
}

const max = 500

var (
	mu   sync.Mutex
	ring []Event
)

func Add(msg string) {
	mu.Lock()
	defer mu.Unlock()
	ring = append(ring, Event{T: time.Now().Format("15:04:05"), Msg: msg})
	if len(ring) > max {
		ring = ring[len(ring)-max:]
	}
}

func Snapshot() []Event {
	mu.Lock()
	defer mu.Unlock()
	out := make([]Event, len(ring))
	copy(out, ring)
	return out
}
