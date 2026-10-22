// 历史补收（backfill）：把「SnowLuma [Hook] 僵死 / 桥接离线」期间**静默丢失**的
// QQ 消息，按 QQ 服务端的真实历史补回来。
//
// 为什么需要这个：桥接的入库 seq 是**本地自增**（`appendSocialV2Message` 里
// `seq = (st.lastUnreadSeq||0)+1`），与 QQ 的 `message_seq` 毫无关系，所以消息一旦在
// 推送层丢掉，本地既发现不了缺口、也没有任何"漏了几条"的记账。实测 2026-10-21
// 15:18–18:06 SnowLuma 的 [Hook] 收不到 QQ 数据近 3 小时：私聊「在」「为什么回复那么慢」
// 与群里 28 条消息全部丢失，桥接只打了一行 ⚠️ 警告就什么都不做。
//
// 本模块**只放纯函数**（不碰网络 / 不碰文件），逻辑可以直接单元测试，
// 见 scripts/test-backfill.mjs。网络与入库留在 src/bridge.js 的
// `backfillMissedMessagesV2` 里。
//
// 设计要点：
//   1. **只用 message_id 去重**，不动 lastUnreadSeq / lastReadThroughSeq 的语义
//      （本地 seq 是模型做已读水位用的游标，混进 QQ 的 message_seq 会把它搞乱）。
//   2. **水位用本地最后一条入库消息的时间**（`lastIncomingAt`）：它之前的消息一定收到过，
//      之后到现在的就是可能的丢失窗口。
//   3. 历史接口返回的顺序**不保证单调**（实测私聊里自己发的两条排在更早的消息之前），
//      所以要自己排序、自己过滤自己发的消息（历史里包含机器人自己发的）。
//   4. 双保险上限：最多回收 maxAgeMs 以内、最多 maxCount 条，避免一次补收把缓冲区冲爆。

/** 默认参数（可在 config.json 的 snowluma.backfill* 覆盖）。 */
export const BACKFILL_DEFAULTS = Object.freeze({
  // 只看这么久以内的历史，太老的补回来没有意义（还会触发莫名其妙的唤醒）
  maxAgeMs: 24 * 60 * 60 * 1000,
  // 每个会话最多补多少条（超出的取最新的那批）
  maxCount: 30,
  // 与水位比较时允许的时钟毛刺（QQ 的 time 只有秒级精度）
  skewMs: 60 * 1000,
});

/** 把 OneBot 历史里的 time 字段统一成毫秒。SnowLuma 给的是**秒**，也兼容已经是毫秒的。 */
export function historyTimeToMs(rawTime) {
  const n = Number(rawTime);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > 1e12 ? Math.round(n) : Math.round(n * 1000);
}

/**
 * 把一条 OneBot 历史消息归一化成补收需要的形状。
 *
 * 实测形状（`get_friend_msg_history` / `get_group_msg_history` 的 data.messages[]）：
 *   群：{ time, message_type:'group', sub_type:'normal', message_id, message_seq,
 *         group_id, group_name, user_id, message:[{type,data}], raw_message, font,
 *         sender:{user_id,nickname,card,role,sex,age}, anonymous, real_id }
 *   私：{ time, message_type:'private', sub_type:'friend', message_id, message_seq,
 *         user_id, message, raw_message, font, sender:{user_id,nickname,sex,age}, real_id }
 *
 * @returns {null | { messageId: string|null, userId: string|null, sender: string,
 *   timeMs: number, segments: Array, raw: object }}
 */
export function normalizeHistoryMessage(raw, kind) {
  if (!raw || typeof raw !== 'object') return null;
  const userId = raw.user_id ?? raw.sender?.user_id ?? null;
  const messageId = raw.message_id ?? raw.msg_id ?? null;
  let segments = [];
  if (Array.isArray(raw.message)) segments = raw.message;
  else if (typeof raw.message === 'string' && raw.message) segments = [{ type: 'text', data: { text: raw.message } }];
  else if (typeof raw.raw_message === 'string' && raw.raw_message) segments = [{ type: 'text', data: { text: raw.raw_message } }];
  const sender = kind === 'group'
    ? String(raw.sender?.card || raw.sender?.nickname || userId || '未知')
    : '私聊';
  return {
    messageId: messageId != null ? String(messageId) : null,
    userId: userId != null ? String(userId) : null,
    sender,
    timeMs: historyTimeToMs(raw.time ?? raw.timestamp),
    segments,
    raw,
  };
}

