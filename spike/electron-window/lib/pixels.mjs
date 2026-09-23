'use strict';
/* 像素采样工具：NativeImage -> BGRA 角像素 / 中心像素 alpha
   用途：判定透明窗口在 setBounds 之后是否「掉了透明」。
   注意：toBitmap() 返回的是 BGRA（每像素 4 字节，最后一字节是 alpha）。 */

/** 取一张 NativeImage 的角像素与中心像素 */
export function samplePixels(image) {
  if (!image || image.isEmpty()) return { empty: true };
  const size = image.getSize();
  const bmp = image.toBitmap();
  const w = size.width;
  const h = size.height;
  if (!w || !h) return { empty: true, size };

  const at = (x, y) => {
    const i = (y * w + x) * 4;
    return { b: bmp[i], g: bmp[i + 1], r: bmp[i + 2], a: bmp[i + 3] };
  };

  return {
    empty: false,
    size,
    corners: {
      topLeft: at(0, 0),
      topRight: at(w - 1, 0),
      bottomLeft: at(0, h - 1),
      bottomRight: at(w - 1, h - 1)
    },
    center: at(Math.floor(w / 2), Math.floor(h / 2))
  };
}

/**
 * 把角像素采样归纳成一句可判读的结论。
 * 判据（README 里也写了同一套）：
 *   四角 alpha 全为 0        -> 透明完好
 *   任一角 alpha 明显 > 0    -> 透明受损（单窗口三态方案在该平台不成立）
 */
export function cornerVerdict(sample) {
  if (!sample || sample.empty) {
    return { readable: false, allCornersTransparent: null, maxCornerAlpha: null, alphas: [] };
  }
  const alphas = Object.keys(sample.corners).map(k => sample.corners[k].a);
  const maxCornerAlpha = Math.max(...alphas);
  return {
    readable: true,
    allCornersTransparent: maxCornerAlpha === 0,
    maxCornerAlpha,
    alphas,
    corners: sample.corners,
    center: sample.center
  };
}

/** 颜色相近判定（用于「背板色是否透出来」这类视觉核对） */
export function rgbNear(px, target, tol = 24) {
  if (!px) return false;
  return Math.abs(px.r - target.r) <= tol && Math.abs(px.g - target.g) <= tol && Math.abs(px.b - target.b) <= tol;
}
