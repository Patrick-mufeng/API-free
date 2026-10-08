package svcinfo

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"api-free/panel/internal/registry"
)

// stub 起一个假的「服务」，按路径返回预置 JSON。真实服务在跑的机器上没法随时
// 制造冷却，所以用这一层把「有冷却」「有任务」这些分支锁住。
func stub(t *testing.T, routes map[string]string) (base string, port int) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, ok := routes[r.URL.Path]
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	u, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	p, err := strconv.Atoi(u.Port())
	if err != nil {
		t.Fatal(err)
	}
	return srv.URL, p
}

func collectorFor(services ...registry.Service) *Collector {
	return New(&registry.File{Services: services}, func(string) string { return "k" }, func(string) bool { return true })
}

func TestWorkbuddyCoolingBreakerAndCards(t *testing.T) {
	until := time.Now().Add(23 * time.Minute).Format(time.RFC3339)
	_, port := stub(t, map[string]string{
		"/panel/api/overview": `{
		  "cooling": 2, "total": 3, "healthy": 1,
		  "accounts": [
		    {"uid":"u1","nickname":"13800000001","credits":100,"credits_total":500,"cooling":true,"until":"` + until + `","breaker_fails":0,"breaker_until":"0001-01-01T00:00:00Z"},
		    {"uid":"u2","nickname":"13800000002","credits":50,"credits_total":500,"cooling":true,"until":"` + until + `","breaker_fails":5,"breaker_until":"` + until + `"},
		    {"uid":"u3","nickname":"13800000003","credits":30,"credits_total":500,"cooling":false,"until":"0001-01-01T00:00:00Z"}
		  ]}`,
		"/panel/api/school/status": `{"accounts":[
		  {"uid":"u1","nickname":"a","in_period":false,"chances":2,"tasks":[
		    {"task_code":"t1","status":"claimed","progress":1,"target_count":1},
		    {"task_code":"t2","status":"pending","progress":0,"target_count":3}]}]}`,
		"/panel/api/accounts/u1/tasks": `{"ok":true,"tasks":[
		  {"task_code":"g1","current":1,"target":1,"accept_status":"claimed"},
		  {"task_code":"g2","current":1,"target":3,"accept_status":"in_progress"},
		  {"task_code":"g3","current":5,"target":5,"accept_status":"claimed"}]}`,
	})
	c := collectorFor(registry.Service{ID: "workbuddy", Name: "WorkBuddy-free", Port: port})
	rep := c.Report()

	if rep.Total != 2 {
		t.Fatalf("total = %d, want 2", rep.Total)
	}
	if len(rep.Alerts) != 3 { // 2 条 cooling + 1 条 breaker
		t.Fatalf("alerts = %d 条, want 3: %+v", len(rep.Alerts), rep.Alerts)
	}
	if !strings.Contains(rep.Alerts[0].Text, "13800000001") || rep.Alerts[0].Until == "" {
		t.Fatalf("首条冷却告警没带上账号或恢复时刻: %+v", rep.Alerts[0])
	}
	if rep.Alerts[2].Kind != "breaker" || !strings.Contains(rep.Alerts[2].Text, "5 次") {
		t.Fatalf("熔断告警不对: %+v", rep.Alerts[2])
	}

	card := rep.Services[0]
	if !card.OK || card.Accounts == nil || *card.Accounts != 3 || card.Healthy == nil || *card.Healthy != 1 {
		t.Fatalf("账号字段不对: %+v", card)
	}
	if card.Cooling == nil || *card.Cooling != 2 || card.CoolUnit != "账号" {
		t.Fatalf("冷却字段不对: %+v", card)
	}
	if card.Credits == nil || card.Credits.Remaining != 180 || card.Credits.Total != 1500 {
		t.Fatalf("积分合计不对: %+v", card.Credits)
	}
	if len(card.Tasks) != 2 {
		t.Fatalf("应有两项任务（开学季 + 成长）: %+v", card.Tasks)
	}
	school := card.Tasks[0]
	if school.Name != "开学季" || school.Done != 1 || school.Total != 2 || !strings.Contains(school.Note, "不在活动期") || !strings.Contains(school.Note, "抽奖 2 次") {
		t.Fatalf("开学季任务不对: %+v", school)
	}
	growth := card.Tasks[1]
	if growth.Name != "成长任务" || growth.Done != 2 || growth.Total != 3 {
		t.Fatalf("成长任务不对: %+v", growth)
	}

	// 零值时间与过去时间不得当成恢复时刻
	_, port2 := stub(t, map[string]string{"/panel/api/overview": `{
	  "cooling": 1,
	  "accounts": [{"uid":"u9","nickname":"x","cooling":true,"until":"0001-01-01T00:00:00Z","breaker_fails":1,"breaker_until":"2020-01-01T00:00:00Z"}]}`})
	zero := collectorFor(registry.Service{ID: "workbuddy", Port: port2}).Report()
	if zero.Alerts[0].Until != "" || strings.Contains(zero.Alerts[0].Text, "恢复") {
		t.Fatalf("零值时间被渲染成了恢复时刻: %+v", zero.Alerts[0])
	}
	if len(zero.Alerts) != 1 {
		t.Fatalf("过去的熔断时间不该出告警: %+v", zero.Alerts)
	}
}

