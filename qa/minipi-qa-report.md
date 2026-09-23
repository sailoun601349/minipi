# minipi 开发前产物质量验证报告

> 测试人：测试工程师 秦戈
> 被测对象：`docs/minipi-plan.md`（基准 v0.2）、`docs/minipi-audit.md`（待验证）、`prototype/minipi-prototype.html`（待验证）
> 验证性质：**找茬**，不是复述他人结论
> 测试时间：2026-09-22
> 本轮未修改任何被测文件（见文末「文件完整性证据」）

---

## 【测试范围】

| 项 | 内容 |
|---|---|
| 被测功能 | ① 审计结论真实性（19 条 C + 8 条 P0 + R1–R5）；② 原型自包含性 / 交互可用性 / 与文档一致性 / 可访问性 / 隐私；③ 审计技术风险核查的事实性 |
| 环境 | Windows；Node.js v22.22.2；npm 10.9.7；Google Chrome（`C:\Program Files\Google\Chrome\Application\chrome.exe`）；**本机 bash 缺 `ls`/`dirname`/`mkdir`/`head`，全部改用 PowerShell 与 Node** |
| 渲染方式 | 真实 Chromium（headless=new）＋ CDP（`Runtime.enable` / `Log.enable` / `Network.enable` / `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` / `Input.insertText`），**用真实鼠标/键盘事件点击，并在每次点击前用 `document.elementFromPoint` 校验是否被遮挡** |
| 测试账号 | 不适用（原型无后端、无鉴权，无 token 场景） |
| 测试数据 | 输入串使用 `pretest_` 前缀（`pretest_测试问题`、`pretest_回车发送`），仅存在于页面内存，未落盘 |

**测试脚本与原始证据**（未写入项目目录）：
```
%TEMP%\minipi_qa\
├─ cdp.js / page.js              # 自建 CDP 驱动（真实鼠标·键盘·遮挡校验）
├─ run_load.js                   # 加载与控制台报错采集
├─ run_interactions.js           # 64 项交互用例
├─ run_diag.js                   # 修正断言后的 31 项 + 布局/可访问性
├─ run_final.js                  # 8 项最终确认 + 截图
├─ run_layout.js                 # 4 种分辨率的布局测量
├─ analyze.js                    # 文档分析 / 对比度 / 隐私扫描
├─ pi/                           # npm pack 解包后的 @earendil-works/pi-coding-agent@0.87.0
└─ *.png / *.json                # 截图与结果
```
复现命令：`node run_load.js` / `node run_diag.js` / `node run_final.js` / `node run_layout.js` / `node analyze.js`（在 `%TEMP%\minipi_qa` 下执行）。

---

## 【执行摘要】

| 层面 | 用例数 | 通过 | 失败 |
|---|---|---|---|
| 功能（原型交互，真实点击） | 47 | 45 | **2** |
| 边界（空/加载/错误/超长视口/裁剪/极端分辨率） | 12 | 9 | **3** |
| 安全（自包含·隐私·越权面） | 9 | 8 | 1（右键无行为，非安全） |
| 文档一致性（审计 19 条 C 逐条回原文） | 19 | 15 成立 | 3 部分成立 / **1 误报** |
| 审计漏报补遗（原文矛盾与缺口） | — | — | **补 9 条（N1–N9）** |
| 事实核查（Electron / SDK / npm / 版本生命周期） | 8 | 5 成立 | 2 部分准确 / 1 未能核实 |

**运行时错误：0 条**（`Runtime.exceptionThrown` 0、`console.error` 0、`Log.entryAdded(level=error)` 0）。
**外部网络请求：0 条**（Network 域仅记录到 `file:///…/minipi-prototype.html` 自身，1 条 Document）。

---

## 【缺陷清单】

### P0（阻断，必须修）

---

**P0-1｜方案 §3.3 的闸门位置建立在一个可被证伪的错误前提上：Pi SDK 官方提供 `tool_call` 前置钩子，而原文写「Pi 没有这个钩子」**

- **描述**：`docs/minipi-plan.md:158` 写「不放渲染进程（可被绕过），**不放 Pi 内部（Pi 没有这个钩子）**，而是放在 `packages/core` 的工具注册层」。实测 `@earendil-works/pi-coding-agent@0.87.0` **明确提供**在工具执行前触发、**可以阻断**、**可以改参数**的一等钩子，并自带一份实现同样需求的官方示例。
- **证据**：
  ```
  # pi/package/dist/core/extensions/types.d.ts:1014
  on(event: "tool_call", handler: ExtensionHandler<ToolCallEvent, ToolCallEventResult>): () => void;

  # 同文件 784-790
  /** Fired before a tool executes. Can block.
   *  `event.input` is mutable. Mutate it in place to patch tool arguments before execution. */
  export type ToolCallEvent = BashToolCallEvent | PowerShellToolCallEvent | ReadToolCallEvent
      | EditToolCallEvent | WriteToolCallEvent | GrepToolCallEvent | FindToolCallEvent | LsToolCallEvent | …

  # 同文件 887-896
  export interface ToolCallEventResult {
      /** Block tool execution. To modify arguments, mutate `event.input` in place instead. */
      block?: boolean;
      reason?: string;
      /** Hint that the agent should stop after the current tool batch when this call is blocked. */
      terminate?: boolean;
  }
  ```
  官方示例 `pi/package/examples/extensions/permission-gate.ts` 全文即为审批闸门：
  ```ts
  pi.on("tool_call", async (event, ctx) => {
      if (event.toolName !== "bash") return undefined;
      const command = event.input.command as string;
      if (dangerousPatterns.some(p => p.test(command))) {
          if (!ctx.hasUI) return { block: true, reason: "Dangerous command blocked (no UI for confirmation)" };
          const choice = await ctx.ui.select(`⚠️ Dangerous command:\n\n  ${command}\n\nAllow?`, ["Yes", "No"]);
          if (choice !== "Yes") return { block: true, reason: "Blocked by user" };
      }
      return undefined;
  });
  ```
  另有 `examples/extensions/confirm-destructive.ts`、`examples/extensions/protected-paths.ts`、`examples/extensions/tool-override.ts`、`dist/core/extensions/types.d.ts:1016 on("user_bash")`、`1074 setActiveTools(toolNames)`。
- **影响**：§3.3 自称「本方案改动最大的一节」，其实现路线（自建 `defineTool` 包装层 + 依赖「`execute` 返回未 resolve 的 Promise 恰好暂停 agent」）是**可替代的、且更脆的一条路**。审计 R3（是否需要 spike 工具超时／并发／整轮 abort）、P0-08（闸门如何聚合并发 ask）**全部是自选路线带来的不确定性**，不是 SDK 的限制。照原方案开工，M4 会做出一套重复造轮子、且依赖未文档化行为的闸门。
- **复现**：`npm pack @earendil-works/pi-coding-agent && tar -xzf *.tgz`，然后 `grep -n "tool_call" package/dist/core/extensions/types.d.ts` 与 `cat package/examples/extensions/permission-gate.ts`。
- **修法建议**：§3.3 重写一节「闸门位置」，改为 `pi.on("tool_call", async (event, ctx) => …)`，在 handler 内 `await bridge.requestApproval(...)`（等待即暂停，官方示例已验证这一用法）；拒绝时 `return { block: true, reason: "…" }`；需要按策略改参数时直接改 `event.input`。同步下调审计 R3、P0-07、P0-08 的严重度，并把 P0-01 的「审批契约」改成「把 `ctx.ui` 换成 bridge 的 WS 审批推送」。

---

**P0-2｜审计建议把 Electron pin 到「33/34 LTS 线」，而 Electron 没有 LTS，且 33/34 早已 EOL**

- **描述**：`docs/minipi-audit.md:42` 的【技术选型】写「宿主 **Electron（pin 到具体版本，建议 33/34 LTS 线）**」。Electron 官方不存在「LTS 线」；且按官方支持策略，33/34 已分别于 2025-04-29、2025-06-24 结束支持。
- **证据**：
  ```
  # 官方支持策略（https://www.electronjs.org/docs/latest/tutorial/electron-timelines/）
  "Electron's official support policy is the latest 3 stable releases."
  "Electron's cadence between major version releases is 8 weeks long."

  # 官方发布时间表（https://releases.electronjs.org/schedule）
  34.0.0  stable 2025-01-14   EOL 2025-06-24
  33.0.0  stable 2024-10-15   EOL 2025-04-29

  # 第三方生命周期页（https://endoflife.date/electron，2026-09-19 更新）
  44 M152 稳定 2026-08-25  支持至 2027-03-02   最新 44.4.3（2026-09-18）
  43 M150 稳定 2026-06-30  支持至 2027-01-05
  42 M148 稳定 2026-05-05  支持至 2026-10-20
  41 已于 2026-08-25 结束支持
  长期支持周期：0
  ```
- **影响**：任何按此建议执行的动作都会把项目锁死在**不再接收安全补丁**的运行时上（安全漏洞类）。该建议写在「理由」栏，极易被下游当作结论采纳。这也是「开发前必须定」的选型事实错误。
- **复现**：打开 `releases.electronjs.org/schedule` 与 `endoflife.date/electron` 对照。
- **修法建议**：删掉「LTS」；改为「pin 到当前受支持的三条线之一（现为 44.x），并在 M0 前用该版本跑一次透明窗口 resize spike」。审计第 42 行的「注意 E27+ 的窗口 resize/白闪回归」中的 `E27+` 非标准写法，且找不到对应官方来源，应删除或替换为可追溯的 issue 链接。

---

**P0-3｜Pi SDK 是 ESM-only 且要求 `node >= 22.19.0`；方案 §11 写成「node -v ≥ 20」，方案与审计均未提模块格式约束**

