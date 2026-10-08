// Package stats 用量统计：把每次聊天尝试按「自然日 × 模型 × 账号 × 小时」聚合 token
// 用量，供面板统计页读取。
//
// 与 pool 的账号级累计互补：pool.TokenUsage 回答"这个号到现在总共烧了多少"（单调
// 累计、没有时间维度、只记得最近一次用的模型），本包回答"哪一天、哪个模型、哪个号
// 烧了多少"。两者数据源同一处（server 的 recordAttempt），互不覆盖。
//
// 设计约束：
//   - 只留聚合桶，不记逐请求明细：内存与文件体积随 (保留天数 × 模型数) 有界，不会像
//     请求日志那样无界增长；因此可以安全地常驻内存并周期性落盘。
//   - 独立落盘文件（默认与本包同目录的 stats.json），不改 pool 的 state.json 结构——
//     统计是观测数据，出问题也不该牵连账号状态的可恢复性。
//   - 进程内聚合，不参与 Redis 镜像：多实例共用一个 Redis 时各实例只统计自己转发的
//     请求（当前部署形态为单实例；若将来要多实例准确，需改成 Redis INCRBY 累加）。
package stats

import (
	"sort"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/linguo2625469/workbuddy2api-panel/internal/pool"
)

// dayZone 归日时区：上游每日额度按自然日 00:00 CST 重置，统计口径与之对齐
// （中国无夏令时，固定 +8 即可，免 LoadLocation 依赖 tzdata；同一口径见
// scheduler.travelDay 与 server.nextMidnightCST）。
var dayZone = time.FixedZone("CST", 8*60*60)

// defaultKeepDays 默认保留窗口。30 天足够看月度趋势，且 (30 天 × 模型数 + 24 小时)
// 的桶体量在 JSON 里只有几十 KB。
const defaultKeepDays = 30

// Bucket 一个聚合桶。全部字段可加，合并即逐项求和。
// omitempty 让空桶在落盘文件里只占一对花括号，长时间无请求的日子不会撑大文件。
type Bucket struct {
	PromptTokens     int64 `json:"prompt_tokens,omitempty"`
	CompletionTokens int64 `json:"completion_tokens,omitempty"`
	TotalTokens      int64 `json:"total_tokens,omitempty"`
	// Requests 尝试次数（含失败）。与 pool.TokenUsage.RequestCount 同口径：
	// 失败尝试也计入，否则"成功率/失败量"这类指标没有分母。
	Requests int64 `json:"requests,omitempty"`
	// UsageCount 带回上游 usage 的次数。与 Requests 的差额 = 上游没给 usage 的
	// 成功请求（或失败请求），据此才能算出诚实的"平均每请求 token"。
	UsageCount   int64 `json:"usage_count,omitempty"`
	Failed       int64 `json:"failed,omitempty"`
	LatencyMsSum int64 `json:"latency_ms_sum,omitempty"`
	LatencyCount int64 `json:"latency_count,omitempty"`
}

// Merge 把 o 累加进 b。
func (b *Bucket) Merge(o Bucket) {
	b.PromptTokens += o.PromptTokens
	b.CompletionTokens += o.CompletionTokens
	b.TotalTokens += o.TotalTokens
	b.Requests += o.Requests
	b.UsageCount += o.UsageCount
	b.Failed += o.Failed
	b.LatencyMsSum += o.LatencyMsSum
	b.LatencyCount += o.LatencyCount
}

// dayStat 单个自然日的聚合：三个切面（模型/账号/小时）各一张桶表 + 当日总计。
// 三个切面互为独立维度，各自求和都等于 Total（记录时四者同步累加，不重不漏）。
type dayStat struct {
	ByModel map[string]*Bucket `json:"by_model,omitempty"`
	ByUID   map[string]*Bucket `json:"by_uid,omitempty"`
	// ByHour 当日 24 个小时桶（键 "00".."23"）。今日视图按小时出图，
	// 才能看出"这一天是什么时候烧的"——按天只有一个柱子，没有信息量。
	ByHour map[string]*Bucket `json:"by_hour,omitempty"`
	Total  Bucket              `json:"total"`
}

// Sample 一次聊天尝试的统计样本。
type Sample struct {
	UID   string
	Model string
	// Failed 该次尝试是否失败（传输错误 / 上游非 2xx / 流解析失败）。
	// 失败样本只计 Requests+Failed，不计 token 与延迟。
	Failed    bool
	LatencyMs int64
	Delta     pool.TokenUsageDelta
}

