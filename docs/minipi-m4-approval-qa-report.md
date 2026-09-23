# minipi · M4 审批闸门主进程侧 · 独立 QA 复验报告

> 测试工程师：秦戈（第三层「证伪」）
> 日期：2026-09-23
> 被测交付：M4.1 `approval.js` + M4.2 `protocol.js` 契约 + M4.3/M4.4 接线（`session.js` 规则 2 + `main/index.js` handler + `preload`）
> 复验依据：`docs/minipi-approval-gate-design.md` v1.1.3 §9.4 对账清单（R1–R5 + T5）
> 结论速览：**有条件交付** —— 核心功能与两条安全红线均**未破**；发现 1 条 P2（审计脱敏覆盖不全，team-lead 裁定按 P2 修）+ 1 条 P3（设计 §9.4 声称的 T5 专项断言实际不存在）+ 1 条基线可靠性问题（`verify-sandbox-live` 假阴性，**已修复并回归绿**）。

---

## 【测试范围】

| 项 | 内容 |
|---|---|
| 被测功能 | M4 审批闸门（`repo` 场景护栏）：三 outcome 语义、卡片契约、R5 会话级 always-allow、超时 fail-closed、重启丢弃、审计脱敏、批合并、场景路由 |
| 环境 | Windows · Node v22.22.2 · 纯 Node 离线单测（本机 Electron GPU 崩，起不了真窗口，故走注入 bridge 的纯 Node 路径，与 `verify-approval.mjs` 同口径） |
| 测试账号 | 不适用（单机单用户，无鉴权体系）；改为「不同 sessionId / 不同 source」模拟越权与作用域 |
| 测试数据 | 全部用 `os.tmpdir()` 下的临时 `home` / `appDir`；未触碰 `~/.minipi/`、未修改任何 `src/` 业务代码 |
| 新增脚本 | `scripts/qa-approval-semantics.mjs`（A/B 组）、`scripts/qa-approval-r5.mjs`（C 组 + 两条红线）、`scripts/qa-approval-contract.mjs`（D/E 组） |

**方法说明**：本次**没有复跑** `verify-approval.mjs` 的 151 项作为结论；那 151 项只作为「基线绿」的旁证单独列出。所有判定均来自**我自己构造的输入 + 假时钟（fakeClock，接管 `setTimeout`/`clearTimeout`）+ 记录型 bridge**，从行为结果反推实现是否达标。每条 `FAIL` 都附带最小可复现命令/脚本。

---

## 【执行摘要】

| 层面 | 用例数 | 通过 | 失败 |
|---|---|---|---|
| 语义（A 组：三 outcome / every 语义 / R3 文案 / cancelBySession / 超时） | 41 | 41 | 0 |
| always-allow + 沙箱优先（C 组：R5 / 红线 #9 / 红线 #12） | 44 | 44 | 0 |
| 契约 + 攻击（D/E 组：卡片字段 / 非法 action / fail-closed / 重启丢弃 / 并发 / id 复用 / 场景路由 / 恶意输入） | 58 | 58 | 0 |
| **合计（自建 QA 断言）** | **143** | **143** | **0** |

**基线脚本退出码**（仅作旁证，非本次结论）：

| 脚本 | 退出码 | 备注 |
|---|---|---|
| `verify-approval.mjs` | 0 | 151 项全绿，与白客自述一致 |
| `verify-sandbox.mjs` | 0 | |
| `verify-v04.mjs` | 0 | |
| `verify-outcome.mjs` | 0 | |
| `check-scene-consistency.mjs` | 0 | |
| `qa-sandbox-attack.mjs` | 0 | 我上次的 P0 `@` 逃逸已修复，回归绿 |
| `qa-outcome-adversarial.mjs` | 0 | |
| `qa-renderer-edge.mjs` | 0 | 58 项 |
| `qa-contract-drift.mjs` | 0 | 31 项 |
| **`verify-sandbox-live.mjs`** | 0（修复前 1） | 修复前 8 项失败 2 项（模型行为假阴性）→ **已修复，回归 8/8 绿，EXIT=0**，见【非功能性发现 N-1】 |

