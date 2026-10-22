// blocked 回合自愈（archived-gate）回归测试。
//
// 真实故障（2026-10-22）：私聊会话被归档过一次之后，DSH 的 ArchivedSessionGate
// 把它的**每一回合**都在 `agent/pre-step` 阶段 reject —— 事件侧只有
// `turn/end reason={kind:"blocked"}`，不开 step、不调模型、没有 assistant/message。
// 桥接当时的处理是落到最后那个 `else if (!ended.text.trim())` 分支写一行
// 「回合完成但无文本」，于是 QQ 侧完全静默：消息投递成功、日志一片绿、用户等不到回复。
//
// 本测试钉住四件事：
//   1. blocked 回合必须触发解归档（走 callUnary，因为新版 apiproxy 的 workspace
//      门面里没有 unarchiveSession 这个方法）并重投唤醒；
//   2. blocked 回合**不能**被算成「唤醒无行动」，也不能触发收尾提醒
//      （每次重投都是一次真跑的 DSH 回合，误判会白烧配额）；
//   3. 重试有上限：DSH 侧真的坏死时不能无限重投；
//   4. 之后只要有一回合正常落地，计数必须归零，下一次 blocked 重新拿满额度。
import assert from 'node:assert/strict';
import http from 'node:http';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let failures = 0;
async function test(name, run) {
  const h = await bridgeHarness({
    config: { socialV2: { wake: { batchWindowMs: 1000, noActionLimit: 3, maxWakeConfigReminders: 2 } } },
  });
  h.setMode('reserved2');
  try { await run(h); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, error.message); }
  finally { await h.close(); }
}

/** 起一个后台 pumpMux 消费者，把手工 push 的事件真的喂进桥接的处理链。 */
async function startPump(h) {
  void h.pumpMux().catch(() => {});
  // 让 for-await 先挂上 waiter，否则第一条事件会排在队列里等下一轮。
  await new Promise((resolve) => setImmediate(resolve));
}

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

/** 推一对 turn/start + turn/end。reason 决定走哪条分支。 */
function pushTurn(h, sessionId, { turn = 1, reason = { kind: 'blocked' }, text = '' } = {}) {
  h.pushEvent({ type: 'session/event', sessionId, event: { type: 'turn/start', data: { turn } } });
  if (text) {
    h.pushEvent({
      type: 'session/event',
      sessionId,
      event: { type: 'assistant/message', data: { turn, message: { content: [{ type: 'text', text }] } } },
    });
  }
  h.pushEvent({ type: 'session/event', sessionId, event: { type: 'turn/end', data: { turn, reason } } });
}

await test('blocked 回合触发解归档并重投唤醒', async (h) => {
  const sessionId = await h.ensureSession('private:123');
  h.calls.unarchived.length = 0;
  await startPump(h);
  pushTurn(h, sessionId, { reason: { kind: 'blocked' } });
  for (let i = 0; i < 60 && h.calls.unarchived.length === 0; i += 1) await tick();
  // 必须是 callUnary 那条分支：假 api 故意不提供 workspace.unarchiveSession，
  // 所以在真实 apiproxy 上没有这个方法时桥接也不会崩。
  assert.deepEqual(h.calls.unarchived, [sessionId], 'blocked 回合必须对当前会话解归档一次');
  // 解归档后要重投唤醒（scheduleWakeV2 走正常合并窗口，不是直接 deliverPrompt）
  const st = h.getSocialV2State('private:123');
  assert.ok(st.pendingWakeTimer, '解归档后必须真的安排了一次重投（拿到合并窗口定时器）');
  // 关键回归（2026-10-22 线上踩到的真 bug）：blocked 分支如果 continue 之前不清
  // v2TurnStartAt / collectors，isConversationBusyV2 会一直判「繁忙」，重投的唤醒
  // 只会被塞进 pendingWakeReasons 再没人消费 —— 解归档成功但永远不会开口。
  assert.deepEqual(st.pendingWakeReasons ?? [], [], 'blocked 后会话不能仍被判繁忙（重投必须直接排上，不能只暂存）');
});

await test('blocked 回合不算「唤醒无行动」也不发收尾提醒', async (h) => {
  const st = h.getSocialV2State('private:123');
  const sessionId = await h.ensureSession('private:123');
  st.pendingWakeKeys?.delete?.('private:123');
  await startPump(h);
  pushTurn(h, sessionId, { reason: { kind: 'blocked' } });
  await tick(80);
  const after = h.getSocialV2State('private:123');
  assert.equal(after.wakeConfig.noActionCount ?? 0, 0, 'blocked 不是「无行动」，不能累计 noActionCount');
  assert.equal(h.calls.prompts.length, 0, 'blocked 回合不能投递收尾提醒（每次重投都是一次真跑的回合）');
});