// usageKnown 报告上游是否确实返回了 usage。三个 Has* 是"字段存在"而非"值非零"，
// 因此全 0 的 usage 也算已知（与 pool.RecordTokenUsage 的 known 判据同源）。
func usageKnown(d pool.TokenUsageDelta) bool {
	return d.HasPromptTokens || d.HasCompletionTokens || d.HasTotalTokens
}

// Recorder 内存聚合器 + 落盘。零值不可用，须经 New 构造。
type Recorder struct {
	mu   sync.Mutex
	days map[string]*dayStat
	now  func() time.Time // 取时注入，单测固定时钟用（生产恒 time.Now）

	// life/uids/since 是"自开始统计以来"的总账，**不参与保留窗口淘汰**：
	// 按天的 days 只留最近 keepDays 天，窗口一滚头条数字就会往回缩；头条要的是
	// 单调不减的累计，故单独记一份。与 pool 的账号级累计的区别：这份从本文件
	// 建立那一刻起算，口径与时间序列同源（都来自同一批 recordAt 样本）。
	life  Bucket
	uids  map[string]struct{}
	since string

	fp       string
	keepDays int

	dirty    atomic.Bool
	stopCh   chan struct{}
	stopOnce sync.Once
	failN    int64
}

// New 构建聚合器并载入已有统计文件（不存在/损坏都当空白起步，统计不该阻塞启动）。
// fp 为空 = 纯内存（不落盘，测试与裸用场景）；keepDays <= 0 回落默认 30 天。
func New(fp string, keepDays int) *Recorder {
	if keepDays <= 0 {
		keepDays = defaultKeepDays
	}
	r := &Recorder{
		days:     map[string]*dayStat{},
		uids:     map[string]struct{}{},
		fp:       fp,
		keepDays: keepDays,
		stopCh:   make(chan struct{}),
		now:      time.Now,
	}
	r.load()
	r.pruneLocked(r.now())
	if fp != "" {
		r.startFlusher()
	}
	return r
}

// Record 记录一次聊天尝试（并发安全）。
func (r *Recorder) Record(s Sample) { r.recordAt(s, r.now()) }

// Len 返回当前保留的日数（观测/测试用）。
func (r *Recorder) Len() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.days)
}

// KeepDays 返回保留窗口天数（面板据此说明"统计保留最近 N 天"，不猜）。
func (r *Recorder) KeepDays() int { return r.keepDays }

