// Geometry core: vectors, cubic Béziers, flattening, fitting.
// All coordinates are in the SVG's own user units (viewBox units).

export const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
export const mul = (a, s) => [a[0] * s, a[1] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
export const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
export const len = (a) => Math.hypot(a[0], a[1]);
export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const norm = (a) => { const l = len(a); return l > 1e-12 ? [a[0] / l, a[1] / l] : [0, 0]; };
export const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

// A segment is { t: 'L', p: [p0, p1] } or { t: 'C', p: [p0, c1, c2, p3] }.
export function bez(b, t) {
  const m = 1 - t;
  return [
    m * m * m * b[0][0] + 3 * m * m * t * b[1][0] + 3 * m * t * t * b[2][0] + t * t * t * b[3][0],
    m * m * m * b[0][1] + 3 * m * m * t * b[1][1] + 3 * m * t * t * b[2][1] + t * t * t * b[3][1],
  ];
}
export function bezD1(b, t) {
  const m = 1 - t;
  return [
    3 * (m * m * (b[1][0] - b[0][0]) + 2 * m * t * (b[2][0] - b[1][0]) + t * t * (b[3][0] - b[2][0])),
    3 * (m * m * (b[1][1] - b[0][1]) + 2 * m * t * (b[2][1] - b[1][1]) + t * t * (b[3][1] - b[2][1])),
  ];
}
function bezD2(b, t) {
  return [
    6 * ((1 - t) * (b[2][0] - 2 * b[1][0] + b[0][0]) + t * (b[3][0] - 2 * b[2][0] + b[1][0])),
    6 * ((1 - t) * (b[2][1] - 2 * b[1][1] + b[0][1]) + t * (b[3][1] - 2 * b[2][1] + b[1][1])),
  ];
}
export const segStart = (s) => s.p[0];
export const segEnd = (s) => s.p[s.p.length - 1];
export function segAt(s, t) { return s.t === 'L' ? lerp(s.p[0], s.p[1], t) : bez(s.p, t); }

// Tangent directions at the start / end of a segment (degenerate handles fall back).
export function tanIn(s) {
  if (s.t === 'L') return norm(sub(s.p[1], s.p[0]));
  for (const q of [s.p[1], s.p[2], s.p[3]]) if (dist(q, s.p[0]) > 1e-6) return norm(sub(q, s.p[0]));
  return [0, 0];
}
export function tanOut(s) {
  if (s.t === 'L') return norm(sub(s.p[1], s.p[0]));
  for (const q of [s.p[2], s.p[1], s.p[0]]) if (dist(s.p[3], q) > 1e-6) return norm(sub(s.p[3], q));
  return [0, 0];
}
export function turnDeg(a, b) {
  const c = Math.max(-1, Math.min(1, dot(a, b)));
  return (Math.acos(c) * 180) / Math.PI;
}

// Approximate length of a segment.
export function segLen(s) {
  if (s.t === 'L') return dist(s.p[0], s.p[1]);
  let L = 0, prev = s.p[0];
  for (let i = 1; i <= 16; i++) { const q = bez(s.p, i / 16); L += dist(prev, q); prev = q; }
  return L;
}

// Dense samples of a closed subpath: points roughly `step` apart, each tagged with
// its segment index; `node[i]` marks samples that are segment start nodes.
export function sampleSubpath(segs, step) {
  const pts = [], seg = [], node = [];
  segs.forEach((s, k) => {
    const n = Math.max(1, Math.ceil(segLen(s) / step));
    for (let i = 0; i < n; i++) { pts.push(segAt(s, i / n)); seg.push(k); node.push(i === 0); }
  });
  return { pts, seg, node };
}

// Signed area of a closed polygon.
export function polyArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p[0] * q[1] - q[0] * p[1]; }
  return a / 2;
}
export function polyLen(pts, closed = true) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i]);
  if (closed && pts.length > 1) L += dist(pts[pts.length - 1], pts[0]);
  return L;
}
export function bbox(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
  return [x0, y0, x1, y1];
}

