// Browser check of an intended change (restoration to the source image, repetition
// consistency). Such a change is visible on purpose, so it cannot be validated by
// "looks like the original". It is accepted on the engine's own evidence, measured with
// the internal renderer; the browser must then show the same change:
//   - where the browser shows a difference between the original and the corrected
//     drawing, the internal renderer shows one too (within `reach` px): nothing changes
//     anywhere else
//   - inside the change (pixels whose 3 x 3 neighbourhood all changed), the browser
//     draws the corrected drawing in the colour the internal renderer has (1 px shift
//     tolerated)
// B0 / B1: browser renders of the original and of the corrected drawing; I0 / I1: the
// internal renders of the same two texts, all on one grid (`view`).
import { compare } from './metrics.js';

export function verifyIntended(B0, B1, I0, I1, view, { threshold = 10, reach = 2 } = {}) {
  const { W, H } = view, N = W * H;
  const dB = compare(B0, B1, view, { threshold, radius: 1 });
  const dI = compare(I0, I1, view, { threshold, radius: 0 });
  // where the engine changed anything, widened by `reach`
  const allowed = new Uint8Array(N);
  let changed = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (dI.diff[y * W + x] <= 2) continue;
    changed++;
    for (let dy = -reach; dy <= reach; dy++) for (let dx = -reach; dx <= reach; dx++) {
      const X = x + dx, Y = y + dy;
      if (X >= 0 && Y >= 0 && X < W && Y < H) allowed[Y * W + X] = 1;
    }
  }
  let outside = 0;
  for (let p = 0; p < N; p++) if (dB.visibleMask[p] && !allowed[p]) outside++;
  // the browser's colour inside the change, against the internal renderer's
  const agree = compare(I1, B1, view, { threshold, radius: 1 });
  let interior = 0, disagree = 0;
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    let all = true;
    for (let dy = -1; dy <= 1 && all; dy++) for (let dx = -1; dx <= 1; dx++) if (dI.diff[(y + dy) * W + x + dx] <= threshold) { all = false; break; }
    if (!all) continue;
    interior++;
    if (agree.visibleMask[y * W + x]) disagree++;
  }
  return { ok: outside === 0 && disagree === 0, changedPixels: changed, interiorPixels: interior, outside, disagree, browserVisible: dB.visibleShare };
}
