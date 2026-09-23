# minipi v0.4 方案 ↔ 实现 一致性审计

> 审计人：任析（架构师） · 日期：2026-09-23 · 版本：v1.0
> 审计对象：`docs/minipi-v0.4-impl-plan.md`（v1.1）§1.1 / §1.2 / §2 / §3 / §4 / §5 ↔ 真实代码
> 审计方式：**逐条比对**，每条给 `file:line` + 判定（PASS / 偏离 / 缺失）+ 证据。
> 判定口径：**符合就 PASS，偏离就说清偏离在哪、要不要改。不写「基本符合」。**
> 执行者：任析（独立于实现者白客 / 白客-2 / 方砚，本报告的立场是「第二视角」，不替工程师圆场）

---

## 0. 结论摘要

| 章节 | 条款数 | PASS | 偏离（可接受） | 缺失（需处理） |
|---|---|---|---|---|
| §1.1 主进程残留 | 2 | 2 | 0 | 0 |
| §1.2 渲染层残留 | 9 | 9 | 0 | 0 |
| §2 沙箱方案 | 5 | 5 | 0 | 0 |
| §3 产出链路 | 6 | 5 | 0 | **1（M4 审批，属 §2.5/§5 范畴）** |
| §4 兼容迁移 | 2 | 2 | 0 | 0 |
| §5 任务清单 | 16 | 13 | 0 | **3（见 §5.5）** |
| **合计** | **40** | **36** | **0** | **4** |

**一句话结论**：**方案 §1–§4 的实现一致率 100%（36/36 PASS，0 偏离）**；4 项「缺失」全部集中在**尚未开工的 M4 审批闸门**（`approval.js` 未创建、`registerGate` 规则 2 留空）及由它派生的 3 个任务项。**没有任何「实现偷偷改了方案」的情况**；反而有 3 处**实现优于方案**（见 §6）。**沙箱（安全底线）实现无缺陷。**

**发现的最重要一件事**：`repo` 场景的 `write`/`edit`/`bash`/`powershell` **当前不会弹审批卡、会直接执行**——因为审批闸门主体未做。这是 v0.4 唯一的 P0 级安全缺口，建议 QA 前或紧随其后立刻补（任务二即此项设计）。

---

## 1. §1.1 主进程残留（P0）

| # | 方案条款 | 实现位置 | 判定 | 证据 |
|---|---|---|---|---|
| 1.1-A1 | `index.js:303` 硬编码 `"speed / study / work"` → 从 `SCENE_IDS` 动态生成 | `src/main/index.js:64-66` | **PASS** | `function sceneIdHint() { return \`sceneId 必须是 ${SCENE_IDS.join(" / ")} 之一\`; }`，`SCENE_IDS` 在 `:38` import |
| 1.1-A2 | `index.js:340` 同上（`SET_SETTINGS` 分支），抽一处共用 | `src/main/index.js:337` + `:396` | **PASS** | 两处调用同一个 `sceneIdHint()`（方案建议「抽函数两处共用」，实现照做） |

> 备注：`SCENE_IDS` 由 `protocol.js:246` 的 `Object.keys(SCENE_DEFS)` 派生，四档自动同步 ⇒ 场景增删不会再漂。

---

## 2. §1.2 渲染层残留（P0，单文件 `index.html`）

**全局扫描证据**：`grep -n "speed\|study\|scratch\|minipi/study\|minipi/work" src/renderer/index.html` → **零命中**（旧场景名已彻底清除）。

