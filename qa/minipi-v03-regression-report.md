# minipi 原型 v0.3 定向回归复验报告

> 测试人：测试工程师 秦戈
> 被测对象：`D:\SAiProject\minipi\prototype\minipi-prototype.html`（v0.3）
> 对照基准：本人上一轮报告 `D:\SAiProject\minipi\qa\minipi-qa-report.md`（2026-09-22）
> 复验性质：**定向回归**——只验修复项是否真修好 + 是否引入新回归，不重跑全量
> 本轮**未修改任何被测文件**（见文末「文件完整性证据」）

---

## 【测试范围与环境】

| 项 | 内容 |
|---|---|
| 被测功能 | 上一轮报告中的 P1-4、P1-6、P2-2、P2-3、P2-4、P3-1、P3-2、P3-3、P3-4/P3-5/P3-6、P3-10、新增备注、整体回归 |
| 环境 | Windows；Node.js（脚本驱动）；Google Chrome（`C:\Program Files\Google\Chrome\Application\chrome.exe`），`--headless=new`；本机 bash 缺 `ls`/`dirname`/`head`/`mkdir`，全部改用 PowerShell 与 Node |
| 渲染方式 | 真实 Chromium + CDP（`Runtime.enable` / `Log.enable` / `Network.enable` / `Emulation.setDeviceMetricsOverride` / `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` / `Input.insertText`）；**真实鼠标·键盘事件**，每次点击前用 `document.elementFromPoint` 校验遮挡 |
| 驱动来源 | **自建**（复用本人上一轮的 `cdp.js` / `page.js`）；**未采信前端留下的 `run_v03*.js` 任何结论**，其脚本仅用于对照其自报口径 |
| 测试数据 | 输入串统一 `pretest_` 前缀（`pretest_第二个问题`、`pretest_代码块` 等），仅存在于页面内存，未落盘 |
| 被测文件实测指纹 | `117955B` / `2215` 行 / `sha256=239ab1383596479d…` / `mtime=2026-09-22T02:48:40Z`（任务书写「约 2225 行」，实测 **2215** 行） |

