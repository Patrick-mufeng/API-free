// Package worker manages one Node daemon per Qoder account and speaks its
// HTTP contract: /health, /v1/chat/completions, /admin/{models,quota,login,checkin}.
//
// The daemon (copied from cli2api worker/) loads the pinned qodercli bundle,
// patches hook needles into it, and serves an OpenAI-shaped chat API backed by
// the CLI's WASM runtime. Credentials live in the account home dir, so the Go
// side only needs to keep the process alive and point it at the right HOME.
package worker

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Process struct {
	ID        string
	URL       string
	Port      int
	startedAt time.Time
	cmd       *exec.Cmd
	done      chan struct{}
	exitErr   error
}

type Manager struct {
	mu       sync.Mutex
	procs    map[string]*Process
	ports    map[int]string // port -> accountID
	logSink  io.Writer

	NodeBinary    string
	DaemonPath    string
	CLIJS         string // global bundle path; empty = auto-detect in worker/node_modules
	CLICNJS       string // cn bundle path; empty = auto-detect in worker/node_modules
	PlainTemplate string
	APIKey        string // shared PROXY_API_KEY between Go and workers
	ProxyURL      string
	BasePort      int
	MaxLogBytes   int

	client *http.Client
}

func NewManager(logSink io.Writer) *Manager {
	return &Manager{
		procs:   map[string]*Process{},
		ports:   map[int]string{},
		logSink: logSink,
		client:  &http.Client{Timeout: 130 * time.Second},
	}
}

// ConfigDir mirrors cli2api qoder.ConfigDirName: .qoder-cn for cn, .qoder otherwise.
func ConfigDir(home, region string) string {
	if strings.EqualFold(strings.TrimSpace(region), "cn") {
		return filepath.Join(home, ".qoder-cn")
	}
	return filepath.Join(home, ".qoder")
}

