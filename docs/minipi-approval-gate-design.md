# minipi M4 审批闸门设计（`repo` 场景护栏）

> 设计人：任析（架构师） · 日期：2026-09-23 · 版本：**v1.1.5**
> 上游：`docs/minipi-v0.4-impl-plan.md` §2.5（「同一个钩子两条规则」）、§3.3（写操作逐次确认）、§5 T1.5
> 定位：**唯一来源**（本文件是 M4 审批闸门的施工依据，工程师按此实现，不要再另出设计）
> 关联审计：`docs/minipi-v0.4-impl-audit.md` §7.5 —— 当前唯一 P0 安全缺口（`repo` 无防线）
> 状态：**M4 实现中（设计↔实现对账已闭环）**。`protocol.js` 契约（M4.2，白客）**已落地**；`approval.js`（M4.1，白客）**已补齐 R3/R4/R5 + T5**；`session.js` 脱敏归一（R6）**已闭环**；接线（M4.3/M4.4）与渲染层（M4.5）为后续。§9.4 对账表 **v1.1.5 全部 ✅**

> **v1.1 修订说明（2026-09-23）**：按 team-lead 裁决，对齐**任务 #3**（用户早已拍板的 UI 语义，此前因 M4 主体未做而悬空）：
> 1. **按钮由 2 个 → 3 个**：`allowOnce` / `deny` / `terminate`（中文术语：**「允许一次 / 拒绝 / 中断整轮」**）。触及 §2.2、§3.1、§4、§5.3、§9.1、§9.2、§9.3。
> 2. **收编「本会话总是允许」设置项**（`alwaysAllowInSession`，**默认关**，会话级、不持久化）；同时把 §10 原「不做」一条**改精确**——仍不做的是「持久化 + 指纹级」。
> 3. **M4.0 异步钩子探针取消**：已由 vendor 源码**确证**钩子支持 `await`（`types.d.ts:902` + `runner.js:753`）⇒ **走路径 A**；B / B′ 退路作废。触及 §2.3、§2.4、§11。
> 4. **补记 vendor 实证**：`terminate` 的 every 语义（`types.d.ts:822-826` 原文）、`block` 短路返回（`runner.js:756-758`）、`event.input` 可变（`types.d.ts:721-722`）。
>
> **v1.1.1 修订说明（2026-09-23）**：读了白客已落地的 M4.2 契约与进行中的 M4.1 `approval.js`，做**实现↔设计对账**（新增 §9.4）：R1/R2 命名收敛（本设计改）；**R3/R4/R5 三处需白客补齐**（terminate 专属文案、卡片 `actions`/`alwaysAllowEligible` 字段、会话级 always-allow）。已同步白客。
>
> **v1.1.2 修订说明（2026-09-23）**：按 team-lead 裁定，**固化「`action` 字段值三值为唯一合法写法」为红线**（§9.2 脚注）。并做**全文两值残留核对**——结论：**无残留**。§9.2 表格（`:571`）、§9.1 常量（`:560`）、§3.1（`:154`）、§3.6（`:246`）、§2.5（`:133`）**均为三值**；`§10`/`§11`/修订说明中的「允许/拒绝」为**中文术语或历史叙述**，非字段值，**不改**。（白客发现的两值印象来自 v1.0/v1.1 早期快照；v1.1 起已改。）同时修正 §1 前置事实的**重复编号**（原两个 `5.`，已顺延为 5–8）。
>
> **v1.1.3 修订说明（2026-09-23）**：**终态对账**（§9.4）。白客已在 M4.1 中补齐 R3/R4/R5，并额外修复 **T5 定时器泄漏**（用户超时前批卡、`setTimeout` 仍在跑 ⇒ 5 分钟后 `_onTimeout` 误触发）。**§9.4 对账表至此全部闭环**（R1–R5 + T5 均 ✅）。秦戈独立 QA 可逐条打勾。
>
> **v1.1.4 修订说明（2026-09-23）**：**修正 §7.2 的事实前提错误**（白客实现中发现，team-lead 核实）。原文「复用 `session.js` 的 `sanitizeDetail` 口径」**方向写反**——经核实 `sanitizeDetail`（`session.js:77-93`）**只实现 ①②④、缺 ③ 密钥**，其 JSDoc 却承诺含密钥脱敏（承诺≠实现）。**正确架构关系**：脱敏口径**权威定义在 §7.2**，`approval.js` 导出 `redactSecrets()`/`sanitizeForAudit()` 为**唯一实现点**，`sanitizeDetail`（29 处调用点）**import 复用**。已同步修正 §7.2 正文 + §13 自检第 6 项。「复用 X」vs「由 Y 定义、X 复用」是两种不同架构关系，写反会导致后人误在 session 侧「补一份」⇒ 回到双份实现。
>
> **v1.1.5 修订说明（2026-09-23）**：**R6 闭环**。`session.js:64` 已 `import { redactSecrets } from "./approval.js"`，`sanitizeDetail` 第 3 步（`:100-101`）已接入，**顺序为「路径替换之后、截断之前」**（正确——放截断后会让超长文本的密钥被截半而漏脱）。**§9.4 对账表 R1–R6 + T5 全部 ✅**。**编号已整理**：不再有「已闭环却列在待办段」的不一致。**历史说明段保留**（记录「设计曾写反方向、`sanitizeDetail` 曾缺第 3 步」），作为防复发依据。唯一遗留：`approval.js:136` 注释仍写反（「抄 session.js」），**归白客修正**（第三处方向写反，代码侧）。

---

## 0. 一句话与范围

**一句话**：M4 审批闸门 = 在**已有的** `pi.on("tool_call")` 钩子里补一条「规则 2」——`repo` 场景下所有会改动系统的工具调用，**挂起该轮、弹一张审批卡给用户、等用户点「允许一次 / 拒绝 / 中断整轮」或 5 分钟超时（默认拒绝）**；拒绝/超时则 `{block:true}` 回灌模型，允许则放行（原样不改参）。

**本设计覆盖**（team-lead 点名的 7 项 + 任务 #3 的三 outcome，逐项有专节）：

| # | 必答项 | 所在节 |
|---|---|---|
| 1 | 等用户决策的实现（钩子 `await` 审批 Promise；已由 vendor 源码确证可行） | §2 |
| 2 | 三类审批卡内容（`write` / `edit`（含**真实 diff**）/ `bash`+`powershell`） | §3 |
| 3 | 多 ask 合并规则（一次一批多工具调用）+ **三按钮的批量语义** | §4 |
| 4 | 5 分钟超时**默认拒绝** | §5 |
| 5 | 未决审批持久化（进程重启后不静默变「已允许」） | §6 |
| 6 | 审计日志脱敏 | §7 |
| 7 | `quick` 场景兜底（无工具 / 有工具但无需审批） | §8 |
| 8 | **三 outcome**（允许一次 / 拒绝 / 中断整轮）+ **会话级 always-allow（默认关）** —— 任务 #3 已拍板项 | §3.6 / §5.3 / §4.2 |

**本设计不覆盖**（显式不做，别偷偷加）：
- 沙箱规则（规则 1）—— 已由 `sandbox.js` 实现，本设计**不改它**。
- 审批的「**持久化 + 指纹级**记住选择（精确到命令内容、跨重启保留）」—— 见 §10 未做项。（注意：**会话级 + kind/tool 级**的 `alwaysAllowInSession` 要做，见 §3.6；两者不是同一件事。）
- 渲染层审批卡的**视觉稿**—— 本设计只给**数据契约 + 交互语义**；像素由渲染层负责（零依赖单文件约束不变）。
- `desk` / `note` 场景 —— 它们无 `bash`/`edit`，`write` 永远落在 outbox（沙箱已拦），**不进审批闸门**。见 §8。

---

## 1. 前置事实（实现前必须先接受，别推翻）

1. **钩子只有一处**：`session.js` 的 `registerGate(pi, ctx)`（`:600-633`），规则 1（沙箱，`:607-620`）已在，规则 2 是留空（`:621-624`）。M4 **只补规则 2**，不新起机制。
2. **顺序不可反：先沙箱 → 后审批**（`session.js:606-624`，plan §2.5）。本设计**保持**该顺序，规则 2 只在规则 1 通过后执行。
3. **钩子返回值语义**（**已由 vendor 源码确证**，非实测猜测）：
   - `pi.on("tool_call", cb)` 的 `cb` **可以返回 `Promise`**：类型签名 `ExtensionHandler<E,R> = (event, ctx) => Promise<R|void> | R | void`（`vendor/pi/packages/coding-agent/dist/core/extensions/types.d.ts:902`），且 runner **真的 `await` 它**：`const handlerResult = await handler(event, ctx);`（`dist/core/extensions/runner.js:753`）。
   - 返回值形状 `ToolCallEventResult = { block?: boolean; reason?: string; terminate?: boolean }`（`types.d.ts:818-827`）。
   - `block:true` 让该调用**被拒**，`reason` **逐字**回灌给模型作为 tool result；模型**不重试**（spike 实测）。
   - `terminate:true` 是 **every 语义**，vendor 原文：*"Early termination only happens when **every** finalized tool result in the batch sets this to true."*（`types.d.ts:822-826`）⇒ **合并卡要让整批都带 `terminate:true`**（否则不生效），见 §3.6 / §4.2。
   - **`block` 是短路返回**：`runner.js:754-758` `if (result) { result = …; if (result.block) return result; }` ⇒ 一旦某 handler 返回 `block`，**后续 handler 不再被调用**。这从 SDK 层面**印证了「沙箱规则 1 先于审批规则 2」的正确性**——沙箱 block 后审批**根本不会被调用**，是**双重保障**，不只是「我们约定先判沙箱」。
   - 被 `block` 的调用**仍会发** `tool_execution_start/end`（`isError:true`）⇒ **审批卡必须在 `tool_call` 钩子里推**，不能等 `tool_execution_start`（会晚一拍）。
