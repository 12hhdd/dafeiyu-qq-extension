# 「我的手机」全解（MuMu 模拟器 + MCP）

> 这篇回答四个问题：**agent 能对模拟器做什么**、**每个工具的参数与返回文案**、**为什么它是 MCP server 而不是插件**、**报错时先看哪一条**。
>
> 一句话总览：能力面是 `src/mcp-emu-phone.js` 这一个 **stdio MCP server**（11 个工具，模型可见名 `mcp__emu-phone__*`）；`plugins/qq-emu-phone/` 只是套在外面的一层 **settings 命名空间壳**，不实现任何 adb 动作。

---

## 一、一句话能力边界

**能做**：读屏幕（状态 / 截图 / 抽帧看视频）、列出当前界面可点的控件、按坐标或界面文字点按、点开输入框并确认键盘真的弹出、向输入框打字、按安卓按键、滑动、启停第三方 App。

**不能做**：

- 不接受 adb 任意命令、不接受 shell 命令字符串（`runAdb()` 只收 `args` 数组，逐个传给 `spawnSync`，`src/mcp-emu-phone.js:45`）；
- 不接受任意路径的读写——唯一会写文件的路径是 `state/agents/emu/shots/`（`src/mcp-emu-phone.js:23`）；
- 不装 APK、不抓包、不读通讯录/SMS/相册；
- 截不到**多窗口**：`uiautomator dump` 只导当前焦点窗口，分栏布局的另一栏取不到文字；
- `input text` 只吃 ASCII；中文/emoji 的主通道是 **ADBKeyboard 的 `ADB_INPUT_B64` 广播**（`src/mcp-emu-phone.js:267`），只有设备上没装 ADBKeyboard 才退回剪贴板粘贴（见 §2.6 `emu_text`）。

> 唯一的例外是**动画三档**：`ensureAnimationsOff()` 会 `settings put global` 把三档动画写成 0（`src/mcp-emu-phone.js:367`）。这不是「改系统设置」洁癖，是让 `uiautomator dump` 存活的前提（见 §三，根因 1）；而且每次都先读真实值，非 0 才写。

能力形态与 `mcp-snowluma-safe.js` 一样是「安全子集」：只把**人手动点点点能做的事**做成工具。

---

## 二、十一个工具：参数 / 返回文案 / 坑

返回文案全部逐字来自源码，属于**前端契约**（模型就是照着它说话、控制台就是照着它渲染），改代码时不要顺手改文案。小节顺序 = 源码里 `server.tool()` 的注册顺序，`scripts/test-qq-emu-phone.mjs:167-184` 把顺序钉死了。

### 2.1 `emu_status`（只读）

无参数。返回一段 JSON 文本（`src/mcp-emu-phone.js:529-552`）：

```json
{ "serial": "...", "android": "...", "model": "...", "abi": "...", "screen": "1080x1920", "foreground": "<包名/Activity>", "animations": "off" }
```

- `screen` 来自 `wm size`，解析失败兜底 `1080x1920`（`src/mcp-emu-phone.js:109`）——**兜底值可能就是错的**，坐标打偏时先怀疑这里。
- `foreground` 来自 `dumpsys window | grep -E "mCurrentFocus"`（`:113`），正则不中时原样返回 raw 或 `unknown`（`:114-115`）。
- `animations` 是 `settings get global animator_duration_scale` 的读数（`:534`）：等于 `0` 输出 `off`，否则输出 `on(<真实值>)`（`:545`）。**这一项不是装饰**——只要是 `on(...)`，`uiautomator dump` 很可能等不到 idle，所有「按控件」的工具都会失败（见 §三，根因 1）。看到 `on` 且点不到东西，先想到这条。
- 失败文案：`设备不可用：<原因>`（`:550`）。

### 2.2 `emu_screenshot`

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `maxWidth` | number | 900 | 缩放后最大宽度，夹在 320–1600（`:559`） |

流程：`screencap -p /sdcard/emu_mcp_shot.png`（`:123`）→ `adb pull` 成本地 `shot-<ts>.png`（`:125`）→ 用 System.Drawing 缩成 **JPEG**（quality 72，`toJpeg()` 在 `:133`）。

返回文案：`截图：<jpg 文件名>（原图 <png 文件名>），前台 <前台应用>`（`:560`），并附图片内容。

- **为什么转 JPEG**：源码注释写在 `:132`——「用 System.Drawing 把 PNG 缩成 JPEG，避免把几 MB 的原始截图塞进模型上下文」。原始 PNG 是几 MB 级，直接塞会瞬间吃满上下文。
- 坑①：**两张图都留在 `state/agents/emu/shots/`，代码里没有任何清理逻辑**（只有 `.adb-<stamp>.bin/.err` 临时文件会 unlink，`:70-71`）。长期用会堆出上千个文件——本机实测该目录已有 319 个文件。要清理就自己按时间删，删目录不影响功能。
- 坑②：`maxWidth` 调到 1600 更清晰但更费上下文；问「屏幕上是啥」用默认 900 就够。
- 失败文案：`截图失败：<原因>`（`:562`），其中拉取失败会带尾巴 `（adbd root 变更后可能短暂断连）`（`:127`）。

### 2.3 `emu_tap`

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `x` / `y` | number（必填） | **逻辑坐标**，就是 `emu_status` 报的那个分辨率坐标系 |

返回文案：`已点击 (<x>, <y>)，前台 <前台应用>`（`:570`）；失败 `点击失败：<原因>`（`:571`）。

- 越界判据是 `cx<0 || cy<0 || cx>宽*2 || cy>高*2`（`:193`），越界抛 `坐标越界：<x>,<y>（屏幕 <宽>x<高>）`（`:194`）。
- 坑：这判据**很松**（宽高的 2 倍以内都放行）。截图被缩到 900px 宽之后，模型若照着**图片像素**报坐标就会整体偏移——永远按 `emu_status` 的逻辑坐标报。

### 2.4 `emu_tap_text`

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `text` | string（必填） | 界面上可见的文字、`content-desc`，或 `resource-id` 尾部（如 `et_editor`） |

