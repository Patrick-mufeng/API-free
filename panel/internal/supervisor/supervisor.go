// Package supervisor 真·进程启停：拉起/杀进程树/崩溃自动拉起（指数退避）/PID 收编。
package supervisor

import (
	"errors"
	"log"
	"fmt"
	"net"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"

	"api-free/panel/internal/events"
	"api-free/panel/internal/registry"
)

type Status string

const (
	StatusStopped  Status = "stopped"
	StatusStarting Status = "starting"
	StatusRunning  Status = "running"
)

type Snapshot struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Port      int    `json:"port"`
	Status    Status `json:"status"`
	PID       int    `json:"pid"`
	Managed   bool   `json:"managed"`   // 是否由面板拉起
	Restarts  int    `json:"restarts"`  // 累计自动重启次数
	LastError string `json:"lastError,omitempty"`
}

type entry struct {
	svc      registry.Service
	mu       sync.Mutex
	cmd      *exec.Cmd
	pid      int
	managed  bool
	stopping bool
	restarts int
	lastErr  string
	logFile  *os.File
	timer    *time.Timer // 延迟重启定时器
}

type Supervisor struct {
	mu          sync.Mutex
	entries     map[string]*entry
	panelRoot   string // panel/ 绝对路径
	dataDir     string
	autoRestart bool
}

func New(reg *registry.File, panelRoot, dataDir string, autoRestart bool) *Supervisor {
	s := &Supervisor{
		entries:     map[string]*entry{},
		panelRoot:   panelRoot,
		dataDir:     dataDir,
		autoRestart: autoRestart,
	}
	for _, svc := range reg.Services {
		s.entries[svc.ID] = &entry{svc: svc}
	}
	_ = os.MkdirAll(dataDir+"/logs", 0o755)
	return s
}

func (s *Supervisor) Get(id string) *entry {
	return s.entries[id]
}

// Adopt 面板启动时的 PID 收编：端口已通但非面板拉起的服务，标记为外部运行中，
// 并挂接管监督（端口关闭视为崩溃，自动拉起开启时由面板接管重启）。
func (s *Supervisor) Adopt() {
	for id, e := range s.entries {
		if portOpen(e.svc.Port) {
			e.mu.Lock()
			e.managed = false
			e.pid = pidByPort(e.svc.Port)
			e.mu.Unlock()
			go s.watchAdopted(id, e)
		}
	}
}

// watchAdopted 外部实例监督：面板未拉起期间端口连续探测不通 → 视为崩溃，接管重启。
// 一次探测失败不算（TCP 拨号偶发抖动会把活着的实例误判成崩溃），要求连续 missThreshold 次。
// 用户在面板里主动 Stop 过的（stopping=true）不算崩溃：端口重新被外部起起来之前不接管。
func (s *Supervisor) watchAdopted(id string, e *entry) {
	const missThreshold = 3 // 2s 一次 → 约 6s 确认
	misses := 0
	sawClosed := false // 已确认关闭过，用于区分 Stop 后的残留与真正被重新起来
	for {
		time.Sleep(2 * time.Second)
		e.mu.Lock()
		managed := e.managed
		stopping := e.stopping
		e.mu.Unlock()
		if managed {
			return
		}
		if portOpen(e.svc.Port) {
			misses = 0
			// 关闭过又开了 = 有人把它重新起来了，解除「主动停止」标记
			if sawClosed && stopping {
				e.mu.Lock()
				e.stopping = false
				e.mu.Unlock()
			}
			sawClosed = false
			continue
		}
		misses++
		if misses < missThreshold {
			continue
		}
		sawClosed = true
		if stopping {
			continue // 用户主动停止后的预期状态，不接管
		}
		if !s.autoRestart {
			return
		}
		events.Add("[svc] " + e.svc.Name + " 外部实例掉线，面板接管拉起")
		if err := s.Start(id); err != nil {
			e.mu.Lock()
			e.lastErr = "接管拉起失败: " + err.Error()
			e.mu.Unlock()
			log.Printf("[supervisor] %s 接管拉起失败: %v", id, err)
			return
		}
		e.mu.Lock()
		e.restarts++
		e.lastErr = ""
		e.mu.Unlock()
		return
	}
}