4. **钩子可以 `await` 用户交互**（v1.1 修正，推翻 v1.0 的「必须同步」假设）：既然 `ExtensionHandler` 允许返回 Promise 且 runner `await` 它，**「等用户决策」直接就是 `await approval.request(...)`**——不需要任何「同步泵 / Atomics / 轮询」花招。这是本设计的**实现基础**，见 §2。
5. **`event.input` 可变**（vendor 明示，`types.d.ts:721-722`）：*"`event.input` is mutable. Mutate it in place to patch tool arguments before execution. Later `tool_call` handlers see earlier mutations. No re-validation is performed after mutation."* ⇒ **本设计刻意不改参**（审批只放行/拒绝，不改模型给的内容）；此条仅记录能力边界，防后人误用（改参会绕过校验，是安全隐患）。
6. **`repo` 沙箱不生效**（设计如此）：`repo` 的 `cwd = ~/.minipi/repo`，且白名单含 `bash`/`powershell`/`edit`。沙箱对 `repo` **刻意放行**（`sandbox.js:171-177`），所以 `repo` 的**唯一防线就是本审批闸门**。
7. **零依赖约束**：`approval.js` 必须是**纯 Node 模块**（不 import `electron`、不 import Pi SDK），可被 `node scripts/verify-approval.mjs` 离线单测。所有「弹窗 / 发 IPC」通过**注入的回调**完成（与 `outcome/index.js` 注入 `shell`/`dialog` 同款模式）。
8. **`session.js` 仍只 import SDK**：规则 2 内部调 `approval.js`，但 `session.js` **不替 approval 做 electron 的事**——`approval.js` 的 bridge 由 `main/index.js` 构造并注入到 `PiSessionHost`。见 §2.3。

---

## 2. 等用户决策的实现（核心）

### 2.1 问题陈述（v1.1：问题其实不存在）

「审批要停下来等人」——**Pi 的钩子本来就支持这一点**。v1.0 假设「钩子必须同步返回」，于是设计了一套「同步泵 / Atomics / 轮询」的复杂度；v1.1 已由 vendor 源码**证伪该假设**：钩子可以返回 Promise，runner 会 `await`（见 §1 第 3、4 条）。**所以本设计不需要任何阻塞技巧。**

### 2.2 采用方案：钩子里直接 `await`（路径 A）

```
tool_call(event):                       # async 钩子
  # 规则 1：沙箱（不变，先执行）
  if sandboxed and 目标非法:  return { block: true, reason: SANDBOX_DENY_REASON }   # 短路，审批不会被调用
  # 规则 2：审批
  decision = await approval.request({ sessionId, sceneId, toolName: event.toolName, input: event.input })
  switch decision.action:
    "allowOnce":  return undefined                                   # 放行（不改参）
    "deny":       return { block: true, reason: decision.reason }    # 拒绝
    "terminate":  return { block: true, reason: decision.reason, terminate: true }   # 中断整轮
```

`approval.request(...)` 是 **async 函数**（返回 `Promise<Decision>`）：

```
async request(call):
  id = nextId()
  pending = new PendingApproval(call)          # 含 { resolve }
  this._pending.set(id, pending)
  this._bridge.pushCard(buildCard(call))       # ← 先推 IPC 给渲染层（用户看到卡）
  this._startTimer(id, TIMEOUT_MS)             # ← 5 分钟定时器（§5）
  return pending.promise                       # ← await 在这里挂起，直到 decide()/超时 resolve
```

**为什么这才是对的**：`emitToolCall` 本身是 `async` 且 `await handler(...)`（`runner.js:745-763`）⇒ 钩子返回的 Promise 挂起期间，**主进程事件循环照常跑**，`webContents.send` 出的卡能被渲染、用户能点按钮、`decide()` 能 resolve 该 Promise、`await` 被唤醒、`tool_call` 返回决策。**全程没有阻塞。**

### 2.3 探针取消（v1.0 的 M4.0 作废）

v1.0 设了一个硬前置「M4.0 异步钩子探针」。**取消**——答案已在 vendor 源码里：

| 证据 | 位置 | 结论 |
|---|---|---|
| `ExtensionHandler<E,R> = (event, ctx) => Promise<R\|void> \| R \| void` | `dist/core/extensions/types.d.ts:902` | 类型**允许**返回 Promise |
| `const handlerResult = await handler(event, ctx);` | `dist/core/extensions/runner.js:753` | runner **真的 await** |
| `if (result.block) return result;` | `dist/core/extensions/runner.js:756-758` | `block` **短路**返回 |

⇒ **路径 A 成立**。不需要探针、不需要 B / B′。

### 2.4 路径 B / B′ 作废（保留记录，防后人重新捡起）

v1.0 为「钩子只能同步」准备的退路**全部作废**，理由写在这里，**不要重新实现**：

- **路径 B（同步泵）**：不存在的需求。钩子既然能 `await`，没有「同步返回 + 事后续跑」的必要。
- **路径 B′（先问后跑，多一轮往返）**：体验更差且没必要。**作废**。
- 若将来 SDK 把 `ExtensionHandler` 改回同步（不太可能）⇒ 那是**上游 breaking change**，按版本升级流程处理，**不是**现在预置复杂度。

> **数据契约（§3）、超时（§5）、持久化（§6）、脱敏（§7）不受本节影响**——它们从一开始就与「A/B/B′」解耦。

### 2.5 bridge 注入（谁推卡、谁收决策）

`approval.js` 零依赖 ⇒ 它不认识 electron。构造时注入一个 **bridge**：

```js
/**
 * @typedef {object} ApprovalBridge
 * @property {(card: ApprovalCard) => void} pushCard      主→渲染：推审批卡（同步推 IPC）
 * @property {(card: ApprovalCard) => void} cancelCard    主→渲染：撤回卡（超时/会话销毁/alwaysAllow 生效）
 * @property {(entry: AuditEntry) => void} audit          审计落盘（同步，已脱敏）
 */
```

- `main/index.js` 构造 `approval = new ApprovalGate({ bridge, logger })`，bridge 里 `pushCard` 用 `wm.sendToRenderer(EVENTS.APPROVAL, card)`。
- 渲染层用户点按钮 → `ipcRenderer.invoke(INVOKE.APPROVAL_DECIDE, { approvalId, action })` → `main/index.js` 的 handler 校验 `action ∈ {allowOnce,deny,terminate}` 后调 `approval.decide({ approvalId, action })`。
- `approval.decide()` 同步 resolve 对应 pending 的 Promise ⇒ §2.2 的 `await` 被唤醒。

> **契约扩展**（§9 有完整表）：`EVENTS` 增 `APPROVAL`，`INVOKE` 增 `APPROVAL_DECIDE`，`ERROR_CODES` 增 `APPROVAL_TIMEOUT` / `APPROVAL_DENIED` / `APPROVAL_NOT_FOUND`。这些**必须写进 `protocol.js`**（唯一契约文件），不能散落在实现里。

---

## 3. 三类审批卡内容

**卡是「给人看的」，必须让用户在不看代码的情况下判断「这一下点下去会发生什么」。** 按工具分三类，字段由 `approval.js` 的 `buildCard(call)` 生成（**纯函数**，可单测）。

### 3.1 通用字段（三类共有）