---

## 【§9.4 对账清单逐条打勾】

| # | 项 | 结论 | 依据（自建断言 / 复跑断言） |
|---|---|---|---|
| R1 | 命名 `APPROVAL_ACTION_IDS` | ✅ PASS | 自建：[D5] `APPROVAL_ACTION_IDS === APPROVAL_ACTIONS`；前端 import 名一致 |
| R2 | terminate 归 `APPROVAL_DENIED`、用 reason 区分 | ✅ PASS | 自建：[A1] terminate reason 逐字 `=== DENY_REASON_TERMINATE`；无独立 TERMINATED 码 |
| **R3** | **terminate 拒绝文案** | ✅ PASS | 自建：[A1]+[A3] 三套文案两两不同、各有验锚点（`did not respond` / `explicitly denied` / `stop this turn`） |
| **R4** | **卡片 `actions` / `alwaysAllowEligible` 等字段** | ✅ PASS | 自建：[D1] push 卡 12 个契约字段齐全、`actions` 恒三项、cancel 卡也带 `sessionId`+`actions`+`batch=[]` |
| **R5** | **会话级 always-allow** | ✅ PASS | 自建：[C1]–[C10]（默认关 / 会话隔离 / 工具隔离 / 仅内存 / 退出即失 / cancelBySession 清 / 审计 / 混合批不开启 / 仅 allowOnce 生效） |
| **T5** | **定时器泄漏修复** | ⚠️ **PASS（产品）/ 见 P3-1（测试声明不符）** | 自建：[B1]+[B2] allowOnce/deny/terminate 后推进假时钟 10s ⇒ 无二次推卡、无 timeout 审计、0 存活定时器。**但**设计 §9.4 声称「白客补修时已加专项断言」，实测 `verify-approval.mjs` 内**不存在**该断言 |

**两条安全红线专项**：

| 红线 | 结论 | 依据 |
|---|---|---|
| 🔴 #9 沙箱优先于 always-allow | ✅ **未破** | 自建：[C11] 端到端 registerGate 形状：always-allow 开启后，越界写仍被 block；`approval.request` **根本未被调用**；未推任何审批卡；无 pending 残留。读码交叉：`session.js:622-634` 规则 1 在规则 2 之前，且 `session.js:644` outbox 场景直接 `return undefined`（根本不进审批） |
| 🔴 #12 `remember` 透传 | ✅ **未破** | 读码：`main/index.js:428` 透传 `remember: arg.remember`；`preload/index.js:139` 暴露 `approvalDecide`；`toPlainArg` 用 `JSON.parse(JSON.stringify())` **不丢字段**。自建：[C12] 模型在 `input` 里伪造 `remember/alwaysAllow` ⇒ 不开记忆；7 条真值边界（`"true"` 字符串 / `1` / 对象 / `false` / `undefined`）均**不**开启，仅严格布尔 `true` 开启 |

---

## 【缺陷清单】

### P2-1 · 审计日志密钥脱敏覆盖不全：`前缀_TOKEN=值` 形态明文落盘

- **级别**：P2（一般问题 —— 非核心功能异常 / 边界处理不当；**不阻断使用、非越权**）
- **描述**：`redactCommandForAudit()` / `sanitizeForAudit()` 的密钥正则要求「关键字」前有 `\b` 词边界，但下划线 `_` 是词字符 ⇒ `SECRET_TOKEN=`、`GITHUB_TOKEN=`、`DB_PASSWORD=` 等**「前缀_关键字=值」形态全部漏脱**，明文密钥写入审计日志 `approvals-audit.log`。
- **复现步骤**：
  1. `cd D:\SAiProject\minipi`
  2. 运行：`node scripts/qa-approval-r5.mjs`（看 `[C13]` 段）
  3. 或最小复现：对 `redactCommandForAudit("GITHUB_TOKEN=ghp_REALSECRET123 npm publish")` 求值
