package stats

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/linguo2625469/workbuddy2api-panel/internal/pool"
)

// at 构造 CST 视角的固定时刻（统计全部按 CST 归日归时）。
func at(s string) time.Time {
	t, err := time.ParseInLocation("2006-01-02 15:04", s, dayZone)
	if err != nil {
		panic(err)
	}
	return t
}

// okDelta 构造一次带完整 usage 的成功样本。
func okDelta(prompt, completion, total int64) pool.TokenUsageDelta {
	return pool.TokenUsageDelta{
		HasPromptTokens:     true,
		PromptTokens:        prompt,
		HasCompletionTokens: true,
		CompletionTokens:    completion,
		HasTotalTokens:      true,
		TotalTokens:         total,
	}
}

// zeroUsageDelta 上游回了 usage 但全为 0（字段存在、值为 0），与"没回 usage"必须区分。
func zeroUsageDelta() pool.TokenUsageDelta {
	return pool.TokenUsageDelta{HasPromptTokens: true, HasCompletionTokens: true, HasTotalTokens: true}
}

func sumTokens(rs []Ranked) int64 {
	var n int64
	for _, r := range rs {
		n += r.TotalTokens
	}
	return n
}

// 三个切面（模型/账号/小时）各自求和都必须等于当日总计：记录时四者同步累加，
// 任何一处漏加都会让面板的排行与汇总对不上账。
func TestRecordKeepsDimensionsConsistent(t *testing.T) {
	r := New("", 30)
	defer r.Close()
	r.recordAt(Sample{UID: "u1", Model: "m1", LatencyMs: 100, Delta: okDelta(10, 5, 15)}, at("2026-09-21 15:00"))
	r.recordAt(Sample{UID: "u1", Model: "m1", LatencyMs: 300, Delta: okDelta(20, 10, 30)}, at("2026-09-21 15:30"))
	r.recordAt(Sample{UID: "u2", Model: "m2", Failed: true}, at("2026-09-21 16:00"))

	rep := r.Report(RangeToday, at("2026-09-21 18:00"))
	if rep.Totals.TotalTokens != 45 {
		t.Errorf("total tokens=%d want 45", rep.Totals.TotalTokens)
	}
	if rep.Totals.Requests != 3 || rep.Totals.Failed != 1 {
		t.Errorf("requests=%d failed=%d want 3/1", rep.Totals.Requests, rep.Totals.Failed)
	}
	if got := sumTokens(rep.ByModel); got != 45 {
		t.Errorf("by_model sum=%d want 45", got)
	}
	if got := sumTokens(rep.ByAccount); got != 45 {
		t.Errorf("by_account sum=%d want 45", got)
	}
	var seriesSum int64
	for _, p := range rep.Series {
		seriesSum += p.TotalTokens
	}
	if seriesSum != 45 {
		t.Errorf("series sum=%d want 45", seriesSum)
	}
}

// 今日视图出小时序列：24 个点恒定输出，空小时为 0（图上要看到真实的空档）。
func TestTodaySeriesIsHourly(t *testing.T) {
	r := New("", 30)
	defer r.Close()
	r.recordAt(Sample{UID: "u1", Model: "m1", Delta: okDelta(10, 5, 15)}, at("2026-09-21 15:00"))
	r.recordAt(Sample{UID: "u1", Model: "m1", Delta: okDelta(20, 10, 30)}, at("2026-09-21 15:40"))
	r.recordAt(Sample{UID: "u2", Model: "m2", Failed: true}, at("2026-09-21 16:10"))
	r.recordAt(Sample{UID: "u2", Model: "m2", Delta: okDelta(1, 1, 2)}, at("2026-09-20 23:00")) // 昨日，不计入今日

	rep := r.Report(RangeToday, at("2026-09-21 18:00"))
	if rep.Unit != UnitHour {
		t.Errorf("unit=%q want %q", rep.Unit, UnitHour)
	}
	if len(rep.Series) != 24 {
		t.Fatalf("series len=%d want 24", len(rep.Series))
	}
	if rep.Series[0].Key != "00" || rep.Series[23].Key != "23" {
		t.Errorf("hour keys: %q..%q want 00..23", rep.Series[0].Key, rep.Series[23].Key)
	}
	if got := rep.Series[15].TotalTokens; got != 45 {
		t.Errorf("15h tokens=%d want 45", got)
	}
	if got := rep.Series[16].Requests; got != 1 {
		t.Errorf("16h requests=%d want 1", got)
	}
	if rep.Series[0].Requests != 0 || rep.Series[17].Requests != 0 {
		t.Error("空小时应保持 0")
	}
	if rep.Totals.TotalTokens != 45 {
		t.Errorf("今日总量=%d want 45（昨日那笔不得混入）", rep.Totals.TotalTokens)
	}
}

