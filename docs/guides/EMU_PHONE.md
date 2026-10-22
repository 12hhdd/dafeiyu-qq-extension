# 「我的手机」全解（MuMu 模拟器 + MCP）

> 这篇回答四个问题：**agent 能对模拟器做什么**、**每个工具的参数与返回文案**、**为什么它是 MCP server 而不是插件**、**报错时先看哪一条**。
>
> 一句话总览：能力面是 `src/mcp-emu-phone.js` 这一个 **stdio MCP server**（9 个工具，模型可见名 `mcp__emu-phone__*`）；`plugins/qq-emu-phone/` 只是套在外面的一层 **settings 命名空间壳**，不实现任何 adb 动作。

---

## 一、一句话能力边界

**能做**：读屏幕（状态 / 截图 / 抽帧看视频）、按坐标或界面文字点按、向当前输入框打字、按安卓按键、滑动、启停第三方 App。

**不能做**：

- 不接受 adb 任意命令、不接受 shell 命令字符串（`runAdb()` 只收 `args` 数组，逐个传给 `spawnSync`，`src/mcp-emu-phone.js:45`）；
- 不接受任意路径的读写——唯一会写文件的路径是 `state/agents/emu/shots/`（`src/mcp-emu-phone.js:23`）；
- 不装 APK、不改系统设置、不抓包、不读通讯录/SMS/相册；
- 截不到**多窗口**：`uiautomator dump` 只导当前焦点窗口，分栏布局的另一栏取不到文字；
- `input text` 只吃 ASCII，中文靠剪贴板粘贴（见 §2 `emu_text`）。

能力形态与 `mcp-snowluma-safe.js` 一样是「安全子集」：只把**人手动点点点能做的事**做成工具。

---

## 二、九个工具：参数 / 返回文案 / 坑

返回文案全部逐字来自源码，属于**前端契约**（模型就是照着它说话、控制台就是照着它渲染），改代码时不要顺手改文案。

### 2.1 `emu_status`（只读）

无参数。返回一段 JSON 文本（`src/mcp-emu-phone.js:295-302`）：

```json
{ "serial": "...", "android": "...", "model": "...", "abi": "...", "screen": "1080x1920", "foreground": "<包名/Activity>" }
```

- `screen` 来自 `wm size`，解析失败兜底 `1080x1920`（`src/mcp-emu-phone.js:109`）——**兜底值可能就是错的**，坐标打偏时先怀疑这里。
- `foreground` 来自 `dumpsys window | grep mCurrentFocus`，正则不中时原样返回 raw 或 `unknown`（`src/mcp-emu-phone.js:112-116`）。
- 失败文案：`设备不可用：<原因>`（`:306`）。

### 2.2 `emu_screenshot`

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `maxWidth` | number | 900 | 缩放后最大宽度，夹在 320–1600（`:315`） |

流程：`screencap -p /sdcard/emu_mcp_shot.png` → `adb pull` 成本地 `shot-<ts>.png` → 用 System.Drawing 缩成 **JPEG**（quality 72）。

返回文案：`截图：<jpg 文件名>（原图 <png 文件名>），前台 <前台应用>`（`:316`），并附图片内容。

- **为什么转 JPEG**：源码注释写在 `:132`——「用 System.Drawing 把 PNG 缩成 JPEG，避免把几 MB 的原始截图塞进模型上下文」。原始 PNG 是几 MB 级，直接塞会瞬间吃满上下文。
- 坑①：**两张图都留在 `state/agents/emu/shots/`，代码里没有任何清理逻辑**（只有 `.adb-<stamp>.bin/.err` 临时文件会 unlink，`:70-71`）。长期用会堆出上千个文件——本机实测该目录已有 319 个文件。要清理就自己按时间删，删目录不影响功能。
- 坑②：`maxWidth` 调到 1600 更清晰但更费上下文；问「屏幕上是啥」用默认 900 就够。
- 失败文案：`截图失败：<原因>`（`:318`），其中拉取失败会带尾巴 `（adbd root 变更后可能短暂断连）`（`:127`）。

### 2.3 `emu_tap`

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `x` / `y` | number（必填） | **逻辑坐标**，就是 `emu_status` 报的那个分辨率坐标系 |

返回文案：`已点击 (<x>, <y>)，前台 <前台应用>`（`:326`）；失败 `点击失败：<原因>`（`:327`）。

