// DSH 端点自动发现。
//
// 为什么需要它（这是一个真实踩过、且每次重启 DSH 都会复发的问题）：
// DSH 桌面版由 Electron 启动，**监听端口是启动时随机选的**（实测 5591 → 11172，教程里
// 还见过 19387）。桥接把地址写在 config.json 的 dsh.baseUrl，端口一变就只剩：
//   · 控制台「DSH 未连接 / 请检查 DSH 是否运行」
//   · 所有 QQ 消息只入队、永远不产生回合
//   · 日志每 3 秒一条「连接 DSH 事件流…」+「fetch failed」
// 而用户什么都没改。让人每次重启 DSH 都去翻 netstat / 任务管理器改 JSON，不是一个
// 能交付的交互方式。
//
// 本模块做两件事：
//   1. 扫本机监听端口，找出**真正的** DSH —— 判据是「能通过鉴权调通 settings/describe」，
//      而不是「端口开着」或「进程名像」。这很关键：本机上同时有 SnowLuma（3000/3001/
//      5099）、压缩代理（18787）、桥接自己（3100），按端口猜会连错服务。
//   2. 把确认可用的地址写回 config.json（可选；见 config 的 dsh.followDiscoveredEndpoint）。
//
// 边界（与 snowluma-conn.js 的 discoverSnowLumaConnection 保持一致的设计取向）：
//   · 只探**回环**地址。远程 DSH（dsh.allowRemote）不接受自动发现 —— 扫别人的机器
//     既没权限，也容易把完全无关的服务当成本机 DSH。
//   · 只在「配置的地址连不上」时才会被调用（见 bridge.js 的 checkDsh）。配置值能用时
//     一律尊重配置：用户可能故意指向第二个实例 / 另一份安装。
//   · 不做端口暴力扫描（1..65535）。Windows 上按进程名筛监听端口，进程名筛不出来时
//     就放弃（宁可不自愈，也不要盲扫全网卡超时几十秒）。

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { NodeApiClient, isLoopbackBase } from './dsh-client.js';

/** 单个候选端口的探测超时。短路失败的端口（没有监听/无关服务）通常几百毫秒就返回。 */
const DEFAULT_PROBE_TIMEOUT_MS = 2000;
/** 上限：候选太多时探测耗时线性增长，而真实 DSH 只可能有一个在跑。 */
const MAX_CANDIDATES = 12;
/**
 * 老默认端口（桥接历史上写死的 3080）。只作为兜底，排在所有动态候选之后。
 * 注意别把 SnowLuma 的 3000/3001 放进来 —— 那是另一个服务。
 */