打分在 `findTarget()`（`src/mcp-emu-phone.js:476-492`），六档取最小分：

| 分 | 命中条件 |
| --- | --- |
| 0 | `text === want` |
| 1 | `desc === want` |
| 2 | `resource-id` 的尾部（`/` 之后那段）`=== want`（`:482`） |
| 3 | `text.includes(want)` |
| 4 | `desc.includes(want)` |
| 5 | `resource-id.includes(want)` |

同分时的次序（`:490`）：**优先可点击**（`clickable=true`）→ 再**优先面积小**的（更可能是叶子控件而不是整块容器）。选完不用 `bounds` 中心点硬点，而是走 `safeCenter()`（`:439-444`）把坐标往控件内部收敛，靠屏幕底边手势区时再上移（详见 §三 3.2）。

点击前后各读一次前台应用（`:504`、`:507`），据此在返回里报告**界面到底有没有跳转**：

- 返回文案：`已点击「<命中文本或描述>」(<tx>, <ty>)，<note>`（`:581`），其中 `note` 是 `界面已变化（A → B）` 或 `界面未跳转（仍在 B）`（`:580`）；`<命中文本或描述>` 按 `text` → `desc` → `#rid尾` 的顺序取（`:579`）。
- 失败文案：`点击失败：<原因>`（`:582`）；空文本抛 `要点击的文字为空`（`:496`）。
- 找不到时的文案很有用：`没有找到可点击的「<text>」：当前界面可见文字 <前 24 条 text|desc|#rid，用 " | " 连>`（`:501`，列表由 `visibleText()` 生成，`:433-435`）。**照着这行改词重试**，不要瞎猜坐标。
- 坑：只认当前焦点窗口；WebView 里的文字有时在 `content-desc` 而不在 `text`。
- 坑：`界面未跳转（仍在 B）` 不一定是失败——勾选、展开、Toast 都不会换前台 Activity。别看到它就连点；要确认「点没点上」，用 `emu_ui` 看控件状态或截图看。

### 2.5 `emu_focus_text`（专治「输入框点不到」）

| 参数 | 类型 | 默认 | 说明（源码 describe 原文） |
| --- | --- | --- | --- |
| `text` | string | 无（不传=自动找） | 输入框文字/描述/id 尾部，默认自动找当前界面的 `EditText` |
| `submit` | boolean | 无（不传=不提交） | 聚焦后是否立刻输入文字并回车（配合 `value`） |
| `value` | string | 无（不传=不提交） | 要输入的搜索词/内容，配合 `submit` |

参数表来自 `src/mcp-emu-phone.js:588-590`（工具注册在 `:587`）。

流程（`focusEditor()`，`:448-474` + handler `:591-614`）：

1. 取一次界面 dump，用 `findTarget(nodes, text)` 找目标（`:453`）；没给 `text` 或没匹配上，就退化为「当前界面所有 `EditText`，优先面积 > 4000 的那个，否则第一个」（`:455-456`）。
2. 找不到输入框就直接失败，返回 `界面上没有找到输入框（可见：<可见文字>）`（`:458`，`reason` 原样作为错误文案）。
3. 最多点 4 次，每次换一组偏移（`:459-464`）：中心 `(0,0)` → 上移 30% 控件高 → 右移 25% 控件宽 → 左移 25% 控件宽；坐标过 `clampPoint()`（`:215-220`）保证不出屏。
4. 每次点完 `sleep(700)`，用 `imeShown()` 判「键盘是否真的弹出」（`:467-468`，判据见 §三 3.2）。弹出了就成功返回；没弹出再试下一组。
5. 成功且 `submit && value` 都为真时，再走一遍 `inputText(value)` + 回车（`:606-610`）。

返回文案（逐字）：

- 成功：`已聚焦输入框（第 <n> 次尝试，坐标 <x>,<y>），键盘已弹出`（`:605`），末尾再接 `。尝试记录 <px,py:ok|no，空格分隔>`（`:612`）。
- 带 `submit`+`value` 时中间追加：`；已输入并回车（<mode>，回读校验通过）：<value>`（`:610`）。
- 4 次都没弹出：`4 次尝试都没能唤出键盘（<尝试记录>）。可能该输入框被悬浮层遮挡，或需要先滑动把它挪到屏幕中间。`（`:600`，`isError`）。
- 外层异常：`聚焦失败：<原因>`（`:613`）。

- 坑：尝试记录就是**排错证据**——`px,py:no` 连成一串说明每次点击都没被 IME 接住，通常是控件被悬浮层压住或界面还在动画里（先看 `emu_status.animations`）。
- 坑：`text` 同时用于「找哪个框」和「后续 `inputText` 的回读校验目标」（`:607`）；多输入框界面一定带上它，否则可能聚焦了 A 框、回读却盯着 B 框。
- 坑：4 次尝试光等待就 3.6 秒（每次 `sleep(700)` + 200ms），每轮还要重新 dump 一次界面，实际更久；别在超时紧的场景里循环调用。

### 2.6 `emu_text`

| 参数 | 类型 | 默认 | 说明（源码 describe 原文） |
| --- | --- | --- | --- |
| `text` | string（必填） | — | 要输入的文字 |
| `enter` | boolean | 无（不传=不回车） | 输入后是否立刻回车（搜索框提交用） |
| `field` | string | 无 | 目标输入框的文字/描述/id 尾部（如 `et_title` / `et_content`）。多输入框界面强烈建议传，否则可能粘进当前还有焦点的别的框 |
| `replace` | boolean | false | 输入前先清空该输入框原有内容，默认 false（追加） |
| `focus` | boolean | true | 输入前先点开输入框，默认 true |

参数表来自 `src/mcp-emu-phone.js:617-621`。它已经不是「ASCII 走 input text，中文走剪贴板」两条分支了，现在是**三步流水线**：

