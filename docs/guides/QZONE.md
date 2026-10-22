# QQ 空间说说全解（`qq_qzone_*` 三个工具 + 唯一一道出站门禁）

> 这篇回答四个问题：**agent 能不能发说说、怎么发**、**为什么它绕过桥接直连 OneBot**、**可见性到底怎么映射**、**门禁和删帖会出什么错**。
>
> 一句话总览：纯逻辑在 `src/qzone-core.js`（184 行，可单测）；三个工具 `qq_qzone_post` / `qq_qzone_list` / `qq_qzone_delete` 在 `src/mcp-snowluma-safe.js:1262-1345`（薄壳）；`plugins/qq-qzone/` 只有 settings 命名空间壳 + 原样再导出 core，**不发送任何东西**。

---

## 一、一句话能力边界

**能做**：在自己号的空间发一条说说（正文 ≤1500 字 + 配图 ≤9 张 + 三档可见性）、列自己最近发过的说说（拿 tid / 时间 / 可见性 / 图数 / 正文前 60 字）、按 tid 删自己的一条说说。

**不能做**：

- **不能看别人的说说**（没有「浏览好友动态」这条路，`get_qzone_msg_list` 只列自己）；
- **不能评论 / 点赞 / 转发**——本项目一个相关工具都没有；
- **不能发到「部分好友可见 (16)」/「部分好友不可见 (128)」**：这两个 ugc_right 值能**读**出来（列表里会显示），但发帖三档只有 `friends` / `all` / `private`；
- **不能改已发的说说**——只能删了重发；
- 图片只接受**本机绝对路径 / http URL / base64** 字符串，服务端由 OneBot 去取，这个过程不经过桥接，所以**不校验也不审计**；
- 不是第二条出站通道：它只是「qzone 这一件事」的专用路径，普通 QQ 消息仍然走桥接。

---

## 二、三个工具：参数 / 返回文案 / 坑

返回文案全部逐字来自 `src/mcp-snowluma-safe.js`，属于**前端契约**（模型照它说话），不要顺手改。

### 2.1 `qq_qzone_post`

工具描述（`:1275`）逐字：

> 发一条 QQ 空间说说（发在你自己号的空间里，好友能刷到）。content 是正文；images 可选，最多 9 张，可以传本机绝对路径（如 `C:\Users\me\Pictures\a.jpg`）、http 图片地址或 base64；visibility 默认 friends（好友可见），也支持 all（所有人）/private（仅自己）。

| 参数 | 类型 | 必填 | 约束 | schema 原文 |
| --- | --- | --- | --- | --- |
| `content` | string | ✅ | 1–1500 字 | 说说正文（`:1281`） |
| `images` | string[] | — | ≤9 张 | 配图：本机绝对路径 / http URL / base64，最多 9 张（`:1282`） |
| `visibility` | `friends`/`all`/`private` | — | 缺省 `friends` | 可见范围，默认 friends（好友可见）（`:1283`） |

执行顺序（**顺序本身是安全设计**，`:1285-1305`）：

1. `qzoneGuard(content)` —— 出站门禁，**必须在最前面**（`:1288`，注释原文「直连 OneBot 绕过了桥接的 SENSITIVE_RE 审计」）；
2. `buildQzonePostPayload({content, images, visibility})` —— 校验 + 归一（`:1291`）；
3. `onebot('send_qzone_msg', payload)` —— 直连 OneBot HTTP（`:1292`）。

成功文案（`:1297`）：

```
说说已发出：tid=<tid>（<可见性中文>，配图 <N> 张）
```

失败文案（`:1302`）：`发说说失败：<原因>`，并置 `isError`。