// recordAt 以 now 归日归时。拆出 now 参数便于单测跨日/跨小时。
func (r *Recorder) recordAt(s Sample, now time.Time) {
	dKey, hKey := dayKey(now), hourKey(now)

	// 桶内容：token 只累计明确存在的字段（缺字段与真值 0 必须区分开，否则"上游没给
	// usage"会被当成"这次真的 0 token"混进平均值）。
	var b Bucket
	b.Requests = 1
	if s.Failed {
		b.Failed = 1
	} else {
		if usageKnown(s.Delta) {
			b.UsageCount = 1
			if s.Delta.HasPromptTokens && s.Delta.PromptTokens >= 0 {
				b.PromptTokens = s.Delta.PromptTokens
			}
			if s.Delta.HasCompletionTokens && s.Delta.CompletionTokens >= 0 {
				b.CompletionTokens = s.Delta.CompletionTokens
			}
			if s.Delta.HasTotalTokens && s.Delta.TotalTokens >= 0 {
				b.TotalTokens = s.Delta.TotalTokens
			}
		}
		if s.LatencyMs > 0 {
			b.LatencyMsSum = s.LatencyMs
			b.LatencyCount = 1
		}
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	if r.since == "" {
		r.since = dKey
	}
	r.life.Merge(b)
	if s.UID != "" {
		r.uids[s.UID] = struct{}{}
	}
	// 跨日：新日子出现时顺手清理过期窗口（一天一次 O(保留天数)，无需独立定时器）。
	if _, ok := r.days[dKey]; !ok {
		r.pruneLocked(now)
	}
	d := r.days[dKey]
	if d == nil {
		d = &dayStat{}
		r.days[dKey] = d
	}
	d.Total.Merge(b)
	if s.Model != "" {
		if d.ByModel == nil {
			d.ByModel = map[string]*Bucket{}
		}
		bucketOf(d.ByModel, s.Model).Merge(b)
	}
	if s.UID != "" {
		if d.ByUID == nil {
			d.ByUID = map[string]*Bucket{}
		}
		bucketOf(d.ByUID, s.UID).Merge(b)
	}
	if d.ByHour == nil {
		d.ByHour = map[string]*Bucket{}
	}
	bucketOf(d.ByHour, hKey).Merge(b)
	r.dirty.Store(true)
}

// bucketOf 取（或懒建）表内同名桶。
func bucketOf(m map[string]*Bucket, key string) *Bucket {
	b := m[key]
	if b == nil {
		b = &Bucket{}
		m[key] = b
	}
	return b
}

// pruneLocked 淘汰保留窗口外的日子。调用方必须已持 r.mu。
func (r *Recorder) pruneLocked(now time.Time) {
	if r.keepDays <= 0 {
		return
	}
	cutoff := dayKey(now.AddDate(0, 0, -r.keepDays+1))
	for k := range r.days {
		// 日期键是零填充定长格式，字典序即时间序，直接比较即可。
		if k < cutoff {
			delete(r.days, k)
			r.dirty.Store(true)
		}
	}
}

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

// Range 统计区间口径（面板切换用）。
type Range string

const (
	RangeToday Range = "today" // 今日 00:00 CST 起
	Range7d    Range = "7d"    // 最近 7 个自然日（含今日）
	Range30d   Range = "30d"   // 最近 30 个自然日（含今日）
	RangeAll   Range = "all"   // 全部保留窗口内有数据的日子
)

// ParseRange 解析区间参数，非法值回落 7d（面板传参不合法时不报错，只退回默认视图）。
func ParseRange(s string) Range {
	switch Range(s) {
	case RangeToday, Range7d, Range30d, RangeAll:
		return Range(s)
	}
	return Range7d
}

// SeriesUnit 出图粒度：today 按小时看日内节律，其余按天看趋势。
const (
	UnitHour = "hour"
	UnitDay  = "day"
)

// Lifetime 自开始统计以来的总账（单调不减，不受保留窗口影响）。
// 字段带显式 json tag 且一律不加 omitempty：这是接口的固定形状，零值必须给 0
// 而不是缺键（同 Totals，理由见那里的注释）。
type Lifetime struct {
	// Since 首个被记录的自然日（页面据此说"自 X 日起累计"），尚无数据时为空。
	Since            string `json:"since"`
	PromptTokens     int64  `json:"prompt_tokens"`
	CompletionTokens int64  `json:"completion_tokens"`
	TotalTokens      int64  `json:"total_tokens"`
	Requests         int64  `json:"requests"`
	UsageCount       int64  `json:"usage_count"`
	Failed           int64  `json:"failed"`
	// ActiveAccounts 累计出现过的账号数（去重，含已退池的——总量里也含它们）。
	ActiveAccounts int `json:"active_accounts"`
}

// Lifetime 返回自开始统计以来的总账。与 Report 的区别：Report 受保留窗口限制，
// 本方法不受——窗口滚掉的老日子仍然计在这份总账里。
func (r *Recorder) Lifetime() Lifetime {
	r.mu.Lock()
	defer r.mu.Unlock()
	return Lifetime{
		Since:            r.since,
		PromptTokens:     r.life.PromptTokens,
		CompletionTokens: r.life.CompletionTokens,
		TotalTokens:      r.life.TotalTokens,
		Requests:         r.life.Requests,
		UsageCount:       r.life.UsageCount,
		Failed:           r.life.Failed,
		ActiveAccounts:   len(r.uids),
	}
}

// Point 系列上的一个点（键 + 该点计数）。零请求的点也会出现，
// 让图上"没有流量的那几天"显示为真实的空档，而不是被压缩掉。
type Point struct {
	Key string `json:"key"`
	Bucket
}

// Ranked 排行项（模型/账号）。
type Ranked struct {
	Key string `json:"key"`
	// Label 展示名（账号填昵称，取不到时回落 Key），由调用方填充。
	Label string `json:"label,omitempty"`
	Bucket
	Share float64 `json:"share"` // 占总量的比例 0..1（按 TotalTokens；全为 0 时按 Requests）
}

// Totals 区间汇总。字段刻意不复用 Bucket、也不带 omitempty：这是接口的固定形状，
// 空区间必须给出 0 而不是缺键——缺键会让消费方把"确实是 0"和"字段不存在"混为一谈。
// （桶结构那边的 omitempty 是落盘体积所必需的：30 天 × 24 个小时桶若都带满字段，
// 文件会被零值撑大一个量级。）
type Totals struct {
	PromptTokens     int64 `json:"prompt_tokens"`
	CompletionTokens int64 `json:"completion_tokens"`
	TotalTokens      int64 `json:"total_tokens"`
	Requests         int64 `json:"requests"`
	UsageCount       int64 `json:"usage_count"`
	Failed           int64 `json:"failed"`
	LatencyMsSum     int64 `json:"latency_ms_sum"`
	LatencyCount     int64 `json:"latency_count"`
	// AvgLatencyMs 平均单次耗时（流式为整段流时长，非 TTFB）。
	AvgLatencyMs int64 `json:"avg_latency_ms"`
	// AvgTokensPerSec 区间聚合吞吐 = 生成 token / 累计耗时，比"逐请求速率再平均"
	// 更贴近真实（长请求加权更重）。
	AvgTokensPerSec float64 `json:"avg_tokens_per_sec"`
	// AvgTokensPerRequest 平均每次带回 usage 的请求的 token 量（分母是 UsageCount
	// 而非 Requests：拿不到 usage 的请求 token 记为 0，混进分母会把均值拉低）。
	AvgTokensPerRequest int64 `json:"avg_tokens_per_request"`
	// SuccessRate 成功率 = (Requests-Failed)/Requests，无请求时为 0。
	SuccessRate float64 `json:"success_rate"`
}

// Report 一个区间的完整统计。
type Report struct {
	Range string `json:"range"`
	Unit  string `json:"unit"` // Series 的粒度：hour / day
	// Days 区间覆盖的自然日数（today 为 1），Covered 其中真有数据的天数。
	// 保留窗口外的日子无从得知，故不接受"区间内一定是满的"这种假设。
	Days    int `json:"days"`
	Covered int `json:"covered_days"`
	// FirstDay/LastDay 统计文件里最早的/最新的有数据的日子（"统计自 X 起"用）。
	FirstDay string `json:"first_day,omitempty"`
	LastDay  string `json:"last_day,omitempty"`

	Totals    Totals   `json:"totals"`
	Series    []Point  `json:"series"`
	ByModel   []Ranked `json:"by_model"`
	ByAccount []Ranked `json:"by_account"`
}

// Report 汇总指定区间。now 决定"今天"是哪天（调用方传 time.Now，单测传固定值）。
func (r *Recorder) Report(rng Range, now time.Time) Report {
	today := now.In(dayZone)
	r.mu.Lock()
	defer r.mu.Unlock()

	// 三个切片显式初始化为空而非 nil：JSON 里输出 [] 而不是 null，
	// 前端拿到就能直接遍历，不必每处判空。
	rep := Report{Range: string(rng), Unit: UnitDay, Series: []Point{}, ByModel: []Ranked{}, ByAccount: []Ranked{}}
	days := r.rangeDaysLocked(rng, today)
	rep.Days = len(days)
	rep.FirstDay, rep.LastDay = r.spanLocked()

	models := map[string]*Bucket{}
	accounts := map[string]*Bucket{}
	var acc Bucket
	for _, key := range days {
		d := r.days[key]
		if d == nil {
			rep.Series = append(rep.Series, Point{Key: key})
			continue
		}
		rep.Covered++
		acc.Merge(d.Total)
		rep.Series = append(rep.Series, Point{Key: key, Bucket: d.Total})
		for m, b := range d.ByModel {
			bucketOf(models, m).Merge(*b)
		}
		for u, b := range d.ByUID {
			bucketOf(accounts, u).Merge(*b)
		}
	}

	if rng == RangeToday {
		// 今日视图按小时出图：24 根柱子看日内节律（按天只有一根，没有信息量）。
		rep.Unit = UnitHour
		rep.Series = r.hourlySeriesLocked(days)
	}
	rep.Totals = finalizeTotals(acc)
	// 排行的占比分母用 TotalTokens，全零（例如只统计到失败请求）时退回请求次数，
	// 否则整页占比条全空。
	base, byRequests := rep.Totals.TotalTokens, false
	if base <= 0 {
		base, byRequests = rep.Totals.Requests, true
	}
	rep.ByModel = rank(models, base, byRequests)
	rep.ByAccount = rank(accounts, base, byRequests)
	return rep
}

// rangeDaysLocked 返回区间内的自然日键（升序）。today/7d/30d 按"含今日往前数"生成，
// 不留空档；all 用文件里实际存在的日子（无数据的日子不凭空造列）。
func (r *Recorder) rangeDaysLocked(rng Range, today time.Time) []string {
	if rng == RangeAll {
		out := make([]string, 0, len(r.days))
		for k := range r.days {
			out = append(out, k)
		}
		sort.Strings(out)
		return out
	}
	n := 1
	switch rng {
	case Range7d:
		n = 7
	case Range30d:
		n = 30
	}
	out := make([]string, 0, n)
	for i := n - 1; i >= 0; i-- {
		out = append(out, dayKey(today.AddDate(0, 0, -i)))
	}
	return out
}

// hourlySeriesLocked 今日 24 小时序列（键 "00".."23"，全部 24 个点恒定输出）。
func (r *Recorder) hourlySeriesLocked(days []string) []Point {
	out := make([]Point, 0, 24)
	var src *dayStat
	if len(days) == 1 {
		src = r.days[days[0]]
	}
	for h := 0; h < 24; h++ {
		key := strconv.Itoa(h)
		if h < 10 {
			key = "0" + key
		}
		p := Point{Key: key}
		if src != nil && src.ByHour != nil {
			if b := src.ByHour[key]; b != nil {
				p.Bucket = *b
			}
		}
		out = append(out, p)
	}
	return out
}

// hourKey 返回 t 在 CST 视角下的小时键（"00".."23"）。记录与出图共用，
// 避免两侧各写一份填充逻辑后格式漂移（"9" 与 "09" 会被当成两个桶）。
func hourKey(t time.Time) string { return t.In(dayZone).Format("15") }

// dayKey 返回 t 在 CST 视角下的自然日键（"2006-01-02"）。
func dayKey(t time.Time) string { return t.In(dayZone).Format("2006-01-02") }

// spanLocked 返回统计文件里有数据的最早/最晚日子。
func (r *Recorder) spanLocked() (string, string) {
	first, last := "", ""
	for k := range r.days {
		if first == "" || k < first {
			first = k
		}
		if last == "" || k > last {
			last = k
		}
	}
	return first, last
}

// finalizeTotals 把累计桶转成对外的汇总形状（含派生量）。
func finalizeTotals(b Bucket) Totals {
	t := Totals{
		PromptTokens:     b.PromptTokens,
		CompletionTokens: b.CompletionTokens,
		TotalTokens:      b.TotalTokens,
		Requests:         b.Requests,
		UsageCount:       b.UsageCount,
		Failed:           b.Failed,
		LatencyMsSum:     b.LatencyMsSum,
		LatencyCount:     b.LatencyCount,
	}
	if t.LatencyCount > 0 {
		t.AvgLatencyMs = t.LatencyMsSum / t.LatencyCount
		if t.LatencyMsSum > 0 {
			t.AvgTokensPerSec = float64(t.CompletionTokens) * 1000 / float64(t.LatencyMsSum)
		}
	}
	if t.UsageCount > 0 {
		t.AvgTokensPerRequest = t.TotalTokens / t.UsageCount
	}
	if t.Requests > 0 {
		t.SuccessRate = float64(t.Requests-t.Failed) / float64(t.Requests)
	}
	return t
}

// rank 把桶表转成按 TotalTokens 降序（并列时按 Requests、再按 Key 稳定排序）的排行。
// byRequests 表示 base 用的是请求次数（总量全零时退化），否则用 token 总量。
func rank(m map[string]*Bucket, base int64, byRequests bool) []Ranked {
	out := make([]Ranked, 0, len(m))
	for k, b := range m {
		share := 0.0
		if base > 0 {
			if byRequests {
				share = float64(b.Requests) / float64(base)
			} else {
				share = float64(b.TotalTokens) / float64(base)
			}
		}
		out = append(out, Ranked{Key: k, Bucket: *b, Share: share})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].TotalTokens != out[j].TotalTokens {
			return out[i].TotalTokens > out[j].TotalTokens
		}
		if out[i].Requests != out[j].Requests {
			return out[i].Requests > out[j].Requests
		}
		return out[i].Key < out[j].Key
	})
	return out
}
