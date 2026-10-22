# 每日日记全解（后台会话 + 分级事项 + 长期记忆）

> 这篇回答四个问题：**日记是谁写的、写到哪、为什么是后台会话**、**事项 L1/L2/L3 到底怎么清**、**模型读日记走哪条路**、**写不出来时卡在哪一步**。
>
> 一句话总览：纯逻辑全在 `src/diary-core.js`（277 行，可单测、import 不碰磁盘）；宿主半在 `src/bridge.js`（建 workspace、开 DSH 会话、等模型回合、落盘）；`plugins/qq-diary/` 只是 settings 命名空间壳，**不参与写日记**。

---

## 一、一句话能力边界

**能做**：每天到点（默认 21:00）在自己**私有的后台会话**里写一篇第一人称日记 → 落盘成 `<日记目录>/YYYY-MM-DD.md` → 同时从模型输出里抽一份「事项清单」合并进 `items.jsonl`，按 L1/L2/L3 自动过期；第二天起把「锚点 + 最近几天日记开头」注入每一次 QQ 回合的系统提示。

**不能做**：

- **日记内容不出现在 QQ 里**——提示词里写死了安全不变量（`src/diary-core.js:203`）：`这不是聊天场景：不要调用任何 QQ 发送工具，不要把日记内容发到任何会话，只输出文本。`
- 不写技术判断：不看「收不到消息」「连不上」「配置」「令牌」这类系统事实（`src/diary-core.js:206`）；
- 不是定时任务调度器：只有本进程活着才会跑（`setInterval(maybeRunDiary, 60_000)`，`src/bridge.js:3609`），桥接停了当天就漏；
- 不补写历史：只写「今天」，`maybeRunDiary()` 发现当天文件已存在就跳过（`src/bridge.js:2228`），不会回头补昨天；
- 不能靠设置面板改行为（见 §3.2 的坑）。

---

## 二、目录与数据形态

```
<日记目录>/                 # 默认 D:\日记，可用 QQ_BRIDGE_DIARY_DIR 覆盖
  YYYY-MM-DD.md             # 日记正文（# <日期> 日记 + 可选「## 今天记下的事」）
  items.jsonl               # 分级事项，一行一条 JSON
  memory.md                 # 长期记忆，只有「## 锚点」段会被注入
  对话记录/私聊|群聊/YYYY-MM-DD.md   # 由 chat-log 那条链写，日记只读它（见 §7）
state/diary-session.json    # 日记专用 DSH 会话号（宿主状态，不入库）
```

| 文件 | 谁写 | 谁读 |
| --- | --- | --- |
| `YYYY-MM-DD.md` | `runDiary()` → `fs.writeFileSync`（`src/bridge.js:2187`） | `qq_read_diary`、`recentDiaryBriefs()`、控制台 `GET /api/diary/today` |
| `items.jsonl` | `writeDiaryItems()`（先 `.tmp` 再 rename，`src/diary-core.js:82-87`） | `cleanDiaryItems()`、提示词里的事项段 |
| `memory.md` | `qq_append_memory` 追加锚点（`src/mcp-snowluma-safe.js:1365`） | `buildMemoryBlock()` |
| `state/diary-session.json` | `atomicWriteJson`（`src/bridge.js:2165`） | `ensureDiarySession()` 复用会话 |

`items.jsonl` 每条字段（`src/bridge.js:2192-2198`）：

```json
{"id":"it-<36进制时间戳>-<4位随机>","level":1,"text":"...","due":null,"created":"YYYY-MM-DD","createdAt":1730000000000,"source":"timer|manual"}
```

坏行**直接跳过**、不因为一行坏了丢掉整个清单（`src/diary-core.js:75`）。

---

## 三、配置项

