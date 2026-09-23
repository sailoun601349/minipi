# T0.5 · docx 选型实测结论（v0.4 产出链路）

> 执行：任析 · 2026-09-23
> 探测脚本：`spike/docx-runtime/probe-main.mjs`
> 产物：`spike/docx-runtime/out/report.docx`

## 一句话结论

**采纳 `docx`（npm，纯 JS，v9.7.1）。在 Electron 44.4.3 ESM 主进程下实测可用，`import` 与 `Packer.toBuffer()` 均通过，产物是合法 OOXML。**

## 实测环境（生产条件，非纯 Node）

| 项 | 值 |
|---|---|
| Electron | **44.4.3**（仓库 `node_modules/electron`） |
| 主进程模块格式 | **ESM**（`"type":"module"` + `.mjs`） |
| 内嵌 Node | 24.21.0 |
| Chrome | 152.0.7977.130 |
| docx | **9.7.1**（`--save-exact`，已写入 `package.json` dependencies） |
| 启动注意 | **必须 `env -u ELECTRON_RUN_AS_NODE`**（本机该变量=1，不清则 electron 退化成纯 Node，`import {app}` 报 `does not provide an export named 'app'`） |

## 实测结果（原始输出）

```json
PROBE_RESULT {"electron":"44.4.3","node":"24.21.0","chrome":"152.0.7977.130","moduleType":"ESM main process","importOk":true,"namedExports":{"Document":"function","Packer":"function","Paragraph":"function","HeadingLevel":"object","TextRun":"function"},"toBufferOk":true,"ms":62,"bytes":8722,"isBuffer":true,"magic":"504b","magicOk":true,"wrote":"...\\spike\\docx-runtime\\out\\report.docx"}
```

逐项：

| 检查 | 结果 |
|---|---|
| `import { Document, Packer, Paragraph, HeadingLevel, TextRun } from "docx"`（Electron 主进程 ESM） | ✅ 全部 named export 可用 |
| `Packer.toBuffer(doc)`（**团队负责人特别要求验证项**） | ✅ 通过，耗时 **62ms** |
| 返回类型 | ✅ 真 `Buffer`（`isBuffer:true`） |
| ZIP/OOXML 魔数 | ✅ `504b` |
| 落盘 | ✅ 写出 8722 字节 |

## 产物合法性校验（不只是 zip，是**合法 Word 文档**）

| 检查 | 结果 |
|---|---|
| OOXML 部件数 | 22 |
| 必需部件 `[Content_Types].xml` / `word/document.xml` / `word/styles.xml` / `word/numbering.xml` / `_rels/.rels` | ✅ **无缺失** |
| 中文标题「周报」写入 `document.xml` | ✅ 保留（CJK 无误） |
| 标题层级（`pStyle`/Heading） | ✅ 存在 |
| 项目符号（`numPr`） | ✅ 存在 |

## 依赖面（对应「少依赖」原则）

- docx 9.7.1 的**运行时依赖全部是纯 JS**：`jszip` / `xml` / `xml-js` / `nanoid` / `hash.js`。
- **无原生二进制、无 node-gyp、无外部运行时**（对比 `python-docx` 需要 Python sidecar）。
- `@types/node` 是其声明依赖但**仅类型用**，不影响运行时。
- 体积：docx 本体约 4.5MB，含依赖整树约 9.9MB。
- 包形态：`"type":"module"`，`exports.import → ./dist/index.mjs`，**ESM 一等公民**，与「零构建链 + ESM 主进程」完全兼容。

## 附带修复：node_modules 卫生问题（重要，供团队知悉）

安装 docx 时 `npm install` 一度报 `npm error Invalid Version:`（栈在 `@npmcli/arborist` 的 dedupe）。

**根因**：仓库 `node_modules` 里残留了 **93 个 npm 暂存目录**（形如 `node_modules/\@esbuild/.win32-x64-RDFvFRLX`、`node_modules/@earendil-works/.pi-coding-agent-9afo2KgZ`），是**上一次被中断的安装**留下的孤儿目录。它们：① 无有效 `version`；② **未被 `package-lock.json` 引用**（已核验：lockfile 中 0 条匹配暂存模式）。arborist 在 dedupe 时读到空 version 即崩溃。

**处理**：把这 93 个孤儿目录移出（含一个 **133MB 的 pi-coding-agent 重复副本**，已改名为 `_orphan_dup_pi-coding-agent_133MB_DELETEME`，物理字节仍在，可后续手动删）。随后 `npm install` 正常、树重建成功。

**处理后回归验证（均通过）**：

| 检查 | 结果 |
|---|---|
| `npm ls docx @earendil-works/pi-coding-agent` | ✅ `docx@9.7.1` + `pi-coding-agent@0.87.0` 均解析正常 |
| `import("@earendil-works/pi-coding-agent")` | ✅ 152 个导出，`createAgentSession`/`ModelRuntime`/`SessionManager` 均在 |
| `electron.exe` 二进制 | ✅ 存在（postinstall 校验通过，electron 44.4.3） |

> ⚠ **遗留物**：`node_modules/@earendil-works/_orphan_dup_pi-coding-agent_133MB_DELETEME`（133MB），建议某次空闲时手动 `rm -rf`。它的存在不影响运行（非 canonical 路径）。

## 对排期的影响

**T1.1（docx 渲染接入）不需要改形态**，按原 `render-docx.js` 设计直做。无退路方案被动用（`docxtemplater` / CJS 动态 import 均**不需要**）。

## 给实现的硬约束（从本次实测沉淀）

1. `package.json` 的 `docx` **必须 pin 死 `"9.7.1"`**（不用 `^`），已如此。
2. 启动脚本对 Electron 的 spawn **必须过滤 `ELECTRON_RUN_AS_NODE`**（`scripts/start.mjs` 已有此防线，此坑再次确认）。
3. `render-docx.js` 里 `import` docx 建议用**静态 import**（实测在主进程 ESM 下正常）；若将来要为「不装 docx 也能跑」做可选依赖，再改 `await import("docx")` 动态形式。
4. `Packer.toBuffer()` 单次约 **62ms**（本机、简单文档）——属于「可接受」，产出链路总耗时预算（≤15s）里它占比很小。
