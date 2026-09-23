# minipi v0.4 施工方案（实施计划）

> 版本 v1.1 · 2026-09-23
> 作者：任析（架构师）
> 输入：`docs/minipi-capability-boundary.md`（v0.1）、`docs/minipi-plan.md`（v0.4，含 §0.1/§0.2/§3.2/§3.4/§6/§8/§10 D-20~D-25）、已落地的 `src/shared/protocol.js` / `src/main/settings.js` / `src/main/pi/scenes.js` 三处改动。
> 定位：把 v0.4 的五项拍板（D-20~D-25）落成**可执行、可验收**的施工清单。**本文件不写实现代码**，只给设计、契约与验收标准。
>
> **全部 SDK 断言回本地源码 `vendor/pi/packages/coding-agent/src/` 核对**，每条给 `文件:行号`；查不到的写「未在源码中找到」，不沿用推测。
>
> **v1.1 修订**：① T0.5（docx 实测）**已执行并通过**，见 `spike/docx-runtime/RESULT.md`；② docx 已装进仓库（`package.json` → `"docx": "9.7.1"`），**T1.1 形态不变、无退路被动用**；③ 团队负责人已确认「产出链路 LLM 出口放 `session.js`」，附两条约束（见 §3.1）；④ T0.6 静态扫描脚本**扩展为覆盖 cwdTemplate 一致性**（不止场景名）。

---

## 0. 一页速览

| 项 | 内容 |
|---|---|
| **方向** | 从「迷你 Pi 工作台」收敛为「**选中 → 一句话 → 得到一个文件**」的 5 秒通道（plan §0） |
| **五处方向变化** | D-20 否掉「不做文件更改」→ 只写 `~/.minipi/outbox/`；D-21 沙箱 = 固定单目录；D-22 本期产出 = Markdown + docx（pptx 不做）；D-23 场景四档 `quick`/`note`/`desk`/`repo`；D-24 Jev 摘出主线；D-25 M4 提前到 M3 之前 |
| **本方案产出 5 块** | ① 剩余改动清单（按文件 + 行号）；② outbox 沙箱执行方案；③ 产出链路模块设计；④ 兼容与迁移；⑤ 任务清单（含验收 + P0/P1/P2） |
| **P0（不做就会坏）** | 4 条：场景名残留全清、沙箱逃逸拦截、产出链路可用、老 settings 迁移 |
| **关键结论** | 沙箱与审批闸门是**同一个 `tool_call` 钩子的两条规则**（不是两套机制）；docx **选型 `docx`（npm 纯 JS）成立**；老 `sceneId: "speed"` 走**静默映射**，老目录**不主动删** |

---

## 1. 剩余改动清单（按文件给，含行号区间）

> 已落地（不要再改）：`src/shared/protocol.js` 的 `SCENE_DEFS`/`OUTBOX_SCENES`/`DEFAULT_SCENE_ID`；`src/main/settings.js` 的 `OUTBOX_DIR`/`SCENE_CWD_DIRS`/`ensureAppDirs()`；`src/main/pi/scenes.js` 的 `TEMPLATE_TO_DIR` + `OUTBOX_DIR` import。
> 下表是**残留点**，逐条给「文件:行号 → 改法 → 优先级」。

### 1.1 主进程（P0）

| # | 文件:行号 | 现状 | 改法 | 优先级 |
|---|---|---|---|---|
| A1 | `src/main/index.js:303` | 文案硬编码 `"sceneId 必须是 speed / study / work 之一"` | 改为从 `SCENE_IDS` 动态生成：`sceneId 必须是 ${SCENE_IDS.join(" / ")} 之一` | **P0** |
| A2 | `src/main/index.js:340` | 同上（`SET_SETTINGS` 分支） | 同上，**抽一个本地小函数** `sceneIdHint()` 两处共用，避免第三次漂移 | **P0** |

> **为什么 P0**：这两条是**用户可见的错误文案**。硬编码旧场景名会让用户看到「你可以选 study」，而 UI 上根本没有 `study` 按钮 —— 直接自相矛盾。
> **`SCENE_IDS` 已在 `index.js:38` import**（现成可用），改法零风险。

### 1.2 渲染层（P0，单文件 `src/renderer/index.html`）

> 该文件是**零依赖单文件**，内部维护了一份 `protocol.js` 的**镜像**（文件头有说明：不可 import）。因此每一处镜像都要手动对齐，**这正是场景名最容易漂移的地方**。

| # | 行号区间 | 现状 | 改法 | 优先级 |
|---|---|---|---|---|
| B1 | `180-182` | CSS `.chip--speed` / `.chip--study` / `.chip--work` 三个类 | 改为 `.chip--quick` / `.chip--note` / `.chip--desk` / `.chip--repo` **四个类**（颜色沿用：quick=蓝、note=紫、desk=绿、repo 可复用绿或另给青色）。`desk` 是新档，必须有独立色 | **P0** |
| B2 | `595-597` | Full 态场景切换按钮三个：`data-scene="speed/study/work"` | 改为四个按钮 `quick/note/desk/repo`；`aria-pressed` 默认改为 `quick` | **P0** |
| B3 | `689-711` | 内联 `SCENE_DEFS` 副本（**仍是旧的 speed/study/work 三档 + 旧 cwdTemplate `~/.minipi/scratch|study|work`**） | **逐字对齐** `protocol.js` 的四档：`quick`（cwd `~/.minipi/outbox`, noTools all）、`note`（outbox, read/write/grep/find/ls）、`desk`（outbox, 同 note）、`repo`（`~/.minipi/repo`, 全量）。**四处 `cwdTemplate` 全部改掉** | **P0** |
| B4 | `713` | `DEFAULT_SCENE_ID = 'speed'` | 改为 `'quick'` | **P0** |
| B5 | `2219` | mock settings 默认 `sceneId: 'speed'` | 改为 `'quick'` | **P0** |
| B6 | `2319` | mock `createSession` 里 `settings.sceneId = sceneId || 'speed'` | 改为 `\|\| 'quick'` | **P0** |
| B7 | `2280` | mock 工具事件里路径 `~/.minipi/study/lecture03.md` | 改为 `~/.minipi/outbox/lecture03.md`（对齐新 cwd；这条同时也验证了「产出落在 outbox」的新心智） | **P0** |
| B8 | `627` | mock 控制台里出现 `chip--study`（示例色块） | 跟着 B1 改成 `chip--note` 或 `chip--quick` | **P1** |
| B9 | 全文检索 `scratch` | 内联副本里 `~/.minipi/scratch` 等旧路径 | **全文 grep `scratch` / `speed` / `study` / `work`（作为场景名出现时）**，逐处改。注意：`work` 这个单词在普通英文里会误命，只改**作为 sceneId 出现**的 | **P0** |

> **验收口径**：改完后在渲染层全文搜 `speed`、`study`、`scratch`，**除注释里的历史说明外零命中**；`work` 只允许出现在非 sceneId 语境。

### 1.3 探测页与注释（P1 / P2）

