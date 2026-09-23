# minipi v0.4 · 独立质量验证报告（QA 第三层 · 证伪）

| 项 | 内容 |
|---|---|
| 测试工程师 | 秦戈（QA，第三层「证伪」） |
| 被测版本 | minipi v0.4（场景四档 / outbox 沙箱 / M5 产出链路 / 产出卡片 UI） |
| 环境 | Windows · Node 22.22.2 · Chrome（headless CDP）· 纯 Node（无 electron，本机 GPU 崩） |
| 测试日期 | 2026-09-23 |
| 报告路径 | `docs/minipi-v0.4-qa-report.md` |

---

## 一、测试范围与方法

### 1.1 我的定位

前面已有两层证据（工程师自测 5 脚本全绿、架构师审计 36/36 PASS）。**本报告不重跑那些脚本当成果，而把它们当作基准线，在其之上找它们没覆盖的攻击面**。核心手法是：**不看代码说"看起来没问题"，而是构造恶意/畸形输入实测系统真实行为**。

### 1.2 环境限制（如实声明）

| 限制 | 影响 | 处理 |
|---|---|---|
| Electron 真机起不来（GPU 崩） | 无法对真实主进程 + IPC 链路做端到端 | 渲染层走 headless Chrome + CDP；主进程纯函数直接 import 测 |
| `spawnSync`/`execFileSync` 被沙箱挡（EBUSY） | 象限 D 无法用 spawnSync 调守门脚本 | 改用 `child_process.fork`（可用），已实测 |
| 未做真机 Pi SDK 联调 | 「模型真会吐 `@` 路径吗」无法端到端验证 | 已核实 SDK 源码路径，标出可达性前提 |

### 1.3 四个象限

| 象限 | 脚本 | 覆盖 |
|---|---|---|
| A 沙箱攻击 | `scripts/qa-sandbox-attack.mjs` | UNC / 8.3 短名 / 保留设备名 / 尾随点空格 / SDK 预处理差异 / 畸形 input / 场景漂移 |
| B 产出链路对抗 | `scripts/qa-outcome-adversarial.mjs` | JSON 炸弹 / 原型污染 / 类型混淆 / `buildFileName` 穿越 / 超长 / 并发 TOCTOU |
| C 渲染层边界 | `scripts/qa-renderer-edge.mjs` | 静态 sink 审查 / 函数边界 / emoji 截断 / XSS 实测 |
| D 契约一致性 | `scripts/qa-contract-drift.mjs` | 镜像逐字对齐 / 缺失错误码后果 / 守门脚本有效性 / preload 透传 |

---

## 二、执行摘要

| 层面 | 用例数 | 通过 | 失败 |
|---|---|---|---|
| 象限 A · 沙箱攻击 | 62 | 59 | 3 |
| 象限 B · 产出链路对抗 | 87 | 87 | 0 |
| 象限 C · 渲染层边界 | 58 | 57 | 1 |
| 象限 D · 契约一致性 | 31 | 27 | 4 |
| **合计** | **238** | **230** | **8** |

> 失败项去重后 = **6 条独立缺陷**（A 的 3 条失败归为 2 条；D 的 4 条失败归为 3 条）。

### 缺陷分布

| 编号 | 严重级 | 一句话 | 归属 |
|---|---|---|---|
| **QA-P0-1** | **P0** | 沙箱未复刻 SDK 的 path 预处理（`@` 前缀）→ **可逃逸 outbox 写到外部** | 我发现的 |
| QA-P2-1 | P2 | 沙箱读死 `input.path`，字段名一变即静默放行（不 fail-closed） | 我发现的 |
| QA-P2-2 | P2 | 未知 sceneId 被沙箱当作「非 outbox 场景」放行（fail-open） | 我发现的 |
| QA-P2-3 | P2 | `middleTruncate` 劈开 emoji / 代理对 → 渲染出 `�` 乱码 | 我发现的 |
| QA-P3-1 | P3 | 渲染层 `ERROR_CODES` 缺 `SANDBOX_DENIED`（12 vs 11），会被降级成 `INTERNAL` | 我发现的 |
| QA-P3-2 | P3 | 场景 `description` 两侧文案漂移且守门脚本不覆盖（守门盲区） | 我发现的 |
| **（已知）M4** | **P0** | 审批闸门主体未做（`registerGate` 规则 2 空实现） | **已知缺口，已归档，不计入本次新发现** |

