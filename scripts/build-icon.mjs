/**
 * 生成 minipi 应用图标 —— 纯 Node，零新增依赖。
 *
 * ## 为什么手写编码器
 *
 * 项目原则是「依赖越少越好」（发布体检里 3 个运行时依赖全部 MIT 是加分项）。
 * 为了一个图标引入 sharp（含原生二进制、平台相关、装包体积 +30MB）不划算。
 * PNG 的最小可用子集（IHDR + IDAT + IEND，zlib 由 node 内置）只有几十行；
 * ICO 与 ICNS 的容器格式更简单（都是「头 + 若干帧」），同样手写。
 *
 * ## 为什么连 .ico / .icns 都自己生成（2026-10-23 踩坑）
 *
 * 原本只产出 `icon.png`，指望 electron-builder 自动转 ico/icns。实测在打包机上
 * 它 spawn 出来的 `icon-tool.js` 子进程会 **OOM 崩掉**：
 *   `FATAL ERROR: Zone Allocation failed - process out of memory`
 * （本机 15.7GB 内存、打包时只剩 2.8GB 可用；那是 resvg-wasm + 多尺寸 lanczos 的
 *  内存峰值）。表现是打包走到 `updating asar integrity executable resource` 之后
 *  直接失败，看起来像「图标有问题」，实际是内存不够。
 *
 * 自己产出有两个额外好处：
 *   1. **完全离线可复现** —— 不依赖 electron-builder 的 Cache 目录与 wasm；
 *   2. **小尺寸是真渲染**，不是从 1024 缩下来的 —— 16×16 任务栏图标边缘更干净。
 *
 * 用法：node scripts/build-icon.mjs
 * 产出：build/icon.png（1024，通用/README 用）
 *       build/icon.ico（16/24/32/48/64/128/256，Windows）
 *       build/icon.icns（16~1024，macOS）
 *       src/assets/tray.ico（16/24/32，Windows **托盘**图标）
 *       src/assets/trayTemplate.png（32×32 纯黑+alpha，macOS **托盘** template image）
 *
 * ⚠ 托盘图标刻意放在 `src/assets/` 而不是 `build/`：`build/` 是构建产物目录、不进 asar，
 *   而托盘图标要在运行时由 `src/main/tray.js` 用 `nativeImage.createFromPath()` 读。
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "build");

/** 主 PNG 尺寸（README / 商店页 / 通用）。 */
const PNG_SIZE = 1024;

/**
 * ICO 要打的尺寸。
 *
 * 与 electron-builder 的 `ICO_SIZES` 一致（它内部常量就是这一组）——
 * 刻意对齐，免得将来有人拿它的 ICO 与我们的对比时以为少了几档。
 * 16 是任务栏/标题栏，256 是资源管理器大图标，中间的 24/48 是老式 DPI。
 */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

/**
 * ICNS 要打的档位。`type` 是 Apple 的 4 字节块名：
 *   icp4=16  icp5=32  icp6=64
 *   ic07=128 ic08=256 ic09=512 ic10=1024
 *   ic11=32(16@2x) ic12=64(32@2x) ic13=256(128@2x) ic14=512(256@2x)
 * 全部允许 PNG 载荷（Apple 从 10.7 起支持），所以直接塞我们自己的 PNG。
 */
const ICNS_FRAMES = [
  { type: "icp4", size: 16 },
  { type: "icp5", size: 32 },
  { type: "icp6", size: 64 },
  { type: "ic07", size: 128 },
  { type: "ic08", size: 256 },
  { type: "ic09", size: 512 },
  { type: "ic10", size: 1024 },
  { type: "ic11", size: 32 },
  { type: "ic12", size: 64 },
  { type: "ic13", size: 256 },
  { type: "ic14", size: 512 },
];

/* ---------------- 最小 PNG 编码器 ---------------- */

/** CRC32（PNG 每个 chunk 都要）。 */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/**
 * @param {number} w
 * @param {number} h
 * @param {Buffer} rgba w*h*4
 * @returns {Buffer} PNG 字节
 */