- 越界判据是 `cx<0 || cy<0 || cx>宽*2 || cy>高*2`（`:191`），越界抛 `坐标越界：<x>,<y>（屏幕 <宽>x<高>）`（`:192`）。
- 坑：这判据**很松**（宽高的 2 倍以内都放行）。截图被缩到 900px 宽之后，模型若照着**图片像素**报坐标就会整体偏移——永远按 `emu_status` 的逻辑坐标报。

### 2.4 `emu_tap_text`

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `text` | string（必填） | 界面上可见的文字或 `content-desc` |

打分顺序（`:249-255`）：`text === want`(0) → `desc === want`(1) → `text.includes(want)`(2) → `desc.includes(want)`(3)，取最小分，然后点该控件 `bounds` 的中心点。

返回文案：`已点击「<命中文本或描述>」(<cx>, <cy>)，前台 <前台应用>`（`:335`）；失败 `点击失败：<原因>`（`:336`）。

- 找不到时的文案很有用：`没有找到可点击的「<text>」：当前界面可见文字 <前 20 条 text|desc，用 " | " 连>`（`:262-264`）。**照着这行改词重试**，不要瞎猜坐标。
- 坑：只认当前焦点窗口；WebView 里的文字有时在 `content-desc` 而不在 `text`。

### 2.5 `emu_text`

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `text` | string（必填） | 要输入到**当前输入框**的文字 |

两条分支（`src/mcp-emu-phone.js:197-214`）：

| 分支 | 判据 | 实现 | 返回里的 mode |
| --- | --- | --- | --- |
| ASCII | `/^[\x20-\x7e\r\n\t]*$/`（`:200`） | `input text '...'`，只做单引号转义 + 空格→`%s`（`:201`） | `ascii` |
| 非 ASCII | 其余情况 | `Set-Clipboard` 写 Windows 剪贴板 → 等 300ms（`:211`）→ `input keyevent 279`（KEYCODE_PASTE，`:212`） | `clipboard` |

返回文案：`已输入（<ascii|clipboard>）：<text>`（`:342`）；空文本抛 `要输入的文字为空`（`:199`）；写剪贴板失败抛 `写剪贴板失败：<原因>`（`:210`）；外层失败 `输入失败：<原因>`（`:343`）。

- **坑（最需要知道的一条）**：中文输入会**覆盖你 Windows 的系统剪贴板**，粘贴完不会恢复原内容。剪贴板里有东西正在用的话，先自己存好。
- 坑：它只往**当前焦点**的输入框打字，不负责点输入框。先 `emu_tap` / `emu_tap_text` 点进去，再 `emu_text`。
- 坑：ASCII 分支的转义只处理了单引号与空格，文本里带别的特殊字符（`%` 等）有被设备侧 shell / `input` 解释的风险，没实测过；要输入怪字符走中文那条路（剪贴板）更稳。

### 2.6 `emu_key`

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `key` | string（必填） | 键名（大小写不敏感）或纯数字 keycode |

内置 25 个键（`:170-176`）：`home:3 back:4 call:5 endcall:6 volume_up:24 volume_down:25 power:26 camera:27 clear:28 tab:61 enter:66 del:67 menu:82 notification:83 search:84 media_play_pause:85 media_next:87 media_previous:88 page_up:92 page_down:93 escape:111 forward_del:112 move_end:123 move_home:122 recent:187 paste:279 wakeup:224 sleep:223`。

返回文案：`已按 <key>（keycode <code>），前台 <前台应用>`（`:349`）；未知键抛 `未知按键：<name>（可用：home/back/...）`（`:183`，可用列表就是上表的键名按定义顺序 join）；外层失败 `按键失败：<原因>`（`:350`）。

- 坑：`power` 是**电源键**——按一下就熄屏/亮屏，误按会让后续 `uiautomator dump` 拿不到界面。

### 2.7 `emu_swipe`

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `x1` / `y1` / `x2` / `y2` | number（必填） | — | 起点 → 终点（逻辑坐标） |
| `durationMs` | number | 300 | 夹在 50–3000（`:358`） |

返回文案：`已滑动 (<x1>,<y1>)→(<x2>,<y2>) <d>ms`（`:360`）；失败 `滑动失败：<原因>`（`:361`）。

- 坑：`durationMs` 太短（50–100）在列表上会被识别成「快速甩动」，翻过头；翻页用 300–600 更稳。