### 3.1 `config.json` 的 `diary` 段（**真正生效的那一份**）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | `false` 时：不自动写、手动触发也返回 `日记功能已关闭`（`src/bridge.js:2172`），**并且不再注入记忆块**（`src/bridge.js:2733`） |
| `time` | `21:00` | 每天几点跑（`HH:MM`，本机时区）。非法值回退 23:00（`src/bridge.js:2216-2220`） |
| `preset` | `qq-chat-v2` | 写日记用的 agent preset，**必须是已经验证过的安全 preset**，否则拒绝开会话（`src/bridge.js:2137`） |
| `workspaceTitle` | `她的日记` | 日记 workspace 标题，**只在新建时**改一次（`src/bridge.js:2155`） |
| `maxL2Days` | `10` | L2 保留天数，下限 1（`src/diary-core.js:93`） |
| `maxL3Days` | `3` | L3 保留天数，下限 1（`src/diary-core.js:94`） |
| `lookbackDays` | `7` | 最近几天日记开头注入几次（`src/diary-core.js:121`） |

默认值集中在 `DIARY_DEFAULTS`（`src/diary-core.js:35-43`），合并方式是 `{...默认值, ...cfg.diary}`（`src/diary-core.js:46-48`）。

> ⚠️ **`config.example.json` 里没有 `diary` 段**。模板只有 `dsh` / `role` / `snowluma` / `allow` / `security` / `slang` / `social` 等；`diary` 是**本机 `config.json`（不入库）独有的段**。不写也能跑（全有默认值），要改就自己往真实 `config.json` 里加。

### 3.2 DSH 设置命名空间 `qq-diary`（**当前不影响实际行为**）

`plugins/qq-diary/lib/index.js:59-76` 四个字段，全部 `.extra('volatile', true)`：

| 字段 | 类型 | 默认 | schema 原文 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 是否启用日记功能；关闭后不再自动写日记，手动触发也会被拒绝 |
| `workspaceTitle` | string | `她的日记` | 日记专用 workspace 的标题 |
| `timeOfDay` | string | `23:30` | 每天几点自动写日记，HH:MM（24 小时制，按本机时区） |
| `dir` | string | `''` | 日记与长期记忆的存放目录；留空表示用默认的 `D:\日记` |

**这条必须知道**：全仓只有 `qq-mode` 命名空间被真正读取（`src/bridge.js:3027` 判 `n.ns === 'qq-mode'`、`:4319` 写 `settings.update({ns:'qq-mode'})`）。**没有任何代码读 `qq-diary` 命名空间**——`runDiary()` 走的是 `diaryCfg()` → `cfg.diary`。所以在 DSH 设置页把 `timeOfDay` 改成 08:00 **不会**让日记提前写，改 `enabled: false` **不会**停掉日记。要改行为只能改 `config.json`。

顺带两个由此产生的假象：

- 插件默认 `timeOfDay: '23:30'`，`DIARY_DEFAULTS.time: '21:00'`，`config.json` 里也是 `21:00`。**以 `config.json` 为准**（实际就是 21:00 跑）；
- 插件 `dir:''` 的 description 写「留空表示用默认的 `D:\日记`」——这是对的，但实际目录来自 `QQ_BRIDGE_DIARY_DIR || D:\日记`（`src/diary-core.js:23`），跟这个字段没关系。

### 3.3 环境变量

| 变量 | 作用 |
| --- | --- |
| `QQ_BRIDGE_DIARY_DIR` | **覆盖日记根目录**（`src/diary-core.js:23`）。全仓只有这一处定义 `D:\日记`，`bridge.js` 只是 `const DIARY_DIR = diaryCore.DIARY_DIR`（`src/bridge.js:90`） |
| `QQ_DIARY_DIAG` | 插件诊断日志路径；不设=`os.tmpdir()/qq-diary-plugin.log`，空串=关闭（`plugins/qq-diary/lib/index.js:32`） |

> 坑：`QQ_BRIDGE_DIARY_DIR` 只影响**日记本体**。`src/mcp-snowluma-safe.js` 里四个日记工具现在 import `DIARY_DIR` / `MEMORY_FILE`（`:32`），所以它们跟着变；但老版本曾经各处硬编码 4 份 `D:/日记/`，`scripts/test-qq-diary.mjs:182` 专门钉住「漂移不许扩大」（见 §6 ⑤）。

---

## 四、一次写日记，到底发生什么

调用链：`maybeRunDiary()` 定时 → `runDiary('timer')`；或控制台 `POST /api/diary/run` → `runDiary('manual')`（`src/bridge.js:5950-5951`）。

### 4.1 前置判断（`src/bridge.js:2172-2174`）

