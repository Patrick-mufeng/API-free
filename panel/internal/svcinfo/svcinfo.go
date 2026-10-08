// Package svcinfo 汇总四个服务的运行时信息：冷却/熔断告警 + 首页服务卡片所需的
// 账号数、积分、任务进度、模型数等。
//
// 这些数据只有服务端拿得到——四个服务口径各不相同、且调用都要注入各自 api_key
// （复用代理层的 KeyFor）。前端只读一个 GET /api/svcinfo，不自己拼四个形状。
package svcinfo

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"api-free/panel/internal/registry"
)

/* ---------- 告警 ---------- */

// Alert 一条可直接展示的异常。
type Alert struct {
	Svc   string `json:"svc"`
	Kind  string `json:"kind"`  // cooling | breaker
	Text  string `json:"text"`  // 已本地化的整句描述
	Until string `json:"until"` // 预计恢复（HH:MM），取不到则为空
}

// Cool 单个服务的冷却计数；OK=false 表示该服务没有这个口径或没取到。
type Cool struct {
	Svc  string `json:"svc"`
	N    int    `json:"n"`
	Unit string `json:"unit"` // 账号 | 模型
	OK   bool   `json:"ok"`
	Err  string `json:"err,omitempty"`
}

/* ---------- 服务卡片 ---------- */

// Credits 账号池的积分/额度合计（各服务口径不同，只累加有值的账号）。
type Credits struct {
	Remaining float64 `json:"remaining"`
	Total     float64 `json:"total"`
}

// Task 一项活动/任务的完成情况。
type Task struct {
	Name  string `json:"name"`
	Done  int    `json:"done"`
	Total int    `json:"total"`
	Note  string `json:"note,omitempty"`
}

// Card 首页一张服务卡片的数据。指针字段为 nil = 该服务没有这个口径（界面显示 —），
// 与「确实是 0」区分开。
type Card struct {
	Svc      string   `json:"svc"`
	OK       bool     `json:"ok"`
	Err      string   `json:"err,omitempty"`
	Accounts *int     `json:"accounts,omitempty"`
	Healthy  *int     `json:"healthy,omitempty"`
	Cooling  *int     `json:"cooling,omitempty"`
	CoolUnit string   `json:"cool_unit,omitempty"`
	Credits  *Credits `json:"credits,omitempty"`
	Models   *int     `json:"models,omitempty"`
	Tasks    []Task   `json:"tasks,omitempty"`
	Note     string   `json:"note,omitempty"`
}

type Report struct {
	At       string  `json:"at"`
	Total    int     `json:"total"` // 冷却合计（只累加 OK 的服务）
	Cooling  []Cool  `json:"cooling"`
	Alerts   []Alert `json:"alerts"`
	Services []Card  `json:"services"`
}

// KeyFunc 取某服务的 api_key（复用代理层的读取与缓存）。
type KeyFunc func(svcID string) string

// RunningFunc 该服务进程是否在跑；停着的服务不必发请求。
type RunningFunc func(svcID string) bool

type Collector struct {
	reg     *registry.File
	key     KeyFunc
	running RunningFunc
	http    *http.Client

	mu    sync.Mutex
	cache *Report
	at    time.Time
}

const cacheTTL = 8 * time.Second

// maxTaskAccounts 卡片里的成长任务需要按账号逐个查，账号多了就只统计前几个。
const maxTaskAccounts = 4

func New(reg *registry.File, key KeyFunc, running RunningFunc) *Collector {
	return &Collector{
		reg:     reg,
		key:     key,
		running: running,
		http:    &http.Client{Timeout: 4 * time.Second},
	}
}

func (c *Collector) Report() Report {
	c.mu.Lock()
	if c.cache != nil && time.Since(c.at) < cacheTTL {
		r := *c.cache
		c.mu.Unlock()
		return r
	}
	c.mu.Unlock()

	r := c.collect()

	c.mu.Lock()
	c.cache, c.at = &r, time.Now()
	c.mu.Unlock()
	return r
}

func (c *Collector) collect() Report {
	rep := Report{At: time.Now().Format("15:04:05"), Cooling: []Cool{}, Alerts: []Alert{}, Services: []Card{}}
	for _, svc := range c.reg.Services {
		var d svcData
		switch svc.ID {
		case "workbuddy":
			d = c.workbuddy(svc)
		case "qoder":
			d = c.qoder(svc)
		case "cline":
			d = c.cline(svc)
		case "cmdgo":
			d = c.cmdgo(svc)
		default:
			d = svcData{
				Cool: Cool{Svc: svc.ID, Err: "该服务没有冷却口径"},
				Card: Card{Svc: svc.ID, Note: "面板不认识这个服务，未接任何数据源"},
			}
		}
		if d.Cool.OK {
			rep.Total += d.Cool.N
		}
		// 模型数：workbuddy / qoder 的状态接口里没有这个字段，退回数一下 /v1/models。
		// 四家的 /v1/models 都是 OpenAI 的 {object, data:[]} 形状（实测），只数长度。
		if d.Card.Models == nil {
			d.Card.Models = c.modelsCount(svc)
		}
		rep.Cooling = append(rep.Cooling, d.Cool)
		rep.Alerts = append(rep.Alerts, d.Alerts...)
		rep.Services = append(rep.Services, d.Card)
	}
	return rep
}