// IsRunning 供统计采集器判断服务是否在跑。
func (s *Supervisor) IsRunning(id string) bool {
	e := s.entries[id]
	if e == nil {
		return false
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	return deriveStatus(e) == StatusRunning
}

// Snapshot 全量状态（status 由「进程存活 + 端口探测」实时推导）。
func (s *Supervisor) Snapshot() []Snapshot {
	out := make([]Snapshot, 0, len(s.entries))
	for _, e := range s.entries {
		e.mu.Lock()
		st := deriveStatus(e)
		out = append(out, Snapshot{
			ID: e.svc.ID, Name: e.svc.Name, Port: e.svc.Port,
			Status: st, PID: e.pid, Managed: e.managed,
			Restarts: e.restarts, LastError: e.lastErr,
		})
		e.mu.Unlock()
	}
	return out
}

func deriveStatus(e *entry) Status {
	procAlive := e.cmd != nil && e.cmd.Process != nil && e.pid > 0 && processAlive(e.pid)
	if procAlive {
		if portOpen(e.svc.Port) {
			return StatusRunning
		}
		return StatusStarting
	}
	if portOpen(e.svc.Port) {
		return StatusRunning // 外部实例
	}
	return StatusStopped
}

// Start 拉起服务（若端口已被占则报错；取消挂起的自动重启）。
func (s *Supervisor) Start(id string) error {
	e := s.entries[id]
	if e == nil {
		return fmt.Errorf("未知服务 %s", id)
	}
	e.mu.Lock()
	defer e.mu.Unlock()

	if portOpen(e.svc.Port) {
		return fmt.Errorf("端口 %d 已被监听（服务可能在面板外运行）", e.svc.Port)
	}
	if e.timer != nil { // 取消挂起的自动重启
		e.timer.Stop()
		e.timer = nil
	}

	dir := e.svc.ResolveDir(s.panelRoot)
	cmd := exec.Command(e.svc.Command, e.svc.Args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), envPairs(e.svc.Env)...)

	logFile, err := os.OpenFile(s.dataDir+"/logs/"+e.svc.ID+".log", os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return fmt.Errorf("打开日志失败: %w", err)
	}
	if e.logFile != nil {
		_ = e.logFile.Close()
	}
	e.logFile = logFile
	cmd.Stdout, cmd.Stderr = logFile, logFile

	if err := cmd.Start(); err != nil {
		e.lastErr = err.Error()
		return fmt.Errorf("启动失败: %w", err)
	}
	e.cmd = cmd
	e.pid = cmd.Process.Pid
	e.managed = true
	e.stopping = false
	e.lastErr = ""

	events.Add("[svc] " + e.svc.Name + " 已启动 pid=" + strconv.Itoa(e.pid))
	go s.watchExit(e)
	return nil
}

// watchExit 进程退出后的处理：手动停止→落地 stopped；异常退出→指数退避自动拉起。
func (s *Supervisor) watchExit(e *entry) {
	err := e.cmd.Wait()
	e.mu.Lock()
	defer e.mu.Unlock()
	e.pid = 0
	if e.logFile != nil {
		_ = e.logFile.Close()
		e.logFile = nil
	}
	if e.stopping {
		e.stopping = false
		return
	}
	msg := "进程退出"
	if err != nil {
		msg = "进程异常退出: " + err.Error()
	}
	e.lastErr = msg
	events.Add("[svc] " + e.svc.Name + " " + msg)
	if !s.autoRestart {
		return
	}
	delay := time.Duration(30<<min(e.restarts, 5)) * time.Second // 30s 起步，最长 16m
	if delay > 10*time.Minute {
		delay = 10 * time.Minute
	}
	e.restarts++
	id := e.svc.ID
	events.Add("[svc] " + e.svc.Name + " 将在 " + delay.String() + " 后自动拉起（第 " + strconv.Itoa(e.restarts) + " 次）")
	e.timer = time.AfterFunc(delay, func() {
		if err := s.Start(id); err != nil {
			e.mu.Lock()
			e.lastErr = "自动重启失败: " + err.Error()
			e.mu.Unlock()
		}
	})
}