1. **聚焦**（`focus !== false` 时，`:628-632`）：直接调 `focusEditor(field)` —— 就是 §2.5 那套「点完验 IME、没弹出换偏移重试」。注意它的注释（`:625-627`）：**不能用「键盘已弹出」判断焦点对不对**，上一个框的键盘还在时直接粘贴就会粘进旧框，所以指定了 `field` 时一律重新聚焦。
2. **可选清空**（`replace === true`，`:634-640`）：`input keycombination 113 29`（Ctrl+A，`:635`）→ `input keyevent 67`（DEL，`:637`）。
3. **输入**（`inputText()`，`:306-352`）：
   - 纯 ASCII（正则 `/^[\x20-\x7e\r\n\t]*$/`，`:309`）→ `input text '...'`，只做单引号转义 + 空格→`%s`（`:310`），mode = `ascii`；
   - 非 ASCII → **优先 ADBKeyboard**（`adbKeyboardInstalled()` 查 `ime list -s` 是否含 `com.android.adbkeyboard/.AdbIME`，`:229-235`）：`ime set ADBKeyboard` → `am broadcast -a ADB_INPUT_B64 --es msg <base64>`（`:267`）→ **`finally` 里切回用户输入法**（`:269-272`，`restoreIme()` 刻意排除 ADBKeyboard 自己，`:246-256`），mode = `adbkeyboard`；
   - 设备没有 ADBKeyboard（或广播后回读没进去）才**兜底走剪贴板**：`Set-Clipboard` → 等 900/1600/2600ms 递增 → `input keyevent 279`（KEYCODE_PASTE，`:334`）→ 回读校验，mode = `clipboard`；
   - 三轮兜底都没粘对，抛 `粘贴没生效（剪贴板同步太慢或被抢）。目标文字「<s>」，框里现在是「<回读>」。通常重试一次就好，或改用 emu_text 的 replace 清空后重来。`（`:351`）。
   - 最后 `enter` 为真时补一个 `keyevent 66`（`:642`）。

返回文案：`已输入<前缀>（<mode>[，等剪贴板 <n>ms]，回读校验通过）：<text>[，已回车]，当前 <前台应用>`（`:648`），其中前缀是：

- 聚焦成功：`（聚焦 <field 或「输入框」> <x>,<y>，第 <n> 次）`（`:630`）；
- 聚焦失败：`（聚焦输入框失败：<原因或尝试记录>）`（`:631`）；
- `replace` 又追加 `（已清空原内容）`（`:639`）。

例如：`已输入（聚焦 et_content 540,860，第 1 次）（adbkeyboard，回读校验通过）：晚上好，当前 com.example.app/…`。

其他失败文案：空文本抛 `要输入的文字为空`（`:308`）；写剪贴板失败抛 `写剪贴板失败：<原因>`（`:285`）；ADBKeyboard 广播失败抛 `ADBKeyboard 广播失败：<前 120 字>`（`:273`）；外层 `输入失败：<原因>`（`:652`）。

- **坑（最需要知道的一条）**：剪贴板污染**只发生在兜底路径**。主通道 ADBKeyboard 不动 Windows 剪贴板，但它会把模拟器的系统输入法**临时切成 ADBKeyboard 再切回**（`currentIme()` 读原值，`:237-239`；`restoreIme()` 兜底还原，`:246-256`）。只有设备上没装 ADBKeyboard、退到剪贴板时，才会**覆盖你 Windows 的系统剪贴板**且粘完不恢复——那时剪贴板里有东西正在用的话，先自己存好。
- 坑：它只往**当前焦点**的输入框打字，默认会自己先点（`focus: true`），但点不点得开取决于 `focusEditor`；实在点不开就先单独调 `emu_focus_text`，再传 `focus: false` 调 `emu_text`。
- 坑：`replace` 是 Ctrl+A + **一个** DEL（`:635`、`:637`），不是循环清空；多行框里 Ctrl+A 实际选中范围随控件实现而定（没逐个 App 实测），选不全就会留下尾巴。要彻底清空，补几次 `emu_key del` 更稳。
- 坑：ASCII 分支的转义只处理了单引号与空格，文本里带别的特殊字符（`%` 等）有被设备侧 shell / `input` 解释的风险，没实测过；要输入怪字符走 ADBKeyboard（含非 ASCII 就会走它）更稳。
- 提示：`emu_text` 的**工具描述**（`server.tool()` 第二个参数，`:616`）已随主通道切换同步为「中文走 ADBKeyboard 的 base64 广播，没装 ADBKeyboard 才退回共享剪贴板粘贴」。这句描述是模型唯一能看到的说明，改通道时**必须同时改它**——否则模型会照着旧文案对外说「用剪贴板粘的」。
- 坑：回读校验靠 dump 输入框的 `text` 属性（`fieldText()`，`:289-301`）——密码框的 `text` 属性通常是掩码或空，可能永远 `includes` 不到原文，于是三轮重试后报 `粘贴没生效`。密码类输入要接受「可能是假失败」。

### 2.7 `emu_ui`（只读：看清界面上有什么可点）

| 参数 | 类型 | 默认 | 说明（源码 describe 原文） |
| --- | --- | --- | --- |
| `limit` | number | 60 | 最多返回多少个控件，默认 60 |
| `clickableOnly` | boolean | true | 只列可点击控件，默认 true |

参数表来自 `src/mcp-emu-phone.js:657-658`（工具注册在 `:656`）。

流程（`:659-676`）：`uiNodes()` 拿整棵树（`:661`）→ 过滤 `clickable || class 含 EditText`（`:664`，`clickableOnly === false` 时不过滤）→ 再滤掉「没有 text/desc/rid 且不是 EditText」的纯容器（`:665`）→ 按 `cy` 从上到下排（`:666`）→ 截前 `limit` 个，`limit` 夹在 1–200（`:667`）。

返回文案：

```
前台 <前台应用>
[<cx>,<cy>] <text 或 desc>[ #<resource-id 尾部>][ (不可点)]
...
```