function encodePng(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // no interlace
  // 每行前面加 filter byte 0（None）——最简单，压缩率略低但生成快
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

/* ---------------- ICO / ICNS 容器 ---------------- */

/**
 * 打包 ICO。格式（Windows 图标，简单到不需要库）：
 *   6 字节头：reserved=0, type=1(icon), count
 *   每帧 16 字节目录项：w, h, 调色板数, reserved, planes, bitCount, 字节数, 数据偏移
 *   然后是各帧 PNG 原始字节
 *
 * ⚠ 尺寸 256 在目录项里必须写 **0**（一个字节装不下 256）。这是 ico 的历史包袱，
 *   写 256 会被截断成 0 —— 恰好也对，但别指望读者看得出来，所以要注释。
 *
 * @param {{size:number, png:Buffer}[]} frames
 * @returns {Buffer}
 */
function packIco(frames) {
  const count = frames.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // 1 = icon（不是 cursor）
  header.writeUInt16LE(count, 4);

  let offset = 6 + count * 16;
  const dir = frames.map(({ size, png }) => {
    const entry = Buffer.allocUnsafe(16);
    const dim = size === 256 ? 0 : size; // 见上：256 要写 0
    entry.writeUInt8(dim, 0);
    entry.writeUInt8(dim, 1);
    entry.writeUInt8(0, 2); // 调色板颜色数（真彩为 0）
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    return entry;
  });

  return Buffer.concat([header, ...dir, ...frames.map((f) => f.png)]);
}

/**
 * 打包 ICNS。格式：
 *   `icns` 魔数 + 总长度（含 8 字节头，大端）
 *   每个块：4 字节类型 + 4 字节长度（含这 8 字节头，大端）+ 载荷
 *
 * @param {{type:string, png:Buffer}[]} frames
 * @returns {Buffer}
 */
function packIcns(frames) {
  const blocks = frames.map(({ type, png }) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, 4, "ascii");
    head.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([head, png]);
  });
  const body = Buffer.concat(blocks);
  const head = Buffer.alloc(8);
  head.write("icns", 0, 4, "ascii");
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

/* ---------------- 绘制 ---------------- */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;

/**
 * 抗锯齿过渡带宽度。
 *
 * ⚠ **必须随尺寸缩放**：写死 1.6px 在 1024 上是一条细边，在 16×16 上会把整个球
 *   糊成一团。这里取尺寸的 0.16%（1024→1.64px，16→0.03px 但下面有下限）。
 * @param {number} size
 * @returns {number}
 */
const feather = (size) => Math.max(0.35, size * 0.0016);

/** 圆角矩形的有符号距离（负=内部）。 */
function sdRoundRect(px, py, cx, cy, halfW, halfH, r) {
  const qx = Math.abs(px - cx) - (halfW - r);
  const qy = Math.abs(py - cy) - (halfH - r);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(qx, qy), 0) - r;
}

/** 圆头线段的有符号距离（胶囊体）。 */
function sdCapsule(qx, qy, ax, ay, bx, by, r) {
  const pax = qx - ax;
  const pay = qy - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const denom = bax * bax + bay * bay;
  const h = denom === 0 ? 0 : clamp01((pax * bax + pay * bay) / denom);
  return Math.hypot(pax - bax * h, pay - bay * h) - r;
}

/**
 * 在任意尺寸下渲染图标。
 *
 * 全部几何量都是 `size` 的比例，所以 16×16 是**真渲染**而不是缩小图 ——
 * 小尺寸下比例细节会自然退化（横杠变粗、竖腿变短），但不会糊。
 *
 * @param {number} size
 * @returns {Buffer} size*size*4 的 RGBA
 */
