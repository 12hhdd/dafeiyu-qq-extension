// qq-emu-phone 插件的登记期静态检验 + src/mcp-emu-phone.js 的版本身份校验。
//
// 钉住的东西：
//   ① 插件包形态与仓库标准一致（name/version/type/main/license/dsh.bundle.patch/dependencies），
//      且 **version 必须等于根 package.json**（scripts/verify-dsh-020-adaptation.mjs:197
//      对 qq-mode-console 就是这么钉的；子包版本漂移没有任何其它防线）；
//   ② `cordis.patch.yml` 的 entry **id 恰好等于 settings 命名空间名 `qq-emu-phone`**，
//      `name` 是包名。这是命名空间**可读写**的第一条前提（另外两条在 lib/index.js：
//      导出 `Config`、且至少一个字段带 `volatile` 标记）；
//   ③ `lib/index.js` 能被 import，导出面 name / inject / Config / apply 齐全，
//      `Config` 的字段全部带 `.extra('volatile', true)`（否则 DSH 抛
//      "Plugin entry ... has no volatile fields"，整条命名空间不可写）；
//   ④ `src/mcp-emu-phone.js` 里 `new McpServer({...})` 的 version 字面量等于根包版本。
//      这里曾经是 `'1.0.0'`（其余三个 MCP server 都是 0.2.0-r3），而该文件当时**不在**
//      verify-dsh-020-adaptation.mjs 的版本循环里（:198 只列了 3 个文件），所以漂移
//      一直没有被拦住。本测试是它的独立防线。
//
// 为什么要有这条独立防线：MCP server 的 serverInfo.version 是对外自称的版本身份，
// v0.1.5 曾带着自称 0.1.2-alpha.1 的 package-lock.json 发布出去（见
// verify-dsh-020-adaptation.mjs:189-191 记的历史事故）。工具名与 adb 逻辑**不在**本
// 测试的断言范围里（改名会破坏 `mcp__emu-phone__*` 前端契约，另有 stdio 冒烟覆盖）。
//
// 纯 Node、不联网、**不启动 adb、不需要模拟器在线**；真实工具面握手由
// scripts/test-mcp-servers-stdio.mjs 以 stdio 拉起覆盖（握手阶段不碰 adb）。
// 用法：node scripts/test-qq-emu-phone.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import yaml from 'js-yaml';

let failed = 0;
const assert = (name, cond, extra = '') => {
  if (!cond) failed += 1;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
};

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PLUGIN_DIR = path.join(ROOT, 'plugins', 'qq-emu-phone');
const NS = 'qq-emu-phone';
const PKG_NAME = 'qq-emu-phone';

// ── 0. 文件齐全（四件套） ────────────────────────────────────────────────
for (const rel of ['package.json', 'cordis.patch.yml', 'lib/index.js', 'README.md']) {
  assert(`插件文件存在 ${rel}`, fs.existsSync(path.join(PLUGIN_DIR, rel)));
}

// ── 1. package.json 形态 ─────────────────────────────────────────────────
const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'package.json'), 'utf8'));
const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

assert('package.json name 为包名', pkg.name === PKG_NAME, `实际 ${pkg.name}`);
assert('package.json version 与根包一致', pkg.version === rootPkg.version, `插件=${pkg.version} 根包=${rootPkg.version}`);
assert('package.json type 为 module', pkg.type === 'module', `实际 ${pkg.type}`);
assert('package.json main 指向 ./lib/index.js', pkg.main === './lib/index.js', `实际 ${pkg.main}`);
assert('package.json license 为 MIT', pkg.license === 'MIT', `实际 ${pkg.license}`);
assert('package.json 有一句话 description', typeof pkg.description === 'string' && pkg.description.trim().length > 0);
assert(
  'package.json dsh.bundle.patch 指向 ./cordis.patch.yml',
  pkg.dsh?.bundle?.patch === './cordis.patch.yml',
  `实际 ${JSON.stringify(pkg.dsh?.bundle?.patch)}`,
);
assert(
  'package.json 声明 @deepseek-ai/schemastery 依赖',
  typeof pkg.dependencies?.['@deepseek-ai/schemastery'] === 'string',
  `实际 ${pkg.dependencies?.['@deepseek-ai/schemastery']}`,
);

// ── 2. cordis.patch.yml 契约 ─────────────────────────────────────────────
const patchText = fs.readFileSync(path.join(PLUGIN_DIR, 'cordis.patch.yml'), 'utf8');

