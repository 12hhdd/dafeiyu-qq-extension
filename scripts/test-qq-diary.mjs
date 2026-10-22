/**
 * 日记插件行为测试（纯 Node、不联网）。
 *
 * **绝不碰用户的真实 D:\日记**：所有涉及磁盘的断言都显式传临时目录 / 临时文件路径
 * （diary-core 的每个函数都能注入 dir / file，这正是当初抽内核的理由之一），
 * 临时目录建在 os.tmpdir() 下，跑完即删。
 *
 * 覆盖：
 *   ① 插件包形态契约（package.json 必填字段、version 与根包一致、patch 的 id/name 死契约、
 *      lib/index.js 可 import 且导出期望符号）
 *   ② cleanDiaryItems 的 L1 永久 / L2 10 天 / L3 3 天分级保留
 *   ③ diaryDateStr / diaryPaths 的日期与路径拼装
 *   ④ parseDiaryOutput 的容错解析（正常 / 缺字段 / 多余文本 / 不是 JSON）
 *   ⑤ buildDiaryPrompt 含必要片段
 *   ⑥ diary-core 无 import 期副作用（fs 调用只出现在函数体内）
 *   ⑦ MCP 侧（src/mcp-snowluma-safe.js）的日记路径硬编码不得扩大、工具名不得少
 *      ——那是本次**没能**一起修的已知漂移，只能钉住上界，等它改成 import diary-core
 */
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PLUGIN_DIR = path.join(ROOT, 'plugins', 'qq-diary');
const NS = 'qq-diary';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-diary-test-'));
after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

// 显式把默认目录常量指到临时目录，确保任何「忘了传参」的调用也打不到真实数据。
process.env.QQ_BRIDGE_DIARY_DIR = path.join(TMP, 'diary-default');

const core = await import(pathToFileURL(path.join(ROOT, 'src', 'diary-core.js')).href);
const plugin = await import(pathToFileURL(path.join(PLUGIN_DIR, 'lib', 'index.js')).href);
const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const pluginPkg = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'package.json'), 'utf8'));
const patchText = fs.readFileSync(path.join(PLUGIN_DIR, 'cordis.patch.yml'), 'utf8');
const pluginSource = fs.readFileSync(path.join(PLUGIN_DIR, 'lib', 'index.js'), 'utf8');
const coreSource = fs.readFileSync(path.join(ROOT, 'src', 'diary-core.js'), 'utf8');

let passed = 0;
let failed = 0;
function check(name, fn) {
  test(name, async () => {
    try {
      await fn();
      passed++;
      console.log(`ok - ${name}`);
    } catch (error) {
      failed++;
      throw error;
    }
  });
}

const DAY = 86400000;
const now = Date.now();
function tmpDir(name) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ── ① 插件包形态 ────────────────────────────────────────────────────────────
check('package.json 必填字段齐全', () => {
  assert.equal(pluginPkg.name, NS);
  assert.equal(pluginPkg.type, 'module');
  assert.equal(pluginPkg.main, './lib/index.js');
  assert.equal(pluginPkg.license, 'MIT');
  assert.ok(pluginPkg.description && pluginPkg.description.length > 5);
});

check('插件 version 与根 package.json 一致', () => {
  // 根包 version 被 scripts/verify-dsh-020-adaptation.mjs 断言；子包必须跟着走，
  // 否则 bundle 版本校验会挂。
  assert.equal(rootPkg.version, '0.2.0-r3');
  assert.equal(pluginPkg.version, rootPkg.version);
});

check('dsh.bundle.patch 指向存在的 patch 文件 + schemastery 依赖', () => {
  assert.equal(pluginPkg.dsh?.bundle?.patch, './cordis.patch.yml');
  assert.ok(fs.existsSync(path.join(PLUGIN_DIR, 'cordis.patch.yml')));
  assert.equal(pluginPkg.dependencies?.['@deepseek-ai/schemastery'], '^3.18.1');
});