- **描述**：方案 `docs/minipi-plan.md:430` 的环境前置是「本机 `node -v` ≥ 20，且能 `npm i @earendil-works/pi-coding-agent`」。实测 SDK 最新版 `engines` 要求 `>=22.19.0`，且包为纯 ESM（`"type":"module"`，`exports` 只给 `import`，无 `require` 分支）。这直接约束了 §7.1「Electron 主进程天然是 Node，可直接 `import` Pi SDK」与 §7.2 的工程结构。
- **证据**：
  ```
  # pi/package/package.json
  "name": "@earendil-works/pi-coding-agent", "version": "0.87.0"
  "type": "module"
  "engines": { "node": ">=22.19.0" }
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
               "./rpc-entry": { "import": "./dist/bundle/rpc-entry.js" },
               "./client": { "source": "./src/client/index.ts" },
               "./experimental/plugin": { "source": "./src/experimental/plugin.ts" } }

  # npm dist-tags
  { "latest": "0.87.0", "legacy-node20": "0.74.2" }
  ```
  `dist/index.d.ts` 的导出以 `.ts` 后缀内部引用（`from "./cli/args.ts"`），说明它是 ESM/TS 直发构建。
- **影响**：① 环境前置写错——`≥ 20` 只对 `0.74.2` legacy 线成立；② Electron 主进程要 `import` 这个包，主进程与打包链路必须走 ESM（Electron 28+ 才支持 ESM 主进程，且 `require` 混用有约束），这一条会反向决定 Electron 版本下限与构建方案。审计只把「pin 版本号」列为 P0-03，没有发现这两条硬约束。
- **复现**：`npm view @earendil-works/pi-coding-agent engines type exports --json`。
- **修法建议**：§11 改为「Node ≥ 22.19（SDK 0.87.0 的 `engines`）」；§7.2 增补「主进程 ESM」约束与打包方案（renderer 走 Vite 不受影响，main 进程需确认 Vite/electron-builder 的 ESM 输出）；审计 P0-03 的「pin 版本号」补上版本约束矩阵。

---

### P1（严重，开发前必须定）

---

**P1-1｜§3 对 `preflightResult` 的理解与实际签名不符：它是 RPC 模式的内部钩子，且只给 `success: boolean`，拿不到「接受/排队/被拒」三态**

- **描述**：`docs/minipi-plan.md:116` 写「用 `preflightResult` 回调拿「接受/排队/被拒」，UI 立刻给反馈」。实际该回调在类型注释里被官方标为 **Internal**，参数只有一个布尔。
- **证据**：
  ```
  # pi/package/dist/core/agent-session.d.ts:162-166（PromptOptions 内）
  /** Internal hook used by RPC mode to observe prompt preflight acceptance or rejection. */
  preflightResult?: (success: boolean) => void;
  ```
  对照参考：官方另有 `queue_update` 事件类型（plan:106 的事件清单里就有），排队态应从事件流取，而非从这个回调取。
- **影响**：M0-2／§3.1 的 `/prompt` 契约（审计已补为 `{ accepted, queuePosition, preflight }`）里「排队位置」在方案指定机制下拿不到；照 §3 实现会在 M0 就撞墙。
- **修法建议**：`preflightResult` 只用于二元的成功/失败反馈；`queuePosition` 改由 `queue_update` 事件推导；将该设计写进 `packages/core/pi/adapter` 的注释。审计 P0-03 的结论应由「未核实」改为「已核实：8/8 API 存在，1 处偏差（本条）」。

---

**P1-2｜§5 长任务状态表实际是 **7 行**，但正文与审计共 5 处写成「六级」；原型按 7 级实现（原型是对的）**

- **描述**：任务指定要回原文数清 §5 表行数。实测 **7 行数据行**，而 `docs/minipi-plan.md:379`、`409` 与 `docs/minipi-audit.md:25`、`232`、`284` 均写「六级」。
- **证据**：
  ```
  # 脚本对 §5 表格（plan 行 261–282 区间）的统计
  §5 表数据行数 = 7
  行标题 = ["0–300ms","首字到达","工具调用中","**等审批**","**超过 8s**","完成","超时/失败"]

  # plan:379（§8 M3）   §5 的六级状态表；8s 自动升级；工具调用卡片；中断/重试；成本显示。
  # plan:409（§9 风险）| **长任务让人以为死了** | … | §5 的六级状态 + 8s 自动升级 + 订阅 `auto_retry_*` 并显示 |
  # audit:25           长任务六级呈现、8s 自动升级、成本显示
  # audit:232          | M3-1 | 六级状态呈现 | UI | 提交后 300ms 内出现「思考中」脉冲，不等首字 |
  # audit:284          9. 长任务像死机 → 六级状态 + 8s 自动升级。

  # 原型实测渲染级数 = 7（0…6），与表格一致
  node run_load.js → stepsCount: 7
  ```
- **影响**：M3-1 的验收口径写的是「六级」，若开发照审计实现，会漏掉 1 级（最可能漏掉「等审批」或「超时/失败」——正是安全与失败反馈最关键的两级）。而 M3-1 的验收标准只测了第 0 级（300ms 脉冲），无法暴露漏级。
- **修法建议**：把 plan:379、plan:409 的「六级」改为「七级」；审计 M3-1 改为「七级状态呈现」并逐级写验收。此条属**审计漏报**（见 N1）。

---

**P1-3｜§5 表内部冲突：「等审批 → 不自动升级」与「超过 8s → 自动升级」没有优先级或暂停规则，审计漏报**

- **描述**：`plan:274`（等审批行）明确「**不自动升级**（决定权在你，但入口必须显眼）」；`plan:275`（超过 8s 行）无条件写「**自动从小窗升级为大窗**（带提示「任务较久，已展开」）」。审批默认超时是 5 分钟，因此「等待审批超过 8s」是**常态**，两条规则必然同时命中。
- **证据**：
  ```
  # plan:274
  | **等审批** | 小窗顶部挂一条醒目横幅「⚠ 等待你确认 1 个操作 → 展开」，球变黄；**不自动升级**（决定权在你，但入口必须显眼） | §3.3 的审批请求 |
  # plan:275
  | **超过 8s** | **自动从小窗升级为大窗**（带提示「任务较久，已展开」），露出工具时间线与进度 | 计时器 |
  # plan:206（§3.3 失败模式 2）
  2. **审批超时**（默认 5 分钟）→ **默认拒绝**
  ```
  原型同样未处理该分支：`minipi-prototype.html:999-1007` 的 `STEPS` 是 0–6 的互斥级别，`1662-1675` 只有 `n===4` 强制升级、`n===3` 强制 `mini`，没有「审批期间暂停 8s 计时器」的代码。
- **影响**：M3-3（8s 自动升级）与 M4-6（未决审批持久化）的验收会互相打架；实现者只能自行拍板，事后必返工。
- **修法建议**：在 §5 增一条规则：「处于『等审批』期间，8s 计时器暂停；审批被处理后重新计时」；审计 P1-06（8s 计时起点）并入本条。

---

**P1-4｜原型在形态切换时重置并重放流式回答，直接违反 §4.1「不重连、不清空、不重放」不变量，且界面文案谎称「流不中断」**

- **描述**：§4.1 实现要求 2 与 §1 难点 1 的不变量是「形态切换不重连 WS，只改渲染范围与窗口尺寸」「不重连、不清空、不重放」。原型在 `setMode()` 里调用 `stopStream()`，`render()` 重建 `#miniBody` 后又在 `bindInner()` 里从头 `startStream()`，因此每次放大/收起都会把回答**从第一个字重新流一遍**。
- **证据**：
  ```
  # 实测（run_diag.js / D8-replay）
  放大前  len=135「，这正是书本省略的前提。」
  → 放大后 len=36 「定梯度方向，而二阶项的系」
  → 收起后 len=36 「定梯度方向，而二阶项的系」
  → 1.2s后 len=135「，这正是书本省略的前提。」
  # 第一次交互脚本（run_interactions.js / T04-no-replay）独立复现：94 → 24 → 106

  # 代码定位
  minipi-prototype.html:1631-1637  setMode(){ … stopStream(); … render(); }
  minipi-prototype.html:1598        if (state.level === 1 && $('#streamOut')) startStream();
  minipi-prototype.html:1607-1613   startStream(){ stopStream(); var out=$('#streamOut'); var i=0; out.textContent=''; … }
  # 而 UI 文案声称相反：
  minipi-prototype.html:1830  toast('已放大 · 流不中断（同一会话、同一 seq，不重连）')
  minipi-prototype.html:1831  toast('已收起 · 流不中断（回答还在继续写）')
  ```
- **影响**：前端会以这份原型为交互基线。若不修，「放大后回答重头再来」会被当成预期行为实现；而这条不变量正是整个方案的头号技术难点（§1 难点 1「两张皮」）。
- **修法建议**：把流式状态提到 `setMode()` 之外（例如用 `state.streamText` 持有已渲染文本，`render()` 只投影），或在形态切换时不重建 `#miniBody`。同时把 toast 文案改为与实际一致。审计未审原型，此条为新发现。

---

**P1-5｜审计 R2 把官方限制绝对化为「透明窗口不可 resize」，与官方原文的限定不符**

- **描述**：审计 `minipi-audit.md:276、384、438` 三处断言「官方明确：transparent 窗口不可 resize」，并据此判「§4.3 的推荐方案不成立」。原文那句话存在，但**语境是用户拖拽缩放（`resizable` 选项）**，且带两个限定词（`may`、`on some platforms`），并未禁止程序化 `setBounds`。
- **证据（官方原句，逐字）**：
  ```
  # https://www.electronjs.org/docs/latest/tutorial/custom-window-styles → Limitations
  - You cannot click through the transparent area. See #1335 for details.
  - Transparent windows are not resizable. Setting `resizable` to true may make a transparent
    window stop working on some platforms.
  - The CSS blur() filter only applies to the window's web contents, …
  - The window will not be transparent when DevTools is opened.
  - On Windows:
    - Transparent windows will not work when DWM is disabled.
    - Transparent windows can not be maximized using the Windows system menu or by double clicking
      the title bar. The reasoning behind this can be seen on PR #28207.
  - On macOS: The native window shadow will not be shown on a transparent window.
  ```