- **坑（最需要知道）**：`tid` 取的是 `data?.tid ?? '?'`——OneBot 某些版本不回 tid，这时你会拿到 `tid=?`，**后面就删不掉这条**（`qq_qzone_delete` 需要真 tid）。拿不到 tid 时去 `qq_qzone_list` 里找最新的那条。
- 坑：`content` 长度按**原始入参**算（`z.string().max(1500)`），之后才做 JSON 字符串还原（把 `"\"你好\""` 还原成 `你好`）。所以一个 1499 字的正文包一层引号会先被 schema 拒。
- 坑：正文里带本机路径（`C:\...`、`/home/...`）或凭据特征会被 `qzoneGuard` 拒，**报错文案见 §2.4**。这是有意的——说说发出去就删不干净了（别人可能已转发）。

### 2.2 `qq_qzone_list`

工具描述（`:1309`）逐字：

> 看自己空间最近发过的说说（tid、时间、可见性、图片数、正文摘要）。发之前先看一眼避免重复发，发完也用它确认真的发出去了。

| 参数 | 类型 | 默认 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `limit` | number(int) | 10 | 1–20 | 最多看几条（`:1310`） |

**坑（协议事实，别去"优化"）**：`limit` 会被 `Math.max(10, Math.min(20, limit))` 再夹一次（`:1315`）——传 `limit: 1` 实际拿 10 条。原因写在 `:1313`：OneBot 侧 `num` 太小（如 5）会返回 `msglist: null` + `retcode: 100`。

返回格式：

- 空列表：`空间里还没有说说。`（`:1318`）；
- 有内容：首行 `空间里共 <total> 条：`，然后每条一行（`:1324`）：

```
- tid=<tid>　<时间>　<可见性中文>　图<N>张　<正文前 60 字>
```

（分隔符是**全角空格** `　`，`<时间>` 是 `toLocaleString('zh-CN', {hour12:false})`，`:1320`）

- 失败：`查看说说列表失败：<原因>`（`:1328`）。

可见性中文来自 `QZONE_RIGHT_LABEL`（`src/qzone-core.js:40-46`），认不出来显示 `?`；`ugc_right` 缺失时按 `is_private` 兜底成 64/4（`src/mcp-snowluma-safe.js:1321`）。

### 2.3 `qq_qzone_delete`

工具描述（`src/mcp-snowluma-safe.js:1335`）：`删掉自己空间的一条说说。tid 从 qq_qzone_list 拿。`

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `tid` | string | ✅ | 要删的说说 tid（`src/mcp-snowluma-safe.js:1336`，`z.string().min(1)`） |

成功：`已删除 tid=<tid>`（`src/mcp-snowluma-safe.js:1340`）；失败：`删除说说失败：<原因>`（`src/mcp-snowluma-safe.js:1342`）。

- 坑：实际请求是 `delete_qzone_msg` + `{tid: String(tid)}`（`src/mcp-snowluma-safe.js:1339`）——**tid 传数字也转成字符串**，别指望服务端宽容。
- 坑：`tid=?` 传进来能过 schema（非空字符串），但 OneBot 一定报错。
- **没有二次确认**。调之前先 `qq_qzone_list` 确认 tid，删了不可恢复。

### 2.4 `qzoneGuard` 命中文案（对模型可见，绝对不要改）

```
这条内容里带了本机路径或凭据特征，会被安全策略拦下；把路径、账号之类的东西去掉再发。
```

（`src/qzone-core.js:66-70`）

判定用的是 `src/sensitive.js` 的 `SENSITIVE_RE`——**全仓唯一一份正则**（`src/sensitive.js:15`），覆盖：Windows 盘符路径（`X:\...`）、UNC 路径、`/home/`·`/Users/`·`/etc/`·`/var/`·`/root/`、以及 `token|密码|密钥|口令|password|secret|api_key|authorization|bearer|access_key|credential` 后跟赋值或值的形态。

`src/qzone-core.js` 只是 import 它（`:17`），**没有抄第二份**——`scripts/test-qq-qzone.mjs:274` 专门钉这条。

---

## 三、可见性映射表

