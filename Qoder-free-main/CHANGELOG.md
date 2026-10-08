# 更新日志

本项目的所有显著变更都会记录在本文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

### 新增

- 管理面板配置页：API 密钥字段增加「复制」按钮（页面仍显示掩码，点击后从
  `GET /panel/api/config/api-key` 取完整密钥写入剪贴板）。

## [0.1.0] - 2026-10-02

首个公开版本。

### 新增

- OpenAI 兼容网关：`POST /v1/chat/completions`（SSE 流式 / 非流式）与 `GET /v1/models`，
  支持工具调用与推理参数透传。
- 多账号池调度：加权选号、会话粘性、限流/额度冷却（指数退避）、连续失败熔断、
  按账号并发上限、失败自动轮换。
- 每账号独立 Node worker：隔离 HOME，加载钉版 qodercli 1.1.32 并在内存打 hook，
  崩溃自动拉起；区域路由（`cn:` / `global:` 模型前缀）。
- 内嵌管理面板（`/panel/`）：账号增删、设备授权登录、额度查询、国内版签到、
  模型目录、每日用量统计、运行日志、在线配置。
- CLI 零配置：qodercli 国际/国内包作为 worker npm 依赖内置，配置路径留空时
  Go 侧自动探测 `worker/node_modules` 下的 bundle。
- 启动脚本（`scripts/start.ps1` / `start.sh`）：自动补配置、装依赖、构建。