### 2.8 `emu_app`

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `action` | `start` / `stop` / `list`（必填） | 启动 / 强制停止 / 列出**第三方**应用 |
| `package` | string | `start`/`stop` 必填 |

返回文案：

- `list`：每行一个包名、整段用 `\n` 连（`:370`，来自 `pm list packages -3` 去掉 `package:` 前缀）；
- `start`：`已启动 <包名>`（`:279`，实际命令 `monkey -p <包名> -c android.intent.category.LAUNCHER 1`）；
- `stop`：`已停止 <包名>`（`:280`，实际命令 `am force-stop`）；
- 失败：`操作失败：<原因>`（`:371`）；未知动作 `未知动作：<action>（可用 start/stop/list）`（`:281`）；包名不含法字符抛 `包名不合法`（`:278`，白名单正则 `/^[a-zA-Z0-9._]+$/`）。

- 坑：`monkey` 只能拉起**有 LAUNCHER 入口**的包；纯服务型包报不了。抖音第一次冷启动要等 3–5 秒。
- 坑：`list` 只列第三方（`-3`），系统应用（设置、桌面）永远不出现在列表里。

### 2.9 `emu_watch`（抽帧看视频）

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `seconds` | number | 30 | 观察时长，夹在 5–120（`:379`） |
| `intervalSec` | number | 2 | 采样间隔，夹在 1–10（`:380`） |

它不自己截图，而是调本机脚本 `state/agents/emu/watch.ps1`（`:381`、`:386`）：定时截图 → 用汉明距离去重 → 最多保留 12 张关键帧 → 拼成 3 列九宫格 → 输出 `state/agents/emu/shots/watch-<ts>.png`。

返回文案：`看板图：<png 文件名> <脚本 stdout 末 3 行>`（`:395`），并附拼图；失败分三种：

- `缺少抽帧脚本 <绝对路径>`（`:382`）——`state/` 不入库，换机器就没有；
- `抽帧失败：<stderr 或 stdout 前 400 字>`（`:392`）；
- 外层 `看视频失败：<原因>`（`:397`）。

- 坑：工具超时是 `(seconds + 90) * 1000` 毫秒（`:388`）；`seconds=120` 时单次调用最长 210 秒，DSH 侧 MCP 条目的 `toolCallTimeoutMs` 必须 ≥ 300000（`setup-dsh.mjs` 就是这么配的，别改小）。
- 坑：`seconds` 越小、`intervalSec` 越大，越容易对「2 秒就换一帧」的短视频漏关键帧。

---

## 三、配置项

### 3.1 `config.json` 的 `emuPhone` 段（MCP server 真正读的）

`emuCfg()` 读 `config.json` 的 `emuPhone`（`src/mcp-emu-phone.js:35-43`）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `adb` | `<MuMu 安装盘>:\mumu\MuMuPlayer\nx_main\adb.exe` | adb 可执行文件（`:38`） |
| `serial` | `''` | 指定设备 serial；空=自动探测（`:39`） |
| `connect` | `true`（`!== false`，`:40`） | 允许失败时主动 `adb connect` |
| `connectTarget` | `127.0.0.1:16384` | `adb connect` 目标（MuMu NAT 模式，`:41`） |

> ⚠️ **`config.example.json` 里没有 `emuPhone` 段**（模板里只有 `dsh` / `role` / `snowluma` / `allow` / `diary` 等）。要改就得自己在真实 `config.json`（不入库）里手写这一段，不写也行——四个键全有默认值兜底，本机现在就是「没有这一整段照样跑」。

### 3.2 DSH 设置命名空间 `qq-emu-phone`（**当前不影响实际执行**）

`plugins/qq-emu-phone/lib/index.js:82-99` 声明了四个字段，全部 `.extra('volatile', true)`：

| 字段 | 类型 | 默认 | 说明（schema 原文） |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 仅记录开关，真正执行仍由 MCP 条目与 adb 决定 |
| `adbPath` | string | `<MuMu 安装盘>:\mumu\MuMuPlayer\nx_main\adb.exe` | adb 路径 |
| `connectTarget` | string | `127.0.0.1:16384` | adb connect 目标 |
| `toolCallTimeoutMs` | number | `300000` | 单次工具调用超时 |