// Stop 杀进程树（含子进程）。面板拉起的按 PID 杀；外部实例按端口找 PID 杀。
func (s *Supervisor) Stop(id string) error {
	e := s.entries[id]
	if e == nil {
		return fmt.Errorf("未知服务 %s", id)
	}
	e.mu.Lock()
	defer e.mu.Unlock()

	procAlive := e.cmd != nil && e.cmd.Process != nil && e.pid > 0 && processAlive(e.pid)
	if !portOpen(e.svc.Port) && !procAlive {
		return fmt.Errorf("服务未在运行")
	}
	e.stopping = true
	if e.timer != nil {
		e.timer.Stop()
		e.timer = nil
	}

	pid := e.pid
	if !procAlive || !e.managed {
		pid = pidByPort(e.svc.Port)
	}
	if pid <= 0 {
		e.stopping = false
		return fmt.Errorf("未找到监听端口 %d 的进程", e.svc.Port)
	}
	if err := killTree(pid); err != nil {
		e.stopping = false
		return fmt.Errorf("停止失败: %w", err)
	}
	if e.cmd != nil {
		go func(c *exec.Cmd) { _ = c.Wait() }(e.cmd) // 让 watchExit 正常收尾
	}
	e.pid = 0
	e.cmd = nil
	e.managed = false
	events.Add("[svc] " + e.svc.Name + " 已停止")
	return nil
}

func (s *Supervisor) Restart(id string) error {
	e := s.entries[id]
	if e == nil {
		return fmt.Errorf("未知服务 %s", id)
	}
	e.mu.Lock()
	wasRunning := deriveStatus(e) == StatusRunning
	e.mu.Unlock()
	if wasRunning {
		if err := s.Stop(id); err != nil {
			return err
		}
		time.Sleep(600 * time.Millisecond)
	}
	return s.Start(id)
}

/* ---------- 平台工具（Windows） ---------- */

func envPairs(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k, v := range m {
		out = append(out, k+"="+v)
	}
	return out
}

func portOpen(port int) bool {
	conn, err := net.DialTimeout("tcp", "127.0.0.1:"+strconv.Itoa(port), 400*time.Millisecond)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

func processAlive(pid int) bool {
	// Windows 没有 Signal(0)，用 tasklist 精确 PID 查询
	out, err := exec.Command("tasklist", "/FI", "PID eq "+strconv.Itoa(pid), "/NH").Output()
	if err != nil {
		return true // 查询失败时乐观认为存活
	}
	return strings.Contains(strings.ToUpper(string(out)), ".EXE") || strings.Contains(string(out), strconv.Itoa(pid))
}

func killTree(pid int) error {
	out, err := exec.Command("taskkill", "/PID", strconv.Itoa(pid), "/T", "/F").CombinedOutput()
	if err != nil {
		return errors.New(strings.TrimSpace(string(out)))
	}
	return nil
}

// pidByPort 用 netstat 找监听端口的 PID（收编外部实例的停止）。
func pidByPort(port int) int {
	out, err := exec.Command("netstat", "-ano", "-p", "tcp").Output()
	if err != nil {
		return 0
	}
	suffix := ":" + strconv.Itoa(port)
	for _, line := range strings.Split(string(out), "\n") {
		if !strings.Contains(line, "LISTENING") || !strings.Contains(line, suffix) {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) >= 5 && strings.HasSuffix(fields[1], suffix) {
			if p, err := strconv.Atoi(fields[len(fields)-1]); err == nil {
				return p
			}
		}
	}
	return 0
}
