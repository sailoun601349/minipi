# spike 结论回填表 · 门禁序 7a（Electron 窗口物理）

> **本表已于 2026-09-22 实测回填 **（不是空白模板）。原始数据见 `out/report.json`，截图见 `out/*.png`。
> 复现命令：`cd spike/electron-window && npm install && npm start`（见文末「复现注意」）。

## 0. 运行环境（结论只在这台机器上成立）

| 项 | 实测值（抄 `report.env`） |
|---|---|
| 日期 | 2026-09-22 |
| Windows 版本（`report.env.windowsVersion` / `osRelease`） | `10.0.22631`（Win11 23H2）；⚠️ `osVersion` 字段报的是 `"Windows 8.1 Single Language"`，是 Electron `os.version()` 在本机的**错值**，不要采信该字段 |
| Electron（`report.env.electron`） | `44.4.3` |
| Chrome（`report.env.chrome`） | `152.0.7977.130` |
| Node（`report.env.node`，`nodeEngineOk`） | `24.21.0`（Electron 内置），`nodeEngineOk = true` ✅ |
| 显示器（`report.displays`） | 单屏：`bounds 1707×1067`、`workArea 1707×1019`、`scaleFactor 1.5`、`rotation 0`、primary |
| 是否远程桌面 / 虚拟机 / 无桌面会话 | **有真实桌面会话**（`desktopCapturer` 成功返回 `"整个屏幕"` 2561×1601）；未声明远程桌面/虚拟机 |
| 主进程是否 ESM（`report.env.mainProcessEsm`） | `true` ✅（`package.json` 是 `"type":"module"`、入口 `.mjs`、全程 `import`） |

## 1. 四项结论

| 序 | 测什么 | 报告字段 | 实测值 | 判定 | 一句话结论 |
|---|---|---|---|---|---|
| **T1a** | 透明窗口 `setBounds` 是否掉透明 | `T1.verdict.transparentSurvivesSetBounds` / `.maxCornerAlphaAcrossSteps` | `true`；四角最大 alpha **0**（四步全 `[0,0,0,0]`） | ✅ **通过** | 48×48 → 360×480 → 960×680 → 48×48 全程透明幸存，**单窗口三态方案成立** |
| **T1b** | 背板色是否透出来（独立视觉核对） | `T1.verdict.visualBackdropShowsThrough` / `T1.visualBackdropCheck.corners` | 自动化 `false`（四角只有 `bottomRight` 是品红 `237,0,253`，其余是灰 `29,29,29`/`61,61,61`）；**人工看 `05-visual-check-crop.png`：品红从卡片上/左/右三边与右侧条带清晰透出** | 🤔 **自动化失败，人工判读=通过** | 品红背板确实透过透明区 ⇒ 透明完好。自动化的「四角全是品红」判据被裁剪对位破坏，**不要采信 `visualBackdropShowsThrough=false`** |
| **T1c** | 每次变形耗时（ms） | `T1.verdict.msPerTransform` / `T1.steps[*]` | `setBoundsSyncMs` = **5.49 / 7.64 / 5.71 / 3.20**；`totalMsToFirstRepaint` = 2025.9 / 2050.4 / 2013.0 / 2042.5（**≈2000 是 `once(resize)` 超时值，不是真实耗时**）；`resizeEventFired` 四步全 **false** | ⚠️ **需再看** | 同步代价 **3.2–7.6 ms**，无白闪（`looksLikeOpaqueWhite` 全 false）。**但 `resize` 事件 2 秒内一次没来**，且 `actualBounds` 有 **1px 圆整偏差**（360→361、960→961）⇒ M1 不得拿 `resize` 当「变形完成」信号 |
| **T2** | 透明窗口能否用 `maximize()` | `T2.result` | `threw = null`；`960×680 → 1708×1020` ≈ workArea；`grew = true`、`fillsWorkArea = true`；**`isMaximized = false`**；**`unmaximize()` 后 bounds 仍是 1708×1020** | ✅ **可用（语义不完整）** | 程序化 `maximize()` 未抛错、窗口确实铺满；但 `isMaximized()` 报 false 且 `unmaximize()` 回不去 ⇒ **不要做成开关式按钮** |
| **T3a** | 未聚焦/被遮挡是否真的会节流 | `T3.occludedUnfocused.*.rafTicks` / `T3.verdict.problemReal` | 被遮挡+未聚焦 3s：**A(`bt=false`) raf = 181**（60.3/s）vs **B(`bt=true`) raf = 0**（`visibilityState:"hidden"`）；比值 **181:0** | ✅ **通过（问题真实存在）** | §1 难点 2 实锤：被遮挡即**完全停画**。注意「可见但未聚焦」不节流（A/B 均 ≈181） |
| **T3b** | `backgroundThrottling:false` 是否顶住遮挡 | `T3.occludedUnfocused.A_throttlingFalse` / `T3.verdict.fixWorks` | `A(bt=false)` 在**被遮挡**下 raf 仍 **181**（全速），`interval` 仍 30 | ✅ **通过** | `backgroundThrottling:false` 确实把「遮挡即停画」关掉了 ⇒ M0-4 硬指标可达 |
| **T4** | 运行期 `setBackgroundThrottling()` 是否生效 | `T4.verdict.runtimeToggleEffective` / `T4.afterSetTrue|False.measure` | API 存在（`onWebContents=true`、`getterAvailable=true`）；getter 如实反映（false→true→false）；**但实测 raf：setTrue=181、setFalse=181、参照窗口(construct true 且被遮挡)=0** | 🤔 **不可判定**（不是「不生效」） | setter/getter **是一等 API 且状态正确**；但本轮测量窗口**没被真正遮挡**（`visibilityState` 全程 `visible`），两轮都 181 无法区分 ⇒ 保守取**构造期**设定 |