| # | 文件:行号 | 现状 | 改法 | 优先级 |
|---|---|---|---|---|
| C1 | `scripts/probe/stub.html:175` | 按钮文案「建会话（speed）」 | 改为「建会话（quick）」 | **P1** |
| C2 | `scripts/probe/stub.html:327` | `api.createSession({ sceneId: "speed" })` | 改为 `"quick"` | **P1** |
| C3 | `src/main/pi/session.js:20` | 注释 `work 场景当前没有审批闸门` | 改为 `repo 场景…`；**并补一句** v0.4 沙箱边界（quick/note/desk 不开 bash） | **P2** |
| C4 | `src/main/pi/session.js:252` | 注释 `与 Pi CLI 共用（§3.2 work 行）` | 改为 `§3.2 repo 行` | **P2** |
| C5 | `src/main/pi/session.js:107-108` | 注释里 `speed` / `study` / `work` 场景名 | 改为 `quick` / `note` / `desk` / `repo` | **P2** |
| C6 | `src/main/pi/scenes.js:106-108` | 注释 `speed 用 noTools` / `study / work 用 tools 白名单` | 改为 `quick` / `note` / `desk` / `repo` | **P2** |
| C7 | `src/main/pi/session.js:641` | 注释 `M4 的闸门就挂在这一句上；本期 registerGate() 是空实现` | 集成后改为「M4 闸门已挂载；沙箱规则见 impl-plan §2」 | **P2** |

> **注释类（P2）不进本期验收卡点**，但必须**一次性做完**——注释里的旧场景名是后来人（和未来的 AI）读代码时最大的误导源，成本极低。

### 1.4 需要新增的「场景名唯一来源」约束（P1）

**问题**：场景定义在 3 处存在（`protocol.js` 真源、`index.html` 镜像、注释）。三处靠人肉对齐一定会再漂。**尤其是 `cwdTemplate`**——它漂了最隐蔽：UI 上显示一个路径、实际落到另一个，用户与开发者都难察觉（团队负责人点名要求覆盖）。

**建议**（不引入构建工具前提下的最省事做法）：
- 在 `scripts/` 下加一个**零依赖静态扫描脚本** `scripts/check-scene-consistency.mjs`，覆盖**两类断言**：
  1. **场景名**：读 `protocol.js` 的 `SCENE_IDS` + `DEFAULT_SCENE_ID`，与 `src/renderer/index.html` 里 `const SCENE_DEFS` 段落 / `DEFAULT_SCENE_ID` 断言一致；
  2. **`cwdTemplate`**：逐个场景比对镜像里的 `cwdTemplate` 与 `protocol.js` **逐字**一致（`~/.minipi/outbox` × 3 + `~/.minipi/repo`）。
- 挂进 `package.json` 的 `verify:*` 系列（已有 `verify:stream`/`verify:electron` 先例，不新增机制）。

> 这属于 **P1**：不做不会坏，但做了能防止 v0.5 再漂一遍。**T0.6 已按此扩为「场景名 + cwdTemplate 双覆盖」。**

---

## 2. `outbox` 沙箱的具体执行方案（重点）

### 2.1 先厘清一个前提：cwd 不等于沙箱

**已被源码证伪的直觉**：很多人以为「cwd 设成 outbox，模型就写不出去了」。**错**。

`write` 工具的真实实现（`vendor/pi/.../src/core/tools/write.ts:65`）：

```ts
const absolutePath = resolveToCwd(path, ctx?.cwd || cwd);
```

而 `resolveToCwd`（`path-utils.ts:48-50` → `utils/paths.ts:102-106`）的语义是：

```ts
// 相对路径 → 拼到 cwd 上；绝对路径 → nodeResolvePath(normalized) 原样返回
return isAbsolute(normalized) ? nodeResolvePath(normalized) : nodeResolvePath(normalizedBaseDir, normalized);
```

**结论**：
- 模型传 `../x` → `path.resolve(outbox, "../x")` = **逃出 outbox**（cwd 帮不上忙）；
- 模型传 `C:\Windows\x.txt` 或 `/tmp/x` → **绝对路径直接通过**（cwd 完全被绕过）。

⇒ **cwd 只是「默认落点」，不是「边界」。边界必须靠钩子拦。** 这与 plan §3.4.4 的表述一致（「`write` 的目标路径**必须**落在 outbox 内，用 realpath 校验」）。

### 2.2 判定规则：拦不拦？怎么判？

闸门挂在 `pi.on("tool_call")` 钩子上（与 §3.3 审批闸门**同一个钩子**，见 §2.5）。对 `write`（以及 `edit`）的**沙箱规则**分两步：

#### 第一步：算「目标绝对路径」

```
target = path.resolve(cwd, String(event.input.path ?? ""))
```
- `cwd` = 该会话的 cwd（`note`/`desk` 就是 `OUTBOX_DIR`）。
- 这与 Pi 内部 `resolveToCwd` 的算法**一致**，所以钩子里算出来的路径就是 Pi 将要写的路径（不会出现「我判的和它写的不是一个」）。
- ⚠ 不要自己做 `~` 展开的去重逻辑：Pi 的 `normalizePath` 会自动展开 `~`（`paths.ts:87-93`）。**直接复用 `node:path.resolve` 即可覆盖 `..` 与绝对路径两种逃逸**（`~` 由模型侧展开成绝对路径后同样是绝对路径，被同一条规则覆盖）。

#### 第二步：判定是否落在 outbox 内

```
isInside = (realpathOrNull(target) ?? realpathOrNull(nearestExistingAncestor(target)) ?? target)
           startsWith realpath(OUTBOX_DIR) + sep
```

**判定规则（写成可执行的伪码，落到 `src/main/pi/sandbox.js`）**：

```
function isWriteAllowed(targetAbsPath, outboxAbsPath):
    # 1. 先规范化 outbox（它一定存在，ensureAppDirs 已建）
    root = realpathSync(outboxAbsPath)            # 失败 → 直接 deny（不 fail-open）

    # 2. 求 target 的「最可靠的物理路径」
    probe = targetAbsPath
    while not exists(probe):                       # target 可能还不存在（新建文件）
        parent = dirname(probe)
        if parent == probe: break                  # 到根了
        probe = parent
    real = realpathSync(probe)                     # 对已存在的最深祖先求 realpath

    # 3. 把 target 剩余段（还没创建的部分）拼回去
    tail = relative(probe, targetAbsPath)
    final = tail == "" ? real : join(real, tail)

    # 4. 前缀判定（必须带分隔符，防 /outbox-evil 误判成 /outbox 内）
    norm = (win32 ? toLowerCase : identity)        # Windows 文件系统不区分大小写
    return norm(final) == norm(root) or norm(final).startsWith(norm(root + sep))
```

**⚠ Windows 大小写策略（实现回填补充，白客实现比初版方案更完善，采纳）**：NTFS 默认**不区分大小写** ⇒ `...\OUTBOX\a.txt` 与 `...\outbox\a.txt` 物理上是同一目录。若比较时区分大小写，模型传大写的 `OUTBOX` 会被**误杀**（用户莫名被拦，且无安全收益）。⇒ **win32 下比较前 `toLowerCase`；非 Windows 保持区分**（收紧比放松安全）。注意：`OUTBOX-EVIL` 仍会被正确拦截（归一化后仍是 `outbox-evil`，不带 `sep`）。

**四条必须钉死的细节**：

