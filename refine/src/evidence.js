// Evidence for a geometry change. Every number here is measured on the geometry (or,
// in engine.js, on renders); none is written by hand. A decision compares these
// numbers with the limits of the mode (engine.js MODES). The "score" reported with a
// decision is the remaining margin to the closest limit (0 = at the limit), not a
// confidence someone typed in.
import { sampleNative, polyOf } from './features.js';
import { polyArea, polyLen, dist, bbox } from './geom.js';

// Dense samples, flattened polygon, area and length of one subpath (local units).
// Sampling steps never go below length / MAX_SAMPLES (a degenerate candidate, such as a
// circle fitted to a sliver with a radius of millions, must not allocate millions of points).
const MAX_SAMPLES = 20000;
const roughLength = (sp) => { let L = 0; for (const g of sp.segs) for (let k = 1; k < g.p.length; k++) L += dist(g.p[k - 1], g.p[k]); if (sp.segs.some((g) => g.t === 'A')) for (const g of sp.segs) if (g.t === 'A') L += Math.PI * Math.max(g.a.rx, g.a.ry); return L; };
const step = (sp, s) => Math.max(s, roughLength(sp) / MAX_SAMPLES);
export function outline(sp, u) {
  const poly = polyOf(sp, Math.max(0.05 * u, roughLength(sp) / (50 * MAX_SAMPLES)));
  if (!sp.closed && sp.segs.length) poly.push(sp.segs[sp.segs.length - 1].p.at(-1));
  return { pts: sampleNative(sp, step(sp, 0.25 * u)).pts, poly, area: sp.closed && poly.length > 2 ? polyArea(poly) : 0, perimeter: poly.length > 1 ? polyLen(poly, sp.closed) : 0 };
}
// Total absolute turning of a polygon (radians): 2π for any convex closed outline,
// more for every wiggle, kink or zigzag.
export function totalTurning(P, closed) {
  let t = 0;
  const n = P.length;
  for (let i = closed ? 0 : 1; i < (closed ? n : n - 1); i++) {
    const a = P[(i - 1 + n) % n], b = P[i], c = P[(i + 1) % n];
    const x = [b[0] - a[0], b[1] - a[1]], y = [c[0] - b[0], c[1] - b[1]];
    const lx = Math.hypot(x[0], x[1]), ly = Math.hypot(y[0], y[1]);
    if (lx < 1e-12 || ly < 1e-12) continue;
    t += Math.abs(Math.atan2(x[0] * y[1] - x[1] * y[0], x[0] * y[0] + x[1] * y[1]));
  }
  return t;
}
// Corners: points where the outline turns by more than `angle` degrees within a short
// window (`win`, local units), so a corner cut by a tiny bevel still counts as one.
export function corners(P, closed, angle, win) {
  const n = P.length;
  if (n < 3) return [];
  // arc-length positions
  const s = [0];
  for (let i = 1; i < n; i++) s.push(s[i - 1] + dist(P[i - 1], P[i]));
  const L = s[n - 1] + (closed ? dist(P[n - 1], P[0]) : 0);
  const at = (i) => P[((i % n) + n) % n];
  const pos = (i) => (i < 0 ? s[(i % n + n) % n] - L : i >= n ? s[i % n] + L : s[i]);
  const out = [];
  for (let i = closed ? 0 : 1; i < (closed ? n : n - 1); i++) {
    let a = i - 1, b = i + 1;
    while (pos(i) - pos(a) < win / 2 && (closed ? i - a < n - 1 : a > 0)) a--;
    while (pos(b) - pos(i) < win / 2 && (closed ? b - i < n - 1 : b < n - 1)) b++;
    const x = [at(i)[0] - at(a)[0], at(i)[1] - at(a)[1]], y = [at(b)[0] - at(i)[0], at(b)[1] - at(i)[1]];
    const turn = Math.abs(Math.atan2(x[0] * y[1] - x[1] * y[0], x[0] * y[0] + x[1] * y[1])) * 180 / Math.PI;
    if (turn > angle) out.push({ i, p: at(i), turn });
  }
  // one corner per cluster (the strongest)
  const merged = [];
  for (const c of out) { const last = merged[merged.length - 1]; if (last && dist(last.p, c.p) <= win) { if (c.turn > last.turn) merged[merged.length - 1] = c; } else merged.push(c); }
  if (closed && merged.length > 1 && dist(merged[0].p, merged[merged.length - 1].p) <= win) { if (merged[merged.length - 1].turn > merged[0].turn) merged[0] = merged[merged.length - 1]; merged.pop(); }
  return merged;
}

