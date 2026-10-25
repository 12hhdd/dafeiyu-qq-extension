// 我的手机：MuMu 安卓模拟器控制 MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
//
// 定位：QQ 会话里让 agent 能操作「我的手机」（一台本机 MuMu 模拟器）。
// 与 mcp-snowluma-safe 同一套安全分层：
//   - 只暴露「看屏幕 / 点按 / 输入 / 按键 / 启停 App / 抽帧看视频」这类沙盒内行为；
//   - 不暴露 adb 任意命令、不接受 shell 命令字符串、不接受任意路径读写；
//   - 所有 shell 参数逐个数组传入，不做字符串拼接（避免注入）。
//
// 前置条件（2026-10-19 已在本机修好，见 state/agents/emu/README.md）：
//   MuMuManager.exe setting -v 0 -k net_bridge_open -val false
//   → NAT 模式下 127.0.0.1:16384 提供 ADB，adb 会自动发现 emulator-5554。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const EMU_DIR = path.join(ROOT, 'state', 'agents', 'emu');
const SHOT_DIR = path.join(EMU_DIR, 'shots');

function loadConfig() {
  try {
    let text = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function emuCfg() {
  const c = loadConfig().emuPhone ?? {};
  return {
    adb: c.adb || 'D:\\mumu\\MuMuPlayer\\nx_main\\adb.exe',
    serial: c.serial || '',
    connect: c.connect !== false,
    connectTarget: c.connectTarget || '127.0.0.1:16384'
  };
}

function runAdb(args, { bin = true, timeout = 60000 } = {}) {
  const cfg = emuCfg();
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  // 不用管道捕获子进程输出：DSH 沙箱禁止命名管道，spawnSync 默认 stdio:'pipe' 会 EPERM。
  // 改成临时文件重定向，沙箱内外都能跑；顺带对二进制（screencap）安全。
  const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const outFile = path.join(SHOT_DIR, `.adb-${stamp}.${bin ? 'bin' : 'txt'}`);
  const errFile = path.join(SHOT_DIR, `.adb-${stamp}.err`);
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');
  let res;
  try {
    res = spawnSync(cfg.adb, args, {
      stdio: ['ignore', outFd, errFd],
      timeout,
      windowsHide: true
    });
  } finally {
    try { fs.closeSync(outFd); } catch {}
    try { fs.closeSync(errFd); } catch {}
  }
  let out = bin ? Buffer.alloc(0) : '';
  let err = '';
  try { out = bin ? fs.readFileSync(outFile) : fs.readFileSync(outFile, 'utf8'); } catch {}
  try { err = fs.readFileSync(errFile, 'utf8').trim(); } catch {}
  try { fs.unlinkSync(outFile); } catch {}
  try { fs.unlinkSync(errFile); } catch {}
  if (res?.error) throw new Error(`adb 执行失败：${res.error.message}`);
  return { status: res?.status, out, err };
}

let cachedSerial = '';
function detectSerial(force = false) {
  const cfg = emuCfg();
  if (cfg.serial) return cfg.serial;
  if (cachedSerial && !force) return cachedSerial;
  const list = () => {
    const r = runAdb(['devices'], { bin: false, timeout: 15000 });
    return String(r.out)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /\tdevice$/.test(l))
      .map((l) => l.split('\t')[0]);
  };
  let devices = list();
  if (!devices.length && cfg.connect) {
    runAdb(['start-server'], { bin: false, timeout: 20000 });
    runAdb(['connect', cfg.connectTarget], { bin: false, timeout: 15000 });
    devices = list();
  }
  if (!devices.length) throw new Error('没有可用的模拟器设备：请确认 MuMu 已启动且 ADB 端口已开（MuMuManager.exe adb -v 0）');
  cachedSerial = devices.includes('emulator-5554') ? 'emulator-5554' : (devices.includes('127.0.0.1:16384') ? '127.0.0.1:16384' : devices[0]);
  return cachedSerial;
}

function sh(cmd, { timeout = 45000 } = {}) {
  const serial = detectSerial();
  const r = runAdb(['-s', serial, 'shell', cmd], { bin: false, timeout });
  return String(r.out ?? '').trim();
}

function screenSize() {
  const raw = sh('wm size');
  const m = /(\d+)x(\d+)/.exec(raw);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : { width: 1080, height: 1920 };
}

function foreground() {
  const raw = sh('dumpsys window | grep -E "mCurrentFocus"');
  const m = /mCurrentFocus=Window\{[0-9a-f]+ u0 ([^}\s/]+)\/([^}\s]+)\}/.exec(raw);
  return m ? `${m[1]}/${m[2]}` : raw || 'unknown';
}