// Flatten a subpath into a polygon with at most `tol` deviation (for rasterizing).
export function flatten(segs, tol) {
  const out = [];
  for (const s of segs) {
    if (s.t === 'L') { out.push(s.p[0]); continue; }
    const b = s.p;
    const d = Math.max(dist(b[0], b[1]) + dist(b[1], b[2]) + dist(b[2], b[3]), 1e-9);
    const n = Math.max(1, Math.min(200, Math.ceil(Math.sqrt(d / tol))));
    for (let i = 0; i < n; i++) out.push(bez(b, i / n));
  }
  return out;
}

// ---- Distance between two sampled outlines (symmetric Hausdorff, grid-accelerated)
export function hausdorff(A, B, cellSize) {
  const bb = bbox(A.concat(B)), cell = cellSize || Math.max(1e-9, Math.max(bb[2] - bb[0], bb[3] - bb[1]) / 64);
  const one = (P, Q) => {
    const grid = new Map();
    const key = (x, y) => (Math.floor(x / cell) * 73856093) ^ (Math.floor(y / cell) * 19349663);
    for (const q of Q) { const k = key(q[0], q[1]); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(q); }
    let worst = 0;
    for (const p of P) {
      let best = Infinity;
      for (let r = 0; r < 64 && best > (r - 1) * cell; r++) {
        for (let gx = -r; gx <= r; gx++) for (let gy = -r; gy <= r; gy++) {
          if (Math.max(Math.abs(gx), Math.abs(gy)) !== r) continue;
          const arr = grid.get(key(p[0] + gx * cell, p[1] + gy * cell));
          if (arr) for (const q of arr) { const d = dist(p, q); if (d < best) best = d; }
        }
      }
      if (best > worst) worst = best;
    }
    return worst;
  };
  return Math.max(one(A, B), one(B, A));
}

// ---- Curve fitting (Schneider): fit cubics through points with end tangents
function chordParams(P) {
  const u = [0];
  for (let i = 1; i < P.length; i++) u.push(u[i - 1] + dist(P[i], P[i - 1]));
  const L = u[u.length - 1] || 1;
  return u.map((v) => v / L);
}
function generateBezier(P, u, t1, t2) {
  const p0 = P[0], p3 = P[P.length - 1];
  let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
  for (let i = 0; i < P.length; i++) {
    const t = u[i], m = 1 - t;
    const b0 = m * m * m, b1 = 3 * m * m * t, b2 = 3 * m * t * t, b3 = t * t * t;
    const a1 = mul(t1, b1), a2 = mul(t2, b2);
    c00 += dot(a1, a1); c01 += dot(a1, a2); c11 += dot(a2, a2);
    const tmp = sub(P[i], add(mul(p0, b0 + b1), mul(p3, b2 + b3)));
    x0 += dot(a1, tmp); x1 += dot(a2, tmp);
  }
  const det = c00 * c11 - c01 * c01;
  let al = 0, ar = 0;
  if (Math.abs(det) > 1e-12) { al = (x0 * c11 - x1 * c01) / det; ar = (c00 * x1 - c01 * x0) / det; }
  const L = dist(p0, p3);
  if (!(al > 1e-6 * L) || !(ar > 1e-6 * L) || al > 2 * L || ar > 2 * L) al = ar = L / 3;
  return [p0, add(p0, mul(t1, al)), add(p3, mul(t2, ar)), p3];
}
function maxError(P, b, u) {
  let maxD = 0, split = Math.floor(P.length / 2);
  for (let i = 1; i < P.length - 1; i++) {
    const d = dist(bez(b, u[i]), P[i]);
    if (d > maxD) { maxD = d; split = i; }
  }
  return { maxD, split };
}
function reparam(P, b, u) {
  return u.map((t, i) => {
    const q = bez(b, t), d1 = bezD1(b, t), d2 = bezD2(b, t), r = sub(q, P[i]);
    const den = dot(d1, d1) + dot(r, d2);
    return Math.abs(den) < 1e-12 ? t : Math.min(1, Math.max(0, t - dot(r, d1) / den));
  });
}
// Fit cubics to open polyline P (first / last points fixed) with unit end tangents
// t1 (leaving P[0]) and t2 (pointing back from P[n-1]); max deviation `tol`.
export function fitCubics(P, t1, t2, tol, out = [], depth = 0) {
  if (P.length === 2) {
    const d = dist(P[0], P[1]) / 3;
    out.push([P[0], add(P[0], mul(t1, d)), add(P[1], mul(t2, d)), P[1]]);
    return out;
  }
  let u = chordParams(P), b = generateBezier(P, u, t1, t2);
  let { maxD, split } = maxError(P, b, u);
  for (let it = 0; it < 8 && maxD > tol && maxD < tol * 8; it++) {
    u = reparam(P, b, u); b = generateBezier(P, u, t1, t2); ({ maxD, split } = maxError(P, b, u));
  }
  if (maxD <= tol || depth > 20 || P.length < 4) { out.push(b); return out; }
  split = Math.max(1, Math.min(P.length - 2, split));
  let tc = norm(sub(P[Math.max(0, split - 2)], P[Math.min(P.length - 1, split + 2)]));
  if (!tc[0] && !tc[1]) tc = norm(sub(P[split - 1], P[split + 1]));
  fitCubics(P.slice(0, split + 1), t1, tc, tol, out, depth + 1);
  fitCubics(P.slice(split), mul(tc, -1), t2, tol, out, depth + 1);
  return out;
}

