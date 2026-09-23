/**
 * v0.4 场景重构验证（纯 Node，不依赖 Electron）。
 *
 * 为什么需要它：本机环境的 Electron GPU 进程会崩（`GPU process isn't usable`），
 * 导致 `npm run selftest` 跑不完。所以把**不依赖 Electron 的逻辑**单独测一遍，
 * 保证场景重构没有回归。
 *
 * 覆盖：场景定义一致性 / outbox 沙箱边界 / 工具白名单 / 历史名迁移。
 *
 * 用法：`node scripts/verify-v04.mjs`（退出码 0 = 全通过）
 */

import { SCENE_DEFS, SCENE_IDS, DEFAULT_SCENE_ID, OUTBOX_SCENES, createDefaultSettings } from "../src/shared/protocol.js";
import { normalizeSettings, migrateSceneId, SCENE_CWD_DIRS, OUTBOX_DIR } from "../src/main/settings.js";
import { resolveScene, sessionToolOptions } from "../src/main/pi/scenes.js";

let pass = 0;
let fail = 0;

/** @param {boolean} cond @param {string} label */
function ok(cond, label) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${label}`);
  }
}

const EXPECTED_IDS = "quick,note,desk,repo";

console.log("=".repeat(70));
console.log(" minipi v0.4 场景重构验证（纯 Node）");
console.log(` Node ${process.version} · cwd ${process.cwd()}`);
console.log("=".repeat(70));

console.log("\n[1] 场景定义一致性");
ok(SCENE_IDS.length === 4, `共 4 个场景（实际 ${SCENE_IDS.length}）`);
ok(SCENE_IDS.join(",") === EXPECTED_IDS, `ID 顺序 = ${EXPECTED_IDS}`);
ok(DEFAULT_SCENE_ID === "quick", `默认场景 = quick（实际 ${DEFAULT_SCENE_ID}）`);

for (const id of SCENE_IDS) {
  const r = resolveScene(id);
  ok(r.cwd === SCENE_CWD_DIRS[id], `${id.padEnd(5)} cwd 与 SCENE_CWD_DIRS 一致`);
}

console.log("\n[2] outbox 沙箱边界");
for (const id of OUTBOX_SCENES) {
  const r = resolveScene(id);
  ok(r.cwd === OUTBOX_DIR, `${id.padEnd(5)} 落在 outbox`);
  const t = sessionToolOptions(r);
  const names = t.tools ?? [];
  const hasShell = names.includes("bash") || names.includes("powershell");
  ok(!hasShell, `${id.padEnd(5)} 不含 bash/powershell（沙箱第一道防线）`);
  const hasEdit = names.includes("edit");
  ok(!hasEdit, `${id.padEnd(5)} 不含 edit`);
}

ok(resolveScene("repo").cwd !== OUTBOX_DIR, "repo  不在 outbox（唯一例外，允许选目录）");
ok(sessionToolOptions(resolveScene("repo")).tools.includes("bash"), "repo  有 bash（改代码必需）");
ok(sessionToolOptions(resolveScene("repo")).tools.includes("edit"), "repo  有 edit");

console.log("\n[3] quick 无工具（提示注入免疫）");
const quickTools = sessionToolOptions(resolveScene("quick"));
ok(quickTools.noTools === "all", `quick = noTools:"all"（实际 ${JSON.stringify(quickTools)}）`);
ok(quickTools.tools === undefined, "quick 不给 tools 白名单");
ok(resolveScene("quick").sessionManagerMode === "memory", "quick 用内存会话（不落盘）");

console.log("\n[4] 历史场景名迁移");
ok(migrateSceneId("speed") === "quick", "speed → quick");
ok(migrateSceneId("study") === "note", "study → note");
ok(migrateSceneId("work") === "repo", "work → repo");
ok(migrateSceneId("desk") === "desk", "desk 原样（新名不误伤）");
ok(migrateSceneId("repo") === "repo", "repo 原样");
ok(migrateSceneId("nope") === "nope", "未知名原样（交给 scenes.js 报可读错误）");
ok(migrateSceneId(null) === null, "非字符串原样返回（不抛）");

ok(normalizeSettings({ sceneId: "speed" }).sceneId === "quick", "normalizeSettings 走迁移（speed）");
ok(normalizeSettings({ sceneId: "study" }).sceneId === "note", "normalizeSettings 走迁移（study）");
ok(normalizeSettings({ sceneId: "work" }).sceneId === "repo", "normalizeSettings 走迁移（work）");
ok(normalizeSettings({}).sceneId === "quick", "空输入 → 默认 quick");
ok(normalizeSettings({ totallyUnknown: 1 }).sceneId === "quick", "未知键被丢且场景回默认");

console.log("\n[5] 默认设置");
ok(createDefaultSettings().sceneId === "quick", "createDefaultSettings().sceneId = quick");
ok(DEFAULT_SCENE_ID === "quick", "DEFAULT_SCENE_ID = quick");

console.log("\n[6] 旧场景名已被拒绝");
for (const oldName of ["speed", "study", "work"]) {
  let threw = false;
  try {
    resolveScene(oldName);
  } catch (err) {
    threw = /SCENE_NOT_FOUND/.test(String(err.message));
  }
  ok(threw, `resolveScene("${oldName}") 抛 SCENE_NOT_FOUND`);
}

console.log(`\n${"=".repeat(70)}`);
if (fail === 0) {
  console.log(` 全部通过：${pass} 项`);
} else {
  console.log(` 失败 ${fail} 项 / 共 ${pass + fail} 项`);
}
console.log("=".repeat(70));

process.exit(fail === 0 ? 0 : 1);