function draw(size) {
  const px = Buffer.alloc(size * size * 4);
  const c = size / 2;
  const fe = feather(size);

  /* 底盘尺寸：macOS 图标规范要求内容留 ~10% 边距并带圆角；
     Windows ico 会被系统缩放到各种尺寸，同样需要留白。 */
  const plateHalf = size * 0.44;
  const plateR = size * 0.22;

  /* 球体：比底盘小一圈，居中偏上一点（视觉重心）。 */
  const ballR = size * 0.29;
  const ballCx = c;
  const ballCy = c - size * 0.012;

  /* 品牌色（与 index.html 深色主题的球面一致：冷蓝 → 青） */
  const TOP = [0x5b, 0xa8, 0xff];
  const MID = [0x2f, 0x6b, 0xd8];
  const BOT = [0x14, 0x2a, 0x66];

  /* 品牌 mark 的几何量（π 的抽象：横杠 + 两条外张竖腿） */
  const barHalfW = ballR * 0.46;
  const barHalfH = Math.max(ballR * 0.07, size * 0.012); // 小尺寸给下限，否则消失
  const barCy = ballCy - ballR * 0.30;
  const legHalfW = Math.max(ballR * 0.068, size * 0.011);
  const legTop = ballCy - ballR * 0.28;
  const legBot = ballCy + ballR * 0.46;
  const legOffset = ballR * 0.275;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      /* --- 1) 圆角底板：近黑底 + 轻微上亮渐层 --- */
      const dPlate = sdRoundRect(x, y, c, c, plateHalf, plateHalf, plateR);
      const aPlate = clamp01(1 - dPlate / fe);
      if (aPlate > 0) {
        const t = clamp01((y - (c - plateHalf)) / (plateHalf * 2));
        r = lerp(0x24, 0x0b, t);
        g = lerp(0x2a, 0x0f, t);
        b = lerp(0x3a, 0x18, t);
        a = aPlate;
      }

      /* --- 2) 球体：径向渐变 + 偏移光源 --- */
      const lx = ballCx - ballR * 0.34;
      const ly = ballCy - ballR * 0.4;
      const dBall = Math.hypot(x - ballCx, y - ballCy) - ballR;
      const aBall = clamp01(1 - dBall / fe);
      if (aBall > 0) {
        // 距光源越近越亮
        const dLight = Math.hypot(x - lx, y - ly) / (ballR * 1.85);
        const t = clamp01(dLight);
        let sr;
        let sg;
        let sb;
        if (t < 0.5) {
          const k = t / 0.5;
          sr = lerp(TOP[0], MID[0], k);
          sg = lerp(TOP[1], MID[1], k);
          sb = lerp(TOP[2], MID[2], k);
        } else {
          const k = (t - 0.5) / 0.5;
          sr = lerp(MID[0], BOT[0], k);
          sg = lerp(MID[1], BOT[1], k);
          sb = lerp(MID[2], BOT[2], k);
        }
        // 边缘一圈微亮描边（球感的关键：亮=凸）
        const rim = clamp01((-dBall - ballR * 0.86) / Math.max(ballR * 0.14, 0.001));
        const rimK = 0.55 * rim;
        sr = lerp(sr, 0x8f, rimK);
        sg = lerp(sg, 0xc4, rimK);
        sb = lerp(sb, 0xff, rimK);

        r = lerp(r, sr, aBall);
        g = lerp(g, sg, aBall);
        b = lerp(b, sb, aBall);
        a = Math.max(a, aBall);
      }

      /* --- 3) 品牌 mark：π 的几何抽象 ---
       *
       * ⚠ 第一版画的是「圆环 + 两条竖腿穿过」，实测渲染出来竖腿**戳到环外面**，
       *   像两根柱子穿透一个圈，不专业（build/icon-v1-bad.png 的教训）。
       *   改成纯几何 π：一根圆头横杠 + 两条圆头竖腿，不加外环 —— 形状更干净，
       *   缩到 16×16 任务栏尺寸也认得出。
       */
      let aMark = clamp01(1 - sdCapsule(x, y, ballCx - barHalfW, barCy, ballCx + barHalfW, barCy, barHalfH) / fe);
      for (const side of [-1, 1]) {
        const ax = ballCx + side * legOffset * 0.86;
        const bx = ballCx + side * legOffset;
        const dLeg = sdCapsule(x, y, ax, legTop, bx, legBot, legHalfW);
        const aLeg = clamp01(1 - dLeg / fe);
        if (aLeg > aMark) aMark = aLeg;
      }
      if (aMark > 0) {
        // mark 用亮白偏青，**必须比球体亮**（产品硬约束：π 亮=凸）
        r = lerp(r, 0xf2, aMark);
        g = lerp(g, 0xfb, aMark);
        b = lerp(b, 0xff, aMark);
      }

      px[i] = Math.round(r);
      px[i + 1] = Math.round(g);
      px[i + 2] = Math.round(b);
      px[i + 3] = Math.round(a * 255);
    }
  }
  return px;
}

/* ---------------- 托盘图标（v1.0） ----------------
 *
 * 为什么单独画一套、而不是把 build/icon.png 缩下来：
 *   ① 应用图标有**圆角底盘 + 径向渐变球 + 亮白 π**，缩到 16×16 之后三层颜色糊成
 *      一团灰蓝方块，托盘里根本看不出是什么（16px 只有 256 个像素，塞不下细节）。
 *   ② 托盘图标有平台规范：Windows 更喜欢"有辨识度的品牌色剪影"，
 *      macOS 要求 **template image**（只允许黑色 + alpha，系统按菜单栏深浅色自动反色）。
 *      同一个文件不可能同时满足两边。
 *   所以这里只画一个**单色 π 剪影**（胶囊体拼出来的横杠 + 两条外张竖腿），
 *   透明背景、无底盘 —— 16px 下就是一个干净的 π，看得出是 minipi。
 */

/** Windows 托盘 ICO 的档位（任务栏按 DPI 自取一档；16 是 100% 缩放的主流值）。 */
const TRAY_ICO_SIZES = [16, 24, 32];

/** macOS template image 的尺寸（菜单栏按需缩，32 够清晰且体积可忽略）。 */
const TRAY_TEMPLATE_SIZE = 32;