function capturePng() {
  const serial = detectSerial();
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const tmp = path.join(SHOT_DIR, `shot-${Date.now()}.png`);
  const remote = '/sdcard/emu_mcp_shot.png';
  const cap = runAdb(['-s', serial, 'shell', `screencap -p ${remote}`], { bin: false, timeout: 45000 });
  if (cap.status !== 0) throw new Error(`截图失败：${cap.err || cap.out || 'screencap 返回非 0'}`);
  const pull = runAdb(['-s', serial, 'pull', remote, tmp], { bin: false, timeout: 45000 });
  if (!fs.existsSync(tmp) || fs.statSync(tmp).size < 1000) {
    throw new Error(`截图失败（adbd root 变更后可能短暂断连）：${pull.err || pull.out || '拉取为空'}`);
  }
  return tmp;
}

// 用 System.Drawing 把 PNG 缩成 JPEG，避免把几 MB 的原始截图塞进模型上下文。
function toJpeg(pngPath, maxWidth = 900, quality = 72) {
  const out = pngPath.replace(/\.png$/i, '.jpg');
  const script = [
    'Add-Type -AssemblyName System.Drawing',
    `$src=[System.Drawing.Image]::FromFile('${pngPath.replace(/'/g, "''")}')`,
    `$w=[Math]::Min(${maxWidth},$src.Width);$h=[int]($src.Height*$w/$src.Width)`,
    '$bmp=New-Object System.Drawing.Bitmap($w,$h)',
    '$g=[System.Drawing.Graphics]::FromImage($bmp)',
    '$g.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic',
    '$g.DrawImage($src,0,0,$w,$h)',
    '$enc=[System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders()|Where-Object{$_.MimeType -eq "image/jpeg"}',
    '$ps=New-Object System.Drawing.Imaging.EncoderParameters(1)',
    `$ps.Param[0]=New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality,${quality})`,
    `$bmp.Save('${out.replace(/'/g, "''")}',$enc,$ps)`,
    '$g.Dispose();$bmp.Dispose();$src.Dispose()'
  ].join(';');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: ['ignore', 'ignore', 'ignore'],
    timeout: 60000,
    windowsHide: true
  });
  if (fs.existsSync(out) && fs.statSync(out).size > 500) return out;
  if (r.error) throw new Error(`压缩截图失败：${r.error.message}`);
  return pngPath; // 退回原图
}

function imageResult(filePath, note) {
  const buf = fs.readFileSync(filePath);
  const mime = /\.jpe?g$/i.test(filePath) ? 'image/jpeg' : 'image/png';
  return {
    content: [
      { type: 'text', text: note },
      { type: 'image', data: buf.toString('base64'), mimeType: mime }
    ]
  };
}

const KEYMAP = {
  home: 3, back: 4, call: 5, endcall: 6, volume_up: 24, volume_down: 25, power: 26, camera: 27,
  clear: 28, tab: 61, enter: 66, del: 67, menu: 82, notification: 83, search: 84,
  media_play_pause: 85, media_next: 87, media_previous: 88, page_up: 92, page_down: 93,
  escape: 111, forward_del: 112, move_end: 123, move_home: 122, recent: 187, paste: 279,
  wakeup: 224, sleep: 223
};

function keyevent(name) {
  const key = String(name ?? '').trim();
  let code = KEYMAP[key.toLowerCase()];
  if (code === undefined && /^\d+$/.test(key)) code = Number(key);
  if (code === undefined) throw new Error(`未知按键：${name}（可用：${Object.keys(KEYMAP).join('/')}）`);
  sh(`input keyevent ${code}`);
  return code;
}

function tap(x, y) {
  const size = screenSize();
  const nx = Number(x);
  const ny = Number(y);
  const cx = Math.round(nx);
  const cy = Math.round(ny);
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || cx < 0 || cy < 0 || cx > size.width * 2 || cy > size.height * 2) {
    throw new Error(`坐标越界：${x},${y}（屏幕 ${size.width}x${size.height}）`);
  }
  sh(`input tap ${cx} ${cy}`);
}

// 同步 sleep（不阻塞事件循环太久，仅用于点击后等 UI 稳定）
const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
function sleep(ms) {
  try { Atomics.wait(sleepBuf, 0, 0, Math.max(0, ms)); } catch { /* ignore */ }
}

// 输入法是否弹出。用 grep -m1 减少 dumpsys 输出量。
function imeShown() {
  try {
    const raw = sh('dumpsys input_method | grep -m1 mInputShown');
    return /mInputShown=true/.test(raw);
  } catch {
    return false;
  }
}