**本轮新增脚本与原始证据**（均在 `C:\Users\yang6\AppData\Local\Temp\minipi_qa\`，未写入项目目录）：

```
qa_v03_core.js        → qa_v03_core.json        # 核心修复项 + a11y + maplist + 自包含
qa_v03_layout.js      → qa_v03_layout.json      # 6 档分辨率布局 + 对比度 + 原通过项抽查
qa_v03_fix.js         → qa_v03_fix.json         # 修正测试自身缺陷后的补测
qa_v03_finalcheck.js  → qa_v03_finalcheck.json  # 说明面板可见性 + 文件完整性
qa_v03_rail.js        → qa_v03_rail.json        # 控制台滚动量精确测量（6 档）
qa_v03_stale.js       → qa_v03_stale.json       # P1-4 重构后的「陈旧渲染」专项探测
qa_v03_core.png / qa_v03_1280x800_final.png / qa_v03_drawer_edit.png
qa_v03_menu_open_before_esc.png / qa_v03_menu_after_esc_hover.png
```

复现命令（在 `%TEMP%\minipi_qa` 下）：`node qa_v03_core.js` / `node qa_v03_layout.js` / `node qa_v03_fix.js` / `node qa_v03_rail.js` / `node qa_v03_stale.js` / `node qa_v03_finalcheck.js`

---

## 【执行摘要】

| 层面 | 用例数 | 通过 | 不通过 | 未验证 |
|---|---|---|---|---|
| 修复项复验（12 组） | 12 | 9 | 3（部分通过） | 0 |
| 回归抽查（原 47 项中抽 22 项） | 22 | 22 | 0 | 0 |
| 新引入缺陷 | — | — | **4 条**（P2×2、P3×2） | — |
| 运行时错误 | 6 次独立运行 | 6 | 0 | 0 |

- **运行时错误：0**（`Runtime.exceptionThrown` / `console.error` / `Log.error` 三类在 6 次独立运行中全部为 0）。
- **自包含性：通过**（`<link>`=0、`script[src]`=0、`<img>`=0、无 `fetch`/`XMLHttpRequest`/`new WebSocket`）；运行时网络请求仅文档自身 1 条。

---

## 【一、修复项复验表】

| 编号 | 原判定 | 复验结果 | 证据（实测） |
|---|---|---|---|
| **P1-4** 形态切换不重放 | ❌ 不通过 | **✅ 通过** | 流式中「放大 → 收起 → 再放大」，`#streamOut` 文字长度序列 = **50 → 76 → 98 → 122**，`monotonic = true`，三次切换 `occluded = false`，提问气泡（`pretest_…`）全程保留 → 同一轮内容，无从头重放 |
| **P1-4 追加回归**：第二次提问必须重置 | （前端新增修复） | **✅ 通过** | 首答写完 `len=135`（`streamCodeWrap` 已显示）→ 第二条 Enter 后 **60ms：#streamOut 不存在**（level 0「Pi 正在思考…」脉冲），旧答案已被清空；**760ms：len=56** 从头流式；`hasOldTail=false`；用户气泡文本 = `pretest_第二个问题`。流式中途再发第二条同样成立（80ms `len=0` → 780ms `len=60`） |
| **P2-2** Ball 右键菜单 | ❌ 不通过 | **⚠️ 部分通过**（1 条不通过点） | 通过项：右键后 `data-open=true`、`display:block`、`aria-expanded=true`、`getBoundingClientRect().height=178`、`elementFromPoint` 命中菜单、焦点进第一项（`BUTTON:new`）；鼠标移开仍开（`open=true/disp=block/hitIsMenu=true`）；点击空白关闭（`open=false/disp=none`）；悬停仍可见；四个菜单项均可点（`occluded=false`），`hide30`→toast「已隐藏 30 分钟…」、`new`→「新会话」、`quit`→「退出：…」、`full`→切到 `mode=full`。**不通过点见新缺陷 P2-N2** |
| **P1-6** 审批卡按钮集合 | ❌ 不通过 | **✅ 通过** | 实测 `#drawerBody [data-approve]`：`edit`/`write`/`bash` = **`["允许一次","拒绝","中断整轮"]`**（恰好 3 个，无「本会话总是允许」）；`batch` = `["全部允许","只允许勾选项","全部拒绝","中断整轮"]`，且卡内文案含「**未勾选项在提交时按「拒绝」处理**，同样回一条「不要重试」的 tool result」 |
| **P1-6** 中断整轮必须真中断 | （行为判据） | **✅ 通过** | 打开 `bash` 卡 → 点「中断整轮」：`drawerOpen true→false`（离开审批态）、级别 `6`（失败/中断态）、`stageNote` = 「errorMessage / abort…」、卡体换为「已中断：你在工具执行期间点了「中断」…」，toast「中断整轮（aborted）：agent 停止当前 turn，不回 tool result（§3.3）」→ **非仅弹 toast** |
| **P2-3** 错误态文案 | ❌ 不通过 | **✅ 通过** | 渲染错误态后全文检索：`端口文件` / `随机端口被占用` / `Pi 进程未启动` **命中 0 条**；新文案 = 「连接失败：bridge 未响应（**主进程未就绪 / 会话初始化失败**）」「可能原因：**Pi 会话创建失败 / 上一次 turn 仍在收尾**」；`data-act="copyerr"` 复制串同步改（`:1226-1232`、`:1948`） |
| **P2-4** study 权限文案 | ❌ 不通过 | **✅ 通过** | study 场景表：工具 = 「read · write · grep · find · ls」，权限 = 「可写 —— **write 必须逐次确认（study 无 edit / bash）**」；旧文案「write / edit 必须逐次确认」**命中 0 条**（`:1043`） |
| **P3-1** 状态条 7 级可见可点 | ❌ 不通过 | **✅ 通过** | 6 档分辨率（1280×800 / 1440×900 / 1600×1000 / 1920×1080 / **1366×768** / **1280×720**）：`stepCount=7`，7 级 `fully=true` 且 `elementFromPoint` 命中自身（`hitInside=true`）；`#steps` `scrollWidth == clientWidth`（无横向裁剪）；点第 6 级：`occluded=false`、`pressed=6`、`stageNote=errorMessage / abort…`。原 P3-1 的「点第 6 级命中 `BUTTON#btnPrev`」**已不再复现**（现命中 `SPAN`，`hitInside=true`） |
| **P3-2** 控制台纵向滚动 | ❌ 不通过 | **⚠️ 部分通过** | 四档默认态：**726/726、826/826、926/926、1006/1006 全部无滚动**（复现前端自报的 726/726）；**但** 1366×768 默认 `694/706` → 需滚动（12px）、1280×720 默认 `646/706` → 需滚动（60px），且 ⑦ 组头已在折线下。详见新缺陷 P3-N1 |
| **P3-3** 对比度 ≥ 4.5:1 | ❌ 不通过（5 处） | **✅ 通过** | 渲染后实算：placeholder **5.63**（`rgb(139,148,158)` on `rgb(21,27,35)`）；diff 行号 **5.52**（`rgb(139,148,158)` on `rgb(21,29,39)`，`.dn` ×14）；PDF meta **4.72**；PDF footer **6.25**；状态条级别数字 **6.72**（选中态 6.56）→ **5/5 达标** |
| **P3-4 / P3-5 / P3-6** | ❌ 三处不通过 | **✅ 通过** | ① `h1=1`，首个标题层级即 `H1`（「minipi 原型控制台」，`:662`）；② `<details>` 展开指示：`details.ctl > summary::before` 实测 `content` 关闭态 `"▸"` / 展开态 `"▾"`（渲染宽 8.56px），`#docpanel > summary::before` = `"▸"`（渲染宽 11px）；③ 抽屉 `role="dialog"` + `aria-modal="true"` + `aria-labelledby="drawerTitle"` + `tabindex="-1"`，打开时焦点进入抽屉（`activeElement=ASIDE#drawer`），`Esc` 关闭后**焦点归位到触发按钮**（`data-approval="write"`） |
| **P3-10** 自加项分组 + 反向检查 | ❌ 不通过 | **✅ 通过** | 渲染后的 `#maplist` 共 6 组 / 35 项：三处原误标项（合并卡批量动作 / 本日累计 $0.318 / 思考段只在大窗露出）现均在「**原型自加（文档未规定…）**」分组内、`tag="原型自加"`；`.rail` 组的「合并卡」条目已缩为「逐个勾选」（不再把批量动作算作 §3.3）。**§X 分组中未发现新出现的「自加却标成 §X」项** |
| **新增备注**（透明窗不能系统菜单/双击标题栏最大化） | （要求补） | **✅ 通过** | `:1151` 存在；打开说明面板后该项 `getBoundingClientRect` 宽高 > 0（`noteVisible=true`），文本含「**系统菜单**」「**双击标题栏**」与 `maximize()` spike 说明 |
| **整体回归** | — | **✅ 通过** | 报错 0（6 次运行，三类均 0）；`link=0 / script[src]=0 / img=0 / hasFetch=false / hasXHR=false / hasWS=false`；网络请求仅 `file:///…minipi-prototype.html` 自身 |

