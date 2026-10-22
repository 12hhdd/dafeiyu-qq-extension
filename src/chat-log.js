// 对话记录（chat-log）：把 QQ 私聊 / 群聊的**一天**消息精简成「一天一个文件」。
//
// 为什么要有这个：QQ 长聊会把 DSH 会话上下文越撑越长，真正省钱的办法是
//   「每天读一遍前一天的对话记录 → 重开会话」——
// 记忆靠锚点 + 日记，细节靠按天归档的对话记录，不必把整段对话一直留在上下文里。
//
// 落盘位置（D:\日记\对话记录）：
//   私聊\YYYY-MM-DD.md   —— 主人 ⇄ 大肥鱼 的私聊
//   群聊\YYYY-MM-DD.md   —— 群里的消息
// 两个频道分开存，和「私聊/群聊互相看不见」的设定一致。
//
// 本模块**只放纯函数**（不联网、不碰文件），网络与落盘在 src/bridge.js 的
// chatLog* 里，方便直接单测。精简规则移植自 scripts/archive-conversation.ps1
// （上一版手跑脚本），保持同样的删语气词 / 10 分钟一段 / 同人连发合并。

import path from 'node:path';
import { historyTimeToMs } from './backfill.js';
// 归档目录挂在日记根下面，所以根目录必须与日记同源 —— 否则用户改了
// QQ_BRIDGE_DIARY_DIR 之后，日记换地方了、对话记录还留在旧盘。
import { DIARY_DIR } from './diary-core.js';

/** 默认参数（config.json 的 chatLog 段可覆盖）。 */
export const CHAT_LOG_DEFAULTS = Object.freeze({
  enabled: true,
  dir: path.join(DIARY_DIR, '对话记录'),
  // 按天归档用的时区偏移（分钟）；+8 时区 = 480
  timeZoneOffsetMinutes: 480,
  // 每天几点生成「昨天」的归档 + 重置会话（本地时间 HH:MM）
  generateTime: '05:10',
  resetTime: '05:20',
  // 每段最多留几条最要紧的
  keepTopPrivate: 5,
  keepTopGroup: 3,
  // 拉多少条历史（OneBot 单次上限内）
  fetchCountPrivate: 150,
  fetchCountGroup: 200,
  // 同一段消息超过这么久就重开一段（分钟）
  segMinutes: 10,
  // 单行最多多少字
  maxLineChars: 160,
  // 注入上下文时的摘要上限
  injectDigest: true,
  injectMaxChars: 800,
  injectDigestLines: 6,
});

/** 两个频道。dirName 是归档子目录名。 */
export const CHAT_LOG_CHANNELS = Object.freeze({
  private: Object.freeze({ key: 'private', label: '私聊', dirName: '私聊' }),
  group: Object.freeze({ key: 'group', label: '群聊', dirName: '群聊' }),
});

/** 只发这些等于没说话，不进对话记录。 */
const NOISE_TEXTS = new Set([
  '？', '?', '！', '!', '嗯', '哦', '呃', '啊', '好', '行', '草', '6', '...', '。。。',
  '在', '到', '可以', '哈哈', '笑死', '确实', '是的', '对', '没事', '睡了', '好的',
]);

/** 命中就加权：这些词说明在聊具体的事，值得留。 */
const KEYWORD_RE = /动态|说说|空间|日记|记忆|锚点|表情包|接口|工具|手机|群|配置|bug|token|AI|鱼|收到|发|记|写|改|修|装|试|看|查|学|玩|断|挂|重启|报错|失败|成功|为什么|怎么|能不能|要不要/i;

/** 约游戏/催人这类口水话减权。 */
const PLAY_RE = /^(上号|打不打|来打|打nm|等|下了|睡了|在吗|人呢)/;

/** 纯 @ 串（只有 at 没有内容）不进记录。 */
const PURE_AT_RE = /^(@\S+\s*)+$/;

/** 「已停止」状态前缀（QQ 里点过停止生成会留下这种脏前缀）。 */
const STOPPED_PREFIX_RE = /^⏹️?\s*已停止[；;]\s*/u;