// 7d/30d 按"含今日往前数"补零：图上没有数据的日子要占位，趋势才不会被压扁。
func TestRangeFillsEmptyDays(t *testing.T) {
	r := New("", 30)
	defer r.Close()
	r.recordAt(Sample{UID: "u1", Model: "m1", Delta: okDelta(10, 5, 15)}, at("2026-09-21 10:00"))

	rep := r.Report(Range7d, at("2026-09-21 18:00"))
	if rep.Days != 7 || len(rep.Series) != 7 {
		t.Fatalf("days=%d len=%d want 7/7", rep.Days, len(rep.Series))
	}
	if rep.Series[0].Key != "2026-09-15" || rep.Series[6].Key != "2026-09-21" {
		t.Errorf("window %s..%s want 2026-09-15..2026-09-21", rep.Series[0].Key, rep.Series[6].Key)
	}
	if rep.Covered != 1 {
		t.Errorf("covered=%d want 1（只有今天有数据）", rep.Covered)
	}
	if rep.Totals.TotalTokens != 15 {
		t.Errorf("tokens=%d want 15", rep.Totals.TotalTokens)
	}
	if rep.Unit != UnitDay {
		t.Errorf("unit=%q want %q", rep.Unit, UnitDay)
	}

	all := r.Report(RangeAll, at("2026-09-21 18:00"))
	if all.Days != 1 || len(all.Series) != 1 {
		t.Errorf("all: days=%d len=%d want 1/1（不凭空造空列）", all.Days, len(all.Series))
	}
}

// 失败样本只计 Requests 与 Failed：token 与延迟都不该被"失败的 0"污染。
func TestFailedSampleCountsRequestOnly(t *testing.T) {
	r := New("", 30)
	defer r.Close()
	r.recordAt(Sample{UID: "u1", Model: "m1", Failed: true, LatencyMs: 5000}, at("2026-09-21 10:00"))

	rep := r.Report(RangeToday, at("2026-09-21 11:00"))
	if rep.Totals.Requests != 1 || rep.Totals.Failed != 1 {
		t.Errorf("requests=%d failed=%d want 1/1", rep.Totals.Requests, rep.Totals.Failed)
	}
	if rep.Totals.TotalTokens != 0 || rep.Totals.UsageCount != 0 {
		t.Errorf("失败不该产生 token/usage 计数: tt=%d uc=%d", rep.Totals.TotalTokens, rep.Totals.UsageCount)
	}
	if rep.Totals.LatencyCount != 0 || rep.Totals.AvgLatencyMs != 0 {
		t.Errorf("失败不该进延迟均值: n=%d avg=%d", rep.Totals.LatencyCount, rep.Totals.AvgLatencyMs)
	}
	if rep.Totals.SuccessRate != 0 {
		t.Errorf("success rate=%v want 0", rep.Totals.SuccessRate)
	}
}