---

## 【二、回归发现（修复引入 / 未修完的新问题）】

### P2-N1（新）｜「本会话总是允许」设置开关是**死控件**：无事件绑定，勾选后卡片按钮不变，与自身说明文案矛盾

- **描述**：为响应 P1-6，前端把「本会话总是允许」从审批卡按钮降级为设置区复选框 `#optAlwaysAllow`（`:730`），并写了说明「**开启后**卡片会多一个可选项」（`:733`）。实测该复选框**没有任何事件监听**，`state.alwaysAllow` 恒为 `false`（`:1026` 初始化后**只在 `:1410` 被读取**，从未被赋值），因此 `:1411` 的第 4 个按钮是**不可达代码**。
- **复现步骤**：
  1. 打开页面 → 左栏 ④ 组内找到「启用「本会话总是允许」（设置项，默认关）」；
  2. 用真实鼠标点击该复选框；
  3. 点 ④ 组的 `edit · diff` 打开审批卡，读取 `#drawerBody [data-approve]` 文本。
- **实际结果**：`defaultChecked=false` → 点击后 `checked=true`（点击未被遮挡，`occluded=false`），但卡片按钮仍为 `["允许一次","拒绝","中断整轮"]`。
- **预期结果**：开启后卡片出现第 4 个可选按钮（或其说明文案改为「本原型未实现该开关」）。
- **影响范围**：仅评审/演示时点开该开关者；不会破坏主流程，但会让评审者以为「已支持会话级放行」。
- **证据**：
  ```
  # qa_v03_fix.json / alwaysAllowSwitch
  {"defaultChecked":false,"clickOccluded":false,"checkedAfterRealClick":true,
   "cardActionsWhenOn":["允许一次","拒绝","中断整轮"],
   "noteText":"关闭时卡片只有 §3.3 的三个 outcome。开启后卡片会多一个可选项；…"}
  # 代码定位（无 addEventListener 命中 'optAlwaysAllow'）
  minipi-prototype.html:1026  alwaysAllow: false,
  minipi-prototype.html:1410  if (state.alwaysAllow){        ← 只读
  minipi-prototype.html:1411  html += '…data-approve="always"…>本会话总是允许</button>';
  minipi-prototype.html:730   <input type="checkbox" id="optAlwaysAllow">
  # grep -n "optAlwaysAllow" → 仅命中 :730（markup）与 :733（文案），无任何脚本引用
  ```