| 你写的 | OneBot `ugc_right` | 中文标签 | 能发吗 |
| --- | --- | --- | --- |
| `friends`（缺省） | `4` | 好友可见 | ✅ |
| `all` | `1` | 所有人可见 | ✅ |
| `private` | `64` | 仅自己可见 | ✅ |
| 数字 `16` / 字符串 `'16'` | `16` | 部分好友可见 | ❌ 工具 schema 只收三字符串；但 `resolveVisibility` 接受（供列表翻译/未来用） |
| 数字 `128` / 字符串 `'128'` | `128` | 部分好友不可见 | ❌ 同上 |
| `undefined` / `null` / `''` | `4` | 好友可见 | ✅ |
| 其它任何值 | — | — | **抛错** |

`resolveVisibility()` 的规则（`src/qzone-core.js:85-103`）：

- 大小写不敏感（`trim().toLowerCase()`，`:94`）；
- 数字字符串（`'4'`）也认（`:96-99`）；
- **非法值抛错**，不是静默回退。历史实现是 `QZONE_UGC_RIGHT[v] ?? 4`——非法值会被悄悄发成「好友可见」，在**发布类**动作上这是 fail-open（`:79-80` 的注释）；现在改成 fail-closed，`scripts/test-qq-qzone.mjs:170` 钉住。

错误文案（`src/qzone-core.js:105-110`）：

```
不认识的可见范围：<JSON.stringify(入参)>；只支持 friends（好友可见）/ all（所有人）/ private（仅自己），或 ugc_right 数字 1 / 4 / 16 / 64 / 128（缺省 friends）
```

> 注意：MCP 工具的 `visibility` 是 `z.enum(['friends','all','private'])`，传 `'16'` 会**先被 schema 拒**（报的是 zod 的参数错，不是上面这段文案）。上面这段只在直接调 `resolveVisibility()` / `buildQzonePostPayload()` 时出现。

---

## 四、配置项

### 4.1 `config.json`

qzone 相关**没有任何专属段**。只有它复用的 SnowLuma 连接配置（`getOneBotConfig()`，`src/mcp-snowluma-safe.js:64-70`）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `snowluma.httpUrl` | `http://127.0.0.1:3000` | OneBot **HTTP** API 地址（尾部 `/` 会被去掉） |
| `snowluma.accessToken` | `''` | 非空则加 `authorization: Bearer <token>` 头 |

`onebot()`（`:98-115`）超时 15 秒（`:104`），`status !== 'ok'` 或 `retcode !== 0` 直接抛 `OneBot <action> 失败: retcode=<n> <wording>`（`:112`）。`HTTP 426` 会附一条专属提示「httpUrl 指向了 WebSocket 端口」（`:107`）。

> `config.example.json` 里有 `snowluma` 段，但**没有 qzone 相关键**（本来也没有）。

### 4.2 DSH 设置命名空间 `qq-qzone`（**当前不影响实际发帖**）

`plugins/qq-qzone/lib/index.js:100-120`，三个字段全部 `.extra('volatile', true)`：

| 字段 | 类型 | 默认 | schema 原文 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 是否启用 QQ 空间（说说）相关能力；关掉表示不再允许 agent 发说说 |
| `defaultVisibility` | `'friends'` \| `'all'` \| `'private'` | `'friends'` | 发说说时未显式指定可见性时的缺省值 |
| `maxImages` | 整数 0–9 | `9` | 一条说说最多允许几张配图（工具 schema 的硬上限是 9） |

**坑（必须知道）**：`src/mcp-snowluma-safe.js` **不读** DSH 设置——它只读 `config.json`。全仓只有 `qq-mode` 命名空间被真正读取（`src/bridge.js:3027`、`:4319`）。所以：

- 在设置页把 `enabled` 关成 `false`，**不会**阻止 agent 发说说；
- 把 `defaultVisibility` 改成 `all`，**不会**让缺省可见性变成所有人——实际缺省常量写死在 `src/qzone-core.js:27`（`QZONE_DEFAULT_VISIBILITY = 'friends'`）；
- 把 `maxImages` 改成 3，**不会**限制配图数量——schema 硬上限是字面量 `9`（`src/mcp-snowluma-safe.js:1282`）。

