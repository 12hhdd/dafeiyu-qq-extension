// Execute the real bridge initialization/functions against temporary files and fake peers.
// No production config, QQ connection, DSH process, or persistent home is accessed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
// 注意：bridge.js 用到的相对模块**不在这里逐个 import**。bridgeHarness() 会从
// bridge.js 被剥掉的 import 行里自动推导（见函数内的 relativeSpecifiers），
// 手写第二份清单就是上一版 7 个脚本一起挂掉的原因。
import { unwrap, createTurnCollector } from '../src/dsh-client.js';

const root = fileURLToPath(new URL('..', import.meta.url));
export async function bridgeHarness({ config = {}, savedState, globals = {}, history = {} } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-audit-bridge-'));
  fs.mkdirSync(path.join(temp, 'src'));
  fs.mkdirSync(path.join(temp, 'state'));
  fs.writeFileSync(path.join(temp, 'config.json'), JSON.stringify({
    dsh: { authToken: 'fixture-only' }, ownerQQ: 123,
    allow: { private: ['123'], groups: ['456'] }, consolePort: 0,
    consoleToken: 'fixture-console-token', slang: { enabled: false }, ...config,
  }));
  if (savedState) fs.writeFileSync(path.join(temp, 'state/sessions.json'), JSON.stringify(savedState));
  const calls = { created: [], archived: [], unarchived: [], sent: [], prompts: [], follows: [], cancelled: [], images: [], http: [] };
  // 语音发送在桥接里是**直接 fetch 网关**（与文本/表情共用 sendChain，但要自己带 record 段），
  // 所以这里给 VM 注入一个记录型 fetch：既不让测试真的发 QQ 消息，又能断言发出的段内容。
  const fakeFetch = async (url, init = {}) => {
    const body = (() => { try { return JSON.parse(init.body ?? '{}'); } catch { return init.body; } })();
    calls.http.push({ url: String(url), body });
    const action = String(url).split('/').pop();
    // 历史接口：由调用方用 history 夹具提供（{private: [...], group: [...]}）。
    // 补收走的就是这两条 OneBot HTTP action，必须在假网关里也有对应响应。
    if (action === 'get_friend_msg_history' || action === 'get_group_msg_history') {
      const list = action === 'get_friend_msg_history' ? (history.private ?? []) : (history.group ?? []);
      return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { messages: list } }) };
    }
    if (action === 'fetch_ptt_text') {
      return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { text: 'fixture-transcript' } }) };
    }
    // get_msg：语音落地校验用 —— 回一个带 record 段的消息，模拟真实网关
    if (action === 'get_msg') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: 'ok',
          retcode: 0,
          data: { message_id: 9001, message: [{ type: 'record', data: { file: 'fixture-record.amr', duration: 3 } }] }
        })
      };
    }
    return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 9001 } }) };
  };
  const success = (value) => ({ result: { ok: true, value } });
  // 可控的 mux 事件源：桥接的 pumpMux 用 `for await (... of api.events.mux({}))` 消费它。
  // 测试用 pushEvent 手工喂 turn/start / turn/end 之类的事件，从而在虚拟环境里
  // 走真实的事件处理分支（而不是只测被导出的纯函数）。
  const muxQueue = [];
  const muxWaiters = [];
  const muxEvents = {
    follow: (id) => calls.follows.push(id),
    forget: () => {},
    async *mux() {
      for (;;) {
        if (muxQueue.length) {
          const next = muxQueue.shift();
          yield next;
          continue;
        }
        const waiter = {};
        muxWaiters.push(waiter);
        await new Promise((resolve) => { waiter.resolve = resolve; });
      }
    },
  };
  const pushEvent = (payload) => {
    const envelope = { payload };
    if (muxWaiters.length) {
      const waiter = muxWaiters.shift();
      muxQueue.push(envelope);
      waiter.resolve();
      return;
    }
    muxQueue.push(envelope);
  };
  const api = {
    events: muxEvents,
    workspace: {
      create: async () => success({ created: false, workspace: { workspaceId: 'fixture-workspace' } }),
      archiveSession: async ({ sessionId }) => { calls.archived.push(sessionId); return success({}); },
    },
    sessions: {
      create: async (params) => { calls.created.push(params); return success({ sessionId: `fixture-${calls.created.length}` }); },
      selectModel: async () => success({ selected: { provider: 'fixture', model: 'fixture' } }),
      prompt: async (params) => { calls.prompts.push(params); return success({}); },
    },
    respond: async () => success({}),
    stopSessionWork: async (sessionId) => { calls.cancelled.push(sessionId); return { removed: 0 }; },
    callUnary: async (method, params) => {
      // 生产环境里 `api.workspace.unarchiveSession` 这个域方法**不存在**（新版 apiproxy
      // 客户端的 workspace 门面只到 archiveSession），桥接因此必须走 callUnary。
      // 假 api 故意同样不提供它，让测试覆盖的是真实上线的那条分支；
      // 解归档调用单独记进 calls.unarchived，避免和 stopSessionWork 混在一起。
      if (method === 'workspace.unarchiveSession') {
        calls.unarchived.push(params?.sessionId ?? null);
        return success({ archivedSessionIds: [] });
      }
      calls.cancelled.push({ method, params });
      return success({ accepted: true });
    },
  };
  class FakeBot {
    async sendPrivateMessage(id, text) { calls.sent.push({ kind: 'private', id, text }); }
    async sendGroupMessage(id, text) { calls.sent.push({ kind: 'group', id, text }); }
    async getImage({ file }) {
      calls.images.push(file);
      // Valid 1 × 1 PNG, supplied entirely in memory by the fixture gateway.
      return { base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=' };
    }
    async request() { return { status: 'ok', retcode: 0, data: [{ emoji_id: 'fixture-sticker', url: 'https://public.invalid/sticker' }] }; }
  }
  let source = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');
  // 去掉顶层 import（VM 里靠 context 注入提供这些绑定）。
  // 必须按行处理：这些 import 有**多行**写法，用单行正则（/^import[\s\S]*?;/gm）会在
  // 第一个分号处停下，把紧跟其后的正常代码一起删掉（曾把 `cfg.socialV2.voice = {…}`
  // 整段吞掉，导致语音相关断言在虚拟环境里悄悄失真）。
  source = source.split(/\r?\n/).reduce((acc, line) => {
    if (acc.droppingImport) {
      acc.stripped.push(line);
      if (/;\s*$/.test(line)) acc.droppingImport = false;
      return acc;
    }
    if (/^import[\s{*]/.test(line) || /^import\s+['"]/.test(line)) {
      acc.stripped.push(line);
      if (!/;\s*$/.test(line)) acc.droppingImport = true;
      return acc;
    }
    acc.out.push(line);
    return acc;
  }, { out: [], stripped: [], droppingImport: false });
  const strippedImports = source.stripped.join('\n');
  source = source.out.join('\n');
  // 自动推导 vm 注入清单 ──────────────────────────────────────────────────────
  // 手写注入列表是**会静默过时**的：bridge.js 每抽出一个新的 `*-core.js` 就多一条
  // 顶层 import，harness 漏注入 ⇒ vm 里 ReferenceError，一次性打挂所有走本 harness
  // 的脚本（抽出 diary-core.js 时就是这么让 7 个脚本同时红的，报错还只指向下面那行
  // `vm.runInContext`，看不出真正缺的是什么）。
  // 所以这里不再维护第二份清单：从**被剥掉的 import 语句**里推导相对模块，真实
  // dynamic import 一份，把整个 namespace 展开进 context —— 具名、`as` 别名、
  // `* as ns` 三种写法都自动覆盖。非相对模块（js-yaml、@snowluma/sdk …）仍由
  // 下面的显式桩提供，不在这里动。
  const relativeSpecifiers = [...new Set(
    [...strippedImports.matchAll(/(?:from|^import)\s+['"](\.[^'"]+)['"]/gm)].map((m) => m[1]),
  )];
  const injectedModules = {};
  const loadedModules = new Map();
  for (const specifier of relativeSpecifiers) {
    const target = path.resolve(path.join(root, 'src'), specifier);
    try {
      loadedModules.set(specifier, await import(pathToFileURL(target).href));
    } catch (error) {
      throw new Error(`audit-bridge-harness: 注入 bridge.js 的依赖 ${specifier} 失败（${target}）：${error?.message ?? error}`);
    }
  }
  // 光展开 namespace 还不够：`import * as diaryCore from './diary-core.js'` 之后
  // bridge.js 里写的是 `diaryCore.DIARY_DIR`，只把 DIARY_DIR 摊到顶层照样 ReferenceError。
  // 所以要**按原始 import 语句还原每个本地绑定**：命名导入取对应导出、`as` 用别名、
  // `* as ns` 绑整个 namespace。多行 import 也一并处理（按分号切语句）。
  for (const statement of strippedImports.match(/^import[\s\S]*?;/gm) ?? []) {
    const named = /^import\s+\{([\s\S]*?)\}\s+from\s+['"]([^'"]+)['"]/m.exec(statement);
    const star = /^import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"]/m.exec(statement);
    const fallback = /^import\s+([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"]/m.exec(statement);
    if (named) {
      const mod = loadedModules.get(named[2]);
      if (!mod) continue;
      for (const part of named[1].split(',')) {
        const spec = part.trim();
        if (!spec) continue;
        const [imported, local] = spec.split(/\s+as\s+/).map((s) => s.trim());
        injectedModules[local || imported] = mod[imported];
      }
    } else if (star) {
      const mod = loadedModules.get(star[2]);
      if (mod) injectedModules[star[1]] = mod;
    } else if (fallback && loadedModules.has(fallback[2])) {
      injectedModules[fallback[1]] = loadedModules.get(fallback[2]).default;
    }
  }
  // 同时把每个模块的命名导出摊到顶层：bridge.js 里有些绑定是解构后再用的，
  // 摊平后与旧版手写 `...markdown, ...sensitive, …` 的语义保持一致。
  for (const mod of loadedModules.values()) Object.assign(injectedModules, mod);
  source = source.replaceAll('import.meta.url', JSON.stringify(pathToFileURL(path.join(temp, 'src/bridge.js')).href));
  source = source.slice(0, source.indexOf("process.on('SIGINT'"));
  source = source.replace('  bot.onPrivateMessage(async (event) => {', `
  return {
    ensureSession, ensureSlangLearnerSession, resolvePresetName, deliverPrompt, drainPromptQueue,
    sendToQQ, sendStickerV2, handleIncoming, startConsoleServer, cfg, state, api, promptQueues,
    getSocialV2State, appendSocialV2Message, recordSentMessagesV2,
    buildWakePromptV2, buildWakeSnapshotV2, sendWakePromptV2, socialV2,
    backfillConversationV2, backfillMissedMessagesV2, scheduleBackfillV2,
    setSelfId(value) { selfId = value; },
    flushQueue, retireSession,
    voiceCfg, voiceLibrary, resolveVoicePathForV2, resolveVoicePathForOperator,
    voiceBudgetCheck, sendVoiceV2, sendVoiceForV2, assertOutboundAuditOk,
    setMode(value) { currentMode = value; },
    setReady(value) { dshReady = value; },
    setPresets(value) { dshPresetIds = value; dshDefaultPreset = 'standard'; },
    resetEpoch() { sessionEpoch++; },
    unarchiveSessionIfNeeded, recoverBlockedTurn, pumpMux,
  };
  bot.onPrivateMessage(async (event) => {`);
  const timers = new Set();
  const context = vm.createContext({
    // ⚠️ 顺序要紧：`...injectedModules` 必须在**最先**展开，后面那些显式桩才能覆盖它。
    // 反过来写会让 dsh-client.js 的真实 NodeApiClient / SnowLumaWebSocketClient 盖掉下面
    // 的桩，测试就会真的去连网络（表现为 `fetch failed`，而不是断言失败）。
    ...injectedModules,
    fs, path, http, crypto, fileURLToPath, URL, Buffer, AbortSignal, console: { log() {}, error() {} },
    fetch: fakeFetch,
    // 锁文件探测用（bridge.js 顶层的 consolePortInUse）；
    // 固定桩掉：测试不应该真去 netstat 宿主机。
    execFileSync: () => '',
    // process 桩要带 env：voice-core / bridge 会读 process.env.FFMPEG_PATH、FFPROBE_PATH 等。
    // 之前只给 pid/platform/kill/exit，导致 `process.env.FFMPEG_PATH` 直接抛 TypeError。
    process: { pid: process.pid, platform: process.platform, kill: process.kill, env: {}, exit: (code) => { throw new Error('unexpected exit ' + code); } },
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timers.add(timer); return timer; },
    clearTimeout, setInterval: () => ({ unref() {} }), clearInterval: () => {},
    NodeApiClient: class { constructor() { return api; } },
    SnowLumaWebSocketClient: FakeBot, text: (s) => s,
    discoverDshLaunchToken: () => '', unwrap, createTurnCollector,
    // ACL 收紧会 spawn icacls 去改**真实**文件系统；测试不该做这件事（同理见下面的
    // cleanupTemp / processAudioVolume 桩）。桩成成功，让 hardenStateDirAcl 走正常分支。
    hardenDir: () => ({ ok: true, detail: 'stub' }),
    // 音量靠 ffmpeg；测试环境不该真跑 ffmpeg（也不该在沙箱里 spawn）。
    // 默认桩成"按倍数记账但不转码"，调用方可用 globals 覆盖来断言真实行为。
    processAudioVolume: async (file, { volume = 1, normalize = false, loudness = 'normal' } = {}) => {
      const v = Number(volume);
      const changed = normalize === true || Math.abs(v - 1) > 1e-9;
      return {
        path: changed ? `${file}.vol` : file,
        converted: changed,
        applied: changed,
        volume: normalize ? 1 : v,
        loudness: normalize ? -16 : null,
        mode: normalize ? 'loudnorm' : (changed ? 'volume' : 'original'),
        detail: normalize ? `智能音量（响度归一 ${loudness === 'loud' ? -13 : loudness === 'quiet' ? -20 : -16} LUFS）`
          : (changed ? `音量 ${Math.round(v * 100)}%` : '原始音量')
      };
    },
    cleanupTemp: () => {},
    ...globals,
  });
  // Execute the pure model view in the bridge realm. Its plain-object checks
  // should see the same prototypes as real bridge messages, just as in Node.
  const modelViewSource = fs.readFileSync(path.join(root, 'src/qq-model-view.js'), 'utf8').replace(/^export /gm, '');
  vm.runInContext(`Object.assign(globalThis, (() => { ${modelViewSource}\nreturn { compactModelMessage, compactModelData, serializeModelData }; })());`, context);
  vm.runInContext(source + '\nglobalThis.auditReady = main();', context);
  const bridge = await context.auditReady;
  bridge.setPresets(['standard', 'qq-chat', 'qq-chat-v2']);
  bridge.setReady(true);
  return { ...bridge, calls, temp, pushEvent, async close() {
    for (const timer of timers) clearTimeout(timer);
    fs.rmSync(temp, { recursive: true, force: true });
  } };
}