**关键坑（文档与代码不一致，见交付说明）**：`src/mcp-emu-phone.js` 只读 `config.json`，**全仓没有任何代码读 `qq-emu-phone` 命名空间**。也就是说在 DSH 设置页改 `adbPath` / `connectTarget` **不会**改变实际 adb 调用——要真改，改 `config.json` 的 `emuPhone`。这两个地方目前是**两份互不同步的配置**。

### 3.3 环境变量

| 变量 | 作用 |
| --- | --- |
| `QQ_EMU_PHONE_DIAG` | 插件诊断日志路径；不设=写 `os.tmpdir()/qq-emu-phone-plugin.log`，设成空串=关闭（`plugins/qq-emu-phone/lib/index.js:31-37`） |

MCP server 侧没有任何环境变量。

---

## 四、为什么是这个形态

**为什么工具在 MCP server 里、不在插件里**：MCP server 是**独立进程**（`stdio`），由 DSH 的 MCP 客户端 spawn（`src/mcp-emu-phone.js:1`），它在自己进程里调 `adb.exe`、跑 PowerShell、读 `config.json`——这些动作跟 DSH 插件进程的生命周期、沙箱会话都不该绑在一起。做成 9 个 MCP 工具还有两个直接好处：工具名/描述/schema 就是模型看到的契约；`scripts/test-mcp-servers-stdio.mjs` 能真握手 `listTools` 验一遍。

**那插件壳是干什么的**：只为了让 `adbPath` / `connectTarget` / `toolCallTimeoutMs` 在 DSH 设置页**看得见**——换机器基本都要改 adb 路径，藏在一个不存在的配置文件里不合理。所以插件里没有 client 半（没有浏览器 UI 卡片）、没有工具、`apply(ctx)` 只写一行诊断（`plugins/qq-emu-phone/lib/index.js:109-111`），连 `adb` 都不 import。

**为什么不拆成「插件直接提供工具」**：DSH 插件拿不到本机进程执行能力（沙箱里连命名管道都被禁），而 adb 就是外部进程。MCP server 是唯一合理载体。

**为什么 `runAdb()` 不用管道**：DSH 沙箱禁止命名管道，`spawnSync` 默认 `stdio: 'pipe'` 会直接 **EPERM**。所以改成**临时文件重定向**（`.adb-<stamp>.bin` / `.err`，跑完 unlink，`src/mcp-emu-phone.js:48-72`）——沙箱内外都能跑，顺带对二进制（`screencap`）安全。**这段注释别删，删了下一个人一定会改回管道再踩一遍**。

**两条独立通道**（缺一个的症状完全不同）：

| 缺什么 | 症状 |
| --- | --- |
| 缺插件（`BUNDLE_NAMES` 里没有 / 没重装） | DSH 设置页看不到 `qq-emu-phone` 命名空间，但**工具照常可用** |
| 缺 MCP 条目（`MANAGED_MCP_IDS` 里没有 / profile 里没插入） | `mcp__emu-phone__*` 完全不存在，但设置项可见 |

两处都由 `scripts/setup-dsh.mjs` 维护：`BUNDLE_NAMES`（`:89`）管插件，`MANAGED_MCP_IDS`（`:129`）管 MCP 条目，改完**必须重启 DSH**。

---

## 五、安全与风险

- **出站门禁不在这条链上**：模拟器动作不出网，所以没有 `SENSITIVE_RE` 那一层。真正的门禁在**消息出站**（`src/bridge.js` 回复审计）与**工具白名单**（`plugins/qq-agent-presets/qq-tool-restrict.mjs:169` 的 `SAFE_PREFIXES` 含 `mcp__emu-phone__`）——少这一条，QQ 会话里调用会被拒：`工具 "<name>" 不在 QQ 桥接白名单内，已拒绝（仅允许 QQ MCP 工具与无害模型侧工具）`。
- **只允许管理员用**：`dsh/agent-presets/qq-chat-v2/agent.cordis.yml:48` 起的【我的手机（仅限管理员）】段落限定只有 ownerQQ / 【管理员】消息能触发。预设里还写死了「设备不可用（工具报错）就如实说"我的手机现在连不上"，不要假装操作成功」。
- **误操作后果**：`emu_tap` / `emu_text` / `emu_app stop` 都是**真的会动**的；`am force-stop` 会杀掉对方正在用的 App，`power` 会熄屏。没有「撤销」，只能靠人重新点回去。
- **剪贴板污染**：中文输入会改写 Windows 系统剪贴板（见 §2.5），这不是比喻——`Set-Clipboard` 就是改全局剪贴板。
- **用户数据目录**：`state/agents/emu/`（截图 + `watch.ps1` + 各种历史产物）属于运行时数据，`.gitignore` 排除了 `state/`。**不要删 `watch.ps1`**，`emu_watch` 依赖它；删了只报 `缺少抽帧脚本`，不会崩，但功能没了。
- **凭据**：这条链上没有任何凭据——adb 走的是本机 127.0.0.1:16384，不需要 token。反过来说：**谁能在这台机器上跑 adb，谁就能操作模拟器**，工具层只是把「跑什么 adb 命令」这件事限定死了。