行格式见 `:668`（`#` 前有一个空格，`(不可点)` 前也有一个空格）；整段是 `前台 ${foreground()}\n` + 每行 join（`:672`）。一个控件都没有时第二段是 `当前界面没有可识别控件`（`:672`）；失败文案 `读取界面失败：<原因>`（`:675`）。

- 坑：坐标是**逻辑坐标**（`parseNodes()` 算的 `bounds` 中心），可以直接喂 `emu_tap`，不要再按截图换算。
- 坑：`clickableOnly: true` 会漏掉「容器可点、文字在子节点」的场景（很多列表项就是这样）。这时候用 `clickableOnly: false` 看全量，或者直接 `emu_tap_text` 按文字点。
- 坑：它和 `emu_tap_text` 用的是同一套 dump（同样受动画/残缺影响）；输出为空或明显比屏幕少，先查 §七 ①/⑦。

### 2.8 `emu_key`

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `key` | string（必填） | 键名（大小写不敏感）或纯数字 keycode |

内置 28 个键（`:170-176`）：`home:3 back:4 call:5 endcall:6 volume_up:24 volume_down:25 power:26 camera:27 clear:28 tab:61 enter:66 del:67 menu:82 notification:83 search:84 media_play_pause:85 media_next:87 media_previous:88 page_up:92 page_down:93 escape:111 forward_del:112 move_end:123 move_home:122 recent:187 paste:279 wakeup:224 sleep:223`。

返回文案：`已按 <key>（keycode <code>），前台 <前台应用>`（`:681`）；未知键抛 `未知按键：<name>（可用：home/back/...）`（`:182`，可用列表就是上表的键名按定义顺序 join）；外层失败 `按键失败：<原因>`（`:682`）。

- 坑：`power` 是**电源键**——按一下就熄屏/亮屏，误按会让后续 `uiautomator dump` 拿不到界面。
- 坑：`del` 与 `forward_del` 不同：`del`(67) 是退格，`forward_del`(112) 是往后删；清空输入框用 `del`。

### 2.9 `emu_swipe`

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `x1` / `y1` / `x2` / `y2` | number（必填） | — | 起点 → 终点（逻辑坐标） |
| `durationMs` | number | 300 | 夹在 50–3000（`:690`） |

返回文案：`已滑动 (<x1>,<y1>)→(<x2>,<y2>) <d>ms`（`:692`）；失败 `滑动失败：<原因>`（`:693`）。

- 坑：`durationMs` 太短（50–100）在列表上会被识别成「快速甩动」，翻过头；翻页用 300–600 更稳。

### 2.10 `emu_app`

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `action` | `start` / `stop` / `list`（必填） | 启动 / 强制停止 / 列出**第三方**应用 |
| `package` | string | `start`/`stop` 必填 |

返回文案：

- `list`：每行一个包名（`listApps()`，`:511-513`，来自 `pm list packages -3` 去掉 `package:` 前缀），整段用 `\n` 连（`:702`）；
- `start`：`已启动 <包名>`（`:520`，实际命令 `monkey -p <包名> -c android.intent.category.LAUNCHER 1`）；
- `stop`：`已停止 <包名>`（`:521`，实际命令 `am force-stop`）；
- 失败：`操作失败：<原因>`（`:703`）；未知动作 `未知动作：<action>（可用 start/stop/list）`（`:522`）；包名不含法字符抛 `包名不合法`（`:519`，白名单正则 `/^[a-zA-Z0-9._]+$/`）。

- 坑：`monkey` 只能拉起**有 LAUNCHER 入口**的包；纯服务型包报不了。抖音第一次冷启动要等 3–5 秒。
- 坑：`list` 只列第三方（`-3`），系统应用（设置、桌面）永远不出现在列表里。

### 2.11 `emu_watch`（抽帧看视频）

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `seconds` | number | 30 | 观察时长，夹在 5–120（`:711`） |
| `intervalSec` | number | 2 | 采样间隔，夹在 1–10（`:712`） |

它不自己截图，而是调本机脚本 `state/agents/emu/watch.ps1`（`:713` 取路径、`:718` 起 powershell）：定时截图 → 用汉明距离去重 → 最多保留 12 张关键帧 → 拼成 3 列九宫格 → 输出 `state/agents/emu/shots/watch-<ts>.png`。

返回文案：`看板图：<png 文件名> <脚本 stdout 末 3 行>`（`:727`），并附拼图；失败分三种：

- `缺少抽帧脚本 <绝对路径>`（`:714`）——`state/` 不入库，换机器就没有；
- `抽帧失败：<stderr 或 stdout 前 400 字>`（`:724`）；
- 外层 `看视频失败：<原因>`（`:729`）。

- 坑：工具超时是 `(seconds + 90) * 1000` 毫秒（`:720`）；`seconds=120` 时单次调用最长 210 秒，DSH 侧 MCP 条目的 `toolCallTimeoutMs` 必须 ≥ 300000（`setup-dsh.mjs` 就是这么配的，别改小）。
- 坑：`seconds` 越小、`intervalSec` 越大，越容易对「2 秒就换一帧」的短视频漏关键帧。

---

## 三、为什么会有 `emu_ui` / `emu_focus_text`

这两个工具不是「顺手加的便利功能」，是两次**根因修复**的产物：在这台模拟器上，「按文字点不到控件」「输入框点不进去」曾经是稳定复现的。这一节只讲病因和处方，工具用法见 §2.5 / §2.7。

### 3.1 根因 1：uiautomator 永远等不到 idle state

**症状**：`uiautomator dump` 报 `ERROR: could not get idle state.` + `Segmentation fault`，**而且根本不生成 XML 文件**（源码注释 `:355-357`）。下游表现就是「没有找到可点击的 xxx」，或者点到一个这屏根本不存在的坐标。

**病因**：目标界面一直在跑动画（无限循环的呼吸/轮播），uiautomator 要等界面 idle 才肯 dump，等不到就崩。实测：关掉三档动画后，10/10 次 dump 全部成功（59KB 完整树，`:356-357`）。

**处方**（三层，缺一层都会复发）：

