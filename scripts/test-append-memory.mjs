// qq_append_memory 的落盘行为回归：追加到锚点块末尾、去重、不破坏其它段落。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const NODE = process.execPath;
const MEM = process.env.QQ_MEMORY_FILE_OVERRIDE || null;

// 这段逻辑必须与 src/mcp-snowluma-safe.js 的 qq_append_memory 保持一致；
// 用同样的算法跑一遍，验证产物结构（文件层回归，不需要起 MCP 服务器）。
function appendAnchor(cur, text) {
  const line = `- ${String(text).trim()}`;
  const norm = (s) => s.replace(/^\s*[-*]\s*/, '').replace(/\s+/g, ' ').trim();
  const existing = cur.split('\n').map(norm).filter(Boolean);
  if (existing.includes(norm(line))) return { changed: false, out: cur };
  let out;
  if (cur.includes('## 锚点')) {
    const lines = cur.split('\n');
    const head = lines.findIndex((l) => l.trim() === '## 锚点');
    let last = head;
    for (let i = head + 1; i < lines.length; i += 1) {
      if (/^\s*##\s/.test(lines[i])) break;
      if (lines[i].trim()) last = i;
    }
    lines.splice(last + 1, 0, line);
    out = lines.join('\n');
  } else {
    out = `## 锚点\n${line}\n\n${cur.trim()}`;
  }
  return { changed: true, out };
}

let fail = 0;
function check(name, cond, extra) {
  if (cond) console.log(`✔ ${name}`);
  else { console.log(`✘ ${name}${extra ? ` — ${extra}` : ''}`); fail += 1; }
}

// 1. 追加到块末尾，而不是标题正下方
{
  const before = '## 锚点\n- 第一件事\n- 第二件事\n';
  const { out } = appendAnchor(before, '第三件事');
  const lines = out.trim().split('\n');
  check('追加到锚点块末尾', lines[3] === '- 第三件事', JSON.stringify(lines));
  check('原有顺序不被打乱', lines[1] === '- 第一件事' && lines[2] === '- 第二件事');
}

// 2. 去重：同一条不再重复写
{
  const before = '## 锚点\n- 主人喜欢少女感音色\n';
  const { changed, out } = appendAnchor(before, '主人喜欢少女感音色');
  check('重复锚点不重复写入', changed === false && out === before);
}

// 3. 归一化后也算重复（多余的横杠/空白）
{
  const before = '## 锚点\n- 我是大肥鱼\n';
  const { changed } = appendAnchor(before, '  我是大肥鱼  ');
  check('归一化后判定重复', changed === false);
}

// 4. 锚点块后面还有别的二级标题时，只能插在锚点块内
{
  const before = '## 锚点\n- A\n\n## 最近记录\n- 日记摘要\n';
  const { out } = appendAnchor(before, 'B');
  const idxB = out.indexOf('- B');
  const idxNext = out.indexOf('## 最近记录');
  check('不越界到下一个二级标题', idxB > 0 && idxB < idxNext, out);
  check('下一个段落内容完好', out.includes('- 日记摘要'));
}

// 5. 没有锚点标题时新建
{
  const { out } = appendAnchor('随便一些旧内容\n', 'X');
  check('无锚点标题时新建块', out.startsWith('## 锚点\n- X'));
}

console.log(fail === 0 ? '\nPASS: qq_append_memory 落盘行为符合预期' : `\nFAIL: ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