- **实际结果**：
  ```
  "SECRET_TOKEN=abc curl x"                 → "SECRET_TOKEN=abc curl x"          ❌ 未脱敏
  "GITHUB_TOKEN=ghp_x npm x"                → "GITHUB_TOKEN=ghp_x npm x"         ❌
  "DB_PASSWORD=p@ss cmd"                    → "DB_PASSWORD=p@ss cmd"             ❌
  "AWS_SECRET_ACCESS_KEY=AKIAxxx aws ..."   → "AWS_SECRET_ACCESS_KEY=AKIAxxx ..." ❌
  ```
  端到端：`request` + `allowed` 两条审计条目均含明文 `ghp_REALSECRET123`。
- **预期结果**：`GITHUB_TOKEN=<redacted>`（保留键名，值与设计 §7.3 一致）。
- **影响范围**：所有 `repo` 场景触发审批的 `bash`/`powershell` 命令，只要用「前缀_大写下划线关键字」这种**最主流的 env-var 命名约定**（`GITHUB_TOKEN`、`AWS_SECRET_ACCESS_KEY`、`DB_PASSWORD`…）传密钥，明文即落 `~/.minipi/approvals-audit.log`。**不受影响**：`token=`、`API_KEY=`、`--token=`、`Authorization: Bearer` 等独立关键字形态（7/7 已覆盖）。
- **证据**：见 `scripts/qa-approval-r5.mjs` 的 `[C13]` 输出（6/6 遗漏）+ 端到端审计条目。
- **定位**：
  - `src/main/pi/approval.js:152-153` `SECRET_PATTERN = /\b(api[_-]?key|token|secret|password|authorization|bearer)\b\s*[:=]\s*.../gi` —— `\b...\b` 在 `_` 处不成立
  - `src/main/pi/approval.js:194`（`sanitizeForAudit`）与 `:214` 附近（`redactCommandForAudit`）均复用同一 pattern
- **根因**：设计 §7.2 第 4 条给的正本就是 `(api[_-]?key|token|secret|password|authorization|bearer)\s*[:=]\s*\S+`，实现近乎逐字照抄 ⇒ 这是**规范自身的措辞限制被原样继承**，非实现相对规范的偏离。但设计 §12 风险表把它列为「中」风险并声称缓解措施是「对 `KEY=value` 段做 `<redacted>`」，而当前对**最常见的 `KEY=value` 形态**并未达成。
- **修复建议**：把关键字边界从 `\b` 放宽为「`(?<![A-Za-z0-9])`（即允许 `_` 前缀）」，或显式加一条 `/[A-Z0-9_]+(?:TOKEN|SECRET|PASSWORD|KEY)\s*[:=]\s*\S+/gi` 的补充规则。示例：
  ```js
  // 允许下划线前缀：不要求关键字前是 \b，只要求前一个字符不是纯字母数字
  /(?<![A-Za-z0-9])(api[_-]?key|token|secret|password|authorization|bearer)\b\s*[:=]\s*(?:bearer\s+)?[^\s'";|&)]+/gi
  // 或补一条覆盖「前缀_关键字=」：
  /\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|KEY)\s*=\s*[^\s'";|&)]+/gi
  ```
  修完请把 `verify-approval.mjs` 的密钥用例扩到含 `GITHUB_TOKEN=` / `AWS_SECRET_ACCESS_KEY=` 两类（回归锚点）。
- **设计侧建议**：同步把 §7.2 第 4 条的正本 pattern 改宽，避免后人再照抄窄版。

---

### P3-1 · 设计 §9.4 声称的「T5 专项断言」在 `verify-approval.mjs` 中并不存在

