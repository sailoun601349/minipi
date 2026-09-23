# M4.5 渲染层审批卡 UI · 独立 QA 复验报告

> 复验人：秦戈（QA 第三层证伪）
> 日期：见 git log
> 被测对象：`src/renderer/index.html`（方砚交付，唯一产品文件）
> 对照契约：`src/shared/protocol.js`（`ApprovalCard` / `ApprovalBatchItem` JSDoc）、`src/main/pi/approval.js`（`buildBatchItem` / `cardMeta`）

---

## 一、测试范围与方式

| 项 | 说明 |
|---|---|
| 环境 | headless Chrome + CDP（`--headless=new`），mock 模式（`window.__minipi.mock() === true`） |
| 端口 | 9395（与方砚 9393 错开） |
| 测试脚本 | `scripts/qa-approval-ui-independent.mjs`（**我独立构造**，57 断言） |
| 是否复跑方砚 | **否**。未复跑 `qa-approval-ui.mjs` 的 51 项，全部断言由我独立构造 |
| 数据前缀 | 注入卡 `approvalId` 用 `a_*` 前缀（`a_mixed`/`a_u`/`a_exp`…），mock 卡 `a_1`/`a_2`；测后 `cancelAll` 清理 |

**独立构造的验证重点**（对齐 team-lead 六点 A–F，且不重跑方砚 51 项）：

| 组 | 覆盖点 | 断言数 |
|---|---|---|
| A0/A1 | 契约字段逐字对齐（长字段名 typo、kind 三值、渲染层确实消费） | 11 |
| A2 | mixedKind：卡级 kind 只兜底，逐条按 `batch[].kind` 渲染 | 3 |
| A3 | `alwaysAllowEligible:false` 不画勾选框；true 画且默认不勾 | 2 |
| B1 | push/update 就地 upsert、cancel 删除、重复 cancel 幂等 | 5 |
| B2 | 多卡按 approvalId 索引，处理 A 不影响 B | 3 |
| B3 | 超时置灰+disabled+不移除；纵深防御（真实过期未及 tick 也被拦） | 9 |
| C1 | XSS 全向量（title/command/preview） | 3 |
| C2 | `data-approval-action` 来自 `card.actions`，非法值过滤 | 3 |
| D1 | decide 失败（APPROVAL_NOT_FOUND）按钮复位 | 5 |
| D2 | 勾选 always-allow 后点 deny/terminate 不发 `remember:true` | 5 |
| D3 | 畸形卡（空 batch/非数组/字段全缺/超长/非字符串） | 3 |
| E | 补充盲区（update 后勾选框复位、actions=[] 回退、prompt 注入纯文本） | 3 |
| **合计** | | **57** |

---

## 二、执行摘要（回归后）

| 层面 | 用例数 | 通过 | 失败 |
|---|---|---|---|
| 功能（A0–A3 / B1–B4 / D1–D2 / E1–E3） | 44 | 44 | 0 |
| 边界（B3 超时 / D3 畸形卡） | 12 | 12 | 0 |
| 安全（C1 XSS / C2 过滤 / D2 remember 不外泄） | 8 | 8 | 0 |
| **合计** | **59** | **59** | **0** |

> 初验 57 断言：56 PASS / 1 FAIL（P2-UI-1），另发现 P3-UI-1。方砚修复后，脚本补 [B4] 回归断言（59 断言），复跑 **59/0 全绿，EXIT=0 干净退出**。两个缺陷均已闭环。安全红线（M4 主进程侧 #9/#12）本层不涉及，渲染层 XSS 全向量与 remember 外泄均 PASS。

---

## 三、缺陷清单

### P2-UI-1　`actions` 非空但全部非法 ⇒ 渲染 0 个按钮，卡「存在但不可点」（死卡）　✅ 已修复，回归通过

- **描述**：`normalizeApprovalCard` 对 `actions` 的「回退契约镜像三值」只判了「缺失/空数组」，未判「非空但 filter 后为空」。当服务端（或被篡改/损坏的消息）传来 `actions:["allow","evil"]` 这类全非法值时，`filter(a => APPROVAL_ACTION_IDS.includes(a))` 得到 `[]`，卡片正常渲染但**一个按钮都没有**，用户无法做任何决定，只能等超时或服务端 cancel。
- **复现步骤**（脚本 `scripts/qa-approval-ui-independent.mjs`，[C2] 段）：
  1. `node scripts/qa-approval-ui-independent.mjs`
  2. 内部执行 `window.__minipi.injectApproval({ approvalId:"a_allbad", actions:["allow","evil"], ... })`
  3. 读 `#miniBody .approval[data-approval-id="a_allbad"] [data-approval-action]` 数量