// svcData 一次采集同时产出「冷却告警」与「卡片」两部分。
type svcData struct {
	Cool   Cool
	Alerts []Alert
	Card   Card
}

/* ---------- 取数 ---------- */

func (c *Collector) get(svc registry.Service, path string) (map[string]any, error) {
	if c.running != nil && !c.running(svc.ID) {
		return nil, fmt.Errorf("服务未运行")
	}
	req, err := http.NewRequest(http.MethodGet, "http://127.0.0.1:"+strconv.Itoa(svc.Port)+path, nil)
	if err != nil {
		return nil, err
	}
	if c.key != nil {
		if k := c.key(svc.ID); k != "" {
			req.Header.Set("Authorization", "Bearer "+k)
		}
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("接口不可用")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("接口返回 HTTP %d", resp.StatusCode)
	}
	var m map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&m); err != nil {
		return nil, fmt.Errorf("响应不是 JSON")
	}
	return m, nil
}

/* 服务状态接口没报模型数时（workbuddy / qoder 就是这种情况），
   退回数一下 /v1/models 的 data 长度。没有可用账号时它会返回空列表，
   这时保持 nil，前端显示「—」而不是 0 —— 「没有模型」和「没这个口径」是两回事。 */
func (c *Collector) modelsCount(svc registry.Service) *int {
	doc, err := c.get(svc, "/v1/models")
	if err != nil {
		return nil
	}
	if n := len(asList(doc["data"])); n > 0 {
		return ptr(n)
	}
	return nil
}

/* ---------- 防御式取值 ---------- */

func asMap(v any) map[string]any {
	if m, ok := v.(map[string]any); ok {
		return m
	}
	return map[string]any{}
}

func asList(v any) []any {
	if l, ok := v.([]any); ok {
		return l
	}
	return nil
}

func asStr(v any) string {
	switch t := v.(type) {
	case string:
		return strings.TrimSpace(t)
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	}
	return ""
}

func asInt(v any) int {
	switch t := v.(type) {
	case float64:
		return int(t)
	case int:
		return t
	case json.Number:
		n, _ := t.Int64()
		return int(n)
	}
	return 0
}

func asFloat(v any) (float64, bool) {
	switch t := v.(type) {
	case float64:
		return t, true
	case int:
		return float64(t), true
	case json.Number:
		f, err := t.Float64()
		return f, err == nil
	}
	return 0, false
}

func asBool(v any) bool {
	b, _ := v.(bool)
	return b
}

func ptr(n int) *int { return &n }

// displayName 账号展示名：各服务字段不一，逐个回退。
func displayName(m map[string]any) string {
	for _, k := range []string{"nickname", "name", "email", "id", "uid"} {
		if s := asStr(m[k]); s != "" {
			if len(s) > 18 {
				return s[:8] + "…"
			}
			return s
		}
	}
	return "未知账号"
}

// tsOf 解析各服务混用的时间字段：RFC3339 / Unix 秒 / Unix 毫秒。
// Go 的零值时间（0001-01-01）与 2000 年前的时间一律视为「没有值」。
func tsOf(v any) (time.Time, bool) {
	switch t := v.(type) {
	case string:
		t = strings.TrimSpace(t)
		if t == "" {
			return time.Time{}, false
		}
		if tm, err := time.Parse(time.RFC3339, t); err == nil {
			return normalize(tm)
		}
		if n, err := strconv.ParseInt(t, 10, 64); err == nil {
			return fromUnix(n)
		}
	case float64:
		return fromUnix(int64(t))
	case json.Number:
		if n, err := t.Int64(); err == nil {
			return fromUnix(n)
		}
	}
	return time.Time{}, false
}

func normalize(t time.Time) (time.Time, bool) {
	if t.Before(time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)) {
		return time.Time{}, false
	}
	return t, true
}

func fromUnix(n int64) (time.Time, bool) {
	if n <= 0 {
		return time.Time{}, false
	}
	if n < 1e12 { // 秒级
		n *= 1000
	}
	return normalize(time.UnixMilli(n))
}

func isFuture(v any) bool {
	t, ok := tsOf(v)
	return ok && time.Now().Before(t)
}

// clockOf 预计恢复时刻（本地 HH:MM）；取不到返回空串。
func clockOf(v any) string {
	t, ok := tsOf(v)
	if !ok {
		return ""
	}
	return t.Local().Format("15:04")
}

func untilSuffix(v any) string {
	if s := clockOf(v); s != "" {
		return "，预计 " + s + " 恢复"
	}
	return ""
}
