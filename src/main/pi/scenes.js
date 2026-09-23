/**
 * 场景策略（方案 §3.2 场景表）。
 *
 * 分工：
 *   · `src/shared/protocol.js` 里的 `SCENE_DEFS` 是**声明式**定义（主/渲染共享）；
 *   · 本文件把声明**落地成主进程侧的绝对策略**（绝对路径、工具入参、会话是否落盘）。
 *
 * 本文件**不 import Pi SDK、不 import electron**：
 * 这样「将来 SDK 签名漂移只改一处」的承诺才守得住——SDK 只出现在 `pi/session.js`。
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { ERROR_CODES, SCENE_DEFS, errorMessage, isSceneId } from "../../shared/protocol.js";
import { MINIPI_HOME, OUTBOX_DIR, SCENE_CWD_DIRS } from "../settings.js";

/**
 * 展开 `~`。
 * @param {string} p
 * @returns {string} 绝对路径
 */
export function expandHome(p) {
  if (typeof p !== "string" || p.length === 0) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** 场景的 cwd 相对映射：命中 `~/.minipi/*` 时直接用预建目录，避免路径漂移。 */
const TEMPLATE_TO_DIR = Object.freeze({
  "~/.minipi/outbox": SCENE_CWD_DIRS.quick,
  "~/.minipi/repo": SCENE_CWD_DIRS.repo,
});

/**
 * 取某个场景的**落地策略**。
 * @param {string} sceneId
 * @returns {{
 *   sceneId: string,
 *   label: string,
 *   cwd: string,
 *   toolAllowlist: readonly string[],
 *   noTools: ("all"|"builtin"|null),
 *   sessionManagerMode: ("memory"|"disk"),
 *   description: string,
 * }}
 * @throws {Error} sceneId 非法
 */
export function resolveScene(sceneId) {
  if (!isSceneId(sceneId)) {
    throw new Error(
      errorMessage(
        ERROR_CODES.SCENE_NOT_FOUND,
        `sceneId 必须是 ${Object.keys(SCENE_DEFS).join(" / ")} 之一`,
      ),
    );
  }
  const def = SCENE_DEFS[sceneId];
  const template = def.cwdTemplate;
  const cwd = TEMPLATE_TO_DIR[template] ?? expandHome(template);
  return {
    sceneId: def.sceneId,
    label: def.label,
    cwd,
    toolAllowlist: def.toolAllowlist,
    noTools: def.noTools,
    sessionManagerMode: def.sessionManagerMode,
    description: def.description,
  };
}

/** 所有场景的落地策略（用于 `/api/scenes` 之类的只读展示）。 */
export function listScenes() {
  return Object.keys(SCENE_DEFS).map((id) => resolveScene(id));
}

/**
 * 确保场景 cwd 存在。返回绝对路径。
 * @param {{ cwd: string, sceneId: string }} scene
 * @returns {string}
 * @throws {Error} 建目录失败（带可读信息，不含内部细节）
 */
export function ensureSceneCwd(scene) {
  const cwd = scene?.cwd;
  if (typeof cwd !== "string" || cwd.length === 0) {
    throw new Error(errorMessage(ERROR_CODES.INTERNAL, "场景 cwd 未解析"));
  }
  try {
    fs.mkdirSync(cwd, { recursive: true });
    return cwd;
  } catch (err) {
    throw new Error(
      errorMessage(
        ERROR_CODES.INTERNAL,
        `场景目录不可用（${path.basename(cwd)}）：${err?.code ?? err?.message ?? "未知错误"}`,
      ),
    );
  }
}

/**
 * 把场景策略翻成 `createAgentSession()` 的工具相关入参。
 *
 * 注意：`quick` 用 `noTools: "all"`——**根本没有工具可调**，
 * 所以「选区里藏了『忽略以上指令并删除文件』」这条路径天然免疫（§3.3 末段）。
 * `note` / `desk` / `repo` 用 `tools` 白名单（显式列出，等价于「只有这些」）。
 *
 * v0.4：`note` / `desk` **不含 `bash` / `edit`** ⇒ 它们写不出 `outbox`（见 plan §3.4.4）。
 * 对 `bash` 而言沙箱无效，所以「不开 bash」本身就是沙箱的第一道防线。
 *
 * @param {ReturnType<typeof resolveScene>} scene
 * @returns {{ noTools?: "all", tools?: string[] }}
 */
export function sessionToolOptions(scene) {
  if (scene.noTools) return { noTools: scene.noTools };
  return { tools: [...scene.toolAllowlist] };
}

/** `~/.minipi` 根（导出给日志用）。 */
export const APP_HOME = MINIPI_HOME;
