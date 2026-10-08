// persist.go 持久化：本地 stats.json 的加载、原子落盘与后台 flusher。
package stats

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"sort"
	"time"
)

// flushInterval 后台落盘周期，与 pool 的 5s 对齐：同一批请求引发的账目变化落在
// 同一把刷子里，运维对比 state.json 与 stats.json 的时间戳不会错位。
// 变量而非常量：测试里可临时改小（同 pool.flushInterval 的做法）。
var flushInterval = 5 * time.Second

// persistLogEvery 连续落盘失败每 N 次打一条提醒（口径同 pool.persistLogEvery，
// 磁盘持续满时不刷屏）。
const persistLogEvery = 12

// statsFile 持久化格式。单键包一层对象而非直接写 map：将来要加版本号/元信息时
// 有地方放，且不会与"文件恰好是个 map"的旧格式在解析上产生歧义。
type statsFile struct {
	Days map[string]*dayStat `json:"days"`
	// Lifetime/UIDs/Since 是"自开始统计以来"的总账与元信息，**不随 Days 淘汰**：
	// days 只留最近 keepDays 天，窗口滚动时这份总账仍要单调不减（页面头条读数）。
	Lifetime Bucket `json:"lifetime,omitempty"`
	// Since 首个记录的自然日。UIDs 用排序切片而非 set：
	// 落盘文件要给人看，[{} {} {}] 这种 set 序列化形态没法读。
	Since string   `json:"since,omitempty"`
	UIDs  []string `json:"uids,omitempty"`
}

// load 载入已存在的统计文件（不存在视为首次运行）。
func (r *Recorder) load() {
	if r.fp == "" {
		return
	}
	raw, err := os.ReadFile(r.fp)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("stats: 读取 %s 失败: %v", r.fp, err)
		}
		return
	}
	var sf statsFile
	if json.Unmarshal(raw, &sf) != nil || sf.Days == nil {
		// 解析失败不静默覆盖：先把原文件挪成 .corrupt 留证再空白起步。统计是长期累积量，
		// 直接在损坏文件上落盘会把仅有的历史整片抹掉且不可恢复（宁可从零重算）。
		bak := r.fp + ".corrupt"
		if err := os.Rename(r.fp, bak); err != nil {
			log.Printf("stats: %s 解析失败且备份失败(%v)，本次运行不落盘以免覆盖原文件", r.fp, err)
			r.fp = "" // 备份不了就彻底不写，保护原文件
			return
		}
		log.Printf("stats: %s 解析失败，已备份为 %s，统计从空白起步", r.fp, bak)
		return
	}
	r.days = sf.Days
	r.life = sf.Lifetime
	r.since = sf.Since
	for _, u := range sf.UIDs {
		r.uids[u] = struct{}{}
	}
}

// startFlusher 启动后台周期性落盘。
func (r *Recorder) startFlusher() {
	interval := flushInterval
	go func() {
		t := time.NewTicker(interval)
		defer t.Stop()
		for {
			select {
			case <-t.C:
				r.Flush()
			case <-r.stopCh:
				return
			}
		}
	}()
}

// Flush 同步落盘（幂等：无变更不写）。
func (r *Recorder) Flush() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.dirty.Swap(false) {
		return
	}
	r.saveLocked()
}

// Close 停后台 flusher 并补最后一次落盘（进程退出前由 main defer 调用）。
// 幂等：重复 Close 安全。
func (r *Recorder) Close() {
	r.stopOnce.Do(func() { close(r.stopCh) })
	r.Flush()
}

// saveLocked 把内存状态原子写盘（tmp + rename，同 pool.saveLocked 口径）。调用方须持 r.mu。
func (r *Recorder) saveLocked() {
	if r.fp == "" {
		return
	}
	uids := make([]string, 0, len(r.uids))
	for u := range r.uids {
		uids = append(uids, u)
	}
	sort.Strings(uids) // 稳定顺序：同一份状态每次落盘的字节一致，便于 diff 与备份比对
	raw, err := json.MarshalIndent(statsFile{
		Days:     r.days,
		Lifetime: r.life,
		Since:    r.since,
		UIDs:     uids,
	}, "", "  ")
	if err != nil {
		r.notePersistFail(err)
		return
	}
	if dir := filepath.Dir(r.fp); dir != "" {
		_ = os.MkdirAll(dir, 0o755)
	}
	tmp := r.fp + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		r.notePersistFail(err)
		return
	}
	if err := os.Rename(tmp, r.fp); err != nil {
		r.notePersistFail(err)
		return
	}
	if r.failN > 0 {
		log.Printf("stats: stats.json 落盘恢复（此前连续失败 %d 次）", r.failN)
		r.failN = 0
	}
}

// notePersistFail 记一次落盘失败：把脏位置回，下一个 tick 重试（否则这一批增量
// 在内存里等到下次请求才可能再被标记，静默丢一段观测），并按节流规则打日志。
func (r *Recorder) notePersistFail(err error) {
	r.dirty.Store(true)
	if r.failN == 0 {
		log.Printf("stats: stats.json 落盘失败: %v", err)
	} else if r.failN%persistLogEvery == 0 {
		log.Printf("stats: stats.json 连续落盘失败 %d 次: %v", r.failN, err)
	}
	r.failN++
}
