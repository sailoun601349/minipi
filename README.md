# minipi

常驻桌面的 Pi 悬浮球（Electron 宿主层 + Pi SDK 接线）。

本期交付范围：**M0（能跑起来、能流式说话、未聚焦不停画）+ M1 核心（三态变形 / 全局热键 / 场景 / 设置持久化）**。

> 本仓库当前状态：**宿主层已完成并可独立验证**；渲染层（`src/renderer/`）由前端并行交付，宿主层在它到位前会加载 `scripts/probe/stub.html` 兜底探针页，功能与自测不受影响。

---

## 1. 快速开始

```bash
# 1) 装依赖（本机 npm 走 npmmirror；Electron 二进制需镜像，见 §8）
npm install
```

### 日常使用：双击 `minipi.cmd`

装完依赖后，**双击仓库根目录的 `minipi.cmd`** 即可 —— 这是**唯一**的双击入口。

启动壳只有三行，逻辑全在 `scripts/launch.mjs`（所以它可以被 `node scripts/launch.mjs` 直接复现和验证）：

```
minipi.cmd  →  node scripts/launch.mjs  →  detached 拉起 node_modules/electron/dist/electron.exe .
```

`launch.mjs` 做四件事：建 `~/.minipi/logs` → 解析 electron 二进制 → 清掉
`ELECTRON_RUN_AS_NODE` → **detach 拉起 Electron 后立刻退出**。退出得快，所以黑框只闪
一下；Electron 自己活得比它久，stdout/stderr 直接落进 `~/.minipi/logs/launcher.log`
（超 1 MB 轮转 `.old`）。启动壳退出码非 0 会 `pause`，不会静默失败。

> **启动壳必须保持纯 ASCII + CRLF。** 这里是三次「双击弹出编译错误框」换来的教训：
> 最早用的 `.vbs` 由工具写成「UTF-8 无 BOM + 中文」，而 WSH 在没有 UTF-16 BOM 时按
> 系统 ANSI 码页解码，于是中文被当 GBK 解，抛 `800A0409` / `800A0401` —— 一行都没跑到；
> 改成纯 ASCII 后又踩到 VBScript 的 `800A0414`（`Sub` 配括号 + 多参）。
> `.cmd` 没有这两类陷阱，`npm run verify:launcher` 里有对应硬门禁。

### 开发调试：`npm start`

```bash
npm start            # = node scripts/start.mjs
npm run launch       # 只跑启动壳，不经过 .cmd
```

`npm start` 走 `scripts/start.mjs`，它会先清 `ELECTRON_RUN_AS_NODE` 再 spawn electron
（**WorkBuddy / 沙箱终端里该变量会被注入**，带着它跑会让 Electron 退化成纯 Node，
`import { BrowserWindow } from "electron"` 直接失败）。双击场景没有这个变量，
`launch.mjs` 里清它只是防御。

> **本机必须关掉 GPU 进程自己的 sandbox**，否则双击就是「闪退」。Electron 主进程能跑到
> `app.whenReady()`、窗口也建了，但 GPU 子进程反复以 `exit_code=-1073741819`
> （`0xC0000005`）退出，几轮重试后 Chromium `FATAL ... GPU process isn't usable. Goodbye.`
> 把整个 App 带走 —— 从启动到消失约 1 秒。实测 `--disable-gpu` / `--in-process-gpu` /
> `--use-gl=swiftshader` 都救不了；`--no-sandbox` 能起但连带关了渲染进程的 sandbox，
> 代价过大。最终在 `src/main/index.js` 里注入 `disable-gpu-sandbox`（**保留硬件加速**，
> 这对透明窗很关键）。要恢复默认行为就设 `MINIPI_KEEP_GPU_SANDBOX=1`。

启动后：

- 桌面右下侧出现一个 **48×48 的悬浮球**（默认形态 `ball`）。
- `Alt+Space` —— 唤出 / 收起（`ball` ↔ `mini`；`full` 时收到 `mini`）。
- `Alt+Shift+Space` —— 抓当前选中文字（合成 `Ctrl+C` → 读剪贴板 → **还原原剪贴板**），并切到 `mini`。

### 自测与实测

```bash
npm run verify:all      # ★ 串行回归全量（21 个脚本 / 1100+ 项断言），含真窗口自测
npm run selftest        # 只跑宿主层自测（T0–T4），需要可用的 GPU
npm run selftest:soft   # 同上，但带 --disable-gpu：给沙箱 / 无头 / CI 环境用
npm run verify:stream   # 真实调用一次模型，验证逐字流式（会消耗模型额度）
npm run verify:electron # 校验 electron 二进制是否真的下来了
```

实测产物落在 `scripts/out/`：`selftest.json`（机器可读）、`selftest.txt`（人读）、`verify-stream.json`。