- **结论（准确表述）**：官方说的是「透明窗口**不可（用户）缩放**；把 `resizable` 设为 `true` **可能**在某些平台让它失效」。官方**没有**禁止 `setBounds`/`setSize` 程序化改尺寸；与 Windows 相关的两条官方限制是「DWM 关闭时透明失效」和「**不能通过系统菜单或双击标题栏最大化**」。**后一条比审计引用的那条更直接命中「三态变形要最大化」的场景，审计反而漏了。**
- **影响**：R2 的结论「与官方限制正面相撞」把风险夸大了一档，可能误导团队直接放弃单窗口方案（而单窗口是 §4.3 的推荐）。正确结论应是「需要 spike」，不是「倾向不成立」。
- **修法建议**：R2 改为「官方限制的是 `resizable`，措辞为 may/on some platforms；程序化 `setBounds` 是否掉透明必须实测；另需实测 Windows 下透明窗口能否用 `maximize()` API（官方只禁止了系统菜单/双击标题栏两条路径）」，并在 spike 清单里加上这两项。

---

**P1-6｜审批卡的动作按钮集合与 §3.3 不吻合：缺「中断整轮（aborted）」，多了审计判「默认不做」的「本会话总是允许」**

- **描述**：§3.3 的闸门分支只有三个 outcome——`approved` / `aborted`（`throw new Error("User aborted")`）/ `denied`（回一条 tool result）。原型四张审批卡的动作分别为「允许一次 / 拒绝 / 本会话总是允许」与「全部允许 / 只允许勾选项 / 全部拒绝」，**没有任何一张卡提供「中断整轮」**。
- **证据**：
  ```
  # 实测（run_final.js / F4-card-actions）
  {"edit":["允许一次","拒绝","本会话总是允许"],
   "write":["允许一次","拒绝","本会话总是允许"],
   "bash":["允许一次","拒绝","本会话总是允许"],
   "batch":["全部允许","只允许勾选项","全部拒绝"]}

  # plan:174-177  §3.3 的三个分支
  if (outcome === "approved")  return tool.execute(...);
  if (outcome === "aborted")   throw new Error("User aborted");
  return { content: [{ type: "text", text: "The user denied this action. Do not retry it; …" }] };

  # plan:413  「记住『本会话对该命令前缀的批准』（可选，谨慎）」
  # audit:338 | **P2-03** | 「本会话对该命令前缀的批准」是否要做 | … | 默认不做，等审批疲劳实测后再定 |
  # 原型的 MAP 却把它标注为 §3.3：
  minipi-prototype.html:1074  { ui: '…<b>合并卡</b>：…逐个勾选 + 全部允许 / 只允许勾选项', tag: '§3.3 节奏控制' }
  ```
- **影响**：审批卡是本项目风险最高、用户信任最敏感的组件；按钮语义定错，M4 的协议与 UI 都要返工。另外「本会话总是允许」是把审计明确判为「默认不做」的可选项提前引入，且没有任何「记住命令前缀」的规则定义（§9 只说「谨慎」）。
- **修法建议**：审批卡动作固定为「允许一次 / 拒绝 / 中断整轮」，并把「本会话总是允许」列为设置项（默认关，对应唯一的前缀匹配规则需另行定义）；合并卡保留「全部允许 / 只允许勾选项 / 全部拒绝」，但要补一句「未勾选项按拒绝处理」的语义（原型已写，原文没有）。

---

### P2（一般问题）

---

**P2-1｜审计 C18 是误报：§2 的「会话多路复用」讲的是 session↔场景 映射，不是 WS 连接粒度**

- **描述**：审计 `C18` 称「§2 说会话多路复用（一个 bridge 多会话），§3.1 的 `WS /stream?sessionId=…` 是单会话连接」构成冲突。回原文：§2 的该句是「会话多路复用：一个 Pi AgentSession ↔ 一个「场景」」——它在定义 **session 与 scene 的基数关系**，与一条 WS 承载几个 session 无关；§3.1 也没有任何「一条 WS 只能承载一个会话」的表述。
- **证据**：
  ```
  # plan:72
  │   · 会话多路复用：一个 Pi AgentSession ↔ 一个「场景」
  # plan:128
  WS   /stream?sessionId=…&sinceSeq=N
  ```
- **影响**：误报会让开发去改一处本来没有矛盾的地方；审计的 19 条里因此有 1 条不可用，清单的「19 条全部成立」不成立。
- **修法建议**：把 C18 从「矛盾」降级为「P2 缺口：§3.1 未说明连接与 session 的基数关系、是否支持一条连接订阅多会话」，并保留审计提议的「单连接可订阅多个 sessionId」作为接口设计建议（不要写成「修正原文矛盾」）。

---

**P2-2｜原型的球右键菜单不可用：右键被 `preventDefault()` 吞掉且不弹任何菜单，只有 hover 才显示**

- **描述**：§4.1 要求 Ball 有「右键菜单（新会话 / 隐藏 30 分钟 / 打开大窗 / 退出）」。实测右键后菜单 `display:none`；代码里只有 `e.preventDefault()`，没有打开菜单的逻辑，菜单靠 CSS `:hover` 显示。
- **证据**：
  ```
  # 实测（run_interactions.js / T02-rightclick）
  右键后 #ballMenu display = "none"，宽度 0
  # 实测 / T02-hover → display: block（悬停可用）

  # 代码定位
  minipi-prototype.html:1986  $('#ball').addEventListener('contextmenu', function(e){ e.preventDefault(); });
  minipi-prototype.html:255-256  .ballwrap:hover .ballmenu, .ballwrap:focus-within .ballmenu{ display:block; }
  minipi-prototype.html:782   <div class="ballmenu__hint">右键菜单示意（原型中悬停即可看到）</div>
  ```
- **影响**：用户右键会得到「完全无反应」（原生菜单也被吞掉），这是验收项「右键菜单」实质未覆盖。原型自己标注了这点，但仍是一个真实的交互缺口。
- **修法建议**：加 `contextmenu` 处理打开 `#ballMenu`（并补 Esc/点击空白关闭）；或至少保留原生右键菜单，不要静默吞掉。

---

**P2-3｜原型的错误态文案假设了 sidecar 与「端口文件」，与已定架构（Electron 主进程同进程）冲突，而审计 C12 已判该描述应删除**

- **描述**：原型错误态写「连接失败：bridge 未响应（**端口文件未找到**）」「可能原因：Pi 进程未启动 / **随机端口被占用**」。§7.1 已选 Electron 同进程、审计 C12 明确要求「删掉端口文件/僵尸进程描述（那是 Tauri 才需要的）」，原型却把它写进了用户可见文案。
- **证据**：
  ```
  minipi-prototype.html:1164  '<p …>连接失败：bridge 未响应（端口文件未找到）</p>'
  minipi-prototype.html:1166  '可能原因：Pi 进程未启动 / 随机端口被占用。…'
  minipi-prototype.html:1812  doCopy('bridge 未响应：找不到端口文件。sessionId=s_demo, lastSeq=1043', …)
  # 实测（run_final.js / F6-error-copy）确认该文案已渲染
  # 对照：audit:362 C12「删掉端口文件/僵尸进程描述（那是 Tauri 才需要的）」
  ```
- **影响**：错误文案会先于实现被固化；也会向用户暴露一个本项目不该存在的基础设施概念。
- **修法建议**：改为「bridge 未响应（主进程未就绪 / 会话初始化失败）」，去掉端口与进程相关表述。

---

**P2-4｜原型 study 场景的「权限」文案包含 `edit`，与 §3.2 的 study 工具集（无 `edit`）自相矛盾**

- **描述**：§3.2 规定 `study` 工具为 `read`/`write`/`grep`/`find`/`ls`（不含 `edit`）。原型左侧场景表的 study「权限」行却写「可写 —— **write / edit** 必须逐次确认」，而同一份原型的 edit 审批卡又注明「edit 只在 work 场景存在」。
- **证据**：
  ```
  # 实测（run_final.js / F7-study-perm）
  场景表 = cwd | ~/minipi/study | 工具 | read · write · grep · find · ls | 会话 | 持久化，按主题 |
           权限 | 可写 —— write / edit 必须逐次确认
  # 代码定位
  minipi-prototype.html:987   perm: '可写 —— write / edit 必须逐次确认'
  minipi-prototype.html:1384  '注意：<code>edit</code> 只在 work 场景存在——§3.2 里 study 的工具集是 read/write/grep/find/ls，不含 edit（审计矛盾 C6，需拍板）。'
  ```
- **影响**：原型内部前后不一致，评审时容易被当作「study 其实有 edit」的证据。
- **修法建议**：`:987` 改为「write 必须逐次确认（study 无 edit / bash）」。

---

**P2-5｜§4.1 声明 Mini「可贴边、可吸附、可调宽」，但 M0–M6 无任何任务与验收覆盖（审计漏报）**

- **描述**：`plan:66` 与 `plan:229` 把「可贴边、可吸附、可调宽」写成 Mini 的既有能力，但 §8 里程碑里 M1 只有「位置记忆」，审计 M1-4 同样只有「位置记忆」。原型拖动后自己也提示「贴边 / 吸附 / 调宽尚未实现」。
- **证据**：
  ```
  plan:66   │    · Mini 小窗      (frameless, always-on-top, 360×480, 可拖/贴边/变形)
  plan:229  | Mini | … | `Enter` 发送 / `Shift+Enter` 换行 / `Esc` 收起；可贴边、可吸附、可拖动、可调宽 |
  plan:371  **M1 · 单窗口三态（1–2 天）** … 位置记忆。
  audit:217 | M1-4 | 位置记忆 | UI | 拖动后重启 App，球出现在上次的位置 |
  minipi-prototype.html:1994  toast('小窗位置已记忆（贴边 / 吸附 / 调宽尚未实现）')
  ```
- **影响**：文档承诺了没有排期的能力，验收时无从判定。
- **修法建议**：二选一——要么把「贴边/吸附/调宽」写入 M6 并给验收（如「拖到屏幕边缘自动贴边，留 4px 间隙」），要么把 `plan:66`/`plan:229` 的表述降级为「首个版本仅支持拖动与位置记忆」。

---

**P2-6｜§6.2 的「按 ⌘K 选目录」入口在 §4.1/§4.2/§8 全无定义（审计 C14 只处理了键位记法）**

