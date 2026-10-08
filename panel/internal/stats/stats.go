// Package stats 统计聚合：定时经代理拉各服务统计 → SQLite；读接口合并日序列。
// 口径：以各服务自身统计为准；cline 为「累计快照差分」口径；cmdgo 待补丁（需单独同意）。
package stats

import (
	"database/sql"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"strconv"
	"sync"
	"time"

	"api-free/panel/internal/events"

	_ "modernc.org/sqlite"
)

type DayRow struct {
	Date  string `json:"date"`
	Input int64  `json:"input"`
	Output int64 `json:"output"`
	Reqs  int64  `json:"reqs"`
}

type Collector struct {
	db         *sql.DB
	httpClient *http.Client
	panelAddr  string // 127.0.0.1:9000，回调自身 /api/svc/*
	mu         sync.Mutex
	lastRun    time.Time
	lastRunErr string
}

func New(dbPath, panelAddr string) (*Collector, error) {
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	for _, q := range []string{
		`CREATE TABLE IF NOT EXISTS stats_daily(date TEXT, svc TEXT, input INTEGER, output INTEGER, reqs INTEGER, failures INTEGER, PRIMARY KEY(date, svc))`,
		`CREATE TABLE IF NOT EXISTS stats_cum(svc TEXT, ts INTEGER, input INTEGER, output INTEGER, reqs INTEGER, PRIMARY KEY(svc, ts))`,
	} {
		if _, err := db.Exec(q); err != nil {
			return nil, err
		}
	}
	return &Collector{db: db, httpClient: &http.Client{Timeout: 20 * time.Second}, panelAddr: panelAddr}, nil
}

func (c *Collector) Close() { _ = c.db.Close() }

/* ---------- 采集 ---------- */

// PullAll 拉一轮全部运行中的服务；返回成功/失败数。
func (c *Collector) PullAll(statusOf func(id string) bool) (int, int) {
	okN, failN := 0, 0
	for _, id := range []string{"workbuddy", "qoder", "zen", "cline", "cmdgo"} {
		if statusOf != nil && !statusOf(id) {
			continue
		}
		var err error
		switch id {
		case "workbuddy", "qoder", "zen":
			// 三家都是 series[] 日序列口径（zen 按同一形状实现）
			err = c.pullDaily(id)
		case "cline":
			err = c.pullCum("cline")
		case "cmdgo":
			err = c.pullCmdgo()
		}
		if err != nil {
			failN++
			log.Printf("[stats] %s 拉取失败: %v", id, err)
			events.Add("[stats] " + id + " 拉取失败: " + err.Error())
		} else {
			okN++
		}
	}
	c.mu.Lock()
	c.lastRun, c.lastRunErr = time.Now(), ""
	if failN > 0 {
		c.lastRunErr = "部分失败"
	}
	c.mu.Unlock()
	return okN, failN
}

// pullCmdgo cmdgo 只读补丁：GET /api/usage → {total, days:[{date,requests,prompt_tokens,completion_tokens,total_tokens}]}
func (c *Collector) pullCmdgo() error {
	m, err := c.get("/api/svc/cmdgo/api/usage")
	if err != nil {
		return err
	}
	items, _ := m["days"].([]any)
	rows := make([]drow, 0, len(items))
	for _, it := range items {
		o, _ := it.(map[string]any)
		if o == nil {
			continue
		}
		date := strAny(o, "date")
		if date == "" {
			continue
		}
		rows = append(rows, drow{
			date:  date,
			in:    intAny(o, "prompt_tokens"),
			out:   intAny(o, "completion_tokens"),
			reqs:  intAny(o, "requests"),
			fails: 0,
		})
	}
	return c.upsertDaily("cmdgo", rows)
}

func (c *Collector) get(path string) (map[string]any, error) {
	r, err := c.httpClient.Get("http://" + c.panelAddr + path)
	if err != nil {
		return nil, err
	}
	defer r.Body.Close()
	b, _ := io.ReadAll(r.Body)
	if r.StatusCode != 200 {
		return nil, errString("HTTP " + strconv.Itoa(r.StatusCode) + ": " + trunc(string(b), 120))
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, err
	}
	return m, nil
}

