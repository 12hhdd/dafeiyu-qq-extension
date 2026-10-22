// Safe audit suite: fixtures and mocks only, never production QQ/DSH.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const tests = [
  'test-audit-bridge.mjs', 'test-audit-protocol.mjs', 'test-audit-protocol-helpers.mjs',
  'test-audit-security.mjs', 'test-audit-security-mcp.mjs',
  'test-audit-setup.mjs', 'test-audit-setup-guards.mjs',
  // DSH 会话队列（inbox 投影）解析：0.2.0 把队列从 control baseline 的
  // `value.queues[<id>]` 挪进了 `value.projections[<id>].values.inbox`。
  // 认错形状的后果不是"少清几条"，而是**每一次退役会话都抛错**、旧任务继续跑，
  // 且只留下一行日志 —— 必须有登记期断言钉住（活 DSH 侧的实测见
  // scripts/test-dsh-session-retire.mjs）。
  'test-dsh-inbox-projection.mjs',
  // DSH 桌面版重启会换端口：自动发现的判据必须钉住（按进程筛候选 + settings/describe 验真），
  // 且写回 config.json 只能改 dsh.baseUrl（保留 BOM/其它字段）。判据若放松，恢复动作会变成「连错服务」。
  'test-dsh-discovery.mjs',
  'test-md-to-plain.mjs', 'test-slang-learn.mjs', 'test-mux-reconnect.mjs',
  'test-token-economy.mjs', 'test-qq-model-view.mjs', 'test-qq-preset-contract.mjs',
  'test-reply-wait.mjs', 'test-preset-prompt.mjs', 'test-role-card.mjs',
  // 长轮询（qq_wait_for_messages）租约：客户端中止后必须立刻归还，否则该会话
  // 15 分钟内的每一次等待都被 429「已有一个等待中」，AI 卡死在等待循环里。
  // 根因是 req 'close' 在 readBody() 读完请求体之后才挂上，永不触发。
  'test-wait-lease.mjs',
  // 归档门自愈：会话被 DSH 归档后每回合都在 agent/pre-step 被 reject 成
  // `reason.kind=blocked`（不开 step、不调模型、无 assistant/message），桥接原来
  // 只写一行「回合完成但无文本」→ QQ 侧永久静默。钉住：blocked 必须自动解归档
  // + 重投唤醒；不许算成「唤醒无行动」；重投有上限；正常回合后计数归零。
  'test-blocked-turn-recovery.mjs',
  // 长期记忆落盘：qq_append_memory 追加到「## 锚点」块末尾、去重、不越界到下一段
  'test-append-memory.mjs',
  // 隐私扫描器自身的回归：它 2026-10-22 前有两个**静默失效**的 bug
  // （规则不带 g → 同一处报 3 次且**后续命中全漏报**；纯数字被 isNoise 吃掉
  // →「QQ 号/群号」这条最重要的规则从没报过一次），外加 .gitignore 兜底与
  // allowPaths 前缀匹配两个坑。这个文件是发布前的安全闸门，必须有测试钉住。
  'test-privacy-scan.mjs',
  // 令牌账本 / 价目表 与 体检修复回归（纯函数，无外部依赖）
  'test-token-usage.mjs', 'test-hardening.mjs',
  // 语音发送（纯函数 + 端点存在性；真发语音只在 --live 或 CLI 里做）
  'test-voice.mjs',
  // 音量：参数校验 + 真的调用 ffmpeg 调音量 + 自算 RMS 验证增益
  'test-voice-volume.mjs',
  // 边界：并发/异常输入/上传限额/越权（纯函数段 + 可选的 live 段）
  'test-voice-edge.mjs',
  // 语音图形界面（参数解析/鉴权/路径穿越/文件名净化；live 段需普通终端）
  'test-voice-gui.mjs',
  // 控制台静态契约（跑不了 Playwright 的环境下的替代回归）
  'test-console-static.mjs',
  // 语音系统整体结构检查（入口/依赖/端点/开关/文档一致性）
  'test-voice-system.mjs',
  // SnowLuma 账号/token 自发现（换 QQ 账号后 token 会变，写死的工具会 401）
  'test-snowluma-conn.mjs',
  // 启动器与编码（乱码根因：.cmd 里的非 ASCII 会被 cmd 按 ANSI 解码）
  'test-encoding.mjs',
  // 控制台乱码机制（UTF-8 字节被按 GBK 解码）+ chcp 修复
  'test-console-encoding.mjs',
  // 🔴 铁律 L7（仿真会话不得拥有本地执行能力）：注册期断言——
  //    preset 挂了守卫、守卫的 restrict 名单覆盖全部已知本地工具、且执行期一律拒绝。
  //    这是唯一挡住"绕过桥接直连 OneBot HTTP"的东西（见 QSH_PLAN.md §0.1/§5.2），
  //    所以必须在每次回归里跑，而不是一次性验收。
  'test-preset-local-tools.mjs',
  // qq-mode-console 的 settings 契约：0.2.0 删除了 ctx.settings.register()，
  // 命名空间改为由 loader entry id + 导出的 Config 推导。断言三点前提都在，
  // 并且那条已删除的 API 不会被照旧注释加回来。
  'test-qq-mode-plugin.mjs',
  // MuMu 模拟器（emu-phone）插件化：这条钉住三件只能靠静态断言发现的事——
  //   ① DSH 的 serverName 模式是 /^[A-Za-z0-9_-]{1,32}$/，写成 'emu.phone' 之类
  //      会在**运行期**才被 mcp-client 拒绝（表现为「工具列表里少了这一组」，很隐蔽）；
  //   ② 工具名必须 /^[A-Za-z0-9_-]{1,64}$/ 且 emu_screenshot 等 9 个名字一个不少
  //      （改 jsonl 协议/换 sdk 版本时最容易静默掉工具）；
  //   ③ 插件包形态：cordis.patch.yml 的 entry id 必须等于命名空间 qq-emu-phone、
  //      Config 至少一个 .extra('volatile', true)（仓库钉的 schemastery 3.18.1 没有 .volatile()）。
  'test-qq-emu-phone.mjs',
  // 每日日记插件化：日记原先整块内嵌在 bridge.js 里（路径常量、保留分级、提示词、
  // 输出解析、会话存续），抽成 src/diary-core.js 后**两份实现漂移**是最大风险——
  // 桥接侧和插件侧读同一份 memory.md/items.jsonl，任何一侧改了 L1/L2/L3 保留天数或
  // 日期窗口，用户第二天就会看到日记条目被误删或被重复写入，而 QQ 侧毫无回执。
  // 这里还钉住：DIARY_DIR 只能有一个常量来源（曾经 bridge.js 与 mcp-snowluma-safe.js
  // 各写一份 D:\日记，MCP 侧四处在 2026-10-22 才改成 import），以及 chat-log.js 的
  // 归档目录必须挂在同一个 DIARY_DIR 下 —— 否则换库后日记搬了、对话记录没搬。
  'test-qq-diary.mjs',
  // QQ 空间（说说）插件化：qzone 工具**直连 OneBot**，绕过了桥接 outbound 端点里的
  // SENSITIVE_RE 审计，所以 qzoneGuard 是唯一一道出站门禁。抽到 src/qzone-core.js 后，
  // 若被谁改回 `QZONE_UGC_RIGHT[v] ?? 4` 那种静默回退，非法可见性会被**悄悄发成好友可见**，
  // 而 QQ 侧没有任何回执能暴露这件事 —— 只有单测能拦住。
  // 另外钉住：cordis.patch.yml 的 entry id 必须等于命名空间 qq-qzone；且
  // mcp-snowluma-safe.js 里 qzone-core 的 import 必须单行、schema 必须写字面量 1500/9
  // （test-audit-security-mcp.mjs 会逐行剥 import 再塞进 vm）。
  'test-qq-qzone.mjs',
  // SnowLuma 上游健康（被误诊成「qq-bridge 注入失败」的那个失败形态）：
  //   · good 必须取自心跳 status.good / get_status —— 取自 get_login_info 会**静默失效**
  //     （SDK 不校验 data 载荷，good 会永远停在 null，整条权威信号变成死分支）；
  //   · 静默检测不得冒充 hook 检测（心跳是 SnowLuma 本地定时器无条件发的）；
  //   · 客户端库版本不得低于 bot_status 出现的版本。
  'test-snowluma-upstream-health.mjs',
  // 历史补收（backfill）：Hook 僵死期间消息在推送层静默丢失，桥接只能靠 OneBot 历史接口补回来。
  // 这里钉的是纯函数部分（窗口/去重/排序/过滤自己发的）；集成点在 test-snowluma-upstream-health.mjs
  // 的恢复边沿断言里。
  'test-backfill.mjs',
  // 补收的接线回归（真跑 bridge.js，喂一段"丢失窗口"的 OneBot 历史）：
  // 纯函数测试证明不了它确实走的是 handleIncoming 的同一套入库/唤醒路径，
  // 而事故里坏掉的正是接线。
  'test-backfill-integration.mjs',
];
let failed = 0;
for (const test of tests) {
  console.log(`\nRunning ${test}`);
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', test)], {
    cwd: root, stdio: 'inherit', timeout: 60000,
    env: { ...process.env, QQ_BRIDGE_TEST_LIVE: '0' },
  });
  if (result.status !== 0 || result.error) {
    failed++;
    console.error(`FAILED ${test}: ${result.error?.message || `exit ${result.status}`}`);
  }
}
console.log(`\nAudit suite: ${tests.length - failed}/${tests.length} scripts passed.`);
process.exitCode = failed ? 1 : 0;