---

## 三、基准线回归（回归未被破坏）

我未修改任何 `src/` 业务代码。跑完我的 4 个脚本后，基准线仍全绿：

```
verify-sandbox          EXIT=0   (47 项)
verify-outcome          EXIT=0   (97 项)
verify-v04              EXIT=0   (39 项)
verify-sandbox-live     EXIT=0   (5 项)
crosscheck-outcome      EXIT=0   (交叉检查)
check-scene-consistency EXIT=0   (场景一致性)
```

我的 4 个 QA 脚本退出码（非零 = 有缺陷，符合设计）：

```
qa-sandbox-attack          EXIT=1   (59 通过 / 3 失败)
qa-outcome-adversarial     EXIT=0   (87 通过 / 0 失败，全绿)
qa-renderer-edge           EXIT=1   (57 通过 / 1 失败)
qa-contract-drift          EXIT=1   (27 通过 / 4 失败)
```

> 象限 D 改文件验证已还原：`RESTORED-EXIT=0`（protocol.js / index.html 逐字还原，见 §四-D3）。

---

## 四、缺陷清单

### QA-P0-1 · 沙箱未复刻 SDK 的 `@` 前缀预处理 → **可逃逸 outbox**

| 项 | 内容 |
|---|---|
| **严重级** | **P0**（安全逃逸 / 数据破坏） |
| **现象** | 模型给出 `@../evil.txt` 这类「`@` 前缀 + `..`」路径时，`checkWriteTarget` 判定为「在 outbox 内」放行；但 SDK 的 `write`/`edit` 会先 `normalizeToolPath()` 剥掉前导 `@`，再做 `resolveToolPath` ⇒ **实际写到 outbox 之外**。 |
| **复现入参** | `toolName="write"`, `input={path:"@../evil.txt", content:"x"}`, `cwd=outboxDir=~/.minipi/outbox`, `sceneId="desk"` |
| **期望** | `blocked:true`（拒绝） |
| **实际** | `blocked:false`（放行）；按 SDK 归一后的物理落点为 `~/…/evil.txt`（outbox 的上一级） |
| **影响** | outbox 沙箱是「用户感觉不到文件系统」的**安全底线**。此缺口使模型（或被提示词注入的内容）可把文件写到 outbox 之外的任意相对位置，破坏沙箱承诺。 |
| **根因定位** | `src/main/pi/sandbox.js:189` 取 `input.path` 后**直接** `path.resolve(cwd, raw)`；而 SDK 在 `vendor/pi/packages/agent/dist/harness/tools/path-utils.js:4-10` 的 `normalizeToolPath()` 会先 `path.replace(UNICODE_SPACES," ")` 并把前导 `@` 剥掉。**沙箱少做了这一步归一。** |
| **证据（脚本输出）** | `qa-sandbox-attack.mjs` A5：<br>`probe @ 前缀「"@../../evil"」 · sandbox→\outbox\evil (blocked=false) · sdk→<outbox 外>`<br>`>>> [P0] A5-PRENORM … SDK 目标是否逃逸=true · 可在沙箱外落盘：…\evil.txt（已写入 PWNED）`<br>端到端确认：`raw=@../evil.txt → sdkAbs=C:\…\Temp\minipi-escape-…\evil.txt · inside outbox? false` |
| **可达性前提（如实）** | `@` 前缀是 SDK 的路径别名约定（`path-utils.js` 显式支持）。模型若吐出 `@` 开头的相对路径即可触发。**未做真机联调确认模型实际频率**，但防御上不应依赖「模型不会这么写」。 |
| **修复建议** | 在 `checkWriteTarget()` 取到 `raw` 后，**复刻 SDK 的归一**再 `path.resolve`：先 `raw.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g," ")`，再剥前导 `@`（`raw.startsWith("@") ? raw.slice(1) : raw`）。或更稳的做法：让沙箱与 SDK 共用同一份 `normalizeToolPath`（抽到 shared）。**注意：修完必须回归 A5 全部向量。** |

---

### QA-P2-1 · 沙箱读死 `input.path`，字段名一变即静默放行（不 fail-closed）

