# 语音发送全解

> 这篇回答三个问题：**怎么发**（四种入口）、**为什么发不出去**（闸门与排障）、**换账号后为什么 401**（token 自动发现）。
>
> 一句话总览：**AI 发语音默认是关的**（`socialV2.voice.enabled` 与 `socialV2.tools.sendVoice` 出厂都是 `false`），但你自己手动发（图形界面 / 命令行 / 控制台面板）**不受这个开关影响**。

---

## 一、四种入口，先认清你用的是哪一种

| 入口 | 谁在用 | 鉴权 | 受 `voice.enabled` 限制吗 |
| --- | --- | --- | --- |
| **独立发语音工具**（图形界面 `voice-gui.mjs` / 命令行 `voice-cli.mjs`，在仓库上一级的 `voice-tool/`） | 人 | SnowLuma token（自动发现） | ❌ 不受限 |
| **桥接 CLI** `scripts/send-voice.mjs`（`npm run send-voice`） | 人 | 桥接 → 控制台令牌 | ❌ 不受限 |
| **控制台「语音库」调试面板** | 人 | 控制台令牌 | ❌ 不受限 |
| **AI 工具** `qq_send_voice` / `qq_list_voices` | AI（大肥鱼） | agent token + 会话 key | ✅ **受限** |

前三个是**操作者通道**，第四个是 **AI 通道**。代码里这两条路是分开鉴权的（`src/bridge.js` 的 `/api/voice/send` vs `/api/socialV2/send-voice`），所以「AI 发语音没开」不会把你自己试发也一起封死 —— 否则你连放个音频听一下都做不到。

---

## 二、独立工具（图形界面 / 命令行）

发语音的本体已经不依赖 qq-bridge 运行了，拆到了仓库**上一级的 `voice-tool/`**：

```
工作区/
├── 发语音-图形界面.cmd     ← 工作区根的双击启动器 → 进 voice-tool/ 起图形界面
├── voice-tool/
│   ├── voice-gui.mjs       ← 图形界面：只监听 127.0.0.1 的本地小服务 + 一次性令牌
│   ├── voice-cli.mjs       ← 命令行：交互菜单 / send / list / check / remove / status
│   ├── public/voice.html   ← 浏览器 UI
│   ├── 发语音.cmd          ← voice-tool/ 内的双击启动器
│   └── config.json         ← 自己的配置（不入库）
└── qq-bridge/
    └── src/voice-core.js   ← 共享内核（单一实现，两个工具都指过来）
```

**双击 `发语音-图形界面.cmd`** 就会起图形界面。它只监听 `127.0.0.1`，并且带一次性令牌，所以本机其它程序不能直接调它的接口。

仓库内也留了转发用的 npm 脚本：

```bash
npm run voice-gui     # == cd ../voice-tool && node voice-gui.mjs
npm run voice-cli     # == cd ../voice-tool && node voice-cli.mjs
```

命令行常用命令：

```bash
node voice-cli.mjs status          # 账号 / token 自动发现结果 + 连通性
node voice-cli.mjs list            # 可发的群聊 / 私聊（含白名单状态）+ 语音库
node voice-cli.mjs send <音频> <目标>
node voice-cli.mjs remove <音频>   # 从语音库删
node voice-cli.mjs                 # 不带参数 = 交互菜单
```

### 配置解析顺序（工具拆出去之后最容易踩的地方）

独立工具按下面顺序**逐级覆盖**，先命中的赢：

```
1. 环境变量
2. voice-tool/config.json
3. ../qq-bridge/config.json      ← 兼容老部署，读不到自己的配置就回落这里
4. 内置默认值
```

认这 5 个环境变量：`SNOWLUMA_HTTP_URL`、`SNOWLUMA_TOKEN`、`SNOWLUMA_HOME`、`VOICE_DIR`、`FFMPEG_PATH`。

内置的 SnowLuma 默认路径（`DEFAULT_SNOWLUMA_HOME`）在找不到 `SNOWLUMA_HOME` 时兜底。**共享内核仍指向 `qq-bridge/src/voice-core.js`** —— 音频探测、音量处理、路径校验只有一份实现，不要在 `voice-tool/` 里复制一份。