check('cordis.patch.yml 的 id === settings 命名空间，name === 包名', () => {
  // 死契约：0.2.0 的命名空间从 loader entry id 推导，id 写错设置面板里就找不到。
  // 注意：`id` 是列表项（有 `- `），`name` 是同一项的兄弟字段（无 `- `）。
  const ids = [...patchText.matchAll(/^\s*-\s*id:\s*(\S+)\s*$/gm)].map((m) => m[1]);
  const names = [...patchText.matchAll(/^\s*name:\s*(\S+)\s*$/gm)].map((m) => m[1]);
  assert.deepEqual(ids, [NS], `patch 里应恰有 id: ${NS}，实际 ${JSON.stringify(ids)}`);
  assert.deepEqual(names, [pluginPkg.name], `patch 里应恰有 name: ${pluginPkg.name}，实际 ${JSON.stringify(names)}`);
  assert.match(patchText, /^\s*-\s*insert:/m, '顶层必须是 insert 列表');
});

check('lib/index.js 导出 name/inject/Config/apply 与命名空间常量', () => {
  assert.equal(plugin.name, NS);
  assert.deepEqual(plugin.inject, ['settings']);
  assert.equal(plugin.DIARY_NAMESPACE, NS);
  assert.equal(typeof plugin.Config, 'function');
  assert.equal(typeof plugin.apply, 'function');
});

check('Config 默认值正确且至少一个 volatile 字段', () => {
  const defaults = plugin.Config({});
  assert.equal(defaults.enabled, true);
  assert.equal(defaults.workspaceTitle, '她的日记');
  assert.equal(defaults.timeOfDay, '23:30');
  assert.equal(defaults.dir, '');
  const refs = plugin.Config.toJSON().refs ?? {};
  const volatile = Object.values(refs).filter((r) => r?.meta?.volatile).map((r) => r.name ?? r.key);
  assert.ok(volatile.length > 0, `至少要有一个 volatile 字段，实际 ${JSON.stringify(Object.keys(refs))}`);
});