/**
 * 渲染托盘用的「单色 π 剪影」。
 *
 * 所有几何量都是 `size` 的比例 ⇒ 16×16 是**真渲染**，不是缩图，小尺寸边缘更干净。
 *
 * @param {number} size
 * @param {[number, number, number]} rgb 剪影颜色（macOS template 传纯黑）
 * @returns {Buffer} size*size*4 的 RGBA
 */
function drawTrayMark(size, rgb) {
  const px = Buffer.alloc(size * size * 4);
  /* 抗锯齿过渡带：托盘图标是 16~32px 的小物件，过渡带必须按像素给下限，
     否则 `feather()`（按 0.16% 缩放）在 16px 上只有 0.35px，边缘会锯齿到看不清。 */
  const fe = Math.max(0.75, size * 0.02);
  const barY = size * 0.3;
  const strokeR = Math.max(0.6, size * 0.085); // 笔画半径：小尺寸给下限，否则笔画消失
  const x0 = size * 0.14;
  const x1 = size * 0.86;
  const legTop = barY;
  const legBot = size * 0.84;
  const legInsetTop = size * 0.2;
  const legInsetBot = size * 0.15;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      // 三个胶囊体的并集：取最小距离（SDF 的 union）
      let d = sdCapsule(x, y, x0, barY, x1, barY, strokeR);
      const dLegLeft = sdCapsule(x, y, x0 + legInsetTop, legTop, x0 + legInsetBot, legBot, strokeR);
      const dLegRight = sdCapsule(x, y, x1 - legInsetTop, legTop, x1 - legInsetBot, legBot, strokeR);
      if (dLegLeft < d) d = dLegLeft;
      if (dLegRight < d) d = dLegRight;
      // 边界上 alpha=0.5，往里收满、往外收没 —— 标准 1px 抗锯齿
      const a = clamp01(0.5 - d / fe);
      px[i] = rgb[0];
      px[i + 1] = rgb[1];
      px[i + 2] = rgb[2];
      px[i + 3] = Math.round(a * 255);
    }
  }
  return px;
}

/** `draw()` 的更小兄弟：`size` 由调用方给，颜色也由调用方给（托盘专用）。 */
const TRAY_MARK_WIN = [0x2f, 0x6b, 0xd8]; // 品牌中蓝（深/浅任务栏都看得见）
const TRAY_MARK_MAC = [0x00, 0x00, 0x00]; // macOS template 必须是纯黑 + alpha

/* ---------------- 校验：别默默产出一个坏图标 ---------------- */

/**
 * 自查产物（**失败要大声**，不能写完就宣布成功）。
 *
 * 这里只查「结构对不对」这类机械可验的事：
 * ICO 头魔数、帧数、每帧偏移是否落在文件内、ICNS 总长度是否与文件长度一致。
 * 视觉好不好看只能靠人看（`ViewImage`），脚本不该假装能判。
 *
 * @param {Buffer} buf
 * @param {{size:number, png:Buffer}[]} frames
 */
function assertIco(buf, frames) {
  if (buf.readUInt16LE(0) !== 0) throw new Error("ICO reserved 字段不是 0");
  if (buf.readUInt16LE(2) !== 1) throw new Error("ICO type 不是 1（icon）");
  if (buf.readUInt16LE(4) !== frames.length) throw new Error("ICO 帧数与目录项不符");
  for (let k = 0; k < frames.length; k += 1) {
    const base = 6 + k * 16;
    const bytes = buf.readUInt32LE(base + 8);
    const off = buf.readUInt32LE(base + 12);
    if (off + bytes > buf.length) throw new Error(`ICO 第 ${k} 帧越界`);
    // 每帧必须是合法 PNG，否则 Windows 会显示空白图标
    if (buf.subarray(off, off + 8).toString("hex") !== "89504e470d0a1a0a") {
      throw new Error(`ICO 第 ${k} 帧不是 PNG`);
    }
  }
}

/** @param {Buffer} buf */
function assertIcns(buf) {
  if (buf.subarray(0, 4).toString("ascii") !== "icns") throw new Error("ICNS 魔数不对");
  if (buf.readUInt32BE(4) !== buf.length) throw new Error("ICNS 总长度与实际文件长度不一致");
}

/**
 * 校验 PNG 头（签名 + IHDR 里的宽高）。
 * 托盘图标是**运行时被 Electron `nativeImage` 直接读**的，宽高写错不会有任何报错，
 * 只会表现成"托盘里图标糊了/空了"，所以这里机械地核一遍。
 *
 * @param {Buffer} buf
 * @param {number} size
 */
