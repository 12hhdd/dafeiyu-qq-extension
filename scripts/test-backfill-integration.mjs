// 历史补收的集成回归：真的跑 bridge.js（在 VM 夹具里），喂一段"丢失窗口"的 OneBot 历史，
// 断言消息被补进未读、按时间升序、不重复、不复活水位前的老消息、并且触发了唤醒。
//
// 为什么必须有这一层：src/backfill.js 的纯函数测试只能证明"筛选逻辑对"，
// 证明不了"它确实被接到 handleIncoming 同一套入库/唤醒路径上"。事故里真正坏掉的是
// 接线（SnowLuma 僵死 → 桥接只打一行警告 → 消息永远补不回来），不是算法。
import test from 'node:test';
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

// 8 位假号：QQ 号规则是 9-10 位，所以这个值永远不会被 privacy-scan 当成真实号码。
const SELF_ID = 10000001;
const OWNER = 123;

function historyMessage({ seq, from, text, secondsAgo, group = null, atSelf = false }) {
  const time = Math.floor(Date.now() / 1000) - secondsAgo;
  // @ 必须是真实的 at 段：只写文本框里的 "@昵称" 走不到 atMention 分支（会落到 keywords）。
  const message = atSelf
    ? [{ type: 'at', data: { qq: String(SELF_ID) } }, { type: 'text', data: { text: ` ${text}` } }]
    : [{ type: 'text', data: { text } }];
  const base = {
    time,
    message_id: `m${seq}`,
    message_seq: seq,
    user_id: from,
    message,
    raw_message: text,
    font: 14,
    sender: { user_id: from, nickname: `u${from}`, card: '' },
    real_id: seq,
  };
  if (group) return { ...base, message_type: 'group', sub_type: 'normal', group_id: group, group_name: 'fixture-group' };
  return { ...base, message_type: 'private', sub_type: 'friend' };
}

/** 种一个"本地已经聊过、然后 Hook 僵死"的会话状态（水位 = now - ageMs）。 */
function seedConversation(bridge, key, { ageMs, recent = [], wakeTriggers = null } = {}) {
  const st = bridge.getSocialV2State(key);
  const since = Date.now() - ageMs;
  st.lastIncomingAt = since;
  st.lastSeenMsgTimeMs = since;
  st.recentMessages = recent.map((m) => ({ ...m, time: since }));
  st.lastUnreadSeq = recent.length;
  if (wakeTriggers) st.wakeConfig = { ...st.wakeConfig, triggers: { ...st.wakeConfig.triggers, ...wakeTriggers } };
  return st;
}

async function withBridge(history, fn) {
  const bridge = await bridgeHarness({
    config: {
      ownerQQ: OWNER,
      allow: { private: [String(OWNER)], groups: ['456'] },
      snowluma: { accessToken: 'fixture' },
    },
    history,
  });
  // 历史上线时是从 get_login_info 拿的；夹具里直接给，省掉一次假调用。
  bridge.setSelfId(String(SELF_ID));
  try {
    return await fn(bridge);
  } finally {
    await bridge.close();
  }
}

test('补收把丢失窗口的私聊补进未读，按时间升序、不重复、不含自己发的', async () => {
  const now = Date.now();
  // 本地最后一条消息是 40 分钟前收到的 —— 之后 Hook 僵死，这段时间的消息全丢了。
  const history = {
    private: [
      // 比水位还老 —— 不能复活（否则每次补收都把同一批老消息再补一遍）
      historyMessage({ seq: 1, from: OWNER, text: '早', secondsAgo: 60 * 60 }),
      // 丢失窗口里的两条
      historyMessage({ seq: 2, from: OWNER, text: '在', secondsAgo: 30 * 60 }),
      historyMessage({ seq: 3, from: OWNER, text: '为什么回复那么慢', secondsAgo: 29 * 60 }),
      // 自己发的 —— 必须过滤掉（历史里自己的消息也在）
      historyMessage({ seq: 4, from: SELF_ID, text: '我在的', secondsAgo: 28 * 60 }),
    ],
  };
  await withBridge(history, async (bridge) => {
    const st = seedConversation(bridge, 'private:123', {
      ageMs: 40 * 60_000,
      recent: [{ seq: 1, isSelf: false, sender: '私聊', text: '早', messageId: 'm1' }],
    });
    const count = await bridge.backfillConversationV2('private:123', { reason: 'test' });
    assert.equal(count, 2, '应补回恰好 2 条丢失消息（水位前的与自己的都不算）');
  // harness 里的 st 来自另一个 VM realm，其 Array 原型与本 realm 不同：
  // 直接 deepEqual 会报"内容一样却不相等"，必须先拷成本 realm 的数组。
    assert.deepEqual(
      [...st.unread].map((m) => m.text),
      ['在', '为什么回复那么慢'],
      '按时间升序补入，且不含自己发的',
    );
    // 原始时间必须保留 —— 否则模型会把半小时前的消息当成"刚刚"
    assert.ok(
      st.unread.every((m) => m.time < now - 25 * 60_000),
      '补收消息必须保留历史真实时间戳',
    );
    // 本地 seq 是模型做已读水位用的游标，不能混进 QQ 的 message_seq
    assert.equal(st.lastUnreadSeq, 3, '本地 seq 继续自增（1 → 3），绝不能变成 QQ 的 message_seq');
    // 重复跑一次不能翻倍（messageId 去重）
    const again = await bridge.backfillConversationV2('private:123', { reason: 'test' });
    assert.equal(again, 0, '第二次补收不应再补进任何东西');
    assert.equal(st.unread.length, 2);
  });
});