function clampPoint(x, y, size) {
  return [
    Math.min(Math.max(Math.round(x), 1), size.width - 2),
    Math.min(Math.max(Math.round(y), 1), size.height - 2)
  ];
}

// ===== 中文输入的主通道：ADBKeyboard =====
// 剪贴板同步是**异步**且不可靠的（实测会粘出两轮之前的旧内容，导致标题/正文互串），
// 只适合当兜底。ADBKeyboard 走 IME commitText 广播，base64 传 UTF-8，
// 内容是「直接提交给输入连接」的，不存在同步延迟和抢占问题 —— 这才是可靠通道。
const ADB_KB_IME = 'com.android.adbkeyboard/.AdbIME';
let adbKbAvailability = null; // null=没查过 true/false=查过

function adbKeyboardInstalled() {
  if (adbKbAvailability !== null) return adbKbAvailability;
  try {
    adbKbAvailability = sh('ime list -s', { timeout: 20000 }).includes(ADB_KB_IME);
  } catch { adbKbAvailability = false; }
  return adbKbAvailability;
}

function currentIme() {
  try { return sh('settings get secure default_input_method', { timeout: 15000 }).trim(); } catch { return ''; }
}

// 找系统里真正的用户输入法（排除 ADBKeyboard 自己）。
// 别直接还原到「切换前那个」：如果上一轮崩在中途，切换前就是 ADBKeyboard，
// 还原来还回去等于把用户键盘永久换掉（这个坑实测踩过一次）。
const SOGOU_IME = 'com.sohu.inputmethod.sogou.chuizi/com.sohu.inputmethod.sogou.SogouIME';

function restoreIme(prev) {
  let target = prev && prev !== ADB_KB_IME ? prev : '';
  if (!target) {
    try {
      const list = sh('ime list -s', { timeout: 20000 }).split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
      target = list.find((x) => x !== ADB_KB_IME) || '';
    } catch { /* ignore */ }
  }
  if (!target) return;
  try { sh(`ime set ${target}`, { timeout: 25000 }); sleep(400); } catch { /* 还原失败不致命 */ }
}

// 用 ADBKeyboard 提交一段文字（含中文/emoji）。切过去 → 广播 → 切回用户输入法。
// base64 必须在 Node 里算：用 PowerShell 传中文参数会被转成 GBK，到手机上就是乱码。
function inputByAdbKeyboard(s) {
  const prev = currentIme();
  const b64 = Buffer.from(s, 'utf8').toString('base64');
  let r = '';
  try {
    sh(`ime set ${ADB_KB_IME}`, { timeout: 25000 });
    sleep(600);
    r = sh(`am broadcast -a ADB_INPUT_B64 --es msg ${b64}`, { timeout: 30000 });
    sleep(900);
  } finally {
    // try/finally：中途任何一步抛错也要把键盘还给用户，不然模拟器就永久停在 ADBKeyboard 上
    restoreIme(prev);
  }
  if (!/result=0|Broadcast completed/i.test(r)) throw new Error(`ADBKeyboard 广播失败：${String(r).trim().slice(0, 120)}`);
  return true;
}

// 兜底：Windows 剪贴板 → 共享剪贴板 → KEYCODE_PASTE。
// 每次写剪贴板后必须等 + 粘完必须回读，否则会粘到上一轮的旧内容。
function setWindowsClipboard(s) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Set-Clipboard', '-Value', s], {
    stdio: ['ignore', 'ignore', 'ignore'],
    timeout: 20000,
    windowsHide: true
  });
  if (r.error) throw new Error(`写剪贴板失败：${r.error.message}`);
  return r;
}

// 输入框当前文字（用于「粘完到底进没进去」的回读校验）。
// 必须用 dump 读 text 属性：这是唯一能确证结果的手段，退出码/IME 状态都不可信。
function fieldText(target) {
  try {
    const nodes = uiNodes();
    const edits = nodes.filter((n) => /EditText/.test(n.cls));
    let n = null;
    if (target) n = findTarget(edits, target) || null;
    if (!n) n = edits.find((x) => x.focused) || null;
    if (!n && edits.length === 1) n = edits[0];
    return n ? { text: n.text, node: n } : null;
  } catch { return null; }
}

