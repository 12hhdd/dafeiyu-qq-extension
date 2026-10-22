// DSH 端点自动发现回归测试（纯函数 + 可注入探测，不依赖真实 DSH）。
//
// 为什么必须有登记期断言：
//   · 这个功能的价值全在「判据准确」——按进程名/端口猜会连到 SnowLuma、压缩代理或
//     桥接自己的控制台上。真正的判据是「能鉴权调通 settings/describe」，这里用注入的
//     probe 把这个契约钉住；
//   · 另一个高危点是**写回 config.json**：写错字段、吞掉 BOM、把用户文件整份重排，
//     都是对用户文件的静默破坏。persistDshEndpoint 有独立断言。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  dshBaseUrlCandidates,
  discoverDshBaseUrl,
  parseNetstatListeners,
  persistDshEndpoint,
  pickDshPids,
  probeDshEndpoint,
  windowsDshBaseUrls
} from '../src/dsh-discovery.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail += 1; console.error(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
};

// netstat -ano -p tcp 的真实形状（含回环、全零绑定、IPv6、以及非 LISTENING 行）
const NETSTAT = `
  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       15400
  TCP    127.0.0.1:3100         0.0.0.0:0              LISTENING       49964
  TCP    0.0.0.0:3001           0.0.0.0:0              LISTENING       15400
  TCP    127.0.0.1:11172        0.0.0.0:0              LISTENING       53056
  TCP    [::]:11172             [::]:0                 LISTENING       53056
  TCP    127.0.0.1:18787        0.0.0.0:0              LISTENING       47476
  TCP    192.168.1.20:139       0.0.0.0:0              LISTENING       4
  TCP    127.0.0.1:3100         127.0.0.1:52344        ESTABLISHED     49964
`;
const TASKLIST = `
"DeepSeek Harness.exe","53056","Console","1","412,340 K"
"D:\\SnowLuma\\node.exe","15400","Console","1","96,120 K"
"node.exe","49964","Console","1","120,004 K"
"chrome.exe","900","Console","1","40,000 K"
`;

console.log('parseNetstatListeners');
{
  const listeners = parseNetstatListeners(NETSTAT);
  const ports = listeners.map((l) => l.port);
  ok(listeners.length === 5, '只取 TCP LISTENING 行', `解析到 ${listeners.length} 条`);
  ok(!ports.includes(139), '跳过绑在真实网卡上的监听（不做全网卡试探）');
  ok(ports.filter((p) => p === 11172).length === 1, '同一端口的 IPv4/IPv6 双监听去重成一条');
  ok(listeners.some((l) => l.port === 11172 && l.pid === 53056), '保留 pid（后面用它筛进程）');
  ok(listeners.every((l) => l.pid !== 900), 'ESTABLISHED 行（两端都带端口）不会被当成监听');
}

console.log('pickDshPids');
{
  const pids = pickDshPids(TASKLIST);
  ok(pids.includes(53056), '认得出 "DeepSeek Harness.exe"');
  ok(!pids.includes(49964), '不会把桥接自己的 node.exe 当成 DSH');
  ok(!pids.includes(15400), '不会把 SnowLuma 的 node.exe 当成 DSH');
  ok(pids.length === 1, '只留下 DSH 进程', `${pids.join(',')}`);
}

console.log('windowsDshBaseUrls');
{
  const urls = windowsDshBaseUrls({ netstatText: NETSTAT, tasklistCsv: TASKLIST });
  ok(urls.length === 1 && urls[0] === 'http://127.0.0.1:11172', '只返回 DSH 进程的监听端口', urls.join(' '));
  ok(windowsDshBaseUrls({ netstatText: NETSTAT, tasklistCsv: '' }).length === 0, '拿不到进程表时不盲猜端口');
}

console.log('dshBaseUrlCandidates');
{
  const snapshot = { netstatText: NETSTAT, tasklistCsv: TASKLIST };
  const list = dshBaseUrlCandidates({
    configured: 'http://127.0.0.1:5591',
    envBaseUrl: 'http://127.0.0.1:3300',
    extra: ['http://127.0.0.1:11172', 'http://127.0.0.1:5591'],
    snapshot
  });
  const urls = list.map((c) => c.url);
  ok(urls[0] === 'http://127.0.0.1:5591', '配置值排第一（用户写的可能就是新端口，先试最省事）');
  ok(urls.includes('http://127.0.0.1:3300'), 'DSH_BASE_URL 环境变量进候选');
  ok(urls.includes('http://127.0.0.1:11172'), '历史地址 / 进程监听端口进候选');
  ok(urls.length === new Set(urls).size, '候选去重');
  const nonLoopback = dshBaseUrlCandidates({ configured: 'http://10.0.0.5:3080', snapshot: { netstatText: '', tasklistCsv: '' } });
  ok(!nonLoopback.some((c) => c.url.includes('10.0.0.5')), '非回环地址不作为候选（不探别人机器）');
}