check('插件不用 .volatile()（schemastery ^3.18.1 没这个方法）也不调已删除的 settings.register', () => {
  const code = pluginSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
  assert.ok(!/\.volatile\s*\(/.test(code), '应使用 .extra("volatile", true)');
  assert.ok(!/settings\s*\.\s*register\s*\(/.test(code), '0.2.0 已删除 ctx.settings.register()');
});

check('插件真身：再导出的常量/函数与 diary-core 同源', () => {
  assert.equal(plugin.DIARY_DIR, core.DIARY_DIR);
  assert.equal(plugin.MEMORY_FILE, core.MEMORY_FILE);
  assert.equal(plugin.DIARY_ITEMS_FILE, core.DIARY_ITEMS_FILE);
  assert.deepEqual({ ...plugin.DIARY_RETENTION }, { ...core.DIARY_RETENTION });
  assert.equal(typeof plugin.cleanDiaryItems, 'function');
  assert.equal(typeof plugin.parseDiaryOutput, 'function');
});

check('apply() 在 0.2.0 下是空操作，不抛错', () => {
  assert.doesNotThrow(() => plugin.apply({}));
  assert.doesNotThrow(() => plugin.apply({ settings: {} }));
});

// ── ⑥ 内核无 import 期副作用 ────────────────────────────────────────────────
check('diary-core 的 fs 调用只出现在函数体内（import 时不碰磁盘）', () => {
  const code = coreSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
  assert.ok(!/\bchild_process\b/.test(code), '内核不该起子进程');
  assert.ok(!/^\s*await\s/m.test(code), '内核不该有顶层 await');
  let depth = 0;
  for (const line of code.split(/\r?\n/)) {
    if (/\bfs\s*\./.test(line)) {
      assert.ok(depth > 0, `顶层出现了 fs 调用（import 期就会碰磁盘）：${line.trim()}`);
    }
    depth += (line.match(/\{/g) ?? []).length;
    depth -= (line.match(/\}/g) ?? []).length;
  }
});

check('DIARY_DIR：默认 D:\\日记，且只能有一份定义（bridge.js 不再重复字面量）', () => {
  // 测试进程里设了 QQ_BRIDGE_DIARY_DIR，所以这里断言「覆盖点生效」；
  // 默认值本身断言在源码里：唯一一份 `path.join('D:', '日记')` 在 diary-core.js。
  assert.equal(core.DIARY_DIR, process.env.QQ_BRIDGE_DIARY_DIR);
  assert.ok(coreSource.includes("path.join('D:', '日记')"), 'diary-core 应保留默认 D:\\日记');
  assert.ok(coreSource.includes('QQ_BRIDGE_DIARY_DIR'), 'diary-core 应提供环境变量覆盖点');
  assert.equal(core.MEMORY_FILE, path.join(core.DIARY_DIR, 'memory.md'));
  assert.equal(core.DIARY_ITEMS_FILE, path.join(core.DIARY_DIR, 'items.jsonl'));

  // 已知缺陷的回归钉子：日记目录常量曾经在 bridge.js 和 mcp-snowluma-safe.js 各写一遍，
  // 漂移后会出现「日记写这里、记忆读那里」。bridge.js 必须改为从 diary-core import。
  const bridgeSource = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  assert.ok(
    !/=\s*path\.join\(\s*['"]D:['"]\s*,\s*['"]日记['"]/.test(bridgeSource),
    'src/bridge.js 不该再硬编码日记目录，应从 diary-core.js 取'
  );
  assert.ok(/diaryCore\.DIARY_DIR/.test(bridgeSource), 'src/bridge.js 应从 diaryCore 取 DIARY_DIR');
});

check('mcp-snowluma-safe.js 的 diary 路径与 core 常量同源', () => {
  // 历史缺陷：src/mcp-snowluma-safe.js 里四个 diary 工具曾各自硬编码 'D:/日记/…'
  // （qq_read_memory / qq_append_memory / qq_read_diary / qq_read_chat_log），与
  // bridge.js 的 DIARY_DIR 是两份独立常量。用户一旦换盘/改名，就会出现
  // 「桥接往新目录写、模型从旧目录读」，而 QQ 侧没有任何回执 —— 静默失忆。
  // 现在两侧都从 src/diary-core.js 取，所以这里钉死：字面量必须为 0 处。
  const mcpSource = fs.readFileSync(path.join(ROOT, 'src', 'mcp-snowluma-safe.js'), 'utf8');
  const sites = [...mcpSource.matchAll(/['"`](D:[\\/]日记[\\/])/g)].map((m) => m[1]);
  assert.equal(sites.length, 0, `mcp-snowluma-safe.js 仍有 ${sites.length} 处硬编码日记路径，应 import diary-core`);
  assert.ok(
    /import \{[^}]*DIARY_DIR[^}]*\} from '\.\/diary-core\.js';/.test(mcpSource),
    'mcp-snowluma-safe.js 应从 diary-core.js 取 DIARY_DIR'
  );
  // 模型可见的工具名一个都不能少：缺了工具模型就再也读不到日记。
  for (const tool of ['qq_read_memory', 'qq_append_memory', 'qq_read_diary', 'qq_read_chat_log']) {
    assert.ok(mcpSource.includes(`'${tool}'`), `MCP 侧缺少日记/记忆工具：${tool}`);
  }
  // 对话记录归档目录也挂在日记根下，必须同源。
  const chatLogSource = fs.readFileSync(path.join(ROOT, 'src', 'chat-log.js'), 'utf8');
  assert.ok(/import \{ DIARY_DIR \} from '\.\/diary-core\.js';/.test(chatLogSource), 'chat-log.js 应从 diary-core.js 取 DIARY_DIR');
  assert.ok(!/dir:\s*'D:\\\\日记/.test(chatLogSource), 'chat-log.js 的默认 dir 不该再写死盘符字面量');
});

// ── ③ 日期与路径 ────────────────────────────────────────────────────────────
check('diaryDateStr 按本地日期补零', () => {
  assert.equal(core.diaryDateStr(new Date(2026, 0, 5, 8, 30).getTime()), '2026-01-05');
  assert.equal(core.diaryDateStr(new Date(2026, 11, 31, 23, 59).getTime()), '2026-12-31');
  assert.match(core.diaryDateStr(), /^\d{4}-\d{2}-\d{2}$/);
});

check('diaryPaths 拼出 dir/diaryDir/diaryFile', () => {
  const dir = tmpDir('paths');
  const p = core.diaryPaths('2026-10-22', dir);
  assert.equal(p.dir, dir);
  assert.equal(p.diaryDir, dir);
  assert.equal(p.diaryFile, path.join(dir, '2026-10-22.md'));
  // 默认目录就是常数本身，不是另写的字面量
  assert.equal(core.diaryPaths('2026-10-22').diaryFile, path.join(core.DIARY_DIR, '2026-10-22.md'));
  assert.equal(core.diarySessionFile('C:\\x\\state'), path.join('C:\\x\\state', 'diary-session.json'));
});

check('diaryCfg 合并顺序：默认值 ← overrides', () => {
  const c = core.diaryCfg({ time: '22:00', maxL3Days: 5 });
  assert.equal(c.enabled, true);
  assert.equal(c.preset, 'qq-chat-v2');
  assert.equal(c.workspaceTitle, '她的日记');
  assert.equal(c.time, '22:00');
  assert.equal(c.maxL3Days, 5);
  assert.equal(c.maxL2Days, 10);
  assert.equal(core.diaryCfg().lookbackDays, 7);
});

// ── ② 分级保留 ──────────────────────────────────────────────────────────────
check('cleanDiaryItems：L1 永久，L2 超 10 天删，L3 超 3 天删', () => {
  const items = [
    { id: 'l1-old', level: 1, text: 'L1 老事项', createdAt: now - 900 * DAY },
    { id: 'l1-today', level: 1, text: 'L1 新事项', createdAt: now - 1 * DAY },
    { id: 'l2-old', level: 2, text: 'L2 过期', createdAt: now - 11 * DAY },
    { id: 'l2-ok', level: 2, text: 'L2 还在期', createdAt: now - 9 * DAY },
    { id: 'l3-old', level: 3, text: 'L3 过期', createdAt: now - 4 * DAY },
    { id: 'l3-ok', level: 3, text: 'L3 还在期', createdAt: now - 2 * DAY }
  ];
  const { kept, removed } = core.cleanDiaryItems(items);
  const keptIds = kept.map((it) => it.id).sort();
  assert.deepEqual(keptIds, ['l1-old', 'l1-today', 'l2-ok', 'l3-ok']);
  const removedIds = removed.map((it) => it.id).sort();
  assert.deepEqual(removedIds, ['l2-old', 'l3-old']);
  assert.equal(removed.find((it) => it.id === 'l2-old').removedBecause, 'L2 超过 10 天');
  assert.equal(removed.find((it) => it.id === 'l3-old').removedBecause, 'L3 超过 3 天');
  // 每项都补上归一后的 level
  assert.ok(kept.every((it) => it.level === 1 || it.level === 2 || it.level === 3));
});

check('cleanDiaryItems：级别归一（缺失/字符串/0 → L1? 不，→ L3）与 created 回退', () => {
  const items = [
    { id: 'no-level', text: '没有 level', createdAt: now - 1 * DAY },
    { id: 'str-level', level: '2', text: '字符串 level', createdAt: now - 1 * DAY },
    { id: 'zero-level', level: 0, text: 'level 0', createdAt: now - 1 * DAY },
    { id: 'by-created', level: 3, text: '只给了 created 日期', created: '2026-01-01' },
    { id: 'no-date', level: 3, text: '没有任何日期' }
  ];
  const { kept, removed } = core.cleanDiaryItems(items);
  const byId = new Map([...kept, ...removed].map((it) => [it.id, it]));
  assert.equal(byId.get('no-level').level, 3);
  assert.equal(byId.get('str-level').level, 2); // '2' 能被 Number() 认出来
  assert.equal(byId.get('zero-level').level, 3);
  assert.ok(removed.some((it) => it.id === 'by-created'), 'created 日期很老 → L3 过期');
  assert.ok(kept.some((it) => it.id === 'no-date'), '没有日期时按「刚创建」处理，不删');
});

check('cleanDiaryItems：maxL2Days/maxL3Days 可调，下限 1', () => {
  const conf = core.diaryCfg({ maxL2Days: 0, maxL3Days: 0 });
  const items = [
    { id: 'l2', level: 2, text: 'L2', createdAt: now - 1.5 * DAY },
    { id: 'l3', level: 3, text: 'L3', createdAt: now - 1.5 * DAY }
  ];
  const { kept } = core.cleanDiaryItems(items, conf);
  // 下限被抬到 1 天；1.5 天 > 1 天 → 两条都被清掉
  assert.deepEqual(kept, []);
  const lenient = core.cleanDiaryItems(items, core.diaryCfg({ maxL2Days: 30, maxL3Days: 30 }));
  assert.equal(lenient.kept.length, 2);
});

check('items.jsonl 读写：往返一致，坏行跳过，先写 tmp 再 rename', () => {
  const dir = tmpDir('items');
  const file = path.join(dir, 'items.jsonl');
  assert.deepEqual(core.readDiaryItems(file), [], '文件不存在时返回空数组');
  core.writeDiaryItems([{ id: 'a', level: 1, text: '甲' }, { id: 'b', level: 2, text: '乙' }], file);
  assert.deepEqual(core.readDiaryItems(file).map((it) => it.id), ['a', 'b']);
  assert.ok(!fs.existsSync(file + '.tmp'), '写完不该留下 .tmp');
  // 手插一行坏 JSON + 一行空行，不能把整份清单搞丢
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8') + '{坏掉的\n\n', 'utf8');
  assert.deepEqual(core.readDiaryItems(file).map((it) => it.id), ['a', 'b']);
  // 空清单
  core.writeDiaryItems([], file);
  assert.equal(fs.readFileSync(file, 'utf8'), '');
});

// ── ④ 输出解析容错 ──────────────────────────────────────────────────────────
check('parseDiaryOutput：正常输出（正文 + 末尾 json 块）', () => {
  const text = '今天和阿岚聊了很久，她说想去看海。\n\n```json\n[{"level":1,"text":"陪阿岚查海边民宿","due":"2026-10-30"},{"level":2,"text":"回一下群消息"}]\n```';
  const { diary, items } = core.parseDiaryOutput(text);
  assert.equal(diary, '今天和阿岚聊了很久，她说想去看海。');
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], { level: 1, text: '陪阿岚查海边民宿', due: '2026-10-30' });
  assert.deepEqual(items[1], { level: 2, text: '回一下群消息', due: null });
});

check('parseDiaryOutput：缺字段 / 空 text 被过滤，level 归一，due 截断', () => {
  const text = '正文。\n```json\n[{"text":"  有事的  ","level":2},{"level":1},{"text":""},{"text":"很长很长","due":"' + 'x'.repeat(80) + '"}]\n```';
  const { items } = core.parseDiaryOutput(text);
  assert.equal(items.length, 2, '缺 text / 空 text 的条目要丢掉');
  assert.deepEqual(items[0], { level: 2, text: '有事的', due: null });
  assert.equal(items[1].level, 3, 'level 缺失 → L3');
  assert.equal(items[1].due.length, 32, 'due 截到 32 字符');
});

check('parseDiaryOutput：多余文本（代码块不在末尾）整段当日记，不吞正文', () => {
  const text = '正文第一段。\n\n```json\n[{"level":1,"text":"x"}]\n```\n\n后面还有话，不该被当成 json 段。';
  const { diary, items } = core.parseDiaryOutput(text);
  assert.equal(items.length, 0);
  assert.equal(diary, text.trim());
});

check('parseDiaryOutput：非 JSON / 非数组 / 空输入都不炸', () => {
  const broken = '正文。\n```json\n{不是数组\n```';
  const r1 = core.parseDiaryOutput(broken);
  assert.equal(r1.items.length, 0);
  assert.equal(r1.diary, broken.trim());

  const obj = '正文。\n```json\n{"level":1}\n```';
  assert.equal(core.parseDiaryOutput(obj).items.length, 0, '顶层不是数组就不算事项');

  assert.deepEqual(core.parseDiaryOutput(''), { diary: '', items: [] });
  assert.deepEqual(core.parseDiaryOutput(null), { diary: '', items: [] });
  assert.deepEqual(core.parseDiaryOutput(undefined), { diary: '', items: [] });
});

check('parseDiaryOutput：日记为空但 json 块解析成功时回落到原文', () => {
  const text = '```json\n[{"level":1,"text":"只有事项"}]\n```';
  const { diary, items } = core.parseDiaryOutput(text);
  assert.equal(items.length, 1);
  assert.equal(diary.trim(), text.trim(), '正文空时不能返回空字符串');
});

check('buildDiaryFileBody：正文 + 「## 今天记下的事」段', () => {
  const noItems = core.buildDiaryFileBody('2026-10-22', { diary: '今天挺好。', items: [] });
  assert.equal(noItems, '# 2026-10-22 日记\n\n今天挺好。\n');
  const withItems = core.buildDiaryFileBody('2026-10-22', {
    diary: '今天挺好。',
    items: [{ level: 1, text: '记一笔', due: '2026-10-25' }, { level: 3, text: '小事', due: null }]
  });
  assert.match(withItems, /^# 2026-10-22 日记\n\n今天挺好。\n\n## 今天记下的事\n- \[L1\] 记一笔（截止 2026-10-25）\n- \[L3\] 小事\n$/);
});

// ── ⑤ 提示词 ────────────────────────────────────────────────────────────────
check('buildDiaryPrompt：含全部必要片段 + 安全不变量', () => {
  const dir = tmpDir('prompt-empty');
  const prompt = core.buildDiaryPrompt('2026-10-22', {
    dir,
    itemsFile: path.join(dir, 'items.jsonl'),
    memoryFile: path.join(dir, 'memory.md'),
    conversations: new Map()
  });
  const must = [
    '这是一个后台的私人任务：写今天的日记，并整理「事情清单」。',
    '不要调用任何 QQ 发送工具',            // 安全不变量：不许把日记发出去
    '今天是 2026-10-22',
    '【今天的聊天记录】今天没有可用的聊天记录。',
    '输出格式（两段）：',
    '[{"level":1,"text":"...","due":"YYYY-MM-DD 或 null"}]',
    'level 1 = 很重要，永久保留',
    '没有新事项就输出 []。'
  ];
  for (const s of must) assert.ok(prompt.includes(s), `提示词缺少片段：${s}`);
  assert.ok(!prompt.includes('【长期记忆】'), '没有记忆时不该有空的长期记忆段');
});

check('buildDiaryPrompt：注入聊天记录/记忆/事项/日记开头', () => {
  const dir = tmpDir('prompt-full');
  const memoryFile = path.join(dir, 'memory.md');
  const itemsFile = path.join(dir, 'items.jsonl');
  fs.writeFileSync(memoryFile, '## 锚点\n- 主人喜欢少女感音色\n\n## 别的段\n不该被注入\n', 'utf8');
  fs.writeFileSync(itemsFile, JSON.stringify({ id: 'it-1', level: 1, text: '给他带咖啡', due: null, created: '2026-10-20' }) + '\n', 'utf8');
  // 前一天的日记（用同一套日期算法算文件名，别写死）
  const yesterday = new Date(now - DAY);
  const yStr = core.diaryDateStr(yesterday.getTime());
  fs.writeFileSync(path.join(dir, `${yStr}.md`), `# ${yStr} 日记\n\n昨天聊到海边。\n\n## 今天记下的事\n- [L1] 旧事\n`, 'utf8');
  const conversations = new Map([
    ['group:456', {
      recentMessages: [
        { time: now - 60_000, sender: '阿岚', text: '周末去看海吗' },
        { time: now - 30_000, isSelf: true, text: '好啊', text2: '' },
        { time: now - 10_000, sender: '阿岚', text: '[图片]' }
      ],
      activeTopics: [{ content: '周末出行' }],
      memberImpressions: ['阿岚：喜欢海'],
      pendingThoughts: [{ content: '还没回她具体时间' }]
    }]
  ]);
  const prompt = core.buildDiaryPrompt('2026-10-22', { dir, itemsFile, memoryFile, conversations });
  for (const s of [
    '【长期记忆】',
    '## 锚点',
    '主人喜欢少女感音色',
    '## 最近记录（来自日记）',
    '昨天聊到海边',
    '【今天的聊天记录（私聊+群聊，时间顺序）】',
    '阿岚: 周末去看海吗',
    '你: 好啊',
    '【你现有的记忆】',
    'group:456 话题：周末出行',
    'group:456 印象：阿岚：喜欢海',
    'group:456 想说没说的：还没回她具体时间',
    '【现有事项清单（L1 永久 / L2 十天后清理 / L3 三天后清理）】',
    'L1 给他带咖啡',
    '已有的事项不要重复添加。',
    '【最近几天的日记开头】'
  ]) assert.ok(prompt.includes(s), `提示词缺少片段：${s}`);
  assert.ok(!prompt.includes('[图片]'), '图片占位消息不该进聊天记录');
  // memory.md 里非「锚点」的段落不注入
  assert.ok(!prompt.includes('不该被注入'));
});

check('buildMemoryBlock：锚点 + 最近摘录，超长折叠', () => {
  const dir = tmpDir('mem');
  const memoryFile = path.join(dir, 'memory.md');
  assert.equal(core.buildMemoryBlock(1600, { memoryFile, dir }), '', '文件不存在时返回空串');
  fs.writeFileSync(memoryFile, '## 锚点\n- 记住我\n', 'utf8');
  const block = core.buildMemoryBlock(1600, { memoryFile, dir });
  assert.ok(block.includes('## 锚点') && block.includes('记住我'));
  const tiny = core.buildMemoryBlock(8, { memoryFile, dir });
  assert.ok(tiny.endsWith('\n（更早记忆已折叠）'));
  assert.ok(tiny.length < block.length + 20);
});

check('recentDiaryBriefs / recentDiaryExcerpts 只读 .md 日记文件', () => {
  const dir = tmpDir('briefs');
  const today = core.diaryDateStr();
  fs.writeFileSync(path.join(dir, '2026-01-01.md'), '# 2026-01-01 日记\n\n新年的第一天。\n', 'utf8');
  fs.writeFileSync(path.join(dir, '2026-01-02.md'), '# 2026-01-02 日记\n\n第二天。\n', 'utf8');
  fs.writeFileSync(path.join(dir, `${today}.md`), '# 今天\n\n今天还没结束。\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'notes.txt'), '不该被读到', 'utf8');
  const briefs = core.recentDiaryBriefs(core.diaryCfg({ lookbackDays: 7 }), dir);
  assert.ok(briefs.length >= 2);
  assert.ok(!briefs.some((b) => b.startsWith(`${today}:`)), '今天的日记不算「前几天」');
  assert.ok(!briefs.some((b) => b.includes('不该被读到')));
  assert.ok(briefs.every((b) => /^\d{4}-\d{2}-\d{2}: /.test(b)));
  const limited = core.recentDiaryBriefs(core.diaryCfg({ lookbackDays: 1 }), dir);
  assert.equal(limited.length, 1, 'lookbackDays 生效');
});

// ── 汇总 ────────────────────────────────────────────────────────────────────
test('summary', () => {
  const total = passed + failed;
  assert.equal(failed, 0, `有 ${failed} 项检查失败`);
  console.log(`\nok - ${passed}/${total} checks passed (qq-diary)`);
});
