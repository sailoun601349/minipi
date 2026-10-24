#!/usr/bin/env node
/**
 * 会话自建存储（B1-3 / D-09）验收 —— 纯 Node，不需要 Electron / Chrome。
 *
 * 守的东西（对应 plan §2.1 存储布局 / §2.2 IPC 契约 / §2.3 恢复语义）：
 *   A 索引 CRUD          建 / 列 / 改名（截 24 字、空标题回落）/ 置顶排序 / 字段冻结
 *   B 归档               archived 不出现在默认列表、单独能查、**不动文件**
 *   C 删除               正文进 `.trash/`、索引同步移除、删不存在 → SESSION_NOT_FOUND
 *   D 对账               索引有文件无 → 删；文件有索引无 → 补（标题「新会话」）；二次幂等
 *   E 坏索引             非法 JSON → 改名 `.bad-<ts>` 后重建，不抛、不丢原文件
 *   F 路径安全           索引里塞 `../../evil` 出不了 sessions 目录，也读不到外面的文件
 *   G 大数据             500 条时 list 受 200 条硬上限约束且不超时；G2 边界精确性（MAX−1 / =MAX / 方向 / 搜索先于截断）
 *   H 搜索               title / preview / 大小写 / 空白 / 与 archived 组合
 *   I 脏索引容错         索引里混进 null / 42 / 重复 id / 错类型标题，列表不能整个没
 *   J 真 SDK 交互        C-live 删活会话不复活 / 并发 resume 同一 id 被合并 / 历史码点截断
 *   K 安全网             所有实例都在临时目录、真实 ~/.minipi 前后快照一致
 *
 * 回归哨兵（对应 2026-10-22 的裁决）：
 *   · BUG-1 → A 组：标题按**码点**截 24，emoji 不会被劈成半个（孤立代理检测）
 *   · BUG-5 → A 组：setPinned / setArchived **不改** updatedAt（否则取消置顶会跳最前）
 *   · BUG-3 → G 组：200 条硬截断**已裁定 ACCEPTED**（v1 不改），保留一条 null 说明能力缺口
 *     （⚠ 别把这个 null 掰成 A：null = 能力不存在，PASS = 存在且正常，掰过去等于把缺口藏起来）
 *
 * 为什么这些断言必须存在（都是踩过或差一点踩到的坑）：
 *   · Pi 的 JSONL 是**懒创建**的：`create()` 之后文件还不存在，`pathOf()` 返回 null 是**正确**行为。
 *     曾经想「create 完就该有文件」→ 把正确的实现判成 bug。这条用 A6 钉死。
 *   · 文件名是 `<ISO 时间戳>_<id>.jsonl`，`pathOf` 按**后缀**匹配，不是 `<id>.jsonl`。
 *     B3 / D6 都依赖它，一旦有人把它改成严格相等，这两条立刻红。
 *   · 删除 = **移动**，不是物理删除（plan §2.2：v1 不删真数据）。C2 直接比字节。
 *
 * 纪律：
 *   1. **每个断言互相隔离**：一条抛异常只记一条 FAIL，后面的照跑（不连坐）。
 *   2. **没测到就记 null**：环境不具备时打 SKIP，绝不当成 PASS。
 *   3. 一律注入临时目录；`~/.minipi/sessions` 只读快照对比，**绝不写**。
 *
 * 用法：`node scripts/verify-sessions.mjs`（退出码 0 = 全绿；`KEEP_TMP=1` 保留临时目录）。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SessionStore } from "../src/main/session-store.js";
import { isSessionId } from "../src/shared/protocol.js";
import { PiSessionHost } from "../src/main/pi/session.js";
/* 从包的**公开导出**取 SessionManager（`dist/**` 子路径被 package.json 的 exports 挡住了，
   而且生产代码也是这么 import 的 —— 测试要跟生产走同一条路）。 */
import { SessionManager } from "@earendil-works/pi-coding-agent";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** 真实用户目录：只做「有没有被改动」的快照，任何测试都不许往里写。 */
const REAL_DIR = path.join(os.homedir(), ".minipi", "sessions");
const KEEP_TMP = process.env.KEEP_TMP === "1";
const LIST_CAP = 200; // 实现的硬上限（G 组钉的就是这个数，别让它悄悄变）

const logger = { info() {}, warn() {}, error() {}, debug() {} };

let pass = 0;
let fail = 0;
let skip = 0;
const failures = [];
const skipped = [];

/**
 * 单条断言。**每个用例都包在 try 里** —— 一条抛异常不能把后面的用例带下水。
 * @param {string} label 人话说明
 * @param {() => Promise<boolean | [boolean, string?]>} fn
 */
