# zen-free

把 **OpenCode Zen 的匿名免费通道**包成一个本机 OpenAI 兼容服务，供 API-free 面板托管。

没有账号、没有密钥池、没有需要你填的凭据：这条免费通道的凭据就是字面量 `public`。服务监听一个回环端口，对外提供 `/v1/models` 与 `/v1/chat/completions`，只暴露上游判定为免费的模型。

> 上游与 opencode2dsh / opencode2api 是同一性质：官方 CLI 无需登录即可使用的免费通道。上游对这条通道的说明是「free tier can only be used from within OpenCode」，把它接进第三方客户端处于服务条款灰区，请自行确认后再用。不要暴露到公网。

## 快速上手

```bash
# 1) 构建（零第三方依赖，只用标准库）
cd zen-free-main
go build -o bin/zen-free.exe ./cmd/server

# 2) 上游形状自检（会真的发几个请求到 opencode.ai）
./bin/zen-free.exe -probe

# 3) 启动（首次运行自动生成 config.json 并写入随机 api_key）
./bin/zen-free.exe -config config.json

# 4) 客户端自检（需服务已在跑）
node scripts/selftest.mjs
```

服务默认监听 `127.0.0.1:8020`，地址由 `config.json` 的 `listen` 决定，`-listen` 可临时覆盖（仍强制回环）。

