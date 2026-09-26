// Visual Difference Engine: compares two renders made with the same view.
// - mean ΔE (CIE Lab) over the image
// - pixel difference: share of pixels with ΔE > threshold (visible change)
// - solid: changed pixels whose whole 3x3 neighbourhood changed (a visible spot,
//   not an anti-aliasing difference along an edge)
// - structural: 1 - SSIM on lightness (8x8 windows)
import { lab } from './raster.js';

export function labImage(img, N) {
  const L = new Float32Array(N * 3);
  for (let p = 0; p < N; p++) { const c = lab(img[p * 3], img[p * 3 + 1], img[p * 3 + 2]); L[p * 3] = c[0]; L[p * 3 + 1] = c[1]; L[p * 3 + 2] = c[2]; }
  return L;
}
export function compare(a, b, view, { threshold = 10, structural = false, labA = null, radius = 1 } = {}) {
  const N = view.W * view.H, A = labA || labImage(a, N);
  let sum = 0, bad = 0;
  const diff = new Float32Array(N), Lb = new Float32Array(N);
  for (let p = 0; p < N; p++) {
    let d;
    if (a[p * 3] === b[p * 3] && a[p * 3 + 1] === b[p * 3 + 1] && a[p * 3 + 2] === b[p * 3 + 2]) { d = 0; Lb[p] = A[p * 3]; }
    else { const B = lab(b[p * 3], b[p * 3 + 1], b[p * 3 + 2]); Lb[p] = B[0]; d = Math.hypot(A[p * 3] - B[0], A[p * 3 + 1] - B[1], A[p * 3 + 2] - B[2]); }
    diff[p] = d; sum += d; if (d > threshold) bad++;
  }
  // shift-tolerant difference: a changed pixel whose new colour exists in the original
  // within `radius` pixels is an edge moved by less than the allowed deviation
  const { W, H } = view;
  let tolBad = 0;
  const tdiff = new Uint8Array(N);
  if (bad) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = y * W + x;
    if (diff[p] <= threshold) continue;
    const B = lab(b[p * 3], b[p * 3 + 1], b[p * 3 + 2]);
    let near = false;
    for (let dy = -radius; dy <= radius && !near; dy++) for (let dx = -radius; dx <= radius; dx++) {
      const X = x + dx, Y = y + dy;
      if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
      const q = Y * W + X;
      if (Math.hypot(A[q * 3] - B[0], A[q * 3 + 1] - B[1], A[q * 3 + 2] - B[2]) <= threshold) { near = true; break; }
    }
    if (!near) { tdiff[p] = 1; tolBad++; }
  }
  let solid = 0;
  if (bad) for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    if (diff[y * W + x] <= threshold) continue;
    let all = true;
    for (let dy = -1; dy <= 1 && all; dy++) for (let dx = -1; dx <= 1; dx++) if (diff[(y + dy) * W + x + dx] <= threshold) { all = false; break; }
    if (all) solid++;
  }
  const r = { mean: sum / N, pixelShare: bad / N, badPixels: bad, visibleShare: tolBad / N, visiblePixels: tolBad, solid, diff, visibleMask: tdiff };
  if (structural) r.structural = 1 - ssim(A, Lb, W, H);
  return r;
}
function ssim(A, Lb, W, H) {
  const C1 = (0.01 * 100) ** 2, C2 = (0.03 * 100) ** 2, S = 8;
  let tot = 0, n = 0;
  for (let y = 0; y + S <= H; y += 4) for (let x = 0; x + S <= W; x += 4) {
    let ma = 0, mb = 0;
    for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) { const p = (y + j) * W + x + i; ma += A[p * 3]; mb += Lb[p]; }
    ma /= S * S; mb /= S * S;
    let va = 0, vb = 0, cv = 0;
    for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) { const p = (y + j) * W + x + i, da = A[p * 3] - ma, db = Lb[p] - mb; va += da * da; vb += db * db; cv += da * db; }
    va /= S * S - 1; vb /= S * S - 1; cv /= S * S - 1;
    tot += ((2 * ma * mb + C1) * (2 * cv + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2)); n++;
  }
  return n ? tot / n : 1;
}
// Visual Error Score (0 = identical): weighted blend, reported next to the parts.
export const visualScore = (r) => +(r.pixelShare * 100 + r.mean * 0.5 + (r.structural || 0) * 10 + r.solid * 0.01).toFixed(4);