// autoCLIJS resolves the pinned qodercli bundle from worker/node_modules,
// where `npm ci --prefix worker` installs the CLI packages. This keeps a
// fresh checkout runnable without installing the CLI globally or editing
// config paths.
func (m *Manager) autoCLIJS(region string) string {
	workerRoot := filepath.Dir(filepath.Dir(m.DaemonPath))
	if strings.EqualFold(region, "cn") {
		return filepath.Join(workerRoot, "node_modules", "@qodercn-ai", "qoderclicn", "bundle", "qoderclicn.js")
	}
	return filepath.Join(workerRoot, "node_modules", "@qoder-ai", "qodercli", "bundle", "qodercli.js")
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

func (m *Manager) Running(id string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, ok := m.procs[id]
	return ok
}

func (m *Manager) URL(id string) (string, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if proc, ok := m.procs[id]; ok {
		return proc.URL, true
	}
	return "", false
}

// Start spawns the daemon for an account. No-op when already running.
func (m *Manager) Start(accountID, region, home string, maxInFlight int) error {
	m.mu.Lock()
	if _, ok := m.procs[accountID]; ok {
		m.mu.Unlock()
		return nil
	}
	cliPath := m.CLIJS
	site := "global"
	configEnv := "QODER_CONFIG_DIR"
	if strings.EqualFold(region, "cn") {
		cliPath = m.CLICNJS
		site = "cn"
		configEnv = "QODERCN_CONFIG_DIR"
	}
	configDir := ConfigDir(home, region)
	if cliPath == "" {
		if auto := m.autoCLIJS(region); fileExists(auto) {
			cliPath = auto
			m.logf("[worker] account %s: using auto-detected qodercli bundle %s", accountID, cliPath)
		}
	}
	if cliPath == "" {
		m.mu.Unlock()
		return fmt.Errorf("qodercli bundle not found for region %s (run npm ci --prefix worker, or set qoder_cli_js / qoder_cn_cli_js)", region)
	}
	port, err := m.allocPortLocked(accountID)
	if err != nil {
		m.mu.Unlock()
		return err
	}
	m.mu.Unlock()

	if err := os.MkdirAll(filepath.Join(home, "work"), 0o700); err != nil {
		return err
	}
	env := append(os.Environ(),
		"HOME="+home,
		"QODER_HOME="+configDir,
		configEnv+"="+configDir,
		"QODER_SITE="+site,
		"QODER_ACCOUNT_ID="+accountID,
		"QODER_MAX_INFLIGHT="+strconv.Itoa(maxInFlight),
		"WORKER_HOST=127.0.0.1",
		"WORKER_PORT="+strconv.Itoa(port),
		"PROXY_API_KEY="+m.APIKey,
		"QODERCLI_JS="+cliPath,
		"PLAIN_TEMPLATE_PATH="+m.PlainTemplate,
		"QODER_WARMUP_CWD="+filepath.Join(home, "work"),
		"QODER_PROXY_URL="+m.ProxyURL,
	)
	cmd := exec.Command(m.NodeBinary, m.DaemonPath)
	cmd.Env = env
	cmd.Stdout = &prefixWriter{prefix: "[" + accountID + "] ", next: m.logSink}
	cmd.Stderr = cmd.Stdout
	if err := cmd.Start(); err != nil {
		m.freePort(port, accountID)
		return fmt.Errorf("spawn worker: %w", err)
	}
	proc := &Process{
		ID:        accountID,
		URL:       "http://127.0.0.1:" + strconv.Itoa(port),
		Port:      port,
		startedAt: time.Now(),
		cmd:       cmd,
		done:      make(chan struct{}),
	}
	m.mu.Lock()
	m.procs[accountID] = proc
	m.mu.Unlock()
	go func() {
		proc.exitErr = cmd.Wait()
		close(proc.done)
		m.mu.Lock()
		if cur, ok := m.procs[accountID]; ok && cur == proc {
			delete(m.procs, accountID)
			m.freePortLocked(port, accountID)
		}
		m.mu.Unlock()
		m.logf("[worker] account %s exited (port %d): %v", accountID, port, proc.exitErr)
	}()
	return nil
}

// Stop terminates the daemon for an account, if running.
func (m *Manager) Stop(accountID string) {
	m.mu.Lock()
	proc, ok := m.procs[accountID]
	if !ok {
		m.mu.Unlock()
		return
	}
	port := proc.Port
	delete(m.procs, accountID)
	m.freePortLocked(port, accountID)
	m.mu.Unlock()
	_ = proc.cmd.Process.Signal(os.Interrupt)
	select {
	case <-proc.done:
	case <-time.After(3 * time.Second):
		_ = proc.cmd.Process.Kill()
	}
}

func (m *Manager) StopAll() {
	m.mu.Lock()
	ids := make([]string, 0, len(m.procs))
	for id := range m.procs {
		ids = append(ids, id)
	}
	m.mu.Unlock()
	for _, id := range ids {
		m.Stop(id)
	}
}

// WaitHealthy polls /health until the daemon reports hasAuthManager (warm)
// or the timeout elapses. waitForAuth=false accepts any live /health.
func (m *Manager) WaitHealthy(ctx context.Context, accountID string, waitForAuth bool, timeout time.Duration) (*Health, error) {
	if _, ok := m.URL(accountID); !ok {
		return nil, ErrNotRunning
	}
	deadline := time.Now().Add(timeout)
	var lastErr error
	for {
		health, err := m.Probe(ctx, accountID)
		if err == nil {
			if !waitForAuth || health.HasAuthManager {
				return health, nil
			}
			lastErr = ErrNotWarm
		} else {
			lastErr = err
		}
		if time.Now().After(deadline) {
			return health, fmt.Errorf("%w: %v", ErrNotWarm, lastErr)
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(300 * time.Millisecond):
		}
	}
}

func (m *Manager) allocPortLocked(accountID string) (int, error) {
	for offset := 0; offset < 500; offset++ {
		port := m.BasePort + offset
		if _, taken := m.ports[port]; taken {
			continue
		}
		listener, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(port))
		if err != nil {
			continue
		}
		_ = listener.Close()
		m.ports[port] = accountID
		return port, nil
	}
	return 0, fmt.Errorf("no free worker port in range starting %d", m.BasePort)
}

func (m *Manager) freePort(port int, accountID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.freePortLocked(port, accountID)
}

func (m *Manager) freePortLocked(port int, accountID string) {
	if owner, ok := m.ports[port]; ok && owner == accountID {
		delete(m.ports, port)
	}
}

func (m *Manager) logf(format string, args ...any) {
	if m.logSink == nil {
		return
	}
	fmt.Fprintf(m.logSink, format+"\n", args...)
}

type prefixWriter struct {
	prefix string
	next   io.Writer
	buf    []byte
	mu     sync.Mutex
}

func (w *prefixWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.next == nil {
		return len(p), nil
	}
	w.buf = append(w.buf, p...)
	for {
		idx := -1
		for i, b := range w.buf {
			if b == '\n' {
				idx = i
				break
			}
		}
		if idx < 0 {
			break
		}
		line := append([]byte(nil), w.buf[:idx+1]...)
		w.buf = w.buf[idx+1:]
		if _, err := w.next.Write(append([]byte(w.prefix), line...)); err != nil {
			return len(p), err
		}
	}
	return len(p), nil
}

var (
	ErrNotRunning = errors.New("account worker is not running")
	ErrNotWarm    = errors.New("account worker is not ready")
)
