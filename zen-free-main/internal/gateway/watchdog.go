package gateway

import (
	"sync"
	"time"
)

// idleWatchdog cancels a stream when no bytes have arrived for the configured
// window. Neither HTTP/1.1 nor the client transport owns a body-silence
// timeout, so without this a tunnel that stands but never speaks hangs the
// turn until the client gives up.
type idleWatchdog struct {
	mu      sync.Mutex
	timer   *time.Timer
	window  time.Duration
	fired   bool
	stopped bool
}

func newIdleWatchdog(window time.Duration, onFire func()) *idleWatchdog {
	w := &idleWatchdog{window: window}
	if window <= 0 {
		return w
	}
	w.timer = time.AfterFunc(window, func() {
		w.mu.Lock()
		alreadyStopped := w.stopped
		w.fired = true
		w.mu.Unlock()
		if !alreadyStopped {
			onFire()
		}
	})
	return w
}

// Touch restarts the window; call it after every successful read.
func (w *idleWatchdog) Touch() {
	if w.timer == nil {
		return
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.stopped {
		return
	}
	w.timer.Reset(w.window)
}

func (w *idleWatchdog) Stop() {
	if w.timer == nil {
		return
	}
	w.mu.Lock()
	w.stopped = true
	w.mu.Unlock()
	w.timer.Stop()
}

// Fired reports whether the watchdog was the one that ended the stream.
func (w *idleWatchdog) Fired() bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.fired
}