| 项 | 内容 |
|---|---|
| **严重级** | P2（隐性契约依赖 / 健壮性） |
| **现象** | 沙箱只认 `input.path`。若 write 类工具把路径放在别的字段名（如 `file_path` / `target` / `filePath`），`raw=""` → `path.resolve(cwd,"")=cwd` → 判为「outbox 内」→ **放行**。 |
| **复现入参** | `input={file_path:"../../evil", content:"x"}`（无 `path` 字段） |
| **期望** | 拒绝（无法确定目标 ⇒ 不 fail-open） |
| **实际** | `blocked:false`（放行） |
| **影响** | **当前 SDK 的 `write`/`edit` 都用 `path`（已核实 `vendor/.../write.js:5-8`、`edit.js:11-16`），故未触发**；但这是隐性的字段名契约——SDK 一旦改名或新增工具，沙箱会静默失效。 |
| **根因定位** | `src/main/pi/sandbox.js:189`：`input && typeof input.path === "string" ? input.path : ""` |
| **证据** | `qa-sandbox-attack.mjs` A6：`>>> [P2] A6-FIELDLOCK 沙箱读死 input.path … input={file_path:'../../evil'} → raw='' → resolve(cwd)=cwd → 放行` |
| **修复建议** | 当 `toolName ∈ WRITE_TOOLS` 且 `input` 里**找不到任何可识别的路径字段**时，应 **fail-closed 拒绝**（而非默默 resolve 到 cwd）。可识别字段集至少涵盖 `path`，并加注释说明「字段名来自 vendor 源码，改名必须同步」。 |

---

### QA-P2-2 · 未知 sceneId 被沙箱当作「非 outbox 场景」放行（fail-open）

| 项 | 内容 |
|---|---|
| **严重级** | P2（防御性缺口，与场景漂移同源） |
| **现象** | `sandbox.js` 内联 `OUTBOX_SCENE_IDS=["quick","note","desk"]`。任何**不在名单**的 sceneId（如新增的 outbox 场景、或拼错的 id）一律 `blocked:false`。 |
| **复现入参** | `sceneId="desk_clone"`（或将来 protocol.js 加的第 5 个 outbox 场景），`input={path:"../../evil"}` |
| **期望** | 要么受沙箱约束，要么明确报错；不建议「默默放行」 |
| **实际** | `blocked:false` |
| **影响** | `sandbox.js` 为「零依赖」内联了场景名单（`sandbox.js:175`），**未 import** `protocol.js` 的 `OUTBOX_SCENES`（`protocol.js:243`）。**已记录为同步风险**：若在 protocol.js 加第 4 个 outbox 场景而忘改 sandbox，该场景沙箱**静默失效**。 |
| **证据** | `qa-sandbox-attack.mjs` A9：`>>> [P2] A9-UNKNOWNSCENE 未知 sceneId 被沙箱当作「非 outbox 场景」放行（fail-open）`；同时 A9 断言当前 `inline === protocol.OUTBOX_SCENES`（`[quick,note,desk]`）**当前一致**。 |
| **修复建议** | 两条择一：① 把 `OUTBOX_SCENES` 抽到一个**零依赖**的常量模块，sandbox 与 protocol 都 import（消除三处镜像：protocol / renderer / sandbox）；② 至少加一条**自动漂移检查**——本报告的 `qa-sandbox-attack.mjs` A9 已实现该检查，建议并入 `check-scene-consistency.mjs`（本脚本按约束**未去改**别人的脚本）。 |

---

### QA-P2-3 · `middleTruncate` 劈开 emoji / 代理对 → 渲染乱码