这个命名空间目前是「可见的配置容器」，不是生效的开关。要真限制，只能改代码或改 `qq-tool-restrict` / preset。

### 4.3 环境变量

| 变量 | 作用 |
| --- | --- |
| `QQ_QZONE_DIAG` | 插件诊断日志路径；不设=`os.tmpdir()/qq-qzone-plugin.log`，空串=关闭（`plugins/qq-qzone/lib/index.js:79`） |

MCP 侧无环境变量。

---

## 五、为什么是这个形态（为什么它绕过桥接）

**qzone 没有「入站」概念**：不是消息、不进白名单会话、不参与 `reserved2` 上下文，就是 agent 主动做的一次性动作。把它塞进桥接的 `/api/...` 端点只会多一层转发，没有任何收益——所以三个工具**直连 OneBot**（`send_qzone_msg` / `get_qzone_msg_list` / `delete_qzone_msg`），配置复用同一份 `snowluma` 连接（`src/mcp-snowluma-safe.js:1263`）。

**直连的代价：出站审计被绕过**。桥接的普通消息发送端点在 `src/bridge.js` 里统一跑 `SENSITIVE_RE` 审计；qzone 这条路不经过它。所以必须**自己补一道** `qzoneGuard()`（`src/mcp-snowluma-safe.js:1264-1265` 的注释就是记这件事）。**任何新增出站路径都必须自己调一次 `qzoneGuard`**——`buildQzonePostPayload()` 本身**不跑门禁**（`src/qzone-core.js:60-61`、`:148`）。

**为什么拆 `qzone-core.js`**：`src/mcp-snowluma-safe.js` 顶层就 `new McpServer()` + `connect(stdio)`，**import 它等于起一个服务器进程**，纯逻辑根本没法单测（`src/mcp-snowluma-safe.js:21-23`）。把常量 / 校验 / 门禁抽出来后：`node scripts/test-qq-qzone.mjs` 能直接跑（352 行、20 个 check、不联网、不启 DSH）；`plugins/qq-qzone` 也能复用同一份常量，不抄第二份。文件头也写死了：**唯一实现留在 core，不要在 MCP 文件里再写一遍映射表或正则**（`src/mcp-snowluma-safe.js:1271`）。

**为什么插件只有 host 半、`apply(ctx)` 是空的**：插件只做两件事——提供一个 `qq-qzone` settings 命名空间；把 core 的符号原样再导出当「插件真身」（`plugins/qq-qzone/lib/index.js:56-66`）。它**不 import `mcp-snowluma-safe.js`**（那会起第二个 server），也不实现发送。没有 client 半是因为没有 UI 卡片。

**两条不能违反的写法约束**：

1. **`import` 必须单行**（`src/mcp-snowluma-safe.js:24-27`）：`scripts/test-audit-security-mcp.mjs` 用 `/^import .*;\r?\n/gm` 逐行剥掉 import 再塞进 vm，多行 import 会漏网 ⇒ vm 里 ESM import 直接 `SyntaxError`。`scripts/test-qq-qzone.mjs:285` 钉住了这条。
2. **schema 里的 1500 / 9 必须写字面量**（`src/mcp-snowluma-safe.js:1277-1280`）：schema 在**模块求值期**构造，剥掉 import 之后 `QZONE_MAX_CONTENT` 这些名字不存在 ⇒ `ReferenceError`。`scripts/test-qq-qzone.mjs:298` 钉住了这条；两边数值靠 `scripts/test-qq-qzone.mjs:334` 那条「limits 常量与工具 schema 的上限一致」对齐。