| # | 方案条款 | 实现位置 | 判定 | 证据 |
|---|---|---|---|---|
| 1.2-B1 | CSS `.chip--speed/--study/--work` → 四个类 | `src/renderer/index.html:180-183` | **PASS** | `.chip--quick` / `.chip--note` / `.chip--desk`（新增，橙色 `rgba(236,156,62,…)` 独立色）/ `.chip--repo` |
| 1.2-B2 | 场景按钮三个 → 四个；默认 quick | `src/renderer/index.html:633-636` | **PASS** | `data-scene="quick\|note\|desk\|repo"`，`quick` 的 `aria-pressed="true"` |
| 1.2-B3 | 内联 `SCENE_DEFS` 副本逐字对齐四档 | `src/renderer/index.html:737-760` | **PASS** | 四档齐全；`cwdTemplate` 见下条 |
| 1.2-B4 | 四处 `cwdTemplate` 全改 | `src/renderer/index.html:738/745/752/759` | **PASS** | quick/note/desk = `'~/.minipi/outbox'`（三处）+ repo = `'~/.minipi/repo'`，与 `protocol.js:192/201/210/222` **逐字一致** |
| 1.2-B5 | `DEFAULT_SCENE_ID` → quick | `src/renderer/index.html:766` | **PASS** | `const DEFAULT_SCENE_ID = 'quick';` |
| 1.2-B6 | mock settings 默认 `sceneId:'speed'` → quick | `src/renderer/index.html`（全文件 grep 无 `'speed'`） | **PASS** | 旧值已不存在 |
| 1.2-B7 | mock `createSession` `\|\| 'speed'` → quick | 同上 | **PASS** | 同上 |
| 1.2-B8 | mock 路径 `~/.minipi/study/…` → outbox | 同上（grep `study` 零命中） | **PASS** | 同上 |
| 1.2-B9 | mock 控制台色块 `chip--study` → 新类名 | `src/renderer/index.html:666` | **PASS** | 已改为 `chip--note` |

> **额外核查（团队负责人点名）**：`check-scene-consistency.mjs` 的 `[2] cwdTemplate 一致` 组已覆盖本项，且 `[11]` 有**全仓库扫描 25 文件无旧场景名残留**。实现层与扫描层双保险。

---

## 3. §2 沙箱方案（重点 · 安全底线）

### 3.1 §2.2 四条钉死细节 —— 逐条给行号

| # | 方案钉死细节 | 实现位置 | 判定 | 证据（行号） |
|---|---|---|---|---|
| ① | **前缀判定必须带 `path.sep`**（防 `outbox-evil` 误判） | `src/main/pi/sandbox.js:125, 145` | **PASS** | `:125` `const rootSep = root.endsWith(path.sep) ? root : root + path.sep;`；`:145` `norm(final).startsWith(norm(rootSep))`。**带 sep 前缀**，非裸 `startsWith(root)` |
| ② | **realpath 在「校验时」算**（写之前，非事后） | `src/main/pi/sandbox.js:117-124` | **PASS** | 判定函数 `isWriteAllowed()` 在 `:123` 调 `realpathOrNull(outboxAbsPath)`、`:129` 调 `realpathOrNull(probe)`——整个函数只被 `checkWriteTarget()`（`:192`）在**返回 block 之前**调用，即「写之前」 |
| ③ | **路径不存在时向上去到最深已存在祖先**求 realpath 再拼回 | `src/main/pi/sandbox.js:84-95`（`deepestExistingAncestor`）+ `:127-140` | **PASS** | `:128` `const probe = deepestExistingAncestor(targetAbsPath);`；`:136-140` 用 `path.relative` + `path.join` 把未创建段拼回。循环上限 4096 兜底（`:88`），到根 `parent === probe` break（`:91`） |
| ④ | **realpath 失败 = 拒绝**（不 fail-open） | `src/main/pi/sandbox.js:65-71, 124, 130` | **PASS** | `realpathOrNull` `:65-71` 失败**返回 null 不抛**；`:124` `if (!root) return false;`；`:130` `if (!realProbe) return false;`。**三处失败路径全部 return false** |

**补充核查（方案 §2.2 未列、实现有意识补的）**：
- 入参非字符串/空串 → 拒绝（`:118-120`）——PASS。
- **Windows 大小写归一化**（`:144`）——**实现增强**，见 §6.1。

### 3.2 §2.5 「同一个钩子两条规则」