| 字段 | 类型 | 说明 |
|---|---|---|
| `approvalId` | `string` | `a_<n>`，decide 时回传 |
| `sessionId` | `string` | 所属会话 |
| `phase` | `"push" \| "update" \| "cancel"` | 推 / 就地更新（合并新增条目）/ 撤回（超时 / 会话销毁 / alwaysAllow 命中） |
| `kind` | `"write" \| "edit" \| "command"` | 卡片类别，渲染层据此选模板 |
| `toolName` | `string` | 原始工具名（`write`/`edit`/`bash`/`powershell`） |
| `title` | `string` | 人类可读标题，如「写入文件」「修改文件」「执行命令」 |
| `actions` | `["allowOnce","deny","terminate"]` | **恒为这三项**（v1.1 起）。渲染层画三个按钮：**允许一次 / 拒绝 / 中断整轮**。术语中文，字段值英文 |
| `createdAt` | `number` | Unix ms |
| `expiresAt` | `number` | `createdAt + APPROVAL_TIMEOUT_MS`，渲染层倒计时用 |
| `timeoutMs` | `number` | 恒为 `APPROVAL_TIMEOUT_MS`，前端倒计时用 |
| `cwd` | `string` | 会话工作目录（**已 `~` 化**，不回传绝对家目录） |
| `batch` | `ApprovalBatchItem[]` | 本次合并的调用列表（§4）；单条时长度为 1 |
| `alwaysAllowEligible` | `boolean` | §3.6：本卡是否允许用户勾「本会话总是允许」（**当前恒 `true`**；若将来对某些高危 `command` 禁止恒允许，这里置 `false`） |

### 3.2 kind = `write`（工具 `write`）

| 字段 | 说明 |
|---|---|
| `path` | 目标文件路径（相对 cwd 展示；越出 cwd 时显示 `<path:文件名>`，见 §7） |
| `bytes` | `content` 的 UTF-8 字节数（**不塞全文**，见下） |
| `preview` | 内容**前 N 行 / 前 2000 字符**（取小者），超出加省略号 |
| `overwrite` | `boolean`：目标是否**已存在**（存在 = 会覆盖，UI 必须**重警示**） |

> **设计取舍**：`write` 卡**给预览但不给全文**——全文可能几十 KB，塞进卡会撑爆 360×480。用户判断「要不要写」只需看开头 + 文件名 + 是否覆盖。

### 3.3 kind = `edit`（工具 `edit`）—— **必须给真实 diff**

这是 team-lead 点名的重点。**`input` 契约已核实**（`vendor/pi/packages/coding-agent/src/core/tools/edit.ts:32-41`，**不是猜的**）：

```ts
editSchema = { path: string, edits: [{ oldText: string, newText: string }, ...] }   // 现行形状
// 另兼容 legacy 顶层形状 { path, oldText, newText }（edit.ts:125-133 prepareEditArguments 会归一到 edits[]）
// 也兼容 edits 被模型发成 JSON 字符串 / 单个对象（edit.ts:110-123）
```

**审批卡必须展示「从这个 → 变成那个」的真实差异，而不是只给一个文件名。**

> ✅ **实现提示（比原设计更省）**：`edits[].oldText / newText` 就是**这次改动的最小片段**（模型被要求「oldText 尽量小且唯一」）。所以 **diff 可以直接由 `edits[]` 生成，无需读盘**——既准确（就是即将写入的内容）又**无 TOCTOU**（不在审批与执行之间被改）。这比「读文件再 diff」更稳。

| 字段 | 说明 |
|---|---|
| `path` | 被修改文件路径 |
| `diff` | **真实 diff 文本**（unified 风格，或结构化 hunk 列表，见下） |
| `diffStat` | `{ added: number, removed: number }`，摘要行 `+8 -3` |
| `tooLargeToDiff` | `boolean`：改动过大（超 `DIFF_MAX_BYTES`）时为 true，UI 提示「改动较大，仅显示统计」 |

**diff 生成**（`buildEditDiff(input)`，纯函数，零依赖）：

- 入参：**归一化后的 `edits[]`**（见上：先跑一个 `normalizeEditInput()` 把 legacy 顶层形状 / JSON 字符串 / 单对象都归到 `edits[]`，**口径抄 `edit.ts:103-141` 的 `prepareEditArguments` + `validateEditInput`**，保证与 SDK 一致）。
- **逐条 `edits[]` 生成 hunk**（`edits[]` 本就是多处、不相邻的最小改动）：
  1. 每条 `{oldText,newText}`：按行切，找**最长公共前缀行**（context-before）、**最长公共后缀行**（context-after，不与前缀重叠）；
  2. 中段：`- oldText 行` / `+ newText 行`；
  3. **不额外造上下文**——`oldText` 已经是模型给的最小唯一片段，够了（无需从文件读 3 行上下文，也就没有读盘）。
  4. 多条 `edits[]` 之间用 `@@` 分隔，编号 `edit 1/3`。
- `diffStat` = 全条 `edits[]` 的 `+行数 / -行数` 汇总。
- **为什么不上 LCS 全量**：`edits[]` 已是「最小改动段」，前缀/后缀裁剪足够；全量 LCS 在超大片段上是 O(n·m)，没必要（「不为未来设计」）。
- **边界**：单条 `oldText`/`newText` 超 `APPROVAL_DIFF_MAX_BYTES`（64KB）⇒ 该条只给 `+行数 -行数`（不逐行），置 `tooLargeToDiff:true`。

> **与 SDK 的关系（说清，避免「重复造轮子」的质疑）**：Pi 自己在 `edit-diff.ts` 里用 `diff` npm 包算 `generateDiffString` / `generateUnifiedPatch`，但那是**在 `execute()` 内、拿到文件后**算的；`tool_call` 钩子跑在 `execute()` **之前**，**拿不到** SDK 的 diff 结果（且 hook 的 event 里没有 `patch` 字段——`EditToolDetails` 是 execute 的返回值）。所以钩子侧必须自己算。**不引 `diff` 包**是为了守住 `approval.js` 的零依赖（与 `sandbox.js` 同款约束）；我们只用 `edits[]` 内的前后缀裁剪，无需通用 diff 算法。

> **验收锚点**：把 `edit` 卡的 `diff` 对应到 `edits[]` 的每一处改动肉眼可读（`- 旧行 / + 新行`）+ `diffStat` 与 `edits[]` 行数一致。**不接受**「只显示 newText」「只显示文件名」「只显示第一条 edit」。

### 3.4 kind = `command`（工具 `bash` / `powershell`）

> **契约已核实**：`bash` 与 `powershell` **共用同一 schema** `{ command: string, timeout?: number }`（`bash.ts:38-40`；`powershell.ts` 复用 `createShellToolDefinition` 的 `cwd` 与 exec）。`timeout` 是**秒**、可选、无默认（`bash.ts:25-35`）。

| 字段 | 说明 |
|---|---|
| `shell` | `"bash" \| "powershell"` |
| `command` | 完整命令文本（这是**人看着决定**的核心 —— `repo` 的防线就是「人看着整条命令决定」，plan §2.2） |
| `cwd` | 执行目录（`~` 化） |
| `timeoutSec` | `number \| null`：模型给的超时（秒），无则 `null`。**卡上要显示**——超时很长意味着命令可能卡住 |
| `risk` | `"normal" \| "high"`：命中高危模式时置 high，UI 加重警示（**下节**） |

**高危命令标记**（`classifyCommand(command)`，纯函数，**只做提示、不做拦截**——拦截会让用户困惑「为什么我不能跑 `rm`」，而审批的意义就是「让用户自己看着决定」）：

命中下列**正则**（大小写不敏感）之一 ⇒ `risk:"high"`：

| 模式 | 命中示例 |
|---|---|
| `rm -rf` / `rm -r` | `rm -rf node_modules` |
| `Remove-Item.*-Recurse` | PowerShell 递归删除 |
| `git reset --hard` / `git clean -fd` / `git push.*--force` | 破坏性 git |
| `git checkout .` / `git restore .`（丢弃工作区） | |
| `> /dev/null` 之外的重定向到已存在文件（`>` 覆盖） | 保守起见，`>` 出现即提示 |
| `curl.*\| *(sh\|bash)` / `iwr.*\| *iex` | 管道执行远端脚本 |
| `chmod -R` / `chown -R` | 权限递归变更 |
| `:\|:&`（fork 炸弹）、`mkfs`、`dd if=` | 破坏性系统命令 |
| `npm publish` / `git push`（对外副作用） | 发布/推送（**建议 high，团队可讨论**） |

> `classifyCommand` 只返回标签，**不产生 block**。它让用户在**最该警觉的时候**看到红色，不替代用户判断。

### 3.5 卡片不显示的内容（脱敏，详 §7）

**审批卡绝不显示**：绝对家目录（`~` 化）、`auth.json`/`.env` 之类的密钥路径内容、`content` 全文（只给 preview）。**但 `bash` 的 `command` 必须原样显示**——命令是用户判断的唯一依据，脱敏它等于废掉审批（见 §7.3 的例外说明）。

### 3.6 三 outcome 的语义（v1.1，任务 #3 拍板项）

卡上恒定三个按钮，**中文术语「允许一次 / 拒绝 / 中断整轮」**；`action` 字段值 `allowOnce` / `deny` / `terminate`。