> **宿主层自测（T0–T4）现在是回归门的一部分**（`verify:all` 里的 `selftest:host`）。
> 它必须在 **Electron** 里跑 —— `verify-all` 用 `via: ["start.mjs", "--selftest"]` 换掉默认的
> `node <file>` 启动方式，因为纯 Node 下拿不到 `BrowserWindow`。
>
> **2026-10-16 修的两个问题（都属"静默失效"类，值得记住）：**
>
> 1. **T2/T3/T4 从未执行。** T2 在主窗口上调 `window.__probeReset/__probeRead`，
>    而这两个探针只定义在兜底探针页 `scripts/probe/stub.html` —— 主窗口加载的是真实渲染层
>    `src/renderer/index.html`（grep 实测 0 处）。于是 `executeJavaScript` reject ⇒
>    `measure()` 抛 ⇒ `t.occluded` 留成 undefined ⇒ 紧接着读 `.rafPerSec` 再抛一次 ⇒
>    外层大 catch 掐断整个流程。报告里 T3/T4 显示 `n/a`，**看着像"跳过"，实际是"没跑到"**。
>    修法：T2 改用**自建探针窗**（加载 stub.html）+ `runTest()` 逐测试隔离故障 + 取值走安全读法
>    （测不到记 `null` = n/a，**不要记 false** ——「没测到」和「测到了但失败」是两件事）。
> 2. **`sandbox: false` 不能省。** 不带它的自建窗口在本机根本起不来，`loadFile` 直接
>    `ERR_FAILED (-2)`，而且**不触发 `did-fail-load`** —— 报错形态和「路径写错」一模一样。
>    本 App 主窗口本来就设了 `sandbox: false`（ESM preload 需要），自测里每个自建窗口都要跟上。
>    当时唯一的差分线索是：同进程内 T3 的 alien 窗口（带 `sandbox:false`）加载同一个
>    `stub.html` 是成功的。

---

## 2. 目录结构

```
minipi/
├── package.json               # 单包，纯 ESM；scripts: start / selftest / selftest:soft / verify:stream / verify:electron
├── .npmrc                     # electron_mirror（npmmirror）
├── README.md
├── src/
│   ├── shared/
│   │   └── protocol.js        # ★ 主↔渲染的唯一契约：通道名 / 错误码 / 尺寸 / 场景 / 设置 / 校验小工具
│   ├── main/
│   │   ├── index.js           # 入口：单实例锁、启动顺序、IPC 路由 registerIpc()、热键行为、事件重放
│   │   ├── window.js          # 窗口层：一个 BrowserWindow 三态变形、位置记忆、推送保护
│   │   ├── hotkeys.js         # 全局热键 + 三级降级抓选区（含剪贴板快照/恢复）
│   │   ├── settings.js        # ~/.minipi/settings.json：白名单归一化 + 原子写盘 + 坏文件兜底
│   │   └── pi/
│   │       ├── session.js     # ★ 唯一 import Pi SDK 业务 API 的地方：会话宿主 + 事件 seq 包装 + 闸门预留位
│   │       └── scenes.js      # 三场景落地策略（cwd / 工具白名单 / 会话是否落盘）
│   └── preload/
│       └── index.js           # contextBridge 暴露 window.minipi（纯透传）
├── scripts/
│   ├── start.mjs              # 启动器：清 ELECTRON_RUN_AS_NODE 后再拉起 electron
│   ├── check-electron.mjs     # 校验 electron.exe 存在，缺失则带镜像重跑 install.js
│   ├── verify-stream.mjs      # 真实模型流式实测（跑生产代码 pi/session.js）
│   ├── selftest/main.mjs      # T0–T4 宿主层自测
│   └── probe/stub.html        # 兜底探针页（渲染层未到位时代替 src/renderer/index.html）
└── scripts/out/               # 自测与实测产物
```

**`src/renderer/` 不属于宿主层**——本仓库宿主层不创建、不修改该目录。

---

## 3. 架构：进程边界与 IPC

```
┌─────────────── 主进程（ESM，Node 24） ───────────────┐
│  src/main/index.js                                     │
│    ├─ window.js  ── BrowserWindow（三态变形）           │
│    ├─ hotkeys.js ── globalShortcut + 抓选区             │
│    ├─ settings.js ─ ~/.minipi/settings.json            │
│    └─ pi/session.js ── PiSessionHost ── Pi SDK ── 模型  │
└───────────────────────┬────────────────────────────────┘
        ipcMain.handle  │  webContents.send
                        │  （不启 ws 服务、不写端口文件）
┌───────────────────────┴────────────────────────────────┐
│ preload（contextBridge）→ window.minipi                 │
│ 渲染层（HTML + 原生 JS，零构建，无 Node 能力）           │
└─────────────────────────────────────────────────────────┘
```

- 进程间**只用 Electron IPC**：`ipcMain.handle` / `ipcRenderer.invoke` / `contextBridge`。
- 纯 ESM：根 `package.json` 有 `"type": "module"`，入口 `.js`/`.mjs`，全程 `import`。
  ESM preload 要求 `sandbox: false`（`src/main/window.js:145`），但 `contextIsolation: true` + `nodeIntegration: false` 保证渲染层拿不到 Node，也就拿不到 `~/.pi/agent/auth.json`。
- `src/shared/protocol.js` 现在是 `src/shared/`，将来原样搬成 `packages/protocol`。

---

## 4. 冻结契约：`window.minipi`

`src/shared/protocol.js` 是唯一来源，字段名一字不改。

### 4.1 invoke（渲染 → 主，返回 Promise）

