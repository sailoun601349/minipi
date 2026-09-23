# spike 结论回填表 · 门禁序 7b（Pi SDK 运行时）

> **本表已于 2026-09-22 实测回填**（offline + live 都跑了）。原始数据见 `out/pi-sdk-offline-report.md`、`out/pi-sdk-live-report.md`。
> live 复现：`$env:MINIPI_SPIKE_LIVE_CONFIRM="1"; npm run spike:live -- --run`（本次共 **10 次**模型调用：首轮 8 次 + 补跑 q2 2 次）。

## 0. 运行环境

| 项 | 实测值 |
|---|---|
| 日期 | 2026-09-22 |
| Node | **v22.22.2**（engines 要求 `>=22.19.0`，满足 ✅） |
| 平台 / OS release | `win32 x64` / `10.0.22631` |
| 安装到的 SDK 版本 | **0.87.0** |
| vendor/pi 版本 | **0.87.0**（`pinMatchesVendor = true` ✅）；vendor/pi 源码在（1668 个文件） |
| 是不是远程桌面 / 虚拟机 | 不是（本机真实桌面会话） |
| live 会话模型 | `deepseek/deepseek-v4-pro` |

---

## 1. offline 结论（B1–B4）

| 序 | 测什么 | 实测值 | 判定 | 一句话结论 |
|---|---|---|---|---|
| **B1a** | `await import(...)` | **成功，2665.9 ms**；`VERSION = 0.87.0` | ✅ | Node 侧 ESM 可用 |
| **B1b** | `require()` 是否如预期失败 | **失败**：`ERR_PACKAGE_PATH_NOT_EXPORTED` | ✅ | 纯 ESM，`require` 走不通 |
| **B1c** | `exports` 是否只有 `import` | `hasImportCondition = true`、**`hasRequireCondition = false`** | ✅ | 无 `require` 分支 |
| **B1d** | `engines.node` 本机是否满足 | 要求 `>=22.19.0`，本机 `22.22.2` | ✅ | 满足 |
| **B2** | 方案用到的运行时导出全不全 | `runtimeMissing = ["getSessionsDir"]`（其余 16 个全在） | ⚠️ | `getSessionsDir` **不是不存在**，是包根**未再导出**（`src/config.ts:572` 有定义，`src/index.ts` 只再导出了 `CONFIG_DIR_NAME` 与 `getAgentDir`）。`docs/` 里无任何引用 ⇒ **不阻塞方案**；若要用只能走子路径导入 |
| **B2b** | 纯类型名在 `.d.ts` 里存在吗 | 缺 **2 个**：`Message`、`ThinkingLevel`（二者来自 `@earendil-works/pi-ai`，属再导出，不是 `coding-agent` 的） | ⚠️ | 类型要从 `pi-ai` 取，不要从 `coding-agent` 取 |
| **B3** | 23 条静态事实 | **完全命中 19 / 部分命中 4 / 未命中 0** | ✅ | 无「凭空断言」；4 条部分命中的措辞已按本节表格收紧 |
| **B3b** | 有没有「行号漂移」要改文档 | 报告 §4 有漂移标注；**但 QA 复核判定其中 F1 的「行号漂移」为误报**（`types.ts:975` 实为正确行） | 🤔 | 引用行号以本表为准；不确定的地方改为只写文件路径 |
| **B3c** | 负向探针有没有被违反 | **0**（`queue_update` 里没有冒出 `position`，`tool_execution_start` 里没有 `input`） | ✅ | 审计 v2 已据此改正 |

**B3 里已逐条抄进方案的 7 条**：

| 事实 | 判定 | 证据（文件:行号） | 要改方案的哪一句 |
|---|---|---|---|
| F1 `ToolCallEvent` 字段名 | ✅ 8/8 | `src/core/extensions/types.ts:973,974,429,1029` | 基类只有 `type` + `toolCallId`；具体事件另有字面量 `toolName` + `input`；自定义工具走 `CustomToolCallEvent`（`toolName: string`） |
| F2 `block`/`reason`/`terminate` | ✅ 4/4 | `types.ts:1217,1219,1220,1225` | 三字段都在且**全部可选**；`reason` 未与 `block` 强绑定（只返回 `{reason}` 不阻断） |
| F3 `event.input` 可变性 | ⚠️ 2/3 | `types.ts:1026,1027`；`packages/agent/src/types.ts:109` | 可变已确认；**注释明确「改参后不再校验」**⇒ 若用改参降级命令，改坏形状 SDK 不会拦 |
| F4 `queue_update` 真实字段 | ✅ 5/5 | `src/core/agent-session.ts:173,174,175,840` | **只有 `steering` / `followUp` 两个字符串数组**；审计 v2 里的 `{queued, position}` 源码中不存在。排队数只能自算，且是「**尚未投递的条数**」，不是稳定席位 |
| F5 `preflightResult` 签名与注释 | ⚠️ 3/4 | `agent-session.ts:274,1751,1759` | **只有一个 `boolean`**，注释写明是 RPC 模式内部钩子；语义是「prompt 被受理/被拒」，**不是**「本轮跑完」，也拿不到三态 |
| F6 `navigateTree` 忙时 | ⚠️ 4/5 | `agent-session.ts:3581,3510,3586,3598` | 忙时**抛 Error**，但两条 throw 都在 `async` 方法体内 ⇒ 调用方拿到的是 **rejected Promise**；`cancelled` 只出现在正常返回路径 |
| F7 `tool_execution_start` 字段名 | ✅ 4/4 | `packages/agent/src/types.ts:498`；`agent-loop.ts:485`；`agent-session.ts:1114,1117` | **是 `args`，不是 `input`**。事件流侧用 `args`、扩展侧用 `input` ⇒ `protocol` 包必须显式改名映射，否则 M3-2 的参数行永远是空 |