| 按钮（中文） | `action` 值 | 钩子返回 | 语义 |
|---|---|---|---|
| **允许一次** | `allowOnce` | `undefined` | 放行这**一次**调用（不改参）。下次同工具**还会再问**（除非命中 §3.6.2 的会话级 always-allow） |
| **拒绝** | `deny` | `{ block: true, reason }` | 拒掉这**一条/整批**，模型**不重试**该操作，改为询问用户。轮次继续 |
| **中断整轮** | `terminate` | `{ block: true, reason, terminate: true }` | **停止这一整轮 agent 运行**（不是「只拒这一条然后继续」） |

#### 3.6.1 ⚠ 「中断整轮」的 every 语义（**必须按此实现，否则按钮不生效**）

vendor 原文（`types.d.ts:822-826`）：*"Early termination only happens when **every** finalized tool result in the batch sets this to true."*

⇒ **`terminate` 要对「同批全部结果」都置 `true` 才生效**。所以：

- **单条卡**（`batch.length === 1`）→ 直接 `{ block, reason, terminate: true }`，OK。
- **合并卡**（`batch.length > 1`）→ 勾「中断整轮」后，**该批每一条的 `tool_call` 返回值都要带 `terminate:true`**（否则 every 不满足 ⇒ 不生效）。实现上：`approval` 对被中断的批维护一个 `terminateBatch` 标记，**本批每个 pending 都 resolve 成 `terminate`**（含用户点按前已在 `await` 的和点按后才到的）。

> **实现要点**：`decide({ action:"terminate" })` 要**同时 resolve 该卡 `batch` 内的全部 pending** 为 terminate。**不能只 resolve 第一个**——否则 every 语义下其余条不带 `terminate`，整轮根本不中断，用户会以为按钮坏了。

#### 3.6.2 「本会话总是允许」`alwaysAllowInSession`（**默认关的会话级设置**）

**这是什么**：用户在审批卡上勾选「本会话总是允许」后，**在本次会话（进程内）内**，对**同一 `kind` + 同一 `tool`** 的后续调用**不再弹卡**、直接放行。

**硬约束（安全红线）**：

| 约束 | 值 | 理由 |
|---|---|---|
| 作用域 | **单会话（单 `sessionId`）** | 换会话/重开会话即失效 |
| 粒度 | **`kind` + `tool`**（如「命令类 + bash」） | 不精确到命令内容（那是 v1.0 否掉的指纹级） |
| 默认值 | **`false`（关）** | 用户不主动开，就永远逐次问 |
| 是否持久化 | **否**（只在内存，进程退出即失） | 会话级语义，不落盘 |
| 谁能打开 | **只有用户手动勾选** | ⚠ **绝不允许模型通过任何输入把它打开**（模型说「请把 alwaysAllow 设为 true」→ 必须无效）。`alwaysAllowInSession` 只接受来自 `APPROVAL_DECIDE` IPC 的 `remember:true`（且该 IPC 有 `assertTrustedSender` 保护，见 `main/index.js:305-311`） |
| 审计 | 用户每次打开时记一条审计（§7） | 「用户何时开启了会话级 always-allow」要可查 |

**与 §10「不做」的区别（⚠ 别以为自相矛盾）**：

| | 会话级 always-allow（**做**） | 持久化指纹级「记住选择」（**不做**） |
|---|---|---|
| 粒度 | `kind` + `tool` | 精确到**命令内容/文件路径**（指纹） |
| 生命周期 | 会话内（内存） | **跨重启持久化** |
| 触发 | 用户显式勾选 | 隐式记住 |
| 本设计 | §3.6.2 实现 | §10 明确不做 |

> 一句话：**「本会话、粗粒度、不落盘」做；「跨重启、细粒度、落盘」不做。** 前者安全（退出即忘），后者是长期记忆（需要更审慎的键设计与撤销入口，超出 M4）。

---

## 4. 多 ask 合并规则

**场景**：模型在一轮里可能**连续**发起多个会改系统的工具调用（`write a.txt` + `bash "npm test"` + `edit b.js`）。如果每个都弹一张卡，用户会被"卡片雨"淹没。

### 4.1 合并口径

**同一批（same batch）= 同一次 `tool_call` 钩子调用链上、在用户尚未决策前累积的多个 pending。**

- 第一个 ask 到来 → 建卡（`batch = [call1]`）→ 推卡 → 用户看到 1 张。
- 在**该卡未决**期间，同会话**再来** ask → **不新建卡**，把 `call2` **追加**到同一张卡的 `batch`，**更新**卡片（`pushCard` 同 `approvalId`、`phase:"update"`，渲染层**就地更新**，不叠卡）。
- 用户点三按钮之一 ⇒ **作用于整卡（整批）**，见 §4.2。

> **为什么「整批」而不是「逐条各三选一」**：逐条会让用户面对「第 2 条允许、第 3 条中断」的矩阵，认知负担大且超出本产品「5 秒通道」的定位。**整批语义简单、可预期**——这也是任务 #3 的「合并卡的按钮是批量语义，不是逐条语义」口径。**逐条矩阵**见 §10（未做项）。

### 4.2 合并卡的按钮 = **批量语义**（v1.1 明确）

合并卡上的三个按钮**作用于整批**，不是作用于卡内某一条：

| 按钮 | 对整批的动作 |
|---|---|
| **允许一次** | 整批全部 `allowOnce`（每条 `await` 都 resolve 为放行） |
| **拒绝** | 整批全部 `deny` |
| **中断整轮** | 整批全部 `terminate`（**必须每条都带 `terminate:true`**，否则 every 语义不生效，见 §3.6.1） |

**实现要点**：`decide({ approvalId, action })` 要**遍历该卡 `batch` 关联的全部 pending 并逐个 resolve 成同一 `action`**。合并卡里每个 pending 是各自 `tool_call` 钩子里的一个 `await`——**必须全部唤醒**，否则未唤醒的那个会一直挂到 5 分钟超时。

### 4.3 「非显式允许一律落到拒绝」原则（v1.1 补，任务 #3 口径）

**任何未经用户显式点击「允许一次」的路径，一律按「拒绝」处理。** 包括且不限于：

- 5 分钟超时（§5）→ 拒绝
- 会话销毁 / 进程重启时未决（§6）→ 丢弃，**不是**允许
- 卡内条目的勾选态若有「非显式允许」的形态（当前三按钮下无勾选；若将来加多选 UI）→ **未勾选 = 拒绝**
- 任何 `decide` 收到非法 / 未知 `action` → 按拒绝（且 `APPROVAL_DECIDE` 已先做 `INVALID_ARGUMENT` 校验，见 §9.2）

> 这与沙箱「realpath 失败 = 拒绝」、超时「默认拒绝」是**同一条安全口径**：**默认不信任，没听到明确的「是」就是「否」。**

### 4.4 合并的**边界**（必须有上限，防爆卡）

| 规则 | 值 | 理由 |
|---|---|---|
| 单卡最多合并条数 | `BATCH_MAX_ITEMS = 20` | 超过则**新建一张卡**（上一张先行等待），防止一张卡无限长 |
| 卡片渲染 | `batch` 超过 5 条时，UI 默认折叠「还有 N 条」 | 360×480 装不下 20 条的 diff |
| 合并窗口 | 与卡「未决」绑定（无独立时间窗） | 用户一旦决策，合并窗口即关闭 |

### 4.5 不同类别能否合并

**可以**（`write` + `command` 混在一张卡里），但卡片按 `kind` **分组展示**（先列所有文件改动、再列所有命令），每组给小标题。**不合并的例外**：沙箱规则（规则 1）**永不进卡**（硬拦，§1 第 2 条）。

### 4.6 并发会话

不同 `sessionId` 的 ask **不合并**（各自一张卡）。`repo` 同时只会有一个会话（单窗口单会话约束，`session.js` 的 `_lastSessionId` 语义），但设计上按 sessionId 隔离，防将来多会话。

---

## 5. 5 分钟超时，默认拒绝

### 5.1 语义

| 项 | 值 |
|---|---|
| 超时常量 | `APPROVAL_TIMEOUT_MS = 5 * 60 * 1000`（5 分钟） |
| 超时动作 | **默认拒绝**（`action = "deny"`），理由 `APPROVAL_TIMEOUT` |
| 超时后 | pending 从表中移除（合并卡整批）；`cancelCard` 撤回卡（UI 显示「已超时，已拒绝」）；**回灌模型的 reason 要说清是超时**（见 5.3）。⚠ 超时**只**对应 `deny`——「中断整轮」是用户**主动**动作，不会由超时产生 |

### 5.2 为什么默认拒绝（不是放行）

**安全底线**：审批是「默认不信任」。用户没在 5 分钟内明确说「同意」，就**等于没同意** ⇒ 拒绝。**任何「超时=放行」都是 fail-open，绝不能有。** 与沙箱「realpath 失败=拒绝」同款口径（plan §2.2 第 4 条）。

### 5.3 回灌文案（给模型，英文逐字）——**三套，必须区分**

三种「非允许」结局**要区分**——模型的应对不同（超时 → 可以再问；拒绝 → 别再试；中断 → 停手等用户）。

**① 超时**（`APPROVAL_TIMEOUT`）：