| 项 | 内容 |
|---|---|
| **严重级** | P2（非核心功能异常 / 边界处理不当） |
| **现象** | 文件名中间截断用 `String.prototype.slice()`（按 UTF-16 码元），当截断点落在星平面字符（emoji）中间时，**劈开代理对**，产生孤立代理项，浏览器渲染为 `�`。 |
| **复现入参** | `middleTruncate("👍👍👍👍👍👍👍👍.docx", 6)` |
| **期望** | 截断点落在**字素簇**边界，不产生半个 emoji（如 `👍👍…👍👍.docx` 或纯尾截断） |
| **实际** | 返回 `"👍👍\ud83d…"`——含孤立**高代理项** `\ud83d`（渲染为 `�`）。实测更多：<br>`middleTruncate("👍👍👍👍👍👍👍👍.docx",20)` → `"👍👍👍\ud83d…\udc4d👍👍👍.docx"`（**同时**含孤立高代理 `d83d` 与孤立低代理 `dc4d`，两个 `�`） |
| **影响** | 任何标题含 emoji 的产出，卡片文件名会出现乱码方块。属用户可见的观感缺陷，不影响文件本身。 |
| **根因定位** | `src/renderer/index.html:986` `${s.slice(0, max - 1)}…`（极长扩展名分支）；`index.html:993-995` `base.slice(0, headLen)` / `base.slice(base.length - tailLen)`（常规分支）。三处 `slice` 均按码元切。 |
| **证据** | `qa-renderer-edge.mjs` C3：`>>> [P2] C3-EMOJI … 结果="👍👍\ud83d…"`。补充探针（headless）输出码点：`1f44d 1f44d d83d 2026`（`d83d` 无配对低代理）。 |
| **修复建议** | 截断前先按码点/字素切分：`const chars = Array.from(base)`（按码点）或 `Intl.Segmenter(grapheme)`（按字素簇，能处理 ZWJ 家庭 emoji），再 `chars.slice()` 后 `join('')`。同时把 `maxChars` 的语义明确为「码点数」或「字素数」并更新注释。**注意**：ZWJ 序列（如 `👨‍👩‍👧`）用 `Array.from` 仍可能劈开，建议直接上 `Intl.Segmenter`。 |

---

### QA-P3-1 · 渲染层 `ERROR_CODES` 缺 `SANDBOX_DENIED`

| 项 | 内容 |
|---|---|
| **严重级** | P3（一致性 / 文案） |
| **现象** | `protocol.js` 的 `ERROR_CODES` 有 **12** 个码（含 `SANDBOX_DENIED`，`protocol.js:96`）；渲染层内联镜像只有 **11** 个（`index.html:781-794`），**缺 `SANDBOX_DENIED`**。 |
| **复现步骤** | ① 读两侧 `ERROR_CODES`；② 用渲染层 `parseErrorMessage` 解析 `"SANDBOX_DENIED: …"`。 |
| **期望** | 两侧逐字一致；`SANDBOX_DENIED` 能被渲染层识别 |
| **实际** | 渲染层缺该码；`parseErrorMessage("SANDBOX_DENIED: 沙箱拒绝写入")` → `{code:"INTERNAL"}`（**降级**） |
| **影响** | 若主进程未来用 `SANDBOX_DENIED` 回错误，渲染层会把码吞成 `INTERNAL`，丢失可分支的错误语义。**当前 `src/` 内暂无该码的使用点**（脚本已 grep：`使用点 SANDBOX_DENIED: （src/ 内暂无使用点）`），故当前无实际功能影响。 |
| **根因定位** | `src/renderer/index.html:781-794` 手工镜像未同步 `protocol.js:96` 新增的 `SANDBOX_DENIED`。 |
| **证据** | `qa-contract-drift.mjs` D1：`protocol ERROR_CODES (12) … renderer ERROR_CODES (11)`；`>>> [P3] D1-ERRORCODES … 缺失=[SANDBOX_DENIED]`。D2：解析结果 `code=INTERNAL`。 |
| **修复建议** | 在 `index.html` 的 `ERROR_CODES` 里补 `SANDBOX_DENIED: 'SANDBOX_DENIED'`（与 protocol 逐字）。更彻底：把错误码列表纳入一个**守门脚本**（见 QA-P3-2），别再靠人工。 |

---

### QA-P3-2 · 场景 `description` 两侧文案漂移，且守门脚本不覆盖

| 项 | 内容 |
|---|---|
| **严重级** | P3（文案 / 一致性） |
| **现象** | `protocol.js` 与 `index.html` 的 4 条 scene `description` **有 2 条不一致**：`note`/`desk` 里 protocol 说「**outbox**」，renderer 说「**产出抽屉**」。且 `check-scene-consistency.mjs` **只比 5 个字段**（`cwdTemplate/label/noTools/toolAllowlist/sessionManagerMode`），**不比 `description`** ⇒ 该漂移无守门。 |
| **复现步骤** | ① 对比两侧 `description` 字面量；② 临时改 `protocol.js` 的 `quick.description`，重跑 `check-scene-consistency.mjs`。 |
| **期望** | 两侧文案一致；或明确接受差异并在注释标注 |
| **实际** | 文案不一致；改 `description` 后守门脚本**仍退出 0**（漏抓） |
| **影响** | 用户在 UI 看到的场景说明（renderer 侧）与契约注释（protocol 侧）不符；不影响功能。属「手工镜像无守门」的典型漂移点。 |
| **根因定位** | `src/renderer/index.html:748,755` vs `src/shared/protocol.js:205,214`；`scripts/check-scene-consistency.mjs` 比较字段集缺 `description`。 |
| **证据** | `qa-contract-drift.mjs` D1b：`protocol: …只写得进 outbox… / renderer: …只写得进产出抽屉…`；`>>> [P3] D1b-DESC 不一致（2 条）`。D3：`>>> [P3] D3-DESC-BLIND … 改 description 后仍退出 0`，且方向 2/3/4 均被正确抓住（退出 1）并还原（`RESTORED-EXIT=0`）。 |
| **修复建议** | 二选一并钉死：① 统一文案（renderer 侧也改回「outbox」，与契约同词）；② 把 `description` 纳入 `check-scene-consistency.mjs` 的比较字段，让漂移无处遁形。②更彻底，推荐。 |