const FALLBACK_PORTS = [3080];
/** 进程名匹配：桌面版叫 "DeepSeek Harness.exe"，也有 dsh / dsh-desktop 之类。 */
const DSH_PROCESS_RE = /deepseek|dsh/i;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function normalizeBaseUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const u = new URL(value.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/**
 * 解析 `netstat -ano` 的 TCP 监听行。
 *
 * 典型输出（Windows，注意本地地址可能是 0.0.0.0 / [::] / 127.0.0.1）：
 *   TCP    127.0.0.1:11172        0.0.0.0:0              LISTENING       53056
 *   TCP    [::]:11172             [::]:0                 LISTENING       53056
 *
 * @param {string} text - netstat 输出。
 * @returns {Array<{host:string, port:number, pid:number}>}
 */
export function parseNetstatListeners(text) {
  const out = [];
  const seen = new Set();
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const m = /^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(raw);
    if (!m) continue;
    const host = m[1].replace(/^\[|\]$/g, '');
    const port = Number(m[2]);
    const pid = Number(m[3]);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) continue;
    if (!Number.isInteger(pid) || pid <= 0) continue;
    // 只保留本机可达的监听：回环，或 bind 在全部网卡上（后者用 127.0.0.1 探）。
    const hostKey = host === '127.0.0.1' ? '127.0.0.1'
      : host === '0.0.0.0' || host === '::' || host === '::1' ? 'any'
        : null;
    if (!hostKey) continue;
    // 同一个 socket 可能同时以 IPv4/IPv6 两种形式出现在表里（Windows 双栈常见），
    // 按 (pid, port) 去重，避免同一个 DSH 被重复探测。
    const key = `${port}:${pid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ host: hostKey === 'any' ? '0.0.0.0' : host, port, pid });
  }
  return out;
}

/**
 * 从 `tasklist /FO CSV /NH` 输出里挑出「像 DSH」的进程 PID。
 *
 * 为什么按进程名筛而不是直接探所有监听端口：本机同时开着 SnowLuma、压缩代理、
 * 桥接控制台，盲探既慢又可能把别的服务当成 DSH。
 *
 * @param {string} csv - tasklist CSV 输出，形如 `"DeepSeek Harness.exe","53056","Console","1","123,456 K"`。
 * @returns {number[]}
 */
export function pickDshPids(csv) {
  const pids = [];
  for (const raw of String(csv ?? '').split(/\r?\n/)) {
    const m = /^"([^"]*)","(\d+)"/.exec(raw.trim());
    if (!m) continue;
    if (!DSH_PROCESS_RE.test(m[1])) continue;
    const pid = Number(m[2]);
    if (Number.isInteger(pid) && pid > 0 && !pids.includes(pid)) pids.push(pid);
  }
  return pids;
}

/** 读 Windows 当前 TCP 监听表与进程表；非 Windows / 命令不可用时返回空数组。 */
function windowsListenerSnapshot() {
  try {
    const netstatText = execFileSync('netstat', ['-ano', '-p', 'tcp'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true
    });
    let tasklistCsv = '';
    try {
      tasklistCsv = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true
      });
    } catch {
      // 拿不到进程名时退化为「只探配置里出现过的端口」，不要盲扫。
      tasklistCsv = '';
    }
    return { netstatText, tasklistCsv };
  } catch {
    return { netstatText: '', tasklistCsv: '' };
  }
}

/**
 * 从 netstat + tasklist 的原始输出里算出候选 baseUrl 列表（纯函数，便于测试）。
 *
 * @param {{netstatText?:string, tasklistCsv?:string}} snapshot
 * @returns {string[]} 形如 `http://127.0.0.1:<port>`，按端口升序。
 */
export function windowsDshBaseUrls({ netstatText = '', tasklistCsv = '' } = {}) {
  const listeners = parseNetstatListeners(netstatText);
  const dshPids = new Set(pickDshPids(tasklistCsv));
  if (dshPids.size === 0) return [];
  const ports = [...new Set(listeners.filter((l) => dshPids.has(l.pid)).map((l) => l.port))];
  ports.sort((a, b) => a - b);
  return ports.map((port) => `http://127.0.0.1:${port}`);
}

/**
 * 生成候选地址（按优先级排序、去重）。
 *
 * 顺序：配置值（如果用户写的其实是新端口，先试它最省事）→ DSH_BASE_URL 环境变量
 * （手工/脚本接线用）→ 上次成功发现的地址（state/dsh-endpoint.json）→ 老默认端口 →
 * 本机 DSH 进程正在监听的端口。
 *
 * 只保留**回环**地址：远程 DSH 不自动发现（见文件头）。
 *
 * @param {object} options
 * @param {string} [options.configured] - config.json 的 dsh.baseUrl。
 * @param {string[]} [options.extra] - 额外候选（如持久化的历史地址），排在前面的优先。
 * @param {string} [options.envBaseUrl] - 环境变量覆盖。
 * @param {{netstatText?:string, tasklistCsv?:string}} [options.snapshot] - 已采集的监听快照。
 * @returns {Array<{url:string, source:string}>}
 */
export function dshBaseUrlCandidates({
  configured = '',
  extra = [],
  envBaseUrl = '',
  snapshot = null,
  platform = process.platform
} = {}) {
  const out = [];
  const seen = new Set();
  const add = (raw, source) => {
    const url = normalizeBaseUrl(raw);
    if (!url || !isLoopbackBase(url)) return;
    if (seen.has(url)) return;
    seen.add(url);
    if (out.length >= MAX_CANDIDATES) return;
    out.push({ url, source });
  };
  add(configured, 'config.json');
  add(envBaseUrl, 'DSH_BASE_URL');
  for (const url of Array.isArray(extra) ? extra : []) add(url, '上次发现');
  for (const port of FALLBACK_PORTS) add(`http://127.0.0.1:${port}`, 'DSH 老默认端口');
  if (platform === 'win32') {
    const snap = snapshot ?? windowsListenerSnapshot();
    for (const url of windowsDshBaseUrls(snap)) add(url, 'DSH 进程监听端口');
  }
  return out;
}

/**
 * 探测一个地址是不是**真的 DSH**：能鉴权调通 `settings/describe` 才算。
 *
 * 用这个 RPC 而不是「端口能不能连」：DSH 有鉴权，非 DSH 服务会把请求回成 404/405
 * 或非协议响应；`settings/describe` 需要合法 Cookie，正常返回 settings 对象。
 *
 * @param {string} baseUrl
 * @param {object} [options]
 * @param {object} [options.auth] - 透传给 NodeApiClient 的鉴权配置（token/header/prefix）。
 * @param {number} [options.timeoutMs]
 * @param {Function} [options.probe] - 测试注入：`(url, opts) => Promise<boolean>`。
 * @returns {Promise<boolean>}
 */
export async function probeDshEndpoint(baseUrl, { auth = {}, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS, probe = null } = {}) {
  const url = normalizeBaseUrl(baseUrl);
  if (!url) return false;
  if (typeof probe === 'function') return (await probe(url, { auth, timeoutMs })) === true;
  try {
    const client = new NodeApiClient(url, timeoutMs, { ...auth, allowRemote: false });
    await client.callUnary('settings.describe', {});
    return true;
  } catch {
    return false;
  }
}

/**
 * 找出当前真正在跑的 DSH。
 *
 * @param {object} options
 * @param {string} [options.configured] - 配置的地址（会先试；能用就直接返回它）。
 * @param {object} [options.auth] - DSH 鉴权配置。
 * @param {string[]} [options.extra] - 额外候选。
 * @param {string} [options.envBaseUrl]
 * @param {object} [options.snapshot] - 监听快照（测试用）。
 * @param {number} [options.timeoutMs]
 * @param {Function} [options.probe]
 * @param {string} [options.platform]
 * @returns {Promise<{ok:boolean, baseUrl:string|null, source:string|null,
 *                    tried:Array<{url:string, source:string, ok:boolean}>,
 *                    skipped?:string}>}
 */
export async function discoverDshBaseUrl({
  configured = '',
  auth = {},
  extra = [],
  envBaseUrl = '',
  snapshot = null,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  probe = null,
  platform = process.platform
} = {}) {
  const configuredUrl = normalizeBaseUrl(configured);
  // 配置的是非回环地址（远程 DSH）：不自动发现。见文件头「边界」。
  if (configuredUrl && !isLoopbackBase(configuredUrl)) {
    return { ok: false, baseUrl: null, source: null, tried: [], skipped: '配置的是非本机地址' };
  }
  const candidates = dshBaseUrlCandidates({ configured, extra, envBaseUrl, snapshot, platform });
  const tried = [];
  for (const c of candidates) {
    const ok = await probeDshEndpoint(c.url, { auth, timeoutMs, probe });
    tried.push({ url: c.url, source: c.source, ok });
    if (ok) return { ok: true, baseUrl: c.url, source: c.source, tried };
  }
  return { ok: false, baseUrl: null, source: null, tried };
}

/**
 * 把发现到的 DSH 地址写回 config.json，只改 `dsh.baseUrl`，其它字段与文件编码原样保留。
 *
 * 与 snowluma-conn.js 的 persistSnowLumaEndpoint 保持一致的行为：
 *   · 值没变就不写文件（幂等，也避免把用户的文件改成「整文件重写」）；
 *   · 保留 UTF-8 BOM —— 用户常用的 Windows 编辑器会写 BOM，吞掉它是字节级静默改动。
 *
 * @param {string} cfgPath - config.json 路径。
 * @param {string} baseUrl - 确认可用的地址。
 * @returns {{updated:boolean, from:string|null, to:string}}
 */
export function persistDshEndpoint(cfgPath, baseUrl) {
  const to = normalizeBaseUrl(baseUrl);
  if (!to) throw new Error(`不是合法的 DSH 地址：${baseUrl}`);
  let text = fs.readFileSync(cfgPath, 'utf8');
  const hadBom = text.charCodeAt(0) === 0xFEFF;
  if (hadBom) text = text.slice(1);
  const cfg = JSON.parse(text);
  if (!isPlainObject(cfg)) throw new Error(`config.json 顶层不是对象：${cfgPath}`);
  if (!isPlainObject(cfg.dsh)) cfg.dsh = {};
  const from = typeof cfg.dsh.baseUrl === 'string' && cfg.dsh.baseUrl ? cfg.dsh.baseUrl : null;
  if (from === to) return { updated: false, from, to };
  cfg.dsh.baseUrl = to;
  const serialized = `${JSON.stringify(cfg, null, 2)}\n`;
  fs.writeFileSync(cfgPath, hadBom ? `\uFEFF${serialized}` : serialized, 'utf8');
  return { updated: true, from, to };
}