```
The user did not respond to the approval request within 5 minutes, so this action was denied by default.
Do not retry this action automatically. Briefly tell the user the action is pending their approval.
```

**② 用户主动拒绝**（`action:"deny"`）：

```
The user explicitly denied this action. Do not retry it. Ask the user what they want to do instead.
```

**③ 用户「中断整轮」**（`action:"terminate"`，v1.1 新增）：

```
The user halted this run. Stop working now and wait for the user's next instruction.
```

> **③ 与 ② 的关键差别**：`deny` 是「这条不行，换个办法继续」；`terminate` 是「**整轮停**」——模型**不得**继续尝试别的工具或改路径重试，直接交还控制权。配合 `terminate:true`（§3.6.1）语义。

### 5.4 定时器实现注意

- 用 `setTimeout`，在 `request()` 里注册；`decide()`（任一 action）或超时命中时 `clearTimeout`。
- **定时器必须在会话销毁时清掉**（`disposeSession` → `approval.cancelBySession(sessionId)`，§6.3），否则悬空定时器持有 pending。
- 超时命中 = `decide({ action:"deny" })` 的等价路径（reason 用超时文案），**合并卡整批一起超时**。

---

## 6. 未决审批持久化

**问题**：进程重启（崩溃 / 用户退出）时，若有 pending 审批，重启后**绝不能**变成「已允许」——必须安全落地。

### 6.1 存储位置

`~/.minipi/approvals.json`（与 `settings.json` 同级，`ensureAppDirs` 已保证目录存在）。

### 6.2 记录形状

```json
{
  "version": 1,
  "pending": [
    {
      "approvalId": "a_7",
      "sessionId": "s_2",
      "kind": "command",
      "toolName": "bash",
      "batch": [ { "toolName": "bash", "commandRedacted": "npm test" } ],
      "createdAt": 1730000000000,
      "expiresAt": 1730000300000,
      "status": "pending"
    }
  ]
}
```

> ⚠ **持久化的内容必须已脱敏**（§7）——绝不能把 `write` 的完整 `content` 或绝对路径原样落盘。存的只是「有一条待批记录」的证据，不是可回放的参数。

### 6.3 生命周期

| 时机 | 动作 |
|---|---|
| `request()` 建 pending | **同步**追加到内存表 + 标记「落盘待写」 |
| 落盘 | **异步、去抖**（`setTimeout 200ms` 合并多次写；用 `fs.writeFile` + 临时文件 + `rename` 原子替换）——**不能阻塞审批热路径** |
| `decide()` 命中（`allowOnce`/`deny`/`terminate` 任一） | 从 `pending` 移除（**合并卡整批**）；**同步**记审计（§7）后异步落盘 |
| 超时 | 同 `decide()`（按 `deny`） |
| 会话级 always-allow 生效 | 后续同 `kind`+`tool` 的 ask **不建 pending**（直接放行）；已推的卡 `cancelCard`；**不落盘**（纯内存，§3.6.2） |
| 会话 `dispose` | `cancelBySession` 移除该会话全部 pending + **清该会话的 always-allow 记录** + 落盘 |
| 进程启动 | **读 `approvals.json`**：**不恢复任何 pending**（见下），只把「上次有未决审批」作为**审计事件**记一笔，然后把文件里的 `pending` **清空重写**（`alwaysAllowInSession` 从不落盘，故无需处理） |

### 6.4 重启策略：**一律丢弃，不恢复，更不放行**

- 重启后**不恢复** pending 卡（旧卡牵扯的会话已没了，恢复出来点「允许」也无从执行）。
- 重启后**绝不**把旧的 pending 当「已允许」。
- 重启时对每条遗留 pending：写一条审计 `{ type: "approval_lost_on_restart", approvalId, ... }`（脱敏），然后**丢弃**。
- **文件的唯一职责**是「崩溃诊断 + 审计留痕」，**不是**「断点续批」。这是刻意的（「不为未来设计」——恢复 pending 需要重建整个会话上下文，代价远超收益）。

### 6.5 原子写与损坏容忍

- 写：`approvals.json.tmp` → `fs.renameSync`（原子）。
- 读：文件不存在 / JSON 解析失败 / 结构非法 ⇒ **当作空**（打 `warn` 日志），**不抛错、不阻止启动**（与 `settings.js` 的 `normalizeSettings` 同款容错哲学）。

---

## 7. 审计日志脱敏

### 7.1 审计记什么（每次 decide / 超时 / 丢弃都记一条）

`AuditEntry`：

| 字段 | 说明 |
|---|---|
| `ts` | Unix ms |
| `approvalId` / `sessionId` | id |
| `event` | `"requested" \| "allowed" \| "denied" \| "terminated" \| "timeout" \| "lost_on_restart" \| "always_allow_enabled"` |
| `kind` / `toolName` | 类别（`always_allow_enabled` 时必填，说明开的哪个 `kind`+`tool`） |
| `summary` | **脱敏后**的一句话摘要（见 7.2） |
| `risk` | `command` 类的 risk 标签（可空） |

> v1.1 新增两个事件：`terminated`（用户点了「中断整轮」，区别于 `denied`）与 **`always_allow_enabled`**（用户开启了会话级 always-allow —— team-lead 要求「用户何时开启了会话级 always-allow」必须可查）。`allowed` 对应用户点「允许一次」（`allowOnce`）。

### 7.2 脱敏规则（**权威定义在此**；`approval.js` 导出实现，`session.js:sanitizeDetail` import 复用，**不要另造一套**）

> **⚠ 方向修正（v1.1.4，team-lead 裁定）**：本节此前写作「复用 `session.js` 的 `sanitizeDetail` 口径」——**方向写反了**。经核实，`session.js:sanitizeDetail`（`:77-93`）**只实现 ①②④，缺 ③ 密钥**，而它的 JSDoc（`:71`）却承诺「绝不允许把…密钥…发给渲染层」——文档承诺与实现不符。**正确架构关系是**：**脱敏口径的权威定义在本节**；`approval.js` 导出 `redactSecrets()` / `sanitizeForAudit()` 作为**唯一实现点**，`session.js:sanitizeDetail`（错误外发，29 处调用点）**import 复用**，消除双份实现。
>
> **落地现状（v1.1.5 已闭环）**：`approval.js` 是**唯一实现点**（`redactSecrets :208`、`sanitizeForAudit :230`，`:200` 注释已写明「`sanitizeDetail` 都 import 它，严禁任何一方另抄一份正则」）；`session.js:64` **已 `import { redactSecrets } from "./approval.js"`**，`sanitizeDetail` 第 3 步（`:100-101`）已接入，顺序「路径替换之后、截断之前」（正确）。**双份实现已消除，密钥规则在 session 侧生效**。

审计 `summary` **必须**经过（四步，权威口径）：
1. 家目录 → `~`；
2. Windows / POSIX 绝对路径 → `<path:文件名>`（**保留文件名**，去掉上级目录）；
3. 折叠换行、截断到 300 字符；
4. **密钥模式**：命中 `(api[_-]?key|token|secret|password|authorization|bearer)\s*[:=]\s*\S+` ⇒ 值替换为 `<redacted>`（保留键名，形如 `KEY=<redacted>`）。

**逐类 summary 生成**：

| kind | `summary` 样例 |
|---|---|
| `write` | `write <path:周报.docx> (+2048B, overwrite=false)` |
| `edit` | `edit <path:session.js> (+8 -3)` |
| `command` | `bash: npm test`（⚠ 见 7.3，命令**不脱敏**，但截断到 500 字符） |

### 7.3 ⚠ `bash` 命令的脱敏"例外"（必须说清，别照抄 7.2 去脱命令）

- **审计日志里**的 `command`：**不替换命令本体**（否则审计无意义——「执行了某条命令」必须能查是哪条），但① 截断 500 字符；② 若命令里出现 `KEY=value` 形态的赋值（`export TOKEN=...`、`curl -H "Authorization: Bearer xxx"`），**只对那一小段**做 `=值 → =<redacted>`，命令结构保留。
- **审批卡里**的 `command`：**原样全文**（用户判断的唯一依据，见 §3.5）。
- **绝不**把命令里的密钥写进**要发给渲染层 card** 之外的任何持久化文件（`approvals.json` 里 `commandRedacted` 已是截断+赋值的脱敏形态）。

### 7.4 审计落盘

- 追加写 `~/.minipi/approvals-audit.log`（NDJSON，一行一条）。
- **同步 append**（审批是低频、人驱动的动作，不值得为它做异步队列；但**写失败不能阻断审批**——`try/catch` 吞掉 + `warn`）。

---

## 8. `quick` 场景兜底（及 `note` / `desk`）

### 8.1 `quick`：**无工具可调**，天然无审批