| 细节 | 规则 | 理由 |
|---|---|---|
| **前缀判定必须带 `sep`** | `final.startsWith(root + path.sep)` | 否则 `~/.minipi/outbox-evil/x` 会被误判为「在 outbox 内」（经典前缀陷阱） |
| **realpath 时机 = 校验时** | 在钩子里（写之前）算，不是在写之后 | 写之后校验等于事后取证，文件已经落盘了 |
| **路径不存在时的处理** | **向上去到最深的已存在祖先求 realpath**，再把未创建段拼回 | 新建文件时 `realpathSync(target)` 会 ENOENT；不能因此放行（否则「先创建符号链接目录再写」的绕过就成立了） |
| **realpath 失败 = 拒绝** | `realpathSync(root)` 抛错 → `deny`，**不 fail-open** | 安全底线：任何「算不出来」的情况一律拒绝（plan §9「审批 fail-open」风险表的同款口径） |

### 2.3 符号链接逃逸怎么防（关键）

**逃逸场景**：模型先 `write` 一个符号链接（或 `bash ln -s`，但 note/desk 无 bash），再往里写 → 物理落点跑到 outbox 外。

**Windows 前提**（D-04 已定：只对 Windows 负责）：创建符号链接需要管理员权限或开发者模式；目录联接（junction）**普通用户即可创建** ⇒ **不能因为「Windows 建符号链接难」就跳过这条**，junction 这条洞真实存在。

**防法就是 §2.2 的「对最深已存在祖先求 realpath」**：

- 假设 `outbox/link` 是指向 `C:\evil` 的 junction。
- 模型写 `outbox/link/x.txt`：
  - `target = outbox/link/x.txt`，`x.txt` 不存在；
  - 向上找到最深已存在祖先 = `outbox/link`（junction 本身存在）；
  - `realpathSync("outbox/link")` = **`C:\evil`**（realpath 会解开 junction）；
  - `final = C:\evil\x.txt`，**不以 `outbox` 前缀开头** → **拒绝** ✅。
- 对照错误做法：如果只看 `target` 字符串前缀，`outbox/link/x.txt` 是「以 outbox 开头」的，**会被误放行** ⇒ 所以**必须 realpath，不能只比字符串**。

**`read` 要不要也校验？** 建议**不拦**（`note`/`desk` 的 `read` 用于读 PDF/长文，用户可能让它读 outbox 外的资料；本期 `read` 归「只读 allow」）。但要在文档里**显式写明这是取舍**：沙箱保的是「不往外面**写**」，不承诺「不往外面**读**」。若将来要收，加同一个 `isInside` 判定即可（钩子已就位）。

### 2.4 与 `bash` 的关系（再次确认 plan §3.4.4）

- `quick`/`note`/`desk` **不提供 `bash`/`powershell`**（`protocol.js` 的 `toolAllowlist` 已不含，`noTools:'all'` for quick）⇒ **物理上没有能越过 outbox 的工具**（`write` 被钩子拦）。
- `repo` 场景**有** bash/powershell ⇒ **沙箱对它无效**（bash 能 `cd /`）。这是 plan §3.4.4 明确的取舍，`repo` 的防线是**审批闸门**（人看着整条命令决定）。
- **因此：沙箱规则只对 `OUTBOX_SCENES` 生效**（`protocol.js:230` 已有该常量），判定入口用 `OUTBOX_SCENES.includes(sceneId)` 分流，避免把 outbox 校验误加到 repo 上（会把 repo 的正常写文件全拦掉）。

### 2.5 沙箱与 §3.3 审批闸门：**同一个钩子的两条规则**（明确回答）

> **结论：不是两套机制，是同一个 `pi.on("tool_call")` 钩子里的两条并列规则。**
> 顺序：**先沙箱硬拦（deny，不给用户选）→ 再审批（ask，交给用户）**。

理由与设计：

1. **钩子只有一处**（`session.js:642` 的 `registerGate(pi, …)` 已预留挂载点）。两条规则都返回 `ToolCallEventResult`，语义天然兼容（`block:true` 都可表达）。
2. **顺序不能反**（安全性关键）：
   ```
   tool_call(event):
     if sceneId in OUTBOX_SCENES:
        if tool in (write, edit) and not isWriteAllowed(target, outbox):
            return { block: true, reason: SANDBOX_DENY_REASON }   # ← 硬拦，不弹卡
     # 走到这里说明「要么不在沙箱场景，要么目标合法」
     decision = policy.classify(event.toolName)   # allow / ask / deny（§3.3）
     ...
   ```
   - **先沙箱后审批**：沙箱违例**不给用户「允许」的选项**。否则用户手滑点「允许一次」，沙箱就形同虚设了。
   - 反过来（先审批后沙箱）会出现「用户批准了却被沙箱拒」的困惑 UI。
3. **拒绝文案必须带语义**（已在 spike live 实测：`reason` 逐字回灌成 tool result，模型不重试、改为询问；见 plan §3.3 要点 4）。建议文案（英文，直接给模型）：
   ```
   The target path is outside the allowed output folder. You may only write inside it;
   use a path relative to the working directory. Do not retry other absolute paths.
   ```
4. **`terminate` 不用**：沙箱违例是「单次操作非法」，不是「整轮要停」；给 `block:true` 即可，让模型自己改正路径重试（这是**期望行为**）。只有用户点「中断整轮」才带 `terminate`（且需传播给同批，见 plan §3.3 要点 5）。
5. **`edit` 同样适用**：`edit` 也接收 `path` 且也走 `resolveToCwd`（`edit.ts` 同 `write.ts` 模式）。虽然 `note`/`desk` 白名单里**没有** `edit`，但**规则要对 `edit` 一并生效**，防将来白名单变动时漏掉。

> **归档口径**：M4 交付物 = 「一个钩子 + 两条规则」；代码上建议 **`registerGate` 不变**，把沙箱判定抽成 `src/main/pi/sandbox.js`（纯 Node，可单测），由 `registerGate` 调用。这样 `session.js` 仍只 import SDK，判定逻辑可离线测。

---

## 3. 产出链路（§3.4）的模块设计

### 3.1 新增文件与职责

> 全部新增在 `src/main/pi/`（主进程）与 `src/shared/`。**渲染层不加文件**（零依赖单文件约束）。

| 新增文件 | 职责 | 依赖约束 |
|---|---|---|
| `src/main/pi/outcome/schema.js` | **结构化产出的 JSON Schema + 校验**（纯函数）。定义 `OutcomeDoc` 的形状、必填字段、长度上限；提供 `validateOutcome(json) → {ok, errors}` | 零依赖纯函数（可单测） |
| `src/main/pi/outcome/prompt.js` | 组装「让模型只输出结构化 JSON」的**提示词 + 约束**（含 one-shot 示例、字段说明、失败重试话术） | 零依赖 |
| `src/main/pi/outcome/render-md.js` | `OutcomeDoc` → **Markdown 文本**（**降级兜底格式**，永远可用） | 零依赖 |
| `src/main/pi/outcome/render-docx.js` | `OutcomeDoc` → `.docx` Buffer（**唯一 import `docx` 的地方**） | 只 import `docx` |
| `src/main/pi/outcome/index.js` | **链路编排**：调 LLM 出 JSON → 校验 → 重试一次 → 渲染（docx 失败则 md）→ 落盘 outbox → 发产出卡片事件 | 编排层，调上面四个 + `session.js` 的模型能力 |
| `src/main/pi/sandbox.js` | outbox 路径校验（§2 的 `isWriteAllowed`），**纯 Node 可单测** | 零依赖（只用 `node:fs`/`node:path`） |
| `src/main/pi/approval.js` | 审批闸门状态机（pending/resolved、超时、batch、持久化） | 零依赖（bridge 通过回调注入） |

