/**
 * 日记内核（纯函数）——从 src/bridge.js 抽出，行为与原实现逐字等价。
 *
 * 为什么单独一个模块：日记里「路径怎么拼、日期怎么算、事项怎么按级别保留、
 * 记忆块和提示词怎么拼、模型输出怎么解析」这些全是纯逻辑，可以脱离 DSH 单测；
 * 而「建 workspace、开会话、等模型回合、写 state/」那半属于宿主，留在 bridge.js。
 *
 * 硬约束（改这个文件前先读一遍）：
 *   1. 无副作用：import 时不读写磁盘、不建目录、不启动任何服务、不打日志。
 *      只有真正调用函数时才碰 fs。
 *   2. 不反向依赖 bridge.js：需要 DIARY_DIR / STATE_DIR / socialV2 / cfg 的地方
 *      一律由调用方通过参数注入（每个参数的默认值与 bridge.js 里的旧实现一致）。
 *   3. 行为等价优先：这里的分级保留规则（L1 永久 / L2 10 天 / L3 3 天）和
 *      parseDiaryOutput 的容错解析都是用户 2026-10-19 定下的规则，不要「顺手优化」。
 */
import fs from 'node:fs';
import path from 'node:path';

// ── 常量 ────────────────────────────────────────────────────────────────────
// 日记/记忆目录：所有日记正文、长期记忆、分级事项都放在同一个目录里。
// 这是全仓唯一一份定义（旧实现 src/bridge.js 里还写过一次，导致两处可能漂移）。
// 覆盖点：环境变量 QQ_BRIDGE_DIARY_DIR（测试用临时目录时用它，别指向真实数据）。
export const DIARY_DIR = process.env.QQ_BRIDGE_DIARY_DIR || path.join('D:', '日记');
export const MEMORY_FILE = path.join(DIARY_DIR, 'memory.md');
export const DIARY_ITEMS_FILE = path.join(DIARY_DIR, 'items.jsonl');

// 事项分级保留策略：L1 永不删除；L2 10 天后自动删；L3 3 天后自动删。
export const DIARY_RETENTION = Object.freeze({
  L1_DAYS: Infinity,
  L2_DAYS: 10,
  L3_DAYS: 3
});

// diaryCfg() 的默认值（原 bridge.js 里写死在函数体里的那份）。
export const DIARY_DEFAULTS = Object.freeze({
  enabled: true,
  time: '21:00',
  preset: 'qq-chat-v2',
  workspaceTitle: '她的日记',
  maxL2Days: DIARY_RETENTION.L2_DAYS,
  maxL3Days: DIARY_RETENTION.L3_DAYS,
  lookbackDays: 7
});

// config.json 的 diary 段合并进默认值。旧实现是 `{ 默认值..., ...(cfg.diary ?? {}) }`。
export function diaryCfg(overrides = {}) {
  return { ...DIARY_DEFAULTS, ...(overrides ?? {}) };
}

// ── 日期与路径 ──────────────────────────────────────────────────────────────
export function diaryDateStr(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function diaryPaths(dateStr, dir = DIARY_DIR) {
  return { dir, diaryDir: dir, diaryFile: path.join(dir, `${dateStr}.md`) };
}

// 日记会话记录属于宿主状态（state/diary-session.json），这里只提供拼路径的纯函数，
// 由 bridge.js 传入自己的 STATE_DIR。
export function diarySessionFile(stateDir) {
  return path.join(stateDir, 'diary-session.json');
}

// ── 分级事项读写 ────────────────────────────────────────────────────────────
// items.jsonl：一行一条 JSON。坏行直接跳过，不能因为一行坏了就丢掉整个清单。
export function readDiaryItems(file = DIARY_ITEMS_FILE) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const out = [];
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try { const it = JSON.parse(t); if (it && typeof it === 'object') out.push(it); } catch {}
    }
    return out;
  } catch { return []; }
}

// 先写 .tmp 再 rename：中途崩溃不会留下半截 items.jsonl。
export function writeDiaryItems(items, file = DIARY_ITEMS_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, items.map((it) => JSON.stringify(it)).join('\n') + (items.length ? '\n' : ''), 'utf8');
  fs.renameSync(tmp, file);
}

// 分级保留：L1 永久、L2 超 maxL2Days 删、L3 超 maxL3Days 删。
// 级别只认 1/2，其它值（含缺失、"2"、0）一律归一成 3 —— 与原实现一致。
export function cleanDiaryItems(items, conf = diaryCfg()) {
  const now = Date.now();
  const maxL2 = Math.max(1, Number(conf.maxL2Days ?? DIARY_RETENTION.L2_DAYS));
  const maxL3 = Math.max(1, Number(conf.maxL3Days ?? DIARY_RETENTION.L3_DAYS));
  const kept = [];
  const removed = [];
  for (const it of items) {
    const level = Number(it.level) === 1 ? 1 : (Number(it.level) === 2 ? 2 : 3);
    const created = Number(it.createdAt) || Date.parse(it.created || '') || now;
    const ageDays = (now - created) / 86400000;
    if (level === 3 && ageDays > maxL3) { removed.push({ ...it, level, removedBecause: `L3 超过 ${maxL3} 天` }); continue; }
    if (level === 2 && ageDays > maxL2) { removed.push({ ...it, level, removedBecause: `L2 超过 ${maxL2} 天` }); continue; }
    kept.push({ ...it, level });
  }
  return { kept, removed };
}

