# minipi · Electron 透明窗口 spike 套件

> **一句话目的**：用一条命令，在**你自己的机器**上实测 `docs/minipi-plan.md` §11【开工门禁】序 7 的 4 件不确定项，跑完自动产出 JSON 报告 + 截图，**用来关闭开工前最后一个门禁**。

这套件**只做测量、不做产品代码**。它不引入 minipi 的任何包，也不依赖 Pi SDK。

---

## 1. 如何运行

前置：**Node ≥ 22.19.0**（`node -v` 自查）、Windows 桌面会话（透明窗口 + `capturePage` 需要有真实桌面）。

```bash
cd D:\SAiProject\minipi\spike\electron-window
npm install          # 只装 electron 44.4.3（约 100+MB，首次会下载二进制）
npm start            # = electron .  → 自动跑完 4 项，打印结论，退出
```

跑完产物在 `spike/electron-window/out/`：

```
out/report.json                     机器可读的完整结论（含每次采样的原始像素、耗时、计数）
out/01-ball-48x48.png               透明球窗 48×48
out/02-mini-360x480.png             变形到 Mini
out/03-full-960x680.png             变形到 Full
out/04-back-to-48x48.png            缩回球
out/05-visual-check-crop.png        视觉核对：球窗区域的屏幕截图（底下压了纯品红背板）
out/06-after-maximize.png           maximize() 之后
out/07-probe-A-occluded.png         节流探针被遮挡时的样子
```

可选参数：

```bash
npm run spike -- --sec 5              # 每次节流测量 5 秒（默认 3 秒）
npm run spike -- --skip-visual        # 跳过 desktopCapturer 视觉核对
npm run spike -- --out D:\somewhere   # 报告与截图换个目录
npm run spike -- --timeout 200000     # 兜底超时（默认 150s；超时也会留下报告）
```

**静态校验（不启动 Electron，可在任何环境跑）**：

```bash
npm run check            # 41 项：语法 / ESM 纯度 / import 可解析 / 资源存在 / HTML 自包含 …
npm run check:online     # 外加 1 项：向 npm registry 核对 pinned 的 electron 版本真的存在
```

---

## 2. 4 项测什么、观察什么

### T1 · 透明窗口 `setBounds` 是否掉透明

- **做了什么**：建一个 `frameless + transparent + alwaysOnTop + backgroundColor:#00000000` 的 48×48 球窗 → 依次 `setBounds` 到 `360×480`、`960×680`、再缩回 `48×48` → **每次都用 `capturePage()` 读像素，检查四角 alpha 是否为 0**；同时记每次变形的耗时（`setBounds` 同步耗时 + 到首帧重绘的总耗时）与「疑似一帧白」的间接信号。
- **额外两道保险**：
  1. **方法自检**（`methodControl.alphaSensitive`）：先在**静止的** 48×48 上采一次。如果连静止的透明球窗四角都不是 alpha=0，说明 `capturePage` 在本平台**根本不保留 alpha**，那就不能用它下结论 —— 报告会把 T1 结论标成 `null`（不可判定），并让你改看第 2 条。
  2. **背板视觉核对**（`visualBackdropCheck`）：在球窗正下方压一个**纯品红 `#FF00FF`** 的不透明窗口，然后用 `desktopCapturer` 截屏、裁出球窗那一块，看**四角像素是不是品红**。这是不依赖 `capturePage` alpha 的独立证据。
- **附带**：会再把 `resizable` 打开（官方警告 `transparent` 窗口设 `resizable:true` 可能失效）后 `setBounds` 一次，看透明是否还在 —— 这决定「Mini 要不要允许用户拖边缩放」。

**怎么判读**

| 结果 | 含义 |
|---|---|
| `T1_transparentSurvivesSetBounds === true` 且 `visualBackdropShowsThrough === true` | ✅ **通过**：单窗口三态变形方案在本机成立，M1 可以按「一个窗口实例三态」写 |
| `maxCornerAlpha > 0`（某一角不透明） | ❌ **不通过**：`setBounds` 掉了透明 → 单窗口三态不成立，窗口层要改成「球/小窗一个透明窗 + 大窗一个不透明窗」两窗口方案（仍共用单一 store + `seq`） |
| `methodControl.alphaSensitive === false` | ⚠️ **方法不可用**：`capturePage` 采不到 alpha。**不代表透明掉了**。以 `visualBackdropShowsThrough` 与人眼看 `03-full-960x680.png` 四角为准 |
| `totalMsToFirstRepaint` | 不设硬阈值，**看一眼**：> 100ms 就要考虑变形加过渡（或先隐藏再改尺寸） |
| `whiteFlashProbe.looksLikeOpaqueWhite === true` | ⚠️ 变形瞬间可能闪了一帧白（间接指标，`capturePage` 本身有几 ms 延迟，只能当线索） |
| `resizableProbe.cornersAllTransparent` | `true` ⇒ Mini 允许用户拖边；`false`/`null` ⇒ 只能程序化 `setBounds`，或 Mini 也不允许用户缩放 |

