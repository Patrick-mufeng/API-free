// 各服务的字段解析。每个服务一次采集同时产出告警与卡片两部分，
// 字段名以实测为准（见注释），取不到的字段留空由界面显示「—」。
package svcinfo

import (
	"fmt"
	"strings"

	"api-free/panel/internal/registry"
)

/* ---------- workbuddy：账号池 + 签到/成长任务最多 ---------- */

// overview: total/healthy/cooling/disabled + accounts[].{nickname,credits,credits_total,
// cooling,until,breaker_fails,breaker_until}（账号级冷却）
// school/status: accounts[].{in_period,chances,tasks[].{task_code,status,progress,target_count}}
// accounts/{uid}/tasks: tasks[].{task_code,current,target,accept_status,claimed}
func (c *Collector) workbuddy(svc registry.Service) svcData {
	d := svcData{Cool: Cool{Svc: svc.ID, Unit: "账号"}, Card: Card{Svc: svc.ID}}
	doc, err := c.get(svc, "/panel/api/overview")
	if err != nil {
		d.Cool.Err, d.Card.Err = err.Error(), err.Error()
		return d
	}
	d.Cool.OK, d.Card.OK = true, true

	d.Card.Accounts = optInt(doc, "total")
	d.Card.Healthy = optInt(doc, "healthy")

	var rem, total float64
	hasCredits := false
	cooling := 0
	for _, raw := range asList(doc["accounts"]) {
		m := asMap(raw)
		who := displayName(m)
		if v, ok := asFloat(m["credits"]); ok {
			rem += v
			hasCredits = true
		}
		if v, ok := asFloat(m["credits_total"]); ok {
			total += v
		}
		if asBool(m["cooling"]) {
			cooling++
			d.Alerts = append(d.Alerts, Alert{Svc: svc.ID, Kind: "cooling", Until: clockOf(m["until"]),
				Text: "账号 " + who + " 冷却中" + untilSuffix(m["until"])})
		}
		if fails := asInt(m["breaker_fails"]); fails > 0 && isFuture(m["breaker_until"]) {
			d.Alerts = append(d.Alerts, Alert{Svc: svc.ID, Kind: "breaker", Until: clockOf(m["breaker_until"]),
				Text: "账号 " + who + " 连续失败 " + fmt.Sprint(fails) + " 次已熔断" + untilSuffix(m["breaker_until"])})
		}
	}
	// 顶层 cooling 可能包含未展开的账号，取较大者
	if v := asInt(doc["cooling"]); v > cooling {
		cooling = v
	}
	d.Cool.N = cooling
	d.Card.Cooling, d.Card.CoolUnit = ptr(cooling), "账号"
	if hasCredits {
		d.Card.Credits = &Credits{Remaining: rem, Total: total}
	}
	d.Card.Tasks = append(d.Card.Tasks, c.wbSchool(svc)...)
	if t, ok := c.wbGrowth(svc, doc); ok {
		d.Card.Tasks = append(d.Card.Tasks, t)
	}
	return d
}

func (c *Collector) wbSchool(svc registry.Service) []Task {
	doc, err := c.get(svc, "/panel/api/school/status")
	if err != nil {
		return nil
	}
	accounts := asList(doc["accounts"])
	if len(accounts) == 0 {
		return nil
	}
	done, total, chances := 0, 0, 0
	inPeriod := false
	for _, raw := range accounts {
		m := asMap(raw)
		if asBool(m["in_period"]) {
			inPeriod = true
		}
		chances += asInt(m["chances"])
		for _, t := range asList(m["tasks"]) {
			total++
			if asStr(asMap(t)["status"]) == "claimed" {
				done++
			}
		}
	}
	note := ""
	if !inPeriod {
		note = "不在活动期"
	}
	if chances > 0 {
		if note != "" {
			note += " · "
		}
		note += "抽奖 " + fmt.Sprint(chances) + " 次"
	}
	return []Task{{Name: "开学季", Done: done, Total: total, Note: note}}
}

// wbGrowth 成长任务按账号逐个查（接口是 per-account 的），账号多时只统计前几个并在 note 里说明。
func (c *Collector) wbGrowth(svc registry.Service, overview map[string]any) (Task, bool) {
	accounts := asList(overview["accounts"])
	if len(accounts) == 0 {
		return Task{}, false
	}
	limit, capped := len(accounts), false
	if limit > maxTaskAccounts {
		limit, capped = maxTaskAccounts, true
	}
	done, total, fetched := 0, 0, 0
	for _, raw := range accounts[:limit] {
		uid := asStr(asMap(raw)["uid"])
		if uid == "" {
			continue
		}
		doc, err := c.get(svc, "/panel/api/accounts/"+uid+"/tasks")
		if err != nil {
			continue
		}
		fetched++
		for _, t := range asList(doc["tasks"]) {
			total++
			if asStr(asMap(t)["accept_status"]) == "claimed" {
				done++
			}
		}
	}
	if fetched == 0 {
		return Task{}, false
	}
	note := ""
	if capped {
		note = "仅统计前 " + fmt.Sprint(limit) + " 个账号"
	}
	return Task{Name: "成长任务", Done: done, Total: total, Note: note}, true
}

