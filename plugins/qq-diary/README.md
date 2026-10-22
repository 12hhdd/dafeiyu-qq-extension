# qq-diary

QQ 桥接的**日记 / 长期记忆**插件（DSH 0.2.0 bundle 形态）。

## 它是干什么的

QQ 桥接每天在固定时间（默认 `23:30`）拉起一个**私有的后台会话**，让 AI 用第一人称写
当天的日记，并整理一份分级「事情清单」：哪些事很重要（永久记着）、哪些要尽快办、
哪些只是值得记一笔。第二天醒来时，桥接再把「长期记忆锚点 + 最近几天日记摘录」注入
系统提示 —— 于是 AI 记得住跨天的事，而不必把整段聊天一直留在上下文里。

这个插件把这件事的**纯逻辑**接进 DSH 的设置面板，让「开关 / 标题 / 几点写 / 存哪」可以
在 profile 里改，而不用手改 `config.json`。

## 两条边界（改代码前先分清）

| 半边 | 位置 | 内容 | 能不能单测 |
| --- | --- | --- | --- |
| **内核（纯函数）** | `src/diary-core.js` | 路径与日期拼装、`items.jsonl` 分级保留、记忆块拼装、后台提示词、模型输出解析 | 能，不碰 DSH |
| **宿主** | `src/bridge.js` | 建 workspace、开专用 DSH 会话、等模型回合、写 `state/diary-session.json`、落盘日记 | 不能，需要活着的 DSH |

`lib/index.js` 直接 `import('../../../src/diary-core.js')` 并再导出关键常量 —— 这样插件不是
空壳，「插件 ↔ 内核」这条链断没断可以被静态测试钉住（见 `scripts/test-qq-diary.mjs`）。

`apply(ctx)` 在 0.2.0 下是**空操作**：命名空间由 profile 的 loader entry id + 导出的 `Config`
推导，不再需要 `ctx.settings.register()`（那个 API 在 0.2.0 已删除）。仅保留诊断日志，
写到 `os.tmpdir()/qq-diary-plugin.log`（可用 `QQ_DIARY_DIAG` 覆盖）。

## 配置项

命名空间 `qq-diary`（由 `cordis.patch.yml` 的 `- id: qq-diary` 决定），全部字段 volatile：
在设置面板里改了立即生效，且不进 profile 的持久化文档。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 是否启用日记；关闭后不自动写，手动 `/api/diary/run` 也会被拒 |
| `workspaceTitle` | string | `她的日记` | 日记专用 workspace 的标题 |
| `timeOfDay` | string | `23:30` | 每天几点自动写（`HH:MM`，本机时区） |
| `dir` | string | `''`（空 = 默认 `D:\日记`） | 日记与长期记忆的存放目录 |

`config.json` 里的 `diary` 段仍在；插件设置覆盖在它之上（`diaryCfg(overrides)` 的语义：
默认值 ← `config.json` ← 设置面板）。

## 日记文件布局

```
D:\日记\                        ← 默认目录，可用 dir 配置项 / QQ_BRIDGE_DIARY_DIR 覆盖
├─ memory.md                    ← 长期记忆，只保留「## 锚点」段会被注入提示词
├─ items.jsonl                  ← 分级事项，一行一条 JSON
├─ 2026-10-22.md                ← 当天日记正文（第一人称），文件名就是日期
└─ 2026-10-21.md
state/diary-session.json        ← 宿主态：日记专用会话的 sessionId / preset / dir
```

- `items.jsonl` 每条：`{ id, level, text, due, created, createdAt, source }`。
  写入走「先写 `.tmp` 再 rename」，中途崩溃不会留下半截清单；读时坏行跳过、不整份丢弃。
- `memory.md` 只有 `## 锚点` 段（以及自动拼上的「## 最近记录（来自日记）」）会进提示词。

## 保留策略

| 级别 | 含义 | 保留 |
| --- | --- | --- |
| **L1** | 很重要 | **永久**，永不自动删除 |
| **L2** | 不太重要但紧急、要尽快办 | **10 天**后自动删除 |
| **L3** | 不重要但值得记一笔 | **3 天**后自动删除 |

天数可用 `maxL2Days` / `maxL3Days` 调（下限 1）。级别只认 `1` / `2`，其余值（缺失、
`"2"`、`0`）一律归一成 L3 —— 这是刻意的保守取向：拿不准的事宁可 3 天后自动消失。

规则来源：用户 2026-10-19 定，见 `src/bridge.js` 日记区段顶部注释。

## 已知漂移（还没修，别以为已经修了）

`src/mcp-snowluma-safe.js` 里的四个模型可见工具 —— `qq_read_memory`、`qq_append_memory`、
`qq_read_diary`、`qq_read_chat_log` —— 仍然**硬编码** `'D:/日记/…'`（约 :1350 / :1364 /
:1405 / :1435），没有 import `src/diary-core.js`。后果是：把 `dir` 设置项或
`QQ_BRIDGE_DIARY_DIR` 改成别的目录后，桥接写在新目录、模型工具还读旧目录 —— 而 QQ 侧
没有任何回执能暴露这件事。

`scripts/test-qq-diary.mjs` 目前只钉住漂移的**上界**：硬编码站点不得超过 4 处，且每处
归一化后必须等于 `diary-core` 的默认目录。等 MCP 侧改成 `import { MEMORY_FILE, DIARY_DIR }`
之后站点数归零，那条断言不需要改就能继续通过。

## 安装（由仓库统一处理）

这个包作为 bundle 插件的注册清单在 `scripts/setup-dsh.mjs` / `scripts/verify-dsh-020-adaptation.mjs`
里维护，不在本包内。

## 测试

```bash
node scripts/test-qq-diary.mjs
```

纯 Node、不联网、**不碰真实的 `D:\日记`**：所有读写都指向 `os.tmpdir()` 下的临时目录，
跑完即删。覆盖插件包形态契约、L1/L2/L3 分级保留、日期与路径拼装、输出解析容错、
提示词关键片段。