## 2. 附加观察

| 项 | 报告字段 | 实测值 | 说明 |
|---|---|---|---|
| `capturePage` 是否保留 alpha（方法自检） | `T1.methodControl.alphaSensitive` | **`true`** | 静止 48×48 上四角 alpha=0 ⇒ **T1a 判据可信**，无需只靠 T1b |
| 变形瞬间是否疑似白闪 | `T1.steps[*].whiteFlashProbe.looksLikeOpaqueWhite` | 四步全 **`false`** | 无白闪迹象（间接指标） |
| `resizable:true` 时透明是否还在 | `T1.resizableProbe.cornersAllTransparent` | **`true`**（`420×520` 时四角 alpha=0） | Mini 允许用户拖边在透明层面是安全的 |
| 最大化后透明是否还在 | `T2.result.cornersAllTransparentAfterMaximize` | **`true`** | 铺满后仍透明 |
| 定时器是否也被压到 1 次/秒 | `T3.occludedUnfocused.*.interval100msTicks` | `bt=true` 遮挡下 **3**（≈1/s）；`bt=false` 遮挡下 **30**（10/s） | ⚠️ **重要**：节流会把页面内 `setInterval` 压到 1 次/秒 ⇒「**审批 5 分钟超时**」**不能用渲染进程计时**，必须主进程计时 |
| 跑过程中的异常 | `report.errors` | **`[]`（0 条）** | 无 |

## 3. 对方案的影响（已勾选）

- [x] **T1a 通过** → §4.3「单窗口实例三态变形」按原方案推进；M1 任务清单不变。
- [ ] ~~T1a 不通过 → 改双窗口~~（不适用）
- [x] **T2 通过** → Full 态可以有「铺满」，**但按结论改为自绘伪最大化**（自己 `setBounds` 到 `workArea` + 自持状态位），不用 `maximize()/unmaximize()` 做开关。
- [ ] ~~T2 不通过~~（不适用）
- [x] **T3a 问题真实 + T3b 有效** → M0-3 按「`webPreferences.backgroundThrottling:false` + rAF 驱动」实施；M0-4 硬指标口径不变。
- [ ] ~~T3b 无效~~（不适用）
- [ ] ~~T4 生效 → 运行期开关节流~~（**本轮不可判定**，暂不采纳）
- [x] **T4 不可判定** → 取保守写法：**构造期**就设 `backgroundThrottling:false`；运行期切换不作为依赖，M0 内补测。

## 4. 一句话总结（已同步进 `docs/minipi-plan.md` §11 门禁表）

```
序 7a · Electron 窗口物理 spike 结论（2026-09-22，Windows 10.0.22631 / Electron 44.4.3 / Chrome 152 / dpr 1.5 / 单屏 1707×1067）：
① 透明 setBounds：通过（四角最大 alpha = 0；视觉核对自动化失败但人工看 05-*.png 品红三边透出 ⇒ 透明完好）
② maximize()：可用但不完整（未抛错、铺满 workArea；但 isMaximized=false、unmaximize 无效 ⇒ 改自绘伪最大化）
③ 未聚焦节流：问题真实（遮挡下 raf 181:0）且 backgroundThrottling:false 有效（遮挡下仍 181）
④ 运行期 setBackgroundThrottling()：不可判定（API 与 getter 正常，但本轮窗口未被真正遮挡）
＋ resize 事件在 setBounds 后 2s 内未触发，且尺寸有 1px 圆整偏差 ⇒ M1 不得依赖 resize 事件
→ 单窗口三态方案：成立，按原方案推进
→ 门禁序 7a：已关闭；M1 窗口变形可启动（附上述 3 条实现约束）
```

## 5. 未验证项（如实列）

```
- T4 运行期切换：不可判定（测量窗口未被真正遮挡）。→ 需要在 M0 里用一个「确定被遮挡」的场景补测。
- desktopCapturer 视觉核对的自动化四角判据失效（裁剪对位问题），T1b 依赖人工读图，未修复判据本身。
- 真实物理窗口 + 系统缩放 125% / 150% 下的 Mini 360×480 可用性：未测（本机 dpr = 1.5）。
- 多屏 / 跨屏拖动 / 在非主屏唤起：未测（本机单屏）。
- 远程桌面 / 虚拟机下的透明行为：未测。
- 触摸板贴边吸附、WebView2 行为：未测。
- F11b/§11 的 SDK 顺带项（navigateTree 忙时行为、tool_call 的 terminate/reason 语义）：已由 spike/pi-sdk 的 live 覆盖，见其 RESULT-TEMPLATE。
```

## 6. 复现注意（本次实际踩到的两个坑）

1. **Electron 二进制下载**：本机 npm 走 `registry.npmmirror.com`，但 Electron 的二进制默认从 GitHub 取。`npm install` 会「成功」却不装二进制（`node_modules/electron/dist` 缺失）。解法：
   `$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"; node node_modules/electron/install.js`
2. **`ELECTRON_RUN_AS_NODE` 污染**：本机环境里存在这个变量，会让 `electron .` 退化成纯 Node 执行，报
   `SyntaxError: The requested module 'electron' does not provide an export named 'BrowserWindow'`。**跑之前必须清掉**：
   `Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue`
   → 这条对 M0 的启动脚本是硬要求。
