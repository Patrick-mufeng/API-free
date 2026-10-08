# Qoder-free

把 **Qoder（国内版 / 国际版）账号**变成 OpenAI 兼容 API 的本机网关，自带 Web 管理面板。

从 [cli2api](https://github.com/caigee-cmd/cli2api) 提取 Qoder 反代能力（per-account Node worker + qodercli hook），参考 [workbuddy-free](https://github.com/Patrick-mufeng/workbuddy-free) 的面板形态做的单二进制精简版。

> 仅连接你自己授权的账号、本机/私有环境使用；使用上游账号请遵守对应平台条款。

## 能力

- **OpenAI 兼容**：`POST /v1/chat/completions`（流式 SSE / 非流式）与 `GET /v1/models`，支持工具调用与推理参数透传。
- **多账号池**：加权选号、会话粘性（同一会话优先同账号）、限流/额度冷却、连续失败熔断、按账号并发上限。
- **每账号独立 worker**：一个账号一个 Node 子进程 + 独立 HOME，加载钉死版本的 qodercli（1.1.32，随 worker npm 依赖自动安装）并在内存里打 hook；崩溃自动拉起。
- **管理面板** `http://127.0.0.1:8210/panel/`：账号增删/启停、设备登录、额度查询、国内版签到、模型目录、每日用量统计、运行日志、在线配置。
- **区域路由**：模型 ID 加 `cn:` / `global:` 前缀可强制区域；无前缀则在全部就绪账号里选。

## 快速开始

要求：Go 1.25+（构建）、Node.js 22+（worker）。qodercli 不用自己装 —— 两个区域的 CLI（国际/国内，钉版 1.1.32）已是 worker 的 npm 依赖，`npm ci` 时自动装进 `worker/node_modules`，Go 侧配置留空即自动探测。

1. 构建 + 初始化：

   ```bash
   npm ci --prefix worker
   go build -o bin/qoder-free.exe ./cmd/server
   cp config.example.json config.json
   ```

   也可以直接跑 `scripts\start.ps1`（Windows）或 `./scripts/start.sh`，缺什么补什么。日常重启用
   `scripts\restart.ps1`：停止旧实例（含 worker 子进程）→ 重新构建 → 后台启动 → 健康检查，运行日志在 `logs/`。
   两个脚本均为 UTF-8 with BOM 编码，Windows PowerShell 5.1 下中文输出不会乱码。

2. 启动（工作目录必须是仓库根，worker 用相对路径）：

   ```bash
   ./bin/qoder-free.exe          # 或 scripts\start.ps1
   ```

   首次启动自动生成 `api_key` 写回 config.json 并打印在日志里。

3. 打开 `http://127.0.0.1:8210/panel/`，输入 API key，**添加账号 → 登录**（设备授权）→ 等 worker 就绪。

4. 客户端接入：

   ```text
   Base URL: http://127.0.0.1:8210/v1
   API Key:  <config.json 的 api_key>
   ```

## 配置项（config.json，QF_* 环境变量可覆盖）

| 键 | 默认 | 说明 |
|---|---|---|
| `listen` | `127.0.0.1:8210` | 监听地址，不要暴露公网 |
| `api_key` | 自动生成 | `/v1/*` 与 `/panel/api/*` 共用 |
| `data_dir` | `./data` | 账号注册、账号 HOME、状态与统计 |
| `worker_base_port` | `33100` | 每账号 worker 端口从此起分配 |
| `qoder_cli_js` / `qoder_cn_cli_js` | 自动探测 | qodercli bundle 绝对路径（国际/国内）；留空则自动探测 `worker/node_modules` 里的 npm 安装版。只想要一个区域的话可从 `worker/package.json` 删掉另一个包（省约 60MB） |
| `max_retry_accounts` | `3` | 单次聊天请求最多轮换几个账号 |
| `max_in_flight` | `4` | 账号默认并发上限 |
| `cooldown_soft_seconds` | `600` | 限流冷却基数（指数退避，上限 `cooldown_soft_max_seconds`） |
| `breaker_threshold` | `3` | 连续失败触发熔断次数 |
| `session_sticky` | `true` | 会话粘性（TTL `session_ttl_seconds`） |
| `stats_enabled` | `true` | 按天 token 统计（`data/stats.json`） |
| `proxy_url` | 空 | 传给 worker 的上游代理 |

## 目录结构

```
cmd/server/          进程组装
internal/config/     配置加载（文件 + QF_* env）
internal/accounts/   账号注册表（data/accounts/*.json）
internal/pool/       选号 / 粘性 / 冷却 / 熔断（data/state.json）
internal/worker/     worker 生命周期管理 + worker HTTP 契约客户端
internal/relay/      SSE 直通 + usage 抓取
internal/stats/      按天用量统计
internal/server/     OpenAI 兼容路由、鉴权、轮换
internal/panel/      内嵌管理面板（go:embed index.html + app.js）
worker/              每账号 Node daemon（自 cli2api 提取，含 compat 钉版）
data/homes/<id>/     账号 HOME：凭证与 qodercli 状态都在 .qoder[-cn] 内
```

## 凭证说明

账号凭证（token、machine_id）只存在于 `data/homes/<账号ID>/.qoder[-cn]/` 内，由 worker（qodercli）自己读写；Go 侧不落盘任何 token。备份账号 = 备份该目录；面板「删除账号」只移除注册信息，不删数据目录。

## 版本与发布

- 版本号定义在 `internal/panel/panel.go` 的 `Version`，面板和启动日志都会显示；构建时可用
  `go build -ldflags "-X qoder-free/internal/panel.Version=vX.Y.Z"` 注入覆盖。
- 发布流程：更新 `CHANGELOG.md` → 提交 → `git tag -a vX.Y.Z -m "..."` → 推送 `main` 和标签 →
  GitHub Releases 附上按上述 ldflags 构建的二进制。
- 行尾约定：仓库内容统一 LF（见 `.gitattributes`），`*.ps1`/`*.bat` 为 CRLF，提交前无需手工转换。

## 与 cli2api / workbuddy-free 的关系

- worker 目录（daemon.mjs / compat.mjs / sse.mjs / plaintext.mjs 等）原样取自 cli2api，协议契约一致：`/health`、`/v1/chat/completions`、`/admin/{models,quota,login,checkin}`。
- 面板与账号池形态参考 workbuddy-free：单二进制、go:embed 前端、无外部依赖（本项目连 Redis 镜像也省了）。
- 没有实现的：Anthropic/Responses 接口、任务中心、Redis 镜像、多租户。需要更强的调度与合规边界请用 cli2api。
