package panel

import (
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/linguo2625469/workbuddy2api-panel/internal/auth"
	"github.com/linguo2625469/workbuddy2api-panel/internal/pool"
	"github.com/linguo2625469/workbuddy2api-panel/internal/stats"
)

// newStatsPanel 构造带统计聚合器的面板（不鉴权，便于直接打接口）。
func newStatsPanel(t *testing.T) (*Panel, *stats.Recorder) {
	t.Helper()
	p := pool.New("") // 空路径 = 纯内存池，不落盘
	rec := stats.New("", 30)
	t.Cleanup(rec.Close)
	return New(Config{Version: "test", Pool: p, Stats: rec}), rec
}

// usageDelta 构造一次带完整 usage 的成功样本。
func usageDelta(prompt, completion, total int64) pool.TokenUsageDelta {
	return pool.TokenUsageDelta{
		HasPromptTokens: true, PromptTokens: prompt,
		HasCompletionTokens: true, CompletionTokens: completion,
		HasTotalTokens: true, TotalTokens: total,
	}
}

// 未注入 Recorder（stats.enabled=false）时统计接口返回 501 而不是空报表——
// "统计关着"与"统计开着但还没有数据"是两件事，运维不该靠猜。
func TestStatsHandlerDisabledReturns501(t *testing.T) {
	p := New(Config{Version: "test", Pool: pool.New("")})
	rec := httptest.NewRecorder()
	p.ServeHTTP(rec, httptest.NewRequest("GET", "/panel/api/stats", nil))
	if rec.Code != 501 {
		t.Fatalf("status=%d want 501", rec.Code)
	}
	var body map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if body["error"] == nil {
		t.Errorf("501 应带 error 说明: %s", rec.Body.String())
	}
}