---

## 五、已攻击但**被挡住**的向量（空报告不可接受，此处给出正面证据）

### 象限 A · 沙箱（59/62 通过）

| 攻击向量 | 结果 | 证据 |
|---|---|---|
| UNC `\\?\C:\…` / `\\server\share\…` / `\\?\UNC\…` / `\\.\C:\…` | **全拒绝** | A1 5/5 PASS（`blocked=true`） |
| 8.3 短名 `C:\PROGRA~1\evil.txt` | **拒绝** | A2 PASS |
| 保留设备名 `CON/NUL/PRN/AUX/COM1/LPT1/NUL.txt/COM1.txt` | **不抛异常**；`..\..\NUL` 拒绝 | A3 8/8 PASS |
| 尾随点/空格 `evil.` / `evil ` | 放行（**正确**，仍在 outbox 内） | A4 PASS |
| `.. /x`（点+空格） | 未构成逃逸 | A4 probe |
| 中间 `..`：`a/../../evil`、`/evil` | **拒绝** | A7 PASS |
| 大小写混合前缀陷阱 `..\..\OUTBOX-EVIL\x`、大写兄弟目录 | **拒绝** | A8 PASS |
| `isWriteAllowed` 边界：空串/null/undefined/数字/前缀陷阱 | 全按预期 | A10 10/10 PASS |
| 畸形 `input`：null/undefined/数组/字符串/数字/Symbol/path 为数组或对象 | **均不抛异常**（钩子不静默失效） | A6 14/14 PASS |
| 拒绝文案逐字一致 | **一致** | A11 PASS |

> 结论：UNC / 短名 / 保留名 / 前缀陷阱 / 畸形 input 这些**经典逃逸面全部被挡住**；唯一撕开的口子是 **SDK 预处理差异（`@` 前缀）**（QA-P0-1）。

### 象限 B · 产出链路对抗（87/87 全绿，**0 缺陷**）

| 攻击向量 | 结果 | 证据 |
|---|---|---|
| 原型污染 `__proto__` / `constructor.prototype`（3 载荷） | **未污染** `Object.prototype`，不抛异常 | B1 PASS |
| 超深嵌套 JSON（1000 层） | 不抛异常 | B1 PASS |
| 超长数组（10 万 sections） | 截断到 50 节 | B1 PASS |
| 类型混淆 12 种（title=数组/对象/数字/NaN/null；sections=字符串/数字/null；bullets 混 null/对象/数字/嵌套对象…） | **全不抛异常** | B2 12/12 PASS |
| **`buildFileName` 路径穿越 31 向量**（`../../evil`、`..\..\evil`、`C:\Windows\evil`、`CON/NUL/AUX`、`....//`、`.`/`..`/`...`、`\u0000`、换行、`\`/`/`/`:`/`*`/`?`/`"`/`<`/`>`/`|`、全角斜杠、URL 编码、RTL override） | **全被清洗为单段文件名，无一穿越** | B3 31/31 PASS（端到端：`path.join(outbox, "../../evil"→名)` 仍在 outbox 内） |
| 超长：title 100KB / bullet 1MB / sections 1 万项 / 1000×50KB | 全部截断，48ms 完成（截断**先于**聚合） | B4 5/5 PASS |
| `parseOutcomeJson` 8 种垃圾输入 | 不抛异常 | B5 8/8 PASS |
| `outcomeId` 猜测 10 种（含 `__proto__`/`constructor`/`toString`/`valueOf`/`hasOwnProperty`） | **全部正确拒绝**；内存表是 `Map`（无原型链问题） | B6 PASS |
| **同名并发（TOCTOU）**：5 轮 × 8 并发同 title | **每轮 8 个唯一名 / 磁盘 8 文件**（`flag:"wx"` 真原子） | B7 PASS |
| `generate()` 畸形入参 8 种 | 全抛可读错误码 | B8 PASS |