test('私聊补收一定补唤醒（私聊恒唤醒），且原因带 backfill 前缀', async () => {
  const history = { private: [historyMessage({ seq: 7, from: OWNER, text: '在', secondsAgo: 10 * 60 })] };
  await withBridge(history, async (bridge) => {
    const st = seedConversation(bridge, 'private:123', { ageMs: 30 * 60_000 });
    await bridge.backfillConversationV2('private:123', { reason: 'test' });
    assert.ok(st.pendingWakeTimer, '私聊补收必须排唤醒 —— 否则她永远不知道有人找过她');
    assert.match(String(st.pendingWakeReason || ''), /^backfill:/, '唤醒原因应带 backfill 前缀，便于日志区分');
  });
});

test('群聊补收按唤醒规则判定：没叫她的群消息入库但不唤醒', async () => {
  const history = {
    group: [
      historyMessage({ seq: 10, from: 999, text: '今天吃啥', secondsAgo: 20 * 60, group: 456 }),
      historyMessage({ seq: 11, from: 998, text: '随便', secondsAgo: 19 * 60, group: 456 }),
    ],
  };
  await withBridge(history, async (bridge) => {
    const st = seedConversation(bridge, 'group:456', {
      ageMs: 30 * 60_000,
      // probability 必须显式关掉：默认 wakeConfig 里是 0.05，跑几次就会随机命中，
      // 于是"不该唤醒"的断言偶发失败（实测 8 次里挂 1 次）。
      wakeTriggers: { anyMessage: false, atMention: true, nameMention: true, question: false, probability: 0 },
    });
    const count = await bridge.backfillConversationV2('group:456', { reason: 'test' });
    assert.equal(count, 2, '两条都应入库');
    assert.equal(st.unread.length, 2);
    // 没 @、没叫名字 → 不该产生待发送唤醒（否则每次补收都白烧一次模型）
    assert.equal(st.pendingWakeTimer, null, '没有命中唤醒规则的群消息不应触发唤醒');
  });
});

test('群聊补收命中 @ 时补唤醒', async () => {
  const history = {
    group: [historyMessage({ seq: 20, from: 999, text: '出来', secondsAgo: 10 * 60, group: 456, atSelf: true })],
  };
  await withBridge(history, async (bridge) => {
    const st = seedConversation(bridge, 'group:456', {
      ageMs: 30 * 60_000,
      wakeTriggers: { anyMessage: false, atMention: true, nameMention: false, question: false },
    });
    await bridge.backfillConversationV2('group:456', { reason: 'test' });
    assert.ok(st.pendingWakeTimer, '@ 命中的补收必须排一次唤醒');
    assert.match(String(st.pendingWakeReason || ''), /^backfill:atMention/, '内部规则应被带出来（atMention）');
  });
});

test('batch 只补白名单内且已存在的会话，不凭空造会话', async () => {
  const history = {
    private: [historyMessage({ seq: 30, from: OWNER, text: '喂', secondsAgo: 5 * 60 })],
    group: [historyMessage({ seq: 31, from: 999, text: '@deepseek', secondsAgo: 4 * 60, group: 456 })],
  };
  await withBridge(history, async (bridge) => {
    // 批量补收只在 reserved2 模式下有意义（其它模式走的是另一套会话模型）。
    bridge.setMode('reserved2');
    seedConversation(bridge, 'private:123', { ageMs: 20 * 60_000 });
    // 群 456 在白名单里但本地没有任何状态（从没收到过它的消息）→ 不该补
    const result = await bridge.backfillMissedMessagesV2('test', { force: true });
    assert.equal(result.total, 1, '只补那个真实存在的会话');
    assert.deepEqual([...result.conversations].map((c) => c.key), ['private:123']);
    assert.equal(bridge.socialV2.conversations.has('group:456'), false, '不得凭空创建陌生群的会话状态');
  });
});