- **描述**：审计 C14 只提出把 `⌘K` 改成 `Ctrl+K`。但真正的缺口是：这个「工作区选择器」在交互规格（§4.1 形态表、§4.2 宿主细节）与任务清单（M0–M6）里**从未出现**，而 §6.2 的代码却把它当成既有 UI 调用。
- **证据**：
  ```
  plan:317  if (context.score >= 2) ui.hint("这条可能需要在工作区里问，按 ⌘K 选目录");
  # 全文中「选目录 / 工作区选择」只此一处（脚本 grep：⌘K / Ctrl+K 仅命中 plan:317 与 audit:364）
  ```
- **影响**：判定层的「context 提示」指向一个不存在的能力；M5 验收（关掉 TypeSafe 全功能可用）也无法覆盖它。
- **修法建议**：在 §4.1/§4.2 补「工作区选择器」的定义（触发键、候选来源、与 `work` 场景 cwd 的关系），或删除这句 `ui.hint` 的落地承诺。

---

**P2-7｜审计技术选型中的「E27+ 的窗口 resize/白闪回归」无法核实**

- **描述**：`audit:42` 写「注意 E27+ 的窗口 resize/白闪回归，版本要压住」。`E27+` 非 Electron 官方记法；我未找到任何官方来源支持「Electron 27 起存在窗口 resize 白闪回归」这一说法。
- **证据**：检索 Electron 官方 blog / breaking-changes / releases 未命中；`E27` 的 EOL 为 2024-04-16（endoflife.date）。
- **影响**：这类无出处的结论会被当作选型依据，且会把「压住版本」引向一个更旧的、已 EOL 的版本（与 P0-2 叠加）。
- **修法建议**：删除或替换为可追溯的 issue 编号与复现描述；若确需规避，注明是哪个 issue、在哪个版本修复。

---

**P2-8｜审计「Electron 14+ 有 `roundedCorners` 配置项」的版本号存疑**

- **描述**：`roundedCorners` 确实存在且确为构造期选项（见任务 C 结论），但「14+」这个版本号我在官方文档中找不到依据；社区资料一处称 Electron 13 引入，另一处称 25+。
- **证据**：
  ```
  # https://www.electronjs.org/docs/latest/api/structures/base-window-options
  - `roundedCorners` boolean (optional) - Whether a frameless window should have rounded corners.
    Default is `true`. On Windows versions older than Windows 11 Build 22000 this property has no
    effect, and frameless windows will not have rounded corners. On Linux, rounded corners are only
    drawn when the desktop environment supports client-side decorations.
  # https://www.electronjs.org/docs/latest/breaking-changes/ (43.0)
  "…the existing roundedCorners option on BrowserWindow, which is now supported on Linux and
   defaults to true on all platforms."
  ```
- **影响**：轻微。不影响「构造期」这一实质结论。
- **修法建议**：删掉版本号，或标注「官方文档未注明引入版本，以实际所用版本实测为准」。另需注意官方新给出的 Windows 前提：**Windows 11 Build 22000 以下 `roundedCorners` 无效**。

---

### P3（建议）

| 编号 | 缺陷描述 | 证据 | 影响 | 修法建议 |
|---|---|---|---|---|
| **P3-1** | 原型底部状态条在 ≤1600×1000 视口被 `overflow-x` 裁剪；**点击第 6 级会误触旁边的「上一级」按钮** | `run_layout.js`：1600×1000 → `#steps` clientWidth 818 / scrollWidth 926，被裁级别 `[6]`；1440×900 → `[4,5,6]`；1280×800 → `[3,4,5,6]`；1920×1080 无裁剪。`run_final.js / F5-misclick`：点第 6 级坐标 (1257,957) → `elementFromPoint` = `BUTTON#btnPrev | 上一级`，级别从 3 变 2 | 演示控制台会点错，验收时容易误判 | 缩短级别标签或允许换行；给 `.steps` 加 `flex-wrap:wrap`；把 `#stageNote` 移出同一行 |
| **P3-2** | 原型左侧控制台内容固定 1473px 高，任何分辨率下都需纵向滚动，⑤⑥ 两组控件默认在屏幕外 | `run_layout.js`：`railScroll` 各分辨率下 `scrollHeight=1473` > `clientHeight`（938/838/738/1018），均 `needsScroll:true` | 演示者需滚动才能点「边界状态」「用户可见动作」 | 折叠分组或压缩间距，让 7 组在一屏内可见 |
| **P3-3** | 深色主题下少量小号辅助文字未达 WCAG AA 正文 4.5:1 | `analyze.js` 对比度计算：输入框 placeholder `#6b7684/#151b23` = **3.75**；diff 行号 `#5d6b7a/#0d1219` = **3.44**；PDF 模拟层 meta `#7d8894/#222a33` = **4.02**、footer `#6f7b87/#1b2129` = **3.75**；状态条级别数字 `#8b949e/#222c38` = 4.60（临界） | 低视力用户读不清辅助信息；正文文本对比度均 ≥4.5 属达标 | placeholder 提亮到 `#7d8894` 以上；diff 行号提亮到 `#7d8894` |
| **P3-4** | 文档无 `h1`，首个标题层级就是 `h2` | `run_diag.js / D10-a11y`：`h1Count:0, h2Count:7` | 屏幕阅读器大纲不完整 | `.rail__title` 改为 `h1` |
| **P3-5** | `<details class="docpanel">` 用 `list-style:none` 去掉了展开指示三角，无视觉可发现性 | `D10-a11y`：`summaryMarkerHidden = "none/flex"` | 用户不易发现该面板可展开 | 用 `::before` 自绘 ▸/▾ 指示 |
| **P3-6** | 审批卡抽屉是 `aside`，无 `role="dialog"` / `aria-modal`，无焦点管理（打开后焦点不进入，Esc 不关闭抽屉） | `D10-a11y`：`drawerRole: null, drawerAriaModal: null`；`run_final.js` 中 Esc 只影响 mini/full 形态 | 键盘与读屏用户难以到达/退出审批卡 | 加 `role="dialog" aria-modal="true"`，打开时移焦、Esc 关闭、关闭后焦点归位 |
| **P3-7** | 术语混用：「速问」与 `speed` 指同一事物 | `plan:56`「**速问场景**默认无工具、内存会话」、`plan:410`「速问不落盘」，而 §3.2 场景名是 `speed`、§3.3 小节标题是「与「速问」场景的关系」正文却写 `speed` | 开发期命名歧义 | 统一为 `speed`，仅在 v0.1→v0.2 变更说明处保留「速问」 |
| **P3-8** | §4.1 只定义了 Mini 的 `Esc` 与 Full 的「⤡ 收起」，未定义 Full 态按 `Esc` 的行为 | `plan:222` 状态机图、`plan:229/230` 形态表；原型自行定为「Full → Mini」 | 模态行为不一致 | 在形态表补一行：Full 态 `Esc` = 收起为 Mini |
| **P3-9** | §9 把「问完自动收起」列为对策，但 M0–M6 无任务、无验收，原型也未实现 | `plan:407`「静默默认、未读小圆点、`interrupt` 判定、30 分钟免打扰、**问完自动收起**、全屏自动隐藏」；M3-4 只有「中断/重试/成本」；原型 level 5 仍停留在小窗，需手动点「收起到球」 | 承诺无排期 | 写入 M3 或 M6 并给验收 |
| **P3-10** | 原型自加内容未全部标注为「原型自加」 | `minipi-prototype.html:1074` 把合并卡的「全部允许 / 只允许勾选项」标为 `§3.3 节奏控制`（原文只说「逐个勾选」）；`:1068` 的「本日累计 $0.318」标 `§4.1 · §9`（§9 只说「设置里可设日预算提示」）；`:1297` 的「思考段（小窗里不显示，大窗才露出）」标 `§4.1`（§4.1 未规定） | 评审时误认为是文档要求 | 这三处移入原型自加的 `MAP` 分组（该分组已存在，见 `:1083`） |

---

## 【任务 A：审计逐条裁定表（C1–C19 + N1–N9）】

> 裁定口径：`成立`＝回原文确有该矛盾/缺口；`部分成立`＝现象存在但审计定性过头；`误报`＝原文并不矛盾。