- `quick` 的 `noTools: "all"`（`scenes.js:117`）⇒ 模型**没有任何工具**，不可能发起 `tool_call` ⇒ **审批闸门对 `quick` 永不触发**。
- 但仍要**显式兜底**（防御性）：`registerGate` 规则 2 的开头判 `if (sceneId === "quick") return undefined;` —— 万一将来 `quick` 白名单变动，这里也不会误拦。
- **选区注入攻击免疫**：`quick` 无工具 ⇒ 「选区里藏指令让它删文件」这条路**天然不存在**（`scenes.js:106-107` 已说明）。

### 8.2 `note` / `desk`：有 `write`，但**永远落在 outbox** ⇒ 不进审批

- 二者白名单 `["read","write","grep","find","ls"]`，**无 `bash`/`edit`**（`scenes.js:110-111`）。
- 其 `write` 由**沙箱规则 1** 约束（必须落在 outbox，否则 block）。
- 落在 outbox 的 `write` **是否需要审批**？⇒ **不需要**。理由：outbox 是产品承诺的「无感落点」（D-21），用户**永远不会**因为「写 outbox」被打断；打断它违背「5 秒通道」定位。**沙箱对 outbox 场景就是全部防线**（plan §2.5）。
- 因此规则 2 **只对 `repo` 生效**。分流口径：`if (OUTBOX_SCENES.includes(sceneId)) return undefined;`（规则 1 已处理其写合法性；放行其合法写）。

### 8.3 兜底判定（规则 2 的完整决策树）

```
tool_call(event) → [规则 1：沙箱] 若 block 则直接 return（vendor 证：block 短路，规则 2 不被调用）
tool_call(event) → 规则 2：
  if sceneId in OUTBOX_SCENES (quick/note/desk): return undefined   # §8.1/§8.2
  # 只剩 repo
  if toolName not in APPROVAL_TOOLS:  return undefined              # 只读工具放行
  if 会话级 always-allow 命中(同 kind+tool):  return undefined        # §3.6.2
  decision = await approval.request(...)                            # §2
  → "allowOnce" → undefined
  → "deny"      → { block: true, reason }
  → "terminate" → { block: true, reason, terminate: true }
```

`APPROVAL_TOOLS = ["write", "edit", "bash", "powershell"]`（`repo` 白名单里**会改系统**的四个；`read`/`grep`/`find`/`ls` 放行）。

> **注意**：这张名单与 `sandbox.js` 的 `WRITE_TOOLS`（`["write","edit"]`）**不同**，别合并——沙箱只管路径，审批管「会改系统的全部」。两份名单各自成常量、各自有测试。

---

## 9. 数据契约（要加进 `protocol.js`，逐字）

### 9.1 新增常量

> **⚠ 对账说明（v1.1.1，2026-09-23）**：M4.2 已由白客落地到 `src/shared/protocol.js`。下列**以实际落地的为准**，本设计已按实际收敛（差异处标注）。核对结论：实质一致，仅命名 `APPROVAL_CARD_ACTIONS → APPROVAL_ACTION_IDS`（等价别名）、`APPROVAL_TERMINATED` 未单列（terminate 归入 `APPROVAL_DENIED` + 专属 reason）。

```js
// INVOKE 增（已落地）
APPROVAL_DECIDE: "minipi:approvalDecide",     // 渲染 → 主：用户点了按钮

// EVENTS 增（已落地）
APPROVAL: "minipi:approval",                  // 主 → 渲染：推/更新/撤回审批卡

// ERROR_CODES 增（已落地）
APPROVAL_TIMEOUT: "APPROVAL_TIMEOUT",
APPROVAL_DENIED: "APPROVAL_DENIED",           // 用户「拒绝」或「中断整轮」都归此码（用 reason 区分）
APPROVAL_NOT_FOUND: "APPROVAL_NOT_FOUND",
// 注：原拟的 APPROVAL_TERMINATED 未单列 —— terminate 走 APPROVAL_DENIED + 专属 reason，够用（收敛）

// LIMITS 增（已落地）
APPROVAL_TIMEOUT_MS: 300000,                  // 5 分钟
APPROVAL_BATCH_MAX_ITEMS: 20,
APPROVAL_DIFF_MAX_BYTES: 65536,               // 超此不生成逐行 diff
APPROVAL_WRITE_PREVIEW_CHARS: 2000,
APPROVAL_COMMAND_MAX_CHARS: 500,              // 审计截断

// 三 outcome 的合法取值（已落地）
export const APPROVAL_ACTIONS = Object.freeze(["allowOnce", "deny", "terminate"]);
export const APPROVAL_ACTION_IDS = APPROVAL_ACTIONS;   // 别名（白客落地的名字；本设计原叫 APPROVAL_CARD_ACTIONS）

// 审批工具名单（与 sandbox.WRITE_TOOLS 区分，已落地）
export const APPROVAL_TOOLS = Object.freeze(["write", "edit", "bash", "powershell"]);
```

### 9.2 通道签名（冻结）

| 方法 | 路径 | 入参 | 出参 | 错误码 |
|---|---|---|---|---|
| invoke | `minipi:approvalDecide` | `{ approvalId: string, action: "allowOnce"\|"deny"\|"terminate", remember?: boolean }` | `{ ok: true }` | `INVALID_ARGUMENT`（`action` 不在三值内 / `approvalId` 非字符串）/ `APPROVAL_NOT_FOUND`（id 不存在或已决） |
| event | `minipi:approval` | — | `ApprovalCard`（见下，含 `batch`） | — |

> `action` **必须**先校验 ∈ `APPROVAL_ACTIONS`（`["allowOnce","deny","terminate"]`），非法值直接 `INVALID_ARGUMENT`——**不能默认成 allow**（§4.3）。`remember:true` 即 §3.6.2 的「本会话总是允许」，**只由用户点击产生**；服务端**不**接受其他来源的 remember。
>
> **⚠ 字段值红线（v1.1.2 固化 team-lead 裁定）**：`action` 的**唯一合法取值是三值** `"allowOnce" | "deny" | "terminate"`。**全文（含历史表格与散句）不得再出现两值写法** `"allow" | "deny"`。中文术语「允许一次 / 拒绝 / 中断整轮」是**按钮文案**，**不是**字段值；字段值一律英文三值。（本次已全文核对：§2.5、§3.1、§3.6、§9.1、§9.2、§9.3 均为三值，无残留。）
>
> **✅ 已闭环（v1.1.3+）**：`approval.js:decide()` 已接 `remember`（`:669`）并处理 always-allow 分支（`_enableAlwaysAllow :707-732`）。详见 §9.4 R5。

### 9.3 `ApprovalCard` 逐字段（冻结）

> **✅ 已闭环（v1.1.3+）**：`approval.js` 的 `_pushCard()`（`:808-823`）已发全部字段（含 `sessionId`/`kind`/`toolName`/`title`/`actions`/`alwaysAllowEligible`），cancel 路径（`:791-800`）亦带 `sessionId`/`actions`。详见 §9.4 R4。

```js
/**
 * @typedef {object} ApprovalCard
 * @property {string} approvalId        // "a_<n>"
 * @property {string} sessionId         // 所属会话
 * @property {"push"|"update"|"cancel"} phase   // 推 / 就地更新 / 撤回
 * @property {"write"|"edit"|"command"} kind    // 单条卡的类别（合并卡取 batch 内分组，见 §4.5）
 * @property {string} toolName
 * @property {string} title             // 人类可读标题
 * @property {string[]} actions         // 恒为 APPROVAL_ACTIONS = ["allowOnce","deny","terminate"]
 * @property {boolean} alwaysAllowEligible       // §3.6.2：是否可勾「本会话总是允许」（当前恒 true）
 * @property {number} createdAt
 * @property {number} expiresAt         // createdAt + APPROVAL_TIMEOUT_MS
 * @property {number} timeoutMs         // 恒为 APPROVAL_TIMEOUT_MS，前端倒计时用
 * @property {ApprovalBatchItem[]} batch
 */
/**
 * @typedef {object} ApprovalBatchItem
 * @property {"write"|"edit"|"command"} kind
 * @property {string} toolName
 * @property {string} title             // 人类可读标题
 * @property {string} [path]            // write/edit：目标文件（~ 化）
 * @property {number} [bytes]           // write：内容字节数
 * @property {string} [preview]         // write：前 APPROVAL_WRITE_PREVIEW_CHARS 字符
 * @property {boolean} [overwrite]      // write：目标已存在
 * @property {string} [diff]            // edit：真实 diff 文本
 * @property {{added:number,removed:number}} [diffStat]  // edit
 * @property {boolean} [tooLargeToDiff] // edit：改动过大
 * @property {"bash"|"powershell"} [shell]   // command
 * @property {string} [command]         // command：完整命令（原样）
 * @property {number|null} [timeoutSec] // command：模型给的超时（秒），无则 null
 * @property {"normal"|"high"} [risk]   // command：高危标记
 */
```

> `phase:"cancel"` 时 `batch` 可为空数组（只撤卡）。**不新增事件 type**（与 `OutcomeCard` 同款推送哲学）。`actions` 恒为三项——渲染层画三个按钮：**允许一次 / 拒绝 / 中断整轮**（顺序即数组顺序）。