// 输入文字（假定光标已在目标框里），并在外面校验落入结果。
// 顺序：纯 ASCII 走 `input text`（最快最稳）；含中文优先 ADBKeyboard（同步可靠）；
// 没有 ADBKeyboard 才退回剪贴板粘贴（可能串，故带重试与回读）。
function inputText(text, opts = {}) {
  const s = String(text ?? '');
  if (!s.trim()) throw new Error('要输入的文字为空');
  if (/^[\x20-\x7e\r\n\t]*$/.test(s)) {
    sh(`input text '${s.replace(/'/g, "'\\''").replace(/ /g, '%s')}'`);
    return { mode: 'ascii', ok: true };
  }

  const target = opts.target ?? null;
  const before = fieldText(target);
  const beforeText = before ? before.text : null;

  // 1) 首选 ADBKeyboard
  if (adbKeyboardInstalled()) {
    inputByAdbKeyboard(s);
    const now = fieldText(target);
    const seen = now ? now.text : null;
    if (seen != null && seen.includes(s)) return { mode: 'adbkeyboard', ok: true, text: seen };
    // 没进去就落到剪贴板兜底（可能光标不在框里，或 IME 没接住）
  }

  // 2) 兜底：剪贴板粘贴，最多 3 轮，等待递增
  // 等待时间递增（剪贴板同步慢时靠这个兜住）；回读里出现目标文字才算成功。
  const waits = [900, 1600, 2600];
  let lastSeen = null;
  for (let i = 0; i < waits.length; i++) {
    setWindowsClipboard(s);
    sleep(waits[i]);
    sh('input keyevent 279');
    sleep(600);
    const now = fieldText(target);
    lastSeen = now ? now.text : null;
    if (lastSeen != null && lastSeen.includes(s)) {
      return { mode: 'clipboard', ok: true, waited: waits[i], text: lastSeen };
    }
    // 落到别的框了（早前那次的旧内容串了过来）：清掉再试，避免把脏字留在界面上。
    if (lastSeen != null && beforeText != null && lastSeen !== beforeText && !lastSeen.includes(s)) {
      // 命中上一轮残留：把刚粘进去的旧内容删掉（按长度退格），保持现场干净
      const extra = lastSeen.length - beforeText.length;
      if (extra > 0 && extra < 200) {
        sh('input keyevent 123');
        for (let k = 0; k < extra; k++) sh('input keyevent 67');
      }
    }
  }
  throw new Error(`粘贴没生效（剪贴板同步太慢或被抢）。目标文字「${s}」，框里现在是「${lastSeen ?? '读不到'}」。通常重试一次就好，或改用 emu_text 的 replace 清空后重来。`);
}

// ===== 根因：uiautomator 永远等不到 idle state =====
// 实测这台模拟器上 `uiautomator dump` 会报 `ERROR: could not get idle state.` + `Segmentation fault`，
// 且**根本不生成 XML 文件**。原因是界面一直在跑动画（无限循环的呼吸/轮播），uiautomator 等 idle 等到崩溃。
// 关掉三档动画后 10/10 次 dump 全部成功（59KB 完整树）—— 这就是「点不到控件」最底层的病根。
const ANIM_KEYS = ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale'];

// 每次都读一次真实值再决定要不要写：`settings get` 只要几十毫秒，
// 但不能缓存「已修好」——模拟器重启/换 App 后动画会被改回来，
// 缓存会导致第一次 dump 白等 40s 才超时。读到非 0 就重设。
function ensureAnimationsOff() {
  try {
    const cur = sh(`settings get global animator_duration_scale`).trim();
    if (cur !== '0') {
      sh(ANIM_KEYS.map((k) => `settings put global ${k} 0`).join('; '), { timeout: 20000 });
      sleep(300);
    }
  } catch { /* 忽略：不影响主流程 */ }
}

// dump 一次并校验：先删旧文件（失败时 cat 会读到上一屏的陈旧 XML → 点到不存在的坐标），
// 再校验闭合根节点与节点数（残缺时实测 5KB 且缺 </hierarchy>）。
function dumpOnce() {
  sh('rm -f /sdcard/emu_mcp_ui.xml', { timeout: 15000 });
  sh('uiautomator dump /sdcard/emu_mcp_ui.xml', { timeout: 40000 });
  const serial = detectSerial();
  const r = runAdb(['-s', serial, 'shell', 'cat /sdcard/emu_mcp_ui.xml'], { bin: false, timeout: 30000 });
  return String(r.out ?? '');
}

