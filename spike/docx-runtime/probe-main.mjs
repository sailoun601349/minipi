// T0.5 · docx 在 Electron 44 ESM 主进程下的可用性实测
// 生产条件：Electron 44.4.3 / ESM 主进程 / 仓库 node_modules 里的 docx
import process from "node:process";
try { delete process.env.ELECTRON_RUN_AS_NODE; } catch {}

import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function run() {
  const r = {
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    moduleType: "ESM main process",
  };
  try {
    const { Document, Packer, Paragraph, HeadingLevel, TextRun } = await import("docx");
    r.importOk = true;
    r.namedExports = { Document: typeof Document, Packer: typeof Packer, Paragraph: typeof Paragraph, HeadingLevel: typeof HeadingLevel, TextRun: typeof TextRun };

    const doc = new Document({
      sections: [{
        children: [
          new Paragraph({ text: "周报（Electron 主进程生成）", heading: HeadingLevel.HEADING_1 }),
          new Paragraph({ children: [new TextRun({ text: "日期：2026-09-23" })] }),
          new Paragraph({ text: "本周进展", heading: HeadingLevel.HEADING_2 }),
          new Paragraph({ text: "T0.5 docx 在 Electron 44 ESM 下实测通过", bullet: { level: 0 } }),
          new Paragraph({ text: "Packer.toBuffer 在 Electron 主进程可用", bullet: { level: 0 } }),
        ],
      }],
    });

    const t0 = Date.now();
    const buf = await Packer.toBuffer(doc);
    r.toBufferOk = true;
    r.ms = Date.now() - t0;
    r.bytes = buf.length;
    r.isBuffer = Buffer.isBuffer(buf);
    r.magic = buf.subarray(0, 2).toString("hex");
    r.magicOk = r.magic === "504b";

    const out = path.join(__dirname, "out", "report.docx");
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, buf);
    r.wrote = out;
  } catch (err) {
    r.error = String((err && err.stack) || err);
  }
  console.log("PROBE_RESULT " + JSON.stringify(r));
  app.exit(r.importOk && r.toBufferOk && r.magicOk ? 0 : 1);
}

app.whenReady().then(run).catch((e) => {
  console.log("PROBE_RESULT " + JSON.stringify({ fatal: String((e && e.stack) || e) }));
  app.exit(1);
});
