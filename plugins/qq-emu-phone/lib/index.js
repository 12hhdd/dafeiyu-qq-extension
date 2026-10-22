// 「我的手机」MuMu 安卓模拟器控制插件（host 插件，只暴露一个 settings 命名空间）。
//
// 这个插件**没有 browser/client 半**，不会生成 WebUI 设置卡片；它存在的意义是把
// 模拟器能力在 DSH 侧变成一个**可配置项容器**（命名空间 `qq-emu-phone`），
// 让 `adbPath` / `connectTarget` / `toolCallTimeoutMs` 这些参数能从 DSH 设置里看见与修改。
//
// ⚠️ 真正的工具面**不在本插件里**：MCP server 实体是 `src/mcp-emu-phone.js`
//   （`new McpServer(...)` + 9 个 `server.tool()`），由 `scripts/setup-dsh.mjs` 的
//   `MANAGED_MCP_IDS` / `mcpEntries()` 以**绝对路径**注册成 `@deepseek-ai/dsh-mcp-client`
//   loader 行，DSH 侧暴露为 `mcp__emu-phone__emu_*`。本插件不 imports、也不重实现 adb 逻辑
//   —— 两条通道各自独立：MCP 条目缺失只影响工具可见性，本插件缺失只影响设置页。
//
// ⚠️ DSH 0.2.0 起，命名空间**不再需要注册**。
//   0.1.x 有 `ctx.settings.register(ns, schema, opts)`；0.2.0 已经删掉它，
//   命名空间改为**从 profile 的 loader entry 推导**（dsh-settings 的
//   `configEditor.configuration()` → `ns: entry.options.id`）。一个命名空间要能被
//   读写，只需要：
//     ① 存在一个 loader entry，其 **id 恰好等于命名空间名** —— 见 cordis.patch.yml
//        的 `id: qq-emu-phone`；
//     ② 该 entry 的插件模块导出 `Config`（schema 读的就是 fiber.runtime.Config）；
//     ③ `Config` 里至少有一个字段带 `volatile` 标记。
//   所以本插件的 `apply()` 在 0.2.0 下是**空操作**，命名空间照样出现在
//   `settings/describe` 里、照样可写。这里保留一个显式空实现 + 诊断日志，是为了让
//   "这个 entry 确实被装配了"可观测，同时避免有人照着旧注释把 `settings.register`
//   加回来（0.2.0 下那会让 apply 抛 TypeError）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import z from '@deepseek-ai/schemastery';

// 诊断日志写系统临时目录，**不要**按相对层级往上爬。
//
// 历史坑（qq-mode-console 踩过）：这里曾经是 path.join(__dirname, '..', '..', '..', 'state', ...)。
// 插件是以 `link:<DSH_HOME>/plugins/<name>` 装进 profile 的，往上是 <DSH_HOME>/..，
// 于是在任何非作者机器上都会在用户主目录旁凭空拉出一个 state/ 目录，
// 只有作者机器上恰好指回仓库时才"看起来正常"。可用 QQ_EMU_PHONE_DIAG 覆盖路径（空字符串=关闭）。
const DIAG = process.env.QQ_EMU_PHONE_DIAG ?? path.join(os.tmpdir(), 'qq-emu-phone-plugin.log');

function diag(msg) {
  if (!DIAG) return;
  try {
    fs.mkdirSync(path.dirname(DIAG), { recursive: true });
    fs.appendFileSync(DIAG, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

export const name = 'qq-emu-phone';
// 命名空间属于 settings seam：声明依赖让 entry 等 settings 就绪后再 activate。
export const inject = ['settings'];

// **死契约**：必须与 cordis.patch.yml 里那条 entry 的 `id` 完全一致。
// 写错（例如写成插件目录名之外的任何字符串）会让 settings 定位失败并抛
// `No configurable plugin entry "qq-emu-phone"`。
export const EMUPHONE_NAMESPACE = 'qq-emu-phone';

// 默认 adb 路径与连接目标：与 src/mcp-emu-phone.js 的 `emuCfg()` 默认值保持一致。
// 注意那个 adb 默认值是 **MuMu 的默认安装位**（`<盘符>:` + `\mumu\MuMuPlayer\nx_main\adb.exe`），
// 换机器基本都要改；公开文档里不要把它当成本机路径宣传（privacy-scan 会扫真实盘符路径）。
const DEFAULT_ADB_PATH = 'D:\\mumu\\MuMuPlayer\\nx_main\\adb.exe';
const DEFAULT_CONNECT_TARGET = '127.0.0.1:16384';

/**
 * 这个插件**作为 loader entry 的 Config** 暴露出去的可配置项。
 *
 * 为什么必须有它、而且字段必须带 `volatile`：
 *   DSH 定位 settings 命名空间的方式（0.1.7 起成立，0.2.0 更加是唯一路径）是
 *   （dsh-settings/lib/index.js）：
 *       const entry = configEditor.entries().find((row) => row.options.id === ns);
 *       const schema = entry?.fiber?.runtime?.Config;
 *       if (!entry || !schema) throw new Error(`No configurable plugin entry "${ns}"`);
 *       const form = volatileForm(schema);   // 只保留 meta.volatile 的字段，否则抛
 *                                            // "Plugin entry ... has no volatile fields"
 *   也就是说 `Config` 里**至少要有一个** `.extra('volatile', true)` 字段，否则整条命名空间
 *   不可写（连 enabled 都读不到）。
 *
 * `.extra('volatile', true)` 是 DSH 的"可热改、不重挂载"标记。这里**刻意不写 `.volatile()`**：
 * 那只是 schemastery 的一个语法糖（DSH 自带那份 schemastery 里
 * `Schema.prototype.volatile = function () { return this.extra('volatile', true) }`），
 * 而它**只存在于 DSH 自带的那份**；本仓库钉的 `^3.18.1` 解析出来的那份没有这个方法 ——
 * 写 `.volatile()` 会 `TypeError: .volatile is not a function`。`.extra` 两边都有，行为完全一致。
 */
export const Config = z.object({
  enabled: z.boolean()
    .description('是否启用「我的手机」能力（仅记录开关，真正执行仍由 MCP 条目与 adb 决定）')
    .default(true)
    .extra('volatile', true),
  adbPath: z.string()
    .description('adb 可执行文件路径（建议填绝对路径；留空则用 MCP server 内的默认值）')
    .default(DEFAULT_ADB_PATH)
    .extra('volatile', true),
  connectTarget: z.string()
    .description('adb connect 目标（MuMu NAT 模式通常是 127.0.0.1:16384）')
    .default(DEFAULT_CONNECT_TARGET)
    .extra('volatile', true),
  toolCallTimeoutMs: z.number()
    .description('单次工具调用超时毫秒（emu_watch 抽帧最长 120s，默认留足余量）')
    .default(300000)
    .extra('volatile', true),
});

/**
 * 装配钩子。0.2.0 下**不需要做任何事**：命名空间由 entry id + `Config` 推导
 * （见文件头注释）。这里只记一行诊断，证明 entry 真的被装配过。
 *
 * 刻意不调用 `ctx.settings.register(...)`：该方法在 0.2.0 已不存在。
 * 也不要改成 `ctx.settings.configure({ auto: false })` —— 那会关掉自动设置页策略，
 * 与默认行为相反。本插件没有 client 半，本来也不会渲染卡片。
 */
export function apply(ctx) {
  diag(`apply called; settings service=${typeof ctx?.settings}; namespace=${EMUPHONE_NAMESPACE} (0.2.0: no registration needed)`);
}
