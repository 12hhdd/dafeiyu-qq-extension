// QQ 空间（说说）插件化后的行为测试。
//
// 覆盖两层：
//   ① 包形态 —— plugins/qq-qzone 的 package.json 必填字段、版本与根包一致、
//      cordis.patch.yml 的 id/name 死契约、lib/index.js 可 import 且导出面完整；
//   ② 纯函数 —— src/qzone-core.js 的 resolveVisibility / buildQzonePostPayload /
//      qzoneGuard（这正是从 mcp-snowluma-safe.js 抽出来的那段逻辑）。
//
// 为什么必须钉住（给 scripts/test-audit.mjs 的注释用）：
//   qzone 工具**直连 OneBot**，绕过了桥接 outbound 端点里的 SENSITIVE_RE 审计，
//   所以 `qzoneGuard` 是唯一一道出站门禁；把它抽到 core 后若被谁改成
//   `QZONE_UGC_RIGHT[v] ?? 4` 那种静默回退，非法可见性会被悄悄发成"好友可见"，
//   而 QQ 侧没有任何回执能暴露这件事。另外 patch 里 entry id 若写成包名
//   （qq-qzone 之外的东西/写错），DSH 会抛 `No configurable plugin entry`，
//   表现为"设置页里看不到这个命名空间"——纯静态断言才能提前拦住。
//
// 纯 Node，不联网、不连 OneBot、不读 config.json；只做 import 与字符串/文件检查。
// 失败即 process.exit(1)；成功打印 `ok - ...` 汇总。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT_PATH = fileURLToPath(new URL('..', import.meta.url));

// ── 迷你断言/记账（不用 node:test，好让输出固定成 ok - ... 一行一条） ──────
const results = [];

function check(label, fn) {
  try {
    fn();
    results.push({ label, ok: true });
    console.log(`ok - ${label}`);
  } catch (error) {
    results.push({ label, ok: false, error });
    console.log(`not ok - ${label}`);
    console.log(`  ${error?.message ?? error}`);
  }
}

function eq(actual, expected, what) {
  if (actual !== expected) throw new Error(`${what}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

function deepEq(actual, expected, what) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}：期望 ${b}，实际 ${a}`);
}

function truthy(value, what) {
  if (!value) throw new Error(what);
}

// ── 载入被测对象 ──────────────────────────────────────────────────────────
const PLUGIN_DIR = path.join(ROOT_PATH, 'plugins', 'qq-qzone');
const ROOT_PKG = JSON.parse(fs.readFileSync(path.join(ROOT_PATH, 'package.json'), 'utf8'));

const core = await import(new URL('../src/qzone-core.js', import.meta.url).href);
const pluginPkg = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'package.json'), 'utf8'));
const patchText = fs.readFileSync(path.join(PLUGIN_DIR, 'cordis.patch.yml'), 'utf8');
const pluginSource = fs.readFileSync(path.join(PLUGIN_DIR, 'lib', 'index.js'), 'utf8');
const coreSource = fs.readFileSync(path.join(ROOT_PATH, 'src', 'qzone-core.js'), 'utf8');
const mcpSource = fs.readFileSync(path.join(ROOT_PATH, 'src', 'mcp-snowluma-safe.js'), 'utf8');
const plugin = await import(pathToFileURL(path.join(PLUGIN_DIR, 'lib', 'index.js')).href);

// ── ① 包形态自检 ─────────────────────────────────────────────────────────
check('plugins/qq-qzone/package.json 必填字段齐全', () => {
  eq(pluginPkg.name, 'qq-qzone', 'name 必须等于目录名');
  eq(pluginPkg.type, 'module', 'type 必须是 module');
  eq(pluginPkg.main, './lib/index.js', 'main 必须指向 ./lib/index.js');
  eq(pluginPkg.license, 'MIT', 'license 必须是 MIT');
  truthy(typeof pluginPkg.description === 'string' && pluginPkg.description.length > 20, 'description 必须有实质内容');
  eq(pluginPkg.dsh?.bundle?.patch, './cordis.patch.yml', 'dsh.bundle.patch 必须指向 ./cordis.patch.yml');
  eq(pluginPkg.dependencies?.['@deepseek-ai/schemastery'], '^3.18.1', 'schemastery 依赖必须钉 ^3.18.1（与根包一致）');
});

