// The source raster (the PNG / JPG the SVG was traced from). When it is given, the
// engine can measure where the SVG disagrees with the real picture and move edges
// back to it. Alignment: SVG user units -> image pixels, x' = s x + tx, y' = s y + ty.
import { makeView, render } from './raster.js';

// rgba: Uint8ClampedArray (canvas ImageData or decoded PNG); flattened on white.
export function makeSource(rgba, W, H) {
  const rgb = new Float32Array(W * H * 3);
  for (let i = 0; i < W * H; i++) { const a = rgba[i * 4 + 3] / 255; for (let k = 0; k < 3; k++) rgb[i * 3 + k] = rgba[i * 4 + k] * a + 255 * (1 - a); }
  return { rgb, W, H, T: null };
}
// bilinear colour at image pixel coordinates (pixel centres at +0.5)
export function sampleImg(src, X, Y, out = [0, 0, 0]) {
  const x = Math.max(0, Math.min(src.W - 1.001, X - 0.5)), y = Math.max(0, Math.min(src.H - 1.001, Y - 0.5));
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0, W = src.W, d = src.rgb;
  const i00 = (y0 * W + x0) * 3, i10 = i00 + 3, i01 = i00 + W * 3, i11 = i01 + 3;
  for (let k = 0; k < 3; k++) out[k] = (d[i00 + k] * (1 - fx) + d[i10 + k] * fx) * (1 - fy) + (d[i01 + k] * (1 - fx) + d[i11 + k] * fx) * fy;
  return out;
}
export const sampleUser = (src, x, y, out) => sampleImg(src, src.T.s * x + src.T.tx, src.T.s * y + src.T.ty, out);