/**
 * 从一段历史里挑出「本地确实缺失」的消息。
 *
 * @param {Array} messages 历史接口返回的原始消息数组（顺序任意）
 * @param {object} opts
 * @param {string|number|null} opts.selfId   机器人自己的 QQ 号（历史里含自己发的消息，必须过滤）
 * @param {Set<string>} [opts.knownIds]      本地已入库的 messageId 集合（去重主依据）
 * @param {number} [opts.floorMs]            水位：只考虑**严格晚于**这个时刻的消息
 * @param {number} [opts.maxAgeMs]           最多回溯多久
 * @param {number} [opts.maxCount]           每个会话最多返回多少条（保留最新的）
 * @param {number} [opts.now]                当前时刻（便于测试）
 * @param {string} [opts.kind]               'group' | 'private'
 * @returns {Array} 归一化后的消息，**按时间升序**（保证入库顺序与真实发送顺序一致）
 */
export function selectMissedMessages(messages, opts = {}) {
  const {
    selfId = null,
    knownIds = new Set(),
    floorMs = 0,
    maxAgeMs = BACKFILL_DEFAULTS.maxAgeMs,
    maxCount = BACKFILL_DEFAULTS.maxCount,
    skewMs = BACKFILL_DEFAULTS.skewMs,
    now = Date.now(),
    kind = 'group',
  } = opts;
  const list = Array.isArray(messages) ? messages : [];
  const known = knownIds instanceof Set ? knownIds : new Set(knownIds || []);
  const self = selfId != null && String(selfId) !== '' ? String(selfId) : null;
  const oldestAllowed = now - Math.max(60_000, Number(maxAgeMs) || BACKFILL_DEFAULTS.maxAgeMs);
  const floor = Number(floorMs) > 0 ? Number(floorMs) - Math.max(0, Number(skewMs) || 0) : 0;

  const picked = [];
  const seen = new Set();
  for (const raw of list) {
    const item = normalizeHistoryMessage(raw, kind);
    if (!item) continue;
    // 自己发的不是"未读"，补回来会让模型以为对方说话了
    if (self && item.userId && item.userId === self) continue;
    if (item.messageId && (known.has(item.messageId) || seen.has(item.messageId))) continue;
    if (item.messageId) seen.add(item.messageId);
    if (!item.segments.length) continue;
    if (item.timeMs <= 0) continue;
    if (item.timeMs < oldestAllowed) continue;
    // 水位之前的消息一定已经入库过（哪怕已经从缓冲区淘汰），不要复活它们
    if (floor > 0 && item.timeMs < floor) continue;
    picked.push(item);
  }
  picked.sort((a, b) => (a.timeMs - b.timeMs) || String(a.messageId || '').localeCompare(String(b.messageId || '')));
  const limit = Math.max(1, Number(maxCount) || BACKFILL_DEFAULTS.maxCount);
  return picked.length > limit ? picked.slice(-limit) : picked;
}

/**
 * 给一条补收消息造一个「够 evaluateWakeTriggerV2 用」的伪事件。
 * 只保留触发判定需要的字段：message 段、user_id、sender、self_id。
 */
export function toPseudoEvent(item, selfId) {
  return {
    message: item.segments,
    raw_message: item.segments.map((s) => (s?.type === 'text' ? String(s?.data?.text ?? '') : '')).join(''),
    user_id: item.userId != null && item.userId !== '' ? (Number.isSafeInteger(Number(item.userId)) ? Number(item.userId) : item.userId) : null,
    self_id: selfId != null && selfId !== '' ? (Number.isSafeInteger(Number(selfId)) ? Number(selfId) : selfId) : null,
    message_id: item.messageId,
    sender: { user_id: item.userId, nickname: item.sender, card: item.sender },
    time: Math.floor(item.timeMs / 1000),
  };
}