check('插件 version 与根包一致（0.2.0-r3）', () => {
  eq(pluginPkg.version, ROOT_PKG.version, '子包 version 必须等于根 package.json 的 version');
  eq(pluginPkg.version, '0.2.0-r3', '根包当前是 0.2.0-r3，子包必须跟版');
});

check('cordis.patch.yml 的 entry id 等于命名空间、name 等于包名', () => {
  // 死契约 ①：DSH 用 `entry.options.id === ns` 定位 settings 命名空间。
  const ids = [...patchText.matchAll(/^\s*-\s*id:\s*(\S+)\s*$/gm)].map((m) => m[1]);
  eq(ids.length, 1, `patch 里应该恰好一条 entry id，实际 ${ids.length} 条`);
  eq(ids[0], 'qq-qzone', 'entry id 必须等于插件导出的 QZONE_NAMESPACE');
  eq(ids[0], plugin.QZONE_NAMESPACE, 'entry id 必须与 lib/index.js 的 QZONE_NAMESPACE 一致');
  const names = [...patchText.matchAll(/^\s*name:\s*(\S+)\s*$/gm)].map((m) => m[1]);
  eq(names[0], 'qq-qzone', 'entry name 必须是包名');
  eq(names[0], pluginPkg.name, 'entry name 必须与 package.json 的 name 一致');
  truthy(/^-\s*insert:/m.test(patchText), 'patch 顶层必须是 - insert: 数组');
});

check('lib/index.js 可 import，导出面完整', () => {
  eq(plugin.name, 'qq-qzone', '插件 name 必须是包名');
  deepEq(plugin.inject, ['settings'], "inject 必须声明 ['settings']");
  eq(plugin.QZONE_NAMESPACE, 'qq-qzone', 'QZONE_NAMESPACE 必须等于 entry id');
  eq(typeof plugin.apply, 'function', '必须导出 apply(ctx)');
  truthy(plugin.Config, '必须导出 Config —— 0.2.0 里这就是命名空间的 schema 来源');
  // 插件要有真身：core 的常量与纯函数必须能从插件再导出（同一份实现，不复制）。
  for (const key of ['QZONE_UGC_RIGHT', 'QZONE_RIGHT_LABEL', 'QZONE_MAX_CONTENT', 'QZONE_MAX_IMAGES']) {
    truthy(plugin[key] !== undefined, `插件必须再导出 core 的 ${key}`);
  }
  for (const key of ['qzoneGuard', 'resolveVisibility', 'buildQzonePostPayload']) {
    eq(typeof plugin[key], 'function', `插件必须再导出 core 的 ${key}()`);
  }
  // 再导出的必须是同一个对象/函数（同一个模块实例），不是拷贝出来的第二份。
  eq(plugin.QZONE_UGC_RIGHT, core.QZONE_UGC_RIGHT, 'QZONE_UGC_RIGHT 必须是 core 的同一个对象');
  eq(plugin.qzoneGuard, core.qzoneGuard, 'qzoneGuard 必须是 core 的同一个函数');
});

check('Config 是可用 schema，字段带 volatile（不是 .volatile()）', () => {
  const resolved = plugin.Config({});
  eq(resolved.defaultVisibility, 'friends', 'defaultVisibility 缺省应为 friends');
  eq(resolved.maxImages, 9, 'maxImages 缺省应为 9');
  eq(resolved.enabled, true, 'enabled 缺省应为 true');

  const json = plugin.Config.toJSON();
  const refs = json.refs ?? {};
  const root = refs[String(json.uid)] ?? json;
  const volatileFields = [];
  for (const [key, node] of Object.entries(root.dict ?? {})) {
    if (refs[String(node)]?.meta?.volatile === true) volatileFields.push(key);
  }
  truthy(volatileFields.length > 0, "Config 至少一个字段必须带 .extra('volatile', true)，否则 settings 写入会抛 has no volatile fields");
  for (const key of ['enabled', 'defaultVisibility', 'maxImages']) {
    truthy(volatileFields.includes(key), `${key} 字段应带 volatile，实际带 volatile 的是：${volatileFields.join(', ')}`);
  }
  // 3.18.1 的 schemastery 没有 .volatile()，写了会在模块求值时就 TypeError。
  // 只看可执行代码：文件头注释里正是拿 .volatile() 做反例说明的。
  const code = pluginSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/).map((line) => line.replace(/\/\/.*$/, '')).join('\n');
  truthy(!/\.volatile\s*\(/.test(code), '不要用 .volatile()（schemastery ^3.18.1 无此方法），请用 .extra(\'volatile\', true)');
  assertApplyToleratesEmptyCtx(plugin);
});