---

## 三、桥接 CLI：`scripts/send-voice.mjs`

不想起图形界面、又想在桥接的规则内发送（白名单 / 限流 / 审计都生效）时用它：

```bash
node scripts/send-voice.mjs list                          # 列出可发的群聊/私聊（含白名单状态）
node scripts/send-voice.mjs list-voice [--no-probe]        # 列出语音库里的音频
node scripts/send-voice.mjs check <音频> [--transcode-test] # 只探测（时长/大小/编码）
node scripts/send-voice.mjs send <音频> <目标> [选项]      # 发送
node scripts/send-voice.mjs status                        # 网关 + 桥接 + 配置状态
```

目标写法：`100005` / `group:100005` / `private:100010` / `@群名或昵称`（要求唯一匹配）。

`send` 常用选项：

| 选项 | 作用 |
| --- | --- |
| `--dry-run` | 只解析与校验，不真发（走桥接的真实校验路径） |
| `--volume 2` | 音量倍数 `0.1 ~ 4`（1 = 原样）；手机外放听不清就调 `2 ~ 3` |
| `--normalize` | 智能音量：按 EBU R128 把整体响度拉到目标 |
| `--loudness loud` | 智能音量档位 `quiet(-20)` / `normal(-16)` / `loud(-13)`，默认 `normal` |
| `--no-verify` | 跳过发送后的回读校验（默认会 `get_msg` 回读确认语音段真落地） |
| `--transcript` | 额外索取 QQ 转写文本（只有**收到的**语音才有，自己发的一般为空） |
| `--voice-dir DIR` | 指定语音库目录（默认 `config.voice.dir` 或 `<repo>/audio`） |
| `--max-seconds N` / `--max-bytes N` | 时长 / 体积上限（默认 300 秒 / 20 MiB） |
| `--direct` | ⚠️ 绕过桥接直连 SnowLuma（**无白名单 / 限流 / 审计**，仅应急排查） |
| `--reveal-token` | 在 `status` 里显示完整令牌（默认打码） |

### 回读校验（`verified`）

默认发完会用 `get_msg` 把刚发的消息读回来，确认 `record` 段真的存在 → 返回 `verified: true`。
**只有 `verified: true` 才能对外说「语音已发送」**；`ok: true` 只代表网关接受了请求。QQ 侧偶发吞消息，这时 `ok=true / verified=false`，值得重发一次。

---

## 四、控制台「语音库」调试面板

控制台 → 工具开关页下方的「语音库」面板：

- 勾选框 **`qq_send_voice` / `qq_list_voices`** → 对应 `socialV2.tools.sendVoice`（这是 **AI 能不能用** 的开关）
- 面板调用 `GET /api/voice/list?probe=1` 列语音库（`probe=1` 会顺手探测时长/大小/编码）
- 「试发选中语音」调 `POST /api/voice/send`，可勾 `dryRun`

面板是**操作者通道**（凭控制台令牌），和 CLI 走同一条解析/校验/限流路径 —— 你在面板里试发成功了，AI 通道剩下的差别就只有那两个开关和会话白名单。

---

## 五、AI 通道：让她自己发

### 5.1 两个开关，都要开

| 配置项 | 出厂默认 | 管什么 |
| --- | --- | --- |
| `socialV2.voice.enabled` | `false` | 语音功能总闸（AI 能不能发 / 能不能列语音库） |
| `socialV2.tools.sendVoice` | `false` | `qq_send_voice` / `qq_list_voices` 这两个工具本身 |

两个都开，她才会在工具清单里看到语音工具。**改完必须重启 DSH**：工具清单与系统提示词是 DSH 启动时加载的，运行中改配置她那边看不到（会一直说「我这边没有语音工具」）。

### 5.2 人设提示词里也要写

`dsh/agent-presets/qq-chat-v2/agent.cordis.yml` 第 16 条工具协议描述语音能力，改写后要重新生成并部署：

