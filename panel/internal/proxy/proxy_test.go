package proxy

import (
	"bytes"
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"api-free/panel/internal/registry"
)

// regFor 用内存注册表指向假上游（registry.File 没有内存构造器，
// 直接摆结构体字面量即可）。
func regFor(services ...registry.Service) *registry.File {
	return &registry.File{Services: services}
}

// portOfURL 把 httptest 的 URL 换成端口号。
func portOfURL(raw string) (int, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return 0, err
	}
	return strconv.Atoi(u.Port())
}

func itoa(i int) string { return strconv.Itoa(i) }

// newTestProxy 起一个假上游（返回可改写的 HTML/JS），返回指向它的代理。
func newTestProxy(t *testing.T, id, upstreamBody, contentType string) (*Proxy, *httptest.Server) {
	t.Helper()
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", contentType)
		_, _ = w.Write([]byte(upstreamBody))
	}))
	t.Cleanup(up.Close)

	port, err := portOfURL(up.URL)
	if err != nil {
		t.Fatal(err)
	}
	reg := regFor(registry.Service{ID: id, Name: id, Port: port})
	p := New(reg, "")
	return p, up
}

// TestProxyInjectsKey 代理必须把注册表里的密钥注入 Authorization。
//
// 这条同时解释了「原面板不显示账号」的第二层原因：workbuddy/cline 的接口要
// 鉴权，而它们的原面板是让**用户手动粘一次密钥**存进浏览器 localStorage
// （每个源各存一份）。经代理打开时那一格是空的——由代理兜住。
func TestProxyInjectsKey(t *testing.T) {
	var gotAuth string
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer up.Close()
	port, err := portOfURL(up.URL)
	if err != nil {
		t.Fatal(err)
	}

	dir := t.TempDir()
	keyFile := filepath.Join(dir, "config.json")
	if err := os.WriteFile(keyFile, []byte(`{"api_key":"secret-k"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	reg := regFor(registry.Service{
		ID: "workbuddy", Name: "workbuddy", Port: port,
		Auth: &registry.Auth{File: keyFile, Field: "api_key", Format: "json"},
	})
	p := New(reg, "")
	rec := httptest.NewRecorder()
	p.ServeHTTP(rec, httptest.NewRequest("GET", "/api/svc/workbuddy/panel/api/overview", nil))
	if gotAuth != "Bearer secret-k" {
		t.Fatalf("Authorization = %q, want %q", gotAuth, "Bearer secret-k")
	}
}

// TestRootPathBothForms 根路径两种写法都必须能打开原面板。
//
// 回归：早先 `tail == "" && r.URL.Path != "/api/svc/"+id` 把**带尾斜杠**的
// 根路径判成未知服务，而统一面板「打开原面板 ↗」生成的链接恰好是
// /api/svc/{id}/ ——四个服务的原面板入口因此全是 404。
func TestRootPathBothForms(t *testing.T) {
	for _, path := range []string{"/api/svc/cmdgo", "/api/svc/cmdgo/"} {
		p, _ := newTestProxy(t, "cmdgo", "<html>ok</html>", "text/html; charset=utf-8")
		rec := httptest.NewRecorder()
		p.ServeHTTP(rec, httptest.NewRequest("GET", path, nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: got %d, want 200", path, rec.Code)
		}
		if !strings.Contains(rec.Body.String(), "ok") {
			t.Fatalf("%s: body not forwarded: %q", path, rec.Body.String())
		}
	}
}

// TestRewritePanelAbsolutePaths 原面板的绝对路径要被改写成经代理的写法。
// 这就是「原面板不显示账号」的根因：/panel/api/* 打到面板自己身上拿到 HTML。
func TestRewritePanelAbsolutePaths(t *testing.T) {
	cases := []struct {
		id, body, want, notWant string
	}{
		{"workbuddy", `async function api(p){ return fetch('/panel/api/' + p) }`,
			`fetch('/api/svc/workbuddy/panel/api/' + p)`, `fetch('/panel/api/`},
		{"qoder", `const r = await fetch("/panel/api/" + path)`,
			`fetch("/api/svc/qoder/panel/api/" + path)`, `fetch("/panel/api/`},
		{"cline", `fetch("/v1/status")`,
			`fetch("/api/svc/cline/v1/status")`, `fetch("/v1/status")`},
		{"cline", `function baseUrl(){ return location.origin+"/v1"; }`,
			`location.origin+"/api/svc/cline/v1"`, `location.origin+"/v1"`},
		{"cmdgo", `function api(path){ return fetch('/api' + path) }`,
			`fetch('/api/svc/cmdgo/api' + path)`, `fetch('/api' + path`},
	}
	for _, c := range cases {
		p, _ := newTestProxy(t, c.id, c.body, "application/javascript")
		rec := httptest.NewRecorder()
		p.ServeHTTP(rec, httptest.NewRequest("GET", "/api/svc/"+c.id+"/panel/app.js", nil))
		got := rec.Body.String()
		if !strings.Contains(got, c.want) {
			t.Errorf("%s: want %q in body, got %q", c.id, c.want, got)
		}
		if strings.Contains(got, c.notWant) {
			t.Errorf("%s: %q should have been rewritten away, got %q", c.id, c.notWant, got)
		}
	}
}

// TestClineProseNotRewritten 改写只认调用点，不能碰正文里的协议说明。
// cline 控制台的接入文档里就有 `/v1/messages`、`/v1/models` 这类散文。
func TestClineProseNotRewritten(t *testing.T) {
	body := `<p>同时支持 OpenAI（<code>/v1/chat/completions</code>）与 Anthropic（<code>/v1/messages</code>）</p>` +
		`<button title="从 /v1/models 里撤下">移除</button>`
	p, _ := newTestProxy(t, "cline", body, "text/html; charset=utf-8")
	rec := httptest.NewRecorder()
	p.ServeHTTP(rec, httptest.NewRequest("GET", "/api/svc/cline/", nil))
	if got := rec.Body.String(); got != body {
		t.Errorf("prose must be left intact, got %q", got)
	}
}

// TestJSONNotRewritten 只有页面/脚本才改写；JSON（接口数据）必须原样透传。
func TestJSONNotRewritten(t *testing.T) {
	body := `{"note":"call fetch('/panel/api/overview') to read accounts"}`
	p, _ := newTestProxy(t, "workbuddy", body, "application/json")
	rec := httptest.NewRecorder()
	p.ServeHTTP(rec, httptest.NewRequest("GET", "/api/svc/workbuddy/panel/api/overview", nil))
	if got := rec.Body.String(); got != body {
		t.Errorf("JSON body must pass through unchanged, got %q", got)
	}
}

// TestGzipAssetDecompressedAndRewritten 上游对脚本返回 gzip 时，
// 代理也要能解压并完成改写。
//
// 做法：对资产型路径主动去掉出站 Accept-Encoding，Go 的 Transport 于是自行
// 协商 gzip 并**透明解压**，改写逻辑拿到的是明文。若不去掉，压缩字节既没法
// 做字符串替换、又会让 Content-Encoding 与改写后的长度互相冲突。
//
// 注意别用「手写 \x1f\x8b 头」模拟压缩字节：Transport 见到 gzip 头会自己解，
// 解不开就报 proxy error 并给空 body —— 那测的是 net/http 而不是我们的逻辑。
func TestGzipAssetDecompressedAndRewritten(t *testing.T) {
	const plain = `fetch("/v1/status")`
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	if _, err := zw.Write([]byte(plain)); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	payload := buf.Bytes()

	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/javascript")
		if strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
			w.Header().Set("Content-Encoding", "gzip")
			_, _ = w.Write(payload)
			return
		}
		_, _ = w.Write([]byte(plain))
	}))
	defer up.Close()
	port, err := portOfURL(up.URL)
	if err != nil {
		t.Fatal(err)
	}
	reg := regFor(registry.Service{ID: "cline", Name: "cline", Port: port})
	p := New(reg, "")

	// 客户端声明接受 gzip —— 代理仍要去掉这个头，保证自己拿到可改写的明文。
	req := httptest.NewRequest("GET", "/api/svc/cline/app.js", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	rec := httptest.NewRecorder()
	p.ServeHTTP(rec, req)

	got := rec.Body.String()
	if strings.Contains(got, `fetch("/v1/status")`) {
		t.Errorf("absolute path should have been rewritten away, got %q", got)
	}
	if !strings.Contains(got, `fetch("/api/svc/cline/v1/status")`) {
		t.Errorf("want rewritten path in body, got %q", got)
	}
}