/* ---------- qoder：账号池（国内签到没有状态接口） ---------- */

// overview: total/healthy/sticky_count + accounts[].{name,cool_kind,cool_until,
// credits,credits_total,has_quota}（账号级冷却）
func (c *Collector) qoder(svc registry.Service) svcData {
	d := svcData{
		Cool: Cool{Svc: svc.ID, Unit: "账号"},
		Card: Card{Svc: svc.ID, Note: "该服务没有活动/任务状态接口"},
	}
	doc, err := c.get(svc, "/panel/api/overview")
	if err != nil {
		d.Cool.Err, d.Card.Err = err.Error(), err.Error()
		return d
	}
	d.Cool.OK, d.Card.OK = true, true

	d.Card.Accounts = optInt(doc, "total")
	d.Card.Healthy = optInt(doc, "healthy")

	var rem, total float64
	hasCredits := false
	cooling := 0
	for _, raw := range asList(doc["accounts"]) {
		m := asMap(raw)
		kind := asStr(m["cool_kind"])
		if kind != "" && !strings.EqualFold(kind, "none") {
			cooling++
			d.Alerts = append(d.Alerts, Alert{Svc: svc.ID, Kind: "cooling", Until: clockOf(m["cool_until"]),
				Text: "账号 " + displayName(m) + " 冷却中（" + kind + "）" + untilSuffix(m["cool_until"])})
		}
		if asBool(m["has_quota"]) {
			if v, ok := asFloat(m["credits"]); ok {
				rem += v
				hasCredits = true
			}
			if v, ok := asFloat(m["credits_total"]); ok {
				total += v
			}
		}
	}
	d.Cool.N = cooling
	d.Card.Cooling, d.Card.CoolUnit = ptr(cooling), "账号"
	if hasCredits {
		d.Card.Credits = &Credits{Remaining: rem, Total: total}
	}
	return d
}

/* ---------- cline：模型级冷却 + 模型库规模 ---------- */

// /v1/status: account_count/accounts_available/models_available +
// account_details[].{email,cooldown_models[]}
// 顶层 cooldowns[] 形状未定性，为避免重复计数不回填。
func (c *Collector) cline(svc registry.Service) svcData {
	d := svcData{
		Cool: Cool{Svc: svc.ID, Unit: "模型"},
		Card: Card{Svc: svc.ID, Note: "该服务没有活动/任务接口"},
	}
	doc, err := c.get(svc, "/v1/status")
	if err != nil {
		d.Cool.Err, d.Card.Err = err.Error(), err.Error()
		return d
	}
	d.Cool.OK, d.Card.OK = true, true

	d.Card.Accounts = optInt(doc, "account_count")
	d.Card.Healthy = optInt(doc, "accounts_available")
	d.Card.Models = optInt(doc, "models_available")

	cooling := 0
	for _, raw := range asList(doc["account_details"]) {
		m := asMap(raw)
		models := asList(m["cooldown_models"])
		if len(models) == 0 {
			continue
		}
		cooling += len(models)
		names := make([]string, 0, len(models))
		for _, x := range models {
			if s := asStr(x); s != "" {
				names = append(names, s)
			}
		}
		d.Alerts = append(d.Alerts, Alert{Svc: svc.ID, Kind: "cooling", Until: clockOf(m["cooldown_until"]),
			Text: "账号 " + displayName(m) + " 的模型冷却：" + strings.Join(names, "、")})
	}
	d.Cool.N = cooling
	d.Card.Cooling, d.Card.CoolUnit = ptr(cooling), "模型"
	return d
}

/* ---------- cmdgo：单账号桥接，没有冷却与任务口径 ---------- */

// /api/status: ok/provider/modelCount/activeAccounts/accounts[](camelCase)
func (c *Collector) cmdgo(svc registry.Service) svcData {
	d := svcData{
		Cool: Cool{Svc: svc.ID, Err: "该服务没有冷却口径"},
		Card: Card{Svc: svc.ID, Note: "该服务没有活动/任务状态接口"},
	}
	doc, err := c.get(svc, "/api/status")
	if err != nil {
		d.Card.Err = err.Error()
		return d
	}
	d.Card.OK = true
	if !asBool(doc["ok"]) {
		d.Card.OK = false
		d.Card.Err = "桥接未就绪"
	}
	d.Card.Accounts = optInt(doc, "accounts")     // 账号条数（通常 0/1）
	if v := optInt(doc, "activeAccounts"); v != nil {
		d.Card.Healthy = v
	}
	d.Card.Models = optInt(doc, "modelCount")
	return d
}

/* ---------- 小工具 ---------- */

// optInt 字段缺失返回 nil（= 该服务没有这个口径），与真实的 0 区分。
// 值可以是数字，也可以是数组（cmdgo 的 accounts 就是数组），数组取长度。
func optInt(m map[string]any, key string) *int {
	v, ok := m[key]
	if !ok || v == nil {
		return nil
	}
	if l, ok := v.([]any); ok {
		return ptr(len(l))
	}
	return ptr(asInt(v))
}
