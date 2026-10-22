# qq-emu-phone

「我的手机」——本机 MuMu 安卓模拟器控制能力的 **DSH bundle 插件壳**（settings 命名空间 `qq-emu-phone`）。

> 一句话：**本插件只提供配置项容器，不实现任何 adb 动作。** 真正的工具面是
> `src/mcp-emu-phone.js` 这个 stdio MCP server，由 `scripts/setup-dsh.mjs` 以绝对路径
> 注册成 DSH 的 MCP 条目，DSH 侧暴露为 `mcp__emu-phone__emu_*`。

---

## 1. 两条通道，各管一件事（不要混）

| 层 | 落地物 | 谁注册 | 缺了会怎样 |
| --- | --- | --- | --- |
| **DSH 插件（本包）** | `package.json` + `cordis.patch.yml` + `lib/index.js` | `scripts/setup-dsh.mjs` 的 `BUNDLE_NAMES` / `ensureBundle()` 建两层链接，再 `patchProfilePackage()` 写进 profile 的 `dependencies` + `dsh.profile.bundles[]` | 设置页里看不到 `qq-emu-phone` 命名空间；**工具照常可用** |
| **MCP 工具端点** | `src/mcp-emu-phone.js`（单文件，399 行） | `scripts/setup-dsh.mjs` 的 `MANAGED_MCP_IDS`（`mcp-emu-phone`）+ `mcpEntries()` 的 `servers` 表，生成 `@deepseek-ai/dsh-mcp-client` loader 行，`command: <node 绝对路径>` / `args: ['<src/mcp-emu-phone.js 绝对路径>']` / `toolCallTimeoutMs: 300000` | 工具 `mcp__emu-phone__*` 完全不存在；**设置项照常可见** |

所以本插件**不 import** `src/mcp-emu-phone.js`，也不重写一遍 `emuCfg()` —— 两边各自从
`config.json` 的 `emuPhone` 段/DSH 设置读参数是历史现状，改动其中一边不会自动同步到另一边。

### 为什么它要存在（既然工具本来就是 MCP）

模拟器的动作面全部在 DSH 之外（adb → 模拟器），本不需要 bundle。做这一层是为了让
`adbPath` / `connectTarget` / `toolCallTimeoutMs` 这几个「换机器就要改」的参数能从
**DSH 设置页**看见与修改，而不是只能手改 `config.json`。设置能不能写，取决于下面三个
前提是否同时成立（缺一即整条命名空间不可写）。

---

## 2. `cordis.patch.yml` 的死契约（最容易踩）

```yaml
- insert:
    - id: qq-emu-phone     # ← 必须等于 lib/index.js 导出的 EMUPHONE_NAMESPACE
      name: qq-emu-phone   # ← 包名
      config: {}
```

- 顶层必须是 **YAML 数组**，每项是 `{insert: [...]}`。
- DSH 的 `settings.write()` 用
  `configEditor.entries().find((row) => row.options.id === ns)` 定位可写目标，再用
  `entry.fiber.runtime.Config` 取 schema。**id 与命名空间不同名 ⇒ 永远抛
  `No configurable plugin entry "qq-emu-phone"`**，写入只在本地生效。
- 本插件里命名空间名与包名**恰好相同**（`qq-emu-phone`），这是故意的简化；一旦将来
  改名，先改 `EMUPHONE_NAMESPACE` 再改这里的 `id`，`name` 永远跟包名。

另两条前提在 `lib/index.js`：

1. 导出 `Config`（schemastery schema）；
2. `Config` **至少一个字段带 `.extra('volatile', true)`**，否则 DSH 抛
   `Plugin entry ... has no volatile fields`。

⚠️ 只写 `.extra('volatile', true)`，**不要写 `.volatile()`** —— 仓库钉的
`@deepseek-ai/schemastery@^3.18.1` 没有那个方法，会 `TypeError`。

---

## 3. 配置项（命名空间 `qq-emu-phone`）

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 能力开关（仅记录意图；真正执行仍由 MCP 条目 + adb 决定） |
| `adbPath` | string | `<MuMu 安装盘>:\mumu\MuMuPlayer\nx_main\adb.exe` | adb 可执行文件路径（MuMu 默认安装位，**换机器基本都要改**；本仓库源码里不含任何本机盘符路径） |
| `connectTarget` | string | `127.0.0.1:16384` | `adb connect` 目标（MuMu NAT 模式） |
| `toolCallTimeoutMs` | number | `300000` | 单次工具调用超时毫秒（与 `mcpEntries()` 里的一致；`emu_watch` 抽帧最长 120s） |

全部字段都是 volatile（可热改、不重挂载）。