// ── 记忆块 ──────────────────────────────────────────────────────────────────
// 最近几篇日记的开头（跳过今天，今天还没写完），给提示词做「前几天写了什么」的锚。
export function recentDiaryBriefs(conf = diaryCfg(), dir = DIARY_DIR) {
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort().reverse(); } catch {}
  const today = diaryDateStr();
  const out = [];
  for (const f of files) {
    if (f === `${today}.md`) continue;
    try {
      const txt = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\s+/g, ' ').trim();
      out.push(`${f.replace('.md', '')}: ${txt.slice(0, 140)}`);
    } catch {}
    if (out.length >= Math.max(1, Number(conf.lookbackDays ?? 7))) break;
  }
  return out;
}

// memory.md 原文；读不到就当空（第一次跑的时候文件还不存在，属正常）。
export function readLongMemory(file = MEMORY_FILE) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

// 最近 N 天日记正文摘录：去掉标题行和末尾「## 今天记下的事」段，只留正文。
export function recentDiaryExcerpts(days = 7, perDayChars = 200, dir = DIARY_DIR) {
  const out = [];
  const now = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(now.getTime() - i * 86400_000);
    const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    try {
      const body = fs.readFileSync(path.join(dir, `${ds}.md`), 'utf8');
      let text = body.replace(/^#\s*.*$/m, '').split(/\n##\s/)[0].trim();
      text = text.replace(/\s+/g, ' ').slice(0, perDayChars);
      if (text) out.push(`${ds}：${text}`);
    } catch {}
  }
  return out.length ? out.join('\n') : '';
}

