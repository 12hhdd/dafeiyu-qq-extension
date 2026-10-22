# 新手接入常见遗漏（第三方教程 / 照着做会卡住的地方）

> 面向「第一次把这套东西跑起来」的人。README 的 [完整启动流程](../../README.md#完整启动流程从零开始) 是权威顺序；本文只补充**外部教程最容易漏、漏了会表现为「能启动但 QQ 上没反应」的步骤**，以及几处常见说法与当前代码不一致的地方。
> 如果你已经跑通，本文可以跳过；出问题先看 [README「运行与运维」](../../README.md#运行与运维)。

## 1. 六个必做、经常被漏掉的步骤

| # | 步骤 | 漏了会怎样 |
| --- | --- | --- |
| 1 | `npm install`（`postinstall` 会修补 `@snowluma/sdk` 的 ESM 打包 bug） | 启动即 `ERR_MODULE_NOT_FOUND` / `Cannot find module` |
| 2 | `copy config.example.json config.json`（仓库里没有 `config.json`） | 找不到配置文件 |
| 3 | `node scripts/setup-dsh.mjs [profile]` 装 `qq-chat` / `qq-chat-v2` preset 与 MCP | 桥接不崩、日志正常，但 **QQ 上毫无反应**（拿不到 preset 时会拒绝建会话，fail-closed） |
| 4 | 装完 **重启 DSH** | 同上：preset / MCP 只在 DSH 启动时加载 |
| 5 | 填 `snowluma.homeDir` / `snowluma.launcherPath` | 首次 `1006` 后 token 自愈无从下手 → `token 自愈失败` → **完全收不到消息** |
| 6 | 重启桥接让配置生效（`restart.bat` / `start.bat` 重开） | 改了的配置看起来没生效 |

`setup-dsh.mjs` 的 profile 参数默认是 `web`；DSH 实际使用的 profile 不是 `web` 时必须显式传（例如 `node scripts/setup-dsh.mjs desktop`），否则等于没装。

## 2. 首次连接出现 `1006` 是正常序列

SnowLuma 同一账号的 **HTTP token（默认 3000）与 WebSocket token（默认 3001）是两个不同的值**，所以桥接每次启动的首次 WS 连接几乎必然失败一次：

```text
SnowLuma 连接断开（code=1006）
自愈完成：账号 <机器人QQ号>
SnowLuma 已连接：ws://127.0.0.1:3001
```

看到 `SnowLuma 已连接` 才算成功，中间那次断开**不是故障**，不要因此重装。真故障是自愈也失败：`snowluma.homeDir` 没配、SnowLuma 安装目录被移动、读不到 `config/onebot_<QQ号>.json` 或权限不足。

## 3. 配置里最容易设错的几项

- `allow.private` / `allow.groups` 留空且 `allowAllWhenEmpty: false`（默认）时**谁都不回** —— 这是刻意的 fail-closed，不是坏了。
- `snowluma.httpUrl` 是 OneBot **HTTP API** 端口（3000），`wsUrl` 是 **WebSocket** 端口（3001），不要填成同一个，否则 MCP 工具报 HTTP 426。
- `dsh.baseUrl` 要填 DSH 实际地址（默认 `http://127.0.0.1:3080`，以自己 DSH 为准）；`dsh.provider` / `dsh.model` 要填 DSH 设置页里真实存在的模型，填错只打日志、不阻塞启动，但模型调不动。
- `dsh.authToken` 通常留空：留空时桥接用 `~/.dsh/.credentials.yaml` 离线铸造会话 Cookie，不依赖进程期状态。
- `consoleToken` 留空时自动生成并写到 `state/console-token`；打开控制台 `http://127.0.0.1:3100` 会要求令牌（也可用 `?token=`）。
- 想跑第二个实例 / 指向另一份 SnowLuma 时设 `snowluma.followDiscoveredEndpoint: false`，否则端点自愈会把你写的 `wsUrl` 覆盖掉。
- 自己改过 preset、或从旧版升级过来时，persona 模板里**只能**用 `{{provider}}`、`{{model}}` 两个提示词变量：DSH 0.2.1 起 `{{cwd}}` 不再注册，残留会让**每一轮**都报 `unknown prompt variable "{{cwd}}" in section "deployment:persona-suffix"`。详见 [DSH_021_CWD_PROMPT_FIX.md](DSH_021_CWD_PROMPT_FIX.md)。

## 4. 运维（教程类文章通常整篇没有）

- **启动顺序**：DSH → SnowLuma → 桥接。桥接**不启动、不控制** SnowLuma 与 DSH。
- **后台常驻**：`start.bat` 是守护脚本（崩溃 5 秒后自动拉起，关窗口即停止）。开机自启可把它的快捷方式放进 `shell:startup`，或用任务计划程序（登录时触发、可隐藏窗口）。24/7 运行记得关系统睡眠。
- **掉线重连**：桥接自动重连 SnowLuma 并自愈 WS token；每 5 秒探活 DSH，DSH 不可用期间 QQ 消息在桥接进程内排队（每会话最多 50 条），DSH 重启不必动桥接；桥接进程退出队列即丢失。
- **单实例**：`state/bridge.lock` + 控制台端口 3100 双重防护，双开会互相抢消息、互相覆盖 `state/`。干净重启用 `restart.bat`。
- **端口**：DSH（默认 3080）、OneBot HTTP 3000、OneBot WS 3001、桥接控制台 3100、SnowLuma WebUI 5099。
- **日志**：`state/bridge.log`（stdout 同份，2000 行自动轮转到 `.1`）；SnowLuma 自己的 `logs/snowluma-*.log` 里搜 `[Hook]`。
- **改什么要重启什么**：`config.json` / `roles/` → 重启桥接；`dsh/agent-presets/` → 先 `node scripts/build-agent-preset-patches.mjs` 再重启 DSH；MCP / DSH profile → 重启 DSH；仓库目录被移动 → 重跑 `setup-dsh.mjs`（配置里存的是绝对路径）。
- **「连上了但收不到消息」**：多半是 SnowLuma 的 `[Hook]` 接收链路退化，不是本桥接的问题；看控制台「SnowLuma 上游」卡片与 `GET /api/status` 的 `snowluma` 字段，详见 README「SnowLuma 版本与上游健康」。

## 5. 与部分教程不一致的说法（以本仓库为准）

1. **Node 版本**：要求 **Node ≥ 22.13**（`engines.node`），不是 "20 以上"。
2. **图片**：不存在 `socialV2.image.allowDirs` 这个配置；收到的图片由桥接用安全下载（`src/safe-fetch.js`）取字节交给多模态模型，只需模型支持图片输入。
3. **语音**：**收到的语音目前只显示占位文本、不做语音转写**（"装 whisper" 无效）；语音方向只支持**发送**（音频放 `audio/` + `socialV2.voice.enabled`）。
4. **两个「管理界面」**：SnowLuma 的 WebUI 在 5099，桥接控制台在 3100，别混；控制台还要令牌。
