# DSH 0.2.1 起 `{{cwd}}` 提示词变量被移除 —— QQ 预设兼容性修复

> **本文的边界**：只记录 2026-10-19 这一处修复 —— 升级到 DSH **0.2.1-rc.2** 后，所有使用
> `qq-chat` / `qq-chat-v2` 预设的 QQ 会话**每一轮**都失败，原因是 persona 的 `suffix`
> 里引用了 DSH 0.2.1 不再注册的 `{{cwd}}`。升级 DSH 前请连同 §5 的生效步骤一起看。
>
> 前一轮适配（DSH 0.1.7 → 0.2.0-rc.2）的记录在 [DSH_020_ADAPTATION.md](DSH_020_ADAPTATION.md)。

---

## 1. 现象

DSH GUI 里 QQ 会话（`private:*` / `group:*` 映射的 agent 会话）连续出现：

```
处理失败
本轮运行失败  unknown prompt variable "{{cwd}}" in section "deployment:persona-suffix";
              registered variables: provider, model
```

- 会话本身能创建、模型也能选（桥接日志里 `已设置会话模型 … -> deepseek-flash (high)` 正常），
  失败发生在**提示词组装阶段**、早于模型请求，所以没有任何模型输出。
- 是**每一轮**都失败，不是偶发；重启 DSH 也不恢复（配置本身就错）。
- 具体报错格式由 `@deepseek-ai/dsh-system-prompt` 的严格插值抛出：
  `if (!Object.hasOwn(variables, name)) throw new Error(\`unknown prompt variable "{{${name}}}" in ${kind} "${input.name}"; registered variables: ...\`)`。

## 2. 根因

1. 两个预设的 persona 行都写着 `suffix: Your working directory is {{cwd}}.`。
   `@deepseek-ai/dsh-persona` 把 `config.suffix` 注册为名为 `deployment:persona-suffix` 的提示词段，
   `@deepseek-ai/dsh-system-prompt` 在每次组装时对段文本做**严格** `{{name}}` 插值：
   变量没注册就抛错，整个回合失败。
2. **DSH 0.2.1-rc.2 的 agent loop 只注册两个变量**（`@deepseek-ai/dsh-agent-loop` 里紧挨着的两行）：

   ```js
   ctx.systemPrompt.variable("provider", (context) => context.agent?.options.provider);
   ctx.systemPrompt.variable("model", (context) => context.agent?.options.model);
   ```

   0.2.0-rc.2 还注册过 `{{cwd}}`（桥接 v0.2.0 就是按那个版本写的、并按它做了校验），
   0.2.1 把它删了 —— 因此这是**升级 DSH 才暴露的回归**，不是 v0.2.0 引入的。
3. 官方 README 已经把这件事写成契约（`@deepseek-ai/dsh-system-prompt/README.zh.md`）：
   - 「循环提供 `provider` 和 `model`；插件可注册自己拥有的事实。工作目录服务通过**不执行插值**
     的用户上下文提供目录文本。」
   - 「自定义 persona 模板**不得依赖**内置 `{{cwd}}` 变量：循环不注册它，因此无法解析的引用会在
     任何模型请求之前使提示词组装失败。请……**移除 `Your working directory is {{cwd}}.` 语句**，
     保留无关文本。后缀没有其他内容时，可省略或清空该字段。」
4. 结论：`suffix` 里那句是**纯冗余**（工作目录本来就由工作目录服务写进运行时上下文），
   直接删掉即可；`prefix` 里的 `{{model}}` 是合法注册变量，必须保留。

## 3. 改动清单