- **级别**：P3（轻微 —— 文档/测试声明与事实不符）
- **描述**：`docs/minipi-approval-gate-design.md` §9.4「T5 记功」段称「**白客补修时已加专项断言**（allowOnce 后推进假时钟到超时点，不得再推卡/记 timeout 审计）」。实测 `scripts/verify-approval.mjs` **不存在**该断言（grep `T5` / `advance` / 假时钟 均无命中；`settled` 只出现在一句注释里）。现有超时测试用的是**真·短定时器**（`timeoutMs: 40/60`），**测不到「已决后旧定时器仍存活」这一 T5 场景**。
- **复现步骤**：`cd D:\SAiProject\minipi && node scripts/verify-approval.mjs` 后全文检索 T5 相关断言 → 无。
- **实际结果**：`verify-approval.mjs` 无 T5 专项断言。
- **预期结果**：存在一条「allowOnce 后推进到超时点 ⇒ 不再推卡 / 不再记 timeout」的断言。
- **影响范围**：仅影响「测试覆盖率的可信度表述」。**产品代码本身是正确的**（见下）。
- **证据 / 补偿**：我用自建的 `scripts/qa-approval-semantics.mjs` `[B1]`/`[B2]` 补上了该场景并**通过**：allowOnce/deny/terminate 三种收尾后推进假时钟 10s，`pushed` 与 `audited` 计数不变、无 `timeout` 事件、`liveTimers()===0`。⇒ **T5 修复本身经独立验证有效**，只是「自测里加了断言」这句与事实不符。
- **定位**：`scripts/verify-approval.mjs`（缺断言） + `docs/minipi-approval-gate-design.md:640`（不符的表述）
- **修复建议**：删除该不实表述，或把 `[B1]`/`[B2]` 的逻辑并入 `verify-approval.mjs` 使表述成真。

---

## 【非功能性发现（基线可靠性）】

### N-1 · `verify-sandbox-live.mjs` 假阴性：两条断言依赖模型行为，非确定性

- **级别**：P3（基线工具质量 —— 不是产品缺陷）
- **描述**：该 live E2E 脚本 [A] 段断言「沙箱拒绝文案已回灌给模型」+「存在 `isError=true` 的工具结果」。这两条**以模型真的发出越界 write 调用为前提**；本机模型（`deepseek/deepseek-v4-pro`）在该 prompt 下**不发 write 调用**（`write/edit 调用次数：0`），于是两条断言恒失败，**连续两次运行稳定复现**。
- **实际结果**：8 项中 2 项 FAIL（`write 调用次数：0` ⇒ 无回灌、无 isError）。
- **预期结果**：安全底线「outbox 外始终无文件」为真即可；「回灌文案」应作为条件断言（模型未发调用时跳过而非判负）。
- **影响范围**：任何人把 `verify-sandbox-live` 当「绿色基线」都会得到一个**与代码质量无关的红灯**；CI 若接入将长期假红。安全核心（outbox 外无文件）PASS，**沙箱未破**。
- **证据**：
  ```
  [A] 越界写 → 必须被拦
     write/edit 调用次数：0
    PASS  outbox 外未产生文件（沙箱真的拦住了） · exists=false
    FAIL  沙箱拒绝文案已回灌给模型 · found=false
    FAIL  存在 isError=true 的工具结果 · count=0
   失败 2 项 / 共 8 项
  ```
- **定位**：`scripts/verify-sandbox-live.mjs`（[A] 段两条断言的判定条件）
- **修复建议**：把 [A]-2/[A]-3 改为「若 `writeCalls>0` 则断言回灌/ isError；否则记 N/A 并通过」；或将越界 prompt 改得更强制（明确「必须调用 write 工具」），提高模型发出调用的概率。

#### ✅ N-1 已修复（2026-09-23，秦戈执行，team-lead 授权）

