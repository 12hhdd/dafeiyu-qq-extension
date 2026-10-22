# 发布前隐私检查（PRIVACY）

> 这个项目在一台**真实机器**上运行过，工作树里天然散落着真实 QQ 号、群号、本机绝对路径、
> 令牌、以及个人化的人格卡内容。任何一次「忘了就 push」都会把这些**永久写进公开仓库历史**
> ——Git 历史里的东西删提交也删不干净（还会被 fork 保留）。
>
> 所以发布前跑一遍扫描，是发布流程的**硬性一步**，不是可选建议。

---

## 一、跑扫描

```bash
node scripts/privacy-scan.mjs                # 扫"将要提交的内容"（推荐）
node scripts/privacy-scan.mjs --tracked-only # 只扫 git 已跟踪文件
node scripts/privacy-scan.mjs --json         # 机读输出（给 CI 用）
```

退出码：`0` = 干净，`1` = 有命中（**必须逐个判读**），`2` = 规则文件坏了或目录扫不动。

它扫描：`git ls-files` + 未被 ignore 的未跟踪文件（git 不可用时退化为目录遍历，并尽力套用 `.gitignore`；
遍历会跳过 junction/symlink，免得被指回自身的联接搞成无限递归）。

## 二、内置规则（挡住最常见的泄漏）

| 规则 | 说明 |
| --- | --- |
| 本机绝对路径 | `C:\Users\<名字>\…` 与 `D:\<工作盘>\…` 这类工作盘路径 |
| QQ 号 / 群号 | 9–10 位连续数字（真实账号长度；文档里的 `123456789` 属占位符） |
| 高熵串 | 疑似令牌/密钥。**过滤掉**全 hex（git SHA）、全大写下划线（环境变量名）、小写文件名式串 —— 真凭据是"大小写+数字混合" |
| 凭据赋值 | `accessToken: "<12 位以上实际值>"` 形态（空值/模板不算，避免噪音） |
| 私钥头 / 带凭据的 URL | `-----BEGIN … PRIVATE KEY-----`、`https://user:pass@host` |
| 不应入库的文件 | `config.json`、`state/`、`audio/`、`*.log`、`*.bak*` |

## 三、判读命中：三种处理，别一律"忽略"

| 情况 | 处理 |
| --- | --- |
| **真实数据**（你的 QQ 号、群号、本机路径、令牌） | 换成占位符（`123456789` / `C:\path\to\…`），或把该文件移出版本控制 |
| **该文件本来就不该入库** | 加进 `.gitignore`；若已提交过，见下面第四节 |
| **误报**（脱敏模板、测试夹具、文档示例） | 加进白名单 —— 优先级从高到低：<br>① **规则级**（推荐）：`allowRules`，只放过「这一条规则在这个文件里」的命中；<br>② 字面值级：`allowLiterals`，只放过一个确切字符串；<br>③ 文件级（**最后手段**）：`allowPaths`，整个文件从此一条规则都不查 |

### `scripts/privacy-rules.json`（可选的本地规则文件）

- **它含你机器上的真实标识，必须加进 `.gitignore`**（模板见 `privacy-rules.example.json`）。
- 结构：

```jsonc
{
  "comment": "本机专用；不入库",
  "deny": [
    { "name": "我的真实群号", "pattern": "1001[0-9]{6}", "flags": "" }
  ],
  "denyFiles": ["notes/", "*.private.md"],
  // ① 推荐：只放过「文件 + 规则名」，该文件其它规则照旧会查
  "allowRules": [
    { "path": "src/bridge.js", "rule": "疑似令牌/密钥（高熵串）" }
  ],
  // ② 只放过一个确切字面值（内置默认已含 D:\日记\ 那条）
  "allowLiterals": [
    { "rule": "本机绝对路径（非系统盘的顶层目录）", "value": "D:\\日记\\" }
  ],
  // ③ 最后手段：整个文件不查（前缀或 * 通配）
  "allowPaths": ["scripts/console-ui-"]
}
```

**为什么优先用 `allowRules`**：`allowPaths` 是**按文件**放行的，加进去的文件从此
一条规则都不查。为了放过 3 条误报就让 `src/bridge.js` 这种一万多行的核心文件
退出扫描，等于开了个大盲区 —— 实际上旧版本就是这么干的，直到 2026-10-22 才发现。
`allowRules` 只放过指定的一条规则，同文件里其它规则的命中照样会报。