// 注入系统提示的「长期记忆」块 = 锚点段 + 最近 7 天日记摘录，超长折叠。
export function buildMemoryBlock(maxChars = 1600, opts = {}) {
  const memoryFile = opts.memoryFile ?? MEMORY_FILE;
  const dir = opts.dir ?? DIARY_DIR;
  const raw = readLongMemory(memoryFile).trim();
  const anchor = (raw.match(/##\s*锚点[\s\S]*?(?=\n##\s|$)/) || [''])[0].trim();
  let block = anchor || '';
  const recent = recentDiaryExcerpts(7, 200, dir);
  if (recent) {
    block = (block ? block + '\n\n' : '') + '## 最近记录（来自日记）\n' + recent;
  }
  if (block.length > maxChars) block = block.slice(0, maxChars) + '\n（更早记忆已折叠）';
  return block;
}

// ── 提示词拼装 ──────────────────────────────────────────────────────────────
// 今天的聊天记录（私聊+群聊，时间顺序）。图片/表情/语音等占位消息不算聊天内容。
export function collectDiaryMessages(limit = 80, conversations = new Map()) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const startTs = start.getTime();
  const out = [];
  for (const [key, st] of conversations) {
    const arr = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
    const list = [];
    for (const m of arr) {
      const ts = Number(m?.time) || 0;
      if (ts < startTs) continue;
      const raw = String(m?.text ?? '').replace(/\s+/g, ' ').trim();
      if (!raw) continue;
      if (/^\[(图片|表情|语音|转发|文件|视频)/.test(raw)) continue;
      list.push({ ts, who: m?.isSelf ? '你' : String(m?.sender ?? '群友'), text: raw.slice(0, 100), key, tag: String(key).startsWith('group:') ? '群' : '私' });
    }
    list.sort((a, b) => a.ts - b.ts);
    out.push(...list.slice(-limit));
  }
  out.sort((a, b) => a.ts - b.ts);
  return out.slice(-limit * 2);
}

// 后台写日记的提示词。注意里面那几行「不要调用任何 QQ 发送工具」「不要编造」
// 是安全不变量，改动前先确认意图，别当成普通文案。
export function buildDiaryPrompt(today, opts = {}) {
  const conf = opts.conf ?? diaryCfg();
  const dir = opts.dir ?? DIARY_DIR;
  const itemsFile = opts.itemsFile ?? DIARY_ITEMS_FILE;
  const memoryFile = opts.memoryFile ?? MEMORY_FILE;
  const conversations = opts.conversations ?? new Map();
  const msgs = collectDiaryMessages(80, conversations);
  const items = cleanDiaryItems(readDiaryItems(itemsFile), conf).kept;
  const briefs = recentDiaryBriefs(conf, dir);
  const lines = [];
  const memBlock = buildMemoryBlock(1200, { memoryFile, dir });
  if (memBlock) { lines.push('【长期记忆】'); lines.push(memBlock); lines.push(''); }
  lines.push('这是一个后台的私人任务：写今天的日记，并整理「事情清单」。');
  lines.push('这不是聊天场景：不要调用任何 QQ 发送工具，不要把日记内容发到任何会话，只输出文本。');
  lines.push('只写聊天记录里真实出现的事；不确定的事不要写，也不要编造原因。不要写技术词（报错名、配置项、token、端口、代码名），用日常说法。');
  lines.push('事项清单只写你明确需要做或提醒自己的事，最多 3 条；due 用今天或之后的日期；拿不准的事标 level 3 或不写。');
  lines.push('不要在日记或事项里写「收不到消息」「连不上」「配置」「令牌」这类系统判断；这些交给管理员，不算你的生活。');
  lines.push(`今天是 ${today}。用你自己的第一人称、你自己的语气写，200~500 字；只写今天真实发生的事和真实感受，不要编造，不要堆技术细节。`);
  lines.push('');
  if (msgs.length) {
    lines.push('【今天的聊天记录（私聊+群聊，时间顺序）】');
    for (const m of msgs) {
      const t = new Date(m.ts);
      lines.push(`[${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}][${m.tag ?? '私'}] ${m.who}: ${m.text}`);
    }
    lines.push('');
  } else {
    lines.push('【今天的聊天记录】今天没有可用的聊天记录。');
    lines.push('');
  }
  const topics = [];
  for (const [key, st] of conversations) {
    const t = Array.isArray(st?.activeTopics) ? st.activeTopics : [];
    const imp = Array.isArray(st?.memberImpressions) ? st.memberImpressions : [];
    const pen = Array.isArray(st?.pendingThoughts) ? st.pendingThoughts : [];
    if (t.length) topics.push(`${key} 话题：${t.map((x) => (typeof x === 'string' ? x : x?.content ?? '')).filter(Boolean).slice(-5).join('；')}`);
    if (imp.length) topics.push(`${key} 印象：${imp.map((x) => (typeof x === 'string' ? x : x?.content ?? '')).filter(Boolean).slice(-5).join('；')}`);
    if (pen.length) topics.push(`${key} 想说没说的：${pen.map((x) => (typeof x === 'string' ? x : x?.content ?? '')).filter(Boolean).slice(-3).join('；')}`);
  }
  if (topics.length) { lines.push('【你现有的记忆】'); lines.push(...topics); lines.push(''); }
  if (items.length) {
    lines.push('【现有事项清单（L1 永久 / L2 十天后清理 / L3 三天后清理）】');
    for (const it of items) {
      const due = it.due ? `（截止 ${it.due}）` : '';
      lines.push(`- [${it.id}] L${it.level} ${it.text}${due}（记于 ${it.created ?? '?'}）`);
    }
    lines.push('已有的事项不要重复添加。');
    lines.push('');
  }
  if (briefs.length) { lines.push('【最近几天的日记开头】'); lines.push(...briefs); lines.push(''); }
  lines.push('输出格式（两段）：');
  lines.push('1) 日记正文：Markdown，第一人称，不要标题。');
  lines.push('2) 末尾单独一个 ```json 代码块，内容是今天新增或需要更新的事项数组：');
  lines.push('   [{"level":1,"text":"...","due":"YYYY-MM-DD 或 null"}]');
  lines.push('   分级规则：level 1 = 很重要，永久保留；level 2 = 不太重要但紧急、要尽快完成，10 天后自动删；level 3 = 不重要但值得记一笔，3 天后自动删。');
  lines.push('   没有新事项就输出 []。');
  return lines.join('\n');
}

// ── 模型输出解析 ────────────────────────────────────────────────────────────
// 只认**末尾**的 ```json 代码块；解析失败就整段当日记正文（宁可少记事项，不丢正文）。
export function parseDiaryOutput(text) {
  const raw = String(text ?? '').trim();
  let items = [];
  let diary = raw;
  const m = raw.match(/```(?:json)?\s*([\s\S]*?)```\s*$/);
  if (m) {
    try {
      const parsed = JSON.parse(m[1].trim());
      if (Array.isArray(parsed)) {
        items = parsed.filter((it) => it && typeof it.text === 'string' && it.text.trim()).map((it) => ({
          level: Number(it.level) === 1 ? 1 : (Number(it.level) === 2 ? 2 : 3),
          text: String(it.text).trim().slice(0, 200),
          due: typeof it.due === 'string' && it.due.trim() ? it.due.trim().slice(0, 32) : null
        }));
        diary = raw.slice(0, m.index).trim();
      }
    } catch {}
  }
  return { diary: diary.trim() || raw, items };
}

// runDiary 落盘的那行日记正文 + 事项段（纯拼装，写文件由宿主负责）。
export function buildDiaryFileBody(today, parsed) {
  const itemLines = parsed.items.map((it) => `- [L${it.level}] ${it.text}${it.due ? `（截止 ${it.due}）` : ''}`);
  const body = `${parsed.diary}\n${itemLines.length ? `\n## 今天记下的事\n${itemLines.join('\n')}\n` : ''}`;
  return `# ${today} 日记\n\n${body.trim()}\n`;
}