---

## 六、排错

### ① `设备不可用：没有可用的模拟器设备：请确认 MuMu 已启动且 ADB 端口已开（MuMuManager.exe adb -v 0）`

按顺序查三件事：

1. MuMu 本体起了没（不只是管理器窗口）；
2. ADB 端口开没开：跑 `MuMuManager.exe adb -v 0`，**应该返回 `{"adb_host":"127.0.0.1","adb_port":16384}`**；
3. 返回空/报错 ⇒ 实例又开了**桥接网卡**（`.nemu` 里 NAT 转发被塞进 `<DisabledModes>`）。这是本项目历史上踩过的根因，修法是：

```
MuMuManager.exe setting -v 0 -k net_bridge_open -val false
MuMuManager.exe control -v 0 restart
```

（完整背景在 `state/agents/emu/README.md`，state/ 不入库。）

### ② `截图失败（adbd root 变更后可能短暂断连）：...`

`screencap` 返回非 0，或者 pull 下来的文件 **< 1000 字节**（`:126`）被判为坏图。真因通常是：`adb root` 刚切过身份、或设备刚重启还是 offline。判据：`adb devices` 里那行是不是 `\tdevice` 结尾（代码就是按 `/^\tdevice$/` 过滤的，`src/mcp-emu-phone.js:86`）。修法：等 3–5 秒重试；仍失败就 `adb kill-server` 后让工具重新探测（`detectSerial` 有缓存，重试前别指望它自己刷新——工具进程不重启就一直用旧 serial）。

### ③ `缺少抽帧脚本 <...>\state\agents\emu\watch.ps1`

`state/` 被 `.gitignore` 排除、不随仓库发布，换机器/清过一次 `state/` 就没了。`watch.ps1` 是脚本本体（九宫格拼图全在里面），**不是**能从缓存恢复的东西——从本机备份拿回来。没有它 `emu_watch` 一定失败，其他 8 个工具不受影响。

### ④ `没有找到可点击的「xxx」：当前界面可见文字 a | b | c`

这是**最常见的"看起来像 bug"**，其实信息够了：

- 看那串可见文字，换个词再点（可能实际文字带空格/符号/是繁体）；
- 一串都很短或是英文 ⇒ `uiautomator dump` 只导当前焦点窗口，你要点的东西可能在**另一个分栏**里 ⇒ 先用 `emu_screenshot` 看一眼，再改用 `emu_tap` 坐标点；
- 也可能是输入法把界面盖住了 ⇒ 先 `emu_key back` 收键盘。

### ⑤ `mcp__emu-phone__*` 工具根本不存在

不是设备问题，是**接线**问题。查：`scripts/setup-dsh.mjs` 的 `MANAGED_MCP_IDS` 有没有 `mcp-emu-phone`（`:129`）；profile 的 `cordis.patch.yml` 里有没有那段 `# === qq-bridge MCP BEGIN ===` 区块；然后**重启 DSH**。工具存在但调用报「不在 QQ 桥接白名单内」⇒ 是 `qq-tool-restrict.mjs` 的 `SAFE_PREFIXES` 少了前缀，不是设备问题。

### ⑥ `adb 执行失败：spawnSync ... EPERM`

说明有人把 `runAdb()` 改回了 `stdio: 'pipe'`。DSH 沙箱禁命名管道，这在沙箱里**必然** EPERM。改回临时文件重定向（见 §4）。

---

## 七、相关文件索引