function pad2(n) {
  return String(n).padStart(2, '0');
}

function truncate(text, maxChars) {
  const s = String(text ?? '');
  const chars = Array.from(s);
  if (chars.length <= maxChars) return s;
  return chars.slice(0, Math.max(1, maxChars - 1)).join('') + '…';
}

/** 'HH:MM' → { h, m }，非法返回 null。 */
export function parseHm(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return { h, m: min };
}

/** 毫秒时间戳 → 目标时区下的 'YYYY-MM-DD'。 */
export function dateStrFromMs(ms, offsetMinutes = CHAT_LOG_DEFAULTS.timeZoneOffsetMinutes) {
  const d = new Date(Number(ms) + offsetMinutes * 60_000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** 'YYYY-MM-DD' 是否合法。 */
export function isValidDateStr(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** 某一天（目标时区）的 [起, 止) 毫秒窗口。 */
export function dayWindowMs(dateStr, offsetMinutes = CHAT_LOG_DEFAULTS.timeZoneOffsetMinutes) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr ?? ''));
  if (!m) return null;
  const startMs = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - offsetMinutes * 60_000;
  return { startMs, endMs: startMs + 86_400_000 };
}

/**
 * 统计某一天的**原始**消息条数（含被 normalizeMessages 丢掉的语气词/纯图），
 * 用于归档文件头的「原始：N 条」。normalizeMessages 之后条数会变少，不能用它计数。
 */
export function countMessagesInWindow(rawList, dateStr, offsetMinutes = CHAT_LOG_DEFAULTS.timeZoneOffsetMinutes) {
  const win = dayWindowMs(dateStr, offsetMinutes);
  if (!win || !Array.isArray(rawList)) return 0;
  const seen = new Set();
  let n = 0;
  for (const raw of rawList) {
    if (!raw || typeof raw !== 'object') continue;
    const timeMs = historyTimeToMs(raw.timeMs ?? raw.time ?? raw.timestamp);
    if (!timeMs || timeMs < win.startMs || timeMs >= win.endMs) continue;
    const mid = raw.messageId ?? raw.message_id ?? raw.msg_id;
    if (mid != null) {
      const key = String(mid);
      if (seen.has(key)) continue;
      seen.add(key);
    }
    n += 1;
  }
  return n;
}