> `allowPaths` 不带 `*` 时按**前缀**匹配，`src/bridge.js` 会连带放行 `src/bridge.js.bak-*`。
> 现在 `.gitignore` 兜底已能正确排除备份文件，但新增条目仍应尽量写精确形式。

### 扫描器自身的历史 bug（2026-10-22 修复，有回归测试钉住）

`scripts/test-privacy-scan.mjs` 是这些行为的回归测试。修复前它有两个**静默失效**的缺陷：

1. **规则不带 `g`** → `exec()` 的 `lastIndex` 永远停在 0，同一处匹配被反复返回，
   靠「每文件每规则最多报 3 处」的上限才停下。后果有两层：同一行被报 3 次（噪音），
   以及**该处之后的所有命中永远报不出来**（真正的漏报）。
2. **`isNoise` 把纯数字当成"常量名"过滤掉** → 「QQ 号/群号」这条最重要的规则
   **从来没报过一次**。

另外两个兜底路径也有坑：`.gitignore` 兜底匹配把 glob 的 `^…$` 锚点嵌进
`(?:^|/)…$`，导致 `*.bak-*` 这类 basename 规则在「git 不可用」模式下全部失效；
`allowPaths` 的前缀匹配会连带放行备份文件。

## 四、已经提交进去了怎么办

| 情况 | 处理 |
| --- | --- |
| 还没 push | `git reset --soft` 回退提交、清掉敏感内容、重新提交 |
| 已 push，但**没有被 fork / 没人拉过** | `git filter-repo --replace-text` 清历史，再 `git push --force`。要提前通知协作者 |
| 已 push 且可能被 fork / 已公开一段时间 | **当作已泄露**：① 立刻**轮换**所有涉及的凭据（控制台令牌、SnowLuma token、DSH launch token 都是本地生成，轮换成本低）；② 再清历史；③ 新仓库（QSH）从干净起点开始，不带旧历史 |

> 这也是 `QSH_FORK_AND_SITE_PLAN.md` 建议**新建仓库、不带 qq-bridge 历史**的原因之一：
> 旧历史里既有 11 MB 演示视频，也有难以逐条确认的本地痕迹。新起点一次扫干净，成本最低。

## 五、CI 里怎么用

```yaml
# .github/workflows/ci.yml 片段
- name: Privacy scan
  run: node scripts/privacy-scan.mjs --tracked-only
```

CI 上只扫**已跟踪**文件（未跟踪文件在干净 checkout 里不存在），命中即失败。

## 六、本仓库 2026-09-20 的扫描结果（存档）

首次运行发现的问题，供拆分新仓库时逐条处理：

| 文件 | 命中 | 处理建议 |
| --- | --- | --- |
| `public/console.html` | 真实群号 `100012` × 2 | **必须替换为占位符**（这是会随 QSH 一起发布的文件） |
| `src/bridge.js` | `accessToken` 键名（配置读取处，无真实值） | 误报：键名不是值；已在规则里区分"有实际值" |
| `docs/guides/PROJECT_GUIDE.md`、`docs/guides/VOICE.md` | 真实 QQ 号/群号、`C:\Users\<名字>`、`D:\<工作盘>` | `PROJECT_GUIDE.md`：**不带进新仓库**（旧项目的实现说明，已被 `QSH_PLAN.md` 取代）。`VOICE.md`：**已重写为脱敏版**（只留占位符，privacy-scan 通过），已从 `.gitignore` 移出并随仓库发布 —— 因为 `docs/README.md` / `README.md` / `RULES.md` 都链接它，继续忽略会造成公开仓库断链 |
| `docs/audits/*`、`docs/design/*`、`docs/research/*`、`docs/legacy/*` | 本机路径、真实 QQ 号 | 同上：**不带进新仓库**；只把 `AUDIT_FIXES` 与 `SECURITY_BASELINE` 带走（这两份已确认只含占位符） |
| `scripts/test-*`、`scripts/console-ui-*`、`src/sensitive.js`、`config.example.json` | 刻意构造的假 ID / 假凭据 / 占位符 | 误报：已在 `allowPaths` 白名单里 |

**结论**：真正必须在**代码**里改掉的只有 `public/console.html` 的群号；其余全部靠"不带进新仓库"解决。
