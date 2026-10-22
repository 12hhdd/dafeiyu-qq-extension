// privacy-scan 的回归测试。
//
// 为什么需要它：这个文件是**发布前的安全闸门**，而它自己在 2026-10-22 之前
// 有两个静默失效的 bug，谁都没发现：
//   1. 规则不带 `g` → `lastIndex` 永远停在 0 → 同一处泄漏被报 3 次，
//      而该文件里**它之后的命中全部漏报**（安全缺陷，不只是噪音）；
//   2. `isNoise` 的 `/^[A-Z0-9_]+$/` 把纯数字判成"常量名" → 「QQ 号/群号」
//      这条规则**从来没报过一次**（最重要的那条规则完全失效）。
// 还有两个兜底路径也踩过坑：
//   3. `.gitignore` 兜底匹配把 `^…$` 嵌进 `(?:^|/)…$`，basename 规则（`*.bak-*`）
//      全部失效，备份文件被当待扫文件；
//   4. `allowPaths` 是**前缀**匹配，`src/bridge.js` 会连带放行 `src/bridge.js.bak-*`。
//
// 跑法：node scripts/test-privacy-scan.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const SCANNER = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'privacy-scan.mjs');

/**
 * 造一个临时"仓库"：把真的 privacy-scan.mjs 拷进 scripts/，
 * 这样 ROOT 就是这个临时目录，扫描的是我们构造的最小 fixture。
 */
function makeRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbridge-privacy-'));
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  // 真脚本一行不改地拷过去 —— 测的必须是**生产代码本身**，不能是复刻的逻辑
  fs.copyFileSync(SCANNER, path.join(dir, 'scripts', 'privacy-scan.mjs'));
  if (files['.gitignore'] !== undefined) {
    fs.writeFileSync(path.join(dir, '.gitignore'), files['.gitignore'], 'utf8');
  }
  for (const [rel, content] of Object.entries(files)) {
    if (rel === '.gitignore') continue;
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  return dir;
}