| 检查 | 返回 |
| --- | --- |
| `enabled === false` | `{ok:false, error:'日记功能已关闭'}` |
| DSH 未就绪 | `{ok:false, error:'DSH 未就绪'}` |
| 已经在跑 | `{ok:false, error:'日记任务正在运行'}`（`diaryRunning` 互斥，`src/bridge.js:1348`） |

### 4.2 拿会话（`ensureDiarySession()`，`src/bridge.js:2134-2168`）

1. 解析 preset：`resolvePresetName(conf.preset || cfg.agentPreset, {strict:true})`（`:2136`），**解析不出来直接抛**「日记会话缺少已验证的安全 preset，拒绝创建或复用会话」（`:2137`）——这是硬门禁，不是降级；
2. 读 `state/diary-session.json`，preset 或 dir 变了就作废旧的（`:2139`）；
3. 有缓存 id → 直接复用（`:2140-2144`）；
4. 没有缓存但文件里有且 **dir 真实存在** → 复用（`:2145-2151`）；
5. 都没有 → `fs.mkdirSync(DIARY_DIR)`（`:2152`）→ `api.workspace.create({path: DIARY_DIR})`（`:2153`）→ 新建时改标题（`:2155-2157`）→ `api.sessions.create({workspaceId, agentPreset: preset})`（`:2160`）→ 写回 json（`:2165`）→ 日志「日记会话已创建：…」（`:2166`）。

### 4.3 让模型写完（`src/bridge.js:2178-2187`）

```
buildDiaryPrompt(today)                       → 一坨纯文本（见 §4.4）
api.sessions.prompt({mode:'queue', ...})      → 被拒绝就抛「日记 prompt 被拒绝：…」
waitLearnerTurn(sessionId, 240000)            → 等模型这一回合结束，超时 240 秒
parseDiaryOutput(text)                        → 拆「正文 + 末尾 json 块」
fs.writeFileSync(diaryFile, buildDiaryFileBody(...))
```

👉 **240 秒是硬上限**（`:2182`）。模型那回合要是卡住/排队超过 4 分钟，这次写日记就失败、等 30 分钟后重试。

### 4.4 提示词里有什么（`buildDiaryPrompt()`，`src/diary-core.js:190-247`）

拼装顺序（有内容才出现）：

1. `【长期记忆】` + `buildMemoryBlock(1200, ...)`（`:200-201`）；
2. 五条固定指令（`:202-207`），其中 `:203` 是安全不变量；
3. `【今天的聊天记录（私聊+群聊，时间顺序）】` + 每行 `[HH:MM][群|私] who: text`（`:210-214`）；当天没有任何消息时写一句话 `【今天的聊天记录】今天没有可用的聊天记录。`（`:217`）；
4. `【你现有的记忆】`——把 `socialV2.conversations` 里的 `activeTopics` / `memberImpressions` / `pendingThoughts` 各取末 5（想说没说的取末 3）条（`:220-229`）；
5. `【现有事项清单（L1 永久 / L2 十天后清理 / L3 三天后清理）】` + 每行 `- [id] L<level> <text>（截止 due）（记于 created）` + 一句「已有的事项不要重复添加。」（`:230-238`）——**注意这三个数字是写死在提示词里的文案**，把 `maxL2Days` 改成 30 天，模型看到的仍然是「十天后清理」；
6. `【最近几天的日记开头】` + `日期: 前 140 字`（`:239`，来自 `recentDiaryBriefs()`）；
7. `输出格式（两段）：` —— 正文 + 末尾一个 ```json 块，数组元素 `{"level":1,"text":"...","due":"YYYY-MM-DD 或 null"}`，最后一句「没有新事项就输出 []。」（`:240-245`）。

聊天记录从哪来（`collectDiaryMessages()`，`src/diary-core.js:165-186`）：只取**今天本地 0 点以后**、每会话末 80 条、全部会话按时间排序后取末 160 条；`[图片]` `[表情]` `[语音]` `[转发]` `[文件]` `[视频]` 开头的占位消息**整条丢**（`:178`）；单条正文截 100 字（`:179`）。

### 4.5 模型输出怎么拆（`parseDiaryOutput()`，`src/diary-core.js:251-270`）

- **只认文本末尾**的 ```json（或 ```）代码块：`/```(?:json)?\s*([\s\S]*?)```\s*$/`（`:255`）；
- 代码块内容必须是**数组**才当事项；不是数组/解析失败 ⇒ 整段当日记正文，`items` 为空（`:269` 的 `diary.trim() || raw`）；
- 事项过滤：`text` 必须是非空字符串、截 200 字、`due` 截 32 字或 `null`、`level` 归一到 1/2/3（`:260-264`）；
- 代码块**不在末尾**（模型啰嗦了一句「以上就是今天的日记」）⇒ 认不出来，整段当正文——**宁可少记事项，不丢正文**。

落盘格式（`buildDiaryFileBody()`，`src/diary-core.js:273-277`）：

```markdown
# 2026-10-22 日记