**编排位置的关键约束**：产出链路要**调一次 LLM 拿 JSON**。主进程**只有 `session.js` 可 import Pi SDK**（团队约定 §约束）⇒ **`outcome/index.js` 不能自己 import SDK**，必须通过 `session.js` 暴露的一个方法（如 `session.generateOutcome(sessionId, intent)`）间接调用。建议在 `session.js` 上新增**唯一一个**出口方法，内部用现有的 Pi 会话完成「一次结构化输出」（复用同一 `ModelRuntime`，不新建会话）。

#### 3.1.1 `session.js` 出口方法签名（已钉死，白客按此实现）

```js
/**
 * 一次性结构化输出：复用既有 Pi 会话，要求模型只回一段 JSON，返回原始文本。
 * ⚠ 命名刻意避开 prompt/ask 等词 —— 它是「一次性结构化输出」，不是 prompt 变体：
 *    · 不写 rec.seq / 不进 RingLog —— 它不是对话轮次，不该污染事件流
 *    · 不影响 rec.status、不推 message_* 事件 —— UI 不该看见它，产出卡片才是用户可见面
 *    · 入参出参**不暴露任何 Pi SDK 类型**（纯 string 进出）
 * @param {{ sessionId: string, instruction: string, timeoutMs?: number }} input
 * @returns {Promise<{ text: string, model: string|null }>}
 * @throws 超时 → ERROR_CODES.INTERNAL「结构化输出超时」；同步抛错 → PI_UNAVAILABLE
 */
async generateStructured(input) { /* ... */ }
```

**实现要点（白客注意，这三条是本任务的难点）**：

1. **拿文本**：在 `registerGate` 的 `tool_call` 钩子之外，另挂一次 `pi.on("message_update", ...)`（或复用订阅）收集 `text_delta` 到本地 buffer，**并同时挂 `pi.on("agent_end")` / `agent_settled`** 作为收口信号 —— 与 `_subscribe()` 里已有的事件判定口径**完全一致**（用 `isTextDelta()` / `isTurnSettled()`，不要另造判断）。
2. **不污染会话**：本调用**不得**调用 `_appendAndEmit()`、**不得**递增 `rec.seq`。这是刻意的 —— 产出链路是「旁路」，不是对话轮次。
3. **超时必须硬收**：`timeoutMs` 缺省 `LIMITS.OUTCOME_TIMEOUT_MS`（建议 60_000）。超时后调 `rec.session.abort()` 并 reject。**绝不**留一个永远 pending 的 Promise（否则产出卡片永不返回）。

**一个已知的架构张力（如实记录，不假装不存在）**：Pi SDK 是否**真的**提供「旁路取一次文本、不入会话历史」的官方途径，本次未核实。若实测发现做不到干净旁路（例如模型回答必然落进 `sessionManager` 的历史），**退而求其次**是：在会话里以 `followUp` 发一条「只输出 JSON」的指令，但从恢复的 JSON 里**剥离 markdown 围栏**、且**接受它会进历史**（对用户体验影响很小 —— 用户看到的是产出卡片，不是原始 JSON）。**无论走哪条路，都必须把这个事实写进 `session.js` 顶部注释**，不要留一个「看起来干净但实际不干净」的实现。

### 3.2 docx 选型结论：**`docx`（npm，纯 JS）合适，采纳**

| 方案 | 依赖形态 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|
| **`docx`（npm）** | 纯 JS，无原生二进制，ESM/CJS 均可 | **零原生依赖**（不破坏「Electron 主进程 ESM + 无构建链」）；API 面向对象、可生成正式样式；活跃维护 | 包体较大（数 MB）；样式能力比 python-docx 略弱 | ✅ **采纳** |
| `docxtemplater` | 纯 JS | 模板文件 + `{占位符}` 填充，模板可人改 | 需要一个 `.docx` 模板文件**随 App 分发**（打包要带资源，增加「无构建链」的摩擦）；商用模块（样式）需授权 | 🟡 备选（若将来要复杂模板再评估） |
| `python-docx` | **需要外部 Python 运行时** | API 成熟 | **引入 Python 依赖**——用户机器不一定有；要管 sidecar 生命周期（违反「够用、成熟、少依赖」） | ❌ **否** |
| 手写 OOXML（拼 ZIP） | 零依赖 | 极致可控 | 与 plan §3.4.1 明确禁止的「逐字节生成」同源，维护成本高、易产出坏文件 | ❌ **否** |

**理由归纳（对应选型三原则）**：
- **够用**：本期 `OutcomeDoc` 只有 `title / date / sections[{heading, bullets}]`，`docx` 的 `Document + Paragraph + HeadingLevel + TextRun` 完全覆盖。
- **成熟**：`docx` 是 npm 上主流 docx 生成库，周下载量高、长期维护。
- **少依赖**：纯 JS、无原生编译、无外部运行时 ⇒ 不改动现有 `package.json` 的构建/启动链路（`scripts/start.mjs` 不受影响）。

**新增依赖**：`package.json` → `dependencies` 加 `"docx": "<pin 到具体版本>"`（与现有 `@earendil-works/pi-coding-agent` 一样 **pin 死版本**，不用 `^`）。

**✅ T0.5 实测结论（已完成，2026-09-23）—— `docx` 在 Electron 44 主进程 ESM 下可用，选型不变：**

在 Electron 44.4.3 主进程 ESM 下实跑，**用仓库 `node_modules` 里正式安装的 `docx@9.7.1`**（探测脚本 `spike/docx-runtime/probe-main.mjs`，产物 `spike/docx-runtime/out/report.docx`，完整记录见 `spike/docx-runtime/RESULT.md`）：

```
PROBE_RESULT {"electron":"44.4.3","node":"24.21.0","chrome":"152.0.7977.130",
"moduleType":"ESM main process","importOk":true,
"namedExports":{"Document":"function","Packer":"function","Paragraph":"function","HeadingLevel":"object","TextRun":"function"},
"toBufferOk":true,"ms":62,"bytes":8722,"isBuffer":true,"magic":"504b","magicOk":true}
```

| 判定项 | 结果 | 含义 |
|---|---|---|
| `importOk` | `true` | `docx` 的 ESM 入口在 Electron 主进程顶层 `import` 下**直接可用**，无需 CJS 包装 |
| `namedExports` | 全部可用 | `Document` / `Packer` / `Paragraph` / `HeadingLevel` / `TextRun` 具名导出正常 |
| `toBufferOk` / `isBuffer` | `true` / `true` | `Packer.toBuffer()` 返回真实 `Buffer`（**团队负责人特别要求验证项**） |
| `ms` | `62` | 单次生成耗时 62ms，对 ≤15s 预算占比极小 |
| `bytes` / `magic` | `8722` / `504b` | **ZIP 魔数 `PK` 正确** ⇒ 合法 docx 容器（不是坏文件） |

**产物合法性校验（不只是 zip，是合法 Word 文档）**：22 个 OOXML 部件，`[Content_Types].xml` / `word/document.xml` / `word/styles.xml` / `word/numbering.xml` / `_rels/.rels` **无缺失**；中文标题「周报」保留（CJK 无误）；标题层级（`pStyle`）与项目符号（`numPr`）均在。

