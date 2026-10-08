// 模型目录路径分族测试：global 账号走 /v2 家族（国际站 /console 由 openresty 直接 500，
// 面板「模型与档位」500 即出在这里），/v2 不可用时回落 /console；CN 账号逐字保持 /console。
package upstream

import (
	"strings"
	"testing"

	"net/http"

	"github.com/linguo2625469/workbuddy2api-panel/internal/auth"
)

// modelsDirBody 最小可解析目录：cli agent 的名单决定「能调哪些模型」。
const modelsDirBody = `{"code":0,"data":{` +
	`"models":[{"id":"glm-5.3","maxInputTokens":100000,"maxOutputTokens":8000}],` +
	`"agents":[{"name":"cli","models":["glm-5.3"]}]}}`

// openresty500 国际站 /console 家族的实际响应形态（HTML，非 JSON）。
const openresty500 = "<html>\r\n<head><title>500 Internal Server Error</title></head></html>"

// modelsDirClient 构造按 realm 分族的假上游：
// /v2 与 /console 各自的行为由 v2Status / consoleStatus 决定，命中的目录路径记入 hits
// （/v3/config 等旁路端点不记，避免污染路径断言）。
func modelsDirClient(v2Status, consoleStatus int) (*Client, *[]string) {
	hits := &[]string{}
	c := testClient(func(r *http.Request) (*http.Response, error) {
		if strings.HasSuffix(r.URL.Path, "/personal/models") {
			*hits = append(*hits, r.URL.Path)
		}
		switch r.URL.Path {
		case "/v2/enterprises/personal/models":
			if v2Status == 200 {
				return jsonResp(200, modelsDirBody), nil
			}
			return jsonResp(v2Status, openresty500), nil
		case "/console/enterprises/personal/models":
			if consoleStatus == 200 {
				return jsonResp(200, modelsDirBody), nil
			}
			return jsonResp(consoleStatus, openresty500), nil
		default:
			return jsonResp(500, "boom"), nil
		}
	})
	c.GlobalEnabled = true
	c.ChatBaseGlobal = "https://global.example"
	return c, hits
}

// globalAuth / cnAuth 走 realm 推断（Domain 后缀），与生产落盘形态一致。
func globalAuth() *auth.Auth {
	return &auth.Auth{AccessToken: "at", UID: "g1", Domain: "www.workbuddy.ai"}
}
func cnAuth() *auth.Auth { return &auth.Auth{AccessToken: "at", UID: "c1", Domain: "www.codebuddy.cn"} }

func TestFetchModelsGlobalUsesV2NotConsole(t *testing.T) {
	auth.SetGlobalEnabled(true)
	t.Cleanup(func() { auth.SetGlobalEnabled(true) })

	c, hits := modelsDirClient(200, 500)
	infos, err := c.FetchModels(globalAuth())
	if err != nil {
		t.Fatalf("FetchModels(global): %v", err)
	}
	if len(infos) != 1 || infos[0].ID != "glm-5.3" {
		t.Fatalf("infos=%+v want [glm-5.3]", infos)
	}
	// /v2 已 200，不得再去撞已知 500 的 /console（否则白等一次超时）。
	if len(*hits) != 1 || (*hits)[0] != "/v2/enterprises/personal/models" {
		t.Errorf("hits=%v want [/v2/enterprises/personal/models]", *hits)
	}
}

func TestFetchModelsGlobalFallsBackToConsole(t *testing.T) {
	auth.SetGlobalEnabled(true)
	t.Cleanup(func() { auth.SetGlobalEnabled(true) })

	c, hits := modelsDirClient(500, 200)
	infos, err := c.FetchModels(globalAuth())
	if err != nil {
		t.Fatalf("FetchModels(global, v2 down): %v", err)
	}
	if len(infos) != 1 || infos[0].ID != "glm-5.3" {
		t.Fatalf("infos=%+v want [glm-5.3]", infos)
	}
	want := []string{"/v2/enterprises/personal/models", "/console/enterprises/personal/models"}
	if len(*hits) != len(want) || (*hits)[0] != want[0] || (*hits)[1] != want[1] {
		t.Errorf("hits=%v want %v", *hits, want)
	}
}

// 两家族全挂：错误如实上抛（保留最后一个），调用方走静态回落。
func TestFetchModelsGlobalBothFail(t *testing.T) {
	auth.SetGlobalEnabled(true)
	t.Cleanup(func() { auth.SetGlobalEnabled(true) })

	c, hits := modelsDirClient(500, 500)
	if _, err := c.FetchModels(globalAuth()); err == nil {
		t.Fatal("want error when both families fail")
	}
	if len(*hits) != 2 {
		t.Errorf("hits=%v want both families tried", *hits)
	}
}

// CN 零回归：单路径 /console，/v2 一次都不碰。
func TestFetchModelsCNStaysOnConsoleOnly(t *testing.T) {
	c, hits := modelsDirClient(200, 200)
	infos, err := c.FetchModels(cnAuth())
	if err != nil {
		t.Fatalf("FetchModels(cn): %v", err)
	}
	if len(infos) != 1 {
		t.Fatalf("infos=%+v", infos)
	}
	if len(*hits) != 1 || (*hits)[0] != "/console/enterprises/personal/models" {
		t.Errorf("hits=%v want [/console/enterprises/personal/models]", *hits)
	}
}