- **修复建议**：给 `#optAlwaysAllow` 挂 `change` 监听（`state.alwaysAllow = e.target.checked; if (state.approval) render();`），并在其“唯一前缀匹配规则”未定义期间把文案改为「本原型仅示意，规则见审计 P2-03」。**或**在评审版直接删除该开关，避免出现一个按了没反应的控件。

---

### P2-N2（新）｜球右键菜单：指针仍停在球上时按 `Esc`，状态归位但**菜单视觉上不关闭**

- **描述**：`closeBallMenu()` 会把 `data-open` 与 `aria-expanded` 置 `false` 并 blur 焦点（`:2158-2166`），但 CSS 保留了悬停展开规则 `.ballwrap:hover .ballmenu{display:block}`（`:271-272`）。因此「右键 → Esc」这条最自然的路径下，菜单**仍然可见且可点**，与验收判据「`Esc` 关闭」不符。
- **复现步骤**：
  1. 切到球形态；
  2. 在球上右键（鼠标不要移开）；
  3. 按 `Esc`；
  4. 读取 `#ballMenu` 的 `data-open` / `getComputedStyle().display` / `getBoundingClientRect().height`，并用 `elementFromPoint` 取菜单中心命中的元素。
- **实际结果**：`data-open="false"`、`aria-expanded="false"`，但 **`display=block`、`height=178`、`elementFromPoint` 命中菜单内 `BUTTON`「打开大窗」**；`pointerOverBall=true`、`:focus-within=false`。
- **预期结果**：`Esc` 后菜单不可见（且不可点）。
- **影响范围**：所有用右键打开菜单后按 Esc 的用户；因菜单含「退出」项，存在误点风险（本原型仅 toast，无真实退出）。
- **证据**：
  ```
  # qa_v03_fix.json / ballMenuEscWhileHover
  beforeEsc: {"open":"true","disp":"block","h":178}
  afterEsc : {"open":"false","disp":"block","h":178,"expanded":"false",
              "pointerOverBall":true,"fw":false,"hitMenu":true,
              "hitTag":"BUTTON","hitText":"打开大窗"}
  # 代码定位
  minipi-prototype.html:271  .ballwrap:hover .ballmenu,
  minipi-prototype.html:272  .ballwrap:focus-within .ballmenu{ display:block; }
  minipi-prototype.html:274  .ballmenu[data-open="true"]{ display:block; }
  # 取证截图
  qa_v03_menu_open_before_esc.png（Esc 前，菜单可见）
  qa_v03_menu_after_esc_hover.png（Esc 后，指针未移开，菜单仍可见）
  ```
  > 对照：若先把指针移开再按 `Esc`，则 `display=none`、`height=0`（本条不是「Esc 完全无效」，而是「指针在球上时视觉不关闭」）。