## 接口

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/v1/models` | 是 | 只返回免费且可路由的模型；附带 `context_window` / `max_output` / `reasoning` / `supported_efforts` |
| POST | `/v1/chat/completions` | 是 | 流式 SSE 原样透传；非流式由本服务把上游的流拼回一条 `chat.completion` |
| GET | `/healthz` | 否 | 目录状态、元数据状态、今日/累计用量、限流状态 |
| GET | `/panel/api/overview` | 否（仅回环） | 面板服务卡数据 |
| GET | `/panel/api/stats?range=30d` | 否（仅回环） | 按天用量，`series[].{key,prompt_tokens,completion_tokens,requests,failures}` |
| GET | `/panel/api/models` | 否（仅回环） | 模型表。默认只回本服务暴露的免费集；`?all=1` 回上游目录全部模型并逐个带 `exposed`/`free`/`billing`/`reason`（面板的「模型」页签用这一档，把免费与否直接标在表里） |
| GET | `/panel/api/logs` | 否（仅回环） | 内存环形日志 `entries[].{ts,ch,text}` |
| GET/POST | `/panel/api/config` | 否（仅回环） | 读取 / 保存配置（`listen` 与 `api_key` 不可在线改） |
| GET | `/` | 否 | 一页说明，供面板「打开原面板」用 |

鉴权接受 `Authorization: Bearer <api_key>` 或 `x-api-key: <api_key>`。

## 它和其他四个服务的不同

| 维度 | 本服务 |
|---|---|
| 账号池 | **没有**。匿名通道不绑账号，免费额度按出口 IP 限流 |
| 积分 | **没有**。不存在可查的余额 |
| 冷却 | 只有「上游限流中」这一种，`/panel/api/overview` 的 `rate_limited` / `rate_limit_until` 如实反映 |
| 用量 | 本服务自己记：上游在每个流式 chunk 里都带 `usage`，按天落 `data/usage.json` |
| 协议 | 只有 OpenAI Chat。不提供 `/v1/messages`（Anthropic）与 `/v1/responses` |

## 上游形状（维护这里只需要看这一节）

免费通道在 2026-09-16/17 加了两道门禁，不满足即 `403 FreeTierError`。本服务必须同时满足：

1. **会话头是官方形状** `ses_<12位hex><14位base62>`；
2. **请求体是「智能体形态」**：`stream: true`，且 `tools` 里同时有名为 `bash` 与 `read` 的函数工具。

客户端不需要知道这些：`internal/compat` 统一补上——强制流式、缺什么补什么、客户端本来没有工具时补 `tool_choice: "none"` 以免模型真去调用占位工具。代理头（`user-agent: opencode/<版本>` 与整套 `x-opencode-session` / `x-session-affinity` / `x-opencode-request` / `x-opencode-project`）同样在那里。

**上游改动时只改 `internal/compat/compat.go`**，然后跑 `bin/zen-free.exe -probe`。自检会验证四件事，其中第 3 条是「旧的 `ses_<24hex>` 形状仍被上游拒绝」——它一旦变成通过，说明门禁松动了；一旦第 2 条变成失败，说明门禁又紧了，需要对照 [opencode2dsh](https://github.com/FishBottle7/opencode2dsh) 的最新版本调整。

**逐个模型验证**：`bin/zen-free.exe -probe -verify-models`。免费通道的**单模型可用性是浮动的**（`Endpoint is unavailable`、500、偶发 429 都很常见，响应时间 1s～90s 不等），所以「哪些模型现在真能调」只能当场测：这条命令按本服务 `/v1/models` 的暴露清单，每个模型发一次极小请求，打印可用与不可用两张清单。它花的是你 IP 的配额，所以是手动跑的，不放进服务循环里。

客户端拿到的错误一律是标准 OpenAI 信封 `{"error":{"message","type","param","code"}}`，`message` 保留上游原文、`code` 是上游 HTTP 状态、`Retry-After` 原样透传，并额外带一个 `x-upstream-status` 响应头。上游自己的报错信封有两种（`{"error":{…}}` 与 `{"type":"error","error":{…}}`），直接透传会让客户端找不到 `error.message` 而显示一句笼统的「provider rejected the request」。

**客户端字段拼写也在这里归一化**：有些客户端（实测 ZCode）把工具字段发成驼峰 `toolCalls` / `toolCallId`，而上游校验严格——它看到助理轮次没有 `tool_calls`，后面的工具结果就引用了一个不存在的调用，直接回 `400 [invalid_request_error] invalid request`。`Prepare` 会把这两个字段补成蛇形（**已有的蛇形字段优先，绝不被覆盖**；客户端多出来的驼峰字段留着不管，上游会忽略）。日志里能看到 `client_fields_renamed:toolCallId+toolCalls` 这条注记。

模型目录是三级回退链：

| 级别 | 来源 | 作用 |
|---|---|---|
| S1 | 上游实时 `GET /v1/models`（5 分钟一次） | 决定「这个模型现在存在」 |
| S2 | [models.dev](https://models.dev) 的 OpenCode 条目（24 小时一次，磁盘缓存 7 天） | 决定「这个模型免费」：`cost.input == 0 && cost.output == 0`，且 `deprecated` 一票否决 |
| S3 | 编译期已验证名单（`internal/catalog/static.go`） | S1 尚未成功时的兜底，各条都带验证日期 |

判定顺序是 deprecation 优先：元数据只要还能说话就压过「名字里含 free」的兜底，否则 `deepseek-v4-flash-free` 这类已下架但仍在目录里的 id 会被名字复活。只有元数据无法发言（未就绪 / 该 id 不在 models.dev 里）时才退回名称判断。

## 面板接入

`panel/data/services.json` 里加一条：

```json
{
  "id": "zen",
  "name": "Zen-free",
  "dir": "../zen-free-main",
  "command": "bin\\zen-free.exe",
  "args": ["-config", "config.json"],
  "env": {},
  "port": 8020,
  "health": "/healthz",
  "auth": { "file": "../zen-free-main/config.json", "field": "api_key", "format": "json" }
}
```

- 面板的就绪/崩溃判定靠 TCP 端口探测，不探 `health`，所以服务必须监听固定端口。
- `auth.field` 读的是**单个字符串**字段，所以本服务的密钥是 `api_key` 而不是数组。
- 面板代理会注入真实密钥覆盖客户端自带的 `Authorization`，客户端随便填即可。

## 已知限制

- 只承载 OpenAI Chat 协议；`muse-spark*` 走 Responses 协议，默认在 `models.exclude` 里排除（面板模型表会显示原因，而不是悄悄消失）。
- 不做多出口 / IP 池。免费通道按 IP 限流，换出口属于规避限额，不在本项目范围内。
- 上游限流（429）与区域封锁（403）会原样透传给客户端，包括上游原文与 `Retry-After`。

## 致谢与许可

- [opencode2dsh](https://github.com/FishBottle7/opencode2dsh)（MIT © FishBottle7）：`internal/compat` 的会话 id 形状、门禁工具与 `reasoning_effort` 映射移植自它的 `adapter/ids.ts` 与 `adapter/messages.ts`；目录三级回退与目录判定的 deprecation-first 修正移植自它的 `legacy/internal/catalog` 与 `adapter/catalog.ts`。
- [opencode2api](https://github.com/jasonxu114514/opencode2api)：opencode2dsh 的 Go 侧是它的移植，本项目的请求形状事实链源自那里。（再分发前请自行核实其许可证。）
- 上游形状（门禁、头集合、会话形状、`reasoning_effort` 取值）由本项目在 2026-10-08 实测确认，见 `-probe` 输出。

本目录代码以 MIT 发布，与仓库其余部分一致。