// TestConcurrentRequestsNotCrossed 并发请求不能串号。
//
// 回归：曾经把 tail 写进 ReverseProxy.Director 闭包——那个字段是**共享**的，
// 两个并发请求会互相覆盖，随机拿到对方的目标路径。
func TestConcurrentRequestsNotCrossed(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(r.URL.Path))
	}))
	defer up.Close()
	port, err := portOfURL(up.URL)
	if err != nil {
		t.Fatal(err)
	}
	reg := regFor(registry.Service{ID: "s", Name: "s", Port: port})
	p := New(reg, "")

	const n = 60
	errs := make(chan error, n)
	for i := 0; i < n; i++ {
		go func(i int) {
			want := "/path-" + itoa(i)
			rec := httptest.NewRecorder()
			p.ServeHTTP(rec, httptest.NewRequest("GET", "/api/svc/s"+want, nil))
			if got := rec.Body.String(); got != want {
				errs <- &crossErr{got: got, want: want}
				return
			}
			errs <- nil
		}(i)
	}
	for i := 0; i < n; i++ {
		if err := <-errs; err != nil {
			t.Fatal(err)
		}
	}
}

type crossErr struct{ got, want string }

func (e *crossErr) Error() string { return "request crossed: got " + e.got + ", want " + e.want }

// TestStreamingNotBuffered 流式响应不能被改写逻辑读进内存（会憋住 SSE）。
func TestStreamingNotBuffered(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "data: {\"a\":1}\n\n")
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
	}))
	defer up.Close()
	port, err := portOfURL(up.URL)
	if err != nil {
		t.Fatal(err)
	}
	reg := regFor(registry.Service{ID: "cline", Name: "cline", Port: port})
	p := New(reg, "")
	rec := httptest.NewRecorder()
	p.ServeHTTP(rec, httptest.NewRequest("GET", "/api/svc/cline/v1/chat/completions", nil))
	if got := rec.Body.String(); !strings.Contains(got, "data: {\"a\":1}") {
		t.Errorf("SSE body must pass through, got %q", got)
	}
}
