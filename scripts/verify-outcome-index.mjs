/**
 * 产出索引（D-14）验收 —— 纯 Node，不需要 Electron / Chrome。
 *
 * 守的东西（对应 B1 计划 §B-1/B-2/B-3）：
 *   ① 索引与 outbox **对账**：索引有文件无 → 删；文件有索引无 → 补（幂等）
 *   ② **只存文件名**：索引被改成 `..\..\evil` 也出不了 outbox
 *   ③ **删除进回收站**：文件不丢、可恢复，索引同步移除
 *   ④ **坏索引兜底**：解析失败改名 `.bad-<ts>` 后重建，不静默丢用户数据
 *   ⑤ **原子写**：索引始终是合法 JSON
 *   ⑥ 与 OutcomeService 接线：generate 成功 ⇒ 索引里立刻可见（不用重启）
 *
 * 用法：node scripts/verify-outcome-index.mjs（退出码 0 = 全绿）
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { OutcomeStore, titleFromFileName, formatFromFileName } from "../src/main/pi/outcome/store.js";
import { OutcomeService } from "../src/main/pi/outcome/index.js";

let pass = 0;
let fail = 0;
const failures = [];
function ok(cond, label, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${label}${detail === undefined ? "" : `  · ${detail}`}`);
  } else {
    fail += 1;
    failures.push(label);
    console.log(`  FAIL  ${label}${detail === undefined ? "" : `  · ${detail}`}`);
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "minipi-assets-"));
const outbox = path.join(root, "outbox");
const trash = path.join(root, "trash");
const indexPath = path.join(root, "outcomes.json");
const logger = { warn: () => {}, info: () => {} };

function writeOutbox(name, size = 10) {
  fs.mkdirSync(outbox, { recursive: true });
  fs.writeFileSync(path.join(outbox, name), "x".repeat(size), "utf8");
}
function reset() {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(outbox, { recursive: true });
}

console.log("=".repeat(70));

/* ------------------------------------------------------------------ 1 */
console.log("\n[1] 文件名反推");
ok(titleFromFileName("周报-2026-10-21.md") === "周报", "去掉日期后缀得到标题", titleFromFileName("周报-2026-10-21.md"));
ok(titleFromFileName("a-b-c-2026-01-02.docx") === "a-b-c", "标题里的连字符保留");
ok(formatFromFileName("x.MD") === "md", "扩展名大小写不敏感");
ok(formatFromFileName("x.txt") === null, "不认识的扩展名 → null");

/* ------------------------------------------------------------------ 2 */
console.log("\n[2] 对账：文件与索引双向补删");
reset();
writeOutbox("周报-2026-10-21.md", 2048);
writeOutbox("纪要-2026-10-20.docx", 4096);
writeOutbox("readme.txt", 99); // 非产出文件，不该进索引
{
  const store = new OutcomeStore({ outboxDir: outbox, indexPath, trashDir: trash, logger });
  const r = store.load();
  ok(r.items === 2, "首次加载把 2 个产出文件补进索引", JSON.stringify(r));
  ok(store.list({}).items.every((e) => e.format !== null), "非 .md/.docx 不进索引");
  ok(fs.existsSync(indexPath), "索引已落盘");

  // 索引里塞一条幽灵条目（文件已被用户删掉）
  const doc = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  doc.items.push({ fileName: "幽灵-2026-01-01.md", title: "幽灵", bytes: 1, createdAt: Date.now() });
  fs.writeFileSync(indexPath, JSON.stringify(doc), "utf8");

  const store2 = new OutcomeStore({ outboxDir: outbox, indexPath, trashDir: trash, logger });
  const r2 = store2.load();
  ok(r2.dropped === 1, "文件不在 ⇒ 删掉幽灵条目", JSON.stringify(r2));
  ok(!store2.get("幽灵-2026-01-01.md"), "幽灵条目查不到");

  const store3 = new OutcomeStore({ outboxDir: outbox, indexPath, trashDir: trash, logger });
  const r3 = store3.load();
  ok(r3.added === 0 && r3.dropped === 0, "二次对账幂等（无增无删）", JSON.stringify(r3));
}

/* ------------------------------------------------------------------ 3 */
console.log("\n[3] 搜索与排序：置顶优先，其次时间倒序");
reset();
writeOutbox("周报-2026-10-21.md", 100);
writeOutbox("会议纪要-2026-10-20.md", 200);
{
  const store = new OutcomeStore({ outboxDir: outbox, indexPath, trashDir: trash, logger });
  store.load();
  const all = store.list({}).items;
  ok(all.length === 2, "两条都在");
  ok(store.list({ query: "周报" }).items.length === 1, "按标题搜索命中 1 条");
  ok(store.list({ query: "纪要" }).items.length === 1, "按标题搜索命中另一条");
  ok(store.list({ query: "不存在的" }).items.length === 0, "搜不到 → 空数组（不是报错）");
  ok(store.list({ query: "纪要" }).items[0].id === "会议纪要-2026-10-20.md", "搜索结果 id = 文件名");

  // 置顶
  const doc = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  for (const it of doc.items) it.pinned = it.fileName.startsWith("会议纪要");
  fs.writeFileSync(indexPath, JSON.stringify(doc), "utf8");
  const store2 = new OutcomeStore({ outboxDir: outbox, indexPath, trashDir: trash, logger });
  store2.load();
  ok(store2.list({}).items[0].pinned === true, "置顶项排第一");
}