func TestQoderAndClineCards(t *testing.T) {
	future := time.Now().Add(40 * time.Minute).UnixMilli() // 毫秒时间戳
	_, qp := stub(t, map[string]string{"/panel/api/overview": `{
	  "total": 2, "healthy": 1, "sticky_count": 0,
	  "accounts": [
	    {"id":"a1","name":"qoder-cn","cool_kind":"rate","cool_until":` + strconv.FormatInt(future, 10) + `,"has_quota":true,"credits":30,"credits_total":100},
	    {"id":"a2","name":"qoder-global","cool_kind":"none","cool_until":"0001-01-01T00:00:00Z","has_quota":false}
	  ]}`})
	_, cp := stub(t, map[string]string{"/v1/status": `{
	  "account_count": 1, "accounts_available": 1, "models_available": 4,
	  "account_details": [
	    {"id":"c1","email":"a@b.com","cooldown_models":["deepseek-v4.1-flash","glm-5.2"]},
	    {"id":"c2","email":"c@d.com","cooldown_models":[]}
	  ]}`})
	c := collectorFor(
		registry.Service{ID: "qoder", Port: qp},
		registry.Service{ID: "cline", Port: cp},
	)
	rep := c.Report()

	byID := map[string]Card{}
	for _, x := range rep.Services {
		byID[x.Svc] = x
	}
	q := byID["qoder"]
	if q.Accounts == nil || *q.Accounts != 2 || q.Healthy == nil || *q.Healthy != 1 {
		t.Fatalf("qoder 账号字段: %+v", q)
	}
	if q.Cooling == nil || *q.Cooling != 1 || q.CoolUnit != "账号" {
		t.Fatalf("qoder 冷却: %+v", q)
	}
	if q.Credits == nil || q.Credits.Remaining != 30 || q.Credits.Total != 100 {
		t.Fatalf("qoder 额度只应统计 has_quota 的账号: %+v", q.Credits)
	}
	if len(q.Tasks) != 0 || q.Note == "" {
		t.Fatalf("qoder 应如实标注没有任务接口: %+v", q)
	}

	cl := byID["cline"]
	if cl.Accounts == nil || *cl.Accounts != 1 || cl.Healthy == nil || *cl.Healthy != 1 || cl.Models == nil || *cl.Models != 4 {
		t.Fatalf("cline 字段: %+v", cl)
	}
	if cl.Cooling == nil || *cl.Cooling != 2 || cl.CoolUnit != "模型" {
		t.Fatalf("cline 冷却应为模型级 2: %+v", cl)
	}
	if rep.Total != 3 {
		t.Fatalf("total = %d, want 3", rep.Total)
	}
	if !strings.Contains(rep.Alerts[0].Text, "qoder-cn") || rep.Alerts[0].Until == "" {
		t.Fatalf("qoder 告警: %+v", rep.Alerts[0])
	}
	if !strings.Contains(rep.Alerts[1].Text, "deepseek-v4.1-flash") {
		t.Fatalf("cline 告警没列出模型: %+v", rep.Alerts[1])
	}
}

func TestCmdgoAndDegradation(t *testing.T) {
	_, port := stub(t, map[string]string{
		"/api/status": `{"ok":true,"provider":"commandcode","modelCount":51,"activeAccounts":1,
		  "accounts":[{"id":"x"}],"login":{"status":"idle"}}`,
	})
	c := collectorFor(
		registry.Service{ID: "cmdgo", Port: port},
		registry.Service{ID: "workbuddy", Port: port}, // 下面把这个标成未运行
	)
	c.running = func(id string) bool { return id != "workbuddy" }
	rep := c.Report()

	cmdgo := rep.Services[0]
	if !cmdgo.OK || cmdgo.Accounts == nil || *cmdgo.Accounts != 1 || cmdgo.Models == nil || *cmdgo.Models != 51 {
		t.Fatalf("cmdgo 卡片: %+v", cmdgo)
	}
	if cmdgo.Healthy == nil || *cmdgo.Healthy != 1 {
		t.Fatalf("cmdgo 活跃账号: %+v", cmdgo.Healthy)
	}
	if rep.Cooling[0].OK || rep.Cooling[0].Err != "该服务没有冷却口径" {
		t.Fatalf("cmdgo 应标记无冷却口径: %+v", rep.Cooling[0])
	}
	wb := rep.Services[1]
	if wb.OK || wb.Err != "服务未运行" {
		t.Fatalf("停着的服务应标记未运行: %+v", wb)
	}
	if rep.Cooling[1].OK || rep.Cooling[1].Err != "服务未运行" {
		t.Fatalf("停着的服务冷却应标记未运行: %+v", rep.Cooling[1])
	}
	if rep.Total != 0 || len(rep.Alerts) != 0 {
		t.Fatalf("无数据时不该有计数或告警: %+v", rep)
	}
}