// 统计接口的字段与口径：区间汇总、24 点小时序列（today）、模型/账号排行带 share，
// 以及从 pool 取账号昵称作展示名。
func TestStatsHandlerReport(t *testing.T) {
	p, rec := newStatsPanel(t)
	p.cfg.Pool.Add(&auth.Auth{UID: "uid-alpha", Nickname: "阿尔法"})
	rec.Record(stats.Sample{UID: "uid-alpha", Model: "glm-5.2", LatencyMs: 1000, Delta: usageDelta(100, 200, 300)})
	rec.Record(stats.Sample{UID: "uid-alpha", Model: "glm-5.2", Failed: true})

	w := httptest.NewRecorder()
	p.ServeHTTP(w, httptest.NewRequest("GET", "/panel/api/stats?range=today", nil))
	if w.Code != 200 {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	var got struct {
		Range    string         `json:"range"`
		Unit     string         `json:"unit"`
		KeepDays int            `json:"keep_days"`
		Totals   map[string]any `json:"totals"`
		Series   []struct {
			Key         string `json:"key"`
			TotalTokens int64  `json:"total_tokens"`
			Requests    int64  `json:"requests"`
		} `json:"series"`
		ByModel   []struct{ Key, Label string; Share float64 } `json:"by_model"`
		ByAccount []struct{ Key, Label string; Share float64 } `json:"by_account"`
		PoolTotal map[string]any                                      `json:"pool_total"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("unmarshal: %v body=%s", err, w.Body.String())
	}
	if got.Range != "today" || got.Unit != "hour" {
		t.Errorf("range=%q unit=%q want today/hour", got.Range, got.Unit)
	}
	if got.KeepDays != 30 {
		t.Errorf("keep_days=%d want 30", got.KeepDays)
	}
	if len(got.Series) != 24 {
		t.Fatalf("series len=%d want 24（今日按小时）", len(got.Series))
	}
	if got.Totals["total_tokens"] != float64(300) || got.Totals["requests"] != float64(2) || got.Totals["failed"] != float64(1) {
		t.Errorf("totals=%v want tt=300 rq=2 fl=1", got.Totals)
	}
	if len(got.ByModel) != 1 || got.ByModel[0].Key != "glm-5.2" {
		t.Fatalf("by_model=%v", got.ByModel)
	}
	if got.ByModel[0].Share != 1 {
		t.Errorf("by_model share=%v want 1", got.ByModel[0].Share)
	}
	// 账号排行用池里的昵称作展示名（uid 对运维不可读）。
	if len(got.ByAccount) != 1 || got.ByAccount[0].Label != "阿尔法" {
		t.Errorf("by_account=%v want label=阿尔法", got.ByAccount)
	}
	// 本测试未给池灌累计量，pool_total 应全零而不是缺字段（前端直接读不会 NaN）。
	if got.PoolTotal["total_tokens"] != float64(0) {
		t.Errorf("pool_total=%v want 全零", got.PoolTotal)
	}
}

// 两个累计口径必须分开且形状固定：
//   - since_start 来自统计聚合器（自统计启用起，与时间序列同源）；
//   - pool_total 来自池内账号的长期累计（含统计功能上线之前的历史）。
//
// 这正是用户曾误读为"页面自相矛盾"的地方：只给池灌历史量时 pool_total 有数而
// since_start 为 0，这是正确行为，不是 bug——本测试把这条语义钉住。
func TestStatsHandlerTwoTotalsAreDistinct(t *testing.T) {
	p, rec := newStatsPanel(t)
	p.cfg.Pool.Add(&auth.Auth{UID: "u1", Nickname: "一号"})
	// 只给池灌历史（模拟统计功能上线之前的旧账）。
	p.cfg.Pool.RecordTokenUsage("u1", usageDelta(100, 10, 110))

	w := httptest.NewRecorder()
	p.ServeHTTP(w, httptest.NewRequest("GET", "/panel/api/stats?range=7d", nil))
	var got struct {
		SinceStart struct {
			Since          string `json:"since"`
			TotalTokens    int64  `json:"total_tokens"`
			Requests       int64  `json:"requests"`
			ActiveAccounts int    `json:"active_accounts"`
		} `json:"since_start"`
		PoolTotal struct {
			TotalTokens int64 `json:"total_tokens"`
		} `json:"pool_total"`
		Totals struct {
			TotalTokens int64 `json:"total_tokens"`
		} `json:"totals"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.PoolTotal.TotalTokens != 110 {
		t.Errorf("pool_total=%d want 110（历史旧账）", got.PoolTotal.TotalTokens)
	}
	if got.SinceStart.TotalTokens != 0 || got.SinceStart.Since != "" {
		t.Errorf("since_start=%+v want 全零（本进程还没有任何请求）", got.SinceStart)
	}
	if got.Totals.TotalTokens != 0 {
		t.Errorf("区间总量=%d want 0", got.Totals.TotalTokens)
	}

	// 有了一笔真实记录后：since_start 与区间（range=all）同源，数值必须一致。
	// 生产路径里 handler 的 recordAttempt 是**同时**写这两处（池的长期累计 + 统计
	// 聚合器），这里照做，否则测的就不是线上形状。
	rec.Record(stats.Sample{UID: "u1", Model: "m1", LatencyMs: 100, Delta: usageDelta(7, 3, 10)})
	p.cfg.Pool.RecordTokenUsage("u1", usageDelta(7, 3, 10))
	w2 := httptest.NewRecorder()
	p.ServeHTTP(w2, httptest.NewRequest("GET", "/panel/api/stats?range=all", nil))
	var got2 struct {
		SinceStart struct {
			Since       string `json:"since"`
			TotalTokens int64  `json:"total_tokens"`
			Requests    int64  `json:"requests"`
		} `json:"since_start"`
		Totals struct {
			TotalTokens int64 `json:"total_tokens"`
		} `json:"totals"`
		PoolTotal struct {
			TotalTokens int64 `json:"total_tokens"`
		} `json:"pool_total"`
	}
	if err := json.Unmarshal(w2.Body.Bytes(), &got2); err != nil {
		t.Fatal(err)
	}
	if got2.SinceStart.TotalTokens != 10 || got2.SinceStart.Requests != 1 {
		t.Errorf("since_start=%+v want tt=10 rq=1", got2.SinceStart)
	}
	if got2.SinceStart.Since == "" {
		t.Error("since_start.since 应给出起始自然日")
	}
	if got2.SinceStart.TotalTokens != got2.Totals.TotalTokens {
		t.Errorf("since_start(%d) 与 all 区间(%d) 同源，应一致",
			got2.SinceStart.TotalTokens, got2.Totals.TotalTokens)
	}
	if got2.PoolTotal.TotalTokens != 120 {
		t.Errorf("pool_total=%d want 120（110 旧账 + 10 新账）", got2.PoolTotal.TotalTokens)
	}
}

// 非法 range 回落 7d（前端传参不合法只退回默认视图，不该 400 掉整页）。
func TestStatsHandlerRangeFallback(t *testing.T) {
	p, _ := newStatsPanel(t)
	w := httptest.NewRecorder()
	p.ServeHTTP(w, httptest.NewRequest("GET", "/panel/api/stats?range=bogus", nil))
	if w.Code != 200 {
		t.Fatalf("status=%d", w.Code)
	}
	var got struct {
		Range  string `json:"range"`
		Unit   string `json:"unit"`
		Series []any  `json:"series"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Range != "7d" || got.Unit != "day" || len(got.Series) != 7 {
		t.Errorf("range=%q unit=%q len=%d want 7d/day/7", got.Range, got.Unit, len(got.Series))
	}
}

// 账号被移除后其历史仍留在统计里（by_account 的 Label 为空 → 前端回落显示 uid）：
// 统计是发生过的事实，不该因为账号退池而凭空消失。
func TestStatsHandlerKeepsRemovedAccountHistory(t *testing.T) {
	p, rec := newStatsPanel(t)
	rec.Record(stats.Sample{UID: "uid-gone", Model: "glm-5.2", LatencyMs: 10, Delta: usageDelta(1, 1, 2)})

	w := httptest.NewRecorder()
	p.ServeHTTP(w, httptest.NewRequest("GET", "/panel/api/stats?range=all", nil))
	var got struct {
		ByAccount []struct{ Key, Label string } `json:"by_account"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if len(got.ByAccount) != 1 || got.ByAccount[0].Key != "uid-gone" || got.ByAccount[0].Label != "" {
		t.Errorf("by_account=%v want 保留 uid-gone 且 Label 为空", got.ByAccount)
	}
}

// pool_total 汇总池内各账号的长期累计（口径与区间报表分开），并统计有请求记录的账号数。
func TestStatsHandlerPoolTotal(t *testing.T) {
	p, _ := newStatsPanel(t)
	p.cfg.Pool.Add(&auth.Auth{UID: "u1", Nickname: "一号"})
	p.cfg.Pool.Add(&auth.Auth{UID: "u2", Nickname: "二号"})
	p.cfg.Pool.Add(&auth.Auth{UID: "u3", Nickname: "空号"}) // 从未跑过请求
	p.cfg.Pool.RecordTokenUsage("u1", usageDelta(100, 200, 300))
	p.cfg.Pool.RecordTokenUsage("u2", usageDelta(10, 20, 30))

	w := httptest.NewRecorder()
	p.ServeHTTP(w, httptest.NewRequest("GET", "/panel/api/stats?range=7d", nil))
	var got struct {
		PoolTotal struct {
			TotalTokens    int64 `json:"total_tokens"`
			Requests       int64 `json:"requests"`
			ActiveAccounts int   `json:"active_accounts"`
		} `json:"pool_total"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.PoolTotal.TotalTokens != 330 || got.PoolTotal.Requests != 2 {
		t.Errorf("pool_total=%+v want tt=330 rq=2", got.PoolTotal)
	}
	if got.PoolTotal.ActiveAccounts != 2 {
		t.Errorf("active_accounts=%d want 2（空号不计）", got.PoolTotal.ActiveAccounts)
	}
}

// 统计接口也走鉴权（与 /panel/api/* 同口径），且带安全响应头。
func TestStatsHandlerNeedsAuth(t *testing.T) {
	p := New(Config{Version: "test", Pool: pool.New(""), Stats: stats.New("", 30), APIKey: "k"})
	w := httptest.NewRecorder()
	p.ServeHTTP(w, httptest.NewRequest("GET", "/panel/api/stats", nil))
	if w.Code != 401 {
		t.Errorf("status=%d want 401", w.Code)
	}
	if w.Header().Get("Content-Security-Policy") == "" {
		t.Error("缺 CSP 响应头")
	}
}

// 端点返回的是 CST 自然日的键，格式固定 2006-01-02（前端按字符串直接展示）。
func TestStatsSeriesKeyFormat(t *testing.T) {
	p, _ := newStatsPanel(t)
	w := httptest.NewRecorder()
	p.ServeHTTP(w, httptest.NewRequest("GET", "/panel/api/stats?range=30d", nil))
	var got struct {
		Series []struct {
			Key string `json:"key"`
		} `json:"series"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	today := time.Now().In(time.FixedZone("CST", 8*60*60)).Format("2006-01-02")
	if len(got.Series) != 30 || got.Series[29].Key != today {
		t.Errorf("series 末项=%v want %s", got.Series[29].Key, today)
	}
	for _, s := range got.Series {
		if _, err := time.ParseInLocation("2006-01-02", s.Key, time.FixedZone("CST", 8*60*60)); err != nil {
			t.Errorf("key %q 不是 YYYY-MM-DD: %v", s.Key, err)
		}
	}
}