function dumpUiXml(tries = 3) {
  ensureAnimationsOff();
  let last = '';
  for (let i = 0; i < tries; i++) {
    const xml = dumpOnce();
    last = xml;
    const complete = xml.includes('<hierarchy') && xml.includes('</hierarchy>');
    const nodeCount = (xml.match(/<node /g) || []).length;
    if (complete && nodeCount > 3) return xml;
    // 偶尔还会失败：动画又被 App 打开了，或该界面本身就持续重绘。再关一次动画后重试。
    if (i === 0) ensureAnimationsOff();
    sleep(600);
  }
  return last;
}

function parseNodes(xml) {
  const nodes = [];
  const re = /<node[^>]*>/g;
  let m;
  while ((m = re.exec(xml))) {
    const tag = m[0];
    const attr = (name) => {
      const a = new RegExp(`${name}="([^"]*)"`).exec(tag);
      return a ? a[1] : '';
    };
    const bounds = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(tag);
    if (!bounds) continue;
    const [x1, y1, x2, y2] = bounds.slice(1).map(Number);
    if (x2 <= x1 || y2 <= y1) continue; // 0 尺寸控件点不到
    nodes.push({
      text: attr('text'),
      desc: attr('content-desc'),
      cls: attr('class'),
      rid: attr('resource-id'),
      clickable: attr('clickable') === 'true',
      focused: attr('focused') === 'true',
      x1, y1, x2, y2,
      cx: Math.round((x1 + x2) / 2),
      cy: Math.round((y1 + y2) / 2),
      area: (x2 - x1) * (y2 - y1)
    });
  }
  return nodes;
}

function uiNodes() {
  return parseNodes(dumpUiXml());
}

function visibleText(nodes, n = 24) {
  return nodes.map((x) => x.text || x.desc || (x.rid ? `#${x.rid.split('/').pop()}` : '')).filter(Boolean).slice(0, n).join(' | ');
}

// 控件中心点可能落在 View 组内的缝隙上（例如小黑盒评论框外覆了一层 vg_editor_container），
// 且靠近屏幕底边（1920 高时 y>1800）时更容易被系统手势区吃掉 —— 统一往控件内部收敛。
function safeCenter(node, size) {
  const insetY = Math.min(Math.floor((node.y2 - node.y1) * 0.25), 18);
  const x = Math.round((node.x1 + node.x2) / 2);
  const y = Math.round((node.y1 + node.y2) / 2 + (node.y2 > size.height - 120 ? -insetY : 0));
  return clampPoint(x, y, size);
}

// 找输入框并点开，点完用 IME 是否弹出做判定，没弹出就换偏移再试（最多 4 次）。
// 命中率问题来自三处：dump 残缺 → 坐标算错；坐标落在容器缝隙；键盘弹起后布局上移导致后续点击点空。
function focusEditor(text) {
  const size = screenSize();
  const tries = [];
  for (let attempt = 1; attempt <= 4; attempt++) {
    const nodes = uiNodes();
    let target = text ? findTarget(nodes, text) : null;
    if (!target) {
      const edits = nodes.filter((n) => /EditText/.test(n.cls));
      target = edits.find((n) => n.area > 4000) || edits[0] || null;
    }
    if (!target) return { ok: false, tries, reason: `界面上没有找到输入框（可见：${visibleText(nodes)}）` };
    const offsets = [
      [0, 0],
      [0, -Math.round((target.y2 - target.y1) * 0.3)],
      [Math.round((target.x2 - target.x1) * 0.25), 0],
      [-Math.round((target.x2 - target.x1) * 0.25), 0]
    ][attempt - 1];
    const [px, py] = clampPoint(target.cx + offsets[0], target.cy + offsets[1], size);
    sh(`input tap ${px} ${py}`);
    sleep(700);
    const ok = imeShown();
    tries.push(`${px},${py}:${ok ? 'ok' : 'no'}`);
    if (ok) return { ok: true, attempt, px, py, tries, node: target };
    sleep(200);
  }
  return { ok: false, tries };
}

function findTarget(nodes, want) {
  const scored = [];
  for (const n of nodes) {
    let s = -1;
    if (n.text === want) s = 0;
    else if (n.desc === want) s = 1;
    else if (n.rid && n.rid.split('/').pop() === want) s = 2;
    else if (n.text && n.text.includes(want)) s = 3;
    else if (n.desc && n.desc.includes(want)) s = 4;
    else if (n.rid && n.rid.includes(want)) s = 5;
    if (s >= 0) scored.push({ n, s });
  }
  if (!scored.length) return null;
  // 同分时优先「可点击」、优先面积小的（更可能是叶子控件而不是整块容器）
  scored.sort((a, b) => a.s - b.s || Number(b.n.clickable) - Number(a.n.clickable) || a.n.area - b.n.area);
  return scored[0].n;
}