**`cordis.patch.yml` 的死契约**（`plugins/qq-qzone/cordis.patch.yml`）：顶层 YAML 数组，`id` 必须逐字等于 `QZONE_NAMESPACE`（`'qq-qzone'`，`plugins/qq-qzone/lib/index.js:75`），`name` 是包名。`settings.write()` 用 `configEditor.entries().find((row) => row.options.id === ns)` 定位，id 不同名 ⇒ 写设置永远抛 `No configurable plugin entry "qq-qzone"`。另两条：必须导出 `Config`；`Config` 至少一个字段带 `.extra('volatile', true)`。**不能**用 `.volatile()`（schemastery 3.18.1 没这个方法）、**不能**用 `z.enum` / `.int()`（也没有），枚举要 `z.union([z.const(...)])`、整数要 `z.natural()`（`plugins/qq-qzone/lib/index.js:106` 的注释）。

---

## 六、安全与风险

- **唯一出站门禁是 `qzoneGuard`**。它只看正文（`content`），**不看 `images`**：配图路径可以是任意本机绝对路径，OneBot 会去读那个文件并上传。也就是说「发一张图 = 让 OneBot 读本机任意图片」。不要因为 `qzoneGuard` 通过就以为配图安全。
- **凭据**：`snowluma.accessToken` 明文在 `config.json`（不入库）。qzone 这条链只用它做 `Authorization: Bearer`，日志里不打印。
- **说说发出去就删不干净**：QQ 空间是公开/半公开的，别人看到、转发、截图之后 `delete_qzone_msg` 只是从你自己空间移除。所以门禁放在**发之前**是对的。
- **误操作后果**：`qq_qzone_delete` 没有二次确认（见 §2.3）；发错可见性**不能改**只能删了重发；`private` 也不是"只有我"的保险箱——它只是 ugc_right=64。
- **用户数据**：这条链**不写任何本地文件**（图片由 OneBot 取，正文不落盘）。唯一本地痕迹是插件诊断日志 `os.tmpdir()/qq-qzone-plugin.log`。
- **失败不重试**：`onebot()` 一次 15 秒超时就抛，工具只返回 `isError`，没有自动重试。网络抖动时会看到「发说说失败：HTTP 5xx」——**此时先 `qq_qzone_list` 确认到底发出去没**，别直接重发（会发两条）。

---

## 七、排错

### ① `发说说失败：OneBot send_qzone_msg 失败: retcode=<n> ...`

**retcode 是判断一切的关键**：

- `retcode < 0`（通常是 -1 / -2）= OneBot 侧动作不存在 / 未实现 → SnowLuma 版本不支持 qzone，或者 `snowluma.httpUrl` 指到了不支持 HTTP API 的端口；
- `retcode > 0` = 业务失败（内容风控、图片下载失败、频率限制）；
- 判据：先跑不带副作用的 `qq_qzone_list`。**list 能成功而 post 失败 ⇒ 连接没问题，是内容/图片问题**；list 也失败 ⇒ 是连接/配置问题。

### ② `发说说失败：HTTP 426；HTTP 426 通常表示 httpUrl 指向了 WebSocket 端口...`

这是 `onebot()` 专门给的提示（`src/mcp-snowluma-safe.js:107`）。`config.json` 的 `snowluma.httpUrl` 必须填 **OneBot HTTP API** 地址（默认 `http://127.0.0.1:3000`），不是 `ws://` 那个端口。SnowLuma 的 HTTP token 与 WS token 是**两个不同的值**——这点在 README 里也有记录。

### ③ 门禁命中：`这条内容里带了本机路径或凭据特征，会被安全策略拦下；...`

不是 bug，是 `qzoneGuard` 拒了。判据：正文里是不是有：

- 盘符路径 `X:\...`（`D:\日记` 也算！`allowLiterals` 只对 privacy-scan 豁免，**不豁免 qzoneGuard**）；
- `/home/` `/Users/` `/etc/` `/root/` 开头的路径；
- 「token」「密码」「密钥」「password」这类词后面跟了值（连「密码是 123456」这种也会中）。