| 编号 | 审计主张 | 裁定 | 原文证据（章节 / 行 / 关键原句） |
|---|---|---|---|
| **C1** | 热键与入口优先级三处不一致，「`Alt+Shift+Space` 最高频入口」与 `Alt+Space` 冲突 | **部分成立** | `§0:16`「按 `Alt+Space` 唤起一个小窗」、`§0:29` 判据「**只按一次热键**（`Alt+Shift+Space` 连带抓取选区）」、`§4.1:220` 状态机只用 `Alt+Space`、`§4.2:240`「后者是最高频入口」。**过头处**：三处语义其实兼容（开合 vs 带选区提问），`§0:29` 用 `Alt+Shift+Space` 是因为判据本身就是抓选区路径。**成立处**：状态机确实缺 `Alt+Shift+Space` 直通 Mini 的分支；「最高频入口」不可验证 |
| **C2** | 「不切换前台窗口」与「默认抢焦点」冲突，难点 2 又断言小窗不聚焦 | **成立** | `§0:29`「**不切换前台窗口**」vs `§4.2:250`「建议做成开关：**默认抢焦点**（能直接打字）」；抢焦点即小窗成为前台窗口，判据字面被违反。（审计把 `§1:47`「本来就长期不聚焦」也计入冲突略有加强——那句描述的是稳态，可与唤起瞬间抢焦点并存） |
| **C3** | §2 列三个窗口 vs §4.3 推荐单窗口实例 | **部分成立（审计定性过头）** | `§2:64-68` 窗口层并列 Ball/Mini/Full；**但紧接着** `§2:69` 就写「形态变化**只改窗口尺寸**与渲染范围，不重建会话」——这句已指向单窗口；`§4.3:254` 推荐单实例，`§4.3:257` 又把双窗口明确列为「**若你确实要这个**，再加一个可选的独立 Full 窗口」。→ 这是「能力枚举」与「实例数决策」的分层表述差异，**不是矛盾**；可优化措辞 |
| **C4** | §4.1 Full＝普通窗口（原生边框）与 Ball＝透明 frameless 不能同窗 | **成立** | `§4.1:228`「Ball … frameless + always-on-top + **透明背景**」、`§4.1:230`「Full | 960×680 **普通窗口**」、`§4.3:254`「**一个窗口实例**在 Ball/Mini/Full 三态间变形」；`frame`/`transparent` 为构造期选项（见任务 C 结论）→ 同一实例不可能兼具。审计给的两条修法（自绘标题栏 / 第二窗口）均成立 |
| **C5** | `speed` inMemory 与「钉住转正」的迁移路径缺失 | **成立** | `§3.2:144`「内存，**可「钉住」转正**」、`§3:101` `SessionManager.inMemory()`、`§3.2:150`「**「钉住」**→ 升级为持久 `study` 会话」；全文无 inMemory→disk 的迁移步骤（历史消息如何落盘、工具如何从 none 变有、cwd 如何切换均未定义） |
| **C6** | study 无 `edit`，但 M4 验收要求看真实 diff | **成立** | `§3.2:145` study 工具＝`read`,`write`,`grep`,`find`,`ls`；`§8:385` M4 验收「让 Pi 改一个文件 → 弹卡且显示**真实 diff**」；`§3.3:186`「`edit` → 已由 Pi 返回 `details.patch`」（只有 edit 产 patch） |
| **C7** | 审批链路无 HTTP 契约 | **成立** | `§3.3:168` `bridge.requestApproval({…})`、`§3.3:205` 待确认角标持久化，而 `§3.1:122-130` 最小集里**没有任何** `/api/approvals*` 端点或 WS 事件类型 |
| **C8** | Full 需要「会话列表」但没有 `GET /api/sessions` | **成立** | `§4.1:230` Full 内容含「**会话列表**」；`§3.1:122-130` 无该端点 |
| **C9** | 判定层是否在关键路径矛盾 + 无任何可观测指标 | **部分成立** | **成立处**：「打扰率」全文无定义，`§8:392` M5 验收「打开后打扰率（被立刻划掉的比例）下降」不可验证。**过头处**：`§6:285` 用的是「**不在这条链路的成败路径上**」、`§6.3:325`「绝不阻塞主流程」——通知策略不在「成败路径」上，两者可以并存；审计把它读成了「关键路径」自相矛盾 |
| **C10** | §6.3 原则 vs §6.2 代码的逐字保留决策冲突，且 `>0.5` 与超时默认值 0.5 冲突 | **成立** | `§6.3:327`「「选区一律逐字保留」是明确规则，**不该交给概率模型决定**」vs `§6.2:314` `const prompt = verbatim.noul > 0.5 ? … : raw;`；`§6.3:326`「超时就按默认值（`verbatim=0.5→保留原文`）」，而 `0.5 > 0.5` 为 false → 超时**反而不会**逐字保留。此条最实 |
| **C11** | 焦点归还粒度夸大（无法恢复 caret） | **成立** | `§0:24`「收起后焦点回到原来的 App 和**原来的光标位置**」vs `§4.2:247`「记录唤起前的 `GetForegroundWindow`，收起时 `SetForegroundWindow` 还回去」——只能到窗口级 |
| **C12** | 桥接形态不一致（同进程 / sidecar 两套并存） | **成立** | `§2:71`「bridge（**同一进程内的 Node 侧 / 或 App 管理的 sidecar**）」、`§2:76`「端口：随机端口 + 写进用户数据目录的**端口文件**」；`§7.1:344` 已选 Electron 同进程并称「省掉一整个 sidecar 生命周期管理（**端口**、僵尸进程、重启、日志）」；`§7.2:360`「进程间用 `ipcMain/ipcRenderer` **或**直接 `ws://127.0.0.1:<随机端口>`（推荐后者）」→ 端口文件在 Electron 同进程方案下无意义，且渲染↔主进程通道未收敛 |
| **C13** | 目录根不一致（`~/.minipi/` vs `~/minipi/`） | **成立** | `§3.2:144` `~/.minipi/scratch/<date>`、`§3.2:145` `~/minipi/study`、`§11:432`「决定 `~/.minipi/` 与 `~/minipi/study` 这两个目录放哪」 |
| **C14** | Windows 平台却写「按 ⌘K 选目录」 | **成立** | `§6.2:317` `ui.hint("…按 ⌘K 选目录")`；宿主为 Windows（`§7.1`）。**延伸**（审计未提）：「按 ⌘K 选目录」这个入口在 §4.1/§4.2/§8 全无定义 → 见 N9 |
| **C15** | M5 工期 1–2 天 vs「先跑一周再回归阈值」 | **成立** | `§8:390`「**M5 · 判定层（1–2 天）**」；`§8:392` M5 验收「**一周后**按数据回归阈值」；`§6.3:328`「先跑一周收集…再定阈值」 |
| **C16** | `prompt` 出参未定义 | **成立** | `§3:116`「用 `preflightResult` 回调拿「接受/排队/被拒」，UI 立刻给反馈」；`§3.1:126` `POST /api/sessions/:id/prompt → { text, images?, behavior }` 无出参 |
| **C17** | `edit` 预览数据来源矛盾（预览要 patch，patch 在执行期产出） | **成立** | `§3.3:186`「`edit` → 已由 Pi 返回 `details.patch`（标准 unified patch），直接渲染红绿 diff」vs `§3.3:168` `preview: await buildPreview(name, params)` 出现在 `execute` 之前、未放行时；patch 属执行期产物。**补充**：SDK 已导出 `generateUnifiedPatch` / `generateDiffString`（`dist/index.d.ts`），审计给的方向可行 |
| **C18** | WS 粒度冲突 | **误报** | `§2:72`「会话多路复用：**一个 Pi AgentSession ↔ 一个「场景」**」定义的是 session↔scene 映射，与一条 WS 承载几个 session 无关；`§3.1:128` 也没有「一条 WS 只能一个会话」的表述。→ 不是矛盾，最多是「§3.1 未定义连接与 session 的基数关系」的缺口 |
| **C19** | §11「方案层面已无待决问题」与文档自身缺口矛盾 | **成立** | `§11:428`「**方案层面已无待决问题**，可以直接开工 M0。」与 C5（迁移缺失）、C11（判据夸大）、C16（契约缺出参）等并存 |

**裁定汇总**：成立 **15** 条（C2、C4、C5、C6、C7、C8、C10、C11、C12、C13、C14、C15、C16、C17、C19）；部分成立 **3** 条（C1、C3、C9）；误报 **1** 条（C18）。即：**19 条中 4 条需要修正定性或撤回**。

### 漏报补遗（N1–N9）

| 编号 | 原文矛盾 / 缺口 | 证据 | 严重度 |
|---|---|---|---|
| **N1** | §5 表实为 **7 行**，正文 2 处 + 审计 3 处写成「六级」。审计不但漏报，还**复述了错误数字** | `plan:379`、`plan:409`、`audit:25`、`audit:232`、`audit:284` 均写「六级」；脚本统计 §5 表数据行＝7（`["0–300ms","首字到达","工具调用中","等审批","超过 8s","完成","超时/失败"]`） | **高**（直接影响 M3 验收口径，见 P1-2） |
| **N2** | §5 表内部冲突：等审批行「不自动升级」vs 超 8s 行「自动升级」，无优先级/暂停规则 | `plan:274` vs `plan:275`；`plan:206` 审批超时为 5 分钟 → 二者必然同时命中 | **高**（见 P1-3） |
| **N3** | §4.1 声明 Mini「可贴边、可吸附、可调宽」，M0–M6 无任务无验收 | `plan:66`、`plan:229` vs `plan:371`（M1 只写「位置记忆」）、`audit:217`（M1-4 同样只有位置记忆） | 中（见 P2-5） |
| **N4** | §11 环境前置「`node -v` ≥ 20」与 SDK 实际 `engines: node>=22.19.0` 冲突 | `plan:430` vs `pi/package/package.json`；`dist-tags` 里另有 `legacy-node20: 0.74.2` | **高**（见 P0-3） |
| **N5** | SDK 为纯 ESM（`"type":"module"`，`exports` 仅 `import`），方案 §7.2「主进程直接 import」与审计【技术选型】均未提模块格式约束 | `pi/package/package.json` | **高**（见 P0-3） |
| **N6** | 术语混用：「速问」与 `speed` 指同一事物 | `plan:56`、`plan:410` vs `plan:144`（场景名 `speed`）、`plan:209`（标题用「速问」正文用 `speed`） | 低（见 P3-7） |
| **N7** | 未定义 Full 态按 `Esc` 的行为（只定义了 Mini 的 `Esc` 与 Full 的「⤡ 收起」） | `plan:222` 状态机图、`plan:229`/`plan:230` 形态表 | 低（见 P3-8） |
| **N8** | §9 把「问完自动收起」列为对策，但 M0–M6 无任务、无验收 | `plan:407` vs `plan:378-396`；`plan:223`「问完 → 静默球 + 未读小圆点」亦无验收 | 中（见 P3-9） |
| **N9** | §6.2 的「按 ⌘K 选目录」入口在交互规格与任务清单里从未定义 | `plan:317` 为全文唯一出现处（`grep ⌘\\|Ctrl+K` 仅命中 plan:317 与 audit:364） | 中（见 P2-6） |

---

## 【任务 B：原型交互测试通过率】

### B1 自包含性 —— **通过**

| 检查项 | 结果 | 证据 |
|---|---|---|
| `<link>` | 0 | `analyze.js` |
| `<script src=>` | 0 | 同上 |
| `@import` | 0 | 同上 |
| `@font-face` / 外链字体 | 0 | 同上 |
| `fetch(` / `XMLHttpRequest` / `new WebSocket` / `sendBeacon` / `EventSource` | 0 / 0 / 0 / 0 / 0 | 同上 |
| `<img>` / `srcset` / `data:` URI | 0 / 0 / 0 | 同上 |
| `http(s)://` 出现次数 | 1（`https://example.invalid/install.sh`，仅作为"危险命令"演示串） | 同上 |
| **运行时实测网络请求** | **1 条，且是文档自身** | `Network.requestWillBeSent` 全量记录：`["file:///D:/SAiProject/minipi/prototype/minipi-prototype.html"]` |

