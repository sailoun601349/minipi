# minipi · Pi SDK 运行时 spike 套件

> **一句话目的**：把 `docs/minipi-plan.md` §11【开工门禁】序 7 里**不需要模型**的那一半问题**真跑掉并留下证据**，把**需要模型**的那一半写成可复现的脚本 + 明确判据，让用户自己决定何时花额度去跑。
>
> 姊妹套件：`spike/electron-window/`（同一条门禁的**窗口物理**那一半，由宿主方负责）。两者刻意分开，避免把宿主问题与 SDK 问题混在一份报告里。

---

## 0. 这套件回答什么

| 组 | 问题 | 归属 | 是否真跑 |
|---|---|---|---|
| **B1** | ESM 可行性：本机 Node 下 `import` 该包成不成、`engines` 满不满足、`require()` 会不会如预期失败 | offline | ✅ 真跑 |
| **B2** | 导出面核对：`createAgentSession` / `ModelRuntime` / `SessionManager` / `AgentSessionRuntime` / `defineTool` / 扩展 API 到底能不能 import 到 | offline | ✅ 真跑 |
| **B3** | 静态核对：`ToolCallEvent` 字段、`ToolCallEventResult` 三字段、`event.input` 可变性、`queue_update` 字段、`preflightResult` 签名、`navigateTree` 忙时行为、`tool_execution_start` 是 `args` 还是 `input` | offline | ✅ 真跑（回源码读，给 `文件:行号`） |
| **B4** | 凭证探测：`~/.pi/agent/auth.json` 在不在、有哪些 provider（**只报名称**） | offline | ✅ 真跑 |
| **C1–C5** | `tool_call` 阻断语义 / `terminate` 真实语义 / `navigateTree` 忙时形态 / 流式 `steer`+`followUp` / 闸门能否被嵌套会话绕过 | live | ⏸️ **默认不执行**（要凭证、要花额度） |

> 门禁序 7 的**唯一判定结论**只有一句：`spike:offline` 的报告 + `spike:electron-window` 的报告合起来能否关闭它。live 是「有时间就顺手做」，它的结论会决定 M4 的实现细节，但**不阻塞 M0/M1**。

---

## 1. 如何运行

前置：**Node ≥ 22.19.0**（`node -v` 自查，SDK 的 `engines` 就是这么要求的）。

### 1.1 offline（不调模型，随时可跑）

```powershell
cd D:\SAiProject\minipi\spike\pi-sdk
npm install          # 装 @earendil-works/pi-coding-agent@0.87.0（pin 死），首次约几分钟
npm run spike:offline
```

产物：

```
out/pi-sdk-offline-report.json    机器可读的完整结论（含每条探针的命中行与原文）
out/pi-sdk-offline-report.md      人读版：结论速览 + 每条结论的证据（文件:行号）
```

> **offline 也会真连一次 npm 吗？** 不会。`spike:offline` 只做本地文件读取 + `import`，不发起任何网络请求，不读凭证内容（只读 `auth.json` 的**键名**）。

### 1.2 live（**会真实调用模型、消耗额度**）

**默认不执行**——不加 `--run` 时只打印执行计划与判据：

```powershell
npm run spike:live                 # 只看计划，0 次模型调用，随时可跑
```

真跑（二段确认，两个条件都要满足）：

```powershell
cd D:\SAiProject\minipi\spike\pi-sdk
$env:MINIPI_SPIKE_LIVE_CONFIRM="1"; npm run spike:live -- --run
```

只想跑某一题（**推荐第一次这样跑**，最省额度、最容易定位问题）：

```powershell
$env:MINIPI_SPIKE_LIVE_CONFIRM="1"; npm run spike:live -- --run --only=q1
```

可用参数：

| 参数 | 默认 | 说明 |
|---|---|---|
| `--run` | 关 | 必须显式加，否则只打印计划 |
| `--only=q1,q3` | 全跑 | 只跑指定题 |
| `--max-model-calls=N` | `10` | **硬上限**，超了立刻中止并写报告（防止脚本失控烧额度） |
| `--idle-timeout-ms=N` | `180000` | 单轮最多等多久，超时自动 `abort()` 并记异常 |
| `--planning-window-ms=N` | `12000` | 需要 streaming 窗口的题目（Q3/Q4）的窗口长度 |

产物：

```
out/pi-sdk-live-report.json / .md     同 offline 的两份报告（含事件流快照）
out/scratch/                          被模型实际写盘的文件（一次性，可随时删）
```

### 1.3 套件自检（不依赖 SDK，不联网）

```powershell
npm run selfcheck
```

检查工程约定（`type:module` / `engines` / pin 版本 / 两个入口 / `.gitignore`）、所有 `.mjs` 的语法、ESM 纯度、**这套件自己没有掺进任何真实路径或凭证**、以及「live 默认不执行」「offline 不可能调模型」两条硬约束。

---

## 2. offline 四项测什么、怎么判读

### B1 · ESM 可行性