**依赖面**：`docx@9.7.1` 运行时依赖全为纯 JS（`jszip`/`xml`/`xml-js`/`nanoid`/`hash.js`），**无原生二进制、无外部运行时**；包形态 `"type":"module"` + `exports.import → ./dist/index.mjs`，ESM 一等公民。

⇒ **`render-docx.js` 直接顶层 `import { Document, Packer, Paragraph, HeadingLevel, TextRun } from "docx"` 即可**，`docxtemplater` 退路**不需要**。**T0.5 关闭。docx 已写入 `package.json`（`"docx": "9.7.1"`，pin 死）。**

**⚠ 两条已踩过的坑（写进 `render-docx.js` 的注释）**：

1. **动态 `import()` 必须传 `file://` URL**：Electron 主进程 ESM 下 `import("docx")` 的相对/裸说明符解析与 Node 不完全一致；若将来要从顶层静态 import 改动态 import（例如懒加载省启动时间），必须 `import(pathToFileURL(require.resolve("docx")).href)`，否则报 `ERR_MODULE_NOT_FOUND`。**本期用静态 import，无此问题。**
2. **`npm install` 曾被 `node_modules` 卫生问题挡住**（与 `docx` 无关）：仓库 `node_modules` 里残留 **93 个 npm 暂存目录**（形如 `node_modules/@esbuild/.win32-x64-RDFvFRLX`、`node_modules/@earendil-works/.pi-coding-agent-9afo2KgZ`），是**上一次被中断的安装**留下的孤儿目录：无有效 `version`、且**未被 `package-lock.json` 引用**（已核验 0 条匹配）。npm 10.9.7 的 `canDedupe → semver.gte` 读到空 version 即抛 `Invalid Version:`。**解法**：把这些孤儿目录移出（含一个 **133MB 的 `pi-coding-agent` 重复副本**），再 `npm install docx@9.7.1 --save-exact`，随即成功。**处理后已回归验证**：`npm ls docx @earendil-works/pi-coding-agent` 两者正常、pi SDK `import` 仍 152 个导出、electron 二进制完好。**升级依赖时若再遇 `Invalid Version`，先查 `node_modules` 里有没有 `.pkg-RANDOM` 暂存残留。**

### 3.3 「降级为 Markdown」的触发条件与实现位置

**触发条件（三条，任一命中即降级）**：

| # | 触发条件 | 判定点 | 降级动作 |
|---|---|---|---|
| 1 | 首次 JSON **schema 校验失败** → 重试一次 → 仍失败 | `outcome/index.js` 校验后 | 放弃结构，**直接把模型的自然语言回答写 `.md`** |
| 2 | `render-docx.js` **抛错**（docx 库异常 / Buffer 生成失败） | docx 渲染返回处 | 改调 `render-md.js`，写 `.md` |
| 3 | **落盘失败**（outbox 不可写、磁盘满、路径被占） | `fs.writeFile` catch | 至少把 Markdown 文本**留在对话里**（卡片给「复制」而非「打开」），**绝不空手而归** |

**实现位置**：**全部在 `outcome/index.js` 的编排层**，`render-*.js` 各自只负责「输入 doc，输出内容」、**不含降级决策**（保持纯函数、可单测）。

**降级必须对用户可见**：产出卡片上要**明确标出**「已降级为 Markdown」而不是假装成功（对应 plan M5 验收「模型报错时降级仍要有东西交出去」）。

### 3.4 产出卡片契约字段（建议新增到 `protocol.js`）

> `protocol.js` 是**主/渲染共享的唯一契约**，且**字段名冻结**。下表是**建议新增**（不动已有字段）。

**新增 `INVOKE`**：

| 通道常量 | 值 | 入参 | 出参 | 说明 |
|---|---|---|---|---|
| `GENERATE_OUTCOME` | `"minipi:generateOutcome"` | `{ sessionId, intent, format? }`<br>`intent`: 用户那句「整理成周报」<br>`format`: `"auto" \| "md" \| "docx"`（缺省 `auto`） | `{ outcomeId, format, fileName, absPath, degraded: bool, bytes, createdAt }` | 触发产出链路；返回产出物元信息（**不回传文件内容**） |
| `OPEN_OUTCOME` | `"minipi:openOutcome"` | `{ outcomeId }` | `{ ok: bool }` | 主进程调 `shell.openPath` 打开 |
| `SAVE_OUTCOME_AS` | `"minipi:saveOutcomeAs"` | `{ outcomeId }` | `{ savedPath \| null, canceled: bool }` | 弹系统「另存为」 |
| `LIST_OUTCOMES` | `"minipi:listOutcomes"` | `{ limit?: number }` | `{ items: OutcomeSummary[] }` | Full 态列历史产出（可选，P2） |

**新增 `EVENTS`**：

| 通道常量 | 值 | 载荷 |
|---|---|---|
| `OUTCOME` | `"minipi:outcome"` | 产出卡片推送；承载 `OutcomeCard`（见下） |

**新增 `ERROR_CODES`**：

| 错误码 | 何时 | 给用户的说明口径 |
|---|---|---|
| `OUTCOME_JSON_INVALID` | schema 校验两次都失败 | 内部标记（对用户表现为「已降级为 Markdown」） |
| `OUTCOME_RENDER_FAILED` | docx 渲染失败 | 同上 |
| `OUTCOME_WRITE_FAILED` | 落盘 outbox 失败 | 「无法写入产出目录」 |
| `OUTCOME_NOT_FOUND` | `openOutcome` 的 id 查不到 | 「产出物不存在或已被移动」 |
| `SANDBOX_DENIED` | `tool_call` 沙箱拦截 | 「该操作试图写入产出目录之外」（**给模型**的 reason 用英文，见 §2.5） |

**新增数据结构（放 `protocol.js`，与 `SCENE_DEFS` 同风格）**：

```js
/** 产出格式取值域（D-22）。 */
export const OUTCOME_FORMAT = Object.freeze({ MD: "md", DOCX: "docx" });

/** 产出格式的合法取值（用于入参校验，与 OUTCOME_FORMAT 同源）。 */
export const OUTCOME_FORMAT_IDS = Object.freeze(Object.values(OUTCOME_FORMAT));

/** 产出卡片的三个动作（本期固定，不开放扩展）。 */
export const OUTCOME_ACTIONS = Object.freeze(["open", "saveAs", "revise"]);

/** 产出卡片（主 → 渲染，随 EVENTS.OUTCOME 推送）。 */
// {
//   outcomeId: "o_1",
//   sessionId: "s_1",
//   format: "docx",            // "md" | "docx"
//   degraded: false,           // true = 已从 docx 降级为 md
//   fileName: "周报-2026-09-23.docx",
//   bytes: 12345,
//   title: "周报",
//   createdAt: 1730000000000,
//   actions: ["open", "saveAs", "revise"],  // 卡片三按钮，本期固定这三项
// }

/** 产出物上限（宿主层强制）。 */
// LIMITS 里建议新增：
//   OUTCOME_TITLE_MAX_CHARS: 120,
//   OUTCOME_SECTIONS_MAX: 50,
//   OUTCOME_BULLET_MAX_CHARS: 2000,
//   OUTCOME_FILE_MAX_BYTES: 10 * 1024 * 1024,
//   OUTCOME_TIMEOUT_MS: 60000,        // generateStructured 的硬超时（§3.1.1）
//   OUTCOME_INTENT_MAX_CHARS: 2000,   // 用户那句「整理成周报」的长度上限
```