/** 毫秒时间戳 → 目标时区的 'HH:mm'。 */
export function fmtHM(ms, offsetMinutes = CHAT_LOG_DEFAULTS.timeZoneOffsetMinutes) {
  const d = new Date(Number(ms) + offsetMinutes * 60_000);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

/** 目标时区下「dateStr 这一天的时间戳区间内的某个 HH:MM」→ 毫秒。 */
export function hmOnDateMs(dateStr, hm, offsetMinutes = CHAT_LOG_DEFAULTS.timeZoneOffsetMinutes) {
  const win = dayWindowMs(dateStr, offsetMinutes);
  const t = parseHm(hm);
  if (!win || !t) return null;
  return win.startMs + (t.h * 60 + t.m) * 60_000;
}

/** 归档文件的相对路径（按频道分目录）。 */
export function chatLogRelPath(channel, dateStr) {
  const ch = CHAT_LOG_CHANNELS[channel] || CHAT_LOG_CHANNELS.private;
  return `${ch.dirName}\\${dateStr}.md`;
}

/**
 * 把 QQ 消息段渲染成一行文字。
 * 图片/表情只计数（纯图连发才值得记一条），语音/视频/文件用占位符。
 *
 * @returns {{ text: string, media: number }}
 */
export function renderSegments(segments, opts = {}) {
  const { selfId = null, selfName = '大肥鱼' } = opts;
  let text = '';
  let media = 0;
  for (const seg of Array.isArray(segments) ? segments : []) {
    const type = String(seg?.type || '');
    const data = seg?.data || {};
    if (type === 'text') {
      text += String(data.text ?? '');
    } else if (type === 'at') {
      const qq = data.qq != null ? String(data.qq) : '';
      if (selfId != null && qq && qq === String(selfId)) text += `@${selfName}`;
      else if (data.name) text += `@${data.name}`;
      else if (qq) text += `@${qq}`;
    } else if (type === 'image' || type === 'mface' || type === 'face') {
      media += 1;
    } else if (type === 'record') {
      text += '[语音]';
    } else if (type === 'video') {
      text += '[视频]';
    } else if (type === 'file') {
      text += '[文件]';
    } else if (type === 'forward') {
      text += '[转发消息]';
    }
    // reply / json / xml 等：引用关系不抄，卡片内容没有可读文本就跳过
  }
  return { text: text.trim(), media };
}

/** 对方（非自己）在记录里的显示名。 */
function resolveWho(raw, kind, selfId, selfName) {
  const userId = raw?.user_id ?? raw?.sender?.user_id ?? null;
  if (selfId != null && userId != null && String(userId) === String(selfId)) return selfName;
  if (kind === 'group') {
    return String(raw?.sender?.card || raw?.sender?.nickname || userId || '群友');
  }
  return String(raw?.sender?.nickname || userId || '对方');
}

/**
 * 把 OneBot 历史（或 socialV2 的 recentMessages 转出来的同形对象）归一化成
 * 可渲染的记录项，并按天过滤。
 *
 * 形状兼容：raw.message 是段落数组 / 字符串都行，有 raw_message 兜底；
 * 已经归一化成 { sender, userId, text, timeMs } 的也可以（socialV2 那种）。
 *
 * @returns {Array<{timeMs:number, who:string, text:string, media:number, isSelf:boolean, messageId:string}>}
 */
export function normalizeMessages(rawList, opts = {}) {
  const {
    kind = 'private',
    selfId = null,
    selfName = '大肥鱼',
    offsetMinutes = CHAT_LOG_DEFAULTS.timeZoneOffsetMinutes,
    dateStr = '',
  } = opts;
  const win = dateStr ? dayWindowMs(dateStr, offsetMinutes) : null;
  const list = Array.isArray(rawList) ? rawList : [];
  const picked = [];
  const seenIds = new Set();

  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const timeMs = historyTimeToMs(raw.timeMs ?? raw.time ?? raw.timestamp);
    if (!timeMs) continue;
    if (win && (timeMs < win.startMs || timeMs >= win.endMs)) continue;
    const mid = raw.messageId ?? raw.message_id ?? raw.msg_id;
    const midKey = mid != null ? String(mid) : '';
    if (midKey) {
      if (seenIds.has(midKey)) continue;
      seenIds.add(midKey);
    }

    let segs = null;
    if (Array.isArray(raw.message)) segs = raw.message;
    const rendered = segs
      ? renderSegments(segs, { selfId, selfName })
      : { text: String(raw.text ?? raw.plain ?? raw.raw_message ?? '').trim(), media: 0 };
    const text = rendered.text.replace(STOPPED_PREFIX_RE, '').trim();
    const media = rendered.media;
    if (!text && media <= 0) continue;
    if (text && NOISE_TEXTS.has(text)) continue;
    if (text && PURE_AT_RE.test(text)) continue;

    picked.push({
      timeMs,
      who: raw.who || resolveWho(raw, kind, selfId, selfName),
      text,
      media,
      isSelf: raw.isSelf === true || (() => {
        const uid = raw.user_id ?? raw.sender?.user_id ?? raw.userId ?? null;
        return selfId != null && uid != null && String(uid) === String(selfId);
      })(),
      messageId: midKey,
    });
  }

  picked.sort((a, b) => (a.timeMs - b.timeMs) || String(a.messageId).localeCompare(String(b.messageId)));
  return collapseImageBursts(picked);
}

/**
 * 纯图片连发：同一人连续发的图，少于 3 张直接丢，>=3 张合并成一条。
 * 中间夹着有字的消息就断开。
 */