1. **三档动画写 0**：`ANIM_KEYS = ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale']`（`:358`）；`ensureAnimationsOff()`（`:363-371`）先 `settings get global animator_duration_scale` 读真实值（`:365`），非 0 才把三档一起写 0（`:367`），写完 `sleep(300)`。
   - **不能缓存「已修好」**：模拟器重启、换 App 都会把动画改回来；缓存下来就会变成「第一次 dump 白等 40 秒才超时」（`:360-362`）。所以每次按控件操作前都重读一次——`settings get` 只要几十毫秒，比 40 秒超时便宜得多。
2. **先删旧 XML 再 dump**：`dumpOnce()`（`:375-381`）先 `rm -f /sdcard/emu_mcp_ui.xml`（`:376`）→ `uiautomator dump`（`:377`）→ `cat` 回来（`:379`）。不删的话，dump 失败时 `cat` 读到的是**上一屏的陈旧 XML**，于是拿着旧坐标点新界面（`:373-374`）。
3. **校验产物并重试**：`dumpUiXml()`（`:383-397`）要求同时含 `<hierarchy` 与 `</hierarchy>`（`:389`）、且 `<node ` 的数量 > 3（`:390-391`），残缺就重试（最多 3 次，`:383`）；第一次失败后再关一次动画（`:393`）并 `sleep(600)`。判据来自实测：残缺时文件只有 5KB 且缺 `</hierarchy>`（`:374`）。

`emu_status` 的 `animations` 字段（§2.1）就是这条路线的「体温计」，`emu_ui` 是「眼睛」。

### 3.2 根因 2：输入框点不到

两件事叠在一起（注释写在 `:437-438`、`:446-447`）：

1. **控件中心点可能落在容器 View 的缝隙上**：例如评论框外面还覆了一层 `vg_editor_container`，dump 出来的 `bounds` 是外层容器，中心点正好压在缝里，点下去没反应。
2. **键盘弹起后布局会上移**：点第一下弹出键盘、界面重排，手里那套坐标立刻作废，第二次点等于点空。

**处方**：

- **判据只认 IME 有没有真的弹出**：`imeShown()`（`:206-213`）读 `dumpsys input_method | grep -m1 mInputShown`（`:208`），只认 `mInputShown=true`（`:209`）。不认「tap 返回 0」、不认「没报错」——那些都证明不了焦点进去了。
- `focusEditor()`（`:448-474`）最多试 4 次，每次换一组偏移（`:459-464`）：中心 → 上移 30% 控件高 → 右移 25% 控件宽 → 左移 25% 控件宽；每次点完 `sleep(700)` 再验 IME，尝试记录形如 `px,py:ok` / `px,py:no`（`:469`）。没传 `text` 时退化成「当前界面所有 `EditText`，优先面积 > 4000 的」（`:455-456`）。
- `safeCenter()`（`:439-444`）把点往控件**内部**收敛：纵向最多内缩 `min(控件高 × 25%, 18px)`（`:440`）；控件落在屏幕底部手势区（`y2 > 屏幕高 - 120`）时再额外上移这么多（`:442`），最后过一遍 `clampPoint()`（`:215-220`）保证不出屏。
- `emu_ui` 是配套的观测手段：点不准时先让它把可点控件连坐标列出来（§2.7），别再盲猜。

### 3.3 附带的第三个坑：剪贴板同步是异步的

Windows 剪贴板 → 模拟器共享剪贴板**不是同步的**。实测会粘出**两轮之前的旧内容**，表现是标题粘进正文框、正文粘进标题框（注释在 `:222-225`）。所以中文输入换了主通道：

- **主通道 = ADBKeyboard**：`ime set` 切过去 → `am broadcast -a ADB_INPUT_B64 --es msg <base64>`（`:267`）→ `sleep(900)` → **`finally` 切回用户输入法**（`:269-272`）。IME 走 `commitText` 直接提交给输入连接，没有同步延迟、没有抢占；base64 在 Node 里算（`:259` 记的坑：用 PowerShell 传中文参数会被转成 GBK，到手机上就是乱码）。
- **还原输入法有讲究**：`restoreIme()`（`:246-256`）**不**直接还原到「切换前那个」——如果上一轮崩在中途，切换前就是 ADBKeyboard 自己，还回去等于把用户键盘永久换掉（`:241-243` 是实测踩过的坑）。所以它是「排除 ADBKeyboard 后找系统输入法」。
- **剪贴板只当兜底**，且必须**回读校验**：粘完用 `fieldText()` dump 出输入框的 `text` 属性比对（`:289-301`），这是唯一能确证结果的手段（退出码/IME 状态都不可信，`:290`）；没进去就删掉残留（`:342-349`：`keyevent 123` 到行尾 + 按差值退格 `keyevent 67`）再试，等待按 900/1600/2600ms 递增（`:329`）。三轮都失败才抛 `粘贴没生效（…）`。

---

## 四、配置项

### 4.1 `config.json` 的 `emuPhone` 段（MCP server 真正读的）

`emuCfg()` 读 `config.json` 的 `emuPhone`（`src/mcp-emu-phone.js:35-43`）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `adb` | `<MuMu 安装盘>:\mumu\MuMuPlayer\nx_main\adb.exe` | adb 可执行文件（`:38`） |
| `serial` | `''` | 指定设备 serial；空=自动探测（`:39`） |
| `connect` | `true`（`!== false`，`:40`） | 允许失败时主动 `adb connect` |
| `connectTarget` | `127.0.0.1:16384` | `adb connect` 目标（MuMu NAT 模式，`:41`） |

> ⚠️ **`config.example.json` 里没有 `emuPhone` 段**（模板里只有 `dsh` / `role` / `snowluma` / `allow` / `diary` 等）。要改就得自己在真实 `config.json`（不入库）里手写这一段，不写也行——四个键全有默认值兜底，本机现在就是「没有这一整段照样跑」。

### 4.2 DSH 设置命名空间 `qq-emu-phone`（**当前不影响实际执行**）

`plugins/qq-emu-phone/lib/index.js:82-99` 声明了四个字段，全部 `.extra('volatile', true)`：

