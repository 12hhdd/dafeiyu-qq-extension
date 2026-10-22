// QQ 空间（说说）的纯函数内核：常量、参数校验/归一、出站门禁。
//
// 为什么把这块从 `src/mcp-snowluma-safe.js` 里抽出来：
//   ① 那个文件在**模块顶层**就 `new McpServer(...)` 并且要 `connect(stdio)`，
//      `import` 它等于起一个服务器进程 —— 任何测试 / 插件都没法复用其中的纯逻辑；
//   ② qzone 的三个工具里，可见性映射、长度/张数上限、敏感信息门禁全是纯逻辑，
//      抽出来就能直接单测（不用 `vm` 抓 `server.tool()` 注册表）；
//   ③ `plugins/qq-qzone/lib/index.js` 要能 import 同一份常量与校验，避免抄第二份。
//
// **本模块无副作用**：不读 `config.json`、不建连接、不发任何网络请求。
// 之所以能这样，是因为 qzone 没有 host 半 —— 桥接（`src/bridge.js`）压根没有 qzone
// 端点，工具直连 OneBot（与 `onebot()` 同一套 `snowluma.httpUrl` / `accessToken` 配置），
// 详见 `src/mcp-snowluma-safe.js` 里「QQ 空间（说说）」区段头注释。
//
// 唯一的 import 是敏感信息正则：`src/sensitive.js` 是全仓库**唯一**一份实现，
// 这里**不要**再写一条正则 —— 两套口径必然漂移（桥接侧的出站审计用的就是这一条）。
import { SENSITIVE_RE } from './sensitive.js';

// ── 上限常量（测试与文档引用同一份，别在别处写 1500 / 9） ──────────────────
// 这两个数来自工具 schema 的 `z.string().min(1).max(1500)` 与
// `z.array(z.string()).max(9)`；schema 仍留在 MCP server 侧（那是给模型看的契约），
// 这里保留一份纯函数侧的同名上限，两处必须一致（`scripts/test-qq-qzone.mjs` 会比对）。
export const QZONE_MAX_CONTENT = 1500;
export const QZONE_MAX_IMAGES = 9;

// 可见范围缺省值：工具描述写的是「默认 friends（好友可见）」。
export const QZONE_DEFAULT_VISIBILITY = 'friends';

// OneBot 侧 `num` 太小（如 5）会返回 `msglist:null` + `retcode 100`，
// 所以 `qq_qzone_list` 把下限压到 10（上限是工具 schema 的 20）。
// 这两个常量由 `qq_qzone_list` 的壳直接引用（逻辑仍留在壳里，行为不变）。
export const QZONE_MIN_LIST_NUM = 10;
export const QZONE_MAX_LIST_NUM = 20;

// ugc_right 的语义（OneBot / QQ 空间协议值）。
// all=所有人 · friends=好友 · private=仅自己；16 / 128 是列表接口可能返回的
// 「部分好友可见 / 部分好友不可见」，发帖时用不到，但读数时要能翻译成中文。
export const QZONE_UGC_RIGHT = Object.freeze({ all: 1, friends: 4, private: 64 });

export const QZONE_RIGHT_LABEL = Object.freeze({
  1: '所有人可见',
  4: '好友可见',
  16: '部分好友可见',
  64: '仅自己可见',
  128: '部分好友不可见',
});

// 允许的 ugc_right 数字（发帖时可显式传数字）。从 LABEL 派生，避免两处清单漂移。
const ALLOWED_RIGHTS = Object.freeze(Object.keys(QZONE_RIGHT_LABEL).map(Number));

// ── 出站门禁 ──────────────────────────────────────────────────────────────
/**
 * 出站正文的敏感信息门禁。
 *
 * 直连 OneBot 的路径**绕过了**桥接 outbound 端点里的 `SENSITIVE_RE` 审计，
 * 所以必须在发出去之前自己补一道（历史实现就在 `mcp-snowluma-safe.js` 里，
 * 本次原样搬过来：判定逻辑、正则来源、报错文案都**逐字未改**）。
 *
 * 调用点：`qq_qzone_post` 的工具边界（`src/mcp-snowluma-safe.js`），
 * 以及插件侧的 `guardAndBuildQzonePost()`。`buildQzonePostPayload()` 本身
 * **不**跑门禁（它只做校验/归一），所以任何新增出站路径都必须自己调一次本函数。
 *
 * @param {unknown} text 待发送的正文
 * @throws {Error} 命中本机路径 / 凭据特征时抛出（文案对模型可见，不要改）
 */
export function qzoneGuard(text) {
  if (SENSITIVE_RE.test(String(text ?? ''))) {
    throw new Error('这条内容里带了本机路径或凭据特征，会被安全策略拦下；把路径、账号之类的东西去掉再发。');
  }
}