/* ------------------------------------------------------------------ 4 */
console.log("\n[4] 路径安全：索引里塞穿越路径也出不了 outbox");
reset();
writeOutbox("正常-2026-10-21.md", 10);
{
  const doc = {
    version: 1,
    items: [{ fileName: "../../evil.md", title: "evil", bytes: 1, createdAt: Date.now() }],
  };
  fs.writeFileSync(indexPath, JSON.stringify(doc), "utf8");
  const store = new OutcomeStore({ outboxDir: outbox, indexPath, trashDir: trash, logger });
  store.load();
  ok(store.get("../../evil.md") === null, "穿越路径条目在归一阶段就被丢弃（basename 后不存在）");
  ok(store.absPathOf("正常-2026-10-21.md") !== null, "正常条目仍可取绝对路径");
  const abs = store.absPathOf("正常-2026-10-21.md");
  ok(abs && abs.startsWith(path.resolve(outbox) + path.sep), "绝对路径落在 outbox 内");
}

/* ------------------------------------------------------------------ 5 */
console.log("\n[5] 删除：文件进回收站，索引同步移除");
reset();
writeOutbox("待删-2026-10-21.md", 30);
{
  const store = new OutcomeStore({ outboxDir: outbox, indexPath, trashDir: trash, logger });
  store.load();
  const r = await store.remove("待删-2026-10-21.md");
  ok(r.ok === true, "删除返回 ok");
  ok(!fs.existsSync(path.join(outbox, "待删-2026-10-21.md")), "原文件已移走");
  ok(fs.existsSync(r.trashedTo), "回收站里能找到（可恢复）", path.basename(r.trashedTo));
  ok(store.get("待删-2026-10-21.md") === null, "索引已移除");
  ok(store.list({}).items.length === 0, "列表里没有它了");

  let threw = false;
  try {
    await store.remove("不存在.md");
  } catch (err) {
    threw = err?.code === "OUTCOME_NOT_FOUND";
  }
  ok(threw, "删不存在的产出 → OUTCOME_NOT_FOUND");
}

/* ------------------------------------------------------------------ 6 */
console.log("\n[6] 坏索引：改名 .bad 后重建，不静默丢数据");
reset();
writeOutbox("幸存-2026-10-21.md", 10);
{
  fs.writeFileSync(indexPath, "{ 这不是 JSON", "utf8");
  const store = new OutcomeStore({ outboxDir: outbox, indexPath, trashDir: trash, logger });
  const r = store.load();
  ok(r.repaired === true, "标记为已修复");
  ok(fs.readdirSync(root).some((f) => f.startsWith("outcomes.json.bad-")), "坏索引被改名保留现场");
  ok(store.list({}).items.length === 1, "从磁盘重建出 1 条");
}

/* ------------------------------------------------------------------ 7 */
console.log("\n[7] 原子写：索引始终是合法 JSON + 含 version");
{
  const doc = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  ok(doc.version === 1, "索引带 version 字段");
  ok(Array.isArray(doc.items), "索引 items 是数组");
  ok(!fs.readdirSync(root).some((f) => f.includes(".tmp-")), "没有遗留 tmp 文件");
}

/* ------------------------------------------------------------------ 8 */
console.log("\n[8] 与 OutcomeService 接线：generate 成功 ⇒ 索引立刻可见");
reset();
{
  const doc = {
    title: "索引测试",
    meta: { generatedAt: "2026-10-21", source: "test" },
    sections: [{ heading: "结论", bullets: ["索引可见"] }],
  };
  const piHost = {
    hasSession: () => true,
    recentTranscript: () => "素材",
    generateStructured: async () => ({ text: JSON.stringify(doc), model: "m" }),
  };
  const svc = new OutcomeService({
    piHost,
    logger,
    emitOutcome: () => {},
    outboxDir: outbox,
    outcomeStore: new OutcomeStore({ outboxDir: outbox, indexPath, trashDir: trash, logger }),
  });
  const card = await svc.generate({ sessionId: "s1", intent: "整理一下", format: "md" });
  ok(card && card.fileName, "generate 产出卡片带 fileName", card?.fileName);
  const listed = svc.indexList({}).items;
  ok(listed.length === 1, "索引里立刻能看到（不用重启）", `count=${listed.length}`);
  ok(listed[0].id === card.fileName, "索引 id = 卡片文件名");
  ok(svc.indexAbsPath({ id: card.fileName }).absPath.endsWith(card.fileName), "indexAbsPath 能取到真实路径");
}

/* ------------------------------------------------------------------ 汇总 */
fs.rmSync(root, { recursive: true, force: true });
console.log("\n" + "=".repeat(70));
console.log(` 通过 ${pass} 项 · 失败 ${fail} 项`);
if (fail > 0) console.log(` 失败项：\n   ✗ ${failures.join("\n   ✗ ")}`);
console.log("=".repeat(70));
process.exit(fail === 0 ? 0 : 1);