// The source resampled onto a view grid (for region comparisons).
export function sourceOnView(src, view) {
  const img = new Float32Array(view.W * view.H * 3), c = [0, 0, 0];
  for (let y = 0; y < view.H; y++) for (let x = 0; x < view.W; x++) {
    // average 2x2 sub-samples (the view can be coarser than the image)
    let r = 0, g = 0, b = 0;
    for (const [dx, dy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) { sampleUser(src, view.x + (x + dx) / view.k, view.y + (y + dy) / view.k, c); r += c[0]; g += c[1]; b += c[2]; }
    const p = (y * view.W + x) * 3; img[p] = r / 4; img[p + 1] = g / 4; img[p + 2] = b / 4;
  }
  return img;
}

// Find s, tx, ty. Same size -> identity; same aspect -> scaled; otherwise the SVG is
// a crop of the image (an icon cut from a sheet): normalised cross-correlation of
// lightness, coarse to fine.
export function align(doc, src) {
  const [vx, vy, vw, vh] = doc.viewBox;
  const quick = [];
  if (Math.abs(vw - src.W) <= 1 && Math.abs(vh - src.H) <= 1) quick.push({ s: 1, tx: -vx, ty: -vy });
  if (Math.abs(vw / vh - src.W / src.H) < 0.01) quick.push({ s: src.W / vw, tx: -vx * src.W / vw, ty: -vy * src.W / vw });
  const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
  const D = 4;                                                        // coarse factor
  const gw = Math.floor(src.W / D), gh = Math.floor(src.H / D), G = new Float32Array(gw * gh);
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    let s = 0;
    for (let j = 0; j < D; j++) for (let i = 0; i < D; i++) { const p = ((y * D + j) * src.W + x * D + i) * 3; s += lum(src.rgb[p], src.rgb[p + 1], src.rgb[p + 2]); }
    G[y * gw + x] = s / (D * D);
  }
  const score = (T, step = 1) => {
    // correlation between the SVG render and the image over the SVG's area
    const k = T.s / D, tw = Math.max(4, Math.round(vw * k)), th = Math.max(4, Math.round(vh * k));
    const ox = (T.tx + T.s * vx) / D, oy = (T.ty + T.s * vy) / D;
    if (ox < -1 || oy < -1 || ox + tw > gw + 1 || oy + th > gh + 1) return -2;
    const view = { x: vx, y: vy, k, W: tw, H: th };
    const tpl = T._tpl && T._tpl.k === k ? T._tpl.img : render(doc, view, { orig: true });
    let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
    for (let y = 0; y < th; y += step) for (let x = 0; x < tw; x += step) {
      const X = Math.round(ox + x), Y = Math.round(oy + y);
      if (X < 0 || Y < 0 || X >= gw || Y >= gh) continue;
      const p = (y * tw + x) * 3, a = lum(tpl[p], tpl[p + 1], tpl[p + 2]), b = G[Y * gw + X];
      n++; sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b;
    }
    if (n < 16) return -2;
    const cov = sab / n - (sa / n) * (sb / n), va = saa / n - (sa / n) ** 2, vb = sbb / n - (sb / n) ** 2;
    return va > 1e-6 && vb > 1e-6 ? cov / Math.sqrt(va * vb) : -2;
  };
  let best = null;
  for (const T of quick) { const c = score(T); if (!best || c > best.c) best = { ...T, c }; }
  if (!best || best.c < 0.9) {
    // scale candidates around "user units = image pixels" and fit-to-image
    const cands = new Set();
    for (let s = 0.25; s <= 4.01; s *= 1.06) cands.add(+s.toFixed(4));
    for (const s of [...cands]) {
      if (vw * s > src.W + 2 || vh * s > src.H + 2) continue;
      const k = s / D, tw = Math.round(vw * k), th = Math.round(vh * k);
      const tpl = render(doc, { x: vx, y: vy, k, W: tw, H: th }, { orig: true });
      for (let Y = 0; Y + th <= gh; Y += 2) for (let X = 0; X + tw <= gw; X += 2) {
        const T = { s, tx: X * D - s * vx, ty: Y * D - s * vy, _tpl: { k, img: tpl } };
        const c = score(T, 2);
        if (!best || c > best.c) best = { s, tx: T.tx, ty: T.ty, c };
      }
    }
    // fine: position and scale around the best
    if (best) {
      for (let it = 0; it < 3; it++) {
        const st = [4, 1, 0.5][it];
        let improved = true;
        while (improved) {
          improved = false;
          for (const [ds, dx, dy] of [[1.01, 0, 0], [1 / 1.01, 0, 0], [1, st, 0], [1, -st, 0], [1, 0, st], [1, 0, -st]]) {
            const cx = vx + vw / 2, cy = vy + vh / 2, s = best.s * ds;
            const T = { s, tx: best.tx + best.s * cx - s * cx + dx, ty: best.ty + best.s * cy - s * cy + dy };
            const c = score(T);
            if (c > best.c + 1e-5) { best = { ...T, c }; improved = true; }
          }
        }
      }
    }
  }
  if (!best) return null;
  // full resolution: sub-pixel position and scale
  const full = (T) => {
    const view = { x: vx, y: vy, k: T.s, W: Math.round(vw * T.s), H: Math.round(vh * T.s) };
    const tpl = render(doc, view, { orig: true });
    const ox = T.tx + T.s * vx, oy = T.ty + T.s * vy, c = [0, 0, 0];
    let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
    for (let y = 0; y < view.H; y += 1) for (let x = 0; x < view.W; x += 1) {
      const p = (y * view.W + x) * 3, a = lum(tpl[p], tpl[p + 1], tpl[p + 2]);
      sampleImg(src, ox + x + 0.5, oy + y + 0.5, c);
      const b = lum(c[0], c[1], c[2]);
      n++; sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b;
    }
    const cov = sab / n - (sa / n) * (sb / n), va = saa / n - (sa / n) ** 2, vb = sbb / n - (sb / n) ** 2;
    return va > 1e-6 && vb > 1e-6 ? cov / Math.sqrt(va * vb) : -2;
  };
  if (best.c < 0.995) {
    best.c = full(best);
    for (const st of [2, 1, 0.5, 0.25]) {
      let improved = true, guard = 0;
      while (improved && guard++ < 20) {
        improved = false;
        const cx = vx + vw / 2, cy = vy + vh / 2;
        for (const [ds, dx, dy] of [[1, st, 0], [1, -st, 0], [1, 0, st], [1, 0, -st], [1 + st / 400, 0, 0], [1 - st / 400, 0, 0]]) {
          const s = best.s * ds, T = { s, tx: best.tx + best.s * cx - s * cx + dx, ty: best.ty + best.s * cy - s * cy + dy };
          const c = full(T);
          if (c > best.c + 1e-6) { best = { ...T, c }; improved = true; }
        }
      }
    }
  }
  return { s: best.s, tx: best.tx, ty: best.ty, correlation: +best.c.toFixed(4) };
}