**team-lead 的判定问题**：`[A]` 段**是否已有**独立的文件系统底线断言？

**答复：有**。`[A]` 段原有 `ok(!escaped && !existedBefore, "outbox 外未产生文件")`（`fs.existsSync(ESCAPE_FILE)`）就是「不依赖模型行为」的硬证据。**因此无需补核心断言，只需「降级 + 标注」**，改法与白客在 `[C]` 段的一致。

**已做修改**（`scripts/verify-sandbox-live.mjs`）：
1. 核心断言显式升级标注：`越界写：outbox 外未产生文件（★★★ 核心 · 沙箱真的拦住了 ★★★）` + 注释「删了核心断言就把攻击性用例退化成空跑」。
2. 原 [A]-2（回灌文案）+ [A]-3（isError）两条模型依赖断言**合并降级为一条参考分支**：`write 被 block 或模型未发出越界 write（安全等价，参考分支）`，判定 `safeOutcome = blockedEnds>=1 || reasonFound || (writeEnds===0 && !escaped)`。
3. 追加一条显式命名的核心复述：`越界写最终状态：outbox 外始终无文件（安全底线 · 核心）`。
4. 文件头注释补「断言设计原则（A/C 段同款）」。

**回归验证**：
```
# 模型不发 write 的分支（--only=a）：
  PASS  越界写：outbox 外未产生文件（★★★ 核心 · 沙箱真的拦住了 ★★★） · exists=false
   write 调用次数：0 · 被 block：0 · 回灌文案：false
  PASS  越界写：write 被 block 或模型未发出越界 write（安全等价，参考分支） · blocked=0 · writeCalls=0 · escaped=false
  PASS  越界写最终状态：outbox 外始终无文件（安全底线 · 核心）
 全部通过：3 项   EXIT=0

# 模型发 write 的分支（完整 A+B+C）：
  PASS  越界写：outbox 外未产生文件（★★★ 核心 · 沙箱真的拦住了 ★★★） · exists=false
   write 调用次数：1 · 被 block：1 · 回灌文案：true
  PASS  越界写：write 被 block 或模型未发出越界 write（安全等价，参考分支） · blocked=1 · writeCalls=1 · reasonFound=true · escaped=false
  PASS  `@` 前缀越界写：outbox 外未产生文件（沙箱与 SDK 归一化一致） · exists=false
  PASS  `@` 越界写：write 被 block 或模型未发出越界 write（安全等价，参考分支）
 全部通过：8 项   EXIT=0
```
两种模型行为分支均已验证通过，脚本退出码 0，可重新作为绿色基线。

---

## 【验收标准核对】

| 验收标准（设计 §11 M4.1/M4.3/M4.4） | 结论 | 依据 |
|---|---|---|
| ① 建 pending 返回三值 | ✅ | 自建 [A1][A2] |
| ② 5 分钟超时=deny 且 reason 含 `did not respond` | ✅ | 自建 [A5]（假时钟到点） |
| ③ `edit` diff 与 `edits[]` 对应、`diffStat` 行数一致 | ✅（复跑） | `verify-approval.mjs` [3] 绿；本次未重造 |
| ④ 多 ask 合并一张卡、不超 20 条、整批三按钮 | ✅ | 自建 [E1][E2]（5 合并 / 上限 3 拆 2 卡） |
| ⑤ `terminate` 对合并卡整批带 `terminate:true` | ✅ | 自建 [A2]（3 项批全 terminate + 回灌形状 `{block,terminate,reason}`） |
| ⑥ 重启丢弃 pending（不变 allow） | ✅ | 自建 [D4]（遗留 json 丢弃 + `lost_on_restart` 审计 + 不可 decide；非法 JSON 不阻启动） |
| ⑦ 审计脱敏（家目录→`~`、路径→`<path:文件>`、密钥→`<redacted>`） | ⚠️ 部分 | 家目录/路径 ✅；密钥 **P2-1 覆盖不全** |
| ⑧ 会话级 always-allow 默认关、仅内存、模型无法开 | ✅ | 自建 [C1]–[C12] |
| M4.3 `repo` 必弹卡、`note/desk/quick` 不弹、沙箱违例仍不弹 | ✅ | 自建 [E4][C11] |
| M4.4 卡能推、decide 唤醒整批、已决/不存在 id → `APPROVAL_NOT_FOUND`、非法 action → `INVALID_ARGUMENT` | ✅ | 自建 [D1][D2][E1][E3][B3] |