结论：**完全自包含**，可离线双击打开。

### B2 功能测试 —— **47 项中 45 项通过（95.7%）**

实际点过的项与结果（真实鼠标/键盘事件，未使用 `element.click()`）：

| # | 交互项 | 结果 | 实测观察 |
|---|---|---|---|
| 1 | Ball 空闲态 | ✅ | `data-ball=idle`、caption「空闲」、自动切回 ball 形态 |
| 2 | Ball 思考中态 | ✅ | `data-ball=thinking`、旋转环 `::after` 存在、caption「思考中」 |
| 3 | Ball 未读态 | ✅ | `data-ball=unread`、红点 `display!=none`、caption「未读」 |
| 4 | Ball 待确认态 | ✅ | `data-ball=await`、黄色脉冲标记、caption「待确认」 |
| 5 | **Ball 右键菜单** | ❌ | 右键后 `#ballMenu` `display:none`（宽度 0）；只有 hover 生效 |
| 6 | Ball 悬停菜单 + 点菜单项 | ✅ | 「隐藏 30 分钟」→ toast「已隐藏 30 分钟（免打扰，§9 …）」 |
| 7 | Ball 拖动 | ✅ | 位置 `787,618 → 907,528`，toast「位置已记忆（M1-4：重启后球回到这里）」 |
| 8 | 拖动后不误触点击 | ✅ | 松手后仍为 `mode=ball` |
| 9 | Mini `Enter` 发送 | ✅ | 输入清空、提问进入气泡、级别 0 →（300ms）→ 1 |
| 10 | Mini `Shift+Enter` 换行 | ✅ | `"A行"` → `"A行\n"`，未发送；可输入多行 `"A行\nB行"` |
| 11 | Mini `Esc` 收起 | ✅ | `mode=ball`，toast「Esc 收起 · 焦点归还到唤起前的窗口（§4.2）」 |
| 12 | `Alt+Space` 开合（两个方向） | ✅ | mini ↔ ball |
| 13 | 代码块「复制」 | ✅ | 按钮文案 →「已复制」（`occluded=false`） |
| 14 | Mini → Full（「⤢ 放大」） | ✅ | `mode=full`，toast「已放大 · 流不中断…」 |
| 15 | Full → Mini（「⤡ 收起」） | ✅ | `mode=mini` |
| 16 | **流式中切换形态不重放** | ❌ | 135 → 36 → 36 → 135（回答从头重放）；UI 却声称「流不中断」 |
| 17 | 流式结束后代码块出现 | ✅ | `#streamCodeWrap.hidden = false` |
| 18 | 审批卡 `edit · diff` | ✅ | 标题「修改 src/train.py」、按钮 `允许一次/拒绝/本会话总是允许`、红绿 diff 双行号 |
| 19 | 审批卡 `write · 新建` | ✅ | 标签「新建」、总行数 42、覆盖＝否 |
| 20 | 审批卡 `bash · 危险` | ✅ | 完整命令原文不截断、危险形状高亮（`rm -rf` / `git push --force` / `>` / `curl … \| sh` / `; &&`）、显示 cwd |
| 21 | 审批卡 `batch · 3 操作` | ✅ | 3 个可勾选项、按钮 `全部允许/只允许勾选项/全部拒绝` |
| 22 | 抽屉内 tab 切换 | ✅ | `aria-pressed` 转移、正文出现 `.bcmd` |
| 23 | 合并卡逐个勾选 | ✅ | `[true,true,false] → [true,true,true]` |
| 24 | 合并卡「只允许勾选项」 | ✅ | toast「只允许勾选项：未勾选的按拒绝处理并回「不要重试」」 |
| 25 | 审批卡「拒绝」 | ✅ | toast「已拒绝：回给模型「不要重试，问用户想怎么做」（§3.3）」 |
| 26 | `write` 卡「展开更多」 | ✅ | `#writeMore.hidden: true → false` |
| 27 | 小窗工具行展开详情 | ✅ | `#toolDetail.hidden: true → false`，chev 文案切换 |
| 28 | 小窗横幅「展开」→ 审批卡 | ✅ | 抽屉打开，标题「修改 src/train.py」 |
| 29 | 长任务状态条逐级跳转 0–6 | ✅ 7/7 | 每级 `aria-pressed` 与 `#stageNote` 均正确；`mode`/`ball` 联动正确（3→await、4→full、5→unread、6→idle） |
| 30 | 「上一级」/「下一级」 | ✅ | 6→5 / 5→6 |
| 31 | 自动播放 | ✅ | 0→1→…→6 后自动停止，按钮文案复原为「自动播放」（需 ≥14s） |
| 32 | 场景切换 speed / study / work | ✅ 3/3 | 场景表 cwd/工具/会话/权限四行均随场景更新，并弹 toast |
| 33 | 边界：空状态 | ✅ | 「还没有对话。在任意 App 里选中一段文字…」 |
| 34 | 边界：加载中 | ✅ | 「正在连接 Pi 会话…（已等待超过 3 秒）」+ 8s 自动升级说明 |
| 35 | 边界：错误状态 | ✅ | 「连接失败：bridge 未响应（端口文件未找到）」+ 重试按钮 |
| 36 | 错误态「重试」 | ✅ | toast「重试中…」并回到级别 0 |
| 37 | 恢复正常对话 | ✅ | 边界态清除 |
| 38 | 「钉住」 | ✅ | `scene: speed → study`，动作说明面板出现 |
| 39 | 「用这个项目打开」 | ✅ | `scene → work` + 说明 |
| 40 | 「新会话」 | ✅ | 说明面板出现（原型未真正新建，已注明） |
| 41 | 大窗会话列表切换 | ✅ | 选中态转移 + toast 提示 `waitForIdle` 语义 |
| 42 | 大窗思考等级切换 | ✅ | 「高」被选中 |
| 43 | 大窗模型下拉 | ✅（存在性） | 3 个选项，默认 `gemini-2.5-pro`；**切换后有无状态变化未定义，未验证** |
| 44 | 大窗附件入口 | ✅ | toast「附件入口：文件 / 框选截图（base64 + mimeType，§4.2）」 |
| 45 | 大窗内切场景 | ✅ | `scene=study` |
| 46 | 大窗内 level 3 内联审批卡 | ✅ | `#fullTree .toolcard--approval` 存在 |
| 47 | 待确认态跨形态保持 | ✅ | level 3 → Esc → 球仍为 `await`（对应 §3.3 失败模式 1） |

**通过率：45 / 47 = 95.7%**（另：页面控制台报错 0 条；`pageerror` / `console.error` / `Log.error` 均为 0）

**层级遮挡检查**：47 项点击全部在派发前用 `document.elementFromPoint` 校验，仅 P3-1 一处发现遮挡（状态条第 6 级坐标命中 `BUTTON#btnPrev`）。

### B3 一致性核验（vs §3.2 / §3.3 / §4.1 / §4.2 / §5）

| 核对项 | 结论 |
|---|---|
| **长任务状态条 6 级还是 7 级** | **原文 §5 表实际 7 行**（`0–300ms` / `首字到达` / `工具调用中` / `等审批` / `超过 8s` / `完成` / `超时/失败`）。原型渲染 **7 级（0–6）**，**与表格一致、与「六级」表述不一致** → 错的是文档正文与审计（P1-2 / N1） |
| 审批卡的三个动作按钮 | **不吻合**（P1-6）：§3.3 的 outcome 是 `approved` / `aborted`（中断整轮）/ `denied`；原型为「允许一次 / 拒绝 / 本会话总是允许」，**无「中断整轮」**，且引入了审计判"默认不做"的「本会话总是允许」 |
| 危险命令高亮项 | **吻合**：§3.3:188 要求高亮 `rm`、`>`、`curl \| sh`、`git push --force` 并显示 `cwd`；原型实测显示全部 4 类 +「`; / &&` 串联」，且 `cwd` 同时出现在卡头与正文 |
| §3.2 场景表 | 三种场景的 `cwd` / 工具白名单 / 会话持久化 / 权限文案与 §3.2 一致；**唯 study「权限」行含 `edit`（P2-4）** |
| §4.1 Ball/Mini/Full 三项内容与关键交互 | 一致（含「⤢ 放大」「⤡ 收起」、右键菜单项文案、`Esc`、`Enter`/`Shift+Enter`、代码块一键复制、中断按钮、会话列表、模型/思考等级/成本/附件） |
| §4.2 宿主细节 | 原型在 ⑦ 组显式标注「未聚焦窗口不刷新 / 焦点归还 / 全屏自动隐藏 / 多屏：原型只做文案与状态示意」——**标注诚实** |
| §5 长任务各级文案与触发条件 | 一致（含「⚠ 等待你确认 1 个操作」「超过 8s 自动升级」「不自动升级」）。**但 8s 计时起点/手动收起覆盖分支原型自述未实现** |
| **原型自加却标注成「对应 §X」** | **有 3 处**：① `:1074` 合并卡的「全部允许 / 只允许勾选项」标 `§3.3 节奏控制`（原文只说「逐个勾选」）；② `:1068`「本日累计 $0.318」标 `§4.1 · §9`（§9 只说「设置里可设日预算提示」）；③ `:1297`「思考段（小窗里不显示，大窗才露出）」标 `§4.1`（§4.1 未规定，且 §4.1 实现要求 3 反而强调小窗要渲染整个 turn）。**另有 3 处已正确标注为「原型自加」**（`:1083-1085` 空/加载/错误态、未聚焦节流） |
| 错误态文案 | 与已定架构冲突（P2-3） |

### B4 可访问性与主题