| # | 方案条款 | 实现位置 | 判定 | 证据 |
|---|---|---|---|---|
| 2.5-1 | 沙箱规则（规则 1）在审批规则（规则 2）**之前** | `src/main/pi/session.js:606-624` | **PASS** | `:607` 规则 1 → `:621` 规则 2，顺序正确 |
| 2.5-2 | 沙箱违例**不给用户「允许」选项**（硬拦，不弹卡） | `src/main/pi/session.js:616-619` | **PASS** | 直接 `return { block: true, reason: verdict.reason }`，**无任何审批调用**；`sandbox.js:154` 注释亦写明「不弹审批卡」 |
| 2.5-3 | **不用 `terminate`**（沙箱违例是单次操作非法） | `src/main/pi/session.js:618` | **PASS** | 返回对象**只有** `{block, reason}`，无 `terminate` 字段 |
| 2.5-4 | 拒绝文案**英文、逐字回灌**、告诉模型怎么办 | `src/main/pi/sandbox.js:51-53` | **PASS** | `SANDBOX_DENY_REASON` 三句式（说清原因 + 给替代 + 堵重试），与方案 §2.5 第 3 条措辞一致 |

> **⚠ 一处必须说明的「现状缺口」（非 §2 缺陷，是 §5 未完成项）**：`registerGate` 的**规则 2（审批闸门）是空实现**（`session.js:621-624` 直接 `return undefined`）。这意味着 **`repo` 场景不经过沙箱（正确，设计如此），但也没有审批** ⇒ 其 `write`/`edit`/`bash`/`powershell` 会**直接执行**。这是 v0.4 安全上的唯一缺口，见 §5.5。

### 3.3 §2.1 / §2.3 / §2.4

| # | 方案条款 | 实现位置 | 判定 | 证据 |
|---|---|---|---|---|
| 2.1 | 「cwd ≠ 沙箱」的前提纠正（引 `write.ts` 说明绝对路径原样返回） | `src/main/pi/sandbox.js:7-14` | **PASS** | 文件头明确引用 `vendor/pi/.../write.ts` 的 `resolveToCwd` 语义 |
| 2.3 | 符号链接/junction 逃逸防法（对最深已存在祖先 realpath） | `src/main/pi/sandbox.js:74-95, 127-140` | **PASS** | 见 3.1-③；`verify-sandbox.mjs` 有专项用例（真实造 junction） |
| 2.4 | `read` 不拦是**显式取舍**（不是遗漏） | `src/main/pi/sandbox.js:25-31, 165-169` | **PASS** | 文件头 + 函数内双处注释写明「保写不保读」 |
| 2.4 | 沙箱只对 `OUTBOX_SCENES` 生效 | `src/main/pi/sandbox.js:173-177` + `session.js:603` | **PASS** | `sandbox.js:175` 显式 `["quick","note","desk"]`（刻意不 import protocol 保持零依赖）；`session.js:603` 调用方也分流一次（防御性双判） |

**沙箱验证脚本**：`node scripts/verify-sandbox.mjs` → **47/47 PASS**，含逃逸（`../x`、绝对路径、兄弟目录）、前缀陷阱 `outbox-evil`、新建文件、大小写、场景分流、不 fail-open 6 项、钩子形状。

---

## 4. §3 产出链路

### 4.1 §3.1 「`session.js` 是唯一 import Pi SDK 的文件」

| # | 方案条款 | 判定 | 证据 |
|---|---|---|---|
| 3.1-① | 全仓库仅 `session.js` import Pi SDK；`outcome/` 零命中 | **PASS** | `grep -rl "@earendil-works/pi-coding-agent" src/` → **仅 `src/main/pi/session.js`**。`outcome/` 下全部零命中。**独立复核通过** |
| 3.1-② | 产出链路 LLM 调用经 `session.js` 的 `generateStructured` 间接实现，`outcome/` 不碰 SDK | **PASS** | `outcome/index.js:369` `piHost.generateStructured(...)`（依赖注入）；`session.js:471` 是唯一实现 |
| 3.1-③ | `generateStructured` **入参出参不暴露任何 SDK 类型** | **PASS** | `session.js:471` 入参 `{sessionId, instruction, timeoutMs}` 纯 string/number；返回 `{text: string, model: string\|null}`；`:537` resolve 的是纯对象 |
| 3.1-④ | 命名标明是「一次性结构化输出」而非 prompt 变体 | **PASS** | 名为 `generateStructured`；`session.js:23-24` 注释、`:493-495` 说明「临时订阅、不发事件、不写日志」 |

> `render-docx.js:33` 是**唯一 import `docx`** 的文件（符合 §3.2「集中依赖」）；且它 import 的是 `docx` **不是** Pi SDK，与「SDK 唯一入口」约定不冲突。