- **实际结果**：按钮数 `0`（`[]`）；该卡确实渲染出来（`store.approvals` 含 1 条）。
- **预期结果**：`filter` 后为空应回退 `APPROVAL_ACTION_IDS.slice()`（三值），保证任何渲染出来的卡至少可操作。
- **影响范围**：服务端在正常路径恒发三合法值（`cardMeta` 用 `APPROVAL_ACTION_IDS`），故常规操作不可达；仅当服务端有 bug、消息损坏或未来引入自定义 action 集合时触发。触发后用户面对一张「可看不可点」的卡，属静默功能失效。
- **证据**：
  ```
  FAIL  [C2b] actions 全非法 ⇒ 退回契约镜像三值（**当前为空 ⇒ 缺陷**）  · []
  PASS  [C2b] 该卡确实渲染出来（但无按钮可点）  · true
  PASS  [C2] actions=[]（空数组）⇒ 退回契约镜像三值  · ["allowOnce","deny","terminate"]
  ```
- **定位**：`src/renderer/index.html:1690-1692`
  ```js
  actions: Array.isArray(card.actions) && card.actions.length
    ? card.actions.filter((a) => APPROVAL_ACTION_IDS.includes(a))   // ← filter 后为空未回退
    : APPROVAL_ACTION_IDS.slice(),
  ```
- **修复建议**：
  ```js
  actions: (() => {
    const a = Array.isArray(card.actions)
      ? card.actions.filter((x) => APPROVAL_ACTION_IDS.includes(x))
      : [];
    return a.length ? a : APPROVAL_ACTION_IDS.slice();
  })(),
  ```
- **修复状态**：方砚已修（`normalizeApprovalCard` 增加 filter 后为空回退）。回归证据（`node scripts/qa-approval-ui-independent.mjs`）：
  ```
  PASS  [C2b] actions 全非法 ⇒ 回退契约镜像三值（已修复：不再空按钮）  · ["allowOnce","deny","terminate"]
  PASS  [C2b] 该卡渲染且含三按钮可操作  · true
  ```

### P3-UI-1　点「大窗副本」按钮时，deciding 态打错副本（被点副本无反馈，可连点）　✅ 已修复，回归通过

- **描述**：`doApprovalDecide` 里定位卡片的 `box` 选择器是 `document.querySelector('.approval[data-approval-id=…]')`，**未限定 `#miniBody`**。审批卡按设计在 `#miniBody` 与 `#fullTree` 各渲染一份（`appendApprovalCards` 两处调用）。点击处理器挂在 `document`（`:2903`），两份副本都可点；但点 `#fullTree` 副本时，`querySelector` 命中的是 DOM 顺序更靠前的 `#miniBody` 副本，于是 deciding/disabled 加到了 mini 副本，**被点的 full 副本毫无反馈**。
- **复现步骤**（已用一次性诊断脚本实证，脚本已删）：
  1. mock 生成一张卡（`[data-mock="approval-edit"]`）
  2. 对 `#fullTree` 副本的 `[data-approval-action="allowOnce"]` 派发 `click`
  3. 读两份副本的 `approval--deciding` 与按钮 `disabled`
- **实际结果**：
  ```
  点 full 副本后 = {"miniDeciding":true,"miniBtnDisabled":true,"fullDeciding":false,"fullBtnDisabled":false}
  ```
- **预期结果**：被点击的 full 副本自身进入 deciding/disabled，或至少两份同步。
- **影响范围**：大窗（full）视图下用户点击审批按钮无任何按压反馈，且按钮未禁用 → 可快速连点，触发两次 `host.approvalDecide`（`doApprovalDecide` 无重入保护；第二次 mock reject `APPROVAL_NOT_FOUND`、真实服务端幂等删除后第二次也报「不存在」）。属反馈错位 + 轻微重复提交，非安全/数据问题。
- **定位**：`src/renderer/index.html:1822`
  ```js
  const box = document.querySelector(`.approval[data-approval-id="${cssEscape(approvalId)}"]`);
  ```