| 检查项 | 结果 | 证据 |
|---|---|---|
| 深色主题文字对比度 | **基本达标**。正文与主要文本均 ≥ 4.5:1（最高 16.27）；**5 处小号辅助文字未达 AA 正文标准**：placeholder 3.75、diff 行号 3.44、PDF 层 meta 4.02 / footer 3.75、状态条级别数字 4.60 | `analyze.js` 对 26 组（前景/背景）逐一计算 WCAG 对比度 |
| 语义标签 | 使用 `main`(1) / `header`(4) / `aside`(4) / `section`(10) / `footer`(2)；`aria-pressed` 39 处、`aria-expanded` 1 处、`aria-live` 2 处 | `run_diag.js / D10-a11y、D11-semantics` |
| 可访问名 | 67 个可聚焦元素中 **0 个**缺可访问名；**0 个**按钮缺文案；**0 个** `<img>` 缺 `alt` | 同上 |
| 图标处理 | 22 处装饰元素加 `aria-hidden="true"` | 同上 |
| 键盘可达性 | `Tab` 实测 12 次连续移动焦点（`ballpick__item` → `btn` → …），**每次均有可见焦点环** `outline: 2px solid rgb(76,154,255)` | `run_diag.js / D10-focus` |
| **全局 `outline: none`** | **不存在**（`outline:none` 出现 0 次；`:focus-visible` 规则 1 处，`outline:2px solid var(--accent)`） | `analyze.js / selfContained.outlineNone = 0`；`D10-a11y.globalOutlineNone = false` |
| 最小点击目标 | 24 / 28 / 30 / 31 px（最小值 24px，满足 WCAG 2.2 SC 2.5.8 的 24×24 下限） | `D11-semantics.minTargetSizes` |
| `prefers-reduced-motion` | 已处理（动画时长压到 0.001ms） | `minipi-prototype.html:47-49` |
| 语言声明 | `<html lang="zh-CN">` ✅ | 同上 |
| 标题层级 / 抽屉语义 / details 指示 | **3 处问题**：无 `h1`（首个标题为 `h2`）；审批抽屉无 `role="dialog"` / `aria-modal`、无焦点管理；`<details>` 用 `list-style:none` 去掉了展开指示三角 | P3-4 / P3-6 / P3-5 |

### B5 隐私 —— **通过**

| 检查项 | 结果 |
|---|---|
| 真实 API key / 凭证 | **0**（`sk-` / `ghp_` / `AKIA` / `AIza` / `xox[baprs]-` 均无匹配） |
| 真实邮箱 | **0** |
| 真实用户名 / 本机绝对路径 | **0**（`C:\Users\…`、`/Users/…`、`/home/…` 均无匹配；本机用户名与项目所在盘符路径均未出现，临时目录一律记作 `%TEMP%`） |
| 绝对路径 | 全部为虚构示例 `D:\proj\demo\...`（18 处）与 `~/minipi/...` |
| IP 地址 | **0** |
| 域名 | 仅 `example.invalid`（**RFC 2606 保留 TLD，保证不可解析**）→ 安全 |
| 出现 `token` 字样 6 处 | 均为成本面板的「输入 tokens / 输出 tokens」，非凭证 |

结论：**示例路径与 `.invalid` 域名确实安全**，原型无敏感信息泄漏。

### B6 无法验证的部分（如实说明）

以下项**本轮无法验证**，不写作通过：

1. **未聚焦窗口的渲染节流**（§1 难点 2 / §9）——浏览器文档无法复现 WebView 节流，需 M0 用真窗口验。原型自己也标注了这点。
2. **焦点归还**（`SetForegroundWindow`）与「恢复插入符位置」——需真实 Windows 窗口与前台锁定策略，原型只做了文案。
3. **全屏自动隐藏、多屏行为、托盘、开机自启**——原型仅示意。
4. **`Alt+Shift+Space` 抓选区 + 剪贴板快照/恢复 + 三级降级链**（§4.2 / M2）——原型只有文案，无实现，未测。
5. **框选截图入对话**（`images` base64 + mimeType）——只有入口 toast，未测。
6. **8s 自动升级的「计时起点」与「本轮内手动收起过则不再升级」分支**（审计 P1-06）——原型自述未实现（`minipi-prototype.html:1092`）。
7. **审批超时 5 分钟默认拒绝的真实计时**——原型只有卡底文案，无计时逻辑，未测。
8. **形态切换不重连 WS**（§4.1 实现要求 2）——单文件原型无 WS，「不重连」只体现在 `fullSub` 文案上；本轮只验证了**"不重放"被违反**这一面。
9. **真实 Pi SDK 调用、真实审批阻塞、真实流式**——原型不含任何 SDK 调用（其自己声明「不含 Electron / Pi SDK 任何真实调用」）。
10. **大窗模型下拉切换后的行为**——原型为静态 `select`，切换后无状态变化或提示；是否应有效果，原文未规定，故未判定。
11. **`WebView2` 行为、触摸/触控板贴边吸附、125%/150% 缩放下的 360×480 可用性**（审计 A4）——未测。

---

## 【任务 C：审计技术风险核查的事实核查结论】

> 结论只使用三种：**成立** / **部分准确** / **未能核实**。每条给出来源。

### C-1（对应审计 R2）「Electron 官方明确：transparent 窗口不可 resize」

**裁定：原文存在，但审计的用法部分准确 —— 准确表述如下。**

官方原句（逐字，来源：<https://www.electronjs.org/docs/latest/tutorial/custom-window-styles> → Transparent windows → Limitations）：

> "You cannot click through the transparent area. See #1335 for details.
> **Transparent windows are not resizable. Setting `resizable` to true may make a transparent window stop working on some platforms.**
> The CSS `blur()` filter only applies to the window's web contents, …
> The window will not be transparent when DevTools is opened.
> On _Windows_:
> - Transparent windows will not work when DWM is disabled.
> - **Transparent windows can not be maximized using the Windows system menu or by double clicking the title bar.** The reasoning behind this can be seen on PR #28207.
> On _macOS_: The native window shadow will not be shown on a transparent window."

结论要点：

| 问题 | 核实结果 |
|---|---|
| 限制的是 `resizable` 还是 `setBounds`？ | **原文约束的是用户拖拽缩放（`resizable` 选项）**；官方**没有**说 `setBounds`/`setSize` 程序化改尺寸会掉透明 |
| 是否与 Windows 相关？ | 该句是跨平台的通用限制，且带 `may` + `on some platforms` 两个限定词；**Windows 特有的是另外两条**：DWM 关闭时透明失效、**不能通过系统菜单或双击标题栏最大化** |
| 审计漏了什么？ | 漏了「Windows 下透明窗口不能通过系统菜单/双击标题栏最大化」这条——它对「三态变形到 Full 并最大化」更直接 |
| 审计过头在哪？ | 三处（`audit:276`、`audit:384`、`audit:438`）把它当成绝对限制并推出「与官方限制正面相撞」，正确结论应是「**需要 spike**」（实测 `setBounds` 是否掉透明、每次变形耗时、是否白闪） |

### C-2（对应审计 R1）`backgroundThrottling` / `setBackgroundThrottling` 是否一等 API，关闭后的代价

**裁定：成立（API 存在且为一等 API，整窗语义亦成立）；「功耗上升」的具体代价未能核实量化。**

| 断言 | 裁定 | 来源（逐字） |
|---|---|---|
| `webPreferences.backgroundThrottling` 是一等 API，默认 `true` | **成立** | 「`backgroundThrottling` boolean (optional) - Whether to throttle animations and timers when the page becomes background. This also affects the Page Visibility API. **When at least one webContents displayed in a single browserWindow has disabled backgroundThrottling then frames will be drawn and swapped for the whole window and other webContents displayed by it.** Defaults to `true`.」<br>来源：<https://www.electronjs.org/docs/latest/api/structures/web-preferences>、<https://www.electronjs.org/docs/latest/api/structures/base-window-options> |
| 运行期 `webContents.setBackgroundThrottling(false)` 是一等 API | **成立** | Electron 4.0/5.0 官方发布说明：「WebContents instances now have a method **`setBackgroundThrottling(allowed)`** to enable or disable throttling of timers and animations when the page is backgrounded.」来源：<https://www.electronjs.org/blog/>（v5.0.0 timeline 页）。第三方类型绑定对其接口描述与官方一致：<https://jetbrains.github.io/kotlin-wrappers/kotlin-electron/electron.core/-web-contents/set-background-throttling.html> |
| 是窗口级而非局部 | **成立** | 官方原句「…frames will be drawn and swapped for the whole window and other webContents displayed by it.」 |
| 官方措辞是「页面进入后台时」的节流，未覆盖「可见但被完全遮挡」 | **成立** | 官方原句为 "when the page becomes background"（并明确「This also affects the Page Visibility API」），确未描述遮挡场景 |
| 关闭后「功耗上升」 | **未能核实（无官方量化）** | 官方文档未给出功耗数据。审计「社区实现里通常出于省电刻意不开」这句我**未找到可引用的权威来源**，建议改写为「理论上持续出帧会增加功耗，具体代价需在 M0 用系统电源计量实测」 |

### C-3 `frame` 与 `transparent` 是否只能在创建窗口时设定、运行期不可变更

**裁定：成立。**（这确认了 P0-02 / C4 的严重程度。）

| 选项 | 官方原文（来源：<https://www.electronjs.org/docs/latest/api/structures/base-window-options>） |
|---|---|
| `frame` | 「`frame` boolean (optional) - Specify `false` to create a frameless window. Default is `true`.」→ 构造期选项 |
| `transparent` | 「`transparent` boolean (optional) - Makes the window transparent. Default is `false`. **On Windows, does not work unless the window is frameless.**」→ 构造期选项 |
| `roundedCorners` | 「`roundedCorners` boolean (optional) - Whether a frameless window should have rounded corners. Default is `true`. On Windows versions older than Windows 11 Build 22000 this property has no effect…」→ 构造期选项 |
| 有无运行期 setter | **无**。`BrowserWindow` 实例方法列表里有 `setResizable` / `setBounds` / `setAlwaysOnTop` / `setBackgroundColor` / `setAspectRatio` 等，**均无 `setFrame` / `setTransparent` / `setRoundedCorners`**。来源：<https://www.electronjs.org/docs/latest/api/browser-window> |