function scan(dir) {
  try {
    const stdout = execFileSync(process.execPath, [path.join(dir, 'scripts', 'privacy-scan.mjs')], {
      encoding: 'utf8', cwd: dir, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out: stdout };
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录，删不掉也没关系 */ }
}

test('真实 QQ 号必须被报（bug B 回归：纯数字曾被当成常量名过滤）', () => {
  const dir = makeRepo({ 'a.mjs': 'const owner = 987654321;\n' });
  try {
    const r = scan(dir);
    assert.equal(r.code, 1, '有真实号码时必须失败');
    assert.match(r.out, /QQ 号\/群号/);
    assert.match(r.out, /a\.mjs/);
  } finally { cleanup(dir); }
});

test('同一文件里的第二处泄漏也必须被报（bug A 回归：3 次上限曾被重复命中吃满）', () => {
  // 老 bug：规则没带 `g` → exec 的 lastIndex 永远停在 0 → **同一处**匹配被反复返回，
  // 靠 `hits < 3` 才停下。后果是同一行被报 3 次，而它**后面**的命中永远报不出来。
  //
  // 所以这条用例必须让同一规则在一个文件里出现**两次不同命中**：
  // 带 bug 时只会看到第一处（重复 3 次），第二处永远不出现。
  // （我第一版只放了一个号码，带 bug 也能过，属于无效用例。）
  const dir = makeRepo({
    'a.mjs': 'const owner = 987654321;\nconst other = 987654322;\n',
  });
  try {
    const r = scan(dir);
    assert.equal(r.code, 1);
    // 注意：输出是**脱敏后**的（`*********`），不能断言号码本身出现在 stdout 里。
    const hits = r.out.split('\n').filter((l) => l.includes('[content]'));
    assert.equal(hits.length, 2, `同一规则的两处命中都该报（带 bug 时只会报 1 处），实际 ${hits.length} 处：\n${hits.join('\n')}`);
  } finally { cleanup(dir); }
});

test('出厂默认日记目录被 allowLiterals 豁免，但同一文件里别的盘路径照报', () => {
  // 注意转义层次：JS 字面量里写 `\\` 才会在**被测文件里**得到单个反斜杠，
  // 而路径规则只认单反斜杠形态。多转义一层会造出 `D:\\日记\\` 这种非路径文本，
  // 于是「0 命中」被误当成「豁免生效」——这个坑我踩过一次。
  const dir = makeRepo({
    'a.mjs': 'const a = "D:\\日记\\memory.md";\nconst b = "E:\\别人的资料\\秘密\\";\n',
  });
  try {
    const r = scan(dir);
    assert.equal(r.code, 1, 'E 盘那条必须被报');
    const hits = r.out.split('\n').filter((l) => l.includes('[content]'));
    assert.equal(hits.length, 1, `只该报 1 处，实际 ${hits.length} 处：\n${hits.join('\n')}`);
  } finally { cleanup(dir); }
});

test('.gitignore 的 basename 规则在目录遍历兜底模式下也生效（*.bak-* 回归）', () => {
  // 备份文件里放着真实号码：它被 .gitignore 排除，就不该被扫（也不该被 denyFiles 报）。
  //
  // ⚠️ 文件必须放在**子目录**里，否则这条用例抓不到当年的 bug：
  // 老的匹配器生成 `(?:^|/)^[^/]*\.bak-[^/]*$$`，根目录下的文件仍能从位置 0
  // 命中那个多余的 `^`，只有子目录（前面多了 `/`）才会真的永不匹配。
  // 我第一版就写在根目录，变异验证时没能变红。
  const dir = makeRepo({
    '.gitignore': '*.bak\n*.bak-*\n*.log\n',
    'a.mjs': 'const ok = 1;\n',
    'src/a.mjs.bak-old': 'const leaked = 987654321;\n',
    'deep/nest/b.log': 'const leaked2 = 987654322;\n',
  });
  try {
    const r = scan(dir);
    assert.equal(r.code, 0, `被 ignore 的备份/日志文件不该被扫，但报错了：\n${r.out}`);
    assert.doesNotMatch(r.out, /bak-old|b\.log/, '被 .gitignore 排除的文件不该出现在结果里');
  } finally { cleanup(dir); }
});

test('allowRules 只放过指定规则，同文件其它规则照查（bridge.js 盲区回归）', () => {
  // 以前为了放过 bridge.js 里的 3 条误报，只能用 allowPaths 把 12000 行的核心文件
  // **整份**排除在扫描之外 —— 等于开个大盲区。allowRules 必须做到：
  // 放过的规则不报，同文件里**其它**规则的命中照报。
  const dir = makeRepo({
    'scripts/privacy-rules.json': JSON.stringify({
      allowRules: [{ path: 'src/thing.js', rule: '本机绝对路径（非系统盘的顶层目录）' }],
    }),
    'src/thing.js': 'const p = "D:\\...\\";\nconst q = "C:\\Users\\somebody\\Desktop\\";\n',
  });
  try {
    const r = scan(dir);
    assert.equal(r.code, 1, '同文件里没被豁免的规则必须照样失败');
    const hits = r.out.split('\n').filter((l) => l.includes('[content]'));
    assert.equal(hits.length, 1, `该报 1 处（用户目录那条），实际 ${hits.length} 处：\n${hits.join('\n')}`);
    assert.match(hits[0], /Windows 用户目录/);
    assert.doesNotMatch(r.out, /非系统盘的顶层目录/);
  } finally { cleanup(dir); }
});

test('--json 输出可机读，且仍以退出码表达结果', () => {
  const dir = makeRepo({ 'a.mjs': 'const owner = 987654321;\n' });
  try {
    let out = '';
    let code = 0;
    try {
      out = execFileSync(process.execPath, [path.join(dir, 'scripts', 'privacy-scan.mjs'), '--json'], {
        encoding: 'utf8', cwd: dir, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      code = error.status ?? 1;
      out = `${error.stdout ?? ''}`;
    }
    assert.equal(code, 1);
    // --json 是整段 pretty-print 的**一个**对象（不是 NDJSON），直接整体 parse。
    const parsed = JSON.parse(out);
    assert.ok(Array.isArray(parsed.findings), `--json 必须给出 findings 数组：${out.slice(0, 200)}`);
    assert.equal(parsed.findings.length, 1);
    assert.match(JSON.stringify(parsed.findings[0]), /QQ 号\/群号/);
  } finally { cleanup(dir); }
});