### 9.4 与白客 M4.2/M4.1 落地的**对账清单**（v1.1.5，2026-09-23）

我读了实际代码（`src/shared/protocol.js`、`src/main/pi/approval.js`、`src/main/pi/session.js`）逐条对账。**R1–R6 + T5 全部闭环**：

| # | 项 | 落地现状 | 结论 |
|---|---|---|---|
| R1 | 命名 `APPROVAL_ACTION_IDS` vs 本设计 `APPROVAL_CARD_ACTIONS` | 白客用 `APPROVAL_ACTION_IDS`（`protocol.js:352`） | ✅ **本设计收敛为实际名**（§9.1）。前端按 `APPROVAL_ACTION_IDS` import |
| R2 | `APPROVAL_TERMINATED` 错误码 | 白客**未单列**，terminate 归 `APPROVAL_DENIED` | ✅ **本设计收敛**（§9.1 已删）——terminate/deny 用 **reason** 区分 |
| **R3** | **terminate 的拒绝文案** | `approval.js:673-675`：`action === "terminate" ? DENY_REASON_TERMINATE : DENY_REASON_USER`；`DENY_REASON_TERMINATE` 已导出（`:81`） | ✅ **闭环**——三套文案分开，模型可区分「这条被拒」与「整轮被停」 |
| **R4** | **卡片字段 `actions` / `alwaysAllowEligible` 等** | `_pushCard()`（`approval.js:808-823`）含 `sessionId`/`kind`/`toolName`/`title`/`actions`/`alwaysAllowEligible`；`cardMeta()`（`:981`）统一提取；cancel 路径（`:791-800`）也带 `sessionId`/`actions` | ✅ **闭环**——方砚可据 `card.actions` 画三按钮、据 `alwaysAllowEligible` 画勾选框 |
| **R5** | **会话级 always-allow（§3.6.2）** | `decide()` 接 `remember`（`:669`）；命中放行在 `request()`（`:585-590`，**在沙箱之后**）；`_enableAlwaysAllow`（`:707-732`）+ `isAlwaysAllowed`（`:735`）；`cancelBySession` 清记忆（`:689`）；审计 `always_allow_enabled`（`:723`） | ✅ **闭环**——默认关、仅内存、退出即失；**只接受 IPC 的 `remember:true`**（模型输入到不了 `decide`） |
| **T5** | **定时器泄漏**（用户在超时前批卡，`setTimeout` 仍在跑 ⇒ 5 分钟后 `_onTimeout` 误触发） | `_settle()` 对所有 outcome 都 `clearTimeout`（`:761`）；`_settle` 开头 settled 早退（`:758`）；`_onTimeout` 开头 settled 早退（`:745`） | ✅ **闭环**——fail-closed 双保险，已决卡不再二次推卡 / 误记 timeout 审计 |
| **R6** | **脱敏口径的**方向**（三处实现归一）** | `approval.js` 是**唯一实现点**（`redactSecrets :208`、`sanitizeForAudit :230`）；`session.js:64` **已 `import { redactSecrets } from "./approval.js"`**，`sanitizeDetail` 第 3 步（`:100-101`）已接入，**顺序为「路径替换之后、截断之前」**（`:78-80` 注释写明理由：放截断后 ⇒ 超长文本密钥可能被截一半而漏脱） | ✅ **闭环**——双份实现已消除，密钥规则在 session 侧生效 |

> **R1/R2 是纯命名收敛**（改本设计即可）；**R3/R4/R5/T5/R6 均已由白客实现**。**本对账表 v1.1.5 全部 ✅**，秦戈独立 QA 可逐条打勾。

> **⚠ 历史说明（保留，勿删 —— 这是 v1.1.4/v1.1.5 修订的理由记录）**：
> - **设计曾写反脱敏口径的方向**：§7.2 原写「复用 `session.js` 的 `sanitizeDetail` 口径」，但 `sanitizeDetail` 当时**只实现 ①②④、缺 ③ 密钥**（其 JSDoc 却承诺含密钥脱敏 = 承诺≠实现）。**正确关系是「审批侧定义、session 侧复用」**（§7.2 已改）。
> - **代码侧亦有第三处方向写反**：`approval.js:136` 注释曾为「口径**抄** `session.js` 的 `sanitizeDetail`」（错向）。**归白客修正**（他的文件）。
> - 保留本段的意义：后人若只看到「R6 ✅」而不知**曾经写反、曾缺第 3 步**，就无从理解 §7.2 为何要强调「权威定义在此」。**这不是流水账，是防复发的依据。**
>
> **T5 记功**：该缺陷打在「5 秒通道」的产品原点上——**用户批得越快越容易踩**，非边缘 case。白客报「114 项全绿」时未覆盖到它，印证「自测绿灯 ≠ 无洞」。**白客补修时已加专项断言**（allowOnce 后推进假时钟到超时点，不得再推卡/记 timeout 审计）。
>
> **「§9.2 两值残留」已核实不存在**：`approval.js` 侧 grep 无 `"allow"` 字面量（只有 `"allowOnce"`），本设计 §9.2 表格 `:571` 本就是三值。系早期快照误读，**已加红线脚注固化**（§9.2）。
>
> **对账的正面结论（始终一致，无实质冲突）**：白客的三 outcome（`APPROVAL_ACTIONS` 三值）、terminate every 语义注释、批合并（`_sessionCard` 按 sessionId）、超时默认拒绝（`_onTimeout` → deny + timeout reason）、重启丢弃（`_sweepOnStart`）、审计脱敏——**均与本设计一致**。

---

## 10. 显式不做（本版本不包含，防后期扯皮）

| 不做 | 理由 |
|---|---|
| **「记住选择」的持久化 + 指纹级**版本（精确到命令内容/文件路径、**跨重启保留**） | 属长期记忆，需审慎的键设计与撤销入口，超出 M4。**注意**：会话级、`kind`+`tool` 级、**不落盘**的 `alwaysAllowInSession` **要做**（§3.6.2）——两者不是同一件事，别混。 |
| 逐条允许/拒绝（矩阵式） | 认知负担大、违背 5 秒通道；**整卡（整批）三按钮**语义够用（§4.2） |
| 命令白名单/黑名单**硬拦截** | 审批的意义就是「人看着决定」；黑名单会误伤 + 让用户困惑（§3.4） |
| 恢复重启前的 pending 卡 | 需重建会话上下文，代价远超收益（§6.4） |
| 审批的「预览真文件内容」（`edit` 时读盘显示上下文） | 读盘有 TOCTOU 风险且非必需；`edits[]` 已够判断（§3.3） |
| `read` 的审批 | 沙箱与审批都保「写」不保「读」（`sandbox.js` 文件头取舍，plan §2.4） |
| 审批器**改参**（`event.input` 可变，但本设计不用） | vendor 明示改参**不会重新校验**（`types.d.ts:721-722`）⇒ 是安全隐患；审批只放行/拒绝，**不改模型给的内容**（§1 第 5 条） |
| 渲染层审批卡视觉稿 | 本设计只定数据契约（§3/§9）；像素归渲染层 |

---

## 11. 任务清单（M4 施工顺序 + 验收 + 优先级）