- **修复建议**：`Esc` 关闭时同时抑制悬停展开（如关闭后给 `.ballwrap` 加一次性 `data-suppressed="true"`，`mouseleave` 后清除；或直接删除 `:hover` 展开规则，只保留 `data-open` 与 `focus-within`）。

---

### P3-N1（新）｜控制台在 1366×768 / 1280×720 默认态仍需纵向滚动，⑦ 组头落在折线下

- **描述**：P3-2 只在 4 个指定视口修好；我按要求压测的低高度档位重新出现滚动，且 1280×720 下需滚 60px 才能看到 ⑥ 组内容。
- **复现步骤**：`Emulation.setDeviceMetricsOverride` 设为对应分辨率，刷新后读 `.rail__body` 的 `clientHeight` / `scrollHeight`。
- **实际结果**：

  | 视口 | 默认态 client/scroll | 需滚动 | 折线下的分组 | 展开 ⑥ 后 client/scroll（溢出） |
  |---|---|---|---|---|
  | 1280×800 | 726 / 726 | 否 | 无 | 726 / 828（**102px**，⑥⑦ 折线下） |
  | 1440×900 | 826 / 826 | 否 | 无 | 826 / 828（2px） |
  | 1600×1000 | 926 / 926 | 否 | 无 | 926 / 926（0） |
  | 1920×1080 | 1006 / 1006 | 否 | 无 | 1006 / 1006（0） |
  | **1366×768** | **694 / 706** | **是（12px）** | **⑦** | 694 / 828（134px） |
  | **1280×720** | **646 / 706** | **是（60px）** | **⑦** | 646 / 828（182px） |

- **预期结果**：评审常用分辨率下 7 组均可见或至少无需滚动即可触达。
- **影响范围**：1366×768 是常见笔记本分辨率，演示时需滚动才能点到 ⑦；⑥ 的按钮滚入后仍可点（`occluded=false`，实测已应用空状态），故**不阻断**。
- **证据**：`qa_v03_rail.json`（`default` / `afterExpand6` 两组）；`qa_v03_layout.json → layout.1366x768.rail = {client:694, scroll:706, needsScroll:true}`。
- **修复建议**：把 ①–⑦ 的间距再压 10–20px（或 ② 组的 ballpick 改单列小尺寸），使默认 `scrollHeight ≤ 646`；或允许 ② 组默认折叠。

---

### P3-N2（新）｜新增备注的 tag 写作「额外 13」，全站无编号图例

- **描述**：`:1151` 的 tag 值为 `额外 13`，但全文再无其它「额外 N」，也没有任何地方说明「额外 13」指什么。评审者无法解读该编号。
- **证据**：`qa_v03_core.json → maplist` 中该条 `{"tag":"额外 13"}`；`grep -n "额外"` 仅命中 `minipi-prototype.html:1151`。
- **影响范围**：纯文案可读性。
- **修复建议**：改为 `原型自加` 或 `Electron 官方限制`。

---

### 观察（不计为缺陷）

- **「未聚焦窗口不刷新」条目**位于「原型自加」分组内，但 `tag="§1 · §9"`（`qa_v03_core.json → maplist`）。分组说“自加”、tag 说“对应 §1·§9”，口径略拧。**该条在 v0.2 就存在**，非本轮引入，仅记录。

---

## 【三、原通过项抽查（22 项，应任务要求 ≥12 项）】

> 全部为真实鼠标/键盘事件驱动；`occluded` 为 `elementFromPoint` 遮挡校验结果。