// pullDaily workbuddy/qoder：series[].{key|day, prompt_tokens, completion_tokens, requests, failures}
func (c *Collector) pullDaily(svc string) error {
	m, err := c.get("/api/svc/" + svc + "/panel/api/stats?range=30d")
	if err != nil {
		return err
	}
	items, _ := m["series"].([]any)
	rows := make([]drow, 0, len(items))
	for _, it := range items {
		o, _ := it.(map[string]any)
		if o == nil {
			continue
		}
		date := strAny(o, "key", "day", "date")
		if date == "" {
			continue
		}
		rows = append(rows, drow{
			date:  date,
			in:    intAny(o, "prompt_tokens", "input"),
			out:   intAny(o, "completion_tokens", "output"),
			reqs:  intAny(o, "requests", "req"),
			fails: intAny(o, "failures", "fail"),
		})
	}
	return c.upsertDaily(svc, rows)
}

type drow struct {
	date              string
	in, out, reqs, fails int64
}

func (c *Collector) upsertDaily(svc string, rows []drow) error {
	tx, err := c.db.Begin()
	if err != nil {
		return err
	}
	for _, r := range rows {
		if _, err := tx.Exec(`INSERT OR REPLACE INTO stats_daily(date, svc, input, output, reqs, failures) VALUES(?,?,?,?,?,?)`,
			r.date, svc, r.in, r.out, r.reqs, r.fails); err != nil {
			_ = tx.Rollback()
			return err
		}
	}
	return tx.Commit()
}

// pullCum cline：/v1/status → account_details[].usage.{input,output,calls} 累计快照
func (c *Collector) pullCum(svc string) error {
	m, err := c.get("/api/svc/" + svc + "/v1/status")
	if err != nil {
		return err
	}
	dets, _ := m["account_details"].([]any)
	var in, out, calls int64
	for _, d := range dets {
		u, _ := d.(map[string]any)["usage"].(map[string]any)
		if u == nil {
			continue
		}
		in += intAny(u, "input")
		out += intAny(u, "output")
		calls += intAny(u, "calls")
	}
	now := time.Now().Unix()
	if _, err := c.db.Exec(`INSERT OR REPLACE INTO stats_cum(svc, ts, input, output, reqs) VALUES(?,?,?,?,?)`,
		svc, now, in, out, calls); err != nil {
		return err
	}
	// 只保留每天首尾 + 最近 48 条之外的旧数据清理（简单起见：30 天前）
	_, _ = c.db.Exec(`DELETE FROM stats_cum WHERE ts < ?`, time.Now().AddDate(0, 0, -35).Unix())
	return nil
}

/* ---------- 读取 ---------- */

// Days 返回最近 days 天、按服务展开的日序列；cline 用累计差分推导。
func (c *Collector) Days(days int) (map[string]map[string]DayRow, []string) {
	out := map[string]map[string]DayRow{} // date -> svc -> row
	for _, svc := range []string{"workbuddy", "qoder", "zen", "cline", "cmdgo"} {
		if svc == "cline" {
			c.mergeCline(svc, days, out)
			continue
		}
		rows, err := c.db.Query(`SELECT date, input, output, reqs FROM stats_daily WHERE svc=? AND date>=? ORDER BY date`, svc, dayStr(time.Now().AddDate(0, 0, -days)))
		if err != nil {
			continue
		}
		for rows.Next() {
			var d string
			var i, o, r int64
			if rows.Scan(&d, &i, &o, &r) == nil {
				put(out, d, svc, i, o, r)
			}
		}
		rows.Close()
	}
	return out, []string{"workbuddy", "qoder", "zen", "cline", "cmdgo"}
}