> **`fileName` 的生成规则（必须钉死，否则前后端会各写一套）**：`title` 去掉 Windows 非法字符 `\ / : * ? " < > |` 与控制字符 → 截到 `LIMITS.OUTCOME_TITLE_MAX_CHARS` → 拼 `-YYYY-MM-DD` → 加扩展名。**纯函数，放 `outcome/schema.js`，名字 `buildFileName(title, format, date)`**，两侧共用。

> **卡片三按钮对应 plan §3.4.2 第 ④ 步**：`[打开] [另存为] [再改改]`。
> 卡片必须能在 **360×480 小窗内不换行、不溢出**（M5 验收）⇒ `fileName` 要**中间截断**（保留扩展名），`title` 要**单行省略**。

---

## 4. 兼容与迁移

### 4.1 老 settings.json 里的 `sceneId: "speed"`

**建议：静默映射（不弹窗、不报错），并在写回时顺手把值改成新名。**

**理由**：
1. **`speed` → `quick` 是纯重命名**（plan §3.2 重命名对照表），语义不变 ⇒ 老用户的意图（「我要随手问」）**在新体系里完全等价**，没有任何需要用户决策的分歧点。弹窗问「要不要迁移」是**把工程问题推给用户**。
2. 现有 `SettingsStore` **本身就不校验 sceneId 合法性**（`settings.js:99-104` 只做长度/类型兜底，注释明确说「合法性由 scenes.js 判定」）⇒ 一个存着 `"speed"` 的 settings **不会让 App 起不来**，但会在 `createSession` 时抛 `SCENE_NOT_FOUND`，导致**老用户升级后第一次用就报错**。**这是必须处理的实际故障**（P0）。
3. 静默映射成本极低：一个 `LEGACY_SCENE_MAP` 常量 + 一处转换。

**实现位置**：`src/main/settings.js` 的 `normalizeSettings()` 里，**在 `sceneId` 校验前**加一层映射：

```js
// protocol.js 里新增（共享，渲染层镜像同步）
export const LEGACY_SCENE_MAP = Object.freeze({
  speed: "quick",   // 纯重命名
  study: "note",    // 纯重命名
  work:  "repo",    // 纯重命名，但语义扩展（见下）
});
export function migrateSceneId(v) { return LEGACY_SCENE_MAP[v] ?? v; }
```

- ✅ `speed→quick`、`study→note`：**无条件静默映射**（零风险）。
- 🟡 `work→repo`：**静默映射，但要额外记一条日志**（`console.warn` + `settings.warnings`）。理由：`work` 老场景 cwd 是 `~/.minipi/work`，新 `repo` 是 `~/.minipi/repo`，且 `repo` 语义上「唯一允许选真仓库」——老用户升级后场景名变了、目录名也变了，**值得留痕便于排查**，但**仍不打断用户**。
- 映射发生在 `SettingsStore.load()` 之后、`get()` 之前；**映射结果会在下一次 `persist()` 时写回磁盘**（老值自然消失，无需专门的迁移脚本）。

> **⚠ 反向禁止**：**不要**在 `createSession` 里做映射（那只在调用时生效，settings 里仍是脏值，每次都要映射）。**要在 `normalizeSettings` 里做**（一次归一化，全链路一致）。

### 4.2 老的 `~/.minipi/scratch` / `study` / `work` 目录

**采纳团队负责人的倾向：不主动删，只记录。**

**理由**：
1. **删用户数据是不可逆的**。虽然这些目录理论上只含 minipi 自己的产出，但用户可能**手动把东西放进去过**（尤其 `study` 目录），或**在里面保存过重要笔记**。产品没有「我知道这里面是什么」的确证，**就没有删的资格**。
2. 这几个目录的**存在是无害的**：新代码不再把它们当 cwd，它们就是几个**休眠的空目录**（或老数据），不占运行路径、不进任何逻辑分支。
3. 与 D-20/D-21 的**产品姿态一致**：minipi 的定位是「用户感觉不到文件系统」——**主动删目录恰恰是让用户「感觉到」的行为**（下次他打开 `~/.minipi` 会发现东西没了）。

**具体做法**：
- `ensureAppDirs()` **不创建**这三个目录（已改，正确——只在 `SCENE_CWD_DIRS` 里，不含 scratch/study/work）。
- 启动时**不做任何探测/清理**。
- **只记录**：首次加载 settings 且触发过 `LEGACY_SCENE_MAP` 时，在日志里写一行 `检测到 v0.4 之前的场景名，已映射；旧目录未清理（scratch/study/work）`，并在 `docs/` 的升级说明里告知用户「旧的 `~/.minipi/{scratch,study,work}` 可自行删除」。

> **不做的**：不弹「是否删除旧目录」的对话框（打扰用户）、不做后台静默清理（不可逆且无收益）。

---

## 5. 任务清单（含验收 + 优先级）

> 优先级定义：**P0 = 不做就会坏**（用户可见故障 / 安全底线 / 核心链路不可用）；**P1 = 影响体验或防后续漂移**；**P2 = 打磨/注释/一致性**。
> 归属角色按现有团队分工：`主进程` / `渲染层` / `架构` / `测试`。

### P0（必须先做，阻塞后续）

| # | 任务 | 角色 | 验收标准 |
|---|---|---|---|
| **T0.1** | 场景名残留全清（§1.1 A1/A2 + §1.2 B1~B7/B9） | 主进程 + 渲染层 | ① 全文搜 `speed`/`study`/`scratch` 零命中（注释历史说明除外）；② 渲染层场景按钮是**四个** `quick/note/desk/repo`；③ `createSession({sceneId:"study"})` 返回 `SCENE_NOT_FOUND: sceneId 必须是 quick / note / desk / repo 之一`（**动态生成**，非硬编码） |
| **T0.2** | 老 settings 迁移（§4.1） | 主进程 | ① 手写一份 `settings.json` 含 `"sceneId":"speed"` → 启动 → `getSettings().sceneId === "quick"`；② `study`→`note`、`work`→`repo` 同上；③ 迁移后磁盘文件里已是新值；④ 未知 sceneId（如 `"foobar"`）**不被映射**，仍按原逻辑处理（走到 createSession 才报错） |
| **T0.3** | outbox 沙箱校验实现 + 挂进 `tool_call`（§2） | 主进程 | ① `note` 场景要求 `write` 到 `../../x.txt` → **被 block**，模型收到 reason 后**不重试**该操作；② `write` 到 `/tmp/x`（或 `C:\Windows\x`）→ 被 block；③ `write` 到 `outbox/son.txt` → **成功落盘**；④ **junction/符号链接逃逸**：在 outbox 内建一个指向外部的 junction，写 `outbox/link/x` → **被 block**（realpath 解析后不在 outbox 内）；⑤ 前缀陷阱：`outbox-evil/x` → **被 block**；⑥ `repo` 场景同样操作**不被沙箱拦**（走审批闸门） |
| **T0.4** | 产出链路端到端可用（Markdown 先行）（§3） | 主进程 | ① 在 `desk` 场景说「把刚才聊的整理成周报」→ outbox 出现一个 **`.md`** 文件；② 卡片返回 `format:"md"` + `fileName`；③ 点「打开」能弹出文件；④ 全程**不离开悬浮球**；⑤ 从选中文字到看见卡片 **≤ 15 秒**（计时） |
| **T0.5** | docx 依赖可用性实测（§3.2 的 ⚠） | 测试 | ✅ **已完成（2026-09-23）**：仓库 `docx@9.7.1` 在 Electron 44.4.3 ESM 主进程下 `importOk:true` / `toBufferOk:true`（62ms，真 Buffer）/ `magic:"504b"`；产物为合法 OOXML（22 部件无缺失，CJK/标题/项目符号均在）。**退路不需要**。证据 `spike/docx-runtime/RESULT.md`。结论已回写 §3.2 |
| **T0.6** | **场景名 + cwdTemplate** 一致性静态扫描脚本（§1.4） | 架构 + 测试 | `node scripts/check-scene-consistency.mjs` 在渲染层镜像漂移时**非零退出**并指出差异；一致时零退出。**覆盖两类**：① 场景名键集合 + `DEFAULT_SCENE_ID`；② **四个场景的 `cwdTemplate` 与 `protocol.js` 逐字一致**（团队负责人点名——这条漂了最隐蔽：UI 显示一个路径、实际落另一个）。挂进 `package.json` `verify:*` |