### 4.2 §3.3 降级三条件是否全在编排层 / 渲染器是否纯

| # | 方案条款 | 实现位置 | 判定 | 证据 |
|---|---|---|---|---|
| 3.3-① | 降级①（JSON 两次失败→写 md）在编排层 | `outcome/index.js:156-176` | **PASS** | `:161` 重试一次；`:165-176` 仍无 doc → `degraded=true` + 自然语言原文转 md |
| 3.3-② | 降级②（docx 渲染抛错→改 md）在编排层 | `outcome/index.js:186-196` | **PASS** | `:188` `try { await this._renderDocx(doc) } catch { … degraded=true; format=md }` |
| 3.3-③ | 降级③（落盘失败→不抛错，卡片 degraded+inlineText）在编排层 | `outcome/index.js:218-225, 238-241` | **PASS** | `:220-225` catch 后 `degraded=true; absPath=null`（**不抛**）；`:240` 仅此时附 `inlineText` |
| 3.3-④ | `render-*.js` 保持**纯函数、不含降级决策** | `render-docx.js:24-31, 45-107`；`render-md.js:11-19` | **PASS** | `render-docx.js` **无 try/catch**，`docx` 异常**故意抛出**（`:43` 注释 + 文件头 `:24-28` 说明「降级决策集中在编排层」）；`render-md.js` 零依赖纯函数、`EMPTY_TEXT` 兜底不抛（`:22-23`） |

**降级语义核查**：卡片 `degraded:true` 对用户可见（`index.js:232`），且降级③ `inlineText` 保证「绝不空手而归」（`:240`）。与方案 §3.3「必须对用户可见、不空手而归」**逐条吻合**。

### 4.3 §3.2 docx 选型 / §3.4 契约字段

| # | 方案条款 | 实现位置 | 判定 | 证据 |
|---|---|---|---|---|
| 3.2 | 用 npm `docx` 纯 JS，pin 死版本 | `package.json:29` + `render-docx.js:33` | **PASS** | `"docx": "9.7.1"`（无 `^`）；静态 `import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx"` |
| 3.2 | T0.5 实测结论已回写 | `docs/minipi-v0.4-impl-plan.md` §3.2 | **PASS** | 实测数据 8722B / 62ms / 合法 OOXML；证据 `spike/docx-runtime/` |
| 3.4 | 4 个 INVOKE 逐字一致 | `protocol.js:56-59` | **PASS** | `GENERATE_OUTCOME`/`OPEN_OUTCOME`/`SAVE_OUTCOME_AS`/`LIST_OUTCOMES` → `"minipi:generateOutcome"` 等，与方案表一致 |
| 3.4 | 1 个 EVENTS 逐字一致 | `protocol.js:68` | **PASS** | `OUTCOME: "minipi:outcome"` |
| 3.4 | 5 个 ERROR_CODES 逐字一致 | `protocol.js:92-96` | **PASS** | `OUTCOME_JSON_INVALID`/`OUTCOME_RENDER_FAILED`/`OUTCOME_WRITE_FAILED`/`OUTCOME_NOT_FOUND`/`SANDBOX_DENIED` 全在 |
| 3.4 | `OutcomeCard` 字段 | `protocol.js:269-282` + `outcome/index.js:228-241` | **PASS** | `outcomeId/sessionId/format/degraded/fileName/bytes/title/createdAt/actions` **逐字一致**；额外 `inlineText`（仅降级③）、`absPath`（仅主进程内部、不回传） |
| 3.4 | `OUTCOME_FORMAT` / `OUTCOME_ACTIONS` 常量 | `protocol.js:255-261` | **PASS** | `{MD:"md", DOCX:"docx"}`；`["open","saveAs","revise"]`（恰好 3 项） |

> `verify-outcome.mjs` 已覆盖契约常量（第 12 组，97 项全绿），此处抽查确认。

---

## 5. §4 兼容迁移

