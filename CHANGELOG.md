# Changelog

本项目的所有值得注意的变更都会记录在这里。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

### 新增

- `emu_ui` 工具：**只读**列出当前界面的可点控件（文字 / 描述 / resource-id / 坐标），点不准时先看清再点，不必盲猜坐标
- `emu_focus_text` 工具：专治「输入框点不到」——点完用 IME 是否真的弹出做判定，没弹出就换偏移重试（最多 4 次）；可选 `submit` + `value` 聚焦后直接输入并回车
- `emu_status` 的返回 JSON 增加 `animations` 字段（`off` / `on(<值>)`），一眼看出动画三档是否已关

### 修复

- **`uiautomator dump` 永远等不到 idle state**：界面在跑动画时它会报 `ERROR: could not get idle state.` + `Segmentation fault`，且**根本不生成 XML**，导致所有「按控件点击」的操作连带失败。现在每次 dump 前把动画三档（`window_animation_scale` / `transition_animation_scale` / `animator_duration_scale`）写成 0；每次都读真实值再决定要不要写（模拟器重启 / 换 App 会改回来，缓存「已修好」会让首次 dump 白等 40 秒）
- **dump 读到上一屏的陈旧 XML**：先删旧文件再 dump，并校验 `<hierarchy>` 闭合与节点数，残缺就重试
- **中文输入粘错框、粘串行（标题/正文互串）**：Windows 剪贴板 → 模拟器共享剪贴板是**异步**的，实测会粘出两轮之前的旧内容。主通道改成 ADBKeyboard 的 `ADB_INPUT_B64` 广播（base64 在 Node 里算，避免 PowerShell 把中文转 GBK），剪贴板降级为兜底；兜底路径带「回读校验 + 删掉残留 + 递增等待 900/1600/2600ms 重试」。切 IME 走 `try/finally`，中途报错也会把键盘还给用户
- **`emu_tap_text` 点到容器缝隙 / 键盘弹起后点空**：新增 `safeCenter()` 把落点往控件内部收敛（底部手势区额外上移），打分逻辑扩到 resource-id 两档、同分优先可点击与优先叶子控件，并回报是否真的跳转了前台
- **`emu_text` 只看「键盘有没有弹出」判断焦点**：上一个框的键盘还在时会被误判成功。现在只要指定了 `field`（或默认开启 `focus`）就一律重新聚焦一次

### 变更

- `emu_text` 参数从 1 个扩到 5 个：`text` / `enter` / `field` / `replace` / `focus`
- `emu_tap_text` 返回文案改为报告界面是否变化：`界面已变化（A → B）` / `界面未跳转（仍在 B）`
- `emu_tap_text` 的 `text` 参数现在也接受 resource-id 尾部（如 `et_editor`）
- `src/mcp-emu-phone.js` 从 337 行增至 733 行，`scripts/test-qq-emu-phone.mjs` 的工具契约同步钉到 11 个

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