// id 抽取用与 test-qq-mode-plugin.mjs:41 完全相同的正则，保证两处判据一致。
const ids = [...patchText.matchAll(/^\s*-\s*id:\s*(\S+)\s*$/gm)].map((m) => m[1]);
assert('patch 里只有一个 entry id', ids.length === 1, `实际 [${ids.join(', ')}]`);
assert(`patch 的 entry id 恰好是命名空间名 ${NS}`, ids.includes(NS), `实际 [${ids.join(', ')}]`);

// name 必须是包名（不能只写 id 就完事；二者职责不同）。
const nameLines = [...patchText.matchAll(/^\s*name:\s*(\S+)\s*$/gm)].map((m) => m[1]);
assert('patch 里出现 name:', nameLines.includes(PKG_NAME), `实际 [${nameLines.join(', ')}]`);

// 顶层必须是 YAML 数组，每项是 {insert: [...]}（setup-dsh.mjs:164-171 会修那种坏根）。
let patchDoc = null;
try {
  patchDoc = yaml.load(patchText.replace(/^\uFEFF/, ''));
} catch (error) {
  assert('cordis.patch.yml 能被 YAML 解析', false, error?.message);
}
assert('cordis.patch.yml 顶层是 YAML 数组', Array.isArray(patchDoc), Array.isArray(patchDoc) ? '' : `实际 ${patchDoc === null ? 'null' : typeof patchDoc}`);
const inserts = Array.isArray(patchDoc) ? patchDoc.flatMap((op) => (Array.isArray(op?.insert) ? op.insert : [])) : [];
assert('patch 里有一条 insert 条目', inserts.length === 1, `实际 ${inserts.length}`);
assert(
  'insert 条目的 id/name 与正则抽取一致',
  inserts[0]?.id === NS && inserts[0]?.name === PKG_NAME,
  `实际 ${JSON.stringify(inserts[0] && { id: inserts[0].id, name: inserts[0].name })}`,
);
assert('insert 条目的 config 是对象', inserts[0]?.config !== null && typeof inserts[0]?.config === 'object');

// ── 3. lib/index.js 导出面 ───────────────────────────────────────────────
const mod = await import(pathToFileURL(path.join(PLUGIN_DIR, 'lib', 'index.js')).href);

assert('插件导出 name 为包名', mod.name === PKG_NAME, `实际 ${mod.name}`);
assert('导出 inject 含 settings', Array.isArray(mod.inject) && mod.inject.includes('settings'), `实际 ${JSON.stringify(mod.inject)}`);
assert('导出命名空间常量且等于 patch 的 id', mod.EMUPHONE_NAMESPACE === NS, `实际 ${mod.EMUPHONE_NAMESPACE}`);
assert('导出 Config 是 schemastery schema', typeof mod.Config === 'function');
assert('导出 apply 是函数', typeof mod.apply === 'function');

// apply() 必须容忍没有 ctx.settings 的环境（DSH 早期装配/单测环境）——静默降级，不许抛。
assert('apply({}) 静默降级不抛', (() => {
  try {
    mod.apply({});
    return true;
  } catch {
    return false;
  }
})());