// 上游回全 0 的 usage 算"已知"（字段存在），否则"没回 usage"与"真的 0 token"混为一谈，
// 平均每请求 token 会被拉低。
func TestZeroUsageCountsAsKnown(t *testing.T) {
	r := New("", 30)
	defer r.Close()
	r.recordAt(Sample{UID: "u1", Model: "m1", Delta: zeroUsageDelta()}, at("2026-09-21 10:00"))
	r.recordAt(Sample{UID: "u1", Model: "m1", Delta: pool.TokenUsageDelta{}}, at("2026-09-21 10:05"))

	rep := r.Report(RangeToday, at("2026-09-21 11:00"))
	if rep.Totals.UsageCount != 1 {
		t.Errorf("usage_count=%d want 1（只有第一笔带回 usage）", rep.Totals.UsageCount)
	}
	if rep.Totals.Requests != 2 {
		t.Errorf("requests=%d want 2", rep.Totals.Requests)
	}
}

// 派生量口径：平均耗时按带回延迟的次数算，吞吐用"生成 token / 累计耗时"聚合，
// 平均每请求 token 的分母是 UsageCount（不是 Requests）。
func TestDerivedTotals(t *testing.T) {
	r := New("", 30)
	defer r.Close()
	r.recordAt(Sample{UID: "u1", Model: "m1", LatencyMs: 1000, Delta: okDelta(100, 200, 300)}, at("2026-09-21 10:00"))
	r.recordAt(Sample{UID: "u1", Model: "m1", LatencyMs: 3000, Delta: okDelta(100, 600, 700)}, at("2026-09-21 10:05"))
	r.recordAt(Sample{UID: "u1", Model: "m1", Delta: pool.TokenUsageDelta{}}, at("2026-09-21 10:10"))

	rep := r.Report(RangeToday, at("2026-09-21 11:00"))
	if rep.Totals.CompletionTokens != 800 {
		t.Errorf("completion=%d want 800", rep.Totals.CompletionTokens)
	}
	if rep.Totals.AvgLatencyMs != 2000 {
		t.Errorf("avg latency=%d want 2000", rep.Totals.AvgLatencyMs)
	}
	// 800 token / 4000ms = 200 tok/s
	if got := rep.Totals.AvgTokensPerSec; got < 199.9 || got > 200.1 {
		t.Errorf("avg tps=%v want 200", got)
	}
	// 1000 token / 2 笔带回 usage 的请求 = 500（第 3 笔没 usage，不计入分母）
	if rep.Totals.AvgTokensPerRequest != 500 {
		t.Errorf("avg per request=%d want 500", rep.Totals.AvgTokensPerRequest)
	}
	if got := rep.Totals.SuccessRate; got < 0.999 {
		t.Errorf("success rate=%v want 1", got)
	}
}

// 保留窗口外的日子被淘汰（一天一次的机会式清理）。
func TestPruneDropsOutsideWindow(t *testing.T) {
	r := New("", 3) // 保留 3 天
	defer r.Close()
	r.recordAt(Sample{UID: "u1", Model: "m1", Delta: okDelta(10, 5, 15)}, at("2026-09-18 10:00"))
	r.recordAt(Sample{UID: "u1", Model: "m1", Delta: okDelta(10, 5, 15)}, at("2026-09-19 10:00"))
	if r.Len() != 2 {
		t.Fatalf("len=%d want 2", r.Len())
	}
	// 出现新日子 → 触发清理：窗口为 09-19..09-21，09-18 出局。
	r.recordAt(Sample{UID: "u1", Model: "m1", Delta: okDelta(10, 5, 15)}, at("2026-09-21 10:00"))
	if r.Len() != 2 {
		t.Fatalf("len=%d want 2（09-18 应被淘汰）", r.Len())
	}
	rep := r.Report(RangeAll, at("2026-09-21 12:00"))
	if rep.FirstDay != "2026-09-19" {
		t.Errorf("first day=%s want 2026-09-19", rep.FirstDay)
	}
}