function assertApplyToleratesEmptyCtx(mod) {
  try {
    mod.apply({});
  } catch (error) {
    throw new Error(`apply({}) 不应抛（缺少 ctx.settings 时要静默降级）：${error?.message ?? error}`);
  }
}

check('插件不再调用 0.2.0 已删除的 settings.register/configure', () => {
  // 只看可执行代码：注释里提到 register 是做历史说明。
  const code = pluginSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/).map((line) => line.replace(/\/\/.*$/, '')).join('\n');
  truthy(!/settings\s*\.\s*register\s*\(/.test(code), 'settings.register() 在 DSH 0.2.0 已不存在，调用会 TypeError');
  truthy(!/settings\s*\.\s*configure\s*\(/.test(code), 'apply 不应调用 settings.configure()');
});

// ── ② resolveVisibility ──────────────────────────────────────────────────
check('resolveVisibility：3 个字符串 → all:1 / friends:4 / private:64', () => {
  eq(core.resolveVisibility('all'), 1, "resolveVisibility('all')");
  eq(core.resolveVisibility('friends'), 4, "resolveVisibility('friends')");
  eq(core.resolveVisibility('private'), 64, "resolveVisibility('private')");
  eq(core.resolveVisibility('ALL'), 1, "resolveVisibility('ALL') 大小写不敏感");
  eq(core.resolveVisibility(' Friends '), 4, "resolveVisibility(' Friends ') 要 trim");
});

check('resolveVisibility：3 个数字原样返回', () => {
  eq(core.resolveVisibility(1), 1, 'resolveVisibility(1)');
  eq(core.resolveVisibility(4), 4, 'resolveVisibility(4)');
  eq(core.resolveVisibility(64), 64, 'resolveVisibility(64)');
});

check('resolveVisibility：缺省 friends，非法值抛错（不静默回退）', () => {
  for (const empty of [undefined, null, '']) {
    eq(core.resolveVisibility(empty), 4, `resolveVisibility(${JSON.stringify(empty)}) 应走缺省 friends`);
  }
  for (const bad of ['bogus', 'everyone', 0, 2, 3, 5, 999, -1, 4.5, NaN, true, {}, []]) {
    let threw = false;
    try {
      core.resolveVisibility(bad);
    } catch {
      threw = true;
    }
    truthy(threw, `resolveVisibility(${JSON.stringify(bad)}) 必须抛错，不能静默回退成 friends`);
  }
});

// ── ③ buildQzonePostPayload ──────────────────────────────────────────────
check('buildQzonePostPayload：正常入参 → OneBot 参数字面量', () => {
  const payload = core.buildQzonePostPayload({ content: '今天天气不错', images: ['D:\\日记\\a.jpg'], visibility: 'all' });
  eq(payload.content, '今天天气不错', 'content 原样透出');
  deepEq(payload.images, ['D:\\日记\\a.jpg'], 'images 原样透出');
  eq(payload.ugc_right, 1, "visibility: 'all' → ugc_right 1");
  eq('tid' in payload, false, '未传 tid 时 payload 不应出现 tid 键');
});

check('buildQzonePostPayload：visibility 缺省 → friends(4)，images 缺省 → []', () => {
  const payload = core.buildQzonePostPayload({ content: '只有正文' });
  eq(payload.ugc_right, 4, 'visibility 缺省必须是 friends(4)');
  deepEq(payload.images, [], 'images 缺省必须是空数组（不能是 undefined，OneBot 侧会直接用）');
  eq(payload.content, '只有正文', 'content 原样透出');
});

check('buildQzonePostPayload：content 空 / 非字符串 / 超长都抛错', () => {
  for (const bad of ['', null, undefined, 123, {}, []]) {
    let threw = false;
    try {
      core.buildQzonePostPayload({ content: bad });
    } catch {
      threw = true;
    }
    truthy(threw, `content=${JSON.stringify(bad)} 必须抛错`);
  }
  // 边界：1500 可以，1501 不行（与工具 schema 的 z.string().max(1500) 同一口径）。
  const max = core.QZONE_MAX_CONTENT;
  eq(max, 1500, 'QZONE_MAX_CONTENT 必须是 1500（工具 schema 的硬上限）');
  eq(core.buildQzonePostPayload({ content: 'x'.repeat(max) }).content.length, max, `${max} 个字符必须通过`);
  let threw = false;
  try {
    core.buildQzonePostPayload({ content: 'x'.repeat(max + 1) });
  } catch {
    threw = true;
  }
  truthy(threw, `${max + 1} 个字符必须被拒绝`);
});

check('buildQzonePostPayload：images 0 / 9 / 10 张边界', () => {
  eq(core.QZONE_MAX_IMAGES, 9, 'QZONE_MAX_IMAGES 必须是 9（工具 schema 的硬上限）');
  const make = (n) => Array.from({ length: n }, (_, i) => `https://example.com/${i}.jpg`);
  deepEq(core.buildQzonePostPayload({ content: 'x', images: make(0) }).images, [], '0 张必须是空数组');
  eq(core.buildQzonePostPayload({ content: 'x', images: make(9) }).images.length, 9, '9 张必须通过');
  let threw = false;
  try {
    core.buildQzonePostPayload({ content: 'x', images: make(10) });
  } catch {
    threw = true;
  }
  truthy(threw, '10 张必须被拒绝');
  // 非数组也要抛。
  let threw2 = false;
  try {
    core.buildQzonePostPayload({ content: 'x', images: 'not-an-array' });
  } catch {
    threw2 = true;
  }
  truthy(threw2, 'images 不是数组时必须抛错');
});

// ── ④ qzoneGuard ─────────────────────────────────────────────────────────
check('qzoneGuard：正常正文放行（至少 2 个正例）', () => {
  core.qzoneGuard('今天天气不错，出去走走。');
  core.qzoneGuard('刚看完《三体》，推荐一波。');
  core.qzoneGuard('');
  core.qzoneGuard(undefined);
});

check('qzoneGuard：本机路径 / 凭据特征被拒（至少 1 个拒绝例）', () => {
  const rejected = ['D:\\日记\\x.jpg', 'password: hunter2xyz', '/home/me/secret.txt'];
  for (const text of rejected) {
    let error = null;
    try {
      core.qzoneGuard(text);
    } catch (caught) {
      error = caught;
    }
    truthy(error, `qzoneGuard(${JSON.stringify(text)}) 必须拒绝`);
    // 文案对模型可见，逐字钉住（历史实现原样搬过来，不得改）。
    eq(
      error.message,
      '这条内容里带了本机路径或凭据特征，会被安全策略拦下；把路径、账号之类的东西去掉再发。',
      'qzoneGuard 的报错文案必须逐字不变',
    );
  }
});

// ── ⑤ 迁移完整性：core 没有抄第二份正则；MCP 侧仍注册三个工具 ─────────────
check('src/qzone-core.js 复用 sensitive.js 的正则，没有抄第二份', () => {
  truthy(
    /import\s*\{\s*SENSITIVE_RE\s*\}\s*from\s*'\.\/sensitive\.js'/.test(coreSource),
    'core 必须从 ./sensitive.js import SENSITIVE_RE（全仓库唯一一份实现）',
  );
  const code = coreSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/).map((line) => line.replace(/\/\/.*$/, '')).join('\n');
  truthy(!/= \/.*\\[\\/]/.test(code), 'core 里不应出现自写的路径/凭据正则（会与 sensitive.js 漂移）');
});

