// QQ 空间（说说）插件 —— 只有 host 半，**没有** client 半。
//
// 职责边界（很重要，别把它做成"另一条发送路径"）：
//   · 本插件只做两件事：① 提供一个 settings 命名空间 `qq-qzone`（开关 / 默认可见性 /
//     配图上限）；② 把 `src/qzone-core.js` 的纯函数与常量作为插件真身再导出，
//     让"插件确实装了、确实能拿到 qzone 的逻辑"可被静态检查与单测验证。
//   · **它不发送任何东西**。真正的发布/列表/删除仍然是 MCP server
//     `src/mcp-snowluma-safe.js` 里的 `qq_qzone_post` / `qq_qzone_list` /
//     `qq_qzone_delete` 三个工具 —— 模型看到的就是这三个工具的 schema。
//
// 为什么没有 host（桥接端点）半：
//   桥接 `src/bridge.js` 压根没有 `/api/qzone/*` 之类的端点。qzone 是"agent 主动发一条
//   说说/看一眼列表"的工具型动作，不需要经过桥接的消息路由（没有入站事件、没有白名单
//   会话、没有 reserved2 仿真上下文），所以 MCP 工具**直连 OneBot**
//   （`send_qzone_msg` / `get_qzone_msg_list` / `delete_qzone_msg`，与 `onebot()` 同一套
//   `snowluma.httpUrl` + `accessToken`）。
//   代价是：直连 OneBot 绕过了桥接 outbound 端点里的 SENSITIVE_RE 审计，所以出站正文
//   必须在 MCP 工具侧自己补门禁 —— 那就是 `qzoneGuard()`（实现见 src/qzone-core.js，
//   本次从 mcp-snowluma-safe.js 原样搬过来，判定与文案逐字未改）。
//
// 为什么有一个几乎空着的 `apply()`：
//   DSH 0.2.0 起命名空间**不再需要注册**（0.1.x 的 `ctx.settings.register()` 已删除）。
//   一个命名空间能被读写只需要三点：① loader entry 的 id 恰好等于命名空间名
//   （见 cordis.patch.yml 的 `id: qq-qzone`）；② 该 entry 的插件模块导出 `Config`；
//   ③ `Config` 里至少一个字段带 `volatile` 标记。所以 `apply()` 只写一行诊断。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import z from '@deepseek-ai/schemastery';

// QQ 空间（说说）的唯一一份纯逻辑实现。
//
// 路径解析：本文件在 `plugins/qq-qzone/lib/index.js`，
//   `.`         = plugins/qq-qzone/lib
//   `../..`     = plugins           ← 所以 `'../../src/qzone-core.js'` 会指到
//                                     `plugins/src/qzone-core.js`（不存在，实测）
//   `../../..`  = 仓库根           ← `'../../../src/qzone-core.js'` 才是 `src/qzone-core.js`
// 三级是**正确**的那一级；插件的安装位是 `~/.dsh/plugins/qq-qzone` → 仓库
// `plugins/qq-qzone` 的 junction（见 scripts/setup-dsh.mjs 的 linkBundle），
// Node 默认按 realpath 解析，所以实际读到的仍是仓库里的 `src/qzone-core.js`，
// 与 MCP server 用的是同一份文件（不复制、不漂移）。
import {
  QZONE_MAX_CONTENT,
  QZONE_MAX_IMAGES,
  QZONE_UGC_RIGHT,
  QZONE_RIGHT_LABEL,
  QZONE_DEFAULT_VISIBILITY,
  qzoneGuard,
  resolveVisibility,
  buildQzonePostPayload,
  describeQzoneError,
} from '../../../src/qzone-core.js';

// 再把它们原样导出：插件因此"有真身"——导入 plugins/qq-qzone 就能拿到与 MCP 侧
// 完全同源的常量与校验函数，静态测试不必去 vm 里挖 server.tool() 注册表。
export {
  QZONE_MAX_CONTENT,
  QZONE_MAX_IMAGES,
  QZONE_UGC_RIGHT,
  QZONE_RIGHT_LABEL,
  QZONE_DEFAULT_VISIBILITY,
  qzoneGuard,
  resolveVisibility,
  buildQzonePostPayload,
  describeQzoneError,
};

export const name = 'qq-qzone';

// 命名空间属于 settings seam：声明依赖，让这个 entry 等 settings 就绪后再 activate。
export const inject = ['settings'];

// 死契约：必须与 cordis.patch.yml 里那条 entry 的 `id` 逐字相等（'qq-qzone'），
// 且**不能**写成包名以外的别的东西 —— DSH 用 `entry.options.id === ns` 定位命名空间。
export const QZONE_NAMESPACE = 'qq-qzone';

// 诊断日志写系统临时目录，**不要**按相对层级往上爬（历史坑：往上是 <DSH_HOME>/..，
// 会在用户主目录旁凭空拉出 state/ 目录）。可用 QQ_QZONE_DIAG 覆盖（空字符串 = 关闭）。
const DIAG = process.env.QQ_QZONE_DIAG ?? path.join(os.tmpdir(), 'qq-qzone-plugin.log');

function diag(msg) {
  if (!DIAG) return;
  try {
    fs.mkdirSync(path.dirname(DIAG), { recursive: true });
    fs.appendFileSync(DIAG, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

/**
 * settings 命名空间 `qq-qzone` 的 schema。
 *
 * 这些字段只影响**插件的宿主侧行为/默认值展示**（例如以后若要给 qzone 工具注入
 * `maxImages` 上限）；本次不改变三个 MCP 工具的行为 —— 它们的 schema 契约没动。
 *
 * ⚠️ 每个字段都用 `.extra('volatile', true)`，**不要**写 `.volatile()`：
 *   `.volatile()` 只是 DSH 自带那份 schemastery 的语法糖，本仓库钉的
 *   `@deepseek-ai/schemastery@^3.18.1` 解析出来的那份**没有这个方法**，
 *   写了会直接 `TypeError: .volatile is not a function`。`.extra` 两边都有。
 */
export const Config = z.object({
  enabled: z.boolean()
    .description('是否启用 QQ 空间（说说）相关能力；关掉表示不再允许 agent 发说说')
    .default(true)
    .extra('volatile', true),

  // 注意：schemastery 3.18 没有 `z.enum`，也没有 `.int()`，枚举要用 union of const。
  defaultVisibility: z.union([
    z.const('friends'), z.const('all'), z.const('private'),
  ])
    .description('发说说时未显式指定可见性时的缺省值（friends=好友可见 / all=所有人 / private=仅自己）')
    .default('friends')
    .extra('volatile', true),

  maxImages: z.natural()
    .description('一条说说最多允许几张配图（工具 schema 的硬上限是 9）')
    .min(0)
    .max(9)
    .default(9)
    .extra('volatile', true),
});

/**
 * 装配钩子。0.2.0 下**不需要做任何事**：命名空间由 entry id + `Config` 推导
 * （见文件头注释）。
 *
 * 刻意不调用 `ctx.settings.register(...)` —— 该方法在 0.2.0 已不存在；
 * 也不调用 `ctx.settings.configure({ auto: false })` —— 那会关掉自动设置页策略。
 * 本插件没有 client 半，本来也不渲染设置卡片。
 */
export function apply(ctx) {
  diag(
    `apply called; settings service=${typeof ctx?.settings}; namespace=${QZONE_NAMESPACE}; `
    + `defaultVisibility=${Config.defaultVisibility?.default ?? 'friends'}; maxImages=${QZONE_MAX_IMAGES} (0.2.0: no registration needed)`
  );
}
