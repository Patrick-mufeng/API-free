package svcinfo

import (
	"strconv"
	"strings"
	"testing"

	"api-free/panel/internal/registry"
)

func TestMaskKey(t *testing.T) {
	cases := map[string]string{
		"":                            "",
		"k":                           "…",
		"sk":                          "…",
		"sk-3PPLL":                    "sk…",
		"sk-cline-1234567890abcdef":   "sk-cline…",
		"eb1e59269ef0bd84ab0636e43ca": "eb1e5926…",
	}
	for in, want := range cases {
		if got := maskKey(in); got != want {
			t.Errorf("maskKey(%q) = %q, 期望 %q", in, got, want)
		}
	}
}

func TestPanelBase(t *testing.T) {
	if got := panelBase("127.0.0.1:9000", "cline"); got != "http://127.0.0.1:9000/api/svc/cline/v1" {
		t.Fatalf("panelBase 不对: %s", got)
	}
	// Host 缺失时用默认地址，而不是拼出空 host
	if got := panelBase("", "cmdgo"); got != "http://127.0.0.1:9000/api/svc/cmdgo/v1" {
		t.Fatalf("Host 缺失时应有回退: %s", got)
	}
}

func TestAccessListsModelsAndMasksKey(t *testing.T) {
	_, port := stub(t, map[string]string{
		"/v1/models": `{"object":"list","data":[
		  {"id":"deepseek/deepseek-v4-flash","label":"DeepSeek V4 Flash"},
		  {"id":"z-ai/glm-5.3-flash","is_default":true},
		  {"id":"poolside/laguna-s-2.1:free"}]}`,
	})
	c := collectorFor(registry.Service{ID: "cline", Name: "Cline-free", Port: port})
	c.key = func(string) string { return "sk-cline-abcdefghijklmnop" }

	rep := c.Access("127.0.0.1:9000")
	a := rep.Services[0]
	if a.PanelBase != "http://127.0.0.1:9000/api/svc/cline/v1" || a.LocalBase != "http://127.0.0.1:"+strconv.Itoa(port)+"/v1" {
		t.Fatalf("地址不对: %+v", a)
	}
	if !a.HasKey || a.KeyMasked != "sk-cline…" {
		t.Fatalf("密钥脱敏不对: has=%v masked=%q", a.HasKey, a.KeyMasked)
	}
	if len(a.Protocols) != 2 || a.Protocols[1] != "anthropic" {
		t.Fatalf("cline 应同时支持两种协议: %v", a.Protocols)
	}
	if !a.Running || a.ModelsErr != "" {
		t.Fatalf("运行中不该有 models_err: %+v", a)
	}
	if len(a.Models) != 3 || a.Models[0].ID != "deepseek/deepseek-v4-flash" || a.Models[0].Label != "DeepSeek V4 Flash" {
		t.Fatalf("模型解析不对: %+v", a.Models)
	}
	if a.Models[1].Note != "默认" {
		t.Fatalf("默认模型标记丢了: %+v", a.Models[1])
	}
}

func TestAccessEmptyModelsExplainsAndNonOpenAIService(t *testing.T) {
	_, port := stub(t, map[string]string{"/v1/models": `{"object":"list","data":[]}`})
	c := collectorFor(registry.Service{ID: "qoder", Name: "Qoder-free", Port: port})
	rep := c.Access("127.0.0.1:9000")
	a := rep.Services[0]
	if len(a.Models) != 0 || !strings.Contains(a.ModelsErr, "0 个模型") {
		t.Fatalf("空模型列表应给出原因: %+v", a)
	}
	if len(a.Protocols) != 1 || a.Protocols[0] != "openai" {
		t.Fatalf("qoder 只有 OpenAI 协议: %v", a.Protocols)
	}
}

func TestAccessStillWorksWhenServiceStopped(t *testing.T) {
	_, port := stub(t, map[string]string{"/v1/models": `{"object":"list","data":[{"id":"x"}]}`})
	c := collectorFor(registry.Service{ID: "cmdgo", Name: "cmdgo-bridge", Port: port})
	c.running = func(string) bool { return false }
	c.key = func(string) string { return "eb1e59269ef0bd84ab0636e43caec5e3" }

	rep := c.Access("127.0.0.1:9000")
	a := rep.Services[0]
	if a.Running {
		t.Fatalf("应标记未运行")
	}
	// 关键：服务停着也要给地址和密钥——这正是需要看接入信息的时刻
	if a.LocalBase == "" || a.PanelBase == "" || !a.HasKey || a.KeyMasked != "eb1e5926…" {
		t.Fatalf("停机时地址/密钥不能为空: %+v", a)
	}
	if !strings.Contains(a.ModelsErr, "服务未运行") {
		t.Fatalf("停机时模型列表应标注原因: %q", a.ModelsErr)
	}
}