| # | 任务 | 角色 | 验收标准 | 优先级 |
|---|---|---|---|---|
| ~~**M4.0**~~ | ~~异步钩子探针~~ | — | ❌ **已关闭（v1.1）**：答案由 vendor 源码确证，无需实测（§2.3）。归档理由：`ExtensionHandler` 允许 Promise（`types.d.ts:902`）+ runner `await`（`runner.js:753`）⇒ 路径 A 成立 | — |
| **M4.1** | 写 `src/main/pi/approval.js`（纯 Node：状态机 + 卡生成 + diff + 超时 + 持久化 + 审计 + 会话级 always-allow） | 主进程 | `node scripts/verify-approval.mjs` 全绿，**至少覆盖**：① 建 pending 返回 `allowOnce`/`deny`/`terminate` 三值；② 5 分钟超时=deny 且 reason 含 `did not respond`；③ `edit` diff 与 `edits[]` 逐处对应、`diffStat` 行数一致；④ 多 ask 合并进一张卡且不超 20 条、**合并卡三按钮作用于整批**；⑤ **`terminate` 对合并卡整批都带 `terminate:true`**；⑥ 重启**丢弃** pending（不变 allow）；⑦ 审计 summary 家目录→`~`、绝对路径→`<path:文件>`、密钥→`<redacted>`；⑧ **会话级 always-allow 默认关、只在内存、退出即失；模型无法通过输入打开** | **P0** |
| **M4.2** | `protocol.js` 加契约（§9：INVOKE/EVENTS/ERROR_CODES/LIMITS/APPROVAL_ACTIONS/APPROVAL_TOOLS + JSDoc 形状） | 架构 | `verify-v04` 覆盖新常量；字段名与本设计 §9.3 **逐字一致**；`action` 校验覆盖 `APPROVAL_ACTIONS` 三值 | **P0** |
| **M4.3** | `registerGate` 接规则 2（`session.js`）：沙箱后、审批前，分流口径按 §8.3 | 主进程 | `repo` 场景 `bash`/`edit`/`write`/`powershell` **必弹卡**；`note`/`desk`/`quick` **不弹**；沙箱违例**仍不弹**（顺序测试，且 vendor 证 `block` 短路 ⇒ 审批不被调用）；拒绝后模型**不重试** | **P0** |
| **M4.4** | `main/index.js` 注入 `ApprovalBridge` + `APPROVAL_DECIDE` handler（校验三值 action） | 主进程 | 卡能推到渲染层；`decide` 能唤醒 pending（**合并卡唤醒整批**）；`approvalId` 已决/不存在 → `APPROVAL_NOT_FOUND`；非法 action → `INVALID_ARGUMENT` | **P0** |
| **M4.5** | 渲染层审批卡 UI（三类模板 + diff 展示 + 倒计时 + **三按钮：允许一次/拒绝/中断整轮** + 会话级「总是允许」勾选） | 渲染层 | 360×480 不溢出；`edit` 卡显示真实 diff（+N -M）；倒计时到 0 显示「已超时拒绝」；`overwrite:true` 有重警示；`risk:high` 命令有红色标记；「中断整轮」按钮存在；「本会话总是允许」复选框**默认不勾** | **P1** |
| **M4.6** | `verify-approval.mjs` 接进 `package.json` `verify:*` + 文档回填（本文件去「设计稿」、plan §5 T1.5 打勾） | 架构 + 测试 | `npm run verify` 全绿；`docs/` 状态更新 | **P1** |

**依赖**：`M4.1 → {M4.2, M4.3} → M4.4 → M4.5 → M4.6`（**M4.0 已关闭，不再是前置**）。M4.2 与 M4.1 可并行（契约先冻结最稳，建议 M4.2 先行）。

---

## 12. 风险与假设

### 假设
- **A1（v1.1 已确证，不再是假设）**：`tool_call` 钩子**支持返回 Promise 并被 `await`**（`types.d.ts:902` + `runner.js:753`）⇒ **路径 A 是唯一实现**，B/B′ 作废（§2.4）。
- **A2（已核实）**：`edit` 的 `input` = `{ path, edits: [{oldText, newText}] }`（现行），兼容 legacy 顶层 `{path, oldText, newText}`；见 `vendor/pi/packages/coding-agent/src/core/tools/edit.ts:32-41,103-141`。`write` = `{ path, content }`；`bash`/`powershell` = `{ command, timeout? }`（均已核实，见 §3.2/§3.4）。**另**：SDK 的 `dist/core/extensions/types.d.ts:682-724` 有 `BashToolCallEvent`/`EditToolCallEvent`/`WriteToolCallEvent`… 的 **`input` 类型**（`BashToolInput`/`EditToolInput`/`WriteToolInput`），实现时可直接对 `event.toolName` 收窄类型。
- **A3**：单窗口单会话（`repo` 场景下）——并发多会话不在本版本。

### 风险
| 风险 | 等级 | 缓解 |
|---|---|---|
| **`terminate` 的 every 语义被实现错**（只 resolve 第一条）⇒ 「中断整轮」按钮点了没用 | **中** | §3.6.1 写死「合并卡整批都带 `terminate:true`」+ M4.1 验收⑤ 专项覆盖 |
| **会话级 always-allow 被模型注入打开** | **中** | §3.6.2 红线：只接受来自 `APPROVAL_DECIDE` IPC（有 `assertTrustedSender`）的 `remember:true`；模型输入无路径可达；M4.1 验收⑧ 覆盖 |
| **diff 生成器自己实现有 bug**，显示与实际改动不符 | 中 | 单测覆盖「前缀/后缀/中间改/纯新增/纯删除/超大片段」6 类；验收锚点为「`diff` 与 `edits[]` 逐处对应 + `diffStat` 与 `edits[]` 行数一致」（§3.3） |
| **渲染层忘做倒计时** ⇒ 用户不知有 5 分钟限制 | 低 | 卡自带 `expiresAt`/`timeoutMs`，UI 无理由不做；M4.5 验收含倒计时 |
| **`approvals.json` 被审查者误当「续批依据」** | 低 | §6.4 写死「重启一律丢弃」，文件头注释同样写明 |
| **审计把 `bash` 命令里的密钥漏掉** | 中 | §7.3 对 `KEY=value` 段做 `<redacted>`；单测覆盖 `curl -H "Authorization: Bearer xxx"` |
| **沙箱与审批顺序被后人写反** | 低 | vendor 证 `block` 短路（`runner.js:756-758`）⇒ 沙箱 block 后审批**根本不被调用**，天然双保险；`registerGate` 两条规则各带显式注释 + M4.3 加「顺序」单测 |
| **非法 action 被静默当 allow** | 低 | §9.2：先校验 ∈ `APPROVAL_ACTIONS`，非法直接 `INVALID_ARGUMENT`（报错，不静默） |

---

## 13. 自检（对照 team-lead 的 7 项 + 任务 #3）

1. **等用户决策**：§2 改为**直接 `await`**——已由 vendor 源码确证钩子支持 Promise；v1.0 的「同步泵/探针/A-B-B′」复杂度**全部删除/作废**（§2.3/§2.4）。✅（并记录了推翻了 v1.0 的哪个错误假设，便于追溯）
2. **三类审批卡**：`write`（preview+overwrite）/ `edit`（**真实 diff**，零依赖裁切，**入参形状已从 `vendor/pi` 核实**）/ `command`（全命令 + 高危标记 + timeout）。✅
3. **多 ask 合并**：同卡追加、**整卡三按钮（批量语义）**、`BATCH_MAX_ITEMS=20`、跨 kind 分组、跨 session 不合并、**「非显式允许一律拒绝」原则**。✅
4. **5 分钟超时默认拒绝**：常量、动作、**超时 / 主动拒绝 / 中断整轮三套文案**、定时器清理。✅
5. **未决持久化**：`approvals.json` 原子写、**重启一律丢弃不放行**、审计留痕。✅
6. **审计脱敏**：**权威口径定义在 §7.2**（四步：家目录→`~` / 绝对路径→`<path:文件名>` / 压行截断 / 密钥→`<redacted>`）——`approval.js` 导出唯一实现，`session.js:sanitizeDetail` import 复用（**方向：审批侧是权威，session 侧复用**）。含 `bash` 命令的脱敏例外 + **新增 `terminated` / `always_allow_enabled` 两个事件**。✅
7. **`quick` 兜底**：无工具天然免疫 + 显式 `if quick return`；`note`/`desk` 由沙箱兜底不进审批。✅
8. **三 outcome（任务 #3）**：`allowOnce`/`deny`/`terminate` 三值 + 中文术语 + terminate every 语义 + 会话级 always-allow（默认关、内存、模型不可开）——§3.6 专节。✅

**接口契约完整吗**：§9 给了 `protocol.js` 要加的全部常量（含 `APPROVAL_ACTIONS` 三值）+ 通道签名（含 `remember`）+ `ApprovalCard` 逐字段（含 `actions`/`alwaysAllowEligible`）。前端拿 §9 能独立画卡，后端拿 §9 能独立建卡。✅
**验收可验证吗**：M4.1/M4.3/M4.4/M4.5 的验收都是「能在 UI/脚本里明确判定的行为」，无「功能正常」。✅
**范围收敛吗**：§10 显式列了 8 项不做，且把「会话级 always-allow（做）」与「持久化指纹级记住选择（不做）」**显式对比**，防误读自相矛盾。✅
**数据模型支撑接口吗**：`ApprovalCard` 每个字段都能从 `tool_call` 的 `event.input` 或会话上下文推出（§3 逐类给了来源）。✅

---

## 14. 给 team-lead 的三句话

1. **v1.1 的核心修正是「删复杂度」**：v1.0 基于「钩子必须同步」的错误假设，设计了同步泵/探针/三路径；vendor 源码证伪后（`types.d.ts:902` + `runner.js:753`），实现回归最朴素的 `await approval.request(...)`。**B/B′ 已作废**，M4.0 已关闭。
2. **任务 #3 的三 outcome 已收编**：三按钮（允许一次/拒绝/中断整轮）+ 会话级 always-allow（默认关、内存、模型不可开）。**terminate 的 every 语义**我单独拉了一节（§3.6.1）写死——这是最容易实现错、且错了「按钮就像坏了」的点。
3. **这里是唯一来源**：`protocol.js` 的契约（§9）先落地，前端（M4.5）与后端（M4.1/M4.3/M4.4）即可并行开工。**v1.0 里凡与 v1.1 冲突处，一律以 v1.1 为准**（顶部修订说明已列出被改的节）。