// 源码层面禁止 `.volatile()`：仓库钉的 schemastery ^3.18.1 **没有**这个方法，
// 写了会在加载期直接 TypeError（见 lib/index.js 的注释）。只看可执行代码，注释里会提到它。
const pluginSource = fs.readFileSync(path.join(PLUGIN_DIR, 'lib', 'index.js'), 'utf8');
const pluginCode = pluginSource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
assert('lib/index.js 不使用 .volatile()（schemastery ^3.18.1 没有该方法）', !/\.volatile\s*\(/.test(pluginCode));
// 0.2.0 已删除 ctx.settings.register()；照着旧注释加回来会让 apply 抛 TypeError。
assert('lib/index.js 不调用已删除的 ctx.settings.register()', !/settings\s*\.\s*register\s*\(/.test(pluginCode));
assert('lib/index.js 不调用 settings.configure()（会关掉自动设置页策略）', !/settings\s*\.\s*configure\s*\(/.test(pluginCode));


// ③ volatile 标记：schemastery 的 toJSON() 是**引用表**形状
//    （{uid, refs:{'<uid>': <node>}}），真正的 dict/字段在 refs 里，要先把 uid 解析回节点。
let volatileFields = [];
if (typeof mod.Config === 'function') {
  const json = mod.Config.toJSON();
  const refs = json.refs ?? {};
  const root = refs[String(json.uid)] ?? json;
  volatileFields = Object.entries(root.dict ?? {})
    .filter(([, node]) => refs[String(node)]?.meta?.volatile === true)
    .map(([key]) => key);
}
assert(
  'Config 至少一个字段带 .extra(\'volatile\', true)',
  volatileFields.length > 0,
  `实际 volatile 字段：[${volatileFields.join(', ') || '(无)'}]（缺了 DSH 会抛 "has no volatile fields"）`,
);
for (const field of ['enabled', 'adbPath', 'connectTarget', 'toolCallTimeoutMs']) {
  assert(`Config 字段 ${field} 带 volatile`, volatileFields.includes(field), `实际 [${volatileFields.join(', ')}]`);
}

// Config 形状：字段类型正确、默认值可用（这是设置页能渲染出来的前提）。
const resolved = typeof mod.Config === 'function' ? mod.Config({}) : {};
assert('Config 默认 enabled 为 boolean', typeof resolved.enabled === 'boolean', `实际 ${typeof resolved.enabled}`);
assert('Config 默认 adbPath 为非空 string', typeof resolved.adbPath === 'string' && resolved.adbPath.length > 0);
assert('Config 默认 connectTarget 为非空 string', typeof resolved.connectTarget === 'string' && resolved.connectTarget.length > 0);
assert('Config 默认 toolCallTimeoutMs 为正数', typeof resolved.toolCallTimeoutMs === 'number' && resolved.toolCallTimeoutMs > 0, `实际 ${resolved.toolCallTimeoutMs}`);

// ── 4. src/mcp-emu-phone.js 的 MCP serverInfo.version ────────────────────
const mcpPath = path.join(ROOT, 'src', 'mcp-emu-phone.js');
const mcpSource = fs.readFileSync(mcpPath, 'utf8');
const ver = /new McpServer\(\{[^}]*version:\s*'([^']+)'/.exec(mcpSource);
assert('src/mcp-emu-phone.js 里有 new McpServer({... version: \'...\' })', Boolean(ver), ver ? '' : '正则没抓到 version 字面量');
assert(
  'src/mcp-emu-phone.js 的 MCP version 与根包一致',
  ver?.[1] === rootPkg.version,
  `声明=${ver?.[1]} 根包=${rootPkg.version}`,
);
// 同一文件里不应再有第二个自相矛盾的 version 字面量声明（历史值是 '1.0.0'）。
assert('不再残留 version: \'1.0.0\' 的自称', !/new McpServer\(\{[^}]*version:\s*'1\.0\.0'/.test(mcpSource));
// 工具名契约：11 个 emu_* 工具（改名会破坏 mcp__emu-phone__* 前端契约）。
// 顺序也钉住：新增工具必须同时更新这里，避免「悄悄少/多一个」这种回归。
const toolNames = [...mcpSource.matchAll(/server\.tool\(\s*'([^']+)'/g)].map((m) => m[1]);
assert('共注册 11 个工具', toolNames.length === 11, `实际 ${toolNames.length}：[${toolNames.join(', ')}]`);
assert(
  '工具名集合与预期完全一致（顺序也钉住）',
  toolNames.join(',') === 'emu_status,emu_screenshot,emu_tap,emu_tap_text,emu_focus_text,emu_text,emu_ui,emu_key,emu_swipe,emu_app,emu_watch',
  `实际 [${toolNames.join(', ')}]`,
);
// 两个新工具是「点不到输入框」的专用解法，缺了就等于修复回退。
for (const must of ['emu_ui', 'emu_focus_text']) {
  assert(`新工具 ${must} 已注册`, toolNames.includes(must));
}
assert(
  '全部工具名满足 DSH 命名契约 /^[A-Za-z0-9_-]{1,64}$/',
  toolNames.every((n) => /^[A-Za-z0-9_-]{1,64}$/.test(n)),
  `违规：[${toolNames.filter((n) => !/^[A-Za-z0-9_-]{1,64}$/.test(n)).join(', ')}]`,
);

// ── 汇总 ─────────────────────────────────────────────────────────────────
if (failed > 0) {
  console.log(`\n❌ ${failed} 项失败`);
  process.exit(1);
}
console.log('\nok - qq-emu-phone 插件契约与 MCP 版本身份全部通过');
