// 接入信息：把「怎么调用这个服务」需要的东西一次给全——地址、密钥、协议、模型列表。
// 密钥只出脱敏值，明文由 server 层单独提供（带回环地址保护）。
package svcinfo

import (
	"fmt"
	"time"

	"api-free/panel/internal/registry"
)

// Model 一个可调用的模型；Label/Note 只有部分服务提供。
type Model struct {
	ID    string `json:"id"`
	Label string `json:"label,omitempty"`
	Note  string `json:"note,omitempty"`
}

type Access struct {
	Svc       string   `json:"svc"`
	Name      string   `json:"name"`
	Port      int      `json:"port"`
	PanelBase string   `json:"panel_base"` // http://<面板地址>/api/svc/<id>/v1
	LocalBase string   `json:"local_base"` // http://127.0.0.1:<port>/v1
	HasKey    bool     `json:"has_key"`
	KeyMasked string   `json:"key_masked"`
	Protocols []string `json:"protocols"` // openai | anthropic
	Models    []Model  `json:"models"`
	ModelsErr string   `json:"models_err,omitempty"`
	Running   bool     `json:"running"`
}

type AccessReport struct {
	At       string   `json:"at"`
	Services []Access `json:"services"`
}

// Access 汇总各服务的接入信息。panelHost 是浏览器访问面板用的 Host，
// 用来拼「经面板」的地址；服务没在跑也照样返回地址与密钥（这正是最需要看它的时刻），
// 只有模型列表会标注原因。
func (c *Collector) Access(panelHost string) AccessReport {
	rep := AccessReport{At: time.Now().Format("15:04:05"), Services: []Access{}}
	for _, svc := range c.reg.Services {
		key := ""
		if c.key != nil {
			key = c.key(svc.ID)
		}
		a := Access{
			Svc:       svc.ID,
			Name:      svc.Name,
			Port:      svc.Port,
			PanelBase: panelBase(panelHost, svc.ID),
			LocalBase: fmt.Sprintf("http://127.0.0.1:%d/v1", svc.Port),
			HasKey:    key != "",
			KeyMasked: maskKey(key),
			Protocols: protocolsFor(svc.ID),
			Running:   c.running == nil || c.running(svc.ID),
		}
		if a.Running {
			a.Models, a.ModelsErr = c.models(svc)
		} else {
			a.Models = []Model{}
			a.ModelsErr = "服务未运行：启动后这里会列出它 /v1/models 的内容"
		}
		rep.Services = append(rep.Services, a)
	}
	return rep
}

// models 各家 /v1/models 都是 OpenAI 列表格式，只取 id（cline 另有 label 与默认标记）。
func (c *Collector) models(svc registry.Service) ([]Model, string) {
	doc, err := c.get(svc, "/v1/models")
	if err != nil {
		return []Model{}, err.Error()
	}
	out := []Model{}
	for _, raw := range asList(doc["data"]) {
		m := asMap(raw)
		id := asStr(m["id"])
		if id == "" {
			continue
		}
		item := Model{ID: id, Label: asStr(m["label"])}
		if asBool(m["is_default"]) {
			item.Note = "默认"
		}
		out = append(out, item)
	}
	if len(out) == 0 {
		return out, "服务返回 0 个模型：通常是没有可用账号（先在「账号」页签登录）"
	}
	return out, ""
}

func protocolsFor(id string) []string {
	if id == "cline" {
		return []string{"openai", "anthropic"} // cline 同时提供 /v1/chat/completions 与 /v1/messages
	}
	return []string{"openai"}
}

func panelBase(host, id string) string {
	if host == "" {
		host = "127.0.0.1:9000"
	}
	return "http://" + host + "/api/svc/" + id + "/v1"
}

// maskKey 脱敏：保留前 8 位（与原面板一致）。空值返回空串；
// 按 rune 切，避免把多字节字符截断，短钥也不会越界。
func maskKey(k string) string {
	if k == "" {
		return ""
	}
	r := []rune(k)
	switch {
	case len(r) <= 2:
		return "…"
	case len(r) <= 10:
		return string(r[:2]) + "…"
	default:
		return string(r[:8]) + "…"
	}
}