function assertPngSize(buf, size) {
  if (buf.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("PNG 签名不对");
  if (buf.subarray(12, 16).toString("ascii") !== "IHDR") throw new Error("PNG 第一个 chunk 不是 IHDR");
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  if (w !== size || h !== size) throw new Error(`PNG 尺寸 ${w}×${h} 与期望 ${size}×${size} 不符`);
}

/* ---------------- main ---------------- */

fs.mkdirSync(OUT_DIR, { recursive: true });

const written = [];

/* ① 主 PNG */
const png = encodePng(PNG_SIZE, PNG_SIZE, draw(PNG_SIZE));
fs.writeFileSync(path.join(OUT_DIR, "icon.png"), png);
written.push(["icon.png", png.length, `${PNG_SIZE}×${PNG_SIZE}`]);

/* ② ICO：每档真渲染 */
const icoFrames = ICO_SIZES.map((size) => ({ size, png: encodePng(size, size, draw(size)) }));
const ico = packIco(icoFrames);
assertIco(ico, icoFrames);
fs.writeFileSync(path.join(OUT_DIR, "icon.ico"), ico);
written.push(["icon.ico", ico.length, ICO_SIZES.join("/")]);

/* ③ ICNS：同尺寸可复用已渲染的帧，避免重复计算 */
const bySize = new Map(ICO_SIZES.map((s, i) => [s, icoFrames[i].png]));
for (const size of [16, 32, 64, 128, 256, 512, 1024]) {
  if (!bySize.has(size)) bySize.set(size, encodePng(size, size, draw(size)));
}
const icnsFrames = ICNS_FRAMES.map(({ type, size }) => ({ type, png: bySize.get(size) }));
const icns = packIcns(icnsFrames);
assertIcns(icns);
fs.writeFileSync(path.join(OUT_DIR, "icon.icns"), icns);
written.push(["icon.icns", icns.length, ICNS_FRAMES.map((f) => f.size).join("/")]);

for (const [name, bytes, note] of written) {
  process.stdout.write(`已生成 build/${name}（${note}，${(bytes / 1024).toFixed(1)} KB）\n`);
}

/* ④ 托盘图标 —— 产出到 **src/assets/**（不是 build/）
 *
 * ⚠ 目录选择是有讲究的，别改到 build/ 下：
 *   `build/` 是 electron-builder 的 buildResources（构建输入 + 产物目录，且被 .gitignore），
 *   **不会**打进 asar；而托盘图标要在运行时被 `nativeImage.createFromPath()` 读，
 *   所以必须落在 `files` 白名单里的 `src/**` 下面。`src/main/tray.js` 就是按
 *   `__dirname/../assets/` 找它们的（asar 内路径同样可读）。
 */
const TRAY_OUT_DIR = path.join(ROOT, "src", "assets");
fs.mkdirSync(TRAY_OUT_DIR, { recursive: true });

/* ④-1 Windows：16/24/32 三档真渲染，打包成 ICO（每帧都是 PNG 载荷，见 packIco） */
const trayIcoFrames = TRAY_ICO_SIZES.map((size) => ({
  size,
  png: encodePng(size, size, drawTrayMark(size, TRAY_MARK_WIN)),
}));
const trayIco = packIco(trayIcoFrames);
assertIco(trayIco, trayIcoFrames); // 帧数 / 偏移 / 每帧 PNG 魔数
fs.writeFileSync(path.join(TRAY_OUT_DIR, "tray.ico"), trayIco);
written.push(["../src/assets/tray.ico", trayIco.length, `${TRAY_ICO_SIZES.join("/")}（托盘 · Windows）`]);

/* ④-2 macOS：32×32 纯黑 + alpha，运行时 setTemplateImage(true) 让系统自适应深浅色 */
const trayTemplate = encodePng(
  TRAY_TEMPLATE_SIZE,
  TRAY_TEMPLATE_SIZE,
  drawTrayMark(TRAY_TEMPLATE_SIZE, TRAY_MARK_MAC),
);
assertPngSize(trayTemplate, TRAY_TEMPLATE_SIZE);
fs.writeFileSync(path.join(TRAY_OUT_DIR, "trayTemplate.png"), trayTemplate);
written.push([
  "../src/assets/trayTemplate.png",
  trayTemplate.length,
  `${TRAY_TEMPLATE_SIZE}×${TRAY_TEMPLATE_SIZE}（托盘 · macOS template）`,
]);

for (const [name, bytes, note] of written.slice(-2)) {
  process.stdout.write(`已生成 ${name}（${note}，${(bytes / 1024).toFixed(1)} KB）\n`);
}