### P1（体验 / 防漂移）

| # | 任务 | 角色 | 验收标准 |
|---|---|---|---|
| **T1.1** | docx 渲染接入产出链路（`render-docx.js`） | 主进程 | 同样「整理成周报」→ 产出 **`.docx`**，`format:"docx"`、`degraded:false`；用 Word/WPS 打开**排版正常**（标题层级 + 项目符号） |
| **T1.2** | 降级链路三条件全测（§3.3） | 主进程 | ① 伪造 schema 失败（模型返回非法 JSON）→ 产出 `.md` 且卡片标 `degraded:true`；② 伪造 docx 渲染抛错 → 同上；③ 伪造 outbox 不可写 → 卡片给「复制」而非「打开」，**有东西交出** |
| **T1.3** | 产出卡片 UI（360×480 内不溢出） | 渲染层 | ① 长文件名（40 字）**中间截断**、单行省略；② 三个按钮在 360 宽内**不换行**；③ 降级时显示「已降级为 Markdown」标识；④ 大窗/小窗形态下卡片都正常 |
| **T1.4** | `stub.html` 探测页场景名对齐（§1.3 C1/C2） | 测试 | 探测页按钮显示「建会话（quick）」，点击成功建 quick 会话 |
| **T1.5** | 审批闸门基础（§3.3，M4 主体） | 主进程 | 同 plan M4 验收（repo 场景：弹卡 + 真实 diff；多 ask 合并一张卡；未决审批持久化；5 分钟超时默认拒绝；`quick` 场景无工具可调）。**v1.1 补**：三按钮「允许一次/拒绝/中断整轮」+ 会话级 always-allow（默认关）。**明细见 `docs/minipi-approval-gate-design.md` v1.1** |
| **T1.6** | 产出物清单接口（`LIST_OUTCOMES`） | 主进程 + 渲染层 | Full 态能列出 outbox 里的历史产出（按 mtime 倒序），点条目能打开 |

### P2（打磨 / 一致性）

| # | 任务 | 角色 | 验收标准 |
|---|---|---|---|
| **T2.1** | 注释里的旧场景名全改（§1.3 C3~C7） | 主进程 | `session.js` / `scenes.js` 注释中不再出现作为场景名的 `speed`/`study`/`work` |
| **T2.2** | mock 控制台色块类名对齐（§1.2 B8） | 渲染层 | mock 控制台无 `chip--study`，改用新类名，视觉正常 |
| **T2.3** | 首次启动「数据出境明示」（plan §10 D-07）文案 | 渲染层 | 首次启动弹一次明示，含「选区原文会发给模型供应商」；「不再提示」可复位 |
| **T2.4** | README「未完成项」更新 | 架构 | README 里 `work` 场景无闸门的旧说明改为 v0.4 口径（repo + 沙箱） |
| **T2.5** | xlsx 的 Markdown 表格兜底提示（D-22） | 渲染层 | 用户要「生成表格」时，产出可复制的 Markdown 表格 + 明确提示「粘进 Excel 自动分列」，**不承诺 .xlsx** |

### 任务依赖图（供排期参考）

```
T0.1 场景名 ─┬─▶ T0.4 产出链路(md) ─▶ T1.1 docx ─▶ T1.2 降级
             ├─▶ T0.2 settings 迁移
             └─▶ T0.6 静态扫描
T0.5 docx 依赖实测 ─────────────────▶ T1.1 docx
T0.3 沙箱 ──▶ T1.5 审批闸门（同钩子，沙箱先行）
T0.4 产出链路 ─▶ T1.3 卡片 UI ─▶ T1.6 产出清单
```

---

## 6. 假设与风险

| 类型 | 内容 | 应对 |
|---|---|---|
| **假设** | 老用户 settings 里出现过的场景名**只有** `speed`/`study`/`work` 三种 | `LEGACY_SCENE_MAP` 只覆盖这三种；其它未知值不映射（不猜） |
| **假设** | 产出链路的「一次 LLM 调用」可复用现有会话的 `ModelRuntime`，无需新建会话 | 若 SDK 要求独立调用，退路是新建一个 `quick` 会话专门出 JSON（需实测） |
| **假设** | `docx` 在 Electron 44 ESM 下可用 | ✅ **已由 T0.5 实测证实**（`magic:504b` 为合法 ZIP），退路方案作废 |
| **风险** | **`docx` 包体较大**（数 MB），且纯 JS 生成 docx 对复杂排版支持有限 | 本期 `OutcomeDoc` 结构极简（标题+项目符号），足够；复杂排版不属于本期 |
| **风险** | **实时校验 write 路径有性能开销**（每次 write 都要 realpath） | write 频率低（不是热路径），开销可忽略；realpath 只对「最深已存在祖先」调一次 |
| **风险** | **模型传 Windows 反斜杠/UNC 路径**（`\\server\share\x`）| `path.resolve` + `realpath` 覆盖；UNC 会解析成绝对路径 → 不以 outbox 开头 → 拒绝 |
| **风险** | **产出链路的 LLM 调用失败**（网络/额度） | 走 §3.3 降级：至少把当前对话内容写成 `.md` |
| **风险** | **场景名镜像再次漂移**（渲染层单文件约束下的结构性问题） | T0.6 静态扫描脚本兜底 |
| **风险** | **沙箱与审批的顺序被后人写反** | 在 `sandbox.js` 与 `registerGate` 各写一条显式注释 + 单测覆盖「沙箱先于审批」 |
| **风险** | **老目录里其实有用户数据，而用户以为已被清理** | §4.2 的「只记录、不删」+ 升级说明明确告知，让用户自己决定 |

---

## 7. 实现回填（v1.1 新增 · 记录最终实现与方案的偏离/增强）

> 目的：方案是「设计意图」，实现是「最终事实」。两者若有差异，**以本节为准**，供后人（和未来的 AI）读代码时不被方案误导。
> 状态截至 2026-09-23：T0.3/T0.4/T0.5 已完成并全绿；**M4 审批闸门主进程侧（契约 + 主体 + 接线）已闭环**（`verify:approval` 195 项全绿），M4.5 渲染层已交付（方砚 51/0 自测）、**独立 QA 进行中**（秦戈）。

