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
  const cx = Math.round(Number(x));
  const cy = Math.round(Number(y));
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || cx < 0 || cy < 0 || cx > size.width * 2 || cy > size.height * 2) {
    throw new Error(`坐标越界：${x},${y}（屏幕 ${size.width}x${size.height}）`);
  }
  sh(`input tap ${cx} ${cy}`);
}

function inputText(text) {
  const s = String(text ?? '');
  if (!s.trim()) throw new Error('要输入的文字为空');
  if (/^[\x20-\x7e\r\n\t]*$/.test(s)) {
    sh(`input text '${s.replace(/'/g, "'\\''").replace(/ /g, '%s')}'`);
    return 'ascii';
  }
  // 中文/非 ASCII：走 Windows 剪贴板 → 模拟器共享剪贴板 → KEYCODE_PASTE。
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Set-Clipboard', '-Value', s], {
    stdio: ['ignore', 'ignore', 'ignore'],
    timeout: 20000,
    windowsHide: true
  });
  if (r.error) throw new Error(`写剪贴板失败：${r.error.message}`);
  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep', '-Milliseconds', '300'], { stdio: 'ignore', timeout: 5000 });
  sh('input keyevent 279');
  return 'clipboard';
}

function uiNodes() {
  const serial = detectSerial();
  sh('uiautomator dump /sdcard/emu_mcp_ui.xml >/dev/null 2>&1');
  const r = runAdb(['-s', serial, 'shell', 'cat /sdcard/emu_mcp_ui.xml'], { bin: false, timeout: 30000 });
  const xml = String(r.out ?? '');
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
    nodes.push({
      text: attr('text'),
      desc: attr('content-desc'),
      cls: attr('class'),
      clickable: attr('clickable') === 'true',
      cx: Math.round((x1 + x2) / 2),
      cy: Math.round((y1 + y2) / 2)
    });
  }
  return nodes;
}

function tapText(needle) {
  const want = String(needle ?? '').trim();
  if (!want) throw new Error('要点击的文字为空');
  const nodes = uiNodes();
  const score = (n) => {
    if (n.text === want) return 0;
    if (n.desc === want) return 1;
    if (n.text && n.text.includes(want)) return 2;
    if (n.desc && n.desc.includes(want)) return 3;
    return -1;
  };
  let best = null;
  let bestScore = 99;
  for (const n of nodes) {
    const s = score(n);
    if (s >= 0 && s < bestScore) { best = n; bestScore = s; }
  }
  if (!best) {
    const visible = nodes.map((n) => n.text || n.desc).filter(Boolean).slice(0, 20).join(' | ');
    throw new Error(`没有找到可点击的「${want}」：当前界面可见文字 ${visible}`);
  }
  tap(best.cx, best.cy);
  return best;
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
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          serial: detectSerial(),
          android: props[0] || '',
          model: props[1] || '',
          abi: props[2] || '',
          screen: `${size.width}x${size.height}`,
          foreground: foreground()
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

server.tool('emu_tap_text', '按界面上的文字/描述点击控件（uiautomator 解析，精确匹配优先）。', {
  text: z.string().describe('要点击的控件文字')
}, async ({ text }) => {
  try {
    const hit = tapText(text);
    return { content: [{ type: 'text', text: `已点击「${hit.text || hit.desc}」(${hit.cx}, ${hit.cy})，前台 ${foreground()}` }] };
  } catch (e) { return { content: [{ type: 'text', text: `点击失败：${e?.message ?? e}` }], isError: true }; }
});

server.tool('emu_text', '向当前输入框输入文字（ASCII 走 input text，中文自动走共享剪贴板粘贴）。', {
  text: z.string().describe('要输入的文字')
}, async ({ text }) => {
  try { const mode = inputText(text); return { content: [{ type: 'text', text: `已输入（${mode}）：${text}` }] }; }
  catch (e) { return { content: [{ type: 'text', text: `输入失败：${e?.message ?? e}` }], isError: true }; }
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