---

### T2 · 透明窗口能否用 `maximize()` API

- **做了什么**：对那个透明窗口调 `win.maximize()`，捕获是否抛错，比对 `getBounds()` 与显示器 `workArea`，并读 `isMaximized()`。之后 `unmaximize()` 复原。
- **背景**：Electron 官方 Limitations 只禁止了「**系统菜单**」与「**双击标题栏**」两条最大化路径；程序化 `maximize()` 未被禁 —— 这条正是要现场验的。

**怎么判读**

| 结果 | 含义 |
|---|---|
| `threw === null` 且 `fillsWorkArea === true`（或至少 `grew === true`）且 `isMaximized === true` | ✅ **通过**：Full 态可以给一个「最大化」按钮，直接调 `maximize()` |
| `threw === null` 但窗口没变大（`grew === false`） | ❌ **静默无效**：调用被忽略，等同于不可用 → Full 态不做最大化，或自绘一个「铺满工作区」的伪最大化（自己 `setBounds` 到 `workArea`） |
| `threw !== null` | ❌ **不可用**：同上，走伪最大化 |

> 顺带记了 `cornersAllTransparentAfterMaximize`：最大化之后透明是否还在。

---

### T3 · 未聚焦 / 被遮挡窗口的渲染节流（**M0 硬指标**）

- **做了什么**：开两个探针窗，除了 `webPreferences.backgroundThrottling` 一个 `false` 一个 `true` 之外**完全一样**。分别在这两种条件下，用页面里的 `requestAnimationFrame` + `setInterval(…, 100)` 数 3 秒内的真实回调次数：
  1. **可见但未聚焦**（焦点被第三个窗口拿走，探针不被遮挡）
  2. **被遮挡且未聚焦**（一个不透明的 `alwaysOnTop` 窗口完全盖住探针）
- **为什么重要**：独立 App 里小窗很快就是「未聚焦/被盖住」的状态，Chromium 对不是前台的窗口会降低渲染与定时器频率 —— 那正是「答案在流式输出，界面上却卡住不动」的成因（§1 难点 2）。

**怎么判读**

| 结果 | 含义 |
|---|---|
| `occludedUnfocused.B_throttlingTrue.rafTicks` 明显小于 `A_throttlingFalse.rafTicks`（经验上差一个数量级） | ✅ **问题真实存在**：M0 必须处理，不能指望它自己好 |
| `occludedUnfocused.A_throttlingFalse.rafTicks` 仍接近 `60 × 秒数` | ✅ **`backgroundThrottling:false` 有效**：M0-3 的修法成立 |
| 两个窗口在被遮挡时 `rafTicks` 都接近 0 | ⚠️ **修法不够**：`backgroundThrottling:false` 在本平台挡不住「遮挡即停画」→ 需要补 `setInterval` 兜底驱动渲染，或改用 `webContents.setBackgroundThrottling()`（见 T4） |
| 两个窗口 `rafTicks` 差不多 | ⚠️ 本机**没触发节流**（可能没真的被遮挡，或系统关掉了「遮挡优化」）→ 在 `report.json` 里核对 `pageVisibility` / `pageHasFocus` / `info`；仍拿不准就多跑几次 |
| `interval100msTicks` 从 ~30 掉到 ~3 | 说明定时器也被压到 1 次/秒 —— 这是「等审批 5 分钟超时」这类逻辑必须用主进程时钟、不能靠渲染进程 `setTimeout` 的直接理由 |

> **只记录次数，不设绝对门槛**。请按你自己机器上的实测填 `RESULT-TEMPLATE.md`。

---

### T4 · 运行期 `setBackgroundThrottling()` 是否生效

- **做了什么**：在被遮挡的探针 A 上，依次 `webContents.setBackgroundThrottling(true)` → 测 3 秒；`setBackgroundThrottling(false)` → 再测 3 秒；读出 `getBackgroundThrottling()`；再拿构造期就是 `true` 的探针 B 做对照。