// ---- Primitive fits
// Axis-aligned ellipse / circle through closed points; returns params and max error.
export function fitEllipse(pts) {
  const n = pts.length;
  if (n < 8) return null;
  let mx = 0, my = 0;
  for (const p of pts) { mx += p[0]; my += p[1]; }
  mx /= n; my /= n;
  // A x² + B y² + C x + D y = 1 (centred coordinates), least squares
  const S = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], v = [0, 0, 0, 0];
  for (const p of pts) {
    const x = p[0] - mx, y = p[1] - my, f = [x * x, y * y, x, y];
    for (let i = 0; i < 4; i++) { v[i] += f[i]; for (let j = 0; j < 4; j++) S[i][j] += f[i] * f[j]; }
  }
  const sol = solve(S, v);
  if (!sol) return null;
  const [A, B, C, D] = sol;
  if (A <= 0 || B <= 0) return null;
  const cx = -C / (2 * A), cy = -D / (2 * B), k = 1 + A * cx * cx + B * cy * cy;
  let rx = Math.sqrt(k / A), ry = Math.sqrt(k / B);
  if (!isFinite(rx) || !isFinite(ry)) return null;
  const X = mx + cx, Y = my + cy;
  if (Math.abs(rx - ry) < 0.03 * Math.max(rx, ry)) rx = ry = (rx + ry) / 2;
  let err = 0;
  for (const p of pts) {
    const dx = (p[0] - X) / rx, dy = (p[1] - Y) / ry, r = Math.hypot(dx, dy) || 1;
    const e = Math.abs(r - 1) * Math.hypot(dx * rx, dy * ry) / r;
    if (e > err) err = e;
  }
  return { cx: X, cy: Y, rx, ry, err };
}
function solve(A, b) {
  const n = b.length, M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}
// Ellipse as four exact quarter arcs (the way a designer draws it); `ccw` keeps the
// winding of the original outline (it matters for nonzero fills).
export function ellipseSegs(e, ccw) {
  const K = 0.5522847498, { cx, cy, rx, ry } = e;
  let P = [[cx + rx, cy], [cx, cy + ry], [cx - rx, cy], [cx, cy - ry]];
  let H = [[0, K * ry], [-K * rx, 0], [0, -K * ry], [K * rx, 0]];
  if (ccw) { P = [P[0], P[3], P[2], P[1]]; H = [mul(H[0], -1), mul(H[3], -1), mul(H[2], -1), mul(H[1], -1)]; }
  const segs = [];
  for (let i = 0; i < 4; i++) {
    const a = P[i], b = P[(i + 1) % 4];
    segs.push({ t: 'C', p: [a, add(a, H[i]), sub(b, H[(i + 1) % 4]), b] });
  }
  return segs;
}

