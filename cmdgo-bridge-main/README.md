# cmdgo-bridge

把 **Command Code Go 套餐**接入任意 Agent 工具的本地桥接服务。

Command Code 的订阅分两种:标准 Provider API(OpenAI 兼容,任何工具可直连)和 **Go 套餐**($1/月)。Go 套餐调官方 OpenAI 端点返回 `403 upgrade_required`,只能走 CLI 私有网关 `POST /alpha/generate`。本项目把 Go 订阅包装成 **OpenAI 兼容 API**——Cherry Studio、Cline、Roo Code、Continue、Cursor、ZCode 等所有支持自定义 OpenAI 端点的工具都能直接用,自带 Web 控制台完成 OAuth 登录与多账号池管理。

## 功能特性

- **OpenAI 兼容 API**:`POST /v1/chat/completions`(流式 / 非流式)、`GET /v1/models`,支持工具调用、`reasoning_effort`、`max_tokens`、`temperature` / `top_p`
- **OAuth 登录**:控制台一键生成登录地址,浏览器授权后 API key 自动回收入池,免手动复制
- **多账号池**:每完成一次登录新 key 自动成为独立账号,请求级 round-robin 摊薄额度;失败(401/403/429/5xx/网络错误)自动指数冷却并故障转移,绝不重放半截回答
- **模型目录同步**:自动从官方目录拉取 Go 套餐可用模型(含 reasoning effort 元数据),15 分钟刷新
- **自带 Web 控制台**:登录、凭据、账号池、模型列表一目了然,零配置上手
- **零依赖桥**:无需 DSH / 任何框架,Node ≥ 20 即可运行,数据落盘在用户目录

## 界面预览

![控制台](assets/console.png)

## 快速开始

### 1. 前置条件

- **Node.js ≥ 20.3**(含 `npm`),验证:`node --version`

### 2. 获取项目

```sh
git clone https://github.com/Patrick-mufeng/cmdgo-bridge.git
cd cmdgo-bridge
```

或者直接下载仓库 ZIP 并解压。

### 3. 安装依赖并构建

```sh
npm install
npm run build
```

### 4. 启动

**Windows**:双击 `start.cmd`(保持窗口开启即在线,关闭即停止)。

**任意平台**(命令行):

```sh
npm start              # 或: node dist/index.js
```

首次启动自动生成配置,终端会打印类似:

```
OpenAI 端点: http://127.0.0.1:11435/v1
客户端 API key: 4e80cd8cbac4c07ab03db0afc95fdb5c1d0d9f9f22d073f7
```

### 5. 完成 OAuth 登录

1. 浏览器打开 **http://127.0.0.1:11435/**
2. 点「**▸ 发起登录**」→ 出现登录地址,点「**打开登录页 ↗**」
3. 在 Command Code 授权页确认,浏览器会把 API key 回传给本机
4. 控制台状态变为「**✓ 授权成功**」,账号出现在账号池(状态 `READY`)

### 6. 在 Agent 工具中配置

任意 OpenAI 兼容客户端,填三项:

| 配置项 | 值 |
| --- | --- |
| Base URL | `http://127.0.0.1:11435/v1` |
| API Key | 终端打印的 key(或控制台 CONFIG 区查看/复制) |
| 模型 ID | 控制台 MODELS 区列出的模型,点击即复制(如 `deepseek/deepseek-v4-pro`) |

验证连通:

```sh
curl http://127.0.0.1:11435/v1/chat/completions \
  -H "Authorization: Bearer <你的API Key>" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek/deepseek-v4-pro","messages":[{"role":"user","content":"你好"}]}'
```

各家工具接入举例:

- **ZCode / Cherry Studio / NextChat / LobeChat**:新增 OpenAI 兼容供应商,填上表三项即可
- **Cline / Roo Code**:OpenAI Compatible 供应商,Base URL 填 `http://127.0.0.1:11435/v1`
- **Cursor**:Settings → Models → OpenAI API Key 填 bridge key,并覆写 Base URL 为 `http://127.0.0.1:11435/v1`
- **Continue**:config.json 里加 `{"provider":"openai","apiBase":"http://127.0.0.1:11435/v1",...}`

## 多账号池

每完成一次 OAuth 登录,新 key 自动成为池中一个独立账号(元数据落在数据目录 `accounts.json`,key 在 `credentials.json`);重复登录同一 key 只刷新标签。