check('src/mcp-snowluma-safe.js 仍注册三个 qzone 工具，且 import 是单行', () => {
  for (const tool of ['qq_qzone_post', 'qq_qzone_list', 'qq_qzone_delete']) {
    truthy(mcpSource.includes(`'${tool}'`), `MCP server 必须仍注册 ${tool}`);
  }
  // scripts/test-audit-security-mcp.mjs 用 /^import .*;\r?\n/gm 逐行剥 import 再塞进 vm；
  // 多行 import 会漏网 → vm 里出现 ESM import 声明 → SyntaxError。这条必须钉住。
  const lines = mcpSource.split(/\r?\n/);
  const qzoneImportLines = lines.filter((line) => /^import .*qzone-core\.js';/.test(line));
  eq(qzoneImportLines.length, 1, '必须有且只有一条单行 import qzone-core.js');
  const blockImport = /^import\s*\{[^}]*$[\s\S]{0,200}?\}\s*from\s*'\.\/qzone-core\.js';/m.test(mcpSource);
  truthy(!blockImport, 'qzone-core 的 import 必须是单行，不能拆成多行 import 块');
});

check('qzone 区段的 schema 仍用字面量 1500 / 9，不引用 core 的常量', () => {
  // 陷阱（我实际踩过一次）：把 `z.string().max(1500)` 换成 `max(QZONE_MAX_CONTENT)`
  // 看起来很"去重"，但 scripts/test-audit-security-mcp.mjs 会把本文件的 import
  // **逐行剥掉**再 vm.runInNewContext，而 schema 是模块求值期构造的 ——
  // 那些名字在 vm 上下文里不存在，直接 ReferenceError，整个 security 测试挂掉。
  // 所以 schema 侧必须留字面量，常量只在 core 的纯函数校验里用。
  // 只看可执行代码：区段里的注释明确写了"不要换成 QZONE_MAX_CONTENT"这类反例说明。
  const rawRegion = mcpSource.slice(mcpSource.indexOf('── QQ 空间（说说）'), mcpSource.indexOf('── 日记与长期记忆'));
  const region = rawRegion
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/).map((line) => line.replace(/\/\/.*$/, '')).join('\n');
  truthy(/\.max\(1500\)/.test(region), 'qq_qzone_post 的 content 上限必须写成字面量 .max(1500)');
  truthy(/\.max\(9\)/.test(region), 'qq_qzone_post 的 images 上限必须写成字面量 .max(9)');
  for (const constant of ['QZONE_MAX_CONTENT', 'QZONE_MAX_IMAGES', 'QZONE_MIN_LIST_NUM', 'QZONE_MAX_LIST_NUM']) {
    truthy(!region.includes(constant), `qzone 区段不得引用 ${constant}（vm 里剥掉 import 后会 ReferenceError）`);
  }
  // 三个工具名一个都不能少，且描述文案没被改（前端契约）。
  truthy(region.includes("'qq_qzone_post'"), 'qq_qzone_post 工具名不得改');
  truthy(region.includes('发一条 QQ 空间说说（发在你自己号的空间里，好友能刷到）'), 'qq_qzone_post 描述文案不得改');
});