| 方法 | 入参 | 返回 |
| --- | --- | --- |
| `createSession` | `{ sceneId? }` | `{ sessionId, sceneId, model, lastSeq }` |
| `sessionState` | `{ sessionId }` | `{ sessionId, model, isStreaming, messageCount, lastSeq, costUsd, sceneId, status }` |
| `prompt` | `{ sessionId, text, behavior? }` | `{ accepted }` |
| `abort` | `{ sessionId }` | `{ ok }` |
| `setWindowState` | `{ state }` | `{ ok, bounds }` |
| `listModels` | — | `{ current, defaultModel, models[] }` |
| `listProviders` | — | `{ current, defaultModel, featured[], providers[] }`（每个 provider 含 `{ provider, name, baseUrl, configured, authSource, models[{ modelId, name, contextWindow, maxTokens, available }] }`，**不含任何密钥**） |
| `setModel` | `{ model: { provider, modelId } \| null }` | `{ ok, model, note }` |
| `setApiKey` | `{ providerId, apiKey }` | `{ ok, persisted, warning? }`（key 只写不读） |
| `setProvider` | `{ provider, definition }` | `{ ok, provider, applied[], removed[], failed[], note }`（`definition` = `{ displayName?, baseUrl?, api?, models? }`，**不含 apiKey**；`models: null` = 去掉模型目录覆盖） |
| `removeProvider` | `{ provider }` | `{ ok, provider, applied[], removed[], failed[] }`（只删 minipi 自己的定义，Pi 的文件不动） |
| `discoverModels` | `{ provider?, baseUrl, api?, apiKey? }` | `{ models: [{ modelId, name }], url, protocol }`（只读 GET；key 只进请求头） |
| `getSettings` | — | `settings` |
| `setSettings` | `partial` | `settings` |
| `quit` | — | `void` |

### 4.2 事件订阅（主 → 渲染，均返回 `unsubscribe` 函数）

| 方法 | handler 收到 |
| --- | --- |
| `onEvent` | `{ seq, sessionId, ts, event }` |
| `onWindowState` | `{ state, bounds }` |
| `onHotkey` | `{ action: "toggle" }` 或 `{ action: "grabSelection", selection, ok }` |

- `event.type` **就是 Pi 的原始事件名**（`message_update` / `tool_execution_start` / `queue_update` / `agent_end` …），主进程不改名。
- `seq` 是 **per-session 从 1 连续递增**的整数；**先落内存日志（带 seq）再发**，所以渲染层重载后能靠重放补回历史。

### 4.3 错误约定

invoke 失败时，渲染层收到的是 **`"<CODE>: <可读说明>"`** 字符串（不是裸异常、不含堆栈 / 路径 / 密钥）：

```js
// 渲染层
try {
  await window.minipi.prompt({ sessionId, text: "…" });
} catch (e) {
  // e.message === "INVALID_ARGUMENT: text 不能为空"
}
```

错误码：`INVALID_ARGUMENT` / `SESSION_NOT_FOUND` / `SCENE_NOT_FOUND` / `SESSION_BUSY` / `PROMPT_REQUIRES_BEHAVIOR` / `PI_UNAVAILABLE` / `INTERNAL`。

---

## 5. 关键实现说明

### 5.1 单窗口三态变形（`src/main/window.js`）

一个 `BrowserWindow` 实例在三态之间变形（不是三个窗口）：

| 形态 | 窗口尺寸（DIP） |
| --- | --- |
| `ball` | 48 × 48 |
| `mini` | 360 × 480 |
| `full` | 960 × 680 |

来自 `spike/electron-window/` 的实测约束（勿踩）：

1. 透明窗口 `setBounds` **不掉透明**；
2. `setBounds` 同步耗时 3–8 ms，无白闪；
3. **`resize` 事件 2 秒内不会触发** ⇒ 「变形完成」用「`setBounds` 后轮询 `getBounds()` 确认」（`_confirmBounds`），**绝不**等 `resize`；
4. 尺寸有 **1px 圆整偏差** ⇒ 比较容差 ±2px；
5. `maximize()` 语义不完整 ⇒ 构造期就 `maximizable: false`。

### 5.2 `backgroundThrottling: false`（M0 硬指标）

必须在**构造期**设（`src/main/window.js:148`）。被遮挡且未聚焦时，`true` 会让 rAF 直接掉到 **0**（完全停画），`false` 时是 ~60/s 全速——实测见 §7。

### 5.3 全局热键与抓选区（`src/main/hotkeys.js`）

- `Alt+Space` → 开合；`Alt+Shift+Space` → 抓选区。
- 抓选区顺序**必须是「先抓、后抬窗」**：合成 `Ctrl+C` 要打给抓取时还在前台的那个 App（`src/main/index.js:218`）。
- 剪贴板**快照 → 恢复**：覆盖 text / html / rtf / image / bookmark；原本空的剪贴板恢复成空，**不污染用户剪贴板**。
- 降级链 ①②：模拟 `Ctrl+C` 失败（如目标 App 是提权进程，UIPI 挡按键）→ 返回 `{ ok: false, selection: null }`，由 UI 提示手动 `Ctrl+C`。
- 热键注册失败（被其它软件占用）**只告警，不让 App 崩**。

### 5.4 Pi SDK 接线（`src/main/pi/session.js`）

`session.js` 是**整个仓库唯一** import Pi SDK 业务 API 的文件（`scenes.js` / `settings.js` 都不碰 SDK，可在纯 Node 下测）。

已实测事实（勿按直觉改）：

- `session.prompt()` 在流式期间**必须**带 `streamingBehavior`（`steer` / `followUp`），否则 SDK 抛错；缺省 `steer`。
- `prompt()` 的 Promise **直到整轮跑完才 resolve** ⇒ 「已接受」改用 `preflightResult` 回调（只给布尔），并有 250ms 超时兜底。
- `queue_update` 的 `steering` / `followUp` 是「**尚未投递**的消息文本数组」⇒ 是「排队 N 条」而非「第 N 位」。
- `tool_execution_start` 的参数字段名是 **`args`**；扩展侧 `tool_call` 是 **`input`**。

四场景（`src/shared/protocol.js` 声明 + `src/main/pi/scenes.js` 落地）：