- **做了什么**：① `await import("@earendil-works/pi-coding-agent")`；② `require()` 同一个包；③ 读安装到的 `package.json` 的 `type` / `exports` / `engines`，并本机比对 Node 版本；④ `import.meta.resolve()` 看解析到哪个文件。
- **为什么这么测**：方案 §11 把「主进程必须走 ESM」定为 M0 的第一条硬约束（`type:module` + `exports` 只有 `import` 分支）。

**怎么判读**

| 结果 | 含义 |
|---|---|
| `dynamicImport.ok === true` | ✅ Node 侧 `import` 通 ⇒ M0-0 的 Node 半边成立 |
| `requireAttempt.ok === true` | ⚠️ **不是预期失败**：Node 22.12+ 的 `require(esm)` 已默认开启。**这不影响结论**（我们要的是 `import` 可用），但意味着「用 `require` 会报错」这种说法在本机 Node 上不成立，别写进验收 |
| `requireAttempt.errorCode === "ERR_REQUIRE_ESM"` 或 `"ERR_REQUIRE_ASYNC_MODULE"` | 如预期失败 |
| `hasRequireCondition === true` | ❗`exports` 里有 `require` 条件，与方案 §11 的描述不符 → 要改文档 |
| `nodeEngineOk === false` | ❌ 本机 Node 不满足 `engines`，**M0 起不来**，只能整体降到 `legacy-node20` 线 |
| Electron 主进程 ESM | 🤔 **本套件不判**。纯 Node 环境验不了 Electron 的 ESM 主进程，那一条由 `spike/electron-window/main.mjs` 覆盖 |

### B2 · 导出面核对

- **做了什么**：把方案 §3 / §3.3 用到的每个名字逐个 `hasOwnProperty` + `typeof` 验一遍；纯类型名（`ToolCallEvent` 等）运行时不体现，改查安装到的 `dist/index.d.ts` 并给首个命中行。
- **怎么判读**

| 结果 | 含义 |
|---|---|
| 运行时那 17 个名字全部 `present === true` | ✅ 方案 §3 的接线可以直接写 |
| 有名字 `present === false` | ❌ 该名字在 0.87.0 里不存在或不导出 → 方案 §3 要改 |
| 纯类型名在 `.d.ts` 里找不到 | ❌ 类型名写错了（多半是方案抄了别的包的命名） |

### B3 · 静态核对（源码 `文件:行号`）

- **做了什么**：对 22 条「事实」各写若干探针正则，**回 `vendor/pi/packages/*/src/` 逐行匹配**，命中就记行号与源码原文。带负向探针的（例如「`queue_update` 里不该有 `position`」）会检查指定行区间内**没有**命中。
- **诚实性口径**：探针先按**逐字正则**匹配；失败才用「缩进放宽」的等价正则重试，并在结果里标 `relaxedIndent`；与文档引用行号不一致的会单列「行号漂移」。**不用放宽后的结果冒充逐字命中。**
- **为什么不用记忆 / 不用 dist**：`dist/` 是**旧构建产物**，与 `src/` 不一致（典型：`on("tool_call")` 的返回类型，见 F8）。**一律以 `src/` 为准**，只有明确标 dist 的探针才读 dist。

| 结果 | 含义 |
|---|---|
| `verdict = confirmed` | ✅ 事实成立，`文件:行号` 可直接写进文档 |
| `verdict = partial` | ⚠️ 部分探针没命中 → 文档的这条断言至少有一半站不住，要改 |
| `verdict = not_found` | ❌ 整条断言在源码里找不到依据 |
| `lineDrift` 非空 | 事实对、**行号错** → 改文档的行号引用 |
| `negativeRegions[].violated === true` | ❗「不存在某字段」的说法被推翻 |

### B4 · 凭证探测

- **做了什么**：真 `import` 后调用 SDK 的 `getAgentDir()` 拿到 agent 目录，检查 `auth.json` 是否存在；存在就 `JSON.parse`，**只取顶层 key 作为 provider 名称、只取 provider 内层 key 名**。
- **硬约束**：**绝不读取、绝不打印任何凭证值**（token / key / OAuth secret）。报告里只有「存在/不存在 + provider 名 + 字段名」。
- **怎么判读**

| 结果 | 含义 |
|---|---|
| `authJsonExists === true` 且 `providerCount > 0` | ✅ `spike:live` 可以跑（会花额度） |
| `authJsonExists === false` | ❌ live 跑不起来 → 先跑一次 `pi` 登录，或按 A1 的前提「启动探测、缺失则引导」 |
| `providerCount === 0` 但文件在 | ❌ 文件在但空 ⇒ 同上 |

---

## 3. live 五问：判据各自一句话

> 完整观察项与判据在 `npm run spike:live`（不加 `--run`）的输出里，也写在源码 `src/live.mjs` 的 `QUESTIONS` 里——**文档与代码同一份来源，不会走偏**。