| # | 原通过项 | 结果 | 实测观察 |
|---|---|---|---|
| 1 | Ball 空闲态 | ✅ | `data-ball=idle`、caption「空闲」、自动回球形态 |
| 2 | Ball 思考中态 | ✅ | `data-ball=thinking`、caption「思考中」 |
| 3 | Ball 未读态 | ✅ | `data-ball=unread`、caption「未读」 |
| 4 | Ball 待确认态 | ✅ | `data-ball=await`、caption「待确认」 |
| 5 | Ball 拖动 | ✅ | `(776,618) → (896,558)`，toast「位置已记忆（M1-4：重启后球回到这里）」 |
| 6 | 拖动后不误触点击 | ✅ | 松手后仍 `mode=ball` |
| 7 | Mini `Enter` 发送 | ✅ | 输入框清空、提问入气泡、级别 0 →（300ms）→ 1 |
| 8 | Mini `Shift+Enter` 换行 | ✅ | 值 = `"A行\nB行"`（含换行）、未发送；对照无 shift 的 Enter 正常发送 |
| 9 | Mini `Esc` 收起 | ✅ | `mode=ball`，toast「Esc 收起 · 焦点归还到唤起前的窗口（§4.2）」 |
| 10 | 代码块「复制」 | ✅ | 流式结束后 `#streamCodeWrap` 显示、含 `[data-copy]`，点击后按钮文案→「已复制」 |
| 11 | Mini → Full（「⤢ 放大」） | ✅ | `mode=full` |
| 12 | Full → Mini（「⤡ 收起」） | ✅ | `mode=mini` |
| 13 | 长任务 7 级逐级跳转 0–6 | ✅ 7/7 | 每级 `aria-pressed` 与 `#stageNote` 均正确；联动 `3→await`、`4→full`、`5→unread`、`6→idle` |
| 14 | 「上一级」/「下一级」 | ✅ | 6→5 / 5→6 |
| 15 | 自动播放 | ✅ | 起始文案「停止播放」，2.6s 后到级别 1，停止后文案复原「自动播放」 |
| 16 | 场景切换 speed / study / work | ✅ 3/3 | 三场景表 cwd/工具/会话/权限四行随场景更新，`aria-pressed` 正确 |
| 17 | 边界：空状态 | ✅ | 「还没有对话。在任意 App 里选中一段文字…」 |
| 18 | 边界：加载中 | ✅ | 「正在连接 Pi 会话…（已等待超过 3 秒）」+ 8s 自动升级说明 |
| 19 | 边界：错误态 + 「重试」 | ✅ | 错误文案已换（见 P2-3）；「重试」→ toast「重试中…」并回到级别 0 |
| 20 | 错误态「复制错误详情」 | ✅ | 按钮存在、`occluded=false`、可点 |
| 21 | 「钉住」/「用这个项目打开」/「新会话」 | ✅ 3/3 | `#actLog` 分别出现对应说明；场景 `speed→study`、`→work` |
| 22 | 待确认态跨形态保持 | ✅ | level 3 时球 = `await`；`Esc` 关抽屉后仍 `await`（mini）；再 `Esc` 收球后 caption 仍「待确认」 |

**另附加 3 项专项**（针对 P1-4 重构可能引入的“陈旧渲染”）：

| # | 探测项 | 结果 | 实测观察 |
|---|---|---|---|
| 23 | 逐级 `setLevel` 后强制切回 mini，主体内容是否与级别一致 | ✅ 7/7 | level 0–6 切回 mini 后 `#miniBody` 首段与级别一一对应（0「正在思考」/1 流式/2「⚙read」/3「我读完了 src/train.py」/4「任务已超过 8 秒，已自动升级为大窗」/5 全答/6「已中断…」），无陈旧内容 |
| 24 | level 3 的 `#miniBanner` 与抽屉联动 | ✅ | level 3 → `miniBanner.hidden=false` 且抽屉打开 |
| 25 | 大窗会话树随切换更新 | ✅ | `#fullTree` 在 level 2/5 下均正常重建（非空、无陈旧报错） |

**抽查结论：22（+3）项全部仍通过，未发现由本轮修复引入的功能性回归。**

---

## 【四、与前端自报数据的差异（以我的实测为准）】