| 字段 | 类型 | 默认 | 说明（schema 原文） |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 仅记录开关，真正执行仍由 MCP 条目与 adb 决定 |
| `adbPath` | string | `<MuMu 安装盘>:\mumu\MuMuPlayer\nx_main\adb.exe` | adb 路径 |
| `connectTarget` | string | `127.0.0.1:16384` | adb connect 目标 |
| `toolCallTimeoutMs` | number | `300000` | 单次工具调用超时 |

**关键坑（文档与代码不一致，见交付说明）**：`src/mcp-emu-phone.js` 只读 `config.json`，**全仓没有任何代码读 `qq-emu-phone` 命名空间**。也就是说在 DSH 设置页改 `adbPath` / `connectTarget` **不会**改变实际 adb 调用——要真改，改 `config.json` 的 `emuPhone`。这两个地方目前是**两份互不同步的配置**。

### 4.3 环境变量

| 变量 | 作用 |
| --- | --- |
| `QQ_EMU_PHONE_DIAG` | 插件诊断日志路径；不设=写 `os.tmpdir()/qq-emu-phone-plugin.log`，设成空串=关闭（`plugins/qq-emu-phone/lib/index.js:31-37`） |

MCP server 侧没有任何环境变量。

---

## 五、为什么是这个形态

**为什么工具在 MCP server 里、不在插件里**：MCP server 是**独立进程**（`stdio`），由 DSH 的 MCP 客户端 spawn（`src/mcp-emu-phone.js:1`），它在自己进程里调 `adb.exe`、跑 PowerShell、读 `config.json`——这些动作跟 DSH 插件进程的生命周期、沙箱会话都不该绑在一起。做成 11 个 MCP 工具还有两个直接好处：工具名/描述/schema 就是模型看到的契约；`scripts/test-mcp-servers-stdio.mjs` 能真握手 `listTools` 验一遍。

**那插件壳是干什么的**：只为了让 `adbPath` / `connectTarget` / `toolCallTimeoutMs` 在 DSH 设置页**看得见**——换机器基本都要改 adb 路径，藏在一个不存在的配置文件里不合理。所以插件里没有 client 半（没有浏览器 UI 卡片）、没有工具、`apply(ctx)` 只写一行诊断（`plugins/qq-emu-phone/lib/index.js:109-111`），连 `adb` 都不 import。

**为什么不拆成「插件直接提供工具」**：DSH 插件拿不到本机进程执行能力（沙箱里连命名管道都被禁），而 adb 就是外部进程。MCP server 是唯一合理载体。

**为什么 `runAdb()` 不用管道**：DSH 沙箱禁止命名管道，`spawnSync` 默认 `stdio: 'pipe'` 会直接 **EPERM**。所以改成**临时文件重定向**（`.adb-<stamp>.bin` / `.err`，跑完 unlink，`src/mcp-emu-phone.js:45-74`，注释在 `:48-49`、临时文件名在 `:51-52`、unlink 在 `:70-71`）——沙箱内外都能跑，顺带对二进制（`screencap`）安全。**这段注释别删，删了下一个人一定会改回管道再踩一遍**。

**两条独立通道**（缺一个的症状完全不同）：

| 缺什么 | 症状 |
| --- | --- |
| 缺插件（`BUNDLE_NAMES` 里没有 / 没重装） | DSH 设置页看不到 `qq-emu-phone` 命名空间，但**工具照常可用** |
| 缺 MCP 条目（`MANAGED_MCP_IDS` 里没有 / profile 里没插入） | `mcp__emu-phone__*` 完全不存在，但设置项可见 |

两处都由 `scripts/setup-dsh.mjs` 维护：`BUNDLE_NAMES`（`:89`）管插件，`MANAGED_MCP_IDS`（`:129`）管 MCP 条目，改完**必须重启 DSH**。

---

## 六、安全与风险

- **出站门禁不在这条链上**：模拟器动作不出网，所以没有 `SENSITIVE_RE` 那一层。真正的门禁在**消息出站**（`src/bridge.js` 回复审计）与**工具白名单**（`plugins/qq-agent-presets/qq-tool-restrict.mjs:169` 的 `SAFE_PREFIXES` 含 `mcp__emu-phone__`）——少这一条，QQ 会话里调用会被拒：`工具 "<name>" 不在 QQ 桥接白名单内，已拒绝（仅允许 QQ MCP 工具与无害模型侧工具）`。
- **只允许管理员用**：`dsh/agent-presets/qq-chat-v2/agent.cordis.yml:48` 起的【我的手机（仅限管理员）】段落限定只有 ownerQQ / 【管理员】消息能触发。预设里还写死了「设备不可用（工具报错）就如实说"我的手机现在连不上"，不要假装操作成功」；并且（`:59`）明确要求「点输入框一律优先 `emu_focus_text`，别自己 `emu_tap` 猜坐标」。
- **误操作后果**：`emu_tap` / `emu_text` / `emu_app stop` 都是**真的会动**的；`am force-stop` 会杀掉对方正在用的 App，`power` 会熄屏。没有「撤销」，只能靠人重新点回去。
- **改系统设置的两处**：三档动画被写成 0（`settings put global`，`:367`，会话结束不会自动还原——想还原就手动把三档设回 1）；中文输入会把模拟器输入法临时切成 ADBKeyboard 再切回（`:265`、`:269-272`，`restoreIme()` 保证异常也还原）。
- **剪贴板污染**：只有「设备没装 ADBKeyboard、退回剪贴板兜底」这条路会改写 Windows 系统剪贴板（见 §2.6、§三 3.3），这不是比喻——`Set-Clipboard` 就是改全局剪贴板，而且粘完不恢复。
- **用户数据目录**：`state/agents/emu/`（截图 + `watch.ps1` + 各种历史产物）属于运行时数据，`.gitignore` 排除了 `state/`。**不要删 `watch.ps1`**，`emu_watch` 依赖它；删了只报 `缺少抽帧脚本`，不会崩，但功能没了。
- **凭据**：这条链上没有任何凭据——adb 走的是本机 127.0.0.1:16384，不需要 token。反过来说：**谁能在这台机器上跑 adb，谁就能操作模拟器**，工具层只是把「跑什么 adb 命令」这件事限定死了。

