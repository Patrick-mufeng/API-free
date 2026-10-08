# cline-free

把 Cline（https://cline.bot）的免费模型能力转成 OpenAI / Anthropic 兼容 API，
**在本机跑起来就能用**，不用部署、不用花钱。

> 📌 作者 **Patrick** · 公众号 **AI实用talk** · 仓库 [Patrick-mufeng/cline-free](https://github.com/Patrick-mufeng/cline-free)
>
> 本项目也可以部署成在线服务（Cloudflare Workers / Vercel），见 [docs/部署到云端.md](docs/部署到云端.md)。

---

## 快速开始

### 第 0 步：装 Node.js

需要 **Node.js 22 或更高**（项目用 ESM 写法但没放 `package.json`，依赖 22+ 的语法自动探测）。
去 [nodejs.org](https://nodejs.org/) 下载 LTS 版装上，然后验证：

```bash
node -v      # 应该显示 v22.x.x 或更高
```

> 这一步是唯一的前置条件。项目**没有任何依赖要装**，不需要 `npm install`。

### 第 1 步：启动

在本项目目录下，按系统选一种：

| 系统 | 怎么启动 |
|---|---|
| **Windows** | **双击 `start.bat`** |
| **Linux / macOS** | `./start.sh` |
| 任意系统（通用） | `node start.mjs` |

> 💡 Windows 用户双击就行，不用先开终端。窗口不会一闪而过（脚本会等你按键）。
>
> ⚠️ **别直接双击 `local-server.js`**——它没有图形界面，双击只会闪一下。
> 用上面三个启动脚本之一。

**成功时会看到：**

```
================================================================
  cline-free 本地服务启动器
================================================================

[1/3] Node.js v24.15.0
[2/3] 已由 .env.local.example 创建 .env.local
[3/3] [提示] .env.local 里的 CLINE_REFRESH_TOKEN 还是空的
      ...（下一步解决，不影响启动）

================================================================
cline-free 本地服务
================================================================
CLINE_REFRESH_TOKEN : 未配置 — 打开 http://localhost:8787 在「账号」页登录即可
API_KEY             : sk-cline-xxxxxxxxxxxxxxxxxxxxxxxx
                      ↑ 首次运行自动生成，已写入 .env.local（无需手填）
监听地址            : http://localhost:8787
----------------------------------------------------------------
端点：
  GET  http://localhost:8787/           控制台（浏览器打开）
  GET  http://localhost:8787/v1/health
  GET  http://localhost:8787/v1/models
  POST http://localhost:8787/v1/chat/completions
  POST http://localhost:8787/v1/messages      (Anthropic 格式)
================================================================

✅ 服务已启动，按 Ctrl+C 停止
```

**保持这个窗口开着**——关掉窗口或按 `Ctrl+C` 服务就停了。

### 第 2 步：打开控制台，登录一个账号

浏览器打开：

```
http://localhost:8787
```

进入「**账号**」页 → 点「**登录新账号**」→ 页面会显示一个授权链接和跳转按钮 →
在浏览器里用 Google / GitHub / 邮箱登录 Cline → 授权完成后**页面会自动检测到结果**。

登录成功后账号立即可用，可以直接去「对话测试」页发消息试试。

> 💾 **本地运行时这样登录的账号会自动存盘，重启不丢**（写在
> `~/.cline-free-state.local.json`，权限 0600）。
> 部署到云端（Workers / Vercel）没有可写磁盘，账号只活在那一次实例里——那时按页面
> 提示把 `refreshToken` 填进 `CLINE_REFRESH_TOKEN` 环境变量。
>
> 这一步也能用命令行完成，见下文「[获取 refreshToken](#获取-refreshtoken)」。

### 第 3 步：在客户端里用

把下面的地址和密钥填进任何 OpenAI 兼容客户端（ChatBox、Cherry Studio、NextChat、
各种 SDK 都行）：

```text
Base URL: http://localhost:8787/v1
API Key:  <你的 API_KEY>          ← 控制台「接入配置」页可直接复制
Model:    cline-free/deepseek-v4.1-flash
```

> 💡 本地运行时 `API_KEY` 会**自动生成**并写进 `.env.local`，
> 同时注入控制台页面，所以用控制台不用手填。
> 用第三方客户端时才需要填——去「**接入配置**」页复制，或看终端启动时的输出。

「接入配置」页还会自动生成**可直接复制**的调用代码（cURL / Python / Node /
Anthropic SDK / 环境变量），地址、密钥、模型都填好了。

兼容两种协议：

- OpenAI 格式：`POST /v1/chat/completions`
- Anthropic 格式：`POST /v1/messages`（自动转换）

---

## 获取 refreshToken

上面第 2 步是在控制台里登录，这里再补两种方式。任选其一，也能都用。

### 方式①：控制台登录

浏览器打开 `http://localhost:8787` → 「账号」页 → 「登录新账号」。
最省事，**不需要预先有 token 就能用**。缺点是账号存在内存里，重启丢失，
记得把页面给出的 token 存进 `.env.local`。

### 方式②：命令行脚本（推荐长期使用）

```bash
python3 cline_oauth.py
```

脚本会启动 Cline 官方的 **WorkOS 设备授权码流程**，你在浏览器里登录一次即可，
剩余全部自动。**拿到的 token 会自动写进 `.env.local`**，不用手动复制。

> 只需要 Python 标准库，**不用 pip 装任何东西**。
>
> 脚本内部做的（逆向自 auth.go）：
> 1. `POST api.workos.com/.../authorize/device` → 拿 device_code + 授权链接
> 2. 轮询 `api.workos.com/.../authenticate` → 授权成功后拿 WorkOS access_token
> 3. `POST api.cline.bot/api/v1/auth/register` → 用 WorkOS token 换 Cline 的 refreshToken

### 方式③：从原版 Go 程序里提取

如果你手上已经在用上游的 Go 版 cline2api，可以直接从它的账号文件里取：

1. 下载原版 [cline2api releases](https://github.com/luawei1/cline2api/releases) 的运行文件
2. 运行 `./cline-proxy --login`，浏览器登录 Cline
3. 打开 `~/.cline2api/.cline-accounts.json`，找到 `refreshToken` 字段，复制它
4. 填进 `.env.local`

---

## 日常使用

### 配置文件 `.env.local`

首次启动会自动从 `.env.local.example` 创建，内容就两项：

```bash
# Cline 账号 refreshToken
CLINE_REFRESH_TOKEN=

# 客户端访问密钥。留空会自动生成并写回本文件
API_KEY=sk-cline-local
```

| 变量 | 必填 | 说明 |
|---|---|---|
| `CLINE_REFRESH_TOKEN` | 是（否则无法调用上游） | 账号的 refreshToken |
| `API_KEY` | 否 | 客户端访问密钥，留空则自动生成 |

- 该文件已在 `.gitignore` 中，**不会被提交**
- 改了 token **不用重启服务**——配置是每次请求重新读的
- ⚠️ **`.env.local` 只支持单账号**，原因见 [docs/常见问题.md](docs/常见问题.md) 的「账号与额度」

### 换个端口 / 只让自己访问

默认监听 **`127.0.0.1:8787`（仅本机可访问）**。

> 🔒 为什么默认只绑回环：控制台页面会把 `API_KEY` 注入进去（本地首次运行自动生成的那个），
> 而这个服务把自己登录过的账号额度开放给任何能访问它的人。绑 `0.0.0.0` 等于把钥匙
> 连同门一起送给同网段的人。

确实要让别的机器连（比如手机）时显式指定，并自己配好 `API_KEY`：

```bash
# Windows (cmd)
set PORT=9000 && set HOST=0.0.0.0 && node local-server.js

# Windows (PowerShell)
$env:PORT=9000; $env:HOST="0.0.0.0"; node local-server.js

# Linux / macOS
PORT=9000 HOST=0.0.0.0 node local-server.js
```

`PORT` 与 `HOST` **不能**写在 `.env.local` 里（解析器只认那两个 key），必须用环境变量。

### 停止服务

在运行的终端窗口按 **`Ctrl+C`**。启动脚本会把信号传给子进程，
不会留下占着端口的孤儿进程。

### 控制台能做什么

浏览器打开 `http://localhost:8787`。界面是像素终端风格（深蓝黑底 + 青色强调），
左侧导航栏有八个页面，右上角可切换深/浅主题：

| 页面 | 能做什么 |
|---|---|
| **对话测试** | 多轮对话（自动带上下文）、流式逐字输出、随时停止生成、思考过程折叠、右侧实时显示首字节/耗时/输出速度/token 数、导出记录；可设 system prompt 与 temperature/top_p |
| **账号** | 查看每个账号状态（来源、token 缓存、**哪些模型在冷却**、已消耗的输入/输出 token）；**在网页里直接登录新的 Cline 账号**；每张卡片有**详情**（模型级冷却表 + 可解除单个模型的冷却 + 查看可用模型清单 + 取 refreshToken）与**余额**（查官方 Credit）按钮 |
| **模型** | 三段式模型库：**可用模型分组**（官方四类，整组或逐个添加）、**全部模型**（446 个，折叠 + 按供应商分组 + 搜索）、**已启用模型**（只有这些会进 `/v1/models`）。卡片可**检测可用性**、添加、复制 ID、设为默认、移除 |
| **统计** | token 用量总览、**重试放大读数**、近 30 天趋势、按模型 / 按账号排行、思考 token 占比 |
| **日志** | 固定高度的滚动窗口（不会把页面撑长）；按成功/失败/慢请求筛选并搜索；点行看详情面板（指标 + 请求体 + 原始响应，可复制）；可导出 JSON |
| **上游渠道** | **按模型钉住上游渠道**（只走某几条 / 排除坏的几条 / 优先某条）、把模型 ID 重定向到上游真实 ID、设置别名；**探测**按钮判定该模型走哪条管道并列可用渠道 |
| **设置** | 轮换策略（round_robin / fill / random）、冷却兜底时长、默认模型、**system prompt 覆盖**、**自定义请求头** |
| **接入配置** | 生成可直接复制的接入代码（cURL / Python / Node / Anthropic SDK / 环境变量），已填好地址、密钥、模型 |

> 🔒 密钥、对话历史、日志、测速结果都只存在**本机浏览器的 localStorage**，不上传别处。
> 控制台是**单文件自包含**的，不引用任何外部 JS/CSS。

### 额度冷却按「账号 × 模型」算

上游是按**账号 + 模型**组合独立计额的：某个账号的 `deepseek` 当天免费额度用完了，
不代表同账号的 `glm` 也不能用。所以冷却也落在组合粒度上——一个模型到上限，
同账号的其它模型照常轮换。

冷却时长的取法（按优先级）：

1. 上游响应里给的重置时刻（免费模型按自然日 → 自动算到**次日本地零点**；
   花费上限用上游给的 `resets_at`）
2. 上游文字里写的等待时长（`try again in 2 hours 30 minutes`）
3. 都没说 → 用「设置」页配的兜底时长（默认 30 分钟）

猜错了（比如额度其实已恢复）不用干等：在「账号」页点账号的**详情**，
可以单独解除某个模型的冷却。

> 📖 全部冷却时返回的 429 会明确告诉你是**哪个模型**没额度、大约多久恢复，
> 而不是笼统的「所有账号都不可用」——换个模型往往就能继续用。

### 上游渠道钉住

Cline 网关后面有**两条完全不同的路由管道**，钉住上游的写法互不通用：

- `direct`（OpenRouter）：响应顶层带 `provider`（显示名），钉住写进顶层 `provider.{only,order}`
- `planner`（Vercel AI Gateway）：响应带 `provider_metadata.gateway.routing`，
  顶层 `provider.*` 会被忽略，必须写 `providerOptions.gateway.{only,order}`

同一个模型在不同时间可能落在其中任一条，所以只能**运行时探测 + 缓存**，不能硬编码名单。
面板上点「探测」会：先发一次带你当前配置的真实请求（回读管道归属，并回答「我钉的渠道
到底生效没有」），再带一个假渠道名让网关在路由层报错并吐出可用渠道清单。

**大多数情况下你不需要这个功能**：留空就是自动模式，由网关自己挑渠道并自带故障转移，
实测比在代理层再叠一层重试更有效。它真正有用的场景是——某个渠道总是坏、
想优先用便宜/快的渠道、或上游改了模型 ID 而你的客户端不方便动。

> ⚠️ 渠道清单只用于把「排除」换算成白名单（网关不认 `exclude` 字段，实测被静默忽略）。
> 没探测过也能钉住：管道未知时代理会**两种形式同时注入**，实测在 planner 模型上多一个
> 顶层 `provider.only` 不会报错（顶层被网关忽略），所以不必先探测成功。

### token 用量统计

「统计」页记录每次上游调用的 token 消耗，并且**按上游调用计，不按消息数计**。

这个区别是重点：免费额度用尽时 worker 会自动切号重试，空响应也会重试，
你发一条消息可能真的打了 2~3 次上游，这几次都实打实消耗额度。所以页面顶部有一项
**重试放大**读数（上游调用数 ÷ 客户端请求数）：1.0 表示每次请求都一次打中，
明显大于 1 就说明有额度被重试悄悄烧掉了。

统计口径上的两点说明：

- 客户端中途断开（点停止、关页面）时上游还没回报用量，这类计入**无用量回报**，
  不会用字符数估算——估算值混进统计会让整份数字失去意义。
- 上游按**自然日**结算免费额度，所以「近 30 天」用的是本机时区的自然日。

> 💾 **本地运行时统计会存盘**，重启不丢：写在 `~/.cline-free-usage.local.json`（用户主目录，
> 不在项目目录里，不会被误提交）。部署到 Cloudflare / Vercel 时没有可写磁盘，统计只活在
> 当前实例内存里，重启即清零——这是刻意的取舍，为了保住"单文件复制粘贴即可部署"。
>
> 📖 `GET /v1/health` 的 `usage` 字段有完整汇总，第三方客户端也能读。
> ⚠️ 该端点**不鉴权**，所以刻意只回「服务在不在、有几个账号」这类计数；
> 账号明细（邮箱、每个账号的用量）在需要 `API_KEY` 的 `GET /v1/status` 里。
> 部署到公网时，health 会公开你的账号数量与用量规模，介意就别暴露它。

### 模型库

**`GET /v1/models` 只返回你在控制台里启用的模型。** 上游有 446 个模型，
全塞给客户端的结果是每次选模型都要翻四百多项、其中大半还会直接 402/403，
所以由你在「模型」页挑。

全新实例（还没启用过任何模型）会**回退到内置推荐**的四个免费通道，
不会返回空列表——否则客户端拉不到模型会以为服务坏了：

```
cline-free/deepseek-v4.1-flash      ← 默认模型
deepseek/deepseek-v4-flash
z-ai/glm-5.3-flash
poolside/laguna-s-2.1:free
```

「模型」页分三段：

| 区块 | 作用 |
|---|---|
| **可用模型分组** | 官方四个分类（官方推荐 / 免费模型 / ClinePass / Cline Cloud）。点分组标题的「全部添加」整组加入，或点单张卡片的 ＋ 逐个加。卡片上有「检测」可先确认它现在能不能用 |
| **全部模型** | 上游全部 446 个模型，**折叠着**（展开才抓，约 500 KB）。按供应商分组（openai 96 个、qwen 54 个…），支持搜索名称或 ID |
| **已启用模型** | 只有这里的模型会出现在 `/v1/models`。可设默认、复制 ID、检测、移除 |

卡片上的三个动作：

- **检测** —— 发一次最短的真实请求（`Reply with only OK.`），回答「这个模型现在能不能用」。
  注意它**只看正文**：上游有时返回 HTTP 200 但内容全空，那种也算不可用。
- **＋ 添加** —— 加入 `/v1/models`。重复添加会自动跳过，所以「全部添加」可以放心重复点。
- **⧉ 复制** —— 复制模型 ID。

> 💡 **这是"发现过滤器"，不是访问控制。** chat 端点不校验模型是否在启用列表里，
> 所以你在客户端里写死一个没在面板加过的模型 ID，照样能用。
> 面板只决定**客户端能看到什么**，不决定**什么能用**。

> ⚠️ **前缀很关键**：`cline-free/deepseek-v4.1-flash` 走官方免费额度；
> 而 `deepseek/deepseek-v4.1-flash`（无前缀）是**付费档**，余额不足直接 402。
> 详见 [docs/常见问题.md](docs/常见问题.md)。

### 自检

不需要真实账号，用假上游验证全部逻辑（**288 项断言**）：

```bash
node selftest.mjs
```

覆盖路由与鉴权、流式不被缓冲（TTFT）、账号池缓存与冷却、
「账号×模型」级冷却与 429 分类解析、上游状态码映射、
上游渠道钉住（双管道 / 排除换算 / 重定向 / 别名）、探测解析、
设置项校验（策略 / 请求头注入 / system 覆盖）、
流中途失败必须发 error、请求体上限、登录限流、用量统计与持久化恢复。

---

## 常见问题

遇到问题先翻 [docs/常见问题.md](docs/常见问题.md)，覆盖了：

- **启动**：窗口一闪而过 / Node 版本报错 / 端口被占用 / 页面打不开 / 改了代码怎么生效
- **中文乱码**：Windows 下乱码、改 `start.bat` 的注意事项
- **调用报错**：401 / 402 / 429 / 500 的含义与处理
- **账号与额度**：怎么加账号、登录的账号为什么重启就没了、冷却中是什么意思
- **模型**：该用哪个、为什么只有几十个、`max_tokens` 为什么没生效
- **安全**：token 谁能看到、数据会不会上传、会不会暴露到局域网

---

## 项目结构

```
.
├── start.bat               # Windows 启动（双击即可；纯 ASCII 引导）⭐
├── start.sh                # Linux / macOS 启动
├── start.mjs               # 启动脚本本体（跨平台，中文提示都在这里）
├── local-server.js         # 本地服务入口（把 Node HTTP 转成 Web Request）⭐
├── worker.js               # 核心逻辑（唯一逻辑源，控制台 HTML 内联其中）
├── console.src.html        # 控制台前端源码（改前端改这个，别改 worker.js 里那份）
├── build-console.mjs       # 把 console.src.html 注入 worker.js ⭐
├── selftest.mjs            # 自检脚本（288 项断言，用假上游验证）⭐
├── cline_oauth.py          # 获取 refreshToken 的脚本（纯标准库）⭐
├── .env.local.example      # 本地配置模板（复制为 .env.local 后填 token）
├── .env.local              # 你的 token 配置（已被 .gitignore 忽略）
├── CHANGELOG.md            # 版本更新记录
├── docs/                   # 云端部署、常见问题
└── api/、build-vercel.mjs、vercel.json、wrangler.toml    # 云端部署用，本地不需要
```

### 改了代码之后要跑什么

**只改了 `console.src.html`（控制台前端）**——必须重新注入，否则改动不生效：

```bash
node build-console.mjs
```

**只改了 `worker.js`（后端逻辑）**——什么都不用跑，本地服务会自动热重载。

**改完随手验证**（不需要真实账号）：

```bash
node selftest.mjs
```

> 💡 **热重载的坑**：改 `console.src.html` 后如果没跑 `build-console.mjs`，
> 页面不会变——因为 Node 缓存了 ESM 模块，而真正的 HTML 是内联在 `worker.js` 里的。
> 这个坑很隐蔽，容易误判成"改动无效"。

> 📌 要部署到云端时，才需要 `node build-vercel.mjs` 同步 Vercel 入口，
> 详见 [docs/部署到云端.md](docs/部署到云端.md)。

---

## 来源与许可

**本仓库**：[Patrick-mufeng/cline-free](https://github.com/Patrick-mufeng/cline-free)
· 作者 **Patrick** · 公众号 **AI实用talk**

本项目是衍生作品，来源链条如下（按 MIT 协议保留原有版权声明）：

| 环节 | 项目 | 说明 |
|---|---|---|
| 1️⃣ 原版 | [luawei1/cline2api](https://github.com/luawei1/cline2api) | Go 版反向代理，本项目的思路与接口来源 |
| 2️⃣ Workers 版 | [pingmike2/cline2api-workers](https://github.com/pingmike2/cline2api-workers) | 重写为纯 JS 的 Worker，本项目 `worker.js` 的代码基础 |
| 3️⃣ **本版 cline-free** | 本仓库 | 在 2️⃣ 基础上继续改造，见下 |

**本版（cline-free）主要改造内容**：

- **本地优先**：`start.bat` / `start.sh` / `start.mjs` 启动脚本，
  `local-server.js` 本地服务，`.env.local` 配置，控制台免手填密钥
- **内置控制台**（像素终端风格，单文件自包含）：对话测试、账号、模型、统计、日志、
  上游渠道、设置、接入配置八个页面
- **多账号池**：429 自动解析上游冷却时长并切号重试，全部冷却时直接返回不再空转
- **「账号×模型」级冷却**：按上游真实计额粒度冷却，模型 A 到上限不影响同账号的模型 B；
  解析上游给出的重置时刻（免费模型算到次日本地零点），并能单独解除某个模型的冷却
- **页面内登录账号**：`/v1/login/start`、`/v1/login/poll` 走 WorkOS 设备授权码流程（均要求 API_KEY）
- **上游渠道钉住**：按模型指定/排除上游渠道，模型 ID 重定向与别名；
  运行时探测管道归属（direct / planner 双写法）与可用渠道清单，探测走异步任务
- **设置项**：轮换策略（round_robin / fill / random）、冷却兜底时长、默认模型、
  system prompt 覆盖、自定义请求头
- **账号详情与余额**：模型级冷却表、可用模型清单、refreshToken 导出、官方 Credit 余额查询
- **可靠性**：上游 401/403 映射成 502（不冒充客户端 Key 错误）、流中途失败发 error 事件、
  客户端断开传播到上游、token 刷新单飞、轮换后的 refreshToken 自动落盘
- **模型库（三段式）**：`/v1/models` 只回控制台里启用的模型（没启用过则回退内置推荐四个免费通道）；
  可用分组整组添加、全部模型按供应商分组可搜索、卡片级可用性检测
- **工程化**：`console.src.html` 前端源码 + 构建脚本（自动同步 Workers / Vercel 两份入口）、
  `selftest.mjs` 自检（288 项断言）

完整版本历史见 [CHANGELOG.md](CHANGELOG.md)。

**MIT License** © 2026 [luawei1](https://github.com/luawei1)（原版）
& [pingmike2](https://github.com/pingmike2)（Workers 版）
& [Patrick-mufeng](https://github.com/Patrick-mufeng)（本版）· 详见 [LICENSE](LICENSE)

三版均以 MIT 协议开源。
