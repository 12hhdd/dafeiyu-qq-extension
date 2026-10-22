/**
 * qq-diary —— 日记/长期记忆插件（DSH 0.2.0 bundle 形态）。
 *
 * 职责边界（这个插件最容易搞混的地方，先看这张表）：
 *   - **纯逻辑半边**：src/diary-core.js（本插件通过下面那行 import 直接复用）。
 *     路径拼装、日期串、items.jsonl 分级保留（L1 永久 / L2 10 天 / L3 3 天）、
 *     记忆块、后台写日记的提示词、模型输出解析 —— 全部无副作用、可单测。
 *   - **宿主半边**：src/bridge.js。建 workspace、开专用 DSH 会话、等模型回合、
 *     写 state/diary-session.json、把结果落盘到日记目录。这半离开 DSH 跑不了，
 *     所以不进这个包。
 *
 * 为什么插件里要 import core：0.2.0 下 apply() 是空操作（命名空间由 loader entry id
 * + 导出的 Config 推导，不再需要 register），插件本身没有活要干。但「插件只是空壳、
 * 真逻辑在别处」会让这个包没有任何可验证的真身 —— 所以这里把 core 的关键常量再导出，
 * 静态测试就能钉住「插件 ↔ 内核」这条 import 链没断（见 scripts/test-qq-diary.mjs）。
 *
 * 0.2.0 契约（三前提，缺一个设置面板里就看不到这个命名空间）：
 *   ① profile 的 loader entry id === 命名空间名（cordis.patch.yml 里 `- id: qq-diary`）
 *   ② 插件导出 Config（schemastery schema）
 *   ③ Config 至少有一个 volatile 字段（用 `.extra('volatile', true)`，**不是** `.volatile()`，
 *      schemastery ^3.18.1 没有那个方法）
 * 另注：0.1.x 的 `ctx.settings.register(ns, schema, opts)` 已删除，不要再写回来。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import z from '@deepseek-ai/schemastery';
// 相对包目录：plugins/qq-diary/lib/index.js → ../../../src/diary-core.js
import * as diaryCore from '../../../src/diary-core.js';

// 诊断日志：写临时目录，**不要**往仓库里爬相对层级建 state/（0.2.0 宿主不保证 cwd）。
const DIAG = process.env.QQ_DIARY_DIAG ?? path.join(os.tmpdir(), 'qq-diary-plugin.log');

function diag(msg) {
  if (!DIAG) return;
  try {
    fs.mkdirSync(path.dirname(DIAG), { recursive: true });
    fs.appendFileSync(DIAG, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

export const name = 'qq-diary';
export const inject = ['settings'];
// 死契约：必须与 cordis.patch.yml 的 `- id:` 完全一致。
export const DIARY_NAMESPACE = 'qq-diary';

// 把内核的关键常量/纯函数再导出，让这个包有可断言的「真身」。
export const DIARY_DIR = diaryCore.DIARY_DIR;
export const MEMORY_FILE = diaryCore.MEMORY_FILE;
export const DIARY_ITEMS_FILE = diaryCore.DIARY_ITEMS_FILE;
export const DIARY_RETENTION = diaryCore.DIARY_RETENTION;
export const DIARY_DEFAULTS = diaryCore.DIARY_DEFAULTS;
export const diaryCfg = diaryCore.diaryCfg;
export const diaryDateStr = diaryCore.diaryDateStr;
export const diaryPaths = diaryCore.diaryPaths;
export const cleanDiaryItems = diaryCore.cleanDiaryItems;
export const parseDiaryOutput = diaryCore.parseDiaryOutput;

export const Config = z.object({
  enabled: z.boolean()
    .description('是否启用日记功能；关闭后不再自动写日记，手动触发也会被拒绝。')
    .default(true)
    .extra('volatile', true),
  workspaceTitle: z.string()
    .description('日记专用 workspace 的标题。')
    .default('她的日记')
    .extra('volatile', true),
  timeOfDay: z.string()
    .description('每天几点自动写日记，HH:MM（24 小时制，按本机时区）。')
    .default('23:30')
    .extra('volatile', true),
  dir: z.string()
    .description('日记与长期记忆的存放目录；留空表示用默认的 D:\\日记。')
    .default('')
    .extra('volatile', true)
});

/**
 * 0.2.0 下 apply() 是空操作：命名空间由 loader entry id + 导出的 Config 推导，
 * 没有需要注册的东西。保留显式空实现 + 诊断日志，方便确认插件真的被加载过。
 */
export function apply(ctx) {
  diag(`apply called; settings service=${typeof ctx?.settings}; namespace=${DIARY_NAMESPACE} (0.2.0: no registration needed); diaryDir=${DIARY_DIR}`);
}