func (c *Collector) mergeCline(svc string, days int, out map[string]map[string]DayRow) {
	type pt struct {
		ts          int64
		in, out, r int64
	}
	rows, err := c.db.Query(`SELECT ts, input, output, reqs FROM stats_cum WHERE svc=? AND ts>=? ORDER BY ts`, svc, time.Now().AddDate(0, 0, -(days+1)).Unix())
	if err != nil {
		return
	}
	var pts []pt
	for rows.Next() {
		var p pt
		if rows.Scan(&p.ts, &p.in, &p.out, &p.r) == nil {
			pts = append(pts, p)
		}
	}
	rows.Close()
	if len(pts) < 2 {
		return
	}
	// 按本地日分组：日内首尾差分
	byDay := map[string][]pt{}
	var order []string
	for _, p := range pts {
		d := dayStr(time.Unix(p.ts, 0))
		if _, ok := byDay[d]; !ok {
			order = append(order, d)
		}
		byDay[d] = append(byDay[d], p)
	}
	for i, d := range order {
		seg := byDay[d]
		first, last := seg[0], seg[len(seg)-1]
		baseIn, baseOut, baseR := first.in, first.out, first.r
		if i > 0 {
			prev := byDay[order[i-1]]
			p := prev[len(prev)-1]
			baseIn, baseOut, baseR = p.in, p.out, p.r
		}
		dIn, dOut, dR := last.in-baseIn, last.out-baseOut, last.r-baseR
		if dIn < 0 || dOut < 0 || dR < 0 { // 重启清零导致回退
			dIn, dOut, dR = max64(0, last.in-first.in), max64(0, last.out-first.out), max64(0, last.r-first.r)
		}
		if dIn == 0 && dOut == 0 && dR == 0 {
			continue
		}
		put(out, d, svc, dIn, dOut, dR)
	}
}

func put(out map[string]map[string]DayRow, date, svc string, i, o, r int64) {
	if out[date] == nil {
		out[date] = map[string]DayRow{}
	}
	e := out[date][svc]
	e.Date, e.Input, e.Output, e.Reqs = date, e.Input+i, e.Output+o, e.Reqs+r
	out[date][svc] = e
}

/* ---------- HTTP 读模型 ---------- */

func (c *Collector) Summary(days int) map[string]any {
	data, svcs := c.Days(days)
	dayList := sortedDates(data, days)
	type svcDay struct {
		Input int64 `json:"input"`
		Output int64 `json:"output"`
		Reqs int64 `json:"reqs"`
	}
	daysArr := make([]map[string]any, 0, len(dayList))
	var todayIn, todayOut, todayR int64
	today := dayStr(time.Now())
	var totals = map[string]svcDay{}
	for _, d := range dayList {
		entry := map[string]any{}
		var dIn, dOut, dR int64
		for _, s := range svcs {
			row, ok := data[d][s]
			if !ok {
				continue
			}
			entry[s] = svcDay{row.Input, row.Output, row.Reqs}
			dIn += row.Input
			dOut += row.Output
			dR += row.Reqs
			t := totals[s]
			t.Input += row.Input
			t.Output += row.Output
			t.Reqs += row.Reqs
			totals[s] = t
			if d == today {
				todayIn += row.Input
				todayOut += row.Output
				todayR += row.Reqs
			}
		}
		entry["total"] = svcDay{dIn, dOut, dR}
		daysArr = append(daysArr, map[string]any{"date": d, "services": entry, "total": svcDay{dIn, dOut, dR}})
	}
	c.mu.Lock()
	lastRun, lastErr := c.lastRun, c.lastRunErr
	c.mu.Unlock()
	return map[string]any{
		"days": daysArr,
		"totals": totals,
		"today": svcDay{todayIn, todayOut, todayR},
		"cmdgoPending": false,
		"lastPull": lastRun.Format("15:04:05"),
		"lastPullErr": lastErr,
	}
}

func sortedDates(data map[string]map[string]DayRow, days int) []string {
	seen := map[string]bool{}
	var out []string
	for i := days - 1; i >= 0; i-- {
		d := dayStr(time.Now().AddDate(0, 0, -i))
		out = append(out, d)
		seen[d] = true
	}
	for d := range data {
		if !seen[d] {
			out = append(out, d)
		}
	}
	sortStrings(out)
	return out
}

func sortStrings(s []string) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j] < s[j-1]; j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
}

func dayStr(t time.Time) string { return t.Format("2006-01-02") }
func max64(a, b int64) int64 { if a > b { return a }; return b }

func strAny(m map[string]any, keys ...string) string {
	for _, k := range keys {
		if v, ok := m[k].(string); ok && v != "" {
			return v
		}
	}
	return ""
}
func intAny(m map[string]any, keys ...string) int64 {
	for _, k := range keys {
		if f, ok := m[k].(float64); ok {
			return int64(f)
		}
	}
	return 0
}
func trunc(s string, n int) string { if len(s) > n { return s[:n] }; return s }

type errString string
func (e errString) Error() string { return string(e) }

var _ = http.MethodGet