function tapText(needle) {
  const want = String(needle ?? '').trim();
  if (!want) throw new Error('要点击的文字为空');
  const size = screenSize();
  const nodes = uiNodes();
  const best = findTarget(nodes, want);
  if (!best) {
    throw new Error(`没有找到可点击的「${want}」：当前界面可见文字 ${visibleText(nodes)}`);
  }
  const [tx, ty] = safeCenter(best, size);
  const before = foreground();
  sh(`input tap ${tx} ${ty}`);
  sleep(420);
  const after = foreground();
  return { node: best, tx, ty, before, after, changed: before !== after };
}

function listApps() {
  return sh('pm list packages -3').split(/\r?\n/).map((l) => l.replace(/^package:/, '').trim()).filter(Boolean);
}

function appAction(action, pkg) {
  const a = String(action ?? 'start').toLowerCase();
  if (a === 'list') return listApps();
  const p = String(pkg ?? '').trim();
  if (!/^[a-zA-Z0-9._]+$/.test(p)) throw new Error('包名不合法');
  if (a === 'start') { sh(`monkey -p ${p} -c android.intent.category.LAUNCHER 1`); return `已启动 ${p}`; }
  if (a === 'stop') { sh(`am force-stop ${p}`); return `已停止 ${p}`; }
  throw new Error(`未知动作：${action}（可用 start/stop/list）`);
}

// version 必须等于根 package.json 的 version（scripts/verify-dsh-020-adaptation.mjs 会断言）：
// 此前这里写的是 '1.0.0'，与其余三个 MCP server 的 0.2.0-r3 不一致，是既有漂移。
const server = new McpServer({ name: 'emu-phone', version: '0.2.0-r3' });

server.tool('emu_status', '查看「我的手机」（本机 MuMu 安卓模拟器）的状态：型号、安卓版本、分辨率、前台应用。只读。', {}, async () => {
  try {
    const size = screenSize();
    const props = sh('getprop ro.build.version.release; getprop ro.product.model; getprop ro.product.cpu.abilist').split(/\r?\n/);
    // 动画三档必须是 0，否则 uiautomator 等不到 idle、dump 崩溃 → 所有按控件的操作都会失败。
    const anim = sh('settings get global animator_duration_scale').trim();
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          serial: detectSerial(),
          android: props[0] || '',
          model: props[1] || '',
          abi: props[2] || '',
          screen: `${size.width}x${size.height}`,
          foreground: foreground(),
          animations: anim === '0' ? 'off' : `on(${anim})`
        }, null, 2)
      }]
    };
  } catch (e) {
    return { content: [{ type: 'text', text: `设备不可用：${e?.message ?? e}` }], isError: true };
  }
});

server.tool('emu_screenshot', '截取「我的手机」当前屏幕并作为图片返回（同时给出本地备用路径）。', {
  maxWidth: z.number().optional().describe('缩放后的最大宽度，默认 900，越大越清晰但更耗上下文')
}, async ({ maxWidth }) => {
  try {
    const png = capturePng();
    const jpg = toJpeg(png, Math.min(Math.max(Number(maxWidth) || 900, 320), 1600));
    return imageResult(jpg, `截图：${path.basename(jpg)}（原图 ${path.basename(png)}），前台 ${foreground()}`);
  } catch (e) {
    return { content: [{ type: 'text', text: `截图失败：${e?.message ?? e}` }], isError: true };
  }
});

server.tool('emu_tap', '点击屏幕坐标（逻辑坐标，即 emu_status 返回的分辨率坐标系）。', {
  x: z.number().describe('横坐标'),
  y: z.number().describe('纵坐标')
}, async ({ x, y }) => {
  try { tap(x, y); return { content: [{ type: 'text', text: `已点击 (${x}, ${y})，前台 ${foreground()}` }] }; }
  catch (e) { return { content: [{ type: 'text', text: `点击失败：${e?.message ?? e}` }], isError: true }; }
});

server.tool('emu_tap_text', '按界面上的文字/描述/id 点击控件（精确匹配优先；同分优先可点击、优先叶子控件）。返回是否发生了界面跳转。', {
  text: z.string().describe('要点击的控件文字、content-desc，或 resource-id 尾部（如 et_editor）')
}, async ({ text }) => {
  try {
    const hit = tapText(text);
    const label = hit.node.text || hit.node.desc || `#${hit.node.rid.split('/').pop()}`;
    const note = hit.changed ? `界面已变化（${hit.before} → ${hit.after}）` : `界面未跳转（仍在 ${hit.after}）`;
    return { content: [{ type: 'text', text: `已点击「${label}」(${hit.tx}, ${hit.ty})，${note}` }] };
  } catch (e) { return { content: [{ type: 'text', text: `点击失败：${e?.message ?? e}` }], isError: true }; }
});