// Taubin smoothing of an open polyline (ends fixed): removes small wobble without
// shrinking the shape.
export function taubin(P, iterations) {
  let A = P.map((p) => p.slice());
  const step = (f) => {
    const B = A.map((p) => p.slice());
    for (let i = 1; i < A.length - 1; i++) {
      B[i][0] = A[i][0] + f * ((A[i - 1][0] + A[i + 1][0]) / 2 - A[i][0]);
      B[i][1] = A[i][1] + f * ((A[i - 1][1] + A[i + 1][1]) / 2 - A[i][1]);
    }
    A = B;
  };
  for (let k = 0; k < iterations; k++) { step(0.5); step(-0.53); }
  return A;
}

// ---- more fitting / tests used by the reconstruction passes

// Max distance of points to the chord a-b (a straight segment).
export function lineDeviation(P, a, b) {
  const ab = sub(b, a), L = len(ab);
  let dev = 0;
  for (const q of P) {
    const d = L < 1e-12 ? dist(q, a) : (() => { const t = Math.max(0, Math.min(1, dot(sub(q, a), ab) / (L * L))); return dist(q, add(a, mul(ab, t))); })();
    if (d > dev) dev = d;
  }
  return dev;
}
// Distance from a point to a polyline (densely sampled curve).
export function distToPolyline(q, P) {
  let best = Infinity;
  for (let i = 0; i + 1 < P.length; i++) {
    const a = P[i], ab = sub(P[i + 1], a), L2 = dot(ab, ab);
    const t = L2 ? Math.max(0, Math.min(1, dot(sub(q, a), ab) / L2)) : 0;
    const d = dist(q, add(a, mul(ab, t)));
    if (d < best) best = d;
  }
  return best;
}
// Least-squares circle (Kasa) with a few geometric refinement steps.
export function fitCircle(P) {
  const n = P.length;
  if (n < 3) return null;
  let mx = 0, my = 0;
  for (const p of P) { mx += p[0]; my += p[1]; }
  mx /= n; my /= n;
  let suu = 0, suv = 0, svv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
  for (const p of P) { const u = p[0] - mx, v = p[1] - my; suu += u * u; suv += u * v; svv += v * v; suuu += u * u * u; svvv += v * v * v; suvv += u * v * v; svuu += v * u * u; }
  const det = suu * svv - suv * suv;
  if (Math.abs(det) < 1e-12) return null;
  const b1 = (suuu + suvv) / 2, b2 = (svvv + svuu) / 2;
  let cx = (b1 * svv - b2 * suv) / det + mx, cy = (suu * b2 - suv * b1) / det + my;
  let r = 0;
  for (let it = 0; it < 6; it++) {
    // geometric refinement (Gauss-Newton on radial residuals)
    r = 0; for (const p of P) r += dist(p, [cx, cy]); r /= n;
    let gx = 0, gy = 0;
    for (const p of P) { const d = dist(p, [cx, cy]) || 1e-12; gx += ((p[0] - cx) / d) * (d - r); gy += ((p[1] - cy) / d) * (d - r); }
    cx += gx / n; cy += gy / n;
  }
  r = 0; for (const p of P) r += dist(p, [cx, cy]); r /= n;
  let err = 0, varr = 0;
  for (const p of P) { const e = Math.abs(dist(p, [cx, cy]) - r); err = Math.max(err, e); varr += e * e; }
  return { cx, cy, r, err, radiusStd: Math.sqrt(varr / n) };
}
// Quadratic through a..b with end tangents t1 (from a) and t2 (back from b): control
// point at the tangent intersection. null when the tangents do not meet ahead.
export function quadFromTangents(a, b, t1, t2) {
  const den = cross(t1, t2);
  if (Math.abs(den) < 1e-9) return null;
  const d = sub(b, a), s = cross(d, t2) / den, u = cross(d, t1) / den;
  if (s <= 0 || u <= 0) return null;
  return add(a, mul(t1, s));
}
export function quadPoint(q, t) { const m = 1 - t; return [m * m * q[0][0] + 2 * m * t * q[1][0] + t * t * q[2][0], m * m * q[0][1] + 2 * m * t * q[1][1] + t * t * q[2][1]]; }

