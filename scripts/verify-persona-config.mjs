// 用 DSH 自身的 dsh-persona 配置 schema 校验修复后的 preset persona 配置。
// 说明：直接加载 DSH 安装目录里的模块做 schema 校验，不依赖 YAML 解析器版本，
// 也不需要 DSH 进程在跑。DSH 安装位置可用 DSH_INSTALL_MODULES 覆盖，未设置时自动探测。
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { dshModulesDir } from './dsh-modules.mjs';

const DSH_MODULES = dshModulesDir();

// DSH 0.2.1-rc.2 的 agent loop 只注册这两个提示词变量（见其 agent-loop 源码：
// ctx.systemPrompt.variable("provider" | "model", ...)）。模板里出现别的 {{name}}
// 会在每次组装提示词时抛 unknown prompt variable，整个回合在模型请求之前就失败。
// 0.2.0-rc.2 还注册过 {{cwd}}，0.2.1 起改为由工作目录服务以「不插值」的上下文提供。
const REGISTERED_TEMPLATE_VARS = new Set(['provider', 'model']);

const persona = await import(pathToFileURL(path.join(DSH_MODULES, '@deepseek-ai/dsh-persona/lib/index.js')).href);

let failed = 0;
function check(label, fn) {
  try { fn(); console.log(`  ✅ ${label}`); }
  catch (e) { console.log(`  ❌ ${label}: ${e?.message ?? e}`); failed += 1; }
}

console.log('persona Config schema 校验：\n');

// 旧写法（DSH 0.1.2 时代的 text 字段）—— 期望被拒绝
check('旧配置 {text} 被拒绝（复现原故障）', () => {
  let threw = false;
  try { persona.Config({ text: 'hello' }); } catch { threw = true; }
  if (!threw) throw new Error('旧配置竟然通过了校验，说明本次改动前提不成立');
});

// 新写法 —— 期望通过
check('新配置 {prefix} 通过（个人前缀）', () => {
  const v = persona.Config({ prefix: 'You are a coding agent powered by the {{model}} model.' });
  if (v.prefix.length === 0) throw new Error('prefix 为空');
});

check('新配置 {prefix, suffix} 通过（suffix 为普通文本，不引用模板变量）', () => {
  const v = persona.Config({
    prefix: 'You are a coding agent powered by the {{model}} model.',
    suffix: 'Keep replies short.',
  });
  if (v.suffix !== 'Keep replies short.') throw new Error('suffix 未保留');
  if (v.complete !== false) throw new Error('complete 默认值异常');
  if (v.includeRuntimeContext !== true) throw new Error('includeRuntimeContext 默认值异常');
});

// 校验仓库里两个 preset 的 persona 配置块
const YAML = await import(pathToFileURL(path.join(DSH_MODULES, 'js-yaml/index.js')).href);
const yaml = YAML.default ?? YAML;

for (const preset of ['qq-chat', 'qq-chat-v2']) {
  const file = path.resolve(process.cwd(), 'dsh/agent-presets', preset, 'agent.cordis.yml');
  console.log(`\n${preset} (${path.relative(process.cwd(), file)}):`);
  const doc = yaml.load(fs.readFileSync(file, 'utf8'));
  const row = doc.find((r) => r.id === 'persona');
  check('存在 persona 行', () => { if (!row) throw new Error('缺少 persona 行'); });
  check('persona 行名正确', () => {
    if (row.name !== '@deepseek-ai/dsh-persona') throw new Error(`name=${row.name}`);
  });
  check('persona.config 通过 DSH schema', () => { persona.Config(row.config); });
  check('保留了 {{model}} 变量', () => {
    if (!/\{\{model\}\}/.test(row.config.prefix)) throw new Error('prefix 缺少 {{model}}');
  });
  check('suffix 不引用 DSH 未注册的 {{cwd}}（0.2.1 起会炸组装）', () => {
    if (/\{\{cwd\}\}/.test(row.config.suffix ?? '')) {
      throw new Error('suffix 仍引用 {{cwd}}：DSH 0.2.1 不再注册该变量，提示词组装会失败');
    }
  });
  check('模板变量都在 agent loop 注册的白名单内', () => {
    const text = `${row.config.prefix}\n${row.config.suffix ?? ''}`;
    const used = [...text.matchAll(/\{\{([a-z][a-z0-9_]*)\}\}/g)].map((m) => m[1]);
    const unknown = [...new Set(used)].filter((name) => !REGISTERED_TEMPLATE_VARS.has(name));
    if (unknown.length > 0) throw new Error(`使用了未注册的提示词变量: ${unknown.join(', ')}`);
  });
  check('不再包含已废弃的 text 字段', () => {
    if (Object.hasOwn(row.config, 'text')) throw new Error('仍有 text 字段');
  });
  check('persona 正文（除头句）完整保留', () => {
    const body = row.config.prefix.split('\n').slice(1).join('\n');
    if (body.length < 500) throw new Error(`正文疑似丢失，仅 ${body.length} 字符`);
  });
}

console.log(failed === 0 ? '\n✅ 全部通过' : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