// Symmetric Hausdorff distance between two subpaths (local units). Each side's samples
// (every 0.25 u) are measured against the other side sampled 5x denser, so the
// sampling itself adds at most 0.025 u (two sparse sample sets alone would read up to
// 0.25 u between identical curves).
export function curveDistance(a, b, u) {
  const A = sampleNative(a, step(a, 0.25 * u)).pts, B = sampleNative(b, step(b, 0.25 * u)).pts;
  if (!A.length || !B.length) return A.length === B.length ? 0 : Infinity;
  const Ad = sampleNative(a, step(a, 0.05 * u)).pts, Bd = sampleNative(b, step(b, 0.05 * u)).pts;
  // the grid cell grows with the drawing, so a far-away candidate is not searched ring
  // by ring through thousands of empty cells (the distances found are exact either way)
  const bb = bbox(A.concat(B)), cell = Math.max(u, Math.hypot(bb[2] - bb[0], bb[3] - bb[1]) / 128);
  return Math.max(directed(A, Bd, cell), directed(B, Ad, cell));
}
// Distance from any point to the nearest point of Q (grid built once).
export function nearestDistance(Q, cell) {
  const grid = new Map(), key = (i, j) => (i * 73856093) ^ (j * 19349663);
  for (const q of Q) { const k = key(Math.floor(q[0] / cell), Math.floor(q[1] / cell)); (grid.get(k) || grid.set(k, []).get(k)).push(q); }
  return (p) => {
    const ix = Math.floor(p[0] / cell), iy = Math.floor(p[1] / cell);
    let best = Infinity;
    for (let r = 0; r < 4096 && best > (r - 1) * cell; r++) for (let gx = -r; gx <= r; gx++) for (let gy = -r; gy <= r; gy++) {
      if (Math.max(Math.abs(gx), Math.abs(gy)) !== r) continue;
      const l = grid.get(key(ix + gx, iy + gy));
      if (l) for (const q of l) { const d = Math.hypot(p[0] - q[0], p[1] - q[1]); if (d < best) best = d; }
    }
    return best;
  };
}
function directed(P, Q, cell) {
  const near = nearestDistance(Q, cell);
  let worst = 0;
  for (const p of P) { const d = near(p); if (d > worst) worst = d; }
  return worst;
}
// Evidence between a reference subpath and a candidate (both in the same local units;
// u = one artwork unit in those units). Distances are reported in artwork units.
// o.hausdorff: the distance when the caller has measured it already (in u);
// o.corners = false skips the corner comparison (reported as null).
export function contourEvidence(ref, cand, u, cornerAngle, o = {}) {
  const A = outline(ref, u), B = outline(cand, u);
  const H = o.hausdorff != null ? o.hausdorff * u : curveDistance(ref, cand, u);
  const aA = Math.abs(A.area), aB = Math.abs(B.area);
  const withCorners = o.corners !== false;
  const ca = withCorners ? corners(A.poly, ref.closed, cornerAngle, 2 * u) : [], cb = withCorners ? corners(B.poly, cand.closed, cornerAngle, 2 * u) : [];
  const near = (p, list) => list.some((q) => dist(p.p, q.p) <= 2 * u);
  const ta = totalTurning(A.poly, ref.closed), tb = totalTurning(B.poly, cand.closed);
  return {
    hausdorff: H / u,
    areaError: ref.closed ? Math.abs(aB - aA) / Math.max(aA, 1e-12) : 0,
    areaBand: ref.closed ? Math.abs(aB - aA) / Math.max(A.perimeter * u, 1e-12) : 0,   // mean displacement of the area change (u)
    perimeterError: Math.abs(B.perimeter - A.perimeter) / Math.max(A.perimeter, 1e-12),
    curvatureError: Math.abs(tb - ta) / Math.max(ta, 2 * Math.PI),
    cornersLost: withCorners ? ca.filter((c) => !near(c, cb)).length : null,
    cornersAdded: withCorners ? cb.filter((c) => !near(c, ca)).length : null,
    size: (() => { const b = bbox(A.poly); return Math.max(b[2] - b[0], b[3] - b[1]) / u; })(),
  };
}

// The limits every geometry candidate must meet (engine.attempt). Returns the failed
// limit as text, or null.
export function geometryVerdict(ev, S, { maxDev = S.maxDev, area = true } = {}) {
  if (ev.hausdorff > maxDev + 1e-9) return `outline moved ${ev.hausdorff.toFixed(2)} u, more than ${maxDev.toFixed(2)} u from the original`;
  // area: relative to the contour, never more than the area of a band of maxDev/4 along it
  if (area && ev.areaError > S.maxAreaError && ev.areaBand > maxDev / 4) return `area changed by ${(ev.areaError * 100).toFixed(2)}% (limit ${(S.maxAreaError * 100).toFixed(2)}%)`;
  return null;
}
// Margin to the closest limit (1 = no change, 0 = at a limit): reported, never a gate.
export const margin = (ev, S, vis) => +Math.max(0, Math.min(1,
  1 - (ev ? ev.hausdorff / Math.max(S.maxDev, 1e-9) : 0),
  1 - (ev && ev.areaBand > S.maxDev / 4 ? ev.areaError / Math.max(S.maxAreaError, 1e-9) : 0),
  1 - (vis ? vis.share / Math.max(S.regionMax, 1e-9) : 0),
  1 - (vis ? vis.global / Math.max(S.globalMax, 1e-9) : 0),
)).toFixed(3);