---

## 七、排错

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

`screencap` 返回非 0，或者 pull 下来的文件 **< 1000 字节**（`:126`）被判为坏图。真因通常是：`adb root` 刚切过身份、或设备刚重启还是 offline。判据：`adb devices` 里那行是不是 `\tdevice` 结尾（代码就是按 `/\tdevice$/` 过滤的，`src/mcp-emu-phone.js:86`）。修法：等 3–5 秒重试；仍失败就 `adb kill-server` 后让工具重新探测（`detectSerial` 有缓存，重试前别指望它自己刷新——工具进程不重启就一直用旧 serial）。

### ③ `缺少抽帧脚本 <...>\state\agents\emu\watch.ps1`

`state/` 被 `.gitignore` 排除、不随仓库发布，换机器/清过一次 `state/` 就没了。`watch.ps1` 是脚本本体（九宫格拼图全在里面），**不是**能从缓存恢复的东西——从本机备份拿回来。没有它 `emu_watch` 一定失败，其他 10 个工具不受影响。

### ④ `没有找到可点击的「xxx」：当前界面可见文字 a | b | c`

这是**最常见的"看起来像 bug"**，其实信息够了：

- 看那串可见文字，换个词再点（可能实际文字带空格/符号/是繁体）；
- 一串都很短或是英文 ⇒ `uiautomator dump` 只导当前焦点窗口，你要点的东西可能在**另一个分栏**里 ⇒ 先用 `emu_screenshot` 看一眼，再改用 `emu_tap` 坐标点；
- 如果连可见文字都是空的/明显比屏幕少，那是 dump 失败了，不是找不到 ⇒ 查 `emu_status.animations`（§2.1）和 §七 ⑦；
- 也可能是输入法把界面盖住了 ⇒ 先 `emu_key back` 收键盘。

### ⑤ `mcp__emu-phone__*` 工具根本不存在

不是设备问题，是**接线**问题。查：`scripts/setup-dsh.mjs` 的 `MANAGED_MCP_IDS` 有没有 `mcp-emu-phone`（`:129`）；profile 的 `cordis.patch.yml` 里有没有那段 `# === qq-bridge MCP BEGIN ===` 区块；然后**重启 DSH**。工具存在但调用报「不在 QQ 桥接白名单内」⇒ 是 `qq-tool-restrict.mjs` 的 `SAFE_PREFIXES` 少了前缀，不是设备问题。

### ⑥ `adb 执行失败：spawnSync ... EPERM`

说明有人把 `runAdb()` 改回了 `stdio: 'pipe'`。DSH 沙箱禁命名管道，这在沙箱里**必然** EPERM。改回临时文件重定向（见 §五）。

### ⑦ `4 次尝试都没能唤出键盘（...）` / `界面上没有找到输入框（可见：...）`

`emu_focus_text`（或 `emu_text` 的自动聚焦）四次都没让 IME 弹出，说明点下去根本没落到输入框上：

- 先看尝试记录 `px,py:no`：四组偏移全 `no` ⇒ 坐标压根不对或界面还在动（查 `emu_status.animations`，见 §三 3.1）；
- `界面上没有找到输入框` ⇒ 当前 dump 里没有 `EditText`：可能键盘是「点搜索图标才展开」、输入框在 WebView 里、或要滚动才出现 ⇒ `emu_ui` 看清结构后先滑一下/点一下再重试；
- 输入框被悬浮层（弹窗、Toast、权限提示）盖住 ⇒ 先关掉遮挡物；
- 设备熄屏了（误按过 `power`）⇒ `emu_key wakeup` 再试。

---

## 八、相关文件索引