async function A(label, fn) {
  let res;
  try {
    res = await fn();
  } catch (err) {
    fail += 1;
    failures.push(`${label}（抛异常：${err && err.message ? err.message : err}）`);
    console.log(`  FAIL  ${label}  · 抛异常：${err && err.message ? err.message : err}`);
    return;
  }
  const cond = Array.isArray(res) ? res[0] : res;
  const detail = Array.isArray(res) ? res[1] : undefined;
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${label}${detail === undefined ? "" : `  · ${detail}`}`);
  } else {
    fail += 1;
    failures.push(label);
    console.log(`  FAIL  ${label}${detail === undefined ? "" : `  · ${detail}`}`);
  }
}

/** 环境不具备 / 实现里没有这条路径 —— 记 null，不记 false，也不记 true。 */
function S(label, why) {
  skip += 1;
  skipped.push(`${label}（${why}）`);
  console.log(`  SKIP  ${label}  · ${why}  [null]`);
}

const tmpRoots = [];
const created = [];
/** 建一个完全隔离的 store（临时目录 + 临时索引 + 临时回收站）。 */
function mk(tag, seed) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `minipi-sess-${tag}-`));
  tmpRoots.push(root);
  const dir = path.join(root, "sessions");
  fs.mkdirSync(dir, { recursive: true });
  if (seed) seed(dir);
  const store = new SessionStore({
    dir,
    indexPath: path.join(dir, "index.json"),
    trashDir: path.join(dir, ".trash"),
    logger,
  });
  created.push(store);
  return { root, dir, store, indexPath: store.indexPath, trashDir: store.trashDir };
}

const indexFile = (dir) => path.join(dir, "index.json");
const writeIndex = (dir, items) =>
  fs.writeFileSync(indexFile(dir), JSON.stringify({ version: 1, items }, null, 2), "utf8");
const readIndex = (dir) => JSON.parse(fs.readFileSync(indexFile(dir), "utf8"));
const indexIds = (dir) => (readIndex(dir).items || []).map((i) => i.id);
const meta = (id, over = {}) => ({
  id,
  title: `标题-${id}`,
  sceneId: "chat",
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 1,
  preview: "",
  lastSeq: 0,
  ...over,
});
/** 造一份「Pi 会写出来的那种」正文文件名：`<ISO>_<id>.jsonl`（冒号换横线）。 */
const isoStamp = (d = new Date()) => d.toISOString().replace(/[:.]/g, "-");
/**
 * Pi 真正写出来的 session header **首行**。
 *
 * ⚠ 曾经这里写的是 `{"type":"header"}` —— 那个字面**在真实 SDK 里根本不存在**
 * （实测 `SessionManager.create()` + `appendMessage()` 落盘首行是
 *  `{"type":"session","version":3,"id":...,"timestamp":...,"cwd":...}`）。
 * 用假 header 造 fixture，等于在验证一个「假文件也能被收养」的错误契约，
 * 而真正的护栏（必须读首行 header）反而没人守。2026-10-23 修正。
 */
const headerLine = (id) =>
  `${JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: os.tmpdir() })}\n`;
/** 合法正文 = header 行 + 一条消息行（`marker` 用来断言"这份文件就是那一份"）。 */
const bodyWith = (id, marker) =>
  headerLine(id) +
  `${JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: marker } })}\n`;
const putBody = (dir, id, body = null, stamp = isoStamp()) => {
  const p = path.join(dir, `${stamp}_${id}.jsonl`);
  fs.writeFileSync(p, body !== null ? body : headerLine(id), "utf8");
  return p;
};
const silentManager = () => ({});
/**
 * ⚠ 空壳 manager 只够验「我们把什么参数交给了 SDK」，验不了**真 SDK 与存储的交互**
 * （Pi 的 `appendFileSync(this.sessionFile)` 会在文件不存在时把它重建）。
 * 那一层由 C 组的「活会话删除」用例与 J 组（真 `PiSessionHost`）覆盖，
 * 它们用真的 `SessionManager.create(cwd, dir, {id})` + `appendMessage()` 造正文。
 */
const ids = (store) => store.list().items.map((i) => i.id);
/** 孤立代理检测（emoji 被劈成半个的判据）：高代理后面必须跟低代理，低代理前面必须有高代理。 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/* ---------------------------------------------------------------- 真实目录快照 */
function realSnapshot() {
  try {
    return fs.readdirSync(REAL_DIR).sort().join("|");
  } catch {
    return null; // 不存在 = 没被测到，返回 null
  }
}
const realBefore = realSnapshot();

console.log("=".repeat(74));
console.log(" 验收 · 会话自建存储（B1-3 / D-09）");
console.log("=".repeat(74));

/* ============================================================== A 索引 CRUD */
console.log("\n[A] 索引 CRUD：建 / 列 / 改名 / 置顶");
{
  const t = mk("crud");
  const managerCalls = [];
  const recManager = (cwd, dir, opts) => {
    managerCalls.push({ cwd, dir, opts });
    return silentManager();
  };
  const madeA = t.store.create(os.tmpdir(), "chat", { createManager: recManager });
  const madeB = t.store.create(os.tmpdir(), "chat", { createManager: recManager });
  const a = madeA.item;
  const b = madeB.item;

  await A("create 返回合法会话 id（s_<时间戳>_<4 位>）", () => [
    isSessionId(a.id),
    `id=${a.id}`,
  ]);
  await A("create 默认标题是「新会话」", () => [a.title === "新会话", `title=${a.title}`]);
  await A("create 之后 list 能查到这条（渲染层列得出）", () => [
    ids(t.store).includes(a.id),
    `list=[${ids(t.store)}]`,
  ]);
  await A("create 之后磁盘 index.json 里也有（重启进程也能列出）", () => [
    indexIds(t.dir).includes(a.id),
    `disk=[${indexIds(t.dir)}]`,
  ]);
  await A("★ create 之后 pathOf(id) 为 null —— JSONL 懒创建，第一条消息才落盘", () => [
    t.store.pathOf(a.id) === null,
    `pathOf=${String(t.store.pathOf(a.id))}`,
  ]);
  await A("★ create 把「我们自己的目录 + 我们自己的 id」交给 SessionManager.create", () => [
    managerCalls.length === 2 &&
      managerCalls[0].dir === t.dir &&
      managerCalls[0].opts &&
      managerCalls[0].opts.id === a.id,
    `dir=${managerCalls[0] && managerCalls[0].dir} id=${managerCalls[0] && managerCalls[0].opts && managerCalls[0].opts.id}`,
  ]);
  await A("★ 还没落盘的会话不会被同一实例的对账清掉（_pending 保护）", () => [
    ids(t.store).length === 2 && indexIds(t.dir).length === 2,
    `mem=${ids(t.store).length} disk=${indexIds(t.dir).length}`,
  ]);
  await A("索引条目字段齐全且类型正确（冻结 9 字段）", () => {
    const it = t.store.get(a.id) || {};
    const bad = [];
    for (const k of ["id", "title", "sceneId", "preview"]) {
      if (typeof it[k] !== "string") bad.push(k);
    }
    for (const k of ["pinned", "archived"]) if (typeof it[k] !== "boolean") bad.push(k);
    for (const k of ["createdAt", "updatedAt", "lastSeq"]) if (typeof it[k] !== "number") bad.push(k);
    return [bad.length === 0, bad.length ? `类型不对：${bad.join(",")}` : Object.keys(it).join(",")];
  });

  const renamed = t.store.rename(a.id, "季度复盘");
  await A("rename 生效并持久化到磁盘", () => [
    renamed && renamed.title === "季度复盘" && readIndex(t.dir).items.find((i) => i.id === a.id).title === "季度复盘",
    `title=${renamed && renamed.title}`,
  ]);
  await A("★ rename 超过 24 字被截断到 24 个码点（中文）", () => {
    const long = "一二三四五六七八九十".repeat(5); // 50 字
    const r = t.store.rename(a.id, long);
    return [Array.from(r.title).length === 24, `codepoints=${Array.from(r.title).length} title=${r.title}`];
  });
  /* BUG-1 已修：`normalizeSessionTitle` 改成按**码点**截断（Array.from）。
     这条同时钉两件事：① 24 是"码点"口径（UTF-16 长度会是 25）；② 不会切出孤立代理字符。
     旧实现按 code unit 切，会把 'a'×23 + '😀' 切成 'a'×23 + 半个 emoji（末位 U+D83D）。 */
  await A("★ BUG-1 回归：emoji 标题截断后是 24 个码点且没有孤立代理字符", () => {
    const r = t.store.rename(a.id, "a".repeat(23) + "😀" + "zz");
    const cps = Array.from(r.title);
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(r.title);
    const tailIntact = cps[cps.length - 1] === "😀";
    return [
      cps.length === 24 && !loneSurrogate && tailIntact,
      `codepoints=${cps.length} utf16=${r.title.length} 孤立代理=${loneSurrogate} 末位=${JSON.stringify(cps[cps.length - 1])}`,
    ];
  });
  /* BUG-1 同类第三处：`preview`（列表里那行灰色小字）也截 60 字 —— 与 title 同一口径才算真修完。
     一次钉死「三处都不出孤立代理」：title（上一条）/ preview（本条）/ history（J 组）。 */
  await A("★ BUG-1 同类：preview 按码点截 60 字，不出孤立代理", () => {
    const p = "a".repeat(59) + "😀" + "zz";
    const got = t.store.touch(a.id, { preview: p }).preview;
    const cps = Array.from(got);
    return [
      cps.length === 60 && !LONE_SURROGATE.test(got) && cps[cps.length - 1] === "😀",
      `codepoints=${cps.length} utf16=${got.length} 孤立代理=${LONE_SURROGATE.test(got)} 末位=${JSON.stringify(cps[cps.length - 1])}`,
    ];
  });
  await A("★ rename 空标题（'' / 全空白 / null）回落「新会话」", () => {
    const e1 = t.store.rename(a.id, "").title;
    const e2 = t.store.rename(a.id, "    ").title;
    const e3 = t.store.rename(a.id, null).title;
    return [e1 === "新会话" && e2 === "新会话" && e3 === "新会话", `${e1}/${e2}/${e3}`];
  });
  await A("rename 未知 id → null（不抛，IPC 层才好转 SESSION_NOT_FOUND）", () => [
    t.store.rename("s_nope_0000", "x") === null,
  ]);

  t.store.rename(a.id, "阿尔法");
  t.store.rename(b.id, "贝塔");
  /* 排序断言要**确定**：两个 rename 可能落在同一毫秒，updatedAt 相等时顺序就变成实现细节。
     这里显式把 b 的 updatedAt 推后（touch 只动 preview/lastSeq/updatedAt，不改标题）。 */
  await new Promise((r) => setTimeout(r, 5));
  t.store.touch(b.id, { lastSeq: 1 });
  await A("★ 置顶后排到最前（pinned desc 优先于 updatedAt desc）", () => {
    t.store.setPinned(a.id, true);
    return [ids(t.store)[0] === a.id, `order=[${t.store.list().items.map((i) => i.title)}]`];
  });
  await A("★ 取消置顶后回到时间序（b 的 updatedAt 更新，所以 b 在前）", () => {
    /* BUG-5 已修：pin/unpin 不再动 updatedAt ⇒ 这条从"结构性"变成**确定性**断言。
       如果谁再把 updatedAt 塞回 setPinned，a 会因为被摸过而排到最前，这条立刻红。 */
    t.store.setPinned(a.id, false);
    const order = t.store.list().items;
    return [order[0].id === b.id, `order=[${order.map((i) => `${i.title}@${i.updatedAt}`)}]`];
  });
  await A("★ BUG-5 回归：置顶 / 取消置顶 / 归档都不改 updatedAt", () => {
    const before = t.store.get(a.id).updatedAt;
    const pinned = t.store.setPinned(a.id, true);
    const unpinned = t.store.setPinned(a.id, false);
    const archived = t.store.setArchived(a.id, true);
    t.store.setArchived(a.id, false);
    const same =
      pinned.updatedAt === before &&
      unpinned.updatedAt === before &&
      archived.updatedAt === before &&
      t.store.get(a.id).updatedAt === before;
    return [same, `before=${before} pin=${pinned.updatedAt} unpin=${unpinned.updatedAt} archive=${archived.updatedAt}`];
  });
  await A("置顶 / 归档的状态位仍然生效（修 updatedAt 不能把功能改没）", () => {
    t.store.setPinned(a.id, true);
    const isPinned = t.store.get(a.id).pinned;
    t.store.setPinned(a.id, false);
    t.store.setArchived(a.id, true);
    const isArchived = t.store.get(a.id).archived;
    t.store.setArchived(a.id, false);
    return [isPinned === true && isArchived === true, `pinned=${isPinned} archived=${isArchived}`];
  });
  await A("size 反映条目数（渲染层/调试用）", () => [t.store.size === 2, `size=${t.store.size}`]);
}

/* ================================================================= B 归档 */
console.log("\n[B] 归档：不出现在默认列表、单独能查、不动文件");
{
  const t = mk("arch");
  const x = t.store.create(os.tmpdir(), "chat", { createManager: silentManager }).item;
  const y = t.store.create(os.tmpdir(), "chat", { createManager: silentManager }).item;
  const archBody = bodyWith(x.id, "ARCHIVED-BODY");
  const filePath = putBody(t.dir, x.id, archBody);
  const statBefore = fs.statSync(filePath).size;

  t.store.setArchived(x.id, true);
  await A("归档后不出现在默认列表", () => [
    !ids(t.store).includes(x.id) && ids(t.store).includes(y.id),
    `list=[${ids(t.store)}]`,
  ]);
  await A("归档后 { archived: true } 能单独查到", () => {
    const arch = t.store.list({ archived: true }).items.map((i) => i.id);
    return [arch.includes(x.id), `archived=[${arch}]`];
  });
  await A("★ 归档不移动文件：原路径还在、内容没变、没进 .trash/", () => [
    fs.existsSync(filePath) &&
      fs.readFileSync(filePath, "utf8") === archBody &&
      (!fs.existsSync(t.trashDir) || fs.readdirSync(t.trashDir).length === 0),
    `size=${statBefore}`,
  ]);
  await A("归档后 pathOf 仍指向那份正文（恢复会话要用它）", () => [
    t.store.pathOf(x.id) === filePath,
    String(t.store.pathOf(x.id)),
  ]);
  await A("★ 归档条目即使 pinned 也不出现在默认列表", () => {
    t.store.setPinned(x.id, true);
    return [!ids(t.store).includes(x.id), `list=[${ids(t.store)}]`];
  });
  await A("取消归档后回到默认列表", () => {
    t.store.setArchived(x.id, false);
    return [ids(t.store).includes(x.id), `list=[${ids(t.store)}]`];
  });
}

/* ================================================================= C 删除 */
console.log("\n[C] 删除：正文进 .trash/、索引移除、可区分「不存在」");
{
  const t = mk("rm");
  const a = t.store.create(os.tmpdir(), "chat", { createManager: silentManager }).item;
  const b = t.store.create(os.tmpdir(), "chat", { createManager: silentManager }).item;
  const aBody = bodyWith(a.id, "GOODBYE-BODY");
  const aPath = putBody(t.dir, a.id, aBody);
  putBody(t.dir, b.id, bodyWith(b.id, "KEEP-BODY"));

  const res = await t.store.remove(a.id);
  await A("★ remove 把正文移进 .trash/ 并返回落点", () => [
    res && typeof res.trashedTo === "string" && res.trashedTo.includes(".trash"),
    String(res && res.trashedTo),
  ]);
  await A("★ 删除后原路径不存在（真的移走了）", () => [!fs.existsSync(aPath), aPath]);
  await A("★ 正文在回收站里一字不差（v1 不删真数据）", () => {
    const names = fs.existsSync(t.trashDir) ? fs.readdirSync(t.trashDir) : [];
    if (names.length !== 1) return [false, `trash 里有 ${names.length} 个文件`];
    if (!names[0].includes(a.id)) return [false, `回收站里没有 ${a.id}：${names[0]}`];
    const body = fs.readFileSync(path.join(t.trashDir, names[0]), "utf8");
    return [body === aBody, `bytes=${body.length}/${aBody.length} 一致=${body === aBody}`];
  });
  await A("删除后索引移除（内存 + 磁盘同步）", () => [
    t.store.get(a.id) === null && !indexIds(t.dir).includes(a.id),
    `disk=[${indexIds(t.dir)}]`,
  ]);
  await A("删除后 pathOf 返回 null", () => [t.store.pathOf(a.id) === null]);
  await A("★ 删不存在的 id 抛 code === SESSION_NOT_FOUND", async () => {
    try {
      await t.store.remove("s_nope_0000");
      return [false, "没有抛错"];
    } catch (err) {
      return [err && err.code === "SESSION_NOT_FOUND", `code=${err && err.code}`];
    }
  });
  await A("同一 id 二次删除 → SESSION_NOT_FOUND，且回收站不多出文件", async () => {
    const before = fs.readdirSync(t.trashDir).length;
    let code = null;
    try {
      await t.store.remove(a.id);
    } catch (err) {
      code = err && err.code;
    }
    return [code === "SESSION_NOT_FOUND" && fs.readdirSync(t.trashDir).length === before, `code=${code}`];
  });
  await A("删除不影响其他会话（b 还在、正文还在）", () => [
    ids(t.store).includes(b.id) && fs.existsSync(putBodyProbe(t.dir, b.id)),
    `list=[${ids(t.store)}]`,
  ]);
  await A("★ 删除还没落盘的会话：返回 ok、trashedTo 为 null、索引照样移除", async () => {
    const p = t.store.create(os.tmpdir(), "chat", { createManager: silentManager }).item;
    const r = await t.store.remove(p.id);
    return [r && r.ok === true && r.trashedTo === null && t.store.get(p.id) === null, JSON.stringify(r)];
  });
}

/* -------------------------- C-live：删除**活会话**（真 SessionManager 在写） ----------
 * 为什么必须单列：上面所有删除用例的 manager 都是空壳，看不到「SDK 还在往那份文件 append」。
 * Pi 的 `_persist()` 在文件不存在时用 `openSync(file,'wx')` 重建（session-manager.js:800），
 * 于是：`remove()` 把正文移进 `.trash/` 之后，活着的 AgentSession 再写一条 ⇒ 原路径
 * 冒出一份**没有 header** 的同名 jsonl ⇒ 重启后被收养 ⇒ 删掉的会话"复活"（且标题/预览全空）。
 * 这正是审查员 Ray 的 BLOCKER-1，用真 SDK 造正文、不需要模型。 */
{
  const t = mk("live");
  const made = t.store.create(os.tmpdir(), "chat", {
    createManager: (cwd, dir, opts) => SessionManager.create(cwd, dir, opts),
  });
  const id = made.item.id;
  const live = made.sessionManager;
  live.appendMessage({ role: "user", content: "第一段正文（会被移进回收站）" });
  const livePath = typeof live.getSessionFile === "function" ? live.getSessionFile() : t.store.pathOf(id);
  const bodyBefore = fs.readFileSync(livePath, "utf8");

  let trashedTo = null;
  await A("真 SessionManager 造的正文能被 pathOf 定位（后缀匹配对真文件名成立）", () => [
    t.store.pathOf(id) === livePath,
    `${path.basename(livePath)}`,
  ]);
  await A("真正文删除后进回收站（trashedTo 落点存在）", async () => {
    const r = await t.store.remove(id);
    trashedTo = r && r.trashedTo;
    return [typeof trashedTo === "string" && fs.existsSync(trashedTo), String(trashedTo)];
  });

  /* 活会话继续写（用户/模型都不知道会话被删了；abort 收尾写盘也一样） */
  let appendErr = null;
  try {
    live.appendMessage({ role: "assistant", content: "删除之后又写了一条" });
  } catch (err) {
    appendErr = err && (err.code || err.message);
  }

  await A("★ BLOCKER-1 回归：删除活会话后，SDK 再写不应让会话在重启后**复活**", () => {
    const fresh = new SessionStore({ dir: t.dir, indexPath: t.indexPath, trashDir: t.trashDir, logger });
    const revived = fresh.list().items.map((i) => i.id).includes(id);
    const stray = fs.readdirSync(t.dir).filter((n) => n.endsWith(`${id}.jsonl`));
    return [
      !revived,
      `重启后 list 含该 id=${revived}（不应复活）· 根目录残留文件=${JSON.stringify(stray)} · append 错误=${String(appendErr)}`,
    ];
  });
  await A("回收站里那份仍是**完整正文**（没被后面的 append 覆盖）", () => {
    const body = fs.existsSync(trashedTo) ? fs.readFileSync(trashedTo, "utf8") : "";
    return [body === bodyBefore && body.includes("第一段正文"), `bytes=${body.length}/${bodyBefore.length}`];
  });
  /* 残片的存在性本身**不是**缺陷（SDK 重建文件是其 `_persist` 的既定行为，我们控制不了）；
     缺陷是「把它认领成会话」。所以这里断的是"有残片 ⇒ 仍不复活"，而不是"不许有残片"。 */
  {
    const stray = fs.readdirSync(t.dir).filter((n) => n.endsWith(`${id}.jsonl`));
    await A("★ 即使根目录真冒出无 header 残片，重启后依然不认领它", () => {
      if (stray.length === 0) {
        /* 残片没出现（SDK 没重建）—— 这一轮没造出该形态，记 null 而不是假装通过 */
        return [null, "本轮 SDK 未重建残片，未造出该形态"];
      }
      const abs = path.join(t.dir, stray[0]);
      const first = fs.readFileSync(abs, "utf8").split("\n")[0] || "";
      let isHeader = false;
      try {
        isHeader = JSON.parse(first)?.type === "session";
      } catch {
        isHeader = false;
      }
      const fresh = new SessionStore({ dir: t.dir, indexPath: t.indexPath, trashDir: t.trashDir, logger });
      const adopted = fresh.list().items.map((i) => i.id).includes(id);
      return [
        isHeader || !adopted,
        `残片首行 type=${isHeader ? "session" : "非 header"} · 被认领=${adopted}（无 header 时必须 false）`,
      ];
    });
  }
}

/** b 的正文路径（不重新写文件，只找现成的）。 */
function putBodyProbe(dir, id) {
  const hit = fs.readdirSync(dir).find((n) => n.endsWith(`${id}.jsonl`));
  return hit ? path.join(dir, hit) : path.join(dir, `${id}.jsonl.MISSING`);
}

/* ---------------------------------------- C-frag：纯残片（无 header）不得被认领 ----------
 * 与 C-live 分开造：C-live 依赖「SDK 真的重建了一次」，那是 SDK 的行为、可能随版本变；
 * 这里**直接写一份残片**，把「_idOfFile 必须读首行」这条约束单独钉死 —— 无论 SDK 怎么写，
 * 一份文件名像我们的会话、首行却不是 session header 的文件，都绝不能被 list() 收养。 */
{
  const t = mk("frag");
  const fid = "s_frag_0001";
  const p = path.join(t.dir, `${isoStamp()}_${fid}.jsonl`);
  /* 形态与 SDK 重建出来的完全一致：只有一条 message 行，没有 header */
  fs.writeFileSync(
    p,
    `${JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: new Date().toISOString(), message: { role: "assistant", content: "删除之后又写了一条" } })}\n`,
    "utf8",
  );
  await A("★ 无 header 的残片不能被认领（否则已删会话会复活）", () => {
    const fresh = new SessionStore({ dir: t.dir, indexPath: t.indexPath, trashDir: t.trashDir, logger });
    const adopted = fresh.list().items.map((i) => i.id).includes(fid);
    return [!adopted, `list 含 ${fid}=${adopted}（必须 false）· 文件仍在=${fs.existsSync(p)}`];
  });
  await A("残片不被认领，但也**不擅自删除**（清理留 P2，扫描不该有删除副作用）", () => [
    fs.existsSync(p),
    `exists=${fs.existsSync(p)}`,
  ]);
}

/* ------------------- C-frag2：「读不到」不能当成「不是会话」（宁可多留，不可误删） ----------
 * 这是 2026-10-23 自查补的一组。起因：把 `_idOfFile` 改成"必须读首行"之后，
 * `fs.openSync` 抛错会走进 catch ⇒ 返回 null ⇒ **一份合法会话被漏认领**，
 * 用户重启后会觉得"我的会话没了"。残片顶多多一行空会话（删一次就没了），
 * 而漏掉合法会话是不可逆的用户数据损失 —— 两者代价不对称，取舍必须偏保守。
 * 所以：**首行明确不是 header ⇒ 才拒；读不到 / 读不全 ⇒ 按文件名认领**。 */
{
  const t = mk("unreadable");
  /* 形态 1：空文件（0 字节）。JSON.parse("") 抛 ⇒ 应保守认领，不能当残片丢掉。 */
  const emptyId = "s_empt_0001";
  const emptyPath = path.join(t.dir, `${isoStamp()}_${emptyId}.jsonl`);
  fs.writeFileSync(emptyPath, "", "utf8");
  /* 形态 2：首行不是 JSON（被截断的半行）。 */
  const truncId = "s_trnc_0001";
  const truncPath = path.join(t.dir, `${isoStamp()}_${truncId}.jsonl`);
  fs.writeFileSync(truncPath, '{"type":"sess\n', "utf8");
  /* 形态 3：首行是合法 JSON 但不是 session header、且**带** id（id 与文件名不符）。 */
  const mismatchId = "s_mism_0001";
  const mismatchPath = path.join(t.dir, `${isoStamp()}_${mismatchId}.jsonl`);
  fs.writeFileSync(
    mismatchPath,
    `{"type":"message","id":"other","id2":"x"}\n`,
    "utf8",
  );

  await A("★ 空文件（读不出 header）**保守认领**，不能当残片丢掉（漏认领=会话消失）", () => {
    const fresh = new SessionStore({ dir: t.dir, indexPath: t.indexPath, trashDir: t.trashDir, logger });
    const adopted = fresh.list().items.map((i) => i.id).includes(emptyId);
    return [adopted, `空文件被认领=${adopted}（必须 true：读不到 ≠ 不是会话）`];
  });
  await A("★ 首行被截断（不是合法 JSON）同样保守认领", () => {
    const fresh = new SessionStore({ dir: t.dir, indexPath: t.indexPath, trashDir: t.trashDir, logger });
    const adopted = fresh.list().items.map((i) => i.id).includes(truncId);
    return [adopted, `截断文件被认领=${adopted}（必须 true）`];
  });
  await A("★ 首行是合法 JSON 但不是 session header ⇒ 仍不认领（残片判据只在\"能明确判断\"时生效）", () => {
    const fresh = new SessionStore({ dir: t.dir, indexPath: t.indexPath, trashDir: t.trashDir, logger });
    const adopted = fresh.list().items.map((i) => i.id).includes(mismatchId);
    return [!adopted, `非 header JSON 被认领=${adopted}（必须 false）`];
  });
  await A("三种形态都不影响合法会话被正常认领（换个干净目录验一次基本盘）", () => {
    const t2 = mk("sanity");
    putBody(t2.dir, "s_sane_0001");
    const fresh = new SessionStore({ dir: t2.dir, indexPath: t2.indexPath, trashDir: t2.trashDir, logger });
    const ok = fresh.list().items.map((i) => i.id).includes("s_sane_0001");
    return [ok, `合法会话被认领=${ok}（必须 true）`];
  });
}

/* ================================================================= D 对账 */
console.log("\n[D] 对账：索引有文件无 → 删；文件有索引无 → 补；二次幂等");
{
  const t = mk("rec1", (dir) => {
    writeIndex(dir, [meta("s_keep_0001"), meta("s_gone_0002")]);
    putBody(dir, "s_keep_0001");
    // s_gone_0002 故意不给文件（模拟用户手工删了 jsonl）
  });
  await A("★ 索引有、文件无 → 条目被删掉", () => [
    !ids(t.store).includes("s_gone_0002") && ids(t.store).includes("s_keep_0001"),
    `list=[${ids(t.store)}]`,
  ]);
  await A("对账结果写回磁盘（不是只在内存里）", () => [
    !indexIds(t.dir).includes("s_gone_0002"),
    `disk=[${indexIds(t.dir)}]`,
  ]);
}
{
  const t = mk("rec2", (dir) => writeIndex(dir, []));
  putBody(t.dir, "s_orph_0003"); // 文件有、索引无
  await A("★ 文件有、索引无 → 补条目且标题「新会话」", () => {
    const it = t.store.get("s_orph_0003");
    return [it !== null && it.title === "新会话" && it.archived === false, `item=${JSON.stringify(it)}`];
  });
  await A("补出来的条目 pathOf 能找到那份正文（后缀匹配）", () => [
    (t.store.pathOf("s_orph_0003") || "").endsWith("s_orph_0003.jsonl"),
    String(t.store.pathOf("s_orph_0003")),
  ]);
  await A("补出来的条目字段对齐契约（sceneId / preview / lastSeq 有默认值）", () => {
    const it = t.store.get("s_orph_0003") || {};
    return [
      typeof it.sceneId === "string" && typeof it.preview === "string" && it.lastSeq === 0,
      JSON.stringify({ sceneId: it.sceneId, preview: it.preview, lastSeq: it.lastSeq }),
    ];
  });
  await A("★ 二次对账幂等：条目集合与磁盘字节都不变", () => {
    const first = indexIds(t.dir).slice().sort();
    const bytes = fs.readFileSync(t.indexPath, "utf8");
    const again = new SessionStore({ dir: t.dir, indexPath: t.indexPath, trashDir: t.trashDir, logger });
    const second = again.list().items.map((i) => i.id).sort();
    const bytes2 = fs.readFileSync(t.indexPath, "utf8");
    return [first.join() === second.join() && bytes === bytes2, `${first} vs ${second}`];
  });
}
{
  const t = mk("rec3", (dir) => {
    writeIndex(dir, []);
    fs.mkdirSync(path.join(dir, ".trash"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".trash", `${isoStamp()}_s_trash_0004.jsonl`), "{}\n");
    fs.writeFileSync(path.join(dir, `${isoStamp()}_s_bak_0005.jsonl.bak`), "{}\n");
    fs.writeFileSync(path.join(dir, "notes.txt"), "hello");
    fs.writeFileSync(path.join(dir, `${isoStamp()}_notasession.jsonl`), "{}\n");
  });
  await A("★ .trash/ 里的正文不会被当成孤儿收养", () => [
    !ids(t.store).includes("s_trash_0004"),
    `list=[${ids(t.store)}]`,
  ]);
  await A("★ .bak / 非会话命名不会被收养（只认 <stamp>_<id>.jsonl）", () => [
    ids(t.store).length === 0,
    `list=[${ids(t.store)}]`,
  ]);
}

/* ---------------- D-enotdir：对账遇到**非 ENOENT** 的 fs 错误 ----------------
 * 危险写法是 `catch {}` 一律当成"目录不存在" ⇒ 把索引清空再落盘 ⇒ 用户会话列表凭空消失。
 * 造法：把 sessionsDir 换成一个**同名普通文件**（readdir → ENOTDIR），索引放在别处且是好的。
 * 期望：不抛、条目一条不少、`index.json` **一个字节都不改**（宁可这次对账不生效，也不能删数据）。 */
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "minipi-sess-enotdir-"));
  tmpRoots.push(root);
  const dirAsFile = path.join(root, "sessions");
  fs.writeFileSync(dirAsFile, "我不是目录（模拟盘符掉线 / 权限错乱）", "utf8");
  const indexPath = path.join(root, "index.json");
  fs.writeFileSync(indexPath, JSON.stringify({ version: 1, items: [meta("s_en_0001"), meta("s_en_0002")] }, null, 2), "utf8");
  const bytesBefore = fs.readFileSync(indexPath, "utf8");
  const store = new SessionStore({ dir: dirAsFile, indexPath, trashDir: path.join(root, ".trash"), logger });
  created.push(store);

  await A("★ 对账遇到非 ENOENT（ENOTDIR）不抛异常", () => {
    try {
      store.list();
      return [true, "no throw"];
    } catch (err) {
      return [false, `threw ${err && (err.code || err.message)}`];
    }
  });
  await A("★ 非 ENOENT 时索引条目一条不丢（不能把故障当成「目录空」）", () => {
    const listed = store.list().items.map((i) => i.id);
    return [listed.length === 2 && listed.includes("s_en_0001"), `list=[${listed}]`];
  });
  await A("★ 非 ENOENT 时 index.json 一个字节都不改（宁可这次对账不生效）", () => {
    const after = fs.readFileSync(indexPath, "utf8");
    return [after === bytesBefore, `bytes=${after.length}/${bytesBefore.length}`];
  });
}

/* ============================================================== E 坏索引 */
console.log("\n[E] 坏索引：改名 .bad-<ts> 后从正文重建，不抛、不丢文件");
{
  const t = mk("bad", (dir) => {
    fs.writeFileSync(path.join(dir, "index.json"), "{这不是 JSON");
    putBody(dir, "s_bb_0001");
  });
  await A("★ 坏索引不抛（列表照常可用）", () => {
    const r = t.store.list();
    return [Array.isArray(r.items), `items=${r.items.length}`];
  });
  await A("★ 坏索引被改名成 index.json.bad-<ts>", () => {
    const bads = fs.readdirSync(t.dir).filter((n) => n.startsWith("index.json.bad-"));
    return [bads.length === 1, bads.join(",")];
  });
  await A("坏索引原内容一字不差地留着（不静默丢用户数据）", () => {
    const bad = fs.readdirSync(t.dir).find((n) => n.startsWith("index.json.bad-"));
    return [bad && fs.readFileSync(path.join(t.dir, bad), "utf8") === "{这不是 JSON", String(bad)];
  });
  await A("★ 从正文重建索引（孤儿文件被收养）", () => [
    ids(t.store).includes("s_bb_0001") && indexIds(t.dir).includes("s_bb_0001"),
    `disk=[${indexIds(t.dir)}]`,
  ]);
  await A("再次损坏 → 再生成一个 .bad（不覆盖上一次的）", () => {
    fs.writeFileSync(path.join(t.dir, "index.json"), "[[[");
    const again = new SessionStore({ dir: t.dir, indexPath: t.indexPath, trashDir: t.trashDir, logger });
    again.list();
    const bads = fs.readdirSync(t.dir).filter((n) => n.startsWith("index.json.bad-"));
    return [bads.length === 2, `bads=${bads.length}`];
  });
}
{
  const t = mk("noidx", (dir) => putBody(dir, "s_nx_0001"));
  await A("索引文件不存在 → 从正文重建（首次启动 / 被用户删了）", () => [
    ids(t.store).includes("s_nx_0001") && fs.existsSync(t.indexPath),
    `list=[${ids(t.store)}]`,
  ]);
}

/* ============================================================ F 路径安全 */
console.log("\n[F] 路径安全：索引里塞穿越路径也出不了 sessions 目录");
{
  const t = mk("evil", (dir) => {
    writeIndex(dir, [
      meta("../../evil"),
      meta("..\\..\\evil2"),
      meta("/abs/path"),
      meta("C:\\Windows\\system32\\drivers\\etc\\hosts"),
      meta("s_ok_0001"),
    ]);
    putBody(dir, "s_ok_0001");
  });
  await A("★ 索引里的穿越 id 不会出现在列表里", () => [
    ids(t.store).length === 1 && ids(t.store)[0] === "s_ok_0001",
    `list=[${ids(t.store)}]`,
  ]);
  await A("★ pathOf('../..') 返回 null（解析不到目录外）", () => [
    t.store.pathOf("../../evil") === null,
    String(t.store.pathOf("../../evil")),
  ]);
  await A("pathOf(绝对路径) 返回 null", () => [
    t.store.pathOf("/abs/path") === null && t.store.pathOf("C:\\Windows\\system32") === null,
  ]);
  await A("get / rename / setPinned 对穿越 id 一律返回 null（不抛、不命中）", () => [
    t.store.get("../../evil") === null &&
      t.store.rename("../../evil", "x") === null &&
      t.store.setPinned("../../evil", true) === null &&
      t.store.setArchived("../../evil", true) === null,
  ]);
  await A("★ remove(穿越 id) 抛 SESSION_NOT_FOUND（不是 ENOENT / 不是真去删文件）", async () => {
    try {
      await t.store.remove("../../evil");
      return [false, "没有抛错"];
    } catch (err) {
      return [err && err.code === "SESSION_NOT_FOUND", `code=${err && err.code}`];
    }
  });
  await A("★ sessions 目录外没有多出任何文件（没被写出去）", () => {
    const outside = fs.readdirSync(t.root).filter((n) => n !== "sessions");
    const parentEvil = fs
      .readdirSync(path.dirname(t.root))
      .filter((n) => n === "evil" || n === "evil2" || n === "abs");
    return [outside.length === 0 && parentEvil.length === 0, `root=[${outside}] parent=[${parentEvil}]`];
  });
  await A("一次正常写入后，磁盘索引里不再残留穿越条目（净化落盘）", () => {
    t.store.rename("s_ok_0001", "正常写入一次");
    const disk = indexIds(t.dir);
    return [disk.length === 1 && disk[0] === "s_ok_0001", `disk=[${disk}]`];
  });
}

/* ============================================================== G 大数据 */
console.log("\n[G] 大数据：500 条时 list 受硬上限约束且不超时");
{
  const COUNT = 500;
  const t = mk("bulk", (dir) => {
    const items = [];
    for (let i = 0; i < COUNT; i += 1) {
      const id = `s_b${i.toString(36)}_${String(i).padStart(4, "0")}`;
      items.push(meta(id, { updatedAt: 1000 + i }));
      fs.writeFileSync(path.join(dir, `${isoStamp()}_${id}.jsonl`), headerLine(id));
    }
    writeIndex(dir, items);
  });
  let timed = 0;
  let listed = null;
  await A("★ 500 条时 list 只返回上限条数（不把 500 条全塞给渲染层）", () => {
    const t0 = Date.now();
    const r = t.store.list();
    timed = Date.now() - t0;
    listed = r.items;
    return [r.items.length === LIST_CAP, `返回 ${r.items.length} 条（上限 ${LIST_CAP}）`];
  });
  await A("截断后仍按 updatedAt desc 排序（截的不是最旧的）", () => {
    const arr = listed || [];
    const first = arr[0] || {};
    const last = arr[arr.length - 1] || {};
    const sorted = arr.every((it, i) => i === 0 || arr[i - 1].updatedAt >= it.updatedAt);
    return [sorted && first.updatedAt > last.updatedAt, `${first.updatedAt} → ${last.updatedAt}`];
  });
  await A("★ 500 条 list 的耗时 < 2000ms", () => [timed < 2000, `${timed}ms`]);
  await A("500 条时 list({ archived: true }) 只返回归档条目（默认 0 条）", () => [
    t.store.list({ archived: true }).items.length === 0,
    `archived=${t.store.list({ archived: true }).items.length}`,
  ]);
  /* 截断是硬编码的 200，返回体里没有 total / hasMore / limit。
     2026-10-22 队长裁定 **ACCEPTED**（v1 不改：产品还没有那么多会话），所以这里不判红，
     只保留一条 null 说明"能力缺口仍在"。真到了 200+ 会话再回来把它变成 A()。
     ⚠ 2026-10-23 我自己曾把这条掰成 A()（理由："契约该被钉住"），**被队长驳回，改回 null**。
     驳回是对的：`null` 的语义是「这项能力不存在 / 没测到」，不是「测了且通过」。
     把"我们不提供 hasMore"写成 PASS，等于让读者以为这个功能**存在且正常**，
     正好把唯一的缺口藏起来。要钉"契约没漂移"，也该另开一条明确叫「未提供」的断言，
     而不是把缺口本身标成绿的。 */
  {
    const r = t.store.list();
    const keys = Object.keys(r).join(",");
    S(
      "列表被截断时能否告知调用方「还有更多」",
      keys === "items"
        ? `返回体只有 {${keys}}，无 total/hasMore —— BUG-3 已裁定 ACCEPTED（v1 不改）`
        : `返回体字段：${keys}`,
    );
  }
}

/* ------------------------------------------- G2 边界精确性（MAX-1 / =MAX / 方向） ----------
 * 现有 [G] 两条（"500 条只回 200" + "截断后仍按 updatedAt desc 排序"）覆盖了
 * 「远超上限时会被切」和「排序没乱」，但**临界值**没验过：上限是 `>` 还是 `>=`、
 * 正好 MAX 条时会不会莫名少一条 —— 这类 off-by-one 只在边界上暴露，500 条永远看不出来。
 *
 * ⚠ 关于"方向已被 [G] 覆盖" —— **实测不成立**，别删下面第 ③ 条：
 *   变异 M-G3 把实现改成 `items.slice(-LIMITS.SESSION_LIST_MAX)`（条数完全正确，
 *   但留下最旧的 200 条），此时 [G] 那条
 *   `截断后仍按 updatedAt desc 排序（截的不是最旧的）` 依然 **PASS**（`1199 → 1000`，
 *   降序成立、first>last 也成立）——因为它只验"内部有序"，验不了"丢的是哪一头"。
 *   只有下面 ③ 会在 M-G3 下变红。所以这是**补空白**，不是重复。
 */
{
  const MAX = LIST_CAP; // 从 protocol.js 的 LIMITS 读出来（见文件头常量），不写死 200
  /** 造 n 条：updatedAt = 1000+i（i 越大越新），正文带真 header（别被对账判成残片）。 */
  const bulk = (tag, n, titleOf) =>
    mk(tag, (dir) => {
      const items = [];
      for (let i = 0; i < n; i += 1) {
        const id = `s_t${i.toString(36)}_${String(i).padStart(4, "0")}`;
        items.push(meta(id, { updatedAt: 1000 + i, title: titleOf ? titleOf(i, id) : `标题-${id}` }));
        fs.writeFileSync(path.join(dir, `${isoStamp()}_${id}.jsonl`), headerLine(id));
      }
      writeIndex(dir, items);
    });

  /* ① 上限**减一**：不该被截（防 `>=` 写反 / 多切一刀）。 */
  const under = bulk("cap-under", MAX - 1);
  await A(`边界：${MAX - 1} 条（上限−1）原样返回，一条不少`, () => {
    const items = under.store.list().items;
    return [items.length === MAX - 1, `返回 ${items.length} 条（期望 ${MAX - 1}）`];
  });

  /* ② 正好**等于**上限：全量返回。"等于上限"不是"超过上限"（防 off-by-one 少一条）。 */
  const exact = bulk("cap-exact", MAX);
  await A(`边界：恰好 ${MAX} 条全量返回（不因"等于上限"而少一条）`, () => {
    const items = exact.store.list().items;
    const minKept = items.length ? Math.min(...items.map((i) => i.updatedAt)) : null;
    return [
      items.length === MAX && minKept === 1000,
      `返回 ${items.length} 条（期望 ${MAX}）· 最旧一条(updatedAt=1000)还在=${minKept === 1000}`,
    ];
  });

  /* ③ 方向：切掉的必须是最旧的。MAX+1 条里 updatedAt=1000 那条消失，1001..MAX 全在。 */
  const over = bulk("cap-over", MAX + 1);
  await A("★ 截断方向：切掉的是最旧的（最新 MAX 条留下，最旧那条被丢）", () => {
    const items = over.store.list().items;
    const keptNums = items.map((i) => i.updatedAt);
    const oldestDropped = !keptNums.includes(1000);
    const restAllKept = items.length === MAX && items.every((i) => i.updatedAt >= 1001);
    const minKept = keptNums.length ? Math.min(...keptNums) : null;
    const maxKept = keptNums.length ? Math.max(...keptNums) : null;
    return [
      oldestDropped && restAllKept && minKept === 1001,
      `最旧(1000)被丢=${oldestDropped} · 保留区间=[${minKept},${maxKept}]（期望 [1001,${1000 + MAX}]）`,
    ];
  });

  /* ④ 前置条件：query 过滤必须在**截断之前**。否则"只在第 201 条里出现的词"永远搜不到。
     这是最容易写反的一步（先 slice 再 filter），而上面所有条数/方向断言对此都无感。 */
  const overQ = bulk("cap-query", MAX + 1, (i, id) => (i === 0 ? "绝密关键词ZEBRA" : `标题-${id}`));
  await A("搜索发生在截断之前（关键词只在第 201 条里也能搜到）", () => {
    const hit = overQ.store.list({ query: "zebra" }).items;
    const all = overQ.store.list().items.length;
    return [hit.length === 1 && hit[0].updatedAt === 1000, `命中 ${hit.length} 条（全量列表被截成 ${all} 条）`];
  });
}

/* ================================================================ H 搜索 */
console.log("\n[H] 搜索：标题 / 预览 / 大小写 / 空白 / 与归档组合");
{
  const t = mk("query", (dir) => {
    writeIndex(dir, [
      meta("s_q1_0001", { title: "周报整理", updatedAt: 5 }),
      meta("s_q2_0002", { title: "别的", preview: "周报里提到的三件事", updatedAt: 4 }),
      meta("s_q3_0003", { title: "归档周报", archived: true, updatedAt: 3 }),
      meta("s_q4_0004", { title: "Gamma 计划", updatedAt: 2 }),
      meta("s_q5_0005", { title: "无关", updatedAt: 1 }),
    ]);
    for (const id of ["s_q1_0001", "s_q2_0002", "s_q3_0003", "s_q4_0004", "s_q5_0005"]) putBody(dir, id);
  });
  await A("按标题命中", () => [
    t.store.list({ query: "周报" }).items.map((i) => i.id).sort().join() === "s_q1_0001,s_q2_0002",
    `hit=[${t.store.list({ query: "周报" }).items.map((i) => i.title)}]`,
  ]);
  await A("★ 预览(最后一条用户消息)也参与搜索", () => [
    t.store.list({ query: "三件事" }).items.map((i) => i.id).join() === "s_q2_0002",
  ]);
  await A("大小写不敏感", () => [
    t.store.list({ query: "gamma" }).items.length === 1 && t.store.list({ query: "GAMMA" }).items.length === 1,
  ]);
  await A("空白 query 视为不过滤（与不传 query 结果一致）", () => {
    const blank = t.store.list({ query: "   " }).items.map((i) => i.id).sort().join();
    const none = t.store.list().items.map((i) => i.id).sort().join();
    return [blank === none && blank.length > 0, `blank=[${blank}] none=[${none}]`];
  });
  await A("★ query + archived:true 组合只返回归档里的命中", () => [
    t.store.list({ query: "周报", archived: true }).items.map((i) => i.id).join() === "s_q3_0003",
    `hit=[${t.store.list({ query: "周报", archived: true }).items.map((i) => i.title)}]`,
  ]);
  await A("搜不到时返回空数组（不是 null / 不是抛错）", () => {
    const r = t.store.list({ query: "zzz-不会命中" });
    return [Array.isArray(r.items) && r.items.length === 0];
  });
}

/* ======================================================= I 脏索引容错 */
console.log("\n[I] 脏索引 / 病态输入：垃圾条目不能把整个列表搞没");
{
  const t = mk("junk", (dir) => {
    writeIndex(dir, [
      meta("s_dd_0001", { title: "第一个" }),
      null,
      42,
      "string",
      meta("s_dd_0001", { title: "第二个" }),
      meta("s_dd_0001", { title: "第三个" }),
      { ...meta("s_ok_0002", { title: "好的" }), title: 123 },
      { id: null },
      { title: "没有 id" },
    ]);
    putBody(dir, "s_dd_0001");
    putBody(dir, "s_ok_0002");
  });
  await A("★ 索引里混进 null / 42 / 字符串 / 无 id 条目：不抛，只留合法会话", () => [
    t.store.size === 2 && ids(t.store).sort().join() === "s_dd_0001,s_ok_0002",
    `size=${t.store.size} list=[${ids(t.store)}]`,
  ]);
  await A("★ 重复 id 去重（不出现两行同名会话）", () => [
    ids(t.store).filter((x) => x === "s_dd_0001").length === 1,
    `list=[${ids(t.store)}]`,
  ]);
  await A("重复 id 保留最后一条（后来的覆盖先来的）", () => [
    t.store.get("s_dd_0001").title === "第三个",
    `title=${t.store.get("s_dd_0001").title}`,
  ]);
  await A("标题类型不对（title:123）被归一成字符串，不让渲染层拿到 number", () => [
    typeof t.store.get("s_ok_0002").title === "string",
    `typeof=${typeof t.store.get("s_ok_0002").title} value=${t.store.get("s_ok_0002").title}`,
  ]);
  await A("★ 一次正常写入后，磁盘索引里的垃圾条目被清掉", () => {
    t.store.rename("s_dd_0001", "改一次");
    const disk = readIndex(t.dir).items;
    return [disk.length === 2 && disk.every((i) => i && typeof i.id === "string"), `disk=[${disk.map((i) => i && i.id)}]`];
  });
}

/* ============================ J 真 SessionManager / PiSessionHost 交互 */
console.log("\n[J] 真 SDK 交互：并发恢复同一 id / 历史按码点截断");
{
  const t = mk("host");
  const made = t.store.create(os.tmpdir(), "chat", {
    createManager: (cwd, dir, opts) => SessionManager.create(cwd, dir, opts),
  });
  const id = made.item.id;
  made.sessionManager.appendMessage({ role: "user", content: "并发恢复的历史" });
  const livePath = made.sessionManager.getSessionFile();
  const linesBefore = fs.readFileSync(livePath, "utf8").trim().split("\n").length;
  const host = new PiSessionHost({ sessionStore: t.store, logger });

  let a = null;
  let b = null;
  let resumeErr = null;
  await A("★ BLOCKER-2 回归：并发两次 resumeSession 同一 id 被合并成一次恢复", async () => {
    try {
      [a, b] = await Promise.all([host.resumeSession({ id }), host.resumeSession({ id })]);
    } catch (err) {
      resumeErr = err;
    }
    if (resumeErr) return [false, `threw ${resumeErr.code || resumeErr.message}`];
    const linesAfter = fs.readFileSync(livePath, "utf8").trim().split("\n").length;
    const sameObject = a === b;
    return [
      sameObject && a.sessionId === id && host._records.size === 1 && host._resuming.size === 0 && linesAfter <= linesBefore + 1,
      `同一结果对象=${sameObject} _records=${host._records.size} _resuming=${host._resuming.size} 行数 ${linesBefore}→${linesAfter}`,
    ];
  });
  await A("并发恢复返回的 history 完全一致（没有各自读到一半的分叉）", () => {
    const h1 = JSON.stringify((a && a.history) || null);
    const h2 = JSON.stringify((b && b.history) || null);
    return [h1 === h2 && Array.isArray(a && a.history) && a.history.length >= 1, `len=${a && a.history ? a.history.length : "null"}`];
  });
  await A("恢复后 JSONL 只有一个 header（没有把同一份正文开出两条分支）", () => {
    const text = fs.readFileSync(livePath, "utf8");
    const headers = text.split("\n").filter((l) => l.includes('"type":"session"')).length;
    return [headers === 1, `header 行数=${headers}`];
  });
  /* BUG-1 同类第三处：`_historyOf` 单条按 4000 **码点**截断（`slice` 会劈开 emoji）。 */
  await A("★ BUG-1 同类：恢复历史按码点截 4000 字，不出孤立代理", () => {
    const long = "a".repeat(3999) + "😀" + "zz";
    const h = host._historyOf({ messages: [{ role: "user", content: long, timestamp: 1 }] });
    const got = h[0] ? h[0].content : "";
    const cps = Array.from(got);
    return [
      cps.length === 4000 && !LONE_SURROGATE.test(got) && cps[cps.length - 1] === "😀",
      `codepoints=${cps.length} 孤立代理=${LONE_SURROGATE.test(got)}`,
    ];
  });
}

/* ============================================================ K 安全网 */
console.log("\n[K] 安全网：测试没有碰真实用户目录");
{
  await A("★ 所有 store 都注入在系统临时目录里（不在 ~/.minipi 下）", () => {
    const offenders = created
      .map((s) => s.dir)
      .filter((d) => path.resolve(d).toLowerCase().startsWith(path.resolve(os.homedir(), ".minipi").toLowerCase()));
    return [offenders.length === 0, offenders.join(",") || `共 ${created.length} 个实例`];
  });
  const realAfter = realSnapshot();
  if (realAfter === null && realBefore === null) {
    S("真实 ~/.minipi/sessions 未被改动", "本机没有该目录，无从比对");
  } else {
    await A("★ 真实 ~/.minipi/sessions 在测试前后完全一致（只读快照比对）", () => [
      realBefore === realAfter,
      `${String(realBefore).slice(0, 60)} vs ${String(realAfter).slice(0, 60)}`,
    ]);
  }
}

/* ---------------------------------------------------------------- 收尾 */
if (!KEEP_TMP) {
  for (const r of tmpRoots) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      /* 清不掉不影响结论 */
    }
  }
}

console.log("\n" + "=".repeat(74));
console.log(` 通过 ${pass} 项 · 失败 ${fail} 项 · 未测到 ${skip} 项`);
if (fail > 0) console.log(` 失败项：\n   ✗ ${failures.join("\n   ✗ ")}`);
if (skip > 0) console.log(` 未测到：\n   · ${skipped.join("\n   · ")}`);
console.log(` 临时目录：${KEEP_TMP ? tmpRoots.join(", ") : "已清理"}`);
console.log("=".repeat(74));
process.exit(fail === 0 ? 0 : 1);