### 7.1 已落地的文件（与 §3.1 设计对照）

| 方案第 §3.1 设计 | 实际文件 | 状态 |
|---|---|---|
| `src/main/pi/sandbox.js` | ✅ 存在（11.4KB，白客） | 与设计一致 + 下述增强 |
| `src/main/pi/outcome/schema.js` | ✅ 存在（14.6KB） | **增强**：含宽容归一化 |
| `src/main/pi/outcome/prompt.js` | ✅ 存在（8.0KB） | 一致 |
| `src/main/pi/outcome/render-md.js` | ✅ 存在（3.5KB） | 一致 |
| `src/main/pi/outcome/render-docx.js` | ✅ 存在（4.2KB） | 一致（静态 import docx） |
| `src/main/pi/outcome/index.js` | ✅ 存在（19.4KB） | 一致（编排 + 降级） |
| `src/main/pi/approval.js` | ✅ 存在（白客） | **M4 主进程侧已闭环**：审批闸门状态机（pending/resolved、超时、batch、持久化、always-allow）、脱敏（`redactSecrets` 为全仓唯一实现点）。接线见 `session.js` 规则 2 + `main/index.js` + `preload`。**明细与对账见 `docs/minipi-approval-gate-design.md` §9.4（R1–R6 + T5 全 ✅）** |

### 7.2 实现相对方案的**增强**（采纳，值得保留）

1. **沙箱 Windows 大小写不敏感**（`sandbox.js:144, 196-213`）：方案初版未覆盖；实现补了 win32 下 `toLowerCase` 比较，避免大写 `OUTBOX` 被误杀，且 `OUTBOX-EVIL` 仍正确拦截。已回写 §2.2。
2. **JSON schema 的「宽容归一化」**（`schema.js`）：模型输出漂移时先救一次再判失败——`items` 别名统一为 `bullets`、`content` 字符串按换行/分号拆条、超 50 节截断而非报错。比方案里「校验失败即降级」更稳（`crosscheck-outcome.mjs` 有 3 条专项验收）。**建议 §3.3 的降级触发条件表述据此收紧**：降级前必须经过归一化层。
3. **`LIMITS` 补充**：实现里多了 `OUTCOME_TIMEOUT_MS=60000`、`OUTCOME_INTENT_MAX_CHARS=2000`（方案 §3.4 未列，合理补充）。已由 `verify-outcome.mjs` 覆盖。

### 7.3 实现与方案的**已知差异**（无问题，仅记录）

- §3.1 建议的 `outcome/index.js` **不 import SDK**、经 `session.js` 的 `generateStructured` 间接调用——实现照做（`session.js` 有该方法）。
- 方案 §3.4 列了 `LIST_OUTCOMES`（P2 产出清单）与 `SAVE_OUTCOME_AS`；实现以 `verify-outcome.mjs` 覆盖的契约为准，是否全接线由方砚的卡片 UI 任务（#24）收口。

### 7.4 验证脚本矩阵（全绿现状）

> ⚠ **项数以 `npm run verify:all` 各脚本自报为准，本节数字为回填快照**（脚本扩容后此处可能落后，勿把文档旧数字当权威）。

| 脚本 | 覆盖 | 结果 |
|---|---|---|
| `verify-sandbox.mjs` | 逃逸/前缀陷阱/新建文件/大小写/分流/不 fail-open/钩子形状 | **65/65** |
| `verify-outcome.mjs` | 契约常量/入参防御/prompt 组装 | **97/97** |
| `crosscheck-outcome.mjs` | schema 归一化与模型输出漂移 | 全通过 |
| `check-scene-consistency.mjs` | 场景名/`cwdTemplate`/`DEFAULT_SCENE_ID`/`OUTBOX_SCENES`/chip 类/**全仓库旧名扫描（25 文件）** | **48/48** |
| `verify-v04.mjs` | 四场景解析/旧名拒绝 | **39/39** |
| `verify-approval.mjs` | M4 审批：三 outcome / 超时 / edit diff / 批合并 / 重启丢弃 / 脱敏（含前缀形态）/ fail-closed / R3-R5 / T5 假时钟 + 守卫直测 | **195/195** |
| `verify-all.mjs` | **一键串行回归**：上表纯 Node/headless-Chrome 脚本聚合（不含真 Pi 会话 `verify:live`） | 见 `npm run verify:all` |

### 7.5 待办（回填时未完成）

- **M4.5 渲染层独立 QA**（秦戈 #37 进行中）——方砚自测 51/0，独立 QA 未出结论。
- **真 Electron 端到端**——本机 GPU 崩、起不了真窗口，走 headless Chrome + CDP 兜底；真窗口 E2E 待环境恢复。
- **commit**——工作区非 git 仓库，尚未提交。
- **`spike/docx-runtime/package.json.bak`** 临时文件，若 `spike/` 入库建议清理。

---

## 8. 自检（对应角色守则第三步）

1. **接口契约完整吗**：§3.4 的 `INVOKE`/`EVENTS`/`ERROR_CODES` 已给全字段名。前后端拿到后：渲染层可实现「触发产出 → 收卡片 → 三按钮」，主进程可实现对应 handler，**不需要再沟通**。✅
2. **验收标准可验证吗**：§5 每条验收都是**具体行为**（如「写 `../../x` 被 block」「`getSettings().sceneId === "quick"`」），不写「功能正常」。✅
3. **范围收敛了吗**：本期**只做** md + docx；**明确不做** pptx / 真 xlsx / Jev（D-22/D-24）；**没有**偷偷加「工作区选择器」「自动收起」（D-09/D-10/D-11）。✅
4. **数据模型能支撑接口吗**：产出卡片字段（`outcomeId`/`format`/`degraded`/`fileName`/`bytes`/`title`/`createdAt`/`actions`）全部来自磁盘产出物 + `OutcomeDoc`，无字段悬空。✅
5. **沙箱与审批的关系说清了吗**：§2.5 明确「**同一钩子的两条规则，先沙箱后审批**」，含顺序理由与拒绝文案。✅
6. **实现与方案是否对表**：§7「实现回填」记录了三处增强、两处差异、验证脚本矩阵与待办。✅

---

## 9. 一句话交付

> **v0.4 的施工重心是三条**：① 把「场景名」从三档重命名到四档并**一次性全清残留**（P0，最易漏）；② 把 `outbox` 沙箱做成 **`tool_call` 钩子里的一条硬拦规则**（realpath 防符号链接，先于审批，不 fail-open）；③ 把「随手产出」链路按 **md 先行 → docx 补上 → 降级兜底** 的顺序落地（P0 先出 md，P1 出 docx）。**docx 用 npm `docx`（纯 JS，无原生依赖）成立**（已在 Electron 44 主进程实测）；**Jev 本期不碰**。
>
> **现状（2026-09-23）**：①②③ 均已落地并通过验证脚本（沙箱 65/65、产出 97/97、一致性 48/48、v04 39/39）；**M4 审批闸门主进程侧（契约 + 主体 + 接线）已闭环**（`verify:approval` 195 项全绿），M4.5 渲染层已交付、独立 QA 进行中（秦戈）。项数以 `npm run verify:all` 各脚本自报为准。