function collapseImageBursts(items) {
  const out = [];
  let i = 0;
  while (i < items.length) {
    const cur = items[i];
    if (cur.text || cur.media <= 0) {
      out.push(cur);
      i += 1;
      continue;
    }
    let j = i;
    let media = 0;
    while (j < items.length && !items[j].text && items[j].media > 0 && items[j].who === cur.who) {
      media += items[j].media;
      j += 1;
    }
    if (media >= 3) {
      out.push({ ...cur, text: `[连发图片 ${media} 张]`, media: 0 });
    }
    i = j;
  }
  return out;
}

/** 一条记录值不值得留（分数越高越要紧）。 */
export function scoreLine(item, opts = {}) {
  const { selfName = '大肥鱼' } = opts;
  const text = String(item?.text ?? '');
  const len = Array.from(text).length;
  let score = 0;
  if (item?.who === selfName) score += 2;
  if (len >= 15) score += 1;
  if (len >= 40) score += 1;
  if (KEYWORD_RE.test(text)) score += 2;
  if (len <= 6 && !KEYWORD_RE.test(text)) score -= 2;
  if (PLAY_RE.test(text)) score -= 2;
  return score;
}

/**
 * 把当天记录渲染成「每 segMinutes 分钟一段、段内只留最要紧几行」的正文。
 */
export function renderBlock(items, keepTop, opts = {}) {
  const {
    offsetMinutes = CHAT_LOG_DEFAULTS.timeZoneOffsetMinutes,
    segMinutes = CHAT_LOG_DEFAULTS.segMinutes,
    maxLineChars = CHAT_LOG_DEFAULTS.maxLineChars,
    selfName = '大肥鱼',
  } = opts;
  const segMs = Math.max(1, Number(segMinutes) || 10) * 60_000;
  const buckets = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const bucket = Math.floor((item.timeMs + offsetMinutes * 60_000) / segMs);
    if (!buckets.has(bucket)) buckets.set(bucket, []);
    buckets.get(bucket).push(item);
  }
  const keep = Math.max(1, Number(keepTop) || 3);
  const sections = [];
  for (const [, list] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    const scored = list.map((it) => ({ it, score: scoreLine(it, { selfName }) }));
    let top = scored.filter((s) => s.score >= 1).sort((a, b) => b.score - a.score).slice(0, keep);
    if (!top.length) top = scored.slice().sort((a, b) => b.score - a.score).slice(0, 1);
    top.sort((a, b) => a.it.timeMs - b.it.timeMs);

    const merged = [];
    for (const { it } of top) {
      const last = merged[merged.length - 1];
      if (last && last.who === it.who) {
        last.text = `${last.text}；${it.text}`.replace(/；$/u, '');
      } else {
        merged.push({ ...it });
      }
    }
    const body = merged
      .map((m) => `- ${m.who}：${truncate(m.text, maxLineChars)}`)
      .join('\n');
    const startMs = list[0].timeMs;
    const endMs = list[list.length - 1].timeMs;
    sections.push(`### ${fmtHM(startMs, offsetMinutes)}–${fmtHM(endMs, offsetMinutes)}\n\n${body}`);
  }
  return sections.join('\n\n');
}

/** 当天最要紧的几行（给人看，也给注入上下文用）。 */
export function renderDigest(items, opts = {}) {
  const {
    maxLines = CHAT_LOG_DEFAULTS.injectDigestLines,
    maxChars = 120,
    offsetMinutes = CHAT_LOG_DEFAULTS.timeZoneOffsetMinutes,
    selfName = '大肥鱼',
  } = opts;
  const limit = Math.max(1, Number(maxLines) || CHAT_LOG_DEFAULTS.injectDigestLines);
  const scored = (Array.isArray(items) ? items : [])
    .filter((it) => it.text)
    .map((it) => ({ it, score: scoreLine(it, { selfName }) }));
  scored.sort((a, b) => (b.score - a.score) || (b.it.timeMs - a.it.timeMs));
  const strong = scored.filter((s) => s.score >= 1);
  const pool = strong.length ? strong : scored.slice(0, Math.min(3, limit));
  // 摘要是给「接续对话」用的，不能全是我自己说的：对方的话至少占一半。
  const others = pool.filter((s) => s.it.who !== selfName);
  const selves = pool.filter((s) => s.it.who === selfName);
  const wantOthers = Math.min(others.length, Math.ceil(limit / 2));
  const picked = [...others.slice(0, wantOthers), ...selves.slice(0, limit - wantOthers)];
  for (const s of pool) {
    if (picked.length >= limit) break;
    if (!picked.includes(s)) picked.push(s);
  }
  picked.sort((a, b) => a.it.timeMs - b.it.timeMs);
  return picked
    .map(({ it }) => `- ${fmtHM(it.timeMs, offsetMinutes)} ${it.who}：${truncate(it.text, maxChars)}`)
    .join('\n');
}

