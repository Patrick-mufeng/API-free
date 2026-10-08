// Package proxy /api/svc/{id}/* → 127.0.0.1:{port}/* 反向代理，
// 按注册表的 Auth 配置读取各服务 api_key 并注入 Authorization: Bearer。
// FlushInterval<0 保证 SSE/流式直通。
//
// 另外负责「让原面板经代理也能正常工作」：四个原面板的前端都用**绝对路径**
// 请求自己的接口（workbuddy/qoder 是 /panel/api/*，cline 是 /v1/*，
// cmdgo 是 /api/*）。经代理打开时页面源是面板（:9000），这些绝对路径会打到
// 面板自己身上——面板的 SPA 兜底会返回 200 + HTML，原面板 r.json() 解析失败，
// 于是**静默**显示成空账号空列表（不报错，最难查）。所以这里对原面板的
// HTML/JS 资产做锚定字符串改写，把那些绝对路径指到 /api/svc/{id}/ 下。
package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httputil"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"api-free/panel/internal/registry"
)

type cacheEntry struct {
	key string
	at  time.Time
}

// target 是本次请求要转发到的上游位置。放进 request context，
// 由每个服务共用的那个 ReverseProxy 的 Rewrite 读取。
//
// 为什么不用「每请求重设 Director」的老写法：每个服务只建一个 ReverseProxy
// 并长期缓存，而 Director 是**该对象上的字段**——并发请求会互相覆盖对方的
// Director 闭包（A 请求把 tail 设成 /panel/api/overview、B 请求设成
// /panel/api/logs，两者用的是同一个函数变量），结果是随机的串号。
// 走 context 就没有共享可变状态。
type targetKeyType struct{}

var targetKey targetKeyType

type target struct {
	port int
	path string
}

// 各服务原面板资产的路径改写规则（左＝面板源码里的原文，右＝经代理可用的写法）。
// 只锚定调用点，不碰正文里的说明文字——cline 控制台的接入示例里就有
// `/v1/messages`、`/v1/models` 这类**散文**，盲目替换会把它改成错的。
var panelRewrites = map[string][][2]string{
	"workbuddy": {
		{"fetch('/panel/api/", "fetch('/api/svc/workbuddy/panel/api/"},
	},
	"qoder": {
		{`fetch("/panel/api/`, `fetch("/api/svc/qoder/panel/api/`},
	},
	"cline": {
		{`fetch("/v1/`, `fetch("/api/svc/cline/v1/`},
		{`location.origin+"/v1"`, `location.origin+"/api/svc/cline/v1"`},
	},
	"cmdgo": {
		{"fetch('/api' + path", "fetch('/api/svc/cmdgo/api' + path"},
	},
}

type Proxy struct {
	reg       *registry.File
	panelRoot string
	mu        sync.Mutex
	proxies   map[string]*httputil.ReverseProxy
	keys      map[string]cacheEntry
}

func New(reg *registry.File, panelRoot string) *Proxy {
	return &Proxy{reg: reg, panelRoot: panelRoot, proxies: map[string]*httputil.ReverseProxy{}, keys: map[string]cacheEntry{}}
}

func (p *Proxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// 路径形如 /api/svc/{id}/rest/of/path
	rest := strings.TrimPrefix(r.URL.Path, "/api/svc/")
	id, tail, _ := strings.Cut(rest, "/")
	if _, ok := p.reg.Get(id); !ok {
		http.Error(w, `{"error":"unknown_service"}`, http.StatusNotFound)
		return
	}
	// 注意：tail 为空是合法的（/api/svc/{id} 与 /api/svc/{id}/ 都指向上游根路径）。
	// 早先这里额外判了「带尾斜杠就 404」，把原面板的「打开原面板 ↗」
	// （链接正是 /api/svc/{id}/）直接挡在门外——实测四个服务全 404。

	proxy := p.proxyFor(id)
	r = r.WithContext(context.WithValue(r.Context(), targetKey, target{port: p.portOf(id), path: "/" + tail}))
	proxy.ServeHTTP(w, r)
}

func (p *Proxy) portOf(id string) int {
	if svc, ok := p.reg.Get(id); ok {
		return svc.Port
	}
	return 0
}