await test('连续 blocked 达上限后停止重投', async (h) => {
  const sessionId = await h.ensureSession('private:123');
  await startPump(h);
  // 默认上限 2（config.socialV2.recovery.blockedTurnMaxAttempts）
  h.calls.unarchived.length = 0;
  for (let turn = 1; turn <= 4; turn += 1) {
    pushTurn(h, sessionId, { turn, reason: { kind: 'blocked' } });
    await tick(60);
  }
  assert.equal(h.calls.unarchived.length, 2, '超过重试上限后不能再解归档（否则每轮白烧一个 DSH 回合）');
});

await test('正常回合把重试计数清零', async (h) => {
  const sessionId = await h.ensureSession('private:123');
  await startPump(h);
  h.calls.unarchived.length = 0;
  pushTurn(h, sessionId, { turn: 1, reason: { kind: 'blocked' } });
  await tick(60);
  pushTurn(h, sessionId, { turn: 2, reason: { kind: 'completed' }, text: '收到' });
  await tick(60);
  assert.equal(h.calls.unarchived.length, 1, '第一次 blocked 解归档一次');
  // 计数已清零 → 下一次 blocked 还能再解归档
  pushTurn(h, sessionId, { turn: 3, reason: { kind: 'blocked' } });
  await tick(60);
  assert.equal(h.calls.unarchived.length, 2, '正常回合后计数清零，blocked 重新拿满额度');
});

await test('blocked 回合退回唤醒额度，重投不会被限流吞掉', async (h) => {
  const sessionId = await h.ensureSession('private:123');
  const st = h.getSocialV2State('private:123');
  // 造一个「额度刚好用满」的现场：桥接在**投递前**就把唤醒记进 wakeTimes，
  // 而 blocked 回合一个 step 都没开、模型一次都没调，不该占这份额度。
  // 2026-10-22 线上就是死在这里：解归档成功 → 计划唤醒 → 8s 后「唤醒频率超限，跳过」。
  h.cfg.socialV2.wake.maxWakePerMinute = 1;
  h.cfg.socialV2.wake.maxWakePerHour = 0;
  const wakeAt = Date.now();
  st.wakeConfig.lastWakeAt = wakeAt;
  st.wakeTimes = [wakeAt];
  h.calls.prompts.length = 0;
  await startPump(h);
  pushTurn(h, sessionId, { reason: { kind: 'blocked' } });
  // 等过合并窗口（batchWindowMs=1000）让重投真的走到 sendWakePromptV2
  await tick(1400);
  assert.ok(!(st.wakeTimes || []).includes(wakeAt), 'blocked 回合必须把白吃的唤醒额度退回去');
  assert.equal(h.calls.prompts.length, 1, '退回额度后重投必须真的投递出去（不能被 maxWakePerMinute 拦掉）');
});

await test('repair-session 路由可手动解归档并清计数', async (h) => {
  const sessionId = await h.ensureSession('private:123');
  const server = h.startConsoleServer();
  await new Promise((resolve) => (server.listening ? resolve() : server.once('listening', resolve)));
  try {
    h.calls.unarchived.length = 0;
    const body = await new Promise((resolve, reject) => {
      const request = http.request({
        host: '127.0.0.1', port: server.address().port, path: '/api/socialV2/repair-session', method: 'POST',
        headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token' },
      }, (response) => {
        let raw = '';
        response.on('data', (chunk) => { raw += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, json: (() => { try { return JSON.parse(raw); } catch { return raw; } })() }));
      });
      request.on('error', reject);
      request.setTimeout(5000, () => request.destroy(new Error('repair-session request hung')));
      request.end(JSON.stringify({ key: 'private:123' }));
    });
    assert.equal(body.status, 200, `状态码应为 200，实际 ${body.status}`);
    assert.equal(body.json.ok, true);
    assert.equal(body.json.sessionId, sessionId);
    assert.deepEqual(h.calls.unarchived, [sessionId]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

await test('repair-session 拒绝非法 key', async (h) => {
  const server = h.startConsoleServer();
  await new Promise((resolve) => (server.listening ? resolve() : server.once('listening', resolve)));
  try {
    const body = await new Promise((resolve, reject) => {
      const request = http.request({
        host: '127.0.0.1', port: server.address().port, path: '/api/socialV2/repair-session', method: 'POST',
        headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token' },
      }, (response) => {
        let raw = '';
        response.on('data', (chunk) => { raw += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, raw }));
      });
      request.on('error', reject);
      request.setTimeout(5000, () => request.destroy(new Error('request hung')));
      request.end(JSON.stringify({ key: '../../etc/passwd' }));
    });
    assert.equal(body.status, 400, `非法 key 必须 400，实际 ${body.status}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exitCode = failures === 0 ? 0 : 1;