| # | 文件 | 改动 |
| --- | --- | --- |
| 1 | `dsh/agent-presets/qq-chat/agent.cordis.yml` | 删除 persona 行 `suffix: Your working directory is {{cwd}}.`，注释改成「只注册 `{{model}}`（0.2.1 实测只有 provider / model），别写工作目录」 |
| 2 | `dsh/agent-presets/qq-chat-v2/agent.cordis.yml` | 同上（两代各一份，共享同一套 persona 契约） |
| 3 | `plugins/qq-agent-presets/presets/qq-chat.patch.yml`、`qq-chat-v2.patch.yml` | 由 `node scripts/build-agent-preset-patches.mjs` **重新生成**（禁止手改；生成物与已安装副本必须一致） |
| 4 | `scripts/verify-persona-config.mjs` | 断言从「suffix 保留 `{{cwd}}`」翻转为「suffix 不引用 `{{cwd}}」；新增**模板变量白名单**扫描：两个预设的 `prefix`+`suffix` 里所有 `{{name}}` 必须属于 agent loop 注册的 `provider` / `model` |
| 5 | `scripts/verify-dsh-020-adaptation.mjs` | §1 的 check 改成「保留 `{{model}}` 且不引用未注册的 `{{cwd}}`」 |
| 6 | `scripts/test-qq-preset-contract.mjs` | `assert.match(suffix, /{{cwd}}/)` 改为 `assert.doesNotMatch(..., /{{cwd}}/)` |
| 7 | `scripts/test-preset-prompt.mjs` | 行尾用例原本把期望写死为 CRLF（`assert.ok(crlf > 0)`），而本仓库副本是 LF，改动前就必然红灯（已用改动前备份文件复现）；改为**跟随源文件主导行尾**断言，并额外用合成 CRLF 源覆盖 CRLF 分支 |
| 8 | 文档 | 本文件 + `docs/README.md` 索引 + `README.md` / `README.en.md` 横幅 + `RULES.md` 的模板变量白名单说明 + `ONBOARDING_GOTCHAS.md` §3 |

`npm run test:preset-prompt` 里的 fixture 只测「prefix 的 YAML 往返保真」，不经过 DSH 插值，
所以它里面的 `{{model}} / {{cwd}}` 字面量**不需要**改（改了反而降低保真覆盖）。

## 4. 怎么验证

```bash
# 0) 仓库脚本要加载 DSH 自己的 schema；本机 profile 的 node_modules 解析不到时显式指定
set DSH_MODULES=<DSH 安装目录>\node_modules        # PowerShell: $env:DSH_MODULES='...'

# 1) 生成物与源一致（防手改 / 忘重新生成）
node scripts/build-agent-preset-patches.mjs --check

# 2) persona schema + 变量白名单
npm run verify:persona

# 3) 预设契约（reserved2 的 persona / 工具面 / 提示词不变量）
npx --no-install node --test scripts/test-qq-preset-contract.mjs   # 或 npm run test:token

# 4) prefix 往返保真
npm run test:preset-prompt

# 5) 部署对齐（DSH 在跑时）：patch 与源一致、persona 变量契约等
npm run verify:adaptation
```

静态检查能证明「配置合法、产物没漂移、变量都在白名单内」，**不能**证明回合真的跑通；
后者要用 §5 重启后发一条真实 QQ 消息观察日志里不再出现 `unknown prompt variable`。

## 5. 生效步骤（运维）

1. `node scripts/build-agent-preset-patches.mjs`（重新生成 `plugins/qq-agent-presets/presets/*.patch.yml`）。
2. 把这两个 patch 同步到 profile 实际加载的副本：`~/.dsh/plugins/qq-agent-presets/presets/`
   （重跑 `node scripts/setup-dsh.mjs` 也会做，且顺带校验其它安装项）。
3. **重启 DSH**：preset 行是 DSH 启动时由 bundle patch 插入的，热改文件不生效。
4. 发一条真实 QQ 消息，确认会话正常回复；`state/bridge.log` 与 DSH 会话里不再出现
   `unknown prompt variable`。

> ⚠️ 升级 DSH 小版本时也建议重跑 §4 的第 2、5 步：这一轮的问题正是「上游删了一个内置变量」，
> 静态校验能在重启前就发现，不用等到 QQ 群里每一轮都报错。

## 6. 为什么不用「自己把 `cwd` 注册回去」

技术上可以在预设里挂一个极小的 Cordis 行，调用
`ctx.systemPrompt.variable('cwd', ({ agent }) => agent?.session.header.cwd)` 把变量补回来。
不这么做的理由：

- 上游文档明确把「preset 模板不得依赖 `{{cwd}}`」写成契约，自行补注册等于**逆着契约走**，
  下次 DSH 再调整变量/作用域时同样会炸；
- 信息是重复的：DSH 已经在运行时上下文里给出 `Current working directory: ...`（不插值），
  persona 再写一遍没有收益；
- 每多挂一行插件，就多一份要跟 DSH 版本对齐的维护面。

所以要删的是**引用**，不是把变量补回来。