**对本项目的直接影响**：
1. 同一窗口实例**不可能**从「frameless + transparent」变成「有原生边框的普通窗口」→ C4 / P0-02 成立，§4.1 的 Full 描述必须改。
2. `transparent` 在 **Windows 上「does not work unless the window is frameless」** —— 这条反而**强化**了审计 P0-02 的建议默认值（全形态 `frameless` + Full 自绘标题栏）：若想保留 Full 的原生边框，就**不能**让它是透明的，也就不能是同一个窗口实例。
3. `roundedCorners` 在 **Windows 11 Build 22000 以下无效** —— 新增的实测前提，M6「主题」相关验收应带上这项。

### C-4 附带核实（审计未做，但直接决定「能否开工」）

| 断言 / 事项 | 裁定 | 来源 |
|---|---|---|
| `@earendil-works/pi-coding-agent` 是真实包 | **成立**，`0.87.0` | `npm view @earendil-works/pi-coding-agent name version dist-tags` |
| 方案 §3 的 8 个 API 是否真实存在 | **8/8 成立**：`createAgentSession`、`ModelRuntime.create()`、`SessionManager.inMemory()`、`session.subscribe()→unsubscribe`、`session.prompt(text,{streamingBehavior:"steer"\|"followUp"})`、`session.waitForIdle()`、`session.navigateTree(targetId, options)`、`noTools:"all"` | `pi/package/dist/core/agent-session.d.ts`、`core/sdk.d.ts`、`core/session-manager.d.ts`、`core/model-runtime.d.ts` |
| 偏差 1：`preflightResult` | **不成立**（方案理解为「接受/排队/被拒」）——它是 `(success: boolean) => void`，且注释写明 "**Internal** hook used by RPC mode" | `dist/core/agent-session.d.ts:162-166`（见 P1-1） |
| 偏差 2：`navigateTree` 在 agent 忙时「reject 且不返回 cancelled」 | **未能核实**。类型签名为 `Promise<{ editorText?; cancelled: boolean; aborted?: boolean }>`，`cancelled` **确实在返回类型里**；官方注释未提「忙时 reject」。需运行时 spike | `dist/core/agent-session.d.ts:684-697`；`plan:117` |
| 方案 §3.2 的工具名清单 | **成立**：SDK 的 `toolName` 联合类型恰为 `bash`/`powershell`/`read`/`edit`/`write`/`grep`/`find`/`ls` | `dist/core/extensions/types.d.ts:749-781` |
| **Pi 有工具级审批钩子** | **成立**（这是审计与方案都漏掉的） | 见 P0-1；`dist/core/extensions/types.d.ts:784-790、887-896、1014`；`examples/extensions/permission-gate.ts` |
| SDK 的 Node 版本要求与模块格式 | `engines: {"node":">=22.19.0"}`、`"type":"module"`、`exports` 仅 `import` | `pi/package/package.json`（见 P0-3） |
| Electron 是否存在 LTS 线 | **不成立**（无 LTS） | <https://www.electronjs.org/docs/latest/tutorial/electron-timelines/ >「Electron's official support policy is the latest 3 stable releases.」；<https://endoflife.date/electron>「长期支持周期 0」 |
| 审计「E27+ 的窗口 resize/白闪回归」 | **未能核实**（未找到任何官方来源） | — |
| 审计「Electron 14+ 有 `roundedCorners`」 | **部分准确**：选项确实存在，但官方文档未标注引入版本；社区资料一处称 Electron 13、另一处称 25+，故「14+」**未能核实** | 见 P2-8 |

---

## 【验收标准核对】

| 验收标准（来自任务书） | 结论 | 依据 |
|---|---|---|
| 任务 A：逐条回原文核对 C1–C19 | **已完成** | 19 条裁定：成立 15 / 部分成立 3 / 误报 1 |
| 任务 A：特别核查 C3 / C12 / C18 / C9 | **已完成** | C3 部分成立（分层表述差异，非矛盾）；C12 成立；C18 **误报**；C9 部分成立 |
| 任务 A：检查漏报并补 N 条 | **已完成** | 补 **N1–N9**9 条（含 1 条直接影响 M3 验收口径的「六级 vs 7 行」） |
| 任务 B1：自包含性 | **通过** | 静态扫描全 0 外链 + 运行时仅有文档自身 1 条请求 |
| 任务 B2：加载时控制台无报错 | **通过** | `pageerror` 0 / `console.error` 0 / `Log.error` 0 |
| 任务 B2：逐个点击原型自称覆盖的交互 | **已完成** | 47 项，通过 45 项（95.7%），失败 2 项 |
| 任务 B3：长任务状态条 6 级还是 7 级 | **已回原文数清** | **§5 表 7 行**；原型 7 级正确；文档与审计 5 处「六级」错误 |
| 任务 B3：审批卡三按钮与危险命令高亮 | **已完成** | 危险命令高亮**吻合**；三按钮**不吻合**（缺「中断整轮」，多「本会话总是允许」） |
| 任务 B3：原型是否有自加交互却标成「对应 §X」 | **已完成** | 发现 3 处（P3-10） |
| 任务 B4：对比度 / 语义标签 / 键盘可达性 / 全局 outline:none | **已完成** | 正文达标、5 处小字未达 AA；无全局 `outline:none`；Tab 可达且焦点可见 |
| 任务 B5：隐私 | **通过** | 无 key / 邮箱 / 用户路径 / IP；`example.invalid` 为保留 TLD |
| 任务 C：R2 / R1 / frame-transparent 事实核查（含来源） | **已完成** | R1 成立、R2 部分准确、frame/transparent 不可变更成立 |
| 任务 C：查不到的必须明说 | **已执行** | 标注「未能核实」3 处（R1 功耗代价、`navigateTree` 忙时行为、`E27+` 回归、「14+」版本号） |
| 未测部分如实说明 | **已执行** | 见 B6（11 项） |

---

## 【测试数据清理】

- 本次测试**未向项目目录写入任何数据**；`pretest_` 前缀输入仅存在于浏览器页面内存，未落盘、无残留。
- 全部测试产物位于系统临时目录 `%TEMP%\minipi_qa\`（脚本 / 截图 / JSON 结果 / 解包的 SDK），**不在项目内**，可由主理人自行知情后删除。
- 临时 Chrome profile 目录：`%TEMP%\minipi_qa_profile*`、`%TEMP%\minipi_qa_prof2_*`、`%TEMP%\minipi_qa_prof3_*`、`%TEMP%\minipi_qa_prof4_*`。
- 唯一的项目内新增文件是**本报告** `D:\SAiProject\minipi\qa\minipi-qa-report.md`。

**文件完整性证据**（本轮未修改被测文件）：

```
docs/minipi-plan.md                 | 30698B  | sha256=57df6c82d53f89d7 | mtime=2026-09-21T09:36:09Z
docs/minipi-audit.md                | 44553B  | sha256=7d0238b9045bd801 | mtime=2026-09-22T01:37:17Z
prototype/minipi-prototype.html     | 106959B | sha256=45d63a69ea3ce648 | mtime=2026-09-22T02:03:32Z
（本次会话结束时间 2026-09-22T02:21:18Z，三个文件 mtime 均早于会话开始）
```

---

## 【测试结论】

**不可交付 —— 当前产物未达到「可以开工」的门槛。**

方向没错，原型的工程质量也明显在合格线以上（47 项交互 45 项通过、0 控制台报错、完全自包含、无敏感信息、可访问性基础扎实），**但它不能掩盖三件必须先关掉的事**：

1. **§3.3 的实现路线建立在被证伪的前提上**（P0-1）。§3.3 自称「本方案改动最大的一节」，而「Pi 没有这个钩子」是错的——SDK 官方就有 `tool_call` 前置钩子（可 `block`、可改参），并自带一份 `permission-gate.ts` 示例。不先改这条，M4 会造出一套更脆、且被审计自己列为 R3/P0-08 双重不确定的闸门。

2. **两条硬约束没定，M0 的骨架就写不下去**（P0-2、P0-3）。审计建议 pin 的 Electron 33/34 早已 EOL（Electron 没有 LTS）；Pi SDK 是纯 ESM 且要求 Node ≥ 22.19，而方案的环境前置写的是「≥ 20」，全文也没提 ESM 约束。

3. **审计不能当作「已关闭」的清单使用**（P1-2、P2-1 及 N1–N9）。19 条 C 里有 1 条误报（C18）、3 条定性过头（C1/C3/C9）；同时漏了 9 条原文矛盾/缺口，其中 N1（§5 表实为 7 行、文档与审计共 5 处写「六级」）会直接让 M3 的验收口径漏掉一级，N2（等审批「不自动升级」vs 超 8s「自动升级」）会让 M3-3 与 M4-6 的验收互斥。

**还差什么（开工前置动作清单）**：

| 序 | 动作 | 归属 | 产出 |
|---|---|---|---|
| 1 | 把 §3.3 的闸门位置改写为 `pi.on("tool_call")`，并同步下调审计 R3 / P0-07 / P0-08 的严重度 | 架构 | §3.3 修订稿 |
| 2 | 重定 Electron 版本为当前受支持线（44.x），删掉「LTS」；补 ESM 主进程与 Node ≥ 22.19 两条约束到 §7.2 / §11 | 架构 | 技术选型表 + 环境前置 |
| 3 | 在 `plan:379`、`plan:409`、`audit:25/232/284` 把「六级」改为「七级」，并给 7 级各写一条可判定的验收 | 架构 + 产品 | §5 与 M3 修订 |
| 4 | 定义「等审批期间 8s 计时器暂停」规则 | 架构 | §5 增补一行 |
| 5 | 定 `preflightResult` 只做成功/失败、`queuePosition` 走 `queue_update`（或换机制） | bridge | `packages/protocol` 契约 |
| 6 | 修原型 2 处失败项：形态切换不重放（改掉 UI 文案「流不中断」）、球右键菜单可用 | UI | 原型 v0.3 |
| 7 | 做一次 0.5 天 spike：透明窗口 `setBounds` 是否掉透明 / 能否 `maximize()` / 每次变形耗时；同时顺带实测 `session.navigateTree()` 在 agent 忙时的真实行为（C-4 表里的「未能核实」项） | 宿主 | spike 结论（可一次性关闭 C4、P0-02、R2 三项不确定） |

第 7 条做完之前，**不建议开工 M0**；第 1–4 条做完即可让 M0–M2 先启动。