// 落盘→重载 往返一致，且累计量不因重启丢失。
func TestPersistenceRoundTrip(t *testing.T) {
	fp := filepath.Join(t.TempDir(), "stats.json")
	r := New(fp, 30)
	r.recordAt(Sample{UID: "u1", Model: "m1", LatencyMs: 1000, Delta: okDelta(100, 200, 300)}, at("2026-09-21 10:00"))
	r.recordAt(Sample{UID: "u2", Model: "m2", Failed: true}, at("2026-09-21 11:00"))
	r.Flush()
	r.Close()

	if _, err := os.Stat(fp); err != nil {
		t.Fatalf("落盘文件不存在: %v", err)
	}
	r2 := New(fp, 30)
	defer r2.Close()
	rep := r2.Report(RangeToday, at("2026-09-21 12:00"))
	if rep.Totals.TotalTokens != 300 || rep.Totals.Requests != 2 || rep.Totals.Failed != 1 {
		t.Errorf("重载后 tt=%d rq=%d fl=%d want 300/2/1", rep.Totals.TotalTokens, rep.Totals.Requests, rep.Totals.Failed)
	}
	if len(rep.ByAccount) != 2 || len(rep.ByModel) != 2 {
		t.Errorf("重载后切面丢失: accounts=%d models=%d", len(rep.ByAccount), len(rep.ByModel))
	}
	if rep.Series[10].TotalTokens != 300 {
		t.Errorf("重载后小时桶丢失: 10h=%d want 300", rep.Series[10].TotalTokens)
	}
}

