// 历史补收（backfill）纯函数测试。
//
// 跑法：node scripts/test-backfill.mjs
// 只测 src/backfill.js 里的纯逻辑，不碰网络/文件。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BACKFILL_DEFAULTS,
  historyTimeToMs,
  normalizeHistoryMessage,
  selectMissedMessages,
  toPseudoEvent,
} from '../src/backfill.js';

// 一律用**明显是假的** 8 位号码（QQ 号规则是 9-10 位）。
// 这个文件会进公开仓库，写真实 QQ 号/群号等于把它们永久写进 Git 历史。
const SELF = 10000001;
const OWNER = 10000002;

// 2026-10-21 15:51:43 +08:00
const T_IN = Math.floor(new Date('2026-10-21T15:51:43+08:00').getTime() / 1000);
const T_SLOW = Math.floor(new Date('2026-10-21T15:51:56+08:00').getTime() / 1000);
const NOW = new Date('2026-10-21T18:07:00+08:00').getTime();

// 实测形状（有删减）：私聊历史，含机器人自己发的消息，且顺序不单调。
const privateHistory = [
  { time: NOW / 1000 - 30, message_type: 'private', sub_type: 'friend', message_id: 65121, message_seq: 65121, user_id: SELF, message: [{ type: 'text', data: { text: '在的' } }], raw_message: '在的', sender: { user_id: SELF, nickname: '大肥鱼' } },
  { time: T_IN, message_type: 'private', sub_type: 'friend', message_id: 26547, message_seq: 26547, user_id: OWNER, message: [{ type: 'text', data: { text: '在' } }], raw_message: '在', sender: { user_id: OWNER, nickname: '主人' } },
  { time: NOW / 1000 - 60, message_type: 'private', sub_type: 'friend', message_id: 65122, message_seq: 65122, user_id: SELF, message: [{ type: 'text', data: { text: '怎么了' } }], raw_message: '怎么了', sender: { user_id: SELF, nickname: '大肥鱼' } },
  { time: T_SLOW, message_type: 'private', sub_type: 'friend', message_id: 26548, message_seq: 26548, user_id: OWNER, message: [{ type: 'text', data: { text: '为什么回复那么慢' } }], raw_message: '为什么回复那么慢', sender: { user_id: OWNER, nickname: '主人' } },
];

test('historyTimeToMs：秒与毫秒都能认', () => {
  assert.equal(historyTimeToMs(T_IN), T_IN * 1000);
  assert.equal(historyTimeToMs(T_IN * 1000), T_IN * 1000);
  assert.equal(historyTimeToMs(0), 0);
  assert.equal(historyTimeToMs(null), 0);
  assert.equal(historyTimeToMs('abc'), 0);
});

test('normalizeHistoryMessage：私聊/群聊的发送者与段都解析出来', () => {
  const priv = normalizeHistoryMessage(privateHistory[1], 'private');
  assert.equal(priv.messageId, '26547');
  assert.equal(priv.userId, String(OWNER));
  assert.equal(priv.sender, '私聊');
  assert.equal(priv.timeMs, T_IN * 1000);
  assert.equal(priv.segments[0].data.text, '在');

  const group = normalizeHistoryMessage({
    time: T_IN, message_type: 'group', message_id: 9001, message_seq: 48304,
    group_id: 10000003, user_id: 10000004,
    message: [{ type: 'text', data: { text: '快饿死了' } }],
    sender: { user_id: 10000004, nickname: '太子', card: '太子' },
  }, 'group');
  assert.equal(group.sender, '太子');
  assert.equal(group.userId, '10000004');

  // 消息体只给了 raw_message 时也要能补成文本段
  const rawOnly = normalizeHistoryMessage({ time: T_IN, user_id: OWNER, raw_message: '裸文本', message_id: 1 }, 'private');
  assert.equal(rawOnly.segments[0].data.text, '裸文本');

  assert.equal(normalizeHistoryMessage(null, 'private'), null);
});

test('selectMissedMessages：过滤自己发的、按时间升序、只补水位之后的', () => {
  const floorMs = new Date('2026-10-21T13:51:17+08:00').getTime(); // 本地 lastIncomingAt
  const got = selectMissedMessages(privateHistory, {
    selfId: SELF, floorMs, kind: 'private', now: NOW,
  });
  // 只有那两条私聊是「真的丢了」的；自己发的 65121/65122 必须被剔除
  assert.deepEqual(got.map((m) => m.messageId), ['26547', '26548']);
  assert.deepEqual(got.map((m) => m.timeMs), [T_IN * 1000, T_SLOW * 1000]);
  // 升序：入库顺序必须与真实发送顺序一致（历史接口顺序不单调）
  assert.ok(got[0].timeMs <= got[1].timeMs);
});