**另外 4 条与 M4 直接相关**：

| 事实 | 判定 | 证据 | 影响 |
|---|---|---|---|
| F8 `on("tool_call")` 返回类型 src vs dist | ✅ 不一致已确认 | src `types.ts:1416` = `() => void`（可注销）vs dist `dist/core/extensions/types.d.ts:939` = `void` | 以 src 为准，但 **npm 装到的就是这份旧 dist 声明** ⇒ 类型层面 `.on()` 返回值不可用 |
| F9 `reason` 是否回灌模型 | ✅ **live Q1 已实测：是**（逐字、`isError=true`） | `out/pi-sdk-live-report.md` §Q1 | 「拒绝要有语义」**成立**，按原方案做 |
| F10 `terminate` 是否要求同批全 true | ✅ **live Q2 已实测：是** | `out/pi-sdk-live-report.md` §Q2 | 「中断整轮」**必须把 terminate 传播给同批其余 pending 审批**，否则不会提前终止 |
| F11a/F11b 一个 turn 内是否并发 / 钩子是否串行 await | ✅ **live Q2 已实测：不是串行**（两条 `tool_call` 到达**间隔 0 ms**，`tool_execution_start/end` 连续两条） | 同上 | 「多个 ask 合并成一张卡」**可以**用短 debounce（等 N ms 看还有没有第二个 ask）；更稳的做法是从 `message_end` 的 assistant `toolCalls` 列表预判本批 ask 数量 |

---

## 2. 凭证探测与 live 可跑性

| 项 | 实测值 |
|---|---|
| `piConfig.configDir` → `CONFIG_DIR_NAME` | `.pi` |
| 解析出的 agent 目录（已脱敏） | `~/.pi/agent` |
| `auth.json` 是否存在 | **存在** |
| 是否解析为合法 JSON | **是** |
| provider 数量 | **1** |
| **provider 名称** | `deepseek` |
| ⇒ `spike:live` 能不能跑 | **能跑**（已实跑，共 10 次模型调用） |

> ⚠️ 本表只登记「存在性 + provider 名称」。任何 key / token / secret / OAuth 内容一律未记录、未打印、未落盘。

---

## 3. live 五问（**已跑**）

| 题 | 判定 | 观察到的关键事实 | 一句话结论 |
|---|---|---|---|
| **Q1** `block+reason` 的真实语义 | ✅ **通过** | 闸门被调用 1 次（`write`）；**目标文件未生成**；toolResult 文本**逐字等于** reason；`isError=true`；**模型没有重试**，最终回 `"The action was denied. What would you like me to do instead?"`（改为询问用户） | §3.3「拒绝要有语义」**成立**，M4-4 按原方案验收 |
| **Q2** `terminate` 的确切语义 | ✅ **通过** | **Case A**（同批 2 个 write，都 `block+terminate`）：闸门拦 2 个、`assistantTurns = 1`、事件尾是 `turn_end → agent_end → agent_settled`（**该批后没有新回合**）⇒ **提前终止成立**。**Case B**（一个 block+terminate、一个放行）：`b1.txt` 未生成 / `b2.txt` 生成、`assistantTurns = 2` ⇒ **未提前终止**。两条 write 钩子**到达间隔 0 ms** | `every` 语义**成立**：必须**同批全部**为 true 才提前终止 ⇒ 「中断整轮」要把 terminate 传播给同批其余审批 |
| **Q3** `navigateTree` 忙时行为 | ✅ **通过** | 忙时调用形态 = **rejected Promise**（不是同步 throw），错误消息逐字：`"Wait for the current response to finish before navigating the session tree."`；**忙时调用后流式仍在继续**（`stillStreamingAfterCall=true`）；对照 2（空闲+合法 id+扩展返回 `{cancel:true}`）拿到 `{cancelled: true}`；对照 1（空闲+不存在的 id）rejected：`"Entry __definitely_not_an_entry__ not found"` | 方案 §3「切换前 `await waitForIdle`，失败则提示」成立；**调用方必须 `try/catch await`，且同时判返回值 `cancelled`**（两路都要处理） |
| **Q4** 流式 `steer`/`followUp` | ✅ **通过** | `preflightResult` 只给布尔（`args=[true]`，1 次）；`queue_update` 键名**只有 `type/steering/followUp`**；缺 `streamingBehavior` 抛错，消息逐字：`"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message."` | ⚠️ **`steering`/`followUp` 是「待投递消息的文本数组」，投递后被移出 ⇒ 这个和会「先升后降」**。UI 必须显示「**排队 N 条**」而**不是**「你是第 N 位」 |
| **Q5** 闸门能否被绕过 | 🤔 **不可判定**（live 部分） | live 探针没跑起来：自定义工具注册失败（`registerTool` 的 `parameters` 需要 typebox Schema，两个探针工具名都是 `<unnamed>`、`bothPresent=false`），嵌套会话没建起来 | **但有一条源码级确定结论**：官方 `subagent` 示例用 **`spawn` 起独立 pi 进程**（`examples/extensions/subagent/index.ts:346`）⇒ 子进程自己加载扩展，**父会话的 `tool_call` 钩子必然看不到子进程内部的工具调用**。⇒ §3.3 必须补「闸门安全边界」段 |