> 结论：**`buildFileName` 无路径穿越**——这是本次 QA 最关键的一条，我用了 31 个向量 + 端到端落点验证，**它守住了**。原型污染、OOM、并发覆盖也全部守住。

### 象限 C · 渲染层（57/58 通过）

| 攻击向量 | 结果 | 证据 |
|---|---|---|
| 静态 sink 审查（innerHTML 等） | **0 处未转义**（4 处 markdown sink 均 `inlineHTML(escapeHtml(...))` 包裹） | C1 PASS |
| XSS 14 载荷（`<script>`、`<img onerror>`、`<svg onload>`、`javascript:`、`<iframe>`、`data:`、`<math><mtext><script>`…） | **全部无可执行节点**；`window.__pwned` 始终 `undefined` | C5 14/14 PASS |
| 协议白名单（javascript/data/vbscript vs http/#） | 危险协议**未出现在 href** | C6 PASS |
| `escapeHtml` 实测输出 | `<`→`&lt;`、`>`→`&gt;`（脚本**内联**非属性） | 补测：OUT `&lt;img src=x onerror=…&gt;` |
| `middleTruncate` 空值/非字符串/超长/中文/韩文/组合字符 | 不抛异常 | C3 PASS |
| `formatBytes` 14 边界（含 NaN/Infinity/负数/对象） | 全返回字符串（非法→`—`） | C4 PASS |
| `formatClock` 经卡片路径喂 10 种畸形 `createdAt` | **全不抛错** | C4 PASS |
| 畸形产出卡片（空字段/超长文件名/`bytes:null`/`actions:null`） | 渲染不抛错、无横向溢出 | C7 PASS |

> 结论：**渲染层 XSS 防护成立**。`escapeHtml` 虽不转义单引号，但属性一律双引号，且所有模型文本先 `escapeHtml` 再进 `innerHTML`，`sanitizeHref` 挡掉危险协议。唯一问题是 emoji 截断（QA-P2-3）。

### 象限 D · 契约（27/31 通过）

| 攻击向量 | 结果 | 证据 |
|---|---|---|
| `OUTCOME_FORMAT_IDS` / `OUTCOME_ACTIONS` / `OUTBOX_SCENES` / `OUTCOME_TITLE_MAX_CHARS` 镜像 | **逐字一致** | D1 PASS |
| 守门脚本方向 2：改 `index.html` 场景 label | **抓住**（退出 1） | D3 PASS |
| 守门脚本方向 3：删 protocol.js 的 desk 场景 | **抓住**（退出 1） | D3 PASS |
| 守门脚本方向 4：改 protocol.js 的 `OUTBOX_SCENES` | **抓住**（退出 1） | D3 PASS |
| 三次改错**均已还原** | `RESTORED-EXIT=0`（逐字一致） | D3 PASS |
| preload 5 方法齐全 + 通道常量引用 + `toPlainArg`（含循环引用） | **全通过** | D4 PASS |

> 结论：守门脚本对**它覆盖的字段**是有效的、对称的（改任一侧都能抓）；缺口在 `description`（QA-P3-2）和 `ERROR_CODES`（QA-P3-1）——这两块**没有守门脚本**（方砚代码注释亦承认「产出相关字段目前靠人工对齐」）。

---

## 六、验收标准核对

| 验收标准 | 结论 | 依据 |
|---|---|---|
| 场景四档定义两侧一致 | **部分** | 5 个功能字段一致（D1）；`description` 文案 2 条漂移（QA-P3-2） |
| outbox 沙箱「写不出 outbox」 | **不通过** | `@` 前缀可逃逸（QA-P0-1）；其余向量全挡住 |
| 沙箱钩子不静默失效（不抛异常） | **通过** | A6 14 种畸形 input 均不抛异常 |
| M5 产出链路对畸形输入健壮 | **通过** | B 象限 87/87，无穿越/污染/OOM/竞态 |
| `buildFileName` 无路径穿越 | **通过** | B3 31 向量 + 端到端验证 |
| 渲染层无 XSS | **通过** | C5 14 载荷 + `window.__pwned` 未定义 |
| 产出卡片对畸形数据健壮 | **通过** | C7 |
| 产出卡片文件名中间截断 | **部分** | 功能成立，但 emoji 会被劈开（QA-P2-3） |
| 契约镜像逐字一致 | **部分** | 4 常量一致；`ERROR_CODES` 缺 1 码（QA-P3-1） |
| 守门脚本有效 | **部分** | 5 字段有效对称；`description`/`ERROR_CODES` 无守门 |
| preload 透传契约 | **通过** | D4 |
| M4 审批闸门 | **未做（已知 P0）** | `session.js:621` 规则 2 空实现；`approval.js` 不存在 |