// proxyFor 返回该服务共用的反向代理（按 id 缓存）。
func (p *Proxy) proxyFor(id string) *httputil.ReverseProxy {
	p.mu.Lock()
	defer p.mu.Unlock()
	if pr := p.proxies[id]; pr != nil {
		return pr
	}
	rules := panelRewrites[id]
	pr := &httputil.ReverseProxy{
		FlushInterval: -1, // SSE/流式立即刷出
		Rewrite: func(req *httputil.ProxyRequest) {
			t, _ := req.In.Context().Value(targetKey).(target)
			req.Out.URL.Scheme = "http"
			req.Out.URL.Host = "127.0.0.1:" + strconv.Itoa(t.port)
			req.Out.URL.Path = t.path
			req.Out.Host = req.Out.URL.Host
			// 资产请求要保证上游不压缩：压缩后的字节没法做字符串改写。
			// 只对资产型路径去掉 Accept-Encoding，接口/流式请求保持不变。
			if isAssetish(t.path) {
				req.Out.Header.Del("Accept-Encoding")
			}
			if svc, ok := p.reg.Get(id); ok && svc.Auth != nil {
				if key := p.keyFor(id, *svc.Auth); key != "" {
					// 客户端自己带没带 key 都会被真钥覆盖：原面板要求用户手填密钥，
					// 经代理打开时那一格是空的，由这里兜住。
					req.Out.Header.Set("Authorization", "Bearer "+key)
				}
			}
		},
	}
	if len(rules) > 0 {
		pr.ModifyResponse = func(resp *http.Response) error {
			return rewritePanelAsset(resp, rules)
		}
	}
	p.proxies[id] = pr
	return pr
}

// isAssetish 判断是不是原面板的页面/脚本（这几类才需要改写路径）。
func isAssetish(path string) bool {
	if path == "" || path == "/" || strings.HasSuffix(path, "/") {
		return true
	}
	for _, ext := range []string{".js", ".html", ".css"} {
		if strings.HasSuffix(path, ext) {
			return true
		}
	}
	return false
}

func isRewritableContentType(ct string) bool {
	return strings.Contains(ct, "text/html") ||
		strings.Contains(ct, "javascript") ||
		strings.Contains(ct, "ecmascript")
}

// rewritePanelAsset 把上游返回的页面/脚本里的绝对接口路径改成经代理的写法。
// 只在「纯文本 + 未压缩」时动手；JSON、SSE、图片一律原样放过。
func rewritePanelAsset(resp *http.Response, rules [][2]string) error {
	if !isRewritableContentType(resp.Header.Get("Content-Type")) {
		return nil
	}
	if resp.Header.Get("Content-Encoding") != "" {
		return nil
	}
	body, err := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if err != nil {
		return err
	}
	out := body
	for _, rule := range rules {
		if bytes.Contains(out, []byte(rule[0])) {
			out = bytes.ReplaceAll(out, []byte(rule[0]), []byte(rule[1]))
		}
	}
	if bytes.Equal(out, body) {
		resp.Body = io.NopCloser(bytes.NewReader(body))
		return nil
	}
	resp.Body = io.NopCloser(bytes.NewReader(out))
	resp.ContentLength = int64(len(out))
	resp.Header.Set("Content-Length", strconv.Itoa(len(out)))
	return nil
}

// KeyFor 返回该服务当前有效的 api_key。服务端其他聚合模块（如 internal/svcinfo）
// 复用这里的读取与 30s 缓存，避免各处重复实现鉴权。
func (p *Proxy) KeyFor(id string) string {
	svc, ok := p.reg.Get(id)
	if !ok || svc.Auth == nil {
		return ""
	}
	return p.keyFor(id, *svc.Auth)
}

func (p *Proxy) keyFor(id string, auth registry.Auth) string {
	p.mu.Lock()
	if c, ok := p.keys[id]; ok && time.Since(c.at) < 30*time.Second {
		p.mu.Unlock()
		return c.key
	}
	p.mu.Unlock()

	key := readKey(auth, p.panelRoot)
	p.mu.Lock()
	p.keys[id] = cacheEntry{key: key, at: time.Now()}
	p.mu.Unlock()
	return key
}

func readKey(auth registry.Auth, panelRoot string) string {
	path := auth.File
	if strings.HasPrefix(path, "~") {
		if home, err := os.UserHomeDir(); err == nil {
			path = filepath.Join(home, path[1:])
		}
	} else if !filepath.IsAbs(path) {
		path = filepath.Join(panelRoot, path)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	if auth.Format == "env" {
		for _, line := range strings.Split(string(b), "\n") {
			line = strings.TrimSpace(line)
			if strings.HasPrefix(line, auth.Field+"=") {
				return strings.Trim(strings.TrimPrefix(line, auth.Field+"="), `"' `)
			}
		}
		return ""
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		return ""
	}
	if v, ok := m[auth.Field].(string); ok {
		return v
	}
	return ""
}
