# Changelog

本项目的所有值得注意的变更都会记录在这里。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.0-r3] - 2026-10-23

### 新增

- 三个 DSH bundle 插件：`qq-emu-phone`（「我的手机」——MuMu 模拟器控制）、`qq-diary`（每日日记）、`qq-qzone`（QQ 空间动态发布）
- `src/diary-core.js`、`src/qzone-core.js` 纯逻辑模块：日记目录 / 空间可见性 / 出站门禁的**唯一常量来源**，桥接与 MCP 共用同一份定义
- `docs/guides/EMU_PHONE.md`、`docs/guides/DIARY.md`、`docs/guides/QZONE.md` 使用文档

### 修复

- 日记/记忆路径原来在 4 处硬编码了绝对路径字面量，与桥接的 `DIARY_DIR` 是两份独立常量——换盘/改名会「桥接往新目录写、模型从旧目录读」静默错位；现统一到 `src/diary-core.js` 的 `DIARY_DIR` 一处
- QQ 空间的参数校验、可见性归一、出站门禁统一收敛到 `src/qzone-core.js`，MCP 与插件共用同一份校验口径

### 其他

- 仓库改名 `dafeiyu-qq-extension` 并公开
- 离线回归 41/41 通过

## [0.2.0]

- 适配 DSH **0.2.0-rc.2**，逐项实测（`npm run verify:adaptation`）
- 修复「会话待处理队列读不出来」：退役/重置 QQ 会话时清不掉 DSH 侧队列，根源是解析了一个从不存在的字段（`session/control` baseline 的 `value.queues[<id>]`）；现改以一元 `session/projections` 为主路径、`projections[<id>].values.inbox` 为回退形状
- 按 0.2.0 真实工具清单重新对账 QQ 安全守卫（新增 15 个必须隐藏的工具名，含全局层默认启用的 `read_mcp_resource`、`plugin_manager` 等）

## [0.1.7]

- 适配 DSH **0.1.7-rc.2**：进程启动 token 只存在于内存、不再落盘，鉴权改用 `~/.dsh` 持久化签名密钥离线铸造会话 Cookie
- agent preset 改为 `@deepseek-ai/dsh-agent-preset` Cordis 行（`~/.dsh/.agent-presets/` 目录机制废弃）

## [0.1.5]

- 适配 DSH **0.1.5-rc.1**
- 移除 `start_snowluma` / `stop_snowluma`（及 `snowluma.allowProcessControl`）：SnowLuma EULA §5.4 要求通过自动化脚本部署其专有原生组件须事先书面授权，本程序改为**只探测、不部署**

## [0.1.0]

- 初版：QQ 消息接入 DSH agent 会话，agent 回复（含提问、工具审批）发回 QQ