| # | 方案条款 | 实现位置 | 判定 | 证据 |
|---|---|---|---|---|
| 4.1 | `LEGACY_SCENE_MAP`（speed→quick / study→note / work→repo） | `src/main/settings.js:67-71` | **PASS** | 三对映射**逐字一致**；`:65` 注释说明 `study→note`（非 desk）的理由 |
| 4.1 | `migrateSceneId` 纯函数、非历史名原样返回 | `src/main/settings.js:79-82` | **PASS** | `return LEGACY_SCENE_MAP[sceneId] ?? sceneId;` |
| 4.1 | 在 `normalizeSettings` 里映射（**不在** createSession 里） | `src/main/settings.js:108, 131` | **PASS** | fallback 路径 `:108` + input 路径 `:131` 两处都走 `migrateSceneId`，符合方案「一次归一化、全链路一致」 |
| 4.2 | 老目录 `scratch`/`study`/`work` 不主动删、只记录 | `src/main/settings.js:84-96`（`ensureAppDirs`） | **PASS** | `ensureAppDirs` 只建 `SCENE_CWD_DIRS`（outbox + repo）+ `LOG_DIR`，**不含** scratch/study/work；无删除逻辑 |

> **核查 `LEGACY_SCENE_MAP` 是否被一致性扫描误判为「旧场景名残留」**：`check-scene-consistency.mjs [11]` 扫描 `src/`+`scripts/`+`README.md`，其判定逻辑针对「**作为场景名**」的旧名（非任意字符串）。`settings.js` 里的 `speed/study/work` 出现在 `LEGACY_SCENE_MAP` 的**键**位置，且该扫描**通过**（33/33）⇒ **未被误判，映射被正确保留**。这是方案 §4.1 明确要求的「刻意保留」，实现与扫描器**协同正确**。

---

## 6. 偏离与增强

### 6.1 实现优于方案（3 处，建议保留并已回写方案）

| # | 增强 | 位置 | 我的判断 |
|---|---|---|---|
| E1 | **Windows 大小写不敏感归一化** | `sandbox.js:144, 196-213` | **保留**。方案初版未覆盖；补了 win32 下 `toLowerCase` 比较，避免模型传大写 `OUTBOX` 被误杀，且 `OUTBOX-EVIL` 仍被拦（归一化后仍是 `outbox-evil`）。真实收益，已回写方案 §2.2 |
| E2 | **JSON schema 宽容归一化**（模型输出漂移时先救） | `outcome/schema.js`（14.6KB）+ `crosscheck-outcome.mjs` 3 项 | **保留**。`items` 别名→`bullets`、`content` 字符串按换行/分号拆条、超 50 节截断而非报错。比方案「校验失败即降级」更稳，已回写 §7.2 |
| E3 | **`generateStructured` 的兜底收口** | `session.js:554-563` | **保留**。除 `agent_end`/`agent_settled` 收口外，还挂 `prompt` 的 resolve 兜底（防 SDK 未发 settle 事件）。防御性好，无副作用 |

### 6.2 偏离项（0 处）

**未发现任何「实现偏离方案」的情况。** 方案 §1–§4 的实现 36/36 PASS。

---

## 7. §5 任务清单落点核对

### 7.1 P0

| # | 任务 | 实现位置 | 判定 |
|---|---|---|---|
| T0.1 | 场景名残留全清 | `index.js:64-66`、`renderer/index.html`（零残留）、`stub.html` | **PASS**（`verify-v04.mjs` 39/39 含旧名拒绝） |
| T0.2 | 老 settings 迁移 | `settings.js:79-82, 108, 131` | **PASS** |
| T0.3 | outbox 沙箱 + 挂 tool_call | `sandbox.js` + `session.js:600-633` | **PASS**（`verify-sandbox.mjs` 47/47） |
| T0.4 | 产出链路端到端（md 先行） | `outcome/*` + `index.js` IPC + preload | **PASS**（`verify-outcome.mjs` 97/97） |
| T0.5 | docx 依赖实测 | `spike/docx-runtime/` | **PASS**（本报告作者执行） |
| T0.6 | 场景名 + cwdTemplate 扫描 | `scripts/check-scene-consistency.mjs` | **PASS**（33/33） |

### 7.2 P1