<正文>

## 今天记下的事
- [L1] 某件事（截止 2026-10-25）
```

### 4.6 事项怎么过期（`cleanDiaryItems()`，`src/diary-core.js:91-106`）

| 级别 | 含义（提示词原文） | 保留 |
| --- | --- | --- |
| `1` | 很重要，永久保留 | 永不删（`:101` 只处理 2/3） |
| `2` | 不太重要但紧急、要尽快完成 | 超过 `maxL2Days`（默认 10 天）删（`:102`） |
| `3` | 不重要但值得记一笔 | 超过 `maxL3Days`（默认 3 天）删（`:101`） |

- **级别归一**：只认 `1` / `2`，其它（缺失、`"2"` 之外的字符串、`0`）**全归 L3**（`:98`）。取「拿不准就 3 天后消失」的保守方向，不是 1。
- 年龄算法：`createdAt` 优先，其次 `created` 的 `Date.parse`，都没有就当「现在」（`:99`）——所以一条 `created` 写坏的事项会**一直留着**（ageDays=0）。
- 删除时带上 `removedBecause: "L3 超过 3 天"` / `"L2 超过 10 天"`（`:101-102`），只进返回值和日志，不落盘。
- 天数下限 1（`:93-94`）：设成 0 或负数会被抬回 1，不会「立刻全清」。

### 4.7 自动触发条件（`maybeRunDiary()`，`src/bridge.js:2224-2234`）

每分钟跑一次（`:3609`），启动 20 秒后也试一次（`:3612`）。四个 return 条件全过才真跑：

1. `enabled === false` → 跳过（`:2225`）；
2. 今天已经跑过（`diaryLastRunDate === today`）→ 跳过（`:2227`）；
3. **当天日记文件已存在** → 标记今天跑过并跳过（`:2228`）——手动删掉文件会让它下次到点重写；
4. 还没到 `diaryDueToday()` 那个点 → 跳过（`:2229`）；
5. 距上次失败不到 30 分钟 → 跳过（`:2231`），避免每分钟反复打模型。

---

## 五、模型侧怎么读日记

四个工具全在 `src/mcp-snowluma-safe.js` 的「日记与长期记忆（本地文件，无网关依赖）」区段（`:1347` 起），直接读文件、不过网关、**不做出站审计**（本地读，没东西出网）。

| 工具 | 参数 | 行为 / 返回 |
| --- | --- | --- |
| `qq_read_memory` | 无 | 原样吐 `memory.md` 全文；失败 `读取失败：<原因>`（`:1359`） |
| `qq_append_memory` | `text`（1–200 字） | 追加一行 `- <text>` 到「## 锚点」块**末尾**；已存在则返回 `已经记过了：<内容>`；成功 `已记住：<内容>`；失败 `写入失败：<原因>`（`:1364-1402`） |
| `qq_read_diary` | `date`（`YYYY-MM-DD`，缺省=今天） | 原样吐当天日记；失败 `读取失败：<原因>`（`:1404-1417`） |
| `qq_read_chat_log` | `channel`（`private`/`group`，缺省两个都读）、`date`（`YYYY-MM-DD` / `today` / `yesterday`） | 每文件前加 `===== 私聊 <日期> =====` 段头；超过 12000 字截断加 `…（太长了，已截断；完整内容在 <日期> 的归档文件里）`；两个频道都没有则 `没有找到 <日期> 的聊天记录：…。当天还没聊过或还没生成时是正常的；…` 并标 `isError`（`:1419-1460`） |

坑：

- `qq_read_diary` 的「今天」用的是 `new Date().toISOString().slice(0,10)`（`:1410`）——**UTC 日期**，不是本地日期。北京时间 0:00–8:00 之间查「今天的日记」会落到**昨天**。这是个真实的时区 bug，目前没修。
- `qq_append_memory` 有去重（`:1375-1379`），但只按「去掉 `- ` 前缀 + 压空白」比对；改一个字就能再写一条，锚点会越来越长。
- 锚点全部注入提示词，`buildMemoryBlock()` 超过 `maxChars` 会截断并加尾巴 `（更早记忆已折叠）`（`src/diary-core.js:159`）——**锚点写太多后半段会被折掉**。

注入点：每次 QQ 回合在 `withSlangContext()` 里拼 `【长期记忆】\n<block>`（`src/bridge.js:2733-2736`），`cfg.diary.enabled === false` 时**不注入**。

---

## 六、为什么是这个形态

**为什么拆 `diary-core.js`**：`bridge.js` 已经 12000+ 行，里面全是 `await api.xxx` 这种没法脱离 DSH 跑的东西；而「日记怎么拼、事项怎么过期、模型输出怎么容错」是**纯函数**，拆出来才能用 `node scripts/test-qq-diary.mjs` 直接跑（459 行、29 个 check、不联网、不启 DSH、不碰真实 `D:\日记`）。文件头三条硬约束（`src/diary-core.js:1-15`）：

1. **import 时不许碰磁盘**（`scripts/test-qq-diary.mjs:145` 专门断言）；
2. **不许反向 import `bridge.js`**，依赖一律参数注入（`opts.dir` / `opts.itemsFile` / `opts.memoryFile` / `opts.conversations`）；
3. **行为等价优先**：L1/L2/L3 与 `parseDiaryOutput` 的容错是用户 2026-10-19 定的规则，不许「顺手优化」。

**为什么 `bridge.js` 留那半**：建 workspace、开 DSH 会话、`waitLearnerTurn`、`state/diary-session.json` 全是宿主状态，只能在这。`bridge.js` 里那 12 个 `diaryCfg()` / `readDiaryItems()` / `buildDiaryPrompt()` 之类全是**薄封装**——签名和拆之前一样，内部只负责把 `DIARY_DIR` / `cfg.diary` / `socialV2.conversations` 塞进去（`src/bridge.js:2064-2068` 的注释就是这么说的）。

**为什么日记要单独一个会话**：日记里会出现「今天的私聊内容」，那是**跨会话的私密信息**。塞进任何一个 QQ 会话都会污染上下文（而且模型会把日记语气带到聊天里）。单独 workspace + 单独会话 = 日记只是它自己的记忆整理台。

**为什么插件壳里没有实现**：`apply(ctx)` 是空操作（`plugins/qq-diary/lib/index.js:82-84`），插件只干两件事——给设置页一个 `qq-diary` 命名空间；把 `src/diary-core.js` 的常量/函数原样再导出，让「插件真身」有东西可测（`scripts/test-qq-diary.mjs:130` 断言再导出的符号与 core 同源）。**它不写日记、不读 config.json、不 import bridge.js。**

**`cordis.patch.yml` 的死契约**（改之前先看 `plugins/qq-diary/cordis.patch.yml` 的注释）：`id` 必须逐字等于 `DIARY_NAMESPACE`（`'qq-diary'`），`name` 必须是包名；顶层必须是 YAML 数组。写错 id ⇒ 设置页里找不到这个命名空间。另两条：插件必须导出 `Config`；`Config` 至少一个字段带 `.extra('volatile', true)`（**不能**用 `.volatile()`，仓库钉的 schemastery 3.18.1 没这个方法）。

---

## 七、安全与风险

- **不外发**：日记链路唯一的出站是「prompt 进本地 DSH」，没有任何 QQ 发送调用。提示词里的安全不变量（`src/diary-core.js:203`）就是拦模型自己乱用工具的；再往外还有工具白名单兜底（`qq_send_*` 之外的东西进不来）。
- **日记是明文**：`D:\日记\*.md`、`items.jsonl`、`memory.md` 都是**明文、无加密**。里面会有真实人名、群号、私聊内容。别把这个目录同步到网盘/公开仓库；`.gitignore` 只保证它不进 git，不保证它不被别的程序读。
- **`state/diary-session.json`** 存的是 DSH 会话 id（`{sessionId, preset, dir}`）。它被删了不会丢日记，只是下次重建会话。
- **换目录 = 换记忆**：改 `QQ_BRIDGE_DIARY_DIR` 之后，`ensureDiarySession()` 会因为 `saved.dir` 不匹配作废旧会话（`src/bridge.js:2139`）；但**旧目录里的日记不会迁过来**，`buildMemoryBlock()` 会从新目录读——表现是「它失忆了」。迁目录要手动搬 `YYYY-MM-DD.md` / `items.jsonl` / `memory.md`。
- **误操作后果**：手删 `items.jsonl` = 事项清单归零（模型那边就没有待办上下文了）；手删某天 `.md` = 那天的日记没了，且 `maybeRunDiary()` 当天会**重写一份**（因为文件不存在）；往 `memory.md` 的锚点里写错东西，会**永久**注入每次对话。
- **不写技术词是刻意的**：`src/diary-core.js:204` / `:206` 两条限制让日记读起来像人写的，但也意味着「今天桥接崩了三次」这种事**永远不会**出现在日记里——排查问题别去日记里找。

---

## 八、排错

### ① 到点了但没写日记

按 `maybeRunDiary()` 的顺序倒查（`src/bridge.js:2224-2234`）：

1. `config.json` 的 `diary.enabled` 是不是 `false`；
2. `D:\日记\<今天>.md` 是不是**已经存在**（`:2228` 会直接跳过，哪怕文件是空的）——最常见的就是手动建了个空文件；
3. 本机时间过了 `diary.time` 没（默认 21:00）；
4. 距离上次失败是否不到 30 分钟（`:2231`）；
5. 桥接进程这期间有没有重启过（`diaryLastRunDate` 在内存里，重启后要靠文件存在性判断）。

日志关键词：`[diary] 已写 <日期> 日记（正文 N 字，新增事项 N 条，清理过期 N 条，现有 N 条）`（`:2204`）说明成功；`[diary] 写日记失败（timer）：…`（`:2207`）说明失败，后面跟的就是原因。

### ② 控制台点「立即写日记」返回 `日记功能已关闭` / `DSH 未就绪` / `日记任务正在运行`

三个都是**前置判断**，不是崩溃：

- `日记功能已关闭` → `config.json` 里 `diary.enabled: false`；
- `DSH 未就绪` → 桥接还没跟 DSH 握上手（看启动日志有没有连上），跟日记无关；
- `日记任务正在运行` → 上一轮还没结束（正常一次要几十秒到几分钟），等它跑完再点。**连续点两次一定会看到这个**。

### ③ 返回 `日记 prompt 被拒绝：{...}`

会话还在，但 DSH 拒了这次 prompt。两个常见源：会话被别的操作改过（preset 变了）；或者模型侧限流/额度问题。处理：删 `state/diary-session.json` 让它重建会话（`invalidateDiarySession()` 就是干这个的，`src/bridge.js:2127`），再手动触发一次。

### ④ `日记会话缺少已验证的安全 preset，拒绝创建或复用会话`

`resolvePresetName(conf.preset || cfg.agentPreset, {strict:true})` 没解析出 preset（`src/bridge.js:2136-2137`）。判据：

- `config.json` 的 `diary.preset`（默认 `qq-chat-v2`）与 `agentPreset` 是不是写错/写了不存在的名字；
- `qq-chat-v2` 有没有真的装上：跑 `node scripts/setup-dsh.mjs`，然后**重启 DSH**。

这是**故意不降级**的：日记内容会进提示词，用一个没验证过的 preset 写日记等于绕过安全边界。

### ⑤ 日记写了，但模型说「我读不到日记」/ 读到的不是同一份

这是**路径分叉**。判据链条：

1. 桥接写到哪：`DIARY_DIR`（`src/diary-core.js:23`，可被 `QQ_BRIDGE_DIARY_DIR` 改）；
2. 模型从哪读：`qq_read_diary` 用的是 `DIARY_DIR`（`src/mcp-snowluma-safe.js:1411`）——**现在同源了**；
3. 但注意 `qq_read_diary` 的「今天」是 **UTC 日期**（`:1410`）→ 早上 8 点前查「今天」会读到昨天的文件。判据：显式传 `date` 试试，能读到就说明是时区问题，不是路径问题。

历史上这四个工具各自硬编码了 4 处 `D:/日记/`，`scripts/test-qq-diary.mjs:182-201` 现在钉的是「字面量站点 ≤4 处且每处归一化后必须等于 core 的默认目录」——**谁再手动加第 5 处，测试就红**。看到这个断言失败，说明有人在 `mcp-snowluma-safe.js` 里又抄了一份路径。

### ⑥ `items.jsonl` 全没了 / 事项越积越多

- 全没了：文件被删或写坏（写坏不会全丢，坏行跳过，`src/diary-core.js:75`）。`writeDiaryItems()` 是先 `.tmp` 再 rename（`:82-87`），理论上不会写半截；
- 越积越多：把 `maxL2Days` / `maxL3Days` 调大了；或者事项的 `created` 字段被写坏 ⇒ `Date.parse` 失败 ⇒ 全当「现在」（`src/diary-core.js:99`）⇒ 永远不过期。判据：打开 `items.jsonl` 看 `created` / `createdAt` 是不是正常。

### ⑦ 跑 `node scripts/test-qq-diary.mjs` 报 `assert` 失败

测试全程只用临时目录（`scripts/test-qq-diary.mjs:33` 注释：显式把默认目录常量指到临时目录，确保任何「忘了传参」的调用也打不到真实数据）。所以**它不会删你的日记**。失败通常是真回归：改了 `cleanDiaryItems` 的保留规则、`parseDiaryOutput` 的容错、或动了 `Config` 的 volatile 字段。看断言消息里的中文名（如「cleanDiaryItems：级别归一…」）就知道撞了哪条。

---

## 九、相关文件索引

| 文件:行 | 内容 |
| --- | --- |
| `src/diary-core.js:1-15` | 头注释：三条硬约束（import 无副作用 / 不反向依赖 / 行为等价优先） |
| `src/diary-core.js:23-25` | `DIARY_DIR`（`QQ_BRIDGE_DIARY_DIR` 覆盖）/ `MEMORY_FILE` / `DIARY_ITEMS_FILE` |
| `src/diary-core.js:28-43` | `DIARY_RETENTION`（L1 永久 / L2 10 天 / L3 3 天）+ `DIARY_DEFAULTS`（`time:'21:00'`、`preset:'qq-chat-v2'`、`lookbackDays:7`） |
| `src/diary-core.js:46-48` | `diaryCfg(overrides)`：默认值 ← overrides |
| `src/diary-core.js:51-64` | `diaryDateStr()` 本地日期补零 / `diaryPaths()` / `diarySessionFile()` |
| `src/diary-core.js:68-87` | `readDiaryItems()` 坏行跳过 / `writeDiaryItems()` 先 `.tmp` 再 rename |
| `src/diary-core.js:91-106` | `cleanDiaryItems()`：L1/L2/L3 过期、级别归一、`removedBecause` |
| `src/diary-core.js:110-146` | `recentDiaryBriefs()`（跳过今天、前 140 字）/ `readLongMemory()` / `recentDiaryExcerpts()`（每天前 200 字） |
| `src/diary-core.js:149-161` | `buildMemoryBlock()`：锚点段 + 最近记录，超长加「（更早记忆已折叠）」 |
| `src/diary-core.js:165-186` | `collectDiaryMessages()`：只取今天、过滤占位消息、单条截 100 字 |
| `src/diary-core.js:190-247` | `buildDiaryPrompt()`：注入项全在这里（`:203` 安全不变量、`:206` 不写技术词、`:230-238` 事项清单段、`:240-245` 输出格式） |
| `src/diary-core.js:251-270` | `parseDiaryOutput()`：只认末尾代码块、失败整段当正文 |
| `src/diary-core.js:273-277` | `buildDiaryFileBody()`：`# <日期> 日记` + `## 今天记下的事` |
| `src/bridge.js:90-93` | `DIARY_DIR` / `MEMORY_FILE` / `DIARY_ITEMS_FILE` / `DIARY_SESSION_FILE` 都从 core 取 |
| `src/bridge.js:1348` | `let diaryRunning = false`（互斥锁） |
| `src/bridge.js:2056-2068` | 日记区段头 + 「薄封装」说明 |
| `src/bridge.js:2069-2123` | 12 个薄封装（`diaryCfg` / `diaryPaths` / `buildDiaryPrompt` …） |
| `src/bridge.js:2127` | `invalidateDiarySession()` |
| `src/bridge.js:2134-2168` | `ensureDiarySession()`：preset 硬门禁（`:2137`）+ 建 workspace（`:2153`）/ 会话 + 写 `state/diary-session.json`（`:2165`） |
| `src/bridge.js:2170-2212` | `runDiary(reason)`：前置判断 → prompt → 等回合 → 落盘 → 合并事项 |
| `src/bridge.js:2182` | `waitLearnerTurn(sessionId, 240000)`：**240 秒超时** |
| `src/bridge.js:2187` | 写 `<日期>.md` |
| `src/bridge.js:2192` | 事项 id 生成 `it-<base36>-<4位随机>` |
| `src/bridge.js:2204` | 成功日志 `[diary] 已写 …` |
| `src/bridge.js:2214-2222` | `diaryDueToday()`：非法时间回退 23:00 |
| `src/bridge.js:2224-2234` | `maybeRunDiary()`：五个跳过条件 + 30 分钟退避 |
| `src/bridge.js:2733-2736` | `withSlangContext()` 里的【长期记忆】注入（日记关闭时不注入） |
| `src/bridge.js:3609` / `:3612` | `setInterval(maybeRunDiary, 60_000)` / 启动 20 秒后试跑一次 |
| `src/bridge.js:5950-5969` | `POST /api/diary/run`（`:5951 runDiary('manual')`）/ `GET /api/diary/today` / `GET·POST /api/memory` |
| `src/mcp-snowluma-safe.js:28-32` | 「唯一目录来源」注释 + `import { DIARY_DIR, MEMORY_FILE }`（必须单行） |
| `src/mcp-snowluma-safe.js:1350-1402` | `qq_read_memory` / `qq_append_memory`（追加到锚点块末尾 + 去重） |
| `src/mcp-snowluma-safe.js:1404-1460` | `qq_read_diary`（**「今天」是 UTC 日期**，`:1410`）/ `qq_read_chat_log`（today/yesterday、12000 字截断） |
| `plugins/qq-diary/lib/index.js:29` | `import * as diaryCore from '../../../src/diary-core.js'` |
| `plugins/qq-diary/lib/index.js:42-57` | `name` / `DIARY_NAMESPACE` / 再导出的常量与函数 |
| `plugins/qq-diary/lib/index.js:59-76` | `Config` 四字段（全 `volatile`，`timeOfDay` 默认 `23:30`） |
| `plugins/qq-diary/lib/index.js:82-84` | `apply(ctx)` 空操作 |
| `plugins/qq-diary/cordis.patch.yml` | entry `id` = `qq-diary` 的死契约 |
| `scripts/test-qq-diary.mjs:91` / `:109` | 断言 patch 的 id === 命名空间；`Config` 默认值 + 至少一个 volatile |
| `scripts/test-qq-diary.mjs:145` / `:163` | 断言 core 的 fs 调用只在函数体内；`DIARY_DIR` 只有一份定义 |
| `scripts/test-qq-diary.mjs:182-201` | 钉住 `mcp-snowluma-safe.js` 的日记路径漂移（≤4 处且必须同源） |
| `scripts/test-qq-diary.mjs:233` / `:253` | `cleanDiaryItems` 保留规则；级别归一（缺失/0 → L3）与 created 回退 |
| `scripts/test-qq-diary.mjs:299-338` / `:356` | `parseDiaryOutput` 五种容错；`buildDiaryPrompt` 含安全不变量 |
| `scripts/test-audit.mjs:82` | 把 `test-qq-diary.mjs` 收进总回归 |
| `src/chat-log.js:1-29` | 对话记录精简的纯逻辑（`D:\日记\对话记录`、`generateTime:'05:10'`） |
| `src/bridge.js:2236-2241` | 对话记录区段头（日记之外的另一条链） |

跑测试：`node scripts/test-qq-diary.mjs`（或 `npm run test:diary`）。