- **修复建议**：点击处理器已能拿到被点元素（`:2975` `apAct.closest('.approval')`），可将 `box` 一路传入 `doApprovalDecide`，或在此处改用 `apAct.closest('.approval')` 得到的真实卡片节点；至少应限定为实际被点的视图副本。
- **修复状态**：方砚已修（`doApprovalDecide` 增加第 4 参 `boxEl`，点击处理器 `:2986` 传入 `apAct.closest('.approval')`）。回归证据（脚本新增 [B4] 段）：
  ```
  PASS  [B4] 点 full 副本 → 被点 full 副本进入 deciding + 按钮 disabled（P3-UI-1 已修复）  · {"fullDeciding":true,"fullBtnDisabled":true}
  ```

### 附注（非缺陷，供方砚/team-lead 知悉）

- `approvalOverflow` 探针（`index.html:3953-3959`）用**卡级** `scrollWidth` 判溢出，会因卡内 `<pre>{overflow:auto; white-space:pre}` 内部横向滚动而误报 `overflows:true`。实测 `pageHScroll:false`、`docScroll.sw===cw`（页面无横滚）。建议该探针改为判「页面级横滚」或「pre 是否被裁剪」，避免后续回归脚本追一个假阳性。

---

## 四、验收标准核对

| 验收点（team-lead A–F） | 结论 | 依据（独立构造的断言） |
|---|---|---|
| A 契约字段逐字对齐 | **PASS** | [A1] 全部卡级/条目字段名 present，无 `alwaysAllowElegible`/`tooLargeToDiff`/`diffStat` typo，kind 三值服务端↔渲染层一致 |
| B mixedKind 逐条渲染 | **PASS** | [A2] 卡级 kind=write 但第二条 command → 命令原文可见、preview 可见，未漏渲 |
| B `alwaysAllowEligible:false` 不画勾选框 | **PASS** | [A3] false→无勾选框；true→有且默认不勾 |
| C 三态竞态（upsert/cancel/幂等/多卡索引） | **PASS** | [B1] update 同 id 不新增、标题替换；cancel 删除；重复 cancel 不崩；[B2] 处理 A 后 B 仍在 |
| D 超时交互（置灰+disabled+不移除） | **PASS** | [B3] 到 0 卡片仍在、`.approval--expired`、三按钮+勾选框全 disabled、文本「已超时」、cancel 才移除；纵深防御二次拦截 PASS |
| E 安全（textContent / actions 过滤） | **PASS** | [C1] 8 类 XSS 载荷无执行、无 on* 属性、无注入 script/iframe/svg；[C2] 非法值过滤 PASS、[C2b] 全非法→回退三值（P2-UI-1 已修复） |
| F 自设边界（decide 失败复位 / remember 不外泄 / 畸形卡） | **PASS** | [D1] 失败后 `.approval--deciding` 移除、按钮复位可重试、toast 可读；[D2] deny 不带 remember（toast 无「本会话总是允许」）、对照 allowOnce 带 remember；[D3] 8 张畸形卡不抛错、缺 id 卡被忽略、超长不造成页面横滚 |
| G 副本定位（full 副本 deciding 打到被点副本） | **PASS** | [B4] 点 full 副本 → full 副本进入 deciding + disabled（P3-UI-1 已修复） |

**我复跑方砚的**：无（0 项）。全部 59 断言独立构造（初验 57 + 修复后补 [B4] 回归 2 条）。

---

## 五、测试结论

**可以交付（回归通过）。**

- 渲染层审批卡 UI 的契约对齐、三态状态机、超时交互、XSS 防护、remember 不外泄、畸形卡容错、full 副本定位均验证通过（**59/59，EXIT=0**）。
- 初验发现的 **P2-UI-1**（空按钮死卡）与 **P3-UI-1**（full 副本 deciding 错位）均已被方砚修复，回归断言 [C2b]/[B4] PASS。
- 未覆盖（同方砚声明，不重复声明）：真 IPC 往返 / 真 shell 执行 / 真服务端超时。本复验未引入新的盲区。

---

## 附：复现命令

```bash
# 独立复验（回归后 59/0，EXIT=0 干净退出）
node scripts/qa-approval-ui-independent.mjs
```

> ⚠ headless Chrome 串行运行，勿与 `qa-approval-ui.mjs` / `qa-renderer-edge.mjs` 并行（并行会 SIGTERM）。
