# API-free 面板重设计 · v2

2026-10-07。这一版包含三件事：**四家服务换用官方 logo**、**面板主标重做（两个梯子搭成的一个 A）**、**5 个前端方向供选择**。

## 怎么打开

需要一个本地静态服务器（字体与 logo 是内嵌的，但 demo 之间靠相对路径共享 `assets/`）：

```
cd prototypes/v2
python -m http.server 8460 --bind 127.0.0.1
```

然后浏览器打开 <http://127.0.0.1:8460/> —— 那是选择器页：左侧 5 个方向，`1-5` 切换、`←/→` 前后、`O` 在新标签打开当前方案。

| 文件 | 是什么 |
|---|---|
| `index.html` | 选择器（5 个方向 + 键盘导航 + 说明） |
| `logo.html` | logo 定稿展示页（各尺寸 / 深色底 / 图标底 / 与字标组合 / 几何说明） |
| `demo-1-ops.html` | 指挥台 · 浅色精密仪表 |
| `demo-2-workbench.html` | 工作台 · 深色三栏开发工具 |
| `demo-3-analytics.html` | 数据台 · 浅色图表主导 |
| `demo-4-console.html` | 控制台 · 深色终端原生 |
| `demo-5-editorial.html` | 素白 · 浅色排版主导 |

每个 demo 都实现了 **总览 / 服务 / 统计 / 日志 / 设置** 五个视图，服务页含 账号·（任务中心）·模型·用量·日志·接入·设置 页签。

## 数据与素材

- **数据是真实快照**，取自已运行的面板 API（`2026-10-07 17:12`），见 `assets/data.js`。没有占位假数据。
- 真实记录只有 **10-06 与 10-07 两天有流量**，所以趋势曲线贴着零线是事实，不是故障。每个 demo 右上角有
  **「真实 / 示例密度」开关**：切到示例才看得到图表在数据密集时的形态，**示例态在界面上明确标注为示例**。
- **四家 logo 是各自的官方图形**（`assets/logos.js`，192×192 PNG 内嵌，保留官方底板与配色）：
  qoder.com / cline.bot / workbuddy.ai / commandcode.ai 的 favicon 与 brand 资产。
  来源说明见 `assets/logos.js` 里的 `LOGO_META`。
- **字体内嵌**（`assets/fonts.css`）：Inter + JetBrains Mono 的 latin 子集（base64 woff2），
  中文回落到系统字体（Microsoft YaHei UI / PingFang SC）。
- `assets/_raw/` 目录**不存在**：抓取各服务接口的原始 JSON 已在整理后删除（其中 cmdgo 的 status 含明文密钥）。
  要刷新数据，先按下面的命令重新抓取，再跑 `node assets/build-data.mjs`。

### 刷新数据

```bash
cd prototypes/v2/assets
mkdir -p _raw && cd _raw
B=http://127.0.0.1:9000
curl -s $B/api/services        -o _svc.json
curl -s $B/api/svcinfo         -o _info.json
curl -s "$B/api/stats?days=30" -o _stats.json
curl -s $B/api/events          -o _events.json
curl -s $B/api/access          -o _access.json
curl -s $B/api/svc/workbuddy/panel/api/overview -o wb-overview.json
curl -s $B/api/svc/workbuddy/panel/api/models   -o wb-models.json
curl -s $B/api/svc/cline/v1/status              -o cline-status.json
curl -s $B/api/svc/cline/v1/models              -o cline-models.json
curl -s $B/api/svc/qoder/panel/api/overview     -o qoder-overview.json
curl -s $B/api/svc/qoder/panel/api/models       -o qoder-models.json
curl -s $B/api/svc/cmdgo/api/status             -o cmdgo-status.json
cd .. && node build-data.mjs
```

> `build-data.mjs` 从 `_raw/` 读原始件。抓完记得删掉 `_raw/`
> —— `cmdgo-status.json` 里有明文 API key，不要留在仓库里。

## logo

**主标 = 两个梯子搭成的一个 A。** 每条腿画成一把梯子：两条平行轨 + 垂直于轨的横档；
两把梯子在顶点相靠；**上半档两两对齐，正好连成 A 的横杠**（不是额外加的一根）；脚底沿水平线切平。

几何（32×32 画布，全部直线、无贝塞尔）：

| 参数 | 值 |
|---|---|
| 顶点 | `(16, 4.55)`，顶端垂直于轨身切 |
| 脚底 | 水平线 `y = 27.6`，脚距 `x = 6.75 / 25.25` |
| 轨距 / 轨宽 / 横档宽 | `5.0 / 2.3 / 2.25` |
| 横档位置 | 轨长 `t = 0.335 / 0.70` |

生成脚本 `assets/build-logo.mjs` → 产出 `assets/logo.svg`、`assets/favicon.svg`、`assets/logo-inner.js`。
16px 下退化为一个干净的 A，40px 以上能看出两把梯子。

## 与现有 panel/ui 的关系

本次已把真实 logo 与新主标落进实际运行的面板：

- `panel/ui/src/components/logos.ts` —— 自动生成（四家 logo 的 data URI + 主标内联片段 + favicon），勿手改
- `panel/ui/src/components/ServiceIcons.tsx` —— `ServiceLogo`（官方 logo）/ `PanelMark`（主标），`ServiceGlyph` 保留为兼容别名
- `panel/ui/src/components/Sidebar.tsx` —— 品牌位改用 `PanelMark`
- `panel/ui/src/styles/svc.css` —— `.svc-ava` 改为中性白底 + 细环（彩色渐变底会和 logo 抢色）
- `panel/ui/public/favicon.svg` —— 换成新主标的图标底版本

重新生成 `logos.ts`：见 `panel/ui` 目录外的构建脚本，或直接把 `prototypes/v2/assets/logos.js` 与 `logo-inner.svg` 用同源脚本转出。