check('src/qzone-core.js 可独立 import 且无副作用（不联网、不读配置）', () => {
  // 纯函数模块的核心承诺：import 它不产生任何外部副作用。
  // 静态侧能钉的：没有顶层 await、没有顶层 new/connect、没有 config.json 读取。
  const code = coreSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/).map((line) => line.replace(/\/\/.*$/, '')).join('\n');
  truthy(!/^\s*await\s/m.test(code), 'core 不应有顶层 await（import 即求值，会挂住）');
  truthy(!/new\s+McpServer|connect\s*\(/.test(code), 'core 不应建 MCP server / 连接');
  truthy(!/fetch\s*\(|http\.request|readFileSync/.test(code), 'core 不应联网或读文件');
  truthy(!/config\.json/.test(code), 'core 不应读 config.json');
  // 唯一允许的 import 是 sensitive.js 的正则（见上一条 check）。
  const imports = [...coreSource.matchAll(/^import .*$/gm)].map((m) => m[0]);
  eq(imports.length, 1, `core 应只有一条 import（sensitive.js），实际 ${imports.length} 条：${imports.join(' | ')}`);
});

check('limits 常量与工具 schema 的上限一致', () => {
  // core 的纯函数校验和 MCP 工具 schema 是两处独立写的数字，必须相同，
  // 否则模型按 schema 传 1500 字会被 core 拒（或反过来 core 放行 schema 拒）。
  eq(core.QZONE_MAX_CONTENT, 1500, 'QZONE_MAX_CONTENT 必须等于 schema 的 .max(1500)');
  eq(core.QZONE_MAX_IMAGES, 9, 'QZONE_MAX_IMAGES 必须等于 schema 的 .max(9)');
  truthy(/\.max\(1500\)/.test(mcpSource), 'schema 侧应仍是 .max(1500)');
  truthy(/\.max\(9\)/.test(mcpSource), 'schema 侧应仍是 .max(9)');
});

// ── 汇总 ─────────────────────────────────────────────────────────────────
const failed = results.filter((row) => !row.ok);
const total = results.length;
console.log('');
if (failed.length > 0) {
  console.log(`qq-qzone: ${total - failed.length}/${total} checks passed, ${failed.length} failed:`);
  for (const row of failed) console.log(`  - ${row.label}`);
  process.exit(1);
}
console.log(`ok - qq-qzone: ${total}/${total} checks passed (core pure functions + plugin package shape)`);