| 场景 | cwd | 工具 | 会话 | 用途 |
| --- | --- | --- | --- | --- |
| `quick`（默认） | `~/.minipi/outbox` | `noTools: "all"`（无工具） | `SessionManager.inMemory()`，不落盘 | 随手一问：概念、报错、翻译、改写 |
| `note` | `~/.minipi/outbox` | `read` / `write` / `grep` / `find` / `ls` | 落盘 | 读长文/PDF、写笔记 |
| `desk` | `~/.minipi/outbox` | 同 `note` | 落盘 | 日常办公产出：纪要、周报、提纲 |
| `repo` | `~/.minipi/repo`（占位） | 全量（含 `bash` / `edit` / `write`） | 落盘（与 Pi CLI 共用目录） | 「这个报错去帮我改代码」 |

> **v0.4 场景重构（D-23）**：第一分类维度从「像不像在编程」改为「**产出的落点**」。
> 旧名 → 新名：`speed` → `quick` · `study` → `note` · 新增 `desk` · `work` → `repo`。
> 老 `settings.json` 里的历史名由 `migrateSceneId()`（`src/main/settings.js`）**静默迁移**，不报错、不重置用户设置。

**`outbox` 沙箱**（`src/main/settings.js` 的 `OUTBOX_DIR`）：`quick` / `note` / `desk` 三个场景的 cwd
**共用同一个产出抽屉** `~/.minipi/outbox`，用户**永远不选目录**。
`repo` 是**唯一**例外（改代码必须落在真仓库里），且它必走审批闸门。

> ⚠️ **cwd ≠ 沙箱**（架构师实测纠正）：Pi 内部 `resolveToCwd` 对**绝对路径原样放行**，
> 所以「cwd = outbox」**挡不住** `write` 传绝对路径。
> 沙箱必须靠 `pi.on("tool_call")` 钩子 + `realpath` 判定（`src/main/pi/sandbox.js`，见 plan §3.4.4）。

`noExtensions: true`：闸门只覆盖本会话，第三方扩展（官方 subagent 示例是 `spawn` 独立进程）能绕过 ⇒ 本期干脆禁止第三方扩展。

### 5.5 审批闸门（M4，已实现）

`registerGate(pi, ctx)`（`src/main/pi/session.js:626`）就是 M4 闸门，挂在 `_buildResourceLoader()` 的 `factory` 上，对 **`repo` 场景**下 `write` / `edit` / `bash` / `powershell` 四类会改系统的工具调用生效：

1. **先过沙箱**（`src/main/pi/sandbox.js`）：越界直接 block，**根本不会弹卡**。
2. **再等用户决策**：`await approval.request(...)`（`src/main/pi/approval.js`，1083 行）——挂起该轮、推审批卡给渲染层，返回三种结果：`allowOnce`（放行，**不改参**）/ `deny`（拒绝）/ `terminate`（中断整轮；批内**每一条**都要带 `terminate: true`，否则 Pi 的 every 判定不生效、按钮静默失效）。
3. **5 分钟无操作默认拒绝**（`LIMITS.APPROVAL_TIMEOUT_MS`）。

硬约束（注释里均写明实证出处）：

- `tool_call` 钩子**支持 async**（`types.d.ts:902` + `runner.js:753` 会 `await` 返回值）⇒ 可以直接等用户。
- 审批器**只读、绝不改 `event.input`** —— 改参会绕过沙箱与一切校验（vendor 原文：改动后不再重新校验），这是产品级隐患，明确禁止。
- 「本次会话始终允许」**只免审批、绝不免沙箱**；该开关默认关、只在内存、只有 IPC 显式带 `remember: true` 才开，开启时记审计 `always_allow_enabled`。
- 推给渲染层的命令与 diff **统一先过 `redactSecrets()`**（`approval.js:208`，全仓唯一实现点；`session.js:sanitizeDetail` 反过来 import 复用），顺序是「路径替换之后、截断之前」。

---

### 5.6 会话显示：思考段 / 工具标记 / 小窗连续性

三件事都在 `src/renderer/index.html`，都由 `npm run verify:thought` + `npm run qa:mini-continuity` 守着。

**① 小窗是连续的会话流，不是「一轮一屏」。** `renderViews()` 的 mini 分支曾经只取
`store.turns[turns.length - 1]`，用户得打开大窗才发现前面的轮次还在。现在 mini 与 full
**同构**：都遍历 `store.turns` 全量轮次，只是宽度与「思考段默认折叠状态」不同
（小窗默认收起、大窗默认展开）。

**② 模型吐出的工具调用标记 → 折叠成提示卡。** `quick` 场景是 `noTools: "all"`，
模型手里没有工具，却会把 Anthropic 风格的工具调用语法**当正文写出来**：

```text
<invoke name="cmd"><parameter name="cmd">dir /a</parameter>
<parameter name="justification">看看目录</parameter></invoke>
```

已用真实会话 dump 过事件流取证（`pi.on` 订阅 + 逐事件打印）：Pi 只发
`thinking_*` / `text_*`，**没有 `toolcall_*` 子事件**，`message_end` 的 content 也只有
`[thinking, text]` —— 也就是说这**不是解析漏了，是模型行为**。既然它不是真的工具调用，
就不该按工具卡渲染；但也不该让一屏尖括号糊在用户脸上。

所以 `splitToolMarkup()`（`src/shared/protocol.js` §8b）把它识别出来，渲染层折叠成
`.toolnote` 卡片（工具名 + 各 parameter + 一行「当前场景未启用工具」）。
边界一律往「宁可原样显示，不要误吞内容」倒：只认 `<invoke name="…">…</invoke>` 这个确切形状
（`<img>` / `<div>` 一律不碰）；块数 > 20 或单块 > 20000 字就不再识别、剩下的原样当正文。