// Proper crossings between non-adjacent edges of a closed polygon (grid accelerated).
export function selfIntersections(P, limit = 1000) {
  const n = P.length;
  if (n < 4) return 0;
  const bb = bbox(P), size = Math.max(bb[2] - bb[0], bb[3] - bb[1]) || 1, cell = size / Math.max(4, Math.sqrt(n));
  const grid = new Map();
  const key = (i, j) => i * 100003 + j;
  for (let e = 0; e < n; e++) {
    const a = P[e], b = P[(e + 1) % n];
    const i0 = Math.floor(Math.min(a[0], b[0]) / cell), i1 = Math.floor(Math.max(a[0], b[0]) / cell);
    const j0 = Math.floor(Math.min(a[1], b[1]) / cell), j1 = Math.floor(Math.max(a[1], b[1]) / cell);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) { const k = key(i, j); (grid.get(k) || grid.set(k, []).get(k)).push(e); }
  }
  const seen = new Set();
  let count = 0;
  for (const list of grid.values()) {
    for (let x = 0; x < list.length; x++) for (let y = x + 1; y < list.length; y++) {
      let e = list[x], f = list[y];
      if (e > f) [e, f] = [f, e];
      if (f - e <= 1 || (e === 0 && f === n - 1)) continue;
      const k = e * n + f;
      if (seen.has(k)) continue;
      seen.add(k);
      if (segCross(P[e], P[(e + 1) % n], P[f], P[(f + 1) % n])) { if (++count >= limit) return count; }
    }
  }
  return count;
}
function segCross(a, b, c, d) {
  const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}
export function pointInPoly(q, P) {
  let inside = false;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const a = P[i], b = P[j];
    if ((a[1] > q[1]) !== (b[1] > q[1]) && q[0] < ((b[0] - a[0]) * (q[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
// A point strictly inside a polygon (for containment tests of the hierarchy).
export function interiorPoint(P) {
  const bb = bbox(P), y = (bb[1] + bb[3]) / 2;
  const xs = [];
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const a = P[i], b = P[j]; if ((a[1] > y) !== (b[1] > y)) xs.push(((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]); }
  xs.sort((a, b) => a - b);
  let best = null, w = -1;
  for (let i = 0; i + 1 < xs.length; i += 2) if (xs[i + 1] - xs[i] > w) { w = xs[i + 1] - xs[i]; best = [(xs[i] + xs[i + 1]) / 2, y]; }
  return best || [(bb[0] + bb[2]) / 2, y];
}
// Nearest-point lookup on a uniform grid.
export function pointGrid(P, cell) {
  const g = new Map(), key = (i, j) => i * 73856093 ^ j * 19349663;
  P.forEach((p, idx) => { const k = key(Math.floor(p[0] / cell), Math.floor(p[1] / cell)); (g.get(k) || g.set(k, []).get(k)).push(idx); });
  return (q) => {
    const gi = Math.floor(q[0] / cell), gj = Math.floor(q[1] / cell);
    let best = -1, bd = Infinity;
    for (let r = 0; r < 200; r++) {
      if (best >= 0 && bd <= (r - 1) * cell) break;
      for (let i = gi - r; i <= gi + r; i++) for (let j = gj - r; j <= gj + r; j++) {
        if (Math.max(Math.abs(i - gi), Math.abs(j - gj)) !== r) continue;
        const arr = g.get(key(i, j));
        if (arr) for (const idx of arr) { const d = Math.hypot(P[idx][0] - q[0], P[idx][1] - q[1]); if (d < bd) { bd = d; best = idx; } }
      }
    }
    return best;
  };
}