| 项 | 前端自报 | 我的实测 | 说明 |
|---|---|---|---|
| P1-4 长度序列 | 任务书转述「46 → 66 → 86 → 108」；但其自留文件 `v03_result.txt` 记的是 `46→66→86→106` | **50 → 76 → 98 → 122** | 采样时刻不同导致绝对值不同（流式每 22ms +2 字），**单调不减的结论一致**。另：其自报数据自身不一致（108 vs 106） |
| P3-2 1280×800 | 726/726 无滚动 | **726/726 无滚动（fresh 载入实测一致）** | 一致；我在另一种状态下另测得 706/726，两种状态均 ⇒ 无滚动 |
| P3-5 `<details>` 指示 | `v03_result.txt` 记 `docpanelMarker:"none"`、`detailsCtlMarker:"none"` | `#docpanel > summary::before` = `"▸"`（宽 11px）；`details.ctl > summary::before` = `"▸"/"▾"`（宽 8.56px） | 其首轮脚本取的是 `<details>` **自身**的 `::before`（CSS 规则写在 `> summary` 上），属**其测试脚本缺陷导致的假阴性**；`v03b.txt` 改对选择器后也得 `"▸"` |
| 折叠组可展开 | `v03b.txt` 记 `p32_collapse.expand6:false` | **⑥ 可正常展开**，展开后 `[data-boundary="empty"]` 真实点击 `occluded=false` 且生效 | 其 `false` 属其脚手架时序问题 |
| 第二次提问重置 | `v03_result.txt` 首次 `resetOk:false` → 后续 `v03b` 改测 `resetAndStreaming:true` | **通过**（含流式中途重发的补测） | 与我一致 |

---

## 【五、验收标准核对】

| 验收标准（任务书第 1–12 条） | 结论 | 依据 |
|---|---|---|
| 1. P1-4 单调不减 + 同一轮 | **通过** | 50→76→98→122，气泡保留 |
| 1b. 第二次提问重置 | **通过** | 60ms 时旧答清空、760ms 从头流式；流式中途重发亦成立 |
| 2. P2-2 右键菜单（打开/Esc/空白/移开/菜单项） | **部分通过** | 开、空白关、移开仍开、菜单项可点均达标；**指针在球上时 Esc 视觉不关**（P2-N2） |
| 3. P1-6 按钮集合 + 中断整轮行为 | **通过** | 三卡恰好三按钮；batch 四按钮 + 未勾选语义；中断真生效（level 6 / 抽屉关） |
| 4. P2-3 无 sidecar 概念 | **通过** | 三个违禁串 0 命中 |
| 5. P2-4 study 无 edit | **通过** | 权限行与工具集均不含 edit |
| 6. P3-1 四档 7 级可见可点 | **通过**（另加测 1366×768、1280×720） | 6 档全部 7 级 `fully` + `hitInside`，点 6 级命中自身 |
| 7. P3-2 四档无滚动 + 压一档未测分辨率 | **部分通过** | 四档无滚动；**1366×768 / 1280×720 需滚动**（P3-N1） |
| 8. P3-3 五处 ≥4.5:1 | **通过** | 5.63 / 5.52 / 4.72 / 6.25 / 6.72 |
| 9. P3-4/5/6 | **通过** | h1=1；▸/▾ 可见；dialog + aria-modal + 移焦 + Esc + 焦点归位 |
| 10. P3-10 三处移位 + 反向检查 | **通过** | 三处均在「原型自加」组；§X 组无新误标 |
| 11. 新增备注 | **通过** | `:1151` 存在且可见，含「系统菜单」「双击标题栏」 |
| 12. 整体回归 + 抽查 ≥12 项 | **通过** | 报错 0；自包含；抽查 22（+3）项全通过 |

---

## 【六、测试结论】

**当前 v0.3 可以作为交互基线交付给产品负责人评审 —— 但需附带 2 条 P2 已知问题一同呈报。**

理由：

1. 上一轮 12 组缺陷中，**9 组完全修好**（P1-4 主项与其追加回归、P1-6 按钮与中断行为、P2-3、P2-4、P3-1、P3-3、P3-4/5/6、P3-10、新增备注），**3 组部分修好**（P2-2、P3-2，以及顺带发现的 P3-N1）。
2. **没有引入 P0/P1 级回归**：原 47 项里抽查的 22（+3）项全部仍通过；6 次独立运行控制台报错为 0；自包含性完好。
3. 修复引入的 4 条新问题全部集中在**非主流程**（一个设置开关、一个菜单关闭路径、低高度分辨率滚动、一个 tag 文案），**均不阻断评审演示**，但 P2-N1 的「死开关」与 P2-N2 的「Esc 不关菜单」会被评审者当成产品行为记下来，建议**在评审前顺手修掉**（两处改动都很小）。