> 渲染层不能 `import` protocol.js（单文件零依赖），所以那份是**内联镜像**；
> `verify:thought` 的做法不是比字符串，而是**把镜像源码抽出来真跑一遍同样的用例**，逐例比对输出。

**③ 密钥一律只写不读。** 模型设置里的 API 密钥输入框恒为空、`type=password`，
保存后立刻清空；主进程也从不把 key 回传上来。

### 5.7 模型设置（提供方卡片）

信息架构对齐 deepseek-harness 的模型页（卡片列表 + 卡内编辑器），数据全部来自 Pi 运行时：

- `ModelRuntime.getProviders()` / `getModels(id)` / `getProviderAuthStatus(id)` →
  `buildProviderCatalog()`（`src/main/pi/session.js`）→ IPC `listProviders`。
  回传的是**脱敏目录**：`{ provider, name, baseUrl, configured, authSource, models[] }`，没有 key。
- **默认只列国内厂商**：`FEATURED_PROVIDER_IDS`（protocol.js）—— deepseek / 智谱 / Kimi /
  MiniMax / 通义 / 小米 / Ant Ling。其余 30 多个内置厂商折叠进「添加提供方」；
  任何**已配置密钥**的厂商不论在不在清单里都会展示。渲染层不自己维护这份清单。
- 圆点只表达「密钥配置状态」：**绿 = 已配置、红 = 缺失**（不是连通性）。
- **默认模型是 `deepseek/deepseek-flash`**（`DEFAULT_MODEL_PREFERENCE`）。
  它刻意不写进 `DEFAULT_SETTINGS.model`（那里保持 `null` = 「用默认」），而是在
  `resolvePreferredModel()` 里兜底 —— 这样 `settings.json` 里 `"model": null` 的老用户
  立刻拿到新默认，且「默认」与「用户显式选的」在文件里可区分。

  为什么需要兜底：本机 `~/.pi/agent/settings.json` 的 `defaultProvider` 指向一个
  **根本没注册**的 provider（`cc-switch-zhipu-glm`），Pi 会自己回退到「碰巧排前面的」
  `deepseek/deepseek-v4-pro` —— 用户看到的默认模型是随机结果，不是我们的选择。
- 保存时**只提交真正被改过**的模型选项（卡片打开时记下初值），
  避免「点开卡片随手点保存」就把该提供方的第一个模型设成全局默认。

#### 5.7.1 自定义提供方 / 覆盖内置（第二批）

UI：卡片编辑器的「自定义设置」折叠区（API 地址 + API 协议 + 模型目录行 + 「获取可用模型」
+「恢复默认模型目录」），以及底部的「+ 添加自定义提供方」表单（Provider ID / 显示名 /
API 地址 / 协议 / 密钥 / 模型目录）。卡片行头还带「删除提供方 / 移除覆盖」（两步确认）。

**配置住在哪：`~/.minipi/providers.json`，不是 Pi 的 `models.json`。**
Pi 自己的 `~/.pi/agent/models.json` 里可能已经有用户手写的东西（本机那份就含明文 `apiKey`），
去写它等于把别人的配置置于被整段重写的风险之下；本仓库也早立过规矩：**绝不改动 Pi 的文件**。
所以 minipi 的提供方定义只存自己的目录，启动时用 Pi 的公开 API 注入运行时：

```text
~/.minipi/providers.json  ──load──▶  ProviderStore
                                       │ applyProviderDefinitions()
                                       ▼
              ModelRuntime.registerProvider(id, cfg) / unregisterProvider(id)
```

代价与边界写清楚：

| | |
|---|---|
| ✅ 重启后仍在 | 存在自己的文件里 |
| ✅ 立即生效 | `registerProvider` 是同步的，新会话即可选中（不重建已有会话） |
| ❌ `pi` 命令行看不到 | 这是刻意的范围划分：minipi 的自定义提供方是 minipi 的事 |

**文件里只有结构，没有密钥。** `apiKey` 走既有的 `~/.minipi/credentials.json`
（`setApiKey`，只写不读）。这与 Pi 的 models.json 支持 `apiKey: "sk-..."` 字面量**故意不同** ——
「提供一个能把明文密钥写进配置文件的入口」不是特性，是负债。

**存在即覆盖。** 一个 id 出现在 providers.json 里，就在运行时被 `registerProvider` 覆盖：

- id 是**内置**的 → 覆盖它。只给 `baseUrl` 就是换端点（内置模型**不丢**，已实测）；
  给了 `models` 就是**替换整个模型目录**。
- id 是**新的** → 就是一个自定义提供方。
- 删掉这个 id → `unregisterProvider(id)`。实测它**只摘覆盖层**：内置提供方会回落到原始定义，
  模型一个不少（`deepseek` 回到 `https://api.deepseek.com`、仍是 2 个模型）。

因此同步语义就是「**先卸掉当前已注册但不在目标里的，再按目标逐个注册**」，
运行时严格等于存储（`applyProviderDefinitions()`，逐个隔离故障：一个注入失败不影响其它）。

**校验（`ProviderStore` 归一化，非法一律 `PROVIDER_INVALID`）**：Provider ID 必须
`^[a-z][a-z0-9-]*$`；API 地址必须是 http(s)（挡住 `file://` / `javascript:`）；协议必须在
`PROVIDER_API_IDS` 四值内；模型 id 非空、不重复、不超长；模型条数 ≤ 80。
**带 `models` 就必须带 `api`** —— 否则 Pi 组不出 provider（内置的协议不会被继承）；
UI 里没填时会尝试从该提供方现有模型推断，推断不出来就明确报错，不静默放行。