处理：把路径/账号去掉再发。**不要**改 `SENSITIVE_RE` 或去掉 `qzoneGuard` 调用——它是这条路径上唯一的门禁。

### ④ `查看说说列表失败：OneBot get_qzone_msg_list 失败: retcode=100`

`retcode=100` + `msglist: null` 是 OneBot 对「num 太小」的响应（`src/mcp-snowluma-safe.js:1313` 的注释）。代码已经把 `num` 夹到 ≥10（`:1315`），所以**正常不会出现**；真出现了说明有人改了这个 clamp，或者 OneBot 侧空间为空/无权限。

### ⑤ 工具存在但调用被拒：`工具 "qq_qzone_post" 不在 QQ 桥接白名单内，已拒绝`

不是 qzone 的问题，是**工具白名单**。`plugins/qq-agent-presets/qq-tool-restrict.mjs` 只放行 `mcp__snowluma__*` / `mcp__snowluma-host__*` / `mcp__web-search-safe__*` / `mcp__emu-phone__*` 前缀 + 精确名单（`:163-170`、放行判断 `:204`）。`qq_qzone_*` 属于 `mcp__snowluma__` 前缀，所以**工具面本身是放行的**；如果被拒，说明 `name` 拼错（比如写成 `qzone_post`）或 profile 里的 MCP 条目没装。

### ⑥ `说说已发出：tid=?`

OneBot 没回 tid（见 §2.1）。判据：`qq_qzone_list` 里最新一条的 tid 就是它。**拿不到 tid 就删不了**——先记下来。

### ⑦ 设置页改了 `defaultVisibility` / `maxImages` 但行为没变

预期行为，不是 bug：这三个命名空间没有任何消费方（见 §4.2）。要改缺省可见性只能改 `src/qzone-core.js:27` 的 `QZONE_DEFAULT_VISIBILITY`，或者每次发帖显式传 `visibility`。

---

## 八、相关文件索引