/**
 * 生成一个频道的当天记录文件内容。
 *
 * @param {object} p
 * @param {string} p.dateStr
 * @param {'private'|'group'} p.channel
 * @param {string} [p.peerName]  对方昵称 / 群名，写进标题
 * @param {number} [p.rawCount]  当天原始消息条数
 * @param {Array}  p.items       normalizeMessages 的结果
 */
export function buildChannelDoc(p = {}) {
  const ch = CHAT_LOG_CHANNELS[p.channel] || CHAT_LOG_CHANNELS.private;
  const dateStr = String(p.dateStr || '');
  const peerName = p.peerName ? String(p.peerName) : '';
  const items = Array.isArray(p.items) ? p.items : [];
  const rawCount = Number.isFinite(Number(p.rawCount)) ? Number(p.rawCount) : items.length;
  const opts = {
    offsetMinutes: p.offsetMinutes ?? CHAT_LOG_DEFAULTS.timeZoneOffsetMinutes,
    segMinutes: p.segMinutes ?? CHAT_LOG_DEFAULTS.segMinutes,
    maxLineChars: p.maxLineChars ?? CHAT_LOG_DEFAULTS.maxLineChars,
    selfName: p.selfName || '大肥鱼',
  };
  const keepTop = p.keepTop ?? (ch.key === 'group' ? CHAT_LOG_DEFAULTS.keepTopGroup : CHAT_LOG_DEFAULTS.keepTopPrivate);
  const digest = renderDigest(items, { ...opts, maxLines: p.digestLines ?? CHAT_LOG_DEFAULTS.injectDigestLines });
  const blocks = renderBlock(items, keepTop, opts);
  return [
    `# ${dateStr} ${ch.label}记录${peerName ? `（${peerName}）` : ''}`,
    '',
    `> 精简版：只留要紧的几行，当天原始消息 ${rawCount} 条。`,
    `> 用途：每天读一遍，代替把整段对话留在上下文里；细节用 qq_read_chat_log 回查，不要凭印象编。`,
    '',
    '## 一、当天最要紧的几行',
    '',
    digest || '- （今天没什么要紧的）',
    '',
    '## 二、分段记录',
    '',
    blocks || '- （今天没有值得留的消息）',
    '',
  ].join('\n');
}

/**
 * 从记录文件里抠出「一、当天最要紧的几行」，用于每天注入上下文。
 * 返回纯文本（多行），没有这一节就返回 ''。
 */
export function extractDigestSection(markdown, { maxLines = CHAT_LOG_DEFAULTS.injectDigestLines, maxChars = CHAT_LOG_DEFAULTS.injectMaxChars } = {}) {
  const text = String(markdown ?? '');
  const idx = text.indexOf('## 一、当天最要紧的几行');
  if (idx < 0) return '';
  const rest = text.slice(idx + '## 一、当天最要紧的几行'.length);
  const next = rest.indexOf('\n## ');
  const section = (next >= 0 ? rest.slice(0, next) : rest).trim();
  const lines = section.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, Math.max(1, maxLines));
  if (!lines.length) return '';
  return truncate(lines.join('\n'), Math.max(80, maxChars));
}