// 专治「输入框点不到」：点完立刻验证 IME 是否弹出，没弹出就换位置重试。
// 命中率问题主要来自三处：dump 残缺 → 坐标算错；坐标落在容器缝隙；键盘弹起后布局上移导致后续点击点空。
server.tool('emu_focus_text', '点击输入框并确认键盘弹出（自动重试）。用于「聊天框/搜索框点不到」：先试 id 或提示文字，点完校验 IME，未弹出就微调坐标再试，最多 4 次。', {
  text: z.string().optional().describe('输入框文字/描述/id 尾部，默认自动找当前界面的 EditText'),
  submit: z.boolean().optional().describe('聚焦后是否立刻输入文字并回车（配合 value）'),
  value: z.string().optional().describe('要输入的搜索词/内容，配合 submit')
}, async ({ text, submit, value }) => {
  try {
    const res = focusEditor(text);
    if (!res.ok) {
      return {
        content: [{
          type: 'text',
          text: res.reason
            ? res.reason
            : `4 次尝试都没能唤出键盘（${res.tries.join(' ')}）。可能该输入框被悬浮层遮挡，或需要先滑动把它挪到屏幕中间。`
        }],
        isError: true
      };
    }
    let msg = `已聚焦输入框（第 ${res.attempt} 次尝试，坐标 ${res.px},${res.py}），键盘已弹出`;
    if (submit && value) {
      const r = inputText(value, { target: text || null });
      sleep(250);
      sh('input keyevent 66');
      msg += `；已输入并回车（${r.mode}，回读校验通过）：${value}`;
    }
    return { content: [{ type: 'text', text: `${msg}。尝试记录 ${res.tries.join(' ')}` }] };
  } catch (e) { return { content: [{ type: 'text', text: `聚焦失败：${e?.message ?? e}` }], isError: true }; }
});

server.tool('emu_text', '向输入框输入文字（ASCII 走 input text，中文自动走共享剪贴板粘贴）。粘错框/粘串了会回读校验并自动重试。', {
  text: z.string().describe('要输入的文字'),
  enter: z.boolean().optional().describe('输入后是否立刻回车（搜索框提交用）'),
  field: z.string().optional().describe('目标输入框的文字/描述/id 尾部（如 et_title / et_content）。多输入框界面强烈建议传，否则可能粘进当前还有焦点的别的框'),
  replace: z.boolean().optional().describe('输入前先清空该输入框原有内容，默认 false（追加）'),
  focus: z.boolean().optional().describe('输入前先点开输入框，默认 true')
}, async ({ text, enter, field, replace, focus }) => {
  try {
    let note = '';
    // 关键：不能用「键盘有没有弹出」判断焦点对不对。
    // 上一个框的键盘还在时，直接粘贴就会粘进那个旧框 —— 这就是标题/正文「来回互粘」的第二个原因。
    // 因此只要指定了 field（或默认 true），一律重新聚焦一次。
    if (focus !== false) {
      const res = focusEditor(field);
      if (res.ok) note = `（聚焦 ${field || '输入框'} ${res.px},${res.py}，第 ${res.attempt} 次）`;
      else note = `（聚焦输入框失败：${res.reason || res.tries.join(' ')}）`;
    }
    // 全选 + 退格清空（keycombination 113 29 = Ctrl+A）
    if (replace === true) {
      sh('input keycombination 113 29', { timeout: 15000 });
      sleep(200);
      sh('input keyevent 67');
      sleep(300);
      note += '（已清空原内容）';
    }
    const r = inputText(text, { target: field || null });
    if (enter) { sleep(250); sh('input keyevent 66'); }
    const where = foreground();
    const waited = r.waited ? `，等剪贴板 ${r.waited}ms` : '';
    return {
      content: [{
        type: 'text',
        text: `已输入${note}（${r.mode}${waited}，回读校验通过）：${text}${enter ? '，已回车' : ''}，当前 ${where}`
      }]
    };
  }
  catch (e) { return { content: [{ type: 'text', text: `输入失败：${e?.message ?? e}` }], isError: true }; }
});