**「获取可用模型」**（`src/main/pi/discover-models.js`）是我们自己实现的一次只读 GET，
不是 Pi 的 `runtime.refresh()` —— 后者依赖 provider 注册时带 `refreshModels()`，
而且会把结果写进 Pi 的目录缓存；我们要的语义是「拉一份候选清单 → 用户勾选 → 并进目录」。
支持 `openai-completions` / `openai-responses`（`{baseUrl}/models`，`Authorization: Bearer`）
与 `anthropic-messages`（`{baseUrl}/v1/models`，`x-api-key` + `anthropic-version`）；
`google-generative-ai` **显式报错**而不是静默返回空数组（「没有模型」和「拉不到」在界面上长得一样，
但含义完全不同）。硬超时 15s + 响应体 2MB 上限；密钥**只进请求头**，绝不进返回值 / 错误文案 / 日志
（`verify:providers` 有专项断言）。

---

## 6. 安全设计（四个必查项）

| 项目 | 落地方式 |
| --- | --- |
| **越权** | 每个 invoke 都过 `assertTrustedSender()`（`src/main/index.js:270`）：`event.sender` 必须是本 App 主窗口的 webContents，否则拒绝并返回 `INTERNAL: 拒绝来自非主窗口的调用`。自测 T3 用「带同样 preload 的旁路窗口」真打了一发验证。 |
| **IDOR / 资源归属** | 会话注册表就是归属校验：`sessionId` 不在表里一律 `SESSION_NOT_FOUND`，**不会只凭 id 就返回别的会话**（`_requireSession`，`src/main/pi/session.js:530`）。 |
| **参数校验** | 数字类有上下界（坐标 `±100000`、窗口边长 `24–4096`）；字符串类有长度上限（prompt 32000 字符、sessionId 64、sceneId 32、选区 100000）；枚举类校验取值（`state` ∈ ball/mini/full、`sceneId` ∈ quick/note/desk/repo、`behavior` ∈ steer/followUp）。非法入参一律 `400`-等价的 `INVALID_ARGUMENT`。 |
| **分页 / 边界** | 本 App 无分页接口；等价边界是「事件缓冲」：per-session 环形缓冲上限 2000 条（`LIMITS.EVENT_LOG_MAX`），溢出丢最旧；渲染层重放截断到最近 800 条。`page`/`size` 类参数不存在，故不适用。 |

补充：

- 错误文本统一经 `sanitizeDetail()`（`src/main/pi/session.js:61`）洗过：家目录 → `~`、绝对路径 → `<path:文件名>`、压单行 + 截断；**不含堆栈、密钥、SQL、完整手机号**。
- 设置写入走**白名单归一化**（未知键丢弃）+ **原子写盘**（`.tmp` → `rename`）+ **坏文件兜底**（备份 `.bad` 后用默认值启动）。
- 渲染层事件推送前统一 `JSON.parse(JSON.stringify(...))`（`src/main/window.js:505`），杜绝把原生对象塞进 IPC。
- 窗口只允许加载本地文件：`setWindowOpenHandler` 一律 deny、`will-navigate` 一律 prevent。

---

## 7. 数据与配置

### 7.1 磁盘布局

```
~/.minipi/
├── settings.json      # 设置（唯一持久化的用户数据）
├── outbox/            # ★ 产出抽屉：quick / note / desk 的 cwd，用户不感知
├── repo/              # repo 场景 cwd（v0.1 占位）
└── logs/              # 预留目录；v0.1 事件只落内存，不落盘
```

> **`outbox` 是本产品的核心概念**：用户**永远不选目录**，所有随手产出都落在这里。
> 用户不该感知它的存在，只需要在产出卡片上点「打开 / 另存为」。
> 老版本建的 `scratch/` / `study/` / `work/` 目录**不会主动删除**（只记录，见 plan §4.2）。

`~/.pi/agent/auth.json` 由 Pi CLI 维护，minipi **复用**它，不自建 API key。

### 7.2 `settings.json`

```json
{
  "version": 1,
  "sceneId": "quick",
  "noFocusSteal": false,
  "window": {
    "state": "ball",
    "positions": { "ball": null, "mini": null, "full": null }
  }
}
```

`positions` 是三态各自记住的左上角坐标；`null` = 没记过，由主进程按「光标所在屏」算默认位。

### 7.3 环境变量 / 配置项（只列名称与用途，不含真实值）

| 名称 | 用途 |
| --- | --- |
| `MINIPI_VERIFY_SCENE` | `verify:stream` 用哪个场景跑（默认 `quick`） |
| `MINIPI_NO_BOOTSTRAP` | `=1` 时 `src/main/index.js` 只导出模块、不启动 App（供自测复用真实 IPC 路由） |
| `ELECTRON_RUN_AS_NODE` | **必须被清掉**；启动器 `scripts/start.mjs` 负责从子进程环境摘除 |
| `electron_mirror`（package.json `config` + `.npmrc`） | Electron 二进制下载镜像（npmmirror） |

---

## 8. 本机环境坑（踩过的，别重复踩）

1. **`ELECTRON_RUN_AS_NODE=1` 存在于本机环境**。带着它跑 `electron .` 会退化成纯 Node，`import { BrowserWindow } from "electron"` 直接报 `does not provide an export named 'BrowserWindow'`。
   → 必须在 **spawn 之前** 从子进程环境摘掉，所以真正的修复在 `scripts/start.mjs`；`src/main/index.js` 里的 `delete` 只是第二道防线（救不了本进程的 import，因为 ESM import 会被提升）。
