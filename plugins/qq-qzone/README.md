# qq-qzone

QQ 空间（说说）插件。**只有 host 半，没有 client 半**，也没有桥接（bridge）端点半。

- 插件名（包名）：`qq-qzone`
- settings 命名空间：`qq-qzone`（与 `cordis.patch.yml` 里 entry 的 `id` 逐字相等）
- 版本：跟着根包走（当前 `0.2.0-r3`）

## 职责

本插件做且只做两件事：

1. **提供一个 settings 命名空间** `qq-qzone`：开关、发说说时的缺省可见性、配图张数上限。
   DSH 0.2.0 起命名空间不需要注册 —— 只要「有一条 loader entry 其 id 等于命名空间名」
   ＋「该 entry 的插件模块导出 `Config`」＋「`Config` 至少一个字段带 `volatile` 标记」。
   见 [`cordis.patch.yml`](./cordis.patch.yml) 与 [`lib/index.js`](./lib/index.js)。
2. **作为 qzone 纯逻辑的插件真身**：把 `src/qzone-core.js` 的常量与纯函数原样再导出，
   这样"插件装上了、且拿到的是与 MCP server 同一份实现"可以被导入直接验证，不必去
   `vm` 里挖 `server.tool()` 注册表。

**本插件不发送任何 QQ 消息，也不充当第二条出站路径。** 真正的动作仍然是 MCP server
`src/mcp-snowluma-safe.js` 暴露给模型的三个工具：`qq_qzone_post` / `qq_qzone_list` /
`qq_qzone_delete`。插件的存在是为了让配置项与纯逻辑有独立归属、可被单测，而不是为了
新增一条能绕过门禁的发送通道。

## 为什么没有 host（桥接端点）半

桥接 `src/bridge.js` 压根**没有 qzone 端点**（没有 `/api/qzone/*` 之类）。原因是 qzone
在桥接的语义里不属于"消息路由"：它没有入站事件、不涉及白名单会话、也不参与 `reserved2`
仿真上下文。它是 agent 主动发起的一次性工具动作。

因此 qzone 工具**直连 OneBot**，用的是与 `onebot()` 同一套连接配置
（`config.json` 的 `snowluma.httpUrl` + `accessToken`），三个底层 action：

| 动作 | OneBot action | 关键参数 |
| --- | --- | --- |
| 发说说 | `send_qzone_msg` | `content` / `images` / `ugc_right` |
| 看列表 | `get_qzone_msg_list` | `pos: 0` / `num`（10~20） |
| 删说说 | `delete_qzone_msg` | `tid` |

**直连的代价**：桥接 outbound 端点里的 `SENSITIVE_RE` 出站审计被绕过了。所以出站正文
必须自己补一道门禁 —— 那就是 `qzoneGuard()`（实现见 `src/qzone-core.js`，本次从
`src/mcp-snowluma-safe.js` 原样搬出，判定逻辑、正则来源、报错文案**逐字未改**）。
任何新增的 qzone 出站路径都必须自己再调一次 `qzoneGuard`；`buildQzonePostPayload()`
本身**不**跑门禁，它只做校验与归一。

## 三个工具

以下契约（工具名 / 参数名 / 描述文案 / 返回结构）属于前端契约，插件化过程中**一律未改**。

### `qq_qzone_post`

发一条 QQ 空间说说（发在自己号的空间里，好友能刷到）。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `content` | string，1~1500 字符 | 是 | 说说正文；先过 `qzoneGuard` |
| `images` | string[]，最多 9 张 | 否 | 本机绝对路径 / http URL / base64 |
| `visibility` | `'friends'` / `'all'` / `'private'` | 否 | 缺省 `friends` |

成功返回一行文本：
`说说已发出：tid=<tid>（<可见性中文>，配图 <N> 张）`；
失败返回 `发说说失败：<原因>` 且 `isError: true`。

### `qq_qzone_list`

看自己空间最近发过的说说（tid、时间、可见性、图片数、正文摘要）。发之前先看一眼避免
重复发，发完也用它确认真的发出去了。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `limit` | int，1~20 | 否 | 最多看几条，默认 10 |

