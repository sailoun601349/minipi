/**
 * 版本探测（「关于」用）。
 *
 * ## 为什么运行时读，而不是写死一个数字
 *
 * 「基于 Pi 哪个版本」这种信息**一旦写死就会过期**：升级依赖忘了改文案，界面就开始说谎。
 * 所以这里直接从**已安装的包**里读 `package.json` 的 `version` —— 屏幕上显示的一定是
 * 当前真正在跑的那份代码的版本。
 *
 * ## 怎么定位到包
 *
 * 走 `import.meta.resolve("@earendil-works/pi-coding-agent")` 拿到入口文件
 * （`…/pi-coding-agent/dist/index.js`），再**向上逐级找** `package.json` 且 `name` 匹配。
 * 不用 `require.resolve("…/package.json")`：那个会被 `exports` 映射挡住
 * （该包只导出了 `.` 与 `./rpc-entry`），拿不到。
 *
 * 探测失败不抛错 —— 版本信息是**锦上添花**，不能因为它让 App 起不来。
 * 拿不到就返回 `null`，界面显式写「未探测到」，不编一个数字。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 主依赖：minipi 的 Agent 能力全部来自它 */
const PI_PKG = "@earendil-works/pi-coding-agent";
/** 模型层（随 pi-coding-agent 一起装的传递依赖，可能解析不到） */
const PI_AI_PKG = "@earendil-works/pi-ai";

/**
 * 从某个目录向上找指定包名的 package.json。
 * @param {string} startDir
 * @param {string} name
 * @param {number} [maxDepth]
 * @returns {{name:string,version:string,dir:string}|null}
 */
function findPackageJsonUpwards(startDir, name, maxDepth = 8) {
  let dir = startDir;
  for (let i = 0; i < maxDepth; i += 1) {
    const file = path.join(dir, "package.json");
    try {
      const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
      if (pkg && pkg.name === name && typeof pkg.version === "string") {
        return { name: pkg.name, version: pkg.version, dir };
      }
    } catch {
      /* 该层没有或读不动，继续向上 */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * @param {string} specifier 包名
 * @returns {{name:string,version:string,dir:string}|null}
 */
function resolvePackage(specifier) {
  try {
    const url = import.meta.resolve(specifier);
    const entry = fileURLToPath(url);
    return findPackageJsonUpwards(path.dirname(entry), specifier);
  } catch {
    return null;
  }
}

/** minipi 自己的版本（本文件在 `src/main/`，仓库根往上两级）。 */
function readMinipiVersion() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(fs.readFileSync(path.join(here, "..", "..", "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

/**
 * 组装「关于」信息。**不含任何绝对路径**（家目录不出现在界面上）。
 * @param {{electron?:string, chrome?:string, node?:string}} [runtime]
 */
export function getAboutInfo(runtime = {}) {
  const pi = resolvePackage(PI_PKG);
  const ai = resolvePackage(PI_AI_PKG);
  return {
    minipi: {
      version: readMinipiVersion(),
      electron: runtime.electron ?? null,
      chrome: runtime.chrome ?? null,
      node: runtime.node ?? null,
      platform: `${process.platform}-${process.arch}`,
    },
    pi: {
      name: PI_PKG,
      /** null = 未探测到（界面显示「未探测到」，不编数字） */
      version: pi ? pi.version : null,
      /** 模型层的版本，用于“同一套 release 线”的自检 */
      aiVersion: ai ? ai.version : null,
    },
    /** 版本是否同一条发布线（pi 与 pi-ai 版本一致通常才正常） */
    consistent: Boolean(pi && ai && pi.version === ai.version),
  };
}
