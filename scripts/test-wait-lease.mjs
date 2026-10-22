// qq_wait_for_messages 长轮询租约的回归测试。
//
// 真实故障：模型侧的 fetch 超时/回合被取消时，客户端断开连接，但租约没有归还。
// 根因是 `req.on('close')` 在 readBody() 读完请求体之后才挂上 —— Node 的
// IncomingMessage 在请求体读完时就已经发过一次 'close'，之后不再触发，于是
// finishWait 永远跑不到；activeWaits 里的时间戳会空占到 ACTIVE_WAIT_LEASE_MS
// （15 分钟），该会话这 15 分钟内每一次 qq_wait_for_messages 都 429
// 「该会话已有一个等待中的 qq_wait_for_messages」，AI 卡死在等待循环里
// （表现为「她一直在等/不回话」，且 mark_read、set_wake_config 也一起被挡）。
//
// 现在中止信号取自 ServerResponse 的 'close' + writableEnded，并且租约带
// 代际校验（只回收自己那一份），保证后来者的新租约不会被旧 handler 收尾时删掉。
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

async function fixture(run) {
  const h = await bridgeHarness({ config: { socialV2: {
    wait: { minMs: 100, maxMs: 600000, minQuietAfterNewMs: 100 },
    proactive: { enabled: false }, sticker: { enabled: false },
  } } });
  h.setMode('reserved2');
  const key = 'group:456';
  const st = h.getSocialV2State(key);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const port = server.address().port;
  const post = (route, body) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: `/api/socialV2/${route}`,
      method: 'POST',
      headers: { 'x-console-token': 'fixture-console-token', 'x-agent-token': st.agentToken, 'content-type': 'application/json' },
    }, res => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(raw) }));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('Fixture request timed out')));
    req.end(JSON.stringify({ key, ...body }));
  });
  // 发起一个等待请求，等 lease 生效后**模拟客户端放弃**（fetch 超时/回合被取消）。
  const abortWait = (body, afterMs = 250) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: '/api/socialV2/wait',
      method: 'POST',
      headers: { 'x-console-token': 'fixture-console-token', 'x-agent-token': st.agentToken, 'content-type': 'application/json' },
    }, () => { /* 不会收到响应：客户端先走了 */ });
    req.on('error', () => {});
    req.setTimeout(8000, () => req.destroy());
    req.end(JSON.stringify({ key, ...body }));
    const timer = setTimeout(() => { req.destroy(); resolve(); }, afterMs);
    timer.unref?.();
    req.on('close', () => { clearTimeout(timer); resolve(); });
    setTimeout(() => reject(new Error('abort fixture never fired')), 5000).unref?.();
  });
  try { await run({ h, key, st, post, abortWait }); }
  finally { await new Promise(resolve => server.close(resolve)); await h.close(); }
}

test('客户端放弃后租约立刻归还，下一次等待不会被 429', () => fixture(async ({ post, abortWait }) => {
  const started = Date.now();
  await abortWait({ purpose: 'messages', timeoutMs: 600000 }, 250);
  // 旧 handler 的 while 循环最多 sleep 300ms 才发现中止；这里不等它，
  // 直接发下一次等待，正是要验证「新等待可以立刻拿到租约」。
  const second = await post('wait', { purpose: 'messages', timeoutMs: 200 });
  assert.equal(second.status, 200, `follow-up wait rejected with ${second.status} ${JSON.stringify(second.data)}`);
  assert.equal(second.data.ok, true);
  assert.ok(Date.now() - started < 5000, 'follow-up wait should not be blocked by a 15-minute lease');
}));

test('连接正常结束时也会归还租约', () => fixture(async ({ post }) => {
  const first = await post('wait', { purpose: 'messages', timeoutMs: 150 });
  assert.equal(first.status, 200);
  const second = await post('wait', { purpose: 'messages', timeoutMs: 150 });
  assert.equal(second.status, 200, `sequential waits must both be accepted, got ${second.status}`);
}));

test('旧 handler 收尾时不得删掉后来者的新租约', () => fixture(async ({ post, abortWait }) => {
  await abortWait({ purpose: 'messages', timeoutMs: 600000 }, 200);
  // 第二次等待仍在进行中（故意给它长预算），此时旧 handler 一定已经醒来收尾过。
  const pending = post('wait', { purpose: 'messages', timeoutMs: 2500 });
  await new Promise(resolve => setTimeout(resolve, 700));
  const third = await post('wait', { purpose: 'messages', timeoutMs: 120 });
  assert.equal(third.status, 429, `a still-running wait must stay exclusive, got ${third.status}`);
  const second = await pending;
  assert.equal(second.status, 200);
}));

test('中止的等待不得把消息记成已看过', () => fixture(async ({ h, key, st, abortWait, post }) => {
  h.appendSocialV2Message(key, 'fixture-person', 'hello', 'hello', false, false, `fixture-${st.lastUnreadSeq + 1}`, [], '789', []);
  await abortWait({ purpose: 'messages', timeoutMs: 600000 }, 250);
  // 让旧 handler 完整走完收尾路径。
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(st.modelSeenSeqs.size, 0, 'an abandoned wait must not mark messages as seen by the model');
  assert.equal(st.unread.length, 1, 'the unread buffer must survive an abandoned wait');
  const next = await post('wait', { purpose: 'messages', timeoutMs: 150 });
  assert.equal(next.status, 200);
  assert.equal(next.data.unreadCount, 1);
}));