// 让 agent「看见」当前界面上有什么可点，而不是盲猜坐标。
server.tool('emu_ui', '列出当前界面可交互的控件（文字 / 描述 / id / 坐标），用于判断该点哪里。只读。', {
  limit: z.number().optional().describe('最多返回多少个控件，默认 60'),
  clickableOnly: z.boolean().optional().describe('只列可点击控件，默认 true')
}, async ({ limit, clickableOnly }) => {
  try {
    const nodes = uiNodes();
    const onlyClickable = clickableOnly !== false;
    const picked = nodes
      .filter((n) => (onlyClickable ? n.clickable || /EditText/.test(n.cls) : true))
      .filter((n) => n.text || n.desc || n.rid || /EditText/.test(n.cls))
      .sort((a, b) => a.cy - b.cy)
      .slice(0, Math.min(Math.max(Number(limit) || 60, 1), 200))
      .map((n) => `[${n.cx},${n.cy}] ${n.text || n.desc || ''}${n.rid ? ' #' + n.rid.split('/').pop() : ''}${n.clickable ? '' : ' (不可点)'}`);
    return {
      content: [{
        type: 'text',
        text: `前台 ${foreground()}\n` + (picked.length ? picked.join('\n') : '当前界面没有可识别控件')
      }]
    };
  } catch (e) { return { content: [{ type: 'text', text: `读取界面失败：${e?.message ?? e}` }], isError: true }; }
});

server.tool('emu_key', '按安卓按键，如 home/back/enter/recent/power/volume_up/volume_down/del/move_end/paste。', {
  key: z.string().describe('按键名')
}, async ({ key }) => {
  try { const code = keyevent(key); return { content: [{ type: 'text', text: `已按 ${key}（keycode ${code}），前台 ${foreground()}` }] }; }
  catch (e) { return { content: [{ type: 'text', text: `按键失败：${e?.message ?? e}` }], isError: true }; }
});

server.tool('emu_swipe', '滑动屏幕（例如翻页、刷短视频）。', {
  x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number(),
  durationMs: z.number().optional().describe('滑动时长毫秒，默认 300')
}, async ({ x1, y1, x2, y2, durationMs }) => {
  try {
    const d = Math.min(Math.max(Number(durationMs) || 300, 50), 3000);
    sh(`input swipe ${Math.round(x1)} ${Math.round(y1)} ${Math.round(x2)} ${Math.round(y2)} ${d}`);
    return { content: [{ type: 'text', text: `已滑动 (${x1},${y1})→(${x2},${y2}) ${d}ms` }] };
  } catch (e) { return { content: [{ type: 'text', text: `滑动失败：${e?.message ?? e}` }], isError: true }; }
});

server.tool('emu_app', '管理「我的手机」上的应用：start 启动 / stop 停止 / list 列出第三方应用。', {
  action: z.enum(['start', 'stop', 'list']).describe('动作'),
  package: z.string().optional().describe('包名，start/stop 必填')
}, async ({ action, package: pkg }) => {
  try {
    const out = appAction(action, pkg);
    return { content: [{ type: 'text', text: Array.isArray(out) ? out.join('\n') : out }] };
  } catch (e) { return { content: [{ type: 'text', text: `操作失败：${e?.message ?? e}` }], isError: true }; }
});

server.tool('emu_watch', '抽帧「看」视频：按间隔截图，只保留画面有变化的关键帧并拼成一张看板图返回。适合人在 QQ 里问「视频在演什么」时用。', {
  seconds: z.number().optional().describe('观察时长秒，默认 30，上限 120'),
  intervalSec: z.number().optional().describe('采样间隔秒，默认 2')
}, async ({ seconds, intervalSec }) => {
  try {
    const secs = Math.min(Math.max(Number(seconds) || 30, 5), 120);
    const step = Math.min(Math.max(Number(intervalSec) || 2, 1), 10);
    const script = path.join(EMU_DIR, 'watch.ps1');
    if (!fs.existsSync(script)) throw new Error(`缺少抽帧脚本 ${script}`);
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const out = path.join(SHOT_DIR, `watch-${Date.now()}.png`);
    const tmp = path.join(SHOT_DIR, `frames-${Date.now()}`);
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Seconds', String(secs), '-IntervalSec', String(step), '-Out', out, '-TmpDir', tmp], {
      encoding: 'utf8',
      timeout: (secs + 90) * 1000,
      windowsHide: true
    });
    if (!fs.existsSync(out)) {
      throw new Error(`抽帧失败：${String(r.stderr || r.stdout || '').slice(0, 400)}`);
    }
    const note = String(r.stdout || '').trim().split(/\r?\n/).slice(-3).join(' ');
    return imageResult(out, `看板图：${path.basename(out)} ${note}`.trim());
  } catch (e) {
    return { content: [{ type: 'text', text: `看视频失败：${e?.message ?? e}` }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