console.log('discoverDshBaseUrl（注入 probe，不碰真实端口）');
{
  const snapshot = { netstatText: NETSTAT, tasklistCsv: TASKLIST };
  const probed = [];
  const probe = async (url) => { probed.push(url); return url === 'http://127.0.0.1:11172'; };
  const r = await discoverDshBaseUrl({
    configured: 'http://127.0.0.1:5591',
    extra: [],
    snapshot,
    probe
  });
  ok(r.ok === true && r.baseUrl === 'http://127.0.0.1:11172', '找到真正在跑的 DSH', r.baseUrl ?? JSON.stringify(r.tried));
  ok(r.tried[0].url === 'http://127.0.0.1:5591' && r.tried[0].ok === false, '先试配置地址，失败了才继续');
  ok(probed.every((u) => u.startsWith('http://127.0.0.1:')), '只探回环地址');
  ok(r.tried.every((t, i) => i === 0 || t.url !== r.tried[0].url), '候选按顺序逐条试');

  const none = await discoverDshBaseUrl({ configured: 'http://127.0.0.1:5591', snapshot, probe: async () => false });
  ok(none.ok === false && none.tried.length > 0, '全都不通时返回 ok=false 且给出试过的列表');

  const remote = await discoverDshBaseUrl({ configured: 'http://10.0.0.5:3080', snapshot, probe: async () => true });
  ok(remote.ok === false && remote.skipped, '配置的是远程 DSH 时跳过自动发现', remote.skipped ?? '');

  let calls = 0;
  const first = await discoverDshBaseUrl({ configured: 'http://127.0.0.1:11172', snapshot: { netstatText: '', tasklistCsv: '' }, probe: async () => { calls += 1; return true; } });
  ok(first.ok && calls === 1, '配置地址可用时只探一次就返回（不扫端口）');
}

console.log('probeDshEndpoint 判据');
{
  ok(await probeDshEndpoint('http://127.0.0.1:11172', { probe: async () => true }) === true, 'probe 返回 true → 认为是 DSH');
  ok(await probeDshEndpoint('http://127.0.0.1:11172', { probe: async () => false }) === false, 'probe 返回 false → 不认');
  ok(await probeDshEndpoint('not a url', { probe: async () => true }) === false, '非法地址直接 false');
}

console.log('persistDshEndpoint');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbridge-dsh-endpoint-'));
  try {
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, `${JSON.stringify({
      dsh: { baseUrl: 'http://127.0.0.1:5591', model: 'deepseek-flash' },
      allow: { groups: ['10000003'] }
    }, null, 2)}\n`, 'utf8');
    const r = persistDshEndpoint(file, 'http://127.0.0.1:11172');
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    ok(r.updated === true && r.from === 'http://127.0.0.1:5591' && r.to === 'http://127.0.0.1:11172', '只改 dsh.baseUrl');
    ok(after.dsh.baseUrl === 'http://127.0.0.1:11172' && after.dsh.model === 'deepseek-flash', '其它 dsh 字段原样保留');
    ok(JSON.stringify(after.allow) === JSON.stringify({ groups: ['10000003'] }), 'dsh 之外的配置原样保留');
    const again = persistDshEndpoint(file, 'http://127.0.0.1:11172');
    ok(again.updated === false, '值没变时不写文件（幂等）');

    // BOM：Windows 编辑器常写 BOM，吞掉它是字节级静默改动。
    const bomFile = path.join(dir, 'bom.json');
    fs.writeFileSync(bomFile, `\uFEFF${JSON.stringify({ dsh: { baseUrl: 'http://127.0.0.1:3080' } }, null, 2)}\n`, 'utf8');
    persistDshEndpoint(bomFile, 'http://127.0.0.1:11172');
    const bomText = fs.readFileSync(bomFile, 'utf8');
    ok(bomText.charCodeAt(0) === 0xFEFF, '保留 UTF-8 BOM');
    ok(JSON.parse(bomText.slice(1)).dsh.baseUrl === 'http://127.0.0.1:11172', 'BOM 文件内容仍可解析');

    let threw = false;
    try { persistDshEndpoint(file, 'ftp://127.0.0.1:11172'); } catch { threw = true; }
    ok(threw, '非法协议拒绝写回');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// 静态契约：桥接里真的接上了这条自愈链路，而不是只写了个没人调用的模块。
console.log('bridge.js 接线');
{
  const src = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  ok(/from '\.\/dsh-discovery\.js'/.test(src), 'bridge.js 引入 dsh-discovery');
  ok(/maybeDiscoverDshEndpoint\(\)/.test(src), 'checkDsh 里会在连不上时尝试自动发现');
  ok(/followDiscoveredEndpoint/.test(src), '提供 config 开关 dsh.followDiscoveredEndpoint');
  ok(/api\.baseUrl = nextBaseUrl/.test(src) && /api\.invalidateAuth\(\)/.test(src), '切换地址时会重铸 Cookie（Cookie 名绑定 authority）');
}

console.log(`\n${fail === 0 ? '✅' : '❌'} dsh-discovery: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