// 损坏文件先备份再空白起步：统计是长期累积量，直接覆盖等于抹掉不可恢复的历史。
func TestCorruptFileIsBackedUp(t *testing.T) {
	dir := t.TempDir()
	fp := filepath.Join(dir, "stats.json")
	if err := os.WriteFile(fp, []byte("{ this is not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	r := New(fp, 30)
	r.recordAt(Sample{UID: "u1", Model: "m1", Delta: okDelta(10, 5, 15)}, at("2026-09-21 10:00"))
	r.Flush()
	defer r.Close()

	if _, err := os.Stat(fp + ".corrupt"); err != nil {
		t.Errorf("损坏文件未备份: %v", err)
	}
	// 空白起步后新数据照常落盘、可重载。
	r2 := New(fp, 30)
	defer r2.Close()
	if got := r2.Report(RangeAll, at("2026-09-21 12:00")).Totals.TotalTokens; got != 15 {
		t.Errorf("重新落盘后 tokens=%d want 15", got)
	}
}

// 空模型/空 uid 的样本不得在切面里造出空键（否则排行里出现一行无名条目）。
func TestEmptyKeysSkipped(t *testing.T) {
	r := New("", 30)
	defer r.Close()
	r.recordAt(Sample{Delta: okDelta(10, 5, 15)}, at("2026-09-21 10:00"))
	rep := r.Report(RangeToday, at("2026-09-21 11:00"))
	if len(rep.ByModel) != 0 || len(rep.ByAccount) != 0 {
		t.Errorf("空键应跳过: models=%d accounts=%d", len(rep.ByModel), len(rep.ByAccount))
	}
	if rep.Totals.TotalTokens != 15 {
		t.Errorf("总计仍应累加: %d", rep.Totals.TotalTokens)
	}
}

// 总量全零（只剩失败请求）时占比退回按请求次数算，否则整页占比条全空。
func TestShareFallsBackToRequests(t *testing.T) {
	r := New("", 30)
	defer r.Close()
	r.recordAt(Sample{UID: "u1", Model: "m1", Failed: true}, at("2026-09-21 10:00"))
	r.recordAt(Sample{UID: "u2", Model: "m2", Failed: true}, at("2026-09-21 10:30"))
	r.recordAt(Sample{UID: "u2", Model: "m2", Failed: true}, at("2026-09-21 10:40"))

	rep := r.Report(RangeToday, at("2026-09-21 11:00"))
	if len(rep.ByAccount) != 2 {
		t.Fatalf("accounts=%d want 2", len(rep.ByAccount))
	}
	if rep.ByAccount[0].Key != "u2" {
		t.Errorf("排行首项=%q want u2（请求次数多者在前）", rep.ByAccount[0].Key)
	}
	if got := rep.ByAccount[0].Share; got < 0.66 || got > 0.67 {
		t.Errorf("share=%v want ~0.667", got)
	}
}

// 排行按 token 总量降序，share 之和为 1。
func TestRankOrderAndShare(t *testing.T) {
	r := New("", 30)
	defer r.Close()
	r.recordAt(Sample{UID: "u1", Model: "small", Delta: okDelta(10, 10, 20)}, at("2026-09-21 10:00"))
	r.recordAt(Sample{UID: "u1", Model: "big", Delta: okDelta(100, 100, 200)}, at("2026-09-21 10:05"))

	rep := r.Report(RangeToday, at("2026-09-21 11:00"))
	if rep.ByModel[0].Key != "big" {
		t.Errorf("排行首项=%q want big", rep.ByModel[0].Key)
	}
	var share float64
	for _, m := range rep.ByModel {
		share += m.Share
	}
	if share < 0.999 || share > 1.001 {
		t.Errorf("share 之和=%v want 1", share)
	}
}

// 总账不随保留窗口缩水：这是它存在的全部理由。窗口滚掉老日子后，Lifetime 必须
// 仍包含那些日子（页面头条要单调不减，否则每天都会"往回缩"）。
func TestLifetimeSurvivesPrune(t *testing.T) {
	r := New("", 3) // 只留 3 天
	defer r.Close()
	r.recordAt(Sample{UID: "u1", Model: "m1", Delta: okDelta(100, 10, 110)}, at("2026-09-18 10:00"))
	if got := r.Lifetime(); got.TotalTokens != 110 || got.Since != "2026-09-18" {
		t.Fatalf("首笔后 lifetime=%+v want tt=110 since=2026-09-18", got)
	}
	// 09-21 出现新日子 → 触发清理，09-18 出局；但总账要留着那 110。
	r.recordAt(Sample{UID: "u1", Model: "m1", Delta: okDelta(200, 20, 220)}, at("2026-09-21 10:00"))
	if r.Len() != 1 {
		t.Fatalf("保留日数=%d want 1（09-18 应被淘汰）", r.Len())
	}
	rep := r.Report(RangeAll, at("2026-09-21 12:00"))
	if rep.Totals.TotalTokens != 220 {
		t.Errorf("区间总量=%d want 220（窗口内只剩 09-21）", rep.Totals.TotalTokens)
	}
	life := r.Lifetime()
	if life.TotalTokens != 330 {
		t.Errorf("总账=%d want 330（110+220，不得随窗口缩水）", life.TotalTokens)
	}
	if life.Since != "2026-09-18" {
		t.Errorf("起始日=%q want 2026-09-18（首个记录日不随窗口改变）", life.Since)
	}
}

// 总账与起始日要跟着落盘走：重启后头条不能从零重来。
func TestLifetimePersistence(t *testing.T) {
	fp := filepath.Join(t.TempDir(), "stats.json")
	r := New(fp, 3)
	r.recordAt(Sample{UID: "u1", Model: "m1", Delta: okDelta(100, 10, 110)}, at("2026-09-18 10:00"))
	r.recordAt(Sample{UID: "u2", Model: "m1", Delta: okDelta(200, 20, 220)}, at("2026-09-21 10:00"))
	r.Flush()
	r.Close()

	r2 := New(fp, 3)
	defer r2.Close()
	life := r2.Lifetime()
	if life.TotalTokens != 330 || life.Requests != 2 || life.Since != "2026-09-18" {
		t.Errorf("重载后 lifetime=%+v want tt=330 rq=2 since=2026-09-18", life)
	}
	if life.ActiveAccounts != 2 {
		t.Errorf("重载后活跃账号=%d want 2", life.ActiveAccounts)
	}
	// 重载后继续记账，总账接着涨（不是从 330 重来也不是从 0 重来）。
	r2.recordAt(Sample{UID: "u1", Model: "m1", Delta: okDelta(1, 1, 2)}, at("2026-09-21 11:00"))
	if got := r2.Lifetime().TotalTokens; got != 332 {
		t.Errorf("续记后总账=%d want 332", got)
	}
}

// 活跃账号去重计数：同一账号多笔只算一个；失败样本也计入（它确实"用过"这个号）。
func TestLifetimeActiveAccountsDedupe(t *testing.T) {
	r := New("", 30)
	defer r.Close()
	r.recordAt(Sample{UID: "u1", Model: "m1", Delta: okDelta(1, 1, 2)}, at("2026-09-21 10:00"))
	r.recordAt(Sample{UID: "u1", Model: "m2", Failed: true}, at("2026-09-21 10:01"))
	r.recordAt(Sample{UID: "u2", Model: "m1", Delta: okDelta(1, 1, 2)}, at("2026-09-21 10:02"))
	r.recordAt(Sample{Model: "m1", Delta: okDelta(1, 1, 2)}, at("2026-09-21 10:03")) // 无 uid
	if got := r.Lifetime().ActiveAccounts; got != 2 {
		t.Errorf("活跃账号=%d want 2（去重且忽略空 uid）", got)
	}
}

// 空总账的固定形状：零值也必须给全键（同 Totals）。
func TestLifetimeEmptyShape(t *testing.T) {
	r := New("", 30)
	defer r.Close()
	life := r.Lifetime()
	if life.Since != "" || life.ActiveAccounts != 0 || life.TotalTokens != 0 {
		t.Errorf("空总账=%+v", life)
	}
	raw, err := json.Marshal(life)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{
		"since", "prompt_tokens", "completion_tokens", "total_tokens",
		"requests", "usage_count", "failed", "active_accounts",
	} {
		if _, ok := m[k]; !ok {
			t.Errorf("空总账缺键 %q", k)
		}
	}
}

// ParseRange 非法值回落 7d（面板传参不合法只退回默认视图，不报错）。
func TestParseRange(t *testing.T) {
	cases := map[string]Range{
		"today": RangeToday, "7d": Range7d, "30d": Range30d, "all": RangeAll,
		"": Range7d, "bogus": Range7d, "TODAY": Range7d,
	}
	for in, want := range cases {
		if got := ParseRange(in); got != want {
			t.Errorf("ParseRange(%q)=%q want %q", in, got, want)
		}
	}
}

// 汇总对象是接口的固定形状：一个请求都没跑过的时候也必须给全零值而不是缺键
// （桶结构的 omitempty 只应作用于落盘文件与序列点，不该泄漏到 Totals 上）。
func TestEmptyReportHasAllTotalKeys(t *testing.T) {
	r := New("", 30)
	defer r.Close()
	rep := r.Report(RangeToday, at("2026-09-21 10:00"))
	raw, err := json.Marshal(rep.Totals)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{
		"prompt_tokens", "completion_tokens", "total_tokens", "requests", "usage_count",
		"failed", "latency_ms_sum", "latency_count",
		"avg_latency_ms", "avg_tokens_per_sec", "avg_tokens_per_request", "success_rate",
	} {
		if _, ok := m[k]; !ok {
			t.Errorf("空区间的 totals 缺键 %q（消费方会把零值误读成字段不存在）", k)
		}
	}
	if len(m) != 12 {
		t.Errorf("totals 键数=%d want 12（多出的键说明有字段忘了给 json tag）", len(m))
	}
	// 空区间的序列形状同样固定：今日恒为 24 个小时桶。
	if len(rep.Series) != 24 {
		t.Fatalf("series len=%d want 24", len(rep.Series))
	}
	if rep.Series[3].Key != "03" || rep.Series[3].TotalTokens != 0 {
		t.Errorf("series[3]=%+v want 零值桶且键为 03", rep.Series[3])
	}
	if rep.Totals.TotalTokens != 0 || rep.Totals.SuccessRate != 0 {
		t.Errorf("空区间汇总应全零: %+v", rep.Totals)
	}
}