/**
 * 把可见范围归一成 OneBot 的 `ugc_right` 数字。
 *
 * 接受：`'friends' | 'all' | 'private'`（大小写不敏感）、等价的 ugc_right 数字
 * （1 / 4 / 16 / 64 / 128）、数字字符串（`'4'`）；`undefined` / `null` / `''`
 * 走缺省 `friends`（= 4）。
 *
 * 非法值**抛错**而不是静默回退：历史实现是 `QZONE_UGC_RIGHT[v] ?? 4`，
 * 非法值会被悄悄发成「好友可见」—— 发布类动作上这是 fail-open，不能留。
 *
 * @param {unknown} visibility
 * @returns {number} ugc_right
 */
export function resolveVisibility(visibility) {
  if (visibility === undefined || visibility === null || visibility === '') {
    return QZONE_UGC_RIGHT[QZONE_DEFAULT_VISIBILITY];
  }
  if (typeof visibility === 'number') {
    if (Number.isInteger(visibility) && ALLOWED_RIGHTS.includes(visibility)) return visibility;
    throw visibilityError(visibility);
  }
  if (typeof visibility === 'string') {
    const key = visibility.trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(QZONE_UGC_RIGHT, key)) return QZONE_UGC_RIGHT[key];
    if (key !== '' && /^\d+$/.test(key)) {
      const num = Number(key);
      if (ALLOWED_RIGHTS.includes(num)) return num;
    }
    throw visibilityError(visibility);
  }
  throw visibilityError(visibility);
}

function visibilityError(visibility) {
  return new Error(
    `不认识的可见范围：${JSON.stringify(visibility)}；只支持 friends（好友可见）/ all（所有人）/ private（仅自己），`
    + `或 ugc_right 数字 1 / 4 / 16 / 64 / 128（缺省 friends）`
  );
}

/**
 * 把任意抛出的值转成一段可读文本，保持历史返回文案的拼接方式
 * （旧代码写的是 `${error?.message ?? error}`，这里等价）。
 */
export function describeQzoneError(error) {
  const message = error?.message;
  return message === undefined || message === null ? String(error) : String(message);
}

// 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
//
// 这段与 `src/mcp-snowluma-safe.js` 里的 `unquoteJsonString()` **逐字一致**。
// 为什么不共用一份：那个文件顶层就起 stdio server，core 不能 import 它；
// 而把它挪到 core 会牵动那次文件里 ~40 个发送工具（超出本次改动范围）。
// 两边行为必须一致 —— `scripts/test-qq-qzone.mjs` 用同一组样例钉住了这一点。
function unquoteJsonString(value) {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  if (t.startsWith('"')) {
    try {
      const parsed = JSON.parse(t);
      if (typeof parsed === 'string') return parsed;
    } catch {}
  }
  return value;
}

/**
 * 校验并构造 `send_qzone_msg` 的 OneBot 参数字面量。
 *
 * 校验口径与工具 schema 一致（schema 仍然留在 MCP server 侧，那是模型看到的契约）：
 *   · `content` 必须是字符串，1 ~ {@link QZONE_MAX_CONTENT} 个字符（按原始入参算长度，
 *     与 `z.string().min(1).max(1500)` 的判定顺序相同，之后才做 JSON 字符串还原）；
 *   · `images` 可选，字符串数组，最多 {@link QZONE_MAX_IMAGES} 张（缺省 = 空数组）；
 *   · `visibility` 交给 {@link resolveVisibility}（缺省 friends）。
 *
 * 本函数**不做**敏感信息审计（见 {@link qzoneGuard}，出站路径必须自己调）。
 *
 * @param {{content?: unknown, images?: unknown, visibility?: unknown, tid?: unknown}} [input]
 * @returns {{content: string, images: string[], ugc_right: number, tid?: string}}
 *   OneBot `send_qzone_msg` 的 params。`tid` 只在调用方显式传入时才出现
 *   （发帖本身不需要 tid；保留它是为了让重发/调试路径复用同一个 builder）。
 */
export function buildQzonePostPayload({ content, images, visibility, tid } = {}) {
  if (typeof content !== 'string') {
    throw new Error('content 必须是字符串（说说正文）');
  }
  if (content.length < 1) {
    throw new Error('content 不能为空');
  }
  if (content.length > QZONE_MAX_CONTENT) {
    throw new Error(`content 最多 ${QZONE_MAX_CONTENT} 个字符（实际 ${content.length} 个）`);
  }

  let list = [];
  if (images !== undefined && images !== null) {
    if (!Array.isArray(images)) {
      throw new Error('images 必须是字符串数组（本机绝对路径 / http URL / base64）');
    }
    if (images.length > QZONE_MAX_IMAGES) {
      throw new Error(`images 最多 ${QZONE_MAX_IMAGES} 张（实际 ${images.length} 张）`);
    }
    list = images.map((s) => String(s));
  }

  const payload = {
    content: unquoteJsonString(content),
    images: list,
    ugc_right: resolveVisibility(visibility),
  };
  if (tid !== undefined && tid !== null && String(tid) !== '') payload.tid = String(tid);
  return payload;
}