---

## 七、测试结论

**有条件交付**。

- **必须修复（阻断交付）**：**QA-P0-1**（沙箱 `@` 前缀逃逸）——它直接击穿产品「用户感觉不到文件系统」的安全底线，且我在纯 Node 下已端到端复现「沙箱外落盘成功」。
- **强烈建议修复（应修但非阻断）**：**QA-P2-1 / QA-P2-2**（沙箱两处 fail-open 相关：字段名 / 未知场景），与 P0 同源——都是「沙箱与 SDK/契约的隐性耦合」，建议一并收口，并**补一条自动漂移检查**。
- **建议修复**：**QA-P2-3**（emoji 乱码，用户可见）；**QA-P3-1 / QA-P3-2**（契约缺码 / 文案漂移 + 守门盲区）。

### 未测到的部分（如实声明，不含糊）

1. **真机 Electron + IPC 端到端**：本机 GPU 崩，未运行。渲染层用 headless Chrome 等价验证，但 **preload↔主进程 IPC 的真实链路未跑通**（D4 只做了静态透传审查 + `toPlainArg` 纯函数模拟）。
2. **Pi SDK live 联调**：未跑。`@` 前缀逃逸的**可达性**（模型实际会不会吐 `@` 路径）未在真实模型上确认——但 SDK 源码已证实该归一存在。
3. **象限 D 的 `spawnSync` 调用**：本机沙箱禁止，改用 `fork`（等价退出码语义），**未在允许 spawn 的机器上交叉验证**。
4. **`formatClock` 直接单测**：该函数**未暴露**到 `window.__minipi`，我只能经产出卡片渲染路径间接验证（10 种畸形 `createdAt` 未抛错），**未做直接函数级边界单测**。
5. **多用户越权 / IDOR**：本产品为**单机单用户**，无多租户，`sessionId`/`outcomeId` 的归属靠「注册表/内存表」保证（B6 已验证猜测 id 全部 404）。**无独立的多账号越权面可测**。

---

## 八、测试数据与清理

| 项 | 结果 |
|---|---|
| 测试数据位置 | 全部 `os.tmpdir()` 下临时目录（`minipi-qa-*`） |
| `~/.minipi/` 真实目录 | **未触碰**（沙箱测试用临时 outbox 注入） |
| 临时目录清理 | 各脚本 `finally` 内 `fs.rmSync(tmp, {recursive:true,force:true})`，运行日志均有「已删除临时目录」 |
| `src/` 业务代码 | **未修改**（唯一例外：象限 D 临时改 protocol.js/index.html 验证守门脚本，已 `RESTORED-EXIT=0` 逐字还原） |
| 新增依赖 | **无** |
| 探针脚本 | 临时探针（`scripts/out/_qa-probe-*.mjs`）用完即删 |
| commit | **未 commit** |

---

## 附录：4 个 QA 脚本运行方式

```bash
node scripts/qa-sandbox-attack.mjs       # 象限 A · 沙箱攻击（约 1s，退出码 1=有缺陷）
node scripts/qa-outcome-adversarial.mjs  # 象限 B · 产出链路对抗（约 2s，退出码 0=全绿）
node scripts/qa-renderer-edge.mjs        # 象限 C · 渲染层边界（需 Chrome，约 60s，退出码 1=有缺陷）
node scripts/qa-contract-drift.mjs       # 象限 D · 契约一致性（约 5s，退出码 1=有缺陷）
```

> ⚠ `qa-renderer-edge.mjs` 首次冷启动 Chrome + CDP 可能较慢（本机实测 ~60s）；若 200s 内未见输出属启动异常而非挂死，重试即可。跑完不应残留 `minipi-qa-cdp-*` 临时 profile。