- 请求级 **round-robin** 调度;某账号失败按指数冷却(30s 起、封顶 15min),当次请求内自动切换下一账号
- 控制台可**停用 / 启用 / 移除**单个账号,「清空账号池」清空全部

## 配置

数据目录默认 `~/.cmdgo-bridge/`(可用 `--data-dir` 指定),`config.json` 首次启动自动生成:

| 配置项 | 默认 | 说明 |
| --- | --- | --- |
| `host` | `127.0.0.1` | 监听地址;`0.0.0.0` 局域网共享时 `/v1` 靠 API key 鉴权,控制台 `/api` 无鉴权请注意 |
| `port` | `11435` | 监听端口 |
| `baseURL` | `https://api.commandcode.ai` | 网关 base,`/alpha/generate` 自动追加 |
| `apiKey` | 随机生成 | 客户端 Bearer token(改动手动写入需 ≥8 字符) |
| `maxTokens` | `64000` | 单次输出上限 |
| `defaultContextWindow` | `1000000` | 模型无精确上下文时的兜底 |

命令行参数:`--host <addr>`、`--port <port>`、`--data-dir <dir>`、`--help`。注意:`--host` / `--port` 会**写回 `config.json` 持久化**,下次启动继续生效。

## API 端点

| 端点 | 鉴权 | 说明 |
| --- | --- | --- |
| `GET /v1/models` | Bearer | 模型列表 |
| `POST /v1/chat/completions` | Bearer | 对话补全(流式 / 非流式) |
| `GET /health` | 无 | 健康检查 |
| `GET /` | 无 | 控制台页面 |
| `GET /api/status` | 无(仅回环) | 登录 / 账号 / 模型状态快照 |
| `POST /api/login` `cancel` `logout` | 无(仅回环) | 登录生命周期 |
| `POST /api/account/toggle` `remove` | 无(仅回环) | 账号管理 |

## 本地联调(无需真实订阅)

`scripts/mock-gateway.mjs` 模拟官方网关,可完整走通流式、工具调用、多账号故障转移:

```sh
npm run mock                                   # 模拟网关 http://127.0.0.1:18999
node dist/index.js --data-dir /tmp/bridge-test # 然后改该目录 config.json 的 baseURL 为 http://127.0.0.1:18999
```

mock 接受 `user_goodkey`(成功)/ `user_failkey`(403 测故障转移)/ `user_noplan`(`MODEL_NOT_IN_PLAN`),登录回调时填这些 key 即可。

## 排错

| 现象 | 原因与处理 |
| --- | --- |
| 启动报「端口已被占用」 | 已有实例在运行(可能上次的窗口没关),关掉旧窗口或用 `--port` 换端口 |
| 对话报 `401 invalid_api_key` | Agent 工具里填的 key 与终端打印的不一致,去控制台 CONFIG 区复制 |
| 对话报 `401 MISSING_CREDENTIAL` | 还没完成 OAuth 登录,先到控制台「发起登录」 |
| 模型列表为空 | 目录来自 `https://api.commandcode.ai/provider/v1/models`(免鉴权),检查网络;日志会告警并 15 分钟后重试 |
| 「重新连接 / 超时」 | 桥没在运行(关窗即停);或请求体超过 8MB 上限 | 
| 连不上 11435(端口变了) | 检查 `~/.cmdgo-bridge/config.json` 的 `port`(`--port` 启动会写回并持久化) | 
| 控制台登录后收不到回调 | 回调服务器绑定 `127.0.0.1:5959..5968`;浏览器与宿主不同机时需端口转发/SSH 隧道 |
| 想排查问题 | 每次请求都记录在启动窗口与 `~/.cmdgo-bridge/access.log`(方法/路径/状态码/耗时),聊天另有 model/账号/结果明细 |

## 工作原理

请求指纹完整对齐官方 CLI(`commandcode/<版本>` UA + `x-command-code-version` / `x-cli-environment` / `x-session-id` / `x-project-slug`),请求信封与 NDJSON 事件流解析参考了 [commandcode-proxy](https://github.com/MAXeaglet/commandcode-proxy) 与 [cmdcode2api](https://github.com/synthetic-coworkers/cmdcode2api)。

> ⚠️ 非官方项目,仅限个人使用;请遵守 Command Code 服务条款。