```bash
node scripts/build-agent-preset-patches.mjs
node scripts/build-agent-preset-patches.mjs --check   # 确认不漂移
```

生成物是 `plugins/qq-agent-presets/presets/qq-chat-v2.patch.yml`，profile 里通过 junction 指回仓库，改仓库即改部署。

### 5.3 她的工具怎么用

- `qq_list_voices` —— 列语音库（文件名、时长、大小），返回里带 `limits`（时长/体积/频率上限）
- `qq_send_voice` —— 发一条，`voice` 传语音库里的文件名

**AI 只能发语音库里的文件**。给相对路径时只在 `socialV2.voice.dir` 内解析，路径穿越和符号链接逃逸都会被拒绝（`safeJoinLibrary`）。这条是硬边界：防 prompt injection 拿本机任意文件当语音外发。

---

## 六、HTTP 接口速查

| 方法 & 路径 | 通道 | 鉴权 |
| --- | --- | --- |
| `POST /api/voice/send`（别名 `/api/send/voice`） | 操作者 | 控制台令牌（`x-console-token`）；带 `x-agent-token` 会被拒，要求改走 AI 通道 |
| `POST /api/socialV2/send-voice` | AI | `key` + agent token；仅 `reserved2` 模式 |
| `GET /api/voice/list` / `GET /api/socialV2/voices` | 两者 | 操作者：控制台令牌；AI：`x-agent-token` + `key` |

AI 通道返回里的 `dir` 字段被抑制、提示语也不带绝对路径 —— 语音库路径不外泄给她。

`POST /api/voice/send` 请求体：`{ target | key, file | voice, dryRun?, volume?, normalize?, loudness? }`
`dry-run` 也走**与真发完全相同的解析与校验**（只是最后不把 `record` 段交出去），所以它是可信的预检，不是「随便过」。

---

## 七、限额与音频处理

`config.json` 的 `socialV2.voice` 出厂值：

```json
{
  "enabled": false,
  "dir": "audio",
  "maxSeconds": 300,
  "maxBytes": 20971520,
  "maxPerMinute": 2,
  "maxPerHour": 10,
  "allowAbsolutePath": false,
  "defaultVolume": 1,
  "loudness": "normal",
  "ffmpegPath": "",
  "autoReadback": true
}
```

- **限流与文本发送分开计数**：语音不吃聊天的额度，聊天也不吃语音的额度。
- **只检查、不预占额度**：额度在**真正发出去之后**才记账（`voiceBudgetCommit`）。参数错、被审计拦截、网关失败都不会白吃配额 —— 否则连失败几次就被假 429 卡死。
- 超限报错原文：`语音发送频率超限（每小时最多 N 条），请稍后再试`。
- **支持格式**：`.mp3 .wav .ogg .oga .opus .m4a .aac .flac .amr .silk .slk .wma .spx`
- **不需要自己转 SILK**：SnowLuma 会处理，塞 mp3 进去就行。本机不需要装 ffmpeg —— 只有用到音量/响度处理时才需要（`ffmpegPath` 或 `FFMPEG_PATH`）。
- **音量必须本地处理**：SnowLuma 的 `record` 段没有增益字段，所以 `--volume` / `--normalize` 是先用 ffmpeg 调好再发，临时文件发完即删。

---

## 八、排障

### 8.1 换 QQ 账号后，独立工具 401

**这是最常见的坑，而且不是 bug。**

SnowLuma 每个账号有各自的 `httpServers[].accessToken`，**HTTP 与 WebSocket 的 token 还不一样**。换账号登录后旧 token 直接 401（retcode `1401`），任何把 token 硬编码在 `config.json` 里的工具全部失效。

正确做法是让它**自动发现**，`src/snowluma-conn.js` 的 `discoverSnowLumaConnection` 会：

1. 按 `snowLumaHomeCandidates()` 找 SnowLuma home（`snowluma.homeDir` / 环境变量 / 内置默认路径）
2. 读 `<home>/config/` 下的 per-account token
3. 环境变量 `SNOWLUMA_TOKEN` 与 `config.json` 里已配置的 token 只作兼容兜底
4. 确认可用后用 `persistSnowLumaEndpoint()` 把 token/端点写回 `config.json`（只给必须持久化的组件用）