| 文件:行 | 内容 |
| --- | --- |
| `src/mcp-emu-phone.js:1` / `:3-7` | 头注释：stdio MCP server，由 DSH 的 MCP 客户端 spawn；只暴露「看/点/输入/按键/启停 App/抽帧」 |
| `src/mcp-emu-phone.js:9-11` / `:22-23` | 前置条件（`net_bridge_open -val false` → NAT 16384 → emulator-5554）；`EMU_DIR = state/agents/emu`、`SHOT_DIR = EMU_DIR/shots` |
| `src/mcp-emu-phone.js:25-43` | `loadConfig()` / `emuCfg()`：读 `config.json` 的 `emuPhone`，四个默认值（`:38` adb / `:39` serial / `:40` connect / `:41` connectTarget） |
| `src/mcp-emu-phone.js:45-74` | `runAdb()`：参数数组 + 临时文件重定向（`:48-49` 沙箱禁命名管道的注释、`:51-52` 临时文件名、`:70-71` unlink、`:72` EPERM 文案） |
| `src/mcp-emu-phone.js:76-98` | `detectSerial()`：`adb devices`（`:86` 按 `\tdevice` 过滤）→ start-server/connect → 选 serial（`:95` 无设备文案、`:96` 缓存） |
| `src/mcp-emu-phone.js:100-104` | `sh()`：统一 `-s <serial> shell <cmd>` |
| `src/mcp-emu-phone.js:106-116` | `screenSize()`（`:109` 兜底 1080x1920）/ `foreground()`（`:113` mCurrentFocus 正则、`:115` raw/unknown 兜底） |
| `src/mcp-emu-phone.js:118-157` | `capturePng()`（`:123` screencap、`:125` pull、`:126` <1000 字节判坏图）/ `toJpeg()`（`:132` 注释、`:133` quality 72、`:156` 退回原图） |
| `src/mcp-emu-phone.js:159-168` | `imageResult()`（text + image 两段 content） |
| `src/mcp-emu-phone.js:170-185` | `KEYMAP` 28 键 / `keyevent()`（`:182` 未知键文案） |
| `src/mcp-emu-phone.js:187-197` | `tap()` 越界判据（`:193` / `:194`） |
| `src/mcp-emu-phone.js:199-220` | `sleep()`（Atomics.wait）/ `imeShown()`（`:208` `dumpsys input_method` + `grep -m1 mInputShown`）/ `clampPoint()` |
| `src/mcp-emu-phone.js:222-275` | ADBKeyboard 主通道：`ADB_KB_IME`（`:226`）/ `adbKeyboardInstalled()`（`:229-235`）/ `currentIme()`（`:237-239`）/ `restoreIme()`（`:246-256`）/ `inputByAdbKeyboard()`（`:265` 切 IME、`:267` 广播、`:269-272` try/finally 还原） |
| `src/mcp-emu-phone.js:277-301` | 剪贴板兜底 `setWindowsClipboard()`（`:285` 失败文案）/ `fieldText()` 回读校验（`:291-301`） |
| `src/mcp-emu-phone.js:303-352` | `inputText()`：`:309` ASCII 正则、`:310` `input text`、`:319-325` ADBKeyboard 优先、`:329` 递增等待 900/1600/2600、`:334` keyevent 279、`:342-349` 残留清理、`:351` 三轮失败文案 |
| `src/mcp-emu-phone.js:354-397` | 根因 1：`ANIM_KEYS`（`:358`）/ `ensureAnimationsOff()`（`:363-371`）/ `dumpOnce()`（`:376` 先删旧 XML、`:377` dump）/ `dumpUiXml()`（`:389-391` 完整性校验、`:393` 再关一次动画） |
| `src/mcp-emu-phone.js:399-435` | `parseNodes()`（`:409` bounds、`:412` 0 尺寸丢弃、`:423` area）/ `uiNodes()` / `visibleText()`（默认 24 条） |
| `src/mcp-emu-phone.js:437-509` | 根因 2：`safeCenter()`（`:440` insetY、`:442` 手势区上移）/ `focusEditor()`（`:459-464` 四组偏移、`:468` IME 判据）/ `findTarget()`（`:480-486` 六档打分、`:490` 同分排序）/ `tapText()`（`:501` 找不到文案、`:504-508` 前后台对比） |
| `src/mcp-emu-phone.js:511-523` | `listApps()` / `appAction()`（`:519` 包名正则、`:520` start、`:521` stop、`:522` 未知动作） |
| `src/mcp-emu-phone.js:527` / `:733` | `new McpServer({ name: 'emu-phone', version: '0.2.0-r3' })`（version 必须等于根 `package.json`）/ `connect(new StdioServerTransport())` |
| `src/mcp-emu-phone.js:529-552` | `emu_status`（`:534` 动画读数、`:545` `animations` 字段、`:550` 失败文案） |
| `src/mcp-emu-phone.js:554-564` | `emu_screenshot`（`:559` clamp 320–1600、`:560` 文案） |
| `src/mcp-emu-phone.js:566-572` | `emu_tap`（`:570` 文案、`:571` 失败文案） |
| `src/mcp-emu-phone.js:574-583` | `emu_tap_text`（`:575` schema、`:579` label、`:580` 跳转判定、`:581` 文案） |
| `src/mcp-emu-phone.js:585-614` | `emu_focus_text`（`:587` 注册、`:588-590` 三个参数、`:600` 四次失败文案、`:605` 成功文案、`:606-610` submit+value、`:613` 外层失败文案） |
| `src/mcp-emu-phone.js:616-653` | `emu_text`（`:617-621` 五个参数、`:630` 聚焦前缀、`:635` Ctrl+A、`:648` 文案、`:652` 外层失败文案） |
| `src/mcp-emu-phone.js:655-676` | `emu_ui`（`:656` 注册、`:657-658` 两个参数、`:667` limit 夹 1–200、`:668` 行格式、`:672` 文案、`:675` 失败文案） |
| `src/mcp-emu-phone.js:678-683` | `emu_key`（`:681` 文案） |
| `src/mcp-emu-phone.js:685-694` | `emu_swipe`（`:690` clamp 50–3000、`:692` 文案） |
| `src/mcp-emu-phone.js:696-704` | `emu_app`（`:702` list 用 `\n` 连、`:703` 失败文案） |
| `src/mcp-emu-phone.js:706-731` | `emu_watch`（`:713` 脚本路径、`:720` 超时 `(seconds+90)*1000`、`:724` 抽帧失败、`:727` 文案） |
| `plugins/qq-emu-phone/lib/index.js:47-60` | `name` / `inject: ['settings']` / `EMUPHONE_NAMESPACE` / 默认 adb 路径与 connect 目标 |
| `plugins/qq-emu-phone/lib/index.js:82-99` / `:109-111` | `Config` 四个字段（全 `volatile`）/ `apply(ctx)` 只写诊断 |
| `plugins/qq-emu-phone/cordis.patch.yml` | entry `id` 必须等于命名空间；顶层 YAML 数组 |
| `scripts/setup-dsh.mjs:89` / `:129` / `:138` | `BUNDLE_NAMES` 含 `qq-emu-phone` / `MANAGED_MCP_IDS` 含 `mcp-emu-phone` / MCP 条目（`toolCallTimeoutMs: 300000`） |
| `scripts/test-qq-emu-phone.mjs:158-166` / `:167-184` | 断言 `McpServer` 的 `version` 等于根包、不残留 `1.0.0` / 断言共 11 个工具且顺序钉死（`:173`）、两个新工具必须在列（`:177-179`） |
| `plugins/qq-agent-presets/qq-tool-restrict.mjs:169` | `SAFE_PREFIXES` 含 `mcp__emu-phone__` |
| `dsh/agent-presets/qq-chat-v2/agent.cordis.yml:48` / `:59` | 预设里的【我的手机（仅限管理员）】段落 / 「点输入框一律优先 `emu_focus_text`」 |
| `state/agents/emu/README.md` | 环境、NAT 修复记录、`emu.ps1` 助手、已装应用（state/ 不入库） |

跑 `emu_watch` 需要的 `state/agents/emu/watch.ps1` 也在这个目录（同样不入库）。