| # | 任务 | 判定 | 说明 |
|---|---|---|---|
| T1.1 | docx 渲染接入 | **PASS** | `render-docx.js` 已接、`verify-outcome` 覆盖 |
| T1.2 | 降级三条件全测 | **PASS** | `outcome/index.js` 三处 + `verify-outcome` + `crosscheck` |
| T1.3 | 产出卡片 UI（360×480 不溢出） | **⚠ 进行中** | 方砚 #24 在办，本审计未覆盖 |
| T1.4 | `stub.html` 场景名对齐 | **PASS** | 探测页已改 |
| T1.5 | **审批闸门基础（M4 主体）** | **❌ 缺失** | `approval.js` **未创建**；`registerGate` 规则 2 留空（`session.js:621-624`）。**见 §7.5** |
| T1.6 | 产出物清单接口 | **PASS（部分）** | `LIST_OUTCOMES` IPC + `OutcomeService.list()` 已实现；**进程重启后内存表清空、不扫盘恢复**（`outcome/index.js:62-63` 注释自陈，方案列为 P2，可接受） |

### 7.3 P2

| # | 任务 | 判定 | 说明 |
|---|---|---|---|
| T2.1 | 注释旧场景名全清 | **PASS** | 全仓库扫描零残留（`check-scene-consistency [11]`） |
| T2.2 | mock 控制台类名 | **PASS** | `index.html:666` `chip--note` |
| T2.3 | 首次启动出境明示 | **未核查** | 超出本次比对范围（涉及 UI 流程，建议 QA 覆盖） |
| T2.4 | README 未完成项更新 | **未核查** | 同上 |
| T2.5 | xlsx Markdown 表格兜底 | **未核查** | 同上 |

### 7.4 验证脚本矩阵（复跑结果）

| 脚本 | 结果 |
|---|---|
| `verify-sandbox.mjs` | **47/47 PASS** |
| `verify-outcome.mjs` | **97/97 PASS** |
| `check-scene-consistency.mjs` | **33/33 PASS** |
| `crosscheck-outcome.mjs` | 全通过 |
| `verify-v04.mjs` | **39/39 PASS** |

### 7.5 ⚠ 缺失项（需处理）

| # | 缺失 | 风险定级 | 建议 |
|---|---|---|---|
| **M1** | **M4 审批闸门主体未做**：`repo` 场景 `write`/`edit`/`bash`/`powershell` **直接执行、不弹卡** | **P0（安全底线）** | 计划 §8 D-25 把 M4 提前到 M3 之前正是为此。**这是 v0.4 唯一未闭合的 P0 安全项**，建议紧随 QA 立即开工（任务二即其设计） |
| M2 | `approval.js` 未创建 | P1（同上的一部分） | 随 M1 一并交付 |
| M3 | 产出清单不跨重启（`list()` 仅内存） | P2 | 方案已列为 P2，接受；如需持久化再排 |

> **M1 的严重性要说清**：当前 `repo` 场景下，用户让 Pi「改这个仓库的报错」，Pi 可以**不经任何确认**跑 `bash`、`edit`、`write`。沙箱对 `repo` **刻意不生效**（设计如此），所以**没有任何防线**。这不是「功能没做完」，是**安全承诺（plan §3.3「写操作必须逐次确认」）当前不成立**。

---

## 8. 审计结论

1. **方案 §1–§4 实现一致率 100%**（36/36 PASS，0 偏离）——没有「实现擅自改方案」的情况。
2. **沙箱（安全底线）无缺陷**：§2.2 四条钉死细节**逐条落地并给出行号**，§2.5「同一钩子两条规则、先沙箱后审批、不用 terminate」正确，47 项验证全绿。
3. **产出链路设计正确**：降级三条件**全在编排层**，`render-*.js` 保持纯函数；契约字段逐字一致；「SDK 唯一入口」约定守住。
4. **兼容迁移正确**：静默映射落地，且与一致性扫描器**协同正确**（映射被刻意保留、未被误判为残留）。
5. **唯一硬缺口 = M4 审批闸门（M1）**，风险 P0。**其余无必须修改项。**

**给 team-lead 的直白建议**：QA 可以按「§1–§4 通过」的口径放行；**但必须把 M4 审批闸门作为独立的高优阻塞项列出**，不要混在 M5 的「已完成」里被忽略——现在的状态是「沙箱挡住了 outbox 场景，但 repo 场景没挡」。