排查顺序：

1. `node voice-cli.mjs status` 看 token 从哪来、能不能连上
2. home 目录对不对 —— `snowluma.homeDir` 配错会导致 homeDir 被忽略、per-account token 一个都扫不到，界面显示「未连接」
3. 别把 `onebot.accessToken` 当成 `snowluma.accessToken` 读（字段读错 → 拿到空 token → 所有请求 401）

### 8.2 报「语音功能已关闭」

AI 通道判断的是 `socialV2.voice.enabled`。控制台勾上 `sendVoice` 之后还要确认这个总闸，两处都要开且**重启 DSH**。

### 8.3 报「工具未启用：qq_send_voice」

`socialV2.tools.sendVoice` 还是 `false`。这个开关在工具注册时判定（`src/mcp-snowluma-safe.js`），改完同样要重启 DSH。

### 8.4 报「只接受本地文件」/「找不到音频」

- 不收 `base64://`、`data:`、`http(s)://` —— 只收本地文件。
- 相对路径**只在语音库目录内**解析。文件名对不上时会给出语音库里的近似匹配提示，照提示改名即可。
- 操作者通道可以给绝对路径，但要 `allowAbsolutePath` 允许；AI 通道永远不行。

### 8.5 她一直说「我没有语音工具」

不是 MCP 缺工具，而是**她的会话里工具清单还是旧的**：

1. 确认 `socialV2.voice.enabled` 与 `socialV2.tools.sendVoice` 都是 `true`
2. 确认人设第 16 条已经生成部署（`build-agent-preset-patches.mjs --check`）
3. **重启 DSH**，再让她重新开口 —— 工具清单和系统提示词只在 DSH 启动时加载

### 8.6 语音发出去了但听不清

手机外放对 8~16kHz 的窄带音频很不友好。用 `--volume 2` ~ `--volume 3`，或者 `--normalize --loudness loud`。

### 8.7 收语音是空的

**收**到的语音目前只显示占位文本，不做语音转写（没接 whisper）。这是已知限制，不是配置问题。

---

## 九、安全边界（改语音相关代码前必读）

- **AI 只能发语音库内的文件**：`resolveVoicePathForV2` 只走语音库内相对路径 + `safeJoinLibrary`（拒绝 `..` 与符号链接逃逸）。改这里前先读 `docs/guides/SECURITY_BASELINE.md`。
- **不收远程/内联来源**：`base64://`、`data:`、`http(s)://` 一律拒绝，避免 SSRF 与「拉个任意 URL 当语音」。
- **操作者通道也要过白名单与审计**：`/api/voice/send` 走 `modeAllowed()` + `assertOutboundAuditOk()`，只是不套「必须在某个会话里」的前置闸门。
- **AI 通道的额外闸门**：`reserved2` 模式 + agent token 有效 + 会话在白名单内 + 非静默模式，任一不满足就 403。
- **`--direct` 是逃生门**：绕过桥接直连 SnowLuma，没有白名单/限流/审计。只在排查时用，别写进脚本。

---

## 十、相关文件

| 文件 | 作用 |
| --- | --- |
| `src/voice-core.js` | 共享内核：音频探测、音量/响度处理、路径校验、目标解析 |
| `src/snowluma-conn.js` | SnowLuma token/端点自动发现与持久化 |
| `src/bridge.js` | 两条发送通道、限流、审计、白名单 |
| `src/mcp-snowluma-safe.js` | `qq_send_voice` / `qq_list_voices` 工具注册与描述 |
| `scripts/send-voice.mjs` | 桥接 CLI |
| `scripts/test-voice.mjs` / `test-voice-system.mjs` / `test-voice-gui.mjs` / `test-voice-volume.mjs` / `test-voice-edge.mjs` | 回归 |
| `audio/` | 语音库（个人音频素材，不入库） |