test('selectMissedMessages：已入库的 messageId 不重复入库', () => {
  const got = selectMissedMessages(privateHistory, {
    selfId: SELF,
    knownIds: new Set(['26547']),
    kind: 'private',
    now: NOW,
  });
  assert.deepEqual(got.map((m) => m.messageId), ['26548']);
});

test('selectMissedMessages：水位之前的老消息不复活', () => {
  const got = selectMissedMessages(privateHistory, {
    selfId: SELF,
    floorMs: T_SLOW * 1000 + 300_000, // 水位已经远远过了这两条
    kind: 'private',
    now: NOW,
  });
  assert.deepEqual(got, []);
});

test('selectMissedMessages：水位有毛刺时放宽一点，靠 messageId 去重兜底', () => {
  // 场景：lastIncomingAt 记的是**桥接收到的时间**（比 QQ 的 time 略晚），
  // 卡在冻结边界上的那条可能被判成"水位之前"。所以水位减 skewMs 放行，
  // 已经入库过的再由 knownIds 拦一次 —— 放宽不会造成重复入库。
  const opts = { selfId: SELF, floorMs: T_IN * 1000 + 5_000, kind: 'private', now: NOW, skewMs: 60_000 };
  assert.deepEqual(selectMissedMessages(privateHistory, opts).map((m) => m.messageId), ['26547', '26548']);
  assert.deepEqual(
    selectMissedMessages(privateHistory, { ...opts, knownIds: new Set(['26547']) }).map((m) => m.messageId),
    ['26548'],
  );
  // skewMs=0 时水位是硬的
  assert.deepEqual(selectMissedMessages(privateHistory, { ...opts, skewMs: 0 }).map((m) => m.messageId), ['26548']);
});

test('selectMissedMessages：太老的不补、超过 maxCount 只留最新', () => {
  const old = { time: Math.floor((NOW - 48 * 3600 * 1000) / 1000), user_id: OWNER, message_id: 1, message: [{ type: 'text', data: { text: '太老' } }] };
  assert.deepEqual(selectMissedMessages([old], { selfId: SELF, kind: 'private', now: NOW }), []);

  const many = [];
  for (let i = 0; i < 50; i++) {
    many.push({
      time: Math.floor((NOW - (50 - i) * 60_000) / 1000),
      user_id: OWNER, message_id: 1000 + i,
      message: [{ type: 'text', data: { text: `m${i}` } }],
    });
  }
  const got = selectMissedMessages(many, { selfId: SELF, kind: 'private', maxCount: 5, now: NOW });
  assert.equal(got.length, 5);
  assert.deepEqual(got.map((m) => m.messageId), ['1045', '1046', '1047', '1048', '1049']);
});

test('selectMissedMessages：重复 message_id 只算一次', () => {
  const dup = [privateHistory[1], privateHistory[1]];
  const got = selectMissedMessages(dup, { selfId: SELF, kind: 'private', now: NOW });
  assert.equal(got.length, 1);
});

test('selectMissedMessages：非数组入参不炸', () => {
  assert.deepEqual(selectMissedMessages(null, { selfId: SELF }), []);
  assert.deepEqual(selectMissedMessages(undefined, { selfId: SELF }), []);
  assert.deepEqual(selectMissedMessages([null, 3, 'x'], { selfId: SELF }), []);
});

test('toPseudoEvent：够 evaluateWakeTriggerV2 判定用', () => {
  const item = selectMissedMessages(privateHistory, { selfId: SELF, kind: 'private', now: NOW })[0];
  const ev = toPseudoEvent(item, SELF);
  assert.equal(ev.user_id, OWNER);
  assert.equal(ev.self_id, SELF);
  assert.equal(ev.message_id, '26547');
  assert.equal(ev.raw_message, '在');
  assert.deepEqual(ev.sender, { user_id: String(OWNER), nickname: '私聊', card: '私聊' });
  // 段结构保持不变，@ 判定/关键词判定都靠它
  assert.equal(ev.message[0].type, 'text');

  const at = toPseudoEvent({ segments: [{ type: 'at', data: { qq: String(SELF) } }], userId: OWNER, messageId: '1', sender: 'x', timeMs: NOW }, SELF);
  assert.equal(at.message[0].data.qq, String(SELF));
});

test('BACKFILL_DEFAULTS：保守但有界', () => {
  assert.ok(BACKFILL_DEFAULTS.maxAgeMs <= 24 * 3600 * 1000);
  assert.ok(BACKFILL_DEFAULTS.maxCount > 0 && BACKFILL_DEFAULTS.maxCount <= 100);
});