| 文件:行 | 内容 |
| --- | --- |
| `src/qzone-core.js:1-16` | 头注释：为什么抽出、无副作用、唯一 import 是 `sensitive.js` |
| `src/qzone-core.js:17` | `import { SENSITIVE_RE } from './sensitive.js'` |
| `src/qzone-core.js:23-24` | `QZONE_MAX_CONTENT = 1500` / `QZONE_MAX_IMAGES = 9` |
| `src/qzone-core.js:27` | `QZONE_DEFAULT_VISIBILITY = 'friends'` |
| `src/qzone-core.js:32-33` | `QZONE_MIN_LIST_NUM = 10` / `QZONE_MAX_LIST_NUM = 20` |
| `src/qzone-core.js:38` | `QZONE_UGC_RIGHT = {all:1, friends:4, private:64}`（freeze） |
| `src/qzone-core.js:40-46` | `QZONE_RIGHT_LABEL`：1/4/16/64/128 → 中文 |
| `src/qzone-core.js:49` | `ALLOWED_RIGHTS` 从 LABEL 派生 |
| `src/qzone-core.js:60-61` | 「`buildQzonePostPayload()` 本身**不**跑门禁」 |
| `src/qzone-core.js:66-70` | `qzoneGuard()` + 命中文案 |
| `src/qzone-core.js:79-80` | 为什么非法可见性要抛错（历史 `?? 4` 是 fail-open） |
| `src/qzone-core.js:85-103` | `resolveVisibility()` |
| `src/qzone-core.js:105-110` | `visibilityError()` 文案 |
| `src/qzone-core.js:116-119` | `describeQzoneError()` |
| `src/qzone-core.js:127-137` | `unquoteJsonString()`（与 MCP 侧逐字一致，刻意不共用） |
| `src/qzone-core.js:155-184` | `buildQzonePostPayload()`：四条校验 + 归一 |
| `src/sensitive.js:15` | `SENSITIVE_RE`——全仓唯一一份 |
| `src/mcp-snowluma-safe.js:21-27` | qzone 常量抽出说明 + **import 必须单行** |
| `src/mcp-snowluma-safe.js:64-70` | `getOneBotConfig()`：`snowluma.httpUrl` / `accessToken` |
| `src/mcp-snowluma-safe.js:98-115` | `onebot(action, params)`：15s 超时、426 提示、retcode 判定 |
| `src/mcp-snowluma-safe.js:1262-1265` | qzone 区段头：为什么直连 + 为什么要自己补门禁 |
| `src/mcp-snowluma-safe.js:1271-1272` | 「唯一实现在 core，不要在这写第二遍」+「薄壳，契约未变」 |
| `src/mcp-snowluma-safe.js:1273-1305` | `qq_qzone_post`（`:1275` 描述、`:1277-1280` 字面量约束、`:1288` 门禁、`:1297` 成功文案、`:1302` 失败文案） |
| `src/mcp-snowluma-safe.js:1307-1331` | `qq_qzone_list`（`:1313` num 太小返回 retcode 100、`:1315` clamp 10–20、`:1324` 行格式、`:1326` 汇总） |
| `src/mcp-snowluma-safe.js:1333-1345` | `qq_qzone_delete` |
| `src/bridge.js:3027` | 唯一读 DSH settings 的地方（`ns === 'qq-mode'`） |
| `src/bridge.js:4319` | 写 DSH settings（`ns: 'qq-mode'`） |
| `plugins/qq-qzone/lib/index.js:1-25` | 头注释：职责边界 / 为什么没有 host 半 / 为什么 apply 几乎空着 |
| `plugins/qq-qzone/lib/index.js:31-52` | 路径解析（lib → 上三级才是仓库根）+ import core |
| `plugins/qq-qzone/lib/index.js:56-66` | 原样再导出的符号 |
| `plugins/qq-qzone/lib/index.js:68-79` | `name` / `inject` / `QZONE_NAMESPACE` / `DIAG` |
| `plugins/qq-qzone/lib/index.js:100-120` | `Config` 三字段（`:106` 没有 `z.enum` / `.int()` 的注释） |
| `plugins/qq-qzone/lib/index.js:130-135` | `apply(ctx)` 只写诊断 |
| `plugins/qq-qzone/cordis.patch.yml` | `id` = `qq-qzone` 的死契约 + 测试用哪个正则抽它 |
| `plugins/qq-agent-presets/qq-tool-restrict.mjs:163-170` | `SAFE_PREFIXES`（含 `mcp__emu-phone__`） |
| `plugins/qq-agent-presets/qq-tool-restrict.mjs:204-205` | 放行判断 + 拒绝文案 |
| `scripts/test-qq-qzone.mjs:82` | 断言 patch 的 entry id/name |
| `scripts/test-qq-qzone.mjs:112` | 断言 `Config` 字段带 volatile（不是 `.volatile()`） |
| `scripts/test-qq-qzone.mjs:156-170` | `resolveVisibility` 三字符串 / 三数字 / 缺省与抛错 |
| `scripts/test-qq-qzone.mjs:186-224` | `buildQzonePostPayload` 正常/缺省/边界 |
| `scripts/test-qq-qzone.mjs:247-254` | `qzoneGuard` 正例放行、路径凭据被拒 |
| `scripts/test-qq-qzone.mjs:274` | 断言 core 复用 `sensitive.js` 的正则，没抄第二份 |
| `scripts/test-qq-qzone.mjs:285` | 断言 MCP 侧仍注册三个 qzone 工具且 import 单行 |
| `scripts/test-qq-qzone.mjs:298` | 断言 schema 仍用字面量 1500 / 9 |
| `scripts/test-qq-qzone.mjs:334` | 断言 limits 常量与 schema 上限一致 |
| `scripts/test-audit.mjs:90` | 把 `test-qq-qzone.mjs` 收进总回归 |

跑测试：`node scripts/test-qq-qzone.mjs`（或 `npm run test:qzone`）。
