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

const EXPECTED_IDS = "chat,work";

console.log("=".repeat(70));
console.log(" minipi v0.4 场景重构验证（纯 Node）");
console.log(` Node ${process.version} · cwd ${process.cwd()}`);
console.log("=".repeat(70));

console.log("\n[1] 场景定义一致性");
ok(SCENE_IDS.length === 2, `共 2 个模式（实际 ${SCENE_IDS.length}）`);
ok(SCENE_IDS.join(",") === EXPECTED_IDS, `ID 顺序 = ${EXPECTED_IDS}`);
ok(DEFAULT_SCENE_ID === "chat", `默认模式 = chat（实际 ${DEFAULT_SCENE_ID}）`);

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

const workTools = sessionToolOptions(resolveScene("work")).tools ?? [];
ok(!workTools.includes("bash") && !workTools.includes("powershell"), "work  无 bash/powershell（D-15：产品内不再有命令执行）");
ok(workTools.includes("edit") && workTools.includes("write"), "work  有 edit/write（改文档必需，走审批）");
ok(!workTools.includes("grep") && !workTools.includes("find"), "work  不含 grep/find（依赖外部 rg/fd 二进制，改单文档用不上）");

console.log("\n[3] chat 只有联网工具（仍然碰不到磁盘）");
const quickTools = sessionToolOptions(resolveScene("chat"));
/* 2026-10-20 策略变更：quick 从「无任何工具」改成「只给联网工具」——
   用户要求默认具备联网搜索能力。**原有防线没有削弱**，只是把"无工具"精确化为
   "只允许 web_search / web_fetch"：仍然没有 read / write / edit / 命令执行，
   磁盘与本地文件照样碰不到。下面三条一起守这个边界。 */
ok(quickTools.noTools !== "all", `quick 不再整段关闭工具（实际 ${JSON.stringify(quickTools)}）`);
ok(
  Array.isArray(quickTools.tools) && quickTools.tools.length === 2 && quickTools.tools.every((t) => t === "web_search" || t === "web_fetch"),
  `★ quick 白名单**只有**联网工具（实际 ${JSON.stringify(quickTools.tools)}）`,
);
const FILE_TOOLS = ["read", "write", "edit", "bash", "grep", "find", "ls"];
ok(
  Array.isArray(quickTools.tools) && !quickTools.tools.some((t) => FILE_TOOLS.includes(t)),
  "★ quick 不含任何文件 / 命令工具（沙箱边界未被联网能力打开）",
);
ok(resolveScene("chat").sessionManagerMode === "disk", "chat 用落盘会话（D-09：自建存储，恢复后看得见）");

console.log("\n[4] 历史场景名迁移（四场景 → chat/work，D-10/D-15）");
ok(migrateSceneId("speed") === "chat", "speed → chat");
ok(migrateSceneId("study") === "chat", "study → chat");
ok(migrateSceneId("quick") === "chat", "quick → chat");
ok(migrateSceneId("note") === "chat", "note → chat");
ok(migrateSceneId("desk") === "chat", "desk → chat");
ok(migrateSceneId("work") === "work", "work → work（老 work 是改代码，新 work 是改文档：同为「碰本地文件」档）");
ok(migrateSceneId("repo") === "work", "repo → work（repo 已砍，落到 work 而不是 chat：别让用户以为文件没被碰过）");
ok(migrateSceneId("nope") === "nope", "未知名原样（交给 scenes.js 报可读错误）");
ok(migrateSceneId(null) === null, "非字符串原样返回（不抛）");

ok(normalizeSettings({ sceneId: "speed" }).sceneId === "chat", "normalizeSettings 走迁移（speed）");
ok(normalizeSettings({ sceneId: "study" }).sceneId === "chat", "normalizeSettings 走迁移（study）");
ok(normalizeSettings({ sceneId: "work" }).sceneId === "work", "normalizeSettings 走迁移（work）");
ok(normalizeSettings({}).sceneId === "chat", "空输入 → 默认 chat");
ok(normalizeSettings({ totallyUnknown: 1 }).sceneId === "chat", "未知键被丢且场景回默认");

console.log("\n[5] 默认设置");
ok(createDefaultSettings().sceneId === "chat", "createDefaultSettings().sceneId = chat");
ok(DEFAULT_SCENE_ID === "chat", "DEFAULT_SCENE_ID = chat");

console.log("\n[6] 旧场景名已被拒绝");
for (const oldName of ["speed", "study", "quick", "note", "desk", "repo"]) {
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