**Q2 的 `gateReturnTiming` 关键读数**：`"第 2 次到达，间隔 0 ms"` ⇒ **钩子不是串行 await 的**，M4-3 的合并卡可以用 debounce 实现。

---

## 4. 对方案的影响（已勾选）

- [x] **B1 全绿** → §11「Node ≥ 22.19 + 纯 ESM」两条硬约束在本机成立；M0-0 可以按原方案写（Electron 那一半见 `spike/electron-window/RESULT-TEMPLATE.md`）。
- [ ] ~~B1d 不满足 → 降到 `legacy-node20` 线~~（不适用）
- [ ] ~~B3 全部 confirmed → 断言不变~~（不适用：4 条部分命中）
- [x] **B3 有 partial（F3/F5/F6）** → 三条措辞已按本表收紧，**没有**把没依据的说法留在方案里。
- [ ] ~~F4 负向探针被违反~~（不适用，负向探针全干净）
- [ ] ~~F11b 确认钩子串行 → 改用 message_end 预判~~（**实测钩子不串行**，debounce 路线可用；但「从 `message_end` 的 toolCalls 预判本批数量」仍是更稳的实现，两者都可，二选一即可）
- [x] **Q5 → §3.3 加「闸门安全边界」段**：闸门只覆盖**本会话**的工具调用；`work` 场景若允许第三方扩展（官方 `subagent` 示例是独立进程），必须把 `gateFactory` 注入其创建的每个嵌套会话，**或干脆禁止此类扩展**。P1-13 的「是否覆盖子 agent」从「未验证」改为「**源码级判定：不覆盖（独立进程）**」。

---

## 5. 一句话总结（已同步进 `docs/minipi-plan.md` §11 门禁表）

```
序 7b · Pi SDK 运行时 spike 结论（2026-09-22，Node v22.22.2，@earendil-works/pi-coding-agent 0.87.0）：
① ESM：import 通过（2.7s）；require 如预期失败（ERR_PACKAGE_PATH_NOT_EXPORTED）；engines 满足
② 导出面：除 getSessionsDir 未再导出（不阻塞）外全在；Message/ThinkingLevel 需从 pi-ai 取
③ 静态核对：23 条中 19 条完全命中、4 条部分命中、0 条未命中；负向探针 0 违反
④ 凭证：auth.json 存在，provider 1 个（deepseek）⇒ spike:live 可跑，已跑 10 次模型调用
⑤ live 五问：Q1/Q2/Q3/Q4 通过，Q5 不可判定（但源码级判定「子 agent 独立进程 ⇒ 不覆盖」）
＋ 三条实测结论动方案：terminate 的 every 语义成立（中断整轮须传播）；navigateTree 忙时是 rejected Promise（须 try/catch await + 判 cancelled）；queue_update 是「待投递条数」不是席位（UI 写「排队 N 条」）
→ 门禁序 7b：已关闭
```

---

## 6. 未验证项（如实列）

```
- Q5 的 live 部分未跑通（registerTool 探针的 parameters 形态不对，嵌套会话没建起来）。结论依赖源码级证据（官方 subagent 用 spawn 起独立进程）。
- Q2 的 result.terminate 无法从消息里直读（不下发到消息），提前终止是靠「回合数 + 事件尾」间接判断的。
- dist 与 src 不一致的运行期差异：只做了静态对照（F8），未验证 .on() 运行期是否真的返回注销函数。
- Electron 主进程 ESM：本套件只验 Node 侧 import；Electron 侧由 spike/electron-window 覆盖（已通过）。
- 真实模型下的长任务（30–90s 多轮工具）行为：未测。
- 多 provider 下的差异（换模型后 block/reason/terminate 语义是否一致）：未测。本次只用 deepseek。
- 网络异常 / 限流 / auto_retry_* 的真实表现：未测。
- 审批阻塞期间「一个挂起审批 + 新 prompt」并存的 turn 归属：未测（需 M4 实做时定）。
```