2. **Electron 二进制默认从 GitHub 取**，本机 npm 走 npmmirror 会「假成功」（包装了、二进制没下来）。
   → `postinstall` 挂了 `scripts/check-electron.mjs`；缺失时用 `ELECTRON_MIRROR` 重跑 `node node_modules/electron/install.js`。
3. **Electron 固定 44.4.3**（开发依赖里锁死，不写 `^`）。
4. **沙箱 / 无头环境下 GPU 进程不可用**（`GPU process isn't usable. Goodbye.`）→ 用 `npm run selftest:soft`（带 `--disable-gpu`）。本机在**交互式桌面**下 `npm run selftest` 正常。
5. PowerShell 5.1 的 `-Encoding utf8` 会写 **UTF-8 BOM**，`JSON.parse` 不认 → `settings.js` 已做 BOM 容错。
6. 本机 `bash` 不可用（`ls: command not found`）、工具里 PowerShell 的 stdout 会被吞 → 调试时把输出重定向到文件再读。

---

## 9. 实测记录

以下均为本机实跑（Electron 44.4.3 / Chrome 152.0.7977.130 / Node 24.21.0，屏幕 1707×1019 @ dpr 1.5）。

### 9.1 宿主层自测 `npm run selftest:soft` → **EXIT=0，错误 0 条**

```
 [T0] preload 暴露 window.minipi        : PASS
 [T0] invoke 往返                      : PASS
 [T1] 三态变形尺寸全部命中请求值        : PASS
 [T2] 被遮挡/未聚焦仍在画              : PASS
 [T3] 非法入参全部被拒                 : PASS
 [T3] 越权（非主窗口）调用被拒          : PASS
 [T4] 设置存储健壮性                   : PASS
```

**T1 三态变形**（请求值 vs `getBounds()` 实测值，均 ≤2px 容差，全部 ≤40ms）：

```
 T1 ball → mini    请求 360×480 → 实测 361×480 @(1331,86)    40ms  OK
 T1 mini → full    请求 960×680 → 实测 960×680 @(374,170)    12ms  OK
 T1 full → ball    请求 48×48   → 实测 49×48   @(1643,330)   24ms  OK
```

**T2 未聚焦 / 被遮挡时的渲染（M0-3 / M0-4）**：

```
 T2 可见+聚焦        raf=181 (60.2/s) interval=30 visibility=visible focus=true
 T2 可见+未聚焦      raf=180 (59.7/s) interval=30 visibility=visible focus=false
 T2 被遮挡+未聚焦    raf=180 (59.8/s) interval=30 visibility=visible focus=false
 T2[控制组·非透明] bt=false raf=180 (59.8/s) visibility=visible
 T2[控制组·非透明] bt=true  raf=0 (0/s)     visibility=hidden
 T2[控制组] 节流问题真实存在=true · backgroundThrottling:false 有效=true
```

> 我们的主窗口是透明窗，Chromium 不对透明窗做「遮挡」记账（`visibilityState` 恒为 visible），所以另开一对**非透明**探针窗（`bt=false` / `bt=true`）用同一个遮挡者压住，证明「节流机制在本机真实存在、且 `backgroundThrottling: false` 确实把它关掉了」。

**T3 契约与入参校验**（16 例，节选；完整见 `scripts/out/selftest.json`）：

```
 T3 setWindowState 非法 state   OK  INVALID_ARGUMENT: state 必须是 ball / mini / full
 T3 sessionState 字段完整性      OK  缺 [] / 多 []（契约 8 个字段一个不少）
 T3 prompt 空文本                OK  INVALID_ARGUMENT: text 不能为空
 T3 prompt 超长（40000 字符）    OK  INVALID_ARGUMENT: text 超长（上限 32000 字符，实际 40000）
 T3 prompt 非法 behavior         OK  INVALID_ARGUMENT: behavior 必须是 'steer' 或 'followUp'
 T3 sessionState 不存在 id       OK  SESSION_NOT_FOUND: 会话不存在或已释放
 T3 越权：非主窗口调用被拒       OK  INTERNAL: 拒绝来自非主窗口的调用
```

**T4 设置存储健壮性**：缺文件 → 生成默认值 / UTF-8 BOM 容错 / 坏 JSON → 回退默认 + `.bad` 备份 / 未知键丢弃 / 越界坐标被拒（`null`）/ `recordPosition` 落盘 —— 6 例全 OK。

### 9.2 真实模型逐字流式 `npm run verify:stream` → **EXIT=0**

用真实 prompt「用一句话说明什么是梯度下降」（跑的是生产代码 `src/main/pi/session.js`）：

```
 结束依据            : agent_settled
 模型                : deepseek/deepseek-v4-pro
 text_delta 条数     : 26
 首字延迟            : 3741 ms（相对 prompt 调用时刻）
 流式跨度            : 521 ms
 总事件条数 / lastSeq: 112 / 112
 costUsd             : 0.00042152
```

回答：`梯度下降是一种优化算法，通过沿目标函数梯度的反方向反复更新参数，逐步逼近使函数值最小的参数。`

### 9.3 `npm start` 启动链路

```
[minipi] 启动中 · protocol 0.1.0 · Electron 44.4.3 · Node 24.21.0
[minipi] 设置已载入 · 场景 quick · 形态 ball · 不抢焦点 false
[minipi:window] 变形 → ball · 请求 48×48 @(1643,330) · 实测 49×48 @(1643,330) · setBounds 2ms
[minipi:hotkeys] 已注册 Alt+Space（Alt+Space 开合）
[minipi:hotkeys] 已注册 Alt+Shift+Space（Alt+Shift+Space 抓选区）
[minipi] 就绪。Alt+Space 开合，Alt+Shift+Space 抓选区。
```