**若要「零已知缺陷」再交付，还差 2 件事**：修 P2-N1（给 `#optAlwaysAllow` 挂 `change` 监听或删除该开关）、修 P2-N2（`Esc` 关闭时抑制 `:hover` 展开）。P3-N1 / P3-N2 可留待评审后处理。

---

## 【七、仍需标注为「无法验证」的项】

1. **「本会话总是允许」第 4 个按钮被点击后的行为**——该按钮在当前代码中不可达（P2-N1），因此其点击语义与「唯一前缀匹配规则」无法验证。
2. **1366×768 / 1280×720 的真实窗口表现**——我在 headless + `Emulation.setDeviceMetricsOverride` 下测得；未在真实物理窗口、真实系统缩放（125%/150%）下复核。
3. **`Esc` 关闭菜单的产品口径**——判据写的是「Esc 关闭」，我按「视觉关闭 + 不可点」判定不通过；若产品认为「指针停留在球上时保持悬停展开」是预期行为，则本条应降级为「文案/交互口径待定」。
4. **P1-4 在真实 WS 流下的「不重连」**——单文件原型无 WS，「不重连」仅体现在文案；本轮只验证了「不重放 / 不残留旧答案」这一面（沿用上一轮 B6 第 8 项）。
5. **以下与 v0.3 修复无关的项仍沿用上一轮的「无法验证」结论**：未聚焦窗口渲染节流、`SetForegroundWindow` 焦点归还与插入符恢复、全屏自动隐藏/多屏/托盘/开机自启、`Alt+Shift+Space` 抓选区三级降级链、框选截图入对话、8s 自动升级的计时起点与手动收起覆盖分支、审批 5 分钟超时的真实计时、真实 Pi SDK 调用与真实审批阻塞、大窗模型下拉切换后的行为、WebView2 / 触摸贴边吸附 / 125% 缩放下 360×480 可用性。

---

## 【八、测试数据清理与文件完整性】

**测试数据清理**：

- 本轮**未向项目目录（`docs/` / `prototype/` / `qa/`）写入任何数据**——`pretest_` 前缀输入仅存在于浏览器页面内存，未落盘、无残留。
- 全部脚本、截图、JSON 结果位于系统临时目录 `C:\Users\yang6\AppData\Local\Temp\minipi_qa\`，并在 `%TEMP%\minipi_qa_prof_qa_*`、`minipi_qa_prof_layout_*`、`minipi_qa_prof_fix_*`、`minipi_qa_prof_rail_*`、`minipi_qa_prof_stale_*`、`minipi_qa_prof_final_*` 下残留临时 Chrome profile（未清理，可由主理人知情后删除；未触及项目目录）。
- 本轮**未新增、未修改项目内任何文件**；本报告独立存放在临时目录（见下），如需归档到 `qa/` 目录请告知——因任务书要求「`qa/` 不要动」，我未擅自写入。

**项目目录现状（实测，未被本轮改动）**：

```
D:\SAiProject\minipi\docs
  minipi-audit.md            73873B   2026-09-22T10:27:40 (local)
  minipi-plan.md             30698B   2026-09-21T17:36:09 (local)
D:\SAiProject\minipi\prototype
  minipi-prototype.html     117955B   2026-09-22T10:48:40 (local)   ← 被测文件，v0.3
D:\SAiProject\minipi\qa
  minipi-qa-report.md        73067B   2026-09-22T10:23:33 (local)
（三个目录内无其它文件，前端未在项目内留下临时产物）
```

**被测文件完整性证据**（本轮会话首尾两次读取，指纹一致 ⇒ 未被修改）：

```
prototype/minipi-prototype.html | 117955B | 2215 行 | sha256=239ab1383596479d…  | mtime=2026-09-22T02:48:40Z
  ├─ 会话开始读取（Node/PowerShell 探测）：size=117955, sha256=239AB1383596479DCB93477CA2AB40CEADD3F80A283715A8B10100392F747BAF
  └─ 会话结束读取（qa_v03_finalcheck.js）：size=117955, sha256=239ab1383596479d…
```

**本报告路径**：`C:\Users\yang6\AppData\Local\Temp\minipi_qa\minipi-v03-regression-report.md`