| 题 | 通过判据（一句话） |
|---|---|
| **Q1** `block: true` + `reason` 的真实语义 | 闸门被调用 **且** 目标文件没被创建 **且** tool result 文本逐字等于我们给的 `reason` **且** 模型没有原样重试同一操作（重试了 → 判「部分」，因为「拒绝要有语义」不成立） |
| **Q2** `terminate: true` 的确切语义 | 同批全部 `block+terminate` 时**真的提前终止**（该批后不再有新的模型回合），而同批有一个被放行时**不**提前终止（验证 `every` 语义） |
| **Q3** `navigateTree()` 忙时行为 | 忙时不返回 `cancelled`（而是 reject/throw），且空闲 + 扩展返回 `{cancel:true}` 时能拿到 `{cancelled:true}` |
| **Q4** 流式 `steer`/`followUp` | `preflightResult` 只给布尔 **且** `queue_update` 键名 ⊆ `{type,steering,followUp}` **且** 流式中缺 `streamingBehavior` 会抛错 |
| **Q5** 闸门能否被绕过 | 嵌套会话（工具内部再 `createAgentSession`）的工具调用**也**进父会话 handler ⇒ 无绕过；只看到外层工具调用而内层写成功了 ⇒ **被绕过**，必须在设计上显式取舍 |

---

## 4. 目录结构

```
spike/pi-sdk/
├─ package.json            "type":"module"、engines.node >=22.19.0、pin @earendil-works/pi-coding-agent 0.87.0
├─ .gitignore              node_modules/ 与 out/
├─ README.md               本文件
├─ RESULT-TEMPLATE.md      跑完把结论填进去即可回填门禁表
├─ src/
│  ├─ offline.mjs          spike:offline 入口（B1–B4 四段，不调模型）
│  ├─ live.mjs             spike:live 入口（C1–C5 五问，默认只打印计划）
│  ├─ selfcheck.mjs        套件自检（不依赖 SDK）
│  └─ lib/
│     ├─ util.mjs          脱敏 / 落盘 / 行扫描 / 表格拼装
│     ├─ static-facts.mjs  22 条静态事实 + 探针（每条带文档原话与结论）
│     └─ scan.mjs          探针执行器（含缩进放宽兜底与负向区间检查）
└─ out/                    报告与 scratch（已被 .gitignore 忽略，可随时删）
```

---

## 5. 结果怎么回填

1. 跑 `npm run spike:offline`，打开 `out/pi-sdk-offline-report.md`。
2. 按 `RESULT-TEMPLATE.md` 的表填 **B1–B4 四行 + 凭证一行**（「实测值」抄报告字段，「判定」选一个）。
3. 跑 `spike/electron-window` 那套，把它 4 行也填上。
4. 把**两张表**一起贴进 `docs/minipi-plan.md` §11【开工门禁】序 7，把「关闭状态」改为 **已关闭**，并在「产出」列写一句话总结。
5. 有额度后跑 live，把 Q1–Q5 五行补进 `RESULT-TEMPLATE.md` 第 3 节，作为 **M4 的实现依据**（它不阻塞序 7，但阻塞 M4 的细节定稿）。

**判定口径统一为五种**：✅ 通过 / ❌ 不通过 / ⚠️ 部分符合 / 🤔 不可判定 / ⏸️ 未执行。**跑不起来就写跑不起来**，不写「理论成立」。

---

## 6. 已知边界与硬约束（这套件不做什么）

- **不碰产品代码**：不改 `vendor/pi/`、`docs/`、`qa/`、`prototype/` 下的任何文件。`vendor/pi/` **只读**，仅用于静态核对。
- **不打印凭证**：报告里只有「文件是否存在 + provider 名称 + 字段名」。任何值都不读、不写、不上报。
- **不写真实路径**：所有落盘字符串统一过 `redact()`——用户主目录 → `~`，仓库根 → `<repo>`，本套件根 → `<kit>`。示例路径一律 `~/minipi/...` 或 `D:\proj\demo`。
- **不动你的 Pi 既有状态**：live 用的会话一律 `SessionManager.inMemory(...)`（不落盘到 `~/.pi/agent/sessions`）；只有 inline 扩展、`noExtensions/noSkills/noPromptTemplates/noThemes/noContextFiles` 全开，隔离你已装的扩展。**唯一的例外**：被模型写盘的文件落在 `out/scratch/` 下（这是刻意的，用来验证「工具到底有没有真的执行」）。
- **不测模型质量**：本套件只做「行为取证」，不评估回答好不好、不测 token 成本、不测网络中断重试。
- **不验 Electron 主进程 ESM**：纯 Node 环境验不了，交给 `spike/electron-window/main.mjs`。
- **`dist/` 与 `src/` 不一致是已知的**：`vendor/pi/packages/coding-agent/dist/` 是旧构建产物。**凡结论都要注明引自哪一处**；本套件默认引 `src/`。

---

## 7. 隐私与安全的一次性检查表（交付前自查用）

- [ ] `npm run selfcheck` 全绿（含「无本机绝对路径 / 无凭证 / 无真实邮箱」）。
- [ ] `out/` 已在 `.gitignore` 里。
- [ ] 报告里没有 `C:\Users\...`、没有 `/home/...`、没有邮箱、没有 `sk-`/`ghp_`/`AKIA` 类串。
- [ ] live 报告已确认不含真实用户名与绝对路径（`redactDeep()` 兜底）。
- [ ] 跑完 live 后如需清除痕迹，直接删 `out/`。