静置观察 8.5 秒，球窗口位置稳定在 `(1643,330)`，无漂移。

---

## 10. 与方案的偏离

1. **`ball` 窗口就是 48×48**，没有采用「窗口 96×96、视觉球内缩」的做法。理由：本机 `dpr = 1.5`，48 DIP ≈ 48 CSS px ≈ 72 物理像素，已满足 44px 最小命中区建议；若把窗口放大到 96×96，会强迫渲染层在内缩容器里画球，等于在并行开发期**偷偷改视觉契约**。
2. **多了一个 `selftest:soft` 脚本**（`--disable-gpu`）。正常 `npm start` / `npm run selftest` **不动渲染后端**；这只是给沙箱 / 无头环境留的一条可复现验证路径。
3. **多了一个兜底探针页** `scripts/probe/stub.html`。渲染层未到位时 `window.js` 会加载它并在日志里明确告警；`src/renderer/index.html` 一旦出现就自动切回，不需要改代码。
4. **`repo` 场景 cwd 用 `~/.minipi/repo` 占位**：v0.1 契约里 `createSession` 没有 `cwd` 参数，「显式选择工作区」等契约扩展后再替换。
5. **IPC 用「可读错误字符串」而不是 HTTP 状态码**：进程间通信没有 HTTP 层，沿用契约里 `"<CODE>: <说明>"` 的约定，`INVALID_ARGUMENT` 对应 400、`*_NOT_FOUND` 对应 404、非主窗口调用对应 403 的语义。

---

## 11. 未完成项 / 未验证项

**明确不做（本期取舍，不是遗漏）**

- **产出链路（M5）**：`outbox` 沙箱已就位，但「结构化 JSON → docx 落盘 → 产出卡片」尚未实现。
- **抓选区降级链 ③**（UI Automation `TextPattern` 取选中文字）：只做了 ①②。
- **事件落盘**：`~/.minipi/logs/` 只建目录，事件只在内存环形缓冲里。
- **多会话管理**：每次 `createSession` 新建一个会话，契约里没有「列出 / 切换 / 恢复会话」的接口。

**未验证 / 需要你在真机确认**

- **`Alt+Space` / `Alt+Shift+Space` 的真实按键**：自测只验证了「注册成功」，没有真的按下去——`globalShortcut` 在无头 / 沙箱会话里不会收到真实键盘事件。**请在交互式桌面上手动按一次确认**。
- **抓选区的端到端效果**：合成 `Ctrl+C` 依赖 `powershell.exe` + `WScript.Shell.SendKeys`，对提权目标进程会被 UIPI 挡住（→ 降级 ②）。**未在真实 App（浏览器 / 编辑器）里端到端验证过**。
- **审批闸门的真机弹卡**：195 项纯 Node 验证（`npm run verify:approval`）+ 59 项 headless Chrome 渲染验证（`npm run verify:approval-ui`）全绿，但本机 Electron 启动即 GPU 崩（`exit_code=-1073741819`，`--disable-gpu` 无效），**真实窗口里的弹卡与三按钮交互未跑过**。
- **渲染层 UI**：由前端并行交付；宿主层在它到位前跑的是兜底探针页，**没有验证过真实渲染层的联调**。
- **多显示器**：位置计算按「光标所在屏」做，但只有单屏环境可测，多屏 / 混合 DPI **未验证**。
- **`full` 态铺满整屏**：Full 态不做原生最大化（`maximizable: false`），要铺满需自绘 `setBounds`，本期没做。

---

## 12. 开源许可

**minipi 本体采用 [Apache License 2.0](./LICENSE)。**

选 Apache-2.0 而不是 MIT，主要是两条：一是它带**明确的专利授权**（贡献者授予你其贡献所涉专利的使用权），二是它**不授予商标权**并要求保留 `NOTICE` —— 对一个要长期做成产品的项目，这比 MIT 那种「一句免责」更稳。代价是条款更长、贡献者需遵守 §5 的贡献授权默认条款。

### 第三方组件

| 组件 | 许可 | 说明 |
| --- | --- | --- |
| [Pi SDK](https://github.com/badlogic/pi-mono)（`npm: @earendil-works/pi-coding-agent`） | MIT | 运行时依赖，走 npm 安装；仓库**不含**其源码 |
| [Electron](https://www.electronjs.org/) | MIT | 桌面宿主；二进制走 npmmirror 镜像（见 `.npmrc`） |
| [docx](https://docx.js.org/) | MIT | 产出 .docx |

> `vendor/` 目录是上游 Pi SDK 的源码快照（MIT, © Mario Zechner），仅用于开发期核对 SDK 行为 —— `src/` 里那些「vendor 确证」注释指的就是它。**该目录不入库**（约 59MB），运行时并不依赖它，需要核对时请从上游获取。

### 关于密钥：minipi 本身不存任何 key

这是刻意的设计，不是省略：

- minipi **复用 `~/.pi/agent/auth.json`**（由 Pi CLI 维护），不自建、不复制、不缓存模型 API key。
- 该凭据位于**用户家目录**，在本仓库目录树之外 —— `git add .` 够不到它。
- 推给渲染层的命令与 diff 在离开主进程前统一过 `redactSecrets()`，审计记录里不会出现明文密钥。

⚠️ **给使用者的提醒**：不要把任何真实凭据放进本仓库目录树内（`.env`、`auth.json`、`*.key` 等均已被 `.gitignore` 排除）。**公开仓库里"加密上传"的密钥并不安全** —— 任何人都能下载密文离线暴力破解。密钥只应留在本机家目录。
