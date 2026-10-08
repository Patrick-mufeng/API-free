// stats.go 用量统计接口：区间汇总 + 时间序列 + 模型/账号排行。
//
// 三个口径并存，页面上必须分清（否则"累计"与"近 7 天"看着像同一件事）：
//   - 区间（today / 7d / 30d / all）：来自 stats.Recorder 的按天聚合，受保留窗口限制；
//   - since_start：同一台 Recorder 的单调总账，从统计启用那一刻起算、不受窗口淘汰。
//     与区间同源，所以页面上两者永远自洽（头条不会大于区间之和或反过来）；
//   - pool_total：pool 各账号的长期累计（state.json 的 token_usage），从账号第一次
//     请求起就在涨。它**早于**统计功能存在，只记总数、没有按日明细，因此无法回填到
//     时间轴上——页面把它降级为脚注，只作历史参照，不再当头条（曾因此让用户误以为
//     页面自相矛盾）。
package panel

import (
	"net/http"
	"time"

	"github.com/linguo2625469/workbuddy2api-panel/internal/pool"
	"github.com/linguo2625469/workbuddy2api-panel/internal/stats"
)

// statsHandler 返回指定区间的用量报表。
func (p *Panel) statsHandler(w http.ResponseWriter, r *http.Request) {
	if p.cfg.Stats == nil {
		writeErr(w, http.StatusNotImplemented, "用量统计未启用（config.json 中 stats.enabled=false）")
		return
	}
	rep := p.cfg.Stats.Report(stats.ParseRange(r.URL.Query().Get("range")), time.Now())

	// 账号排行补昵称：uid 对运维不可读，能用昵称就用昵称。
	labels := map[string]string{}
	total := poolTotal{}
	for _, s := range p.cfg.Pool.List() {
		if s.Nickname != "" {
			labels[s.UID] = s.Nickname
		}
		total.add(s.TokenUsage)
	}
	for i := range rep.ByAccount {
		rep.ByAccount[i].Label = labels[rep.ByAccount[i].Key]
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"range":        rep.Range,
		"unit":         rep.Unit,
		"days":         rep.Days,
		"covered_days": rep.Covered,
		"first_day":    rep.FirstDay,
		"last_day":     rep.LastDay,
		"keep_days":    p.cfg.Stats.KeepDays(),
		"totals":       rep.Totals,
		"series":       rep.Series,
		"by_model":     rep.ByModel,
		"by_account":   rep.ByAccount,
		"since_start":  p.cfg.Stats.Lifetime(),
		"pool_total":   total,
	})
}

// poolTotal 池内全部账号的长期累计（跨账号求和后的可观测字段）。
// 与 stats.Lifetime 的区别见本文件顶部说明：这份包含统计功能上线之前的历史，
// 但只有总数、没有按日明细。
type poolTotal struct {
	RequestCount     int64 `json:"requests"`
	UsageCount       int64 `json:"usage_count"`
	PromptTokens     int64 `json:"prompt_tokens"`
	CompletionTokens int64 `json:"completion_tokens"`
	TotalTokens      int64 `json:"total_tokens"`
	// ActiveAccounts 其中有请求记录的账号数（"这个总量是几个号跑出来的"）。
	ActiveAccounts int `json:"active_accounts"`
}

func (l *poolTotal) add(u pool.TokenUsage) {
	if u.RequestCount == 0 && u.TotalTokens == 0 {
		// 从没跑过请求的号不进"累计"（否则 ActiveAccounts 会被空号灌水）。
		return
	}
	l.RequestCount += u.RequestCount
	l.UsageCount += u.UsageCount
	l.PromptTokens += u.PromptTokens
	l.CompletionTokens += u.CompletionTokens
	l.TotalTokens += u.TotalTokens
	l.ActiveAccounts++
}