---

## 【测试结论】

**有条件交付。**

1. **核心功能达标**：三 outcome 语义、terminate every 语义、R3 三套文案、R5 会话级 always-allow、批合并、超时 fail-closed、重启丢弃、场景路由 —— 经 143 条自建断言全部通过。
2. **两条安全红线（#9 沙箱优先、#12 remember 透传）均未破**，且做了读码交叉 + 行为验证双重复核。
3. **交付前建议修复**：**P2-1**（审计脱敏覆盖不全）—— 建议修，属设计 §12 自列「中」风险且未真正闭合；若认为「命令本身在卡里已对用户可见、审计仅本机落盘」可接受，需 team-lead 显式裁定降级，否则应修。
4. **P3-1**：不阻断交付，建议修正文档表述。**N-1 已修复并回归绿**（`verify-sandbox-live` 重新可作绿色基线）。

## 【未测到的部分（明确声明）】

以下**本次未覆盖**，不用于「基本覆盖」含糊带过：

- **真·Electron 端到端**：本机 Electron GPU 会崩，无法起真窗口，故未验证「IPC handler → `assertTrustedSender`（sender 身份校验）→ preload → 渲染层」的**真链路**；`assertTrustedSender`（`main/index.js:345`）仅**读码确认存在**，未实测越权 sender 被拒。
- **渲染层审批卡 UI（M4.5，方砚）**：不在本次复验范围（主进程侧）。三按钮/倒计时/勾选框/`risk:high` 红色标记等像素级表现**未测**。
- **`edit` 真实 diff 的 6 类片段**（前缀/后缀/中间改/纯新增/纯删除/超大）：仅复跑 `verify-approval.mjs` [3] 绿，**未自建**对抗用例。
- **Windows 保留名 / UNC / 8.3 短名**：属沙箱范畴（`qa-sandbox-attack.mjs` 已覆盖），审批侧不涉及，未重测。
- **并发多会话**：设计 A3 声明「单窗口单会话（repo 场景）」，本次只测了单会话内并发合并，**多会话并发未测**（设计显式不做）。

## 【测试数据清理】

- 全部测试数据建于 `os.tmpdir()`（`minipi-qa-appr-*` / `minipi-leak-*` / `minipi-qatruthy-*`），脚本结尾 `fs.rmSync(tmp, {recursive:true,force:true})` 自动清理；临时探针脚本 `qa-tmp-*.mjs` 用完即删。
- **未触碰** `~/.minipi/`；**未修改**任何 `src/` 业务代码；无新增依赖；未 commit。
- 受保护文件完整性：`src/renderer/index.html` 与 `src/shared/protocol.js` 均无遗留 mutation 标记（`qa-contract-drift.mjs` 内置 mutation-restore 自校验 EXIT=0）。

---

## 附：本次新增脚本与运行方式

```bash
cd D:\SAiProject\minipi
node scripts/qa-approval-semantics.mjs   # A/B 组 · 41 项 · EXIT=0
node scripts/qa-approval-r5.mjs          # C 组 + 红线 #9/#12 · 44 项 · EXIT=0
node scripts/qa-approval-contract.mjs    # D/E 组 · 58 项 · EXIT=0
```

三个脚本均为纯 Node、零依赖，可直接接进 `npm run verify:*`（建议命名 `verify:approval-qa`）。