诊断日志：默认写 `os.tmpdir()/qq-emu-phone-plugin.log`，可用环境变量
`QQ_EMU_PHONE_DIAG` 覆盖路径（空字符串 = 关闭）。**不要**改成按相对层级往上爬目录 ——
插件是以 `link:<DSH_HOME>/plugins/qq-emu-phone` 装进 profile 的，往上是 `<DSH_HOME>/..`，
会在任意非作者机器上于用户主目录旁凭空建目录（qq-mode-console 踩过这个坑）。

---

## 4. 工具清单（在 `src/mcp-emu-phone.js`，共 9 个）

DSH 侧调用名 = `mcp__emu-phone__<工具名>`。所有 handler 都 `try/catch`，失败返回
`{content:[{type:'text',text:'…失败：…'}], isError:true}`，不会让 MCP 连接崩掉。

| 工具 | 参数 | 行为 |
| --- | --- | --- |
| `emu_status` | 无 | 只读：serial / android 版本 / 型号 / ABI / 分辨率 / 前台应用 |
| `emu_screenshot` | `maxWidth?` (number，默认 900，夹在 320–1600) | 截图 → System.Drawing 压成 JPEG → 返回图片 + 原图文件名 |
| `emu_tap` | `x` (number), `y` (number) | 点击逻辑坐标；坐标越界（> 屏幕 2 倍或负数）直接抛错 |
| `emu_tap_text` | `text` (string) | uiautomator dump 后按 text/content-desc 精确优先匹配，命中即点 |
| `emu_text` | `text` (string) | ASCII 走 `input text`；中文/非 ASCII 走 Windows 剪贴板 + `KEYCODE_PASTE`(279) |
| `emu_key` | `key` (string) | 按键名（home/back/enter/recent/power/volume_up/volume_down/del/move_end/paste…），也接受纯数字 keycode |
| `emu_swipe` | `x1`,`y1`,`x2`,`y2` (number), `durationMs?`（默认 300，夹 50–3000） | `input swipe` |
| `emu_app` | `action` (`'start'\|'stop'\|'list'`), `package?` (string) | `list` = `pm list packages -3`；start/stop 要求包名匹配 `^[a-zA-Z0-9._]+$` |
| `emu_watch` | `seconds?`（默认 30，夹 5–120）, `intervalSec?`（默认 2，夹 1–10） | 抽帧看视频：调用 `state/agents/emu/watch.ps1`，只留有变化的帧拼成看板图 |

前置条件（本机已修好，见 `state/agents/emu/README.md`；`state/` 不入库）：

```
MuMuManager.exe setting -v 0 -k net_bridge_open -val false
```

→ NAT 模式下 `127.0.0.1:16384` 提供 ADB，adb 自动发现 `emulator-5554`。

---

## 5. 安全边界

- 只暴露「看屏幕 / 点按 / 输入 / 按键 / 启停 App / 抽帧看视频」这类沙盒内行为；
- **不暴露 adb 任意命令、不接受 shell 命令字符串、不接受任意路径读写**；
- 所有 shell 参数逐个数组传入（`spawnSync(adb, args)`），不做字符串拼接，避免注入；
- 子进程输出走**临时文件重定向**而不是管道：DSH 沙箱禁止命名管道，
  `spawnSync` 默认 `stdio:'pipe'` 会 EPERM；
- 唯一的路径参数是 `emu_app` 的包名（正则白名单）与工具内部自算的截图目录。

### 关于 QQ 会话工具白名单

本插件**不投递**任何工具白名单 —— 白名单在 `plugins/qq-agent-presets/qq-tool-restrict.mjs`
里，与插件包无关。现状是 `mcp__emu-phone__` **已经**在该文件的 `SAFE_PREFIXES` 中
（`qq-tool-restrict.mjs:169`，带注释说明「动作全部在模拟器沙盒内」），即仿真会话可以用它；
而 `RULES.md:38` / `docs/guides/SECURITY_BASELINE.md:41` 的文档侧**只列了 3 个命名空间**，
属于既有漂移。改白名单请改那三处，**不要**改本插件的 `cordis.patch.yml` —— 两者无关。

---

## 6. 测试

- `scripts/test-qq-emu-phone.mjs`：纯 Node、不联网、不启动 adb、不需要模拟器在线。
  覆盖包形态（字段齐全 + version 与根包相等）、`cordis.patch.yml` 的 id/name 契约、
  `lib/index.js` 的 `import()` 导出面与 `Config` 的 volatile 字段、以及
  `src/mcp-emu-phone.js` 里 `McpServer` 的 version 字面量与根包一致。
- `scripts/test-mcp-servers-stdio.mjs`：以 stdio 真拉起 `src/mcp-emu-phone.js` 并
  `listTools()`（不需要模拟器在线，握手阶段不碰 adb）。

```powershell
node scripts/test-qq-emu-phone.mjs
node scripts/test-mcp-servers-stdio.mjs
```
