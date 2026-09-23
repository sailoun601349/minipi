/**
 * `OutcomeDoc` → `.docx` Buffer。
 *
 * ## 这是**唯一** import `docx` 的文件
 *
 * 产出铁律：**模型绝不能直接生成 docx**（docx 是 ZIP 容器，逐字节写必坏）。
 * 正确做法是「模型只出结构化 JSON，代码用 `docx` 库填模板落盘」。
 * 全仓库只有本文件碰 `docx` 库 —— 一是集中依赖便于将来换库，
 * 二是让 `docx` 的异常只在这里产生、由 `outcome/index.js` 编排层统一决定降级。
 *
 * ## ⚠ 两条已踩过的坑（照抄方案 §3.2，改代码前先读）
 *
 *   1. **动态 `import()` 必须传 `file://` URL**：
 *      Electron 主进程 ESM 下 `import("docx")` 的相对/裸说明符解析与 Node 不完全一致。
 *      若将来要从顶层静态 import 改动态 import（例如懒加载省启动时间），
 *      必须 `import(pathToFileURL(require.resolve("docx")).href)`，否则报
 *      `ERR_MODULE_NOT_FOUND`。**本期用静态 import，无此问题。**
 *
 *   2. **不要把 docx 换成逐字节写**：
 *      docx 是 ZIP 容器（内含 `[Content_Types].xml` / `word/document.xml` 等），
 *      手工拼字节必产出坏文件。方案 §3.2 已实测 `docx` 在 Electron 44.4.3 主进程
 *      ESM 下可用（`toBufferOk:true` / `bytes:8620` / `magic:"504b"`），退路作废。
 *
 * ## 异常策略：**不吞错**
 *
 * 本文件**不加 try/catch**。`docx` 库抛错就让错误抛出去，由 `index.js` 编排层
 * 决定「降级为 Markdown」。这样做是为了让降级决策**集中在一处**，
 * 而不是散落在每个渲染器里 —— 渲染器各管一种格式、各是纯函数，才好单测。
 *
 * 方案出处：`docs/minipi-v0.4-impl-plan.md` §3.1 / §3.2。
 */

import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";

/**
 * 把一份 `OutcomeDoc` 渲染成 `.docx` 的 Buffer。
 *
 * **返回 Buffer，不落盘** —— 落盘是 `outcome/index.js` 的事。
 * 这样本函数保持纯（同 doc 同 bytes），也便于单测（直接看 Buffer 前两字节是不是 PK）。
 *
 * @param {import("./schema.js").OutcomeDoc} doc
 * @returns {Promise<Buffer>} docx 文件内容（ZIP 容器，前两字节 `0x50 0x4b`）
 * @throws `docx` 库的任何异常（**故意不吞**，交给编排层降级）
 */
export async function renderDocx(doc) {
  const title = String(doc?.title ?? "").trim() || "未命名";

  /** @type {Paragraph[]} */
  const children = [];

  // ---- 标题（Heading 1）----
  children.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      children: [new TextRun({ text: title, bold: true })],
    }),
  );

  // ---- 副标题（斜体小字，每条一段）----
  if (Array.isArray(doc?.subtitle)) {
    for (const s of doc.subtitle) {
      const t = String(s ?? "").trim();
      if (t.length === 0) continue;
      children.push(
        new Paragraph({
          children: [new TextRun({ text: t, italics: true })],
        }),
      );
    }
  }

  // ---- 各节 ----
  const sections = Array.isArray(doc?.sections) ? doc.sections : [];
  for (const section of sections) {
    if (!section || typeof section !== "object") continue;

    const heading = String(section.heading ?? "").trim() || "（无标题）";
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun({ text: heading })],
      }),
    );

    const bullets = Array.isArray(section.bullets) ? section.bullets : [];
    for (const bullet of bullets) {
      const text = String(bullet ?? "");
      if (text.trim().length === 0) continue;
      // 用 docx 自带的 bullet 段落（level 0），而不是手打 "· " 前缀 ——
      // 前者是**真正的 Word 项目符号列表**，在 Word/WPS 里能被识别为列表，
      // 后者只是一段以点开头的普通文字，用户无法改层级、也无法自动编号。
      children.push(
        new Paragraph({
          text,
          bullet: { level: 0 },
        }),
      );
    }
  }

  const document = new Document({
    sections: [{ children }],
  });

  // Packer.toBuffer 返回真实 Buffer（已实测 isBuffer:true）。
  return await Packer.toBuffer(document);
}