**怎么判读**

| 结果 | 含义 |
|---|---|
| `runtimeToggleEffective === true`（开 → 关之后 `rafTicks` 明显回升） | ✅ **是一等 API**：可以「小窗可见时关掉节流，收起到球之后打开省电」（对应 P1-01 的功耗取舍） |
| `api === { onWebContents: false }` 或 `afterSetXxx.call` 是 `throw:…` | ❌ 不支持 → 只能在**构造期**定 `webPreferences.backgroundThrottling`，收起到球只能靠**隐藏窗口**（隐藏时本来就不画，也算省电） |
| `afterSetTrue.getter` / `afterSetFalse.getter` 与设置值不一致 | ⚠️ getter 与 setter 不同步 → 别用 getter 当状态源，自己记 |

---

## 3. 目录结构

```
spike/electron-window/
├─ package.json            "type":"module"、electron 精确 pin 44.4.3、engines.node >=22.19
├─ main.mjs                ESM 主进程（这本身就是「主进程走 ESM」这条约束的验证物）
├─ lib/
│  ├─ pixels.mjs           NativeImage -> BGRA 角像素/中心像素采样 + 判据
│  └─ util.mjs             sleep / 事件等待 / 等重绘 / 截图落盘 / 参数解析
├─ renderer/
│  ├─ ball.html            球窗内容（页面自身透明、四角不绘制）
│  ├─ probe.html           rAF + setInterval 计数探针（暴露 window.__probeStart(ms)）
│  └─ plain.html           纯色辅助窗（背板 / 遮挡窗 / 抢焦点窗，颜色与标签走 query）
├─ scripts/selfcheck.mjs   静态校验（不启动 Electron）
├─ README.md               本文件
└─ RESULT-TEMPLATE.md      跑完把 4 条结论填进去即可回填门禁表
```

窗口布局（都落在主显示器工作区内，互不重叠）：

```
workArea
┌──────────────────────────────────────────────────────┐
│ (+40,+40) [球窗 48×48 透明]                          │
│                                                      │
│ (+40,+260) [探针A 420×260 bt=false]   [探针B bt=true]│
│                                                      │
│ (+40,+560) [抢焦点窗 300×120]                        │
└──────────────────────────────────────────────────────┘
```

---

## 4. 已知边界（这套件不做什么）

- **不碰产品代码**：不改 `vendor/pi/`、`docs/`、`qa/`，也不引入 minipi 的任何包。
- **不验 §11 门禁序 7 里那两个「顺带项」**：`session.navigateTree()` 忙时行为、`tool_call` 的 `terminate`/`reason` 真实语义 —— 那两个要跑真实 Pi SDK（`vendor/pi/`），属另一条 spike 线（需 `~/.pi/agent/auth.json`），本套件刻意不碰，避免把宿主问题与 SDK 问题混在一份报告里。
- **`transparent` + `roundedCorners`**：Win11 Build 22000 以下圆角无效、DWM 关闭时透明失效 —— 这两个是**前提**，不是本套件的测量对象；报告里记了 `windowsVersion` 供你对号。
- **`--skip-visual` 之外，`desktopCapturer` 也可能失败**（无桌面会话 / 截图被策略拦）。失败不会中断流程，会记进 `report.json` 的 `errors`，并把 `visualBackdropCheck.failed = true` 写清楚。
- 视觉核对的 `05-visual-check-crop.png` 是**真实屏幕截图**（只裁球窗那一块）。它可能包含球窗背后桌面的一小块内容 —— 不想留就直接删 `out/`。

---

## 5. 结果怎么回填

跑完打开 `out/report.json`，按 `RESULT-TEMPLATE.md` 的表填 4 行，然后把那张表贴进 `docs/minipi-plan.md` §11【开工门禁】序 7 的「产出 / 关闭状态」两列。

**核心结论只有一句**：`summary.T1_transparentSurvivesSetBounds`。
- `true` → §4.3「单窗口三态变形」可以按原方案推进，门禁序 7 关闭，M1 解锁。
- `false` → 窗口层改双窗口方案（§4.3 的备选），M1 的任务清单要改，但仍可关闭序 7 —— 因为「单窗口能不能成立」这个问题已经有答案了。

> 判定口径统一为三种：**已验证（本次实测）** / **未验证（本次没测到）** / **需要再看**。不写没有依据的结论。