注意：OneBot 侧 `num` 太小（如 5）会返回 `msglist: null` + `retcode 100`，所以实现把
`num` 下限压到 10（工具 schema 仍接受 1~20，实际请求是 `clamp(limit, 10, 20)`）。
返回为 `空间里共 <total> 条：` 加每行
`- tid=<tid>　<时间>　<可见性>　图<N>张　<正文前 60 字>`；空列表返回 `空间里还没有说说。`。

### `qq_qzone_delete`

删掉自己空间的一条说说。`tid` 从 `qq_qzone_list` 拿。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `tid` | string，非空 | 是 | 要删的说说 tid |

成功返回 `已删除 tid=<tid>`；失败返回 `删除说说失败：<原因>` 且 `isError: true`。

## 出站门禁 `qzoneGuard`

```js
import { qzoneGuard } from '../../src/qzone-core.js';

qzoneGuard('今天天气不错');            // 通过
qzoneGuard('D:\\日记\\x.jpg');         // throw：命中本机路径
qzoneGuard('password: hunter2xyz');    // throw：命中凭据特征
```

命中时抛出的文案（对模型可见，**不要改**）：

> 这条内容里带了本机路径或凭据特征，会被安全策略拦下；把路径、账号之类的东西去掉再发。

正则唯一来源是 `src/sensitive.js` 的 `SENSITIVE_RE`（全仓库只有一份），`qzone-core.js`
直接 import 它，**没有**抄第二份词表/正则 —— 两套口径必然漂移，而桥接侧的出站审计用的
就是这一条。

## 可见性语义

`ugc_right` 是 OneBot / QQ 空间协议值：

| 名称 | ugc_right | 含义 | 能否用于发帖 |
| --- | --- | --- | --- |
| `all` | `1` | 所有人可见 | 是 |
| `friends` | `4` | 好友可见（缺省） | 是 |
| — | `16` | 部分好友可见 | 否（列表接口可能返回） |
| `private` | `64` | 仅自己可见 | 是 |
| — | `128` | 部分好友不可见 | 否（列表接口可能返回） |

`resolveVisibility(v)` 把 `'friends' | 'all' | 'private'`（大小写不敏感）、等价的数字
（1 / 4 / 16 / 64 / 128）或数字字符串（`'4'`）归一成数字；`undefined` / `null` / `''`
走缺省 `friends`。**非法值抛错**，不静默回退 —— 历史实现是 `QZONE_UGC_RIGHT[v] ?? 4`，
非法值会被悄悄发成"好友可见"，在发布类动作上属于 fail-open。

## 配置项

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 是否启用 QQ 空间（说说）相关能力 |
| `defaultVisibility` | `'friends'` / `'all'` / `'private'` | `'friends'` | 未显式指定可见性时的缺省值 |
| `maxImages` | 整数 0~9 | `9` | 一条说说最多允许几张配图 |

三个字段都带 `.extra('volatile', true)`（DSH 的"可热改、不重挂载"标记）。**不要**写成
`.volatile()` —— 本仓库钉的 `@deepseek-ai/schemastery@^3.18.1` 没有这个方法，写了会
`TypeError: .volatile is not a function`。也不要用 `z.enum` / `.int()`：该版本没有，
枚举请用 `z.union([z.const(...), ...])`、整数请用 `z.natural()`。

## 目录

```
plugins/qq-qzone/
├── package.json          # name/version/type/main/license/dsh.bundle.patch/dependencies
├── cordis.patch.yml      # - insert: [ { id: qq-qzone, name: qq-qzone, config: {} } ]
├── README.md             # 本文件
└── lib/
    └── index.js          # name / inject / QZONE_NAMESPACE / Config / apply + core 再导出
```

`lib/index.js` 用 `'../../../src/qzone-core.js'` 引到仓库根的 `src/qzone-core.js`
（从 `lib/` 数三级）。插件的安装位是 `~/.dsh/plugins/qq-qzone` → 仓库
`plugins/qq-qzone` 的目录链接（见 `scripts/setup-dsh.mjs` 的 linkBundle），Node 默认按
realpath 解析，所以实际读到的就是仓库里那一份，与 MCP server 用的是同一个文件。

## 测试

```bash
node scripts/test-qq-qzone.mjs
```

纯 Node，不联网、不连 OneBot：只测插件包形态（package.json 必填字段、版本与根包一致、
patch 的 id/name 契约、`lib/index.js` 可 import）和 `src/qzone-core.js` 的纯函数
（可见性归一、发帖参数校验、出站门禁）。