| 文件:行 | 内容 |
| --- | --- |
| `src/mcp-emu-phone.js:1` / `:3-7` | 头注释：stdio MCP server，由 DSH 的 MCP 客户端 spawn；只暴露「看/点/输入/按键/启停 App/抽帧」 |
| `src/mcp-emu-phone.js:9-11` / `:22-23` | 前置条件（`net_bridge_open -val false` → NAT 16384 → emulator-5554）；`EMU_DIR = state/agents/emu`、`SHOT_DIR = EMU_DIR/shots` |
| `src/mcp-emu-phone.js:35-43` | `emuCfg()`：读 `config.json` 的 `emuPhone`，四个默认值（`adb` / `serial` / `connect` / `connectTarget`） |
| `src/mcp-emu-phone.js:45-74` | `runAdb()`：参数数组 + 临时文件重定向（`:48-49` 沙箱禁命名管道的注释，`:51` 临时文件名） |
| `src/mcp-emu-phone.js:77-96` | `detectSerial()`：`adb devices` → start-server/connect → 选 serial（`:95` 无设备文案） |
| `src/mcp-emu-phone.js:106-116` | `screenSize()`（`:109` 兜底 1080x1920）/ `foreground()`（mCurrentFocus 正则） |
| `src/mcp-emu-phone.js:118-151` | `capturePng()`（screencap → pull，`:126` <1000 字节判坏图）/ `toJpeg()`（System.Drawing 缩图，quality 72） |
| `src/mcp-emu-phone.js:160-185` | `imageResult()`（text + image 两段 content）/ `KEYMAP` 25 键 + `keyevent()`（`:183` 未知键文案） |
| `src/mcp-emu-phone.js:187-214` | `tap()` 越界判据（`:191` / `:192`）/ `inputText()`（`:200` 正则、`:205` Set-Clipboard、`:212` keyevent 279） |
| `src/mcp-emu-phone.js:216-268` | `uiNodes()`（uiautomator dump 解析）/ `tapText()`（`:249-255` 打分、`:262-264` 找不到时的可见文字） |
| `src/mcp-emu-phone.js:270-282` | `listApps()` / `appAction()`（`:278` 包名正则、`:279` start、`:280` stop、`:281` 未知动作） |
| `src/mcp-emu-phone.js:286` / `:401` | `new McpServer({ name: 'emu-phone', version: '0.2.0-r3' })`（version 必须等于根 `package.json`）/ `connect(new StdioServerTransport())` |
| `src/mcp-emu-phone.js:288-337` | `emu_status`（`:306` 失败文案）/ `emu_screenshot`（`:315` clamp、`:316` 文案）/ `emu_tap`（`:326`）/ `emu_tap_text`（`:335`） |
| `src/mcp-emu-phone.js:339-372` | `emu_text`（`:342`）/ `emu_key`（`:349`）/ `emu_swipe`（`:358` clamp、`:360` 文案）/ `emu_app`（`:370` list） |
| `src/mcp-emu-phone.js:374-399` | `emu_watch`（`:381` 脚本路径、`:388` 超时、`:395` 文案） |
| `plugins/qq-emu-phone/lib/index.js:47-60` | `name` / `inject: ['settings']` / `EMUPHONE_NAMESPACE` / 默认 adb 路径与 connect 目标 |
| `plugins/qq-emu-phone/lib/index.js:82-99` / `:109-111` | `Config` 四个字段（全 `volatile`）/ `apply(ctx)` 只写诊断 |
| `plugins/qq-emu-phone/cordis.patch.yml` | entry `id` 必须等于命名空间；顶层 YAML 数组 |
| `scripts/setup-dsh.mjs:89` / `:129` / `:138` | `BUNDLE_NAMES` 含 `qq-emu-phone` / `MANAGED_MCP_IDS` 含 `mcp-emu-phone` / MCP 条目（`toolCallTimeoutMs: 300000`） |
| `scripts/test-qq-emu-phone.mjs:158-172` | 断言 `McpServer` 的 `version` 等于根包、不残留 `1.0.0`、共 9 个工具且顺序钉死 |
| `plugins/qq-agent-presets/qq-tool-restrict.mjs:169` | `SAFE_PREFIXES` 含 `mcp__emu-phone__` |
| `dsh/agent-presets/qq-chat-v2/agent.cordis.yml:48` | 预设里的【我的手机（仅限管理员）】段落 |
| `state/agents/emu/README.md` | 环境、NAT 修复记录、`emu.ps1` 助手、已装应用（state/ 不入库） |

跑 `emu_watch` 需要的 `state/agents/emu/watch.ps1` 也在这个目录（同样不入库）。
