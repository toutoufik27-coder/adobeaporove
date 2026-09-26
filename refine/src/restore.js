// Restoration to the source image: every visible edge of a shape is looked for in
// the real picture (along its normal, between the shape's colour and the colour next
// to it) and moved there; the outline is then rebuilt (corners + lines / arcs /
// curves). A candidate is kept only when the shape gets closer to the source image.
import { outline, corners } from './evidence.js';
import { apply, invert } from './matrix.js';
import { render, cropView, makeView } from './raster.js';
import { lab } from './raster.js';
import { sampleUser, sourceOnView } from './source.js';
import { sampleNative, topology, polyOf, selfIntersections, segLength } from './features.js';
import { fitStretch } from './fit.js';
import { expand } from './pathdata.js';
import { flatten, dist, sub, add, mul, norm, dot, turnDeg, bbox } from './geom.js';
import { hiddenAt, refreshOcclusion, record, boxOf, subBox, nodesOf, featureSafety } from './engine.js';

const dE = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const labC = (c) => lab(c[0], c[1], c[2]);

// winding of a point against the element's own outline (fill test)
function makeFillTest(e, subs) {
  const polys = subs.map((sp) => flatten(expand(sp.segs), 0.05).map((q) => apply(e.ctm, q)));
  return (q) => {
    let w = 0, cross = 0;
    for (const P of polys) for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
      const a = P[j], b = P[i];
      if ((a[1] <= q[1]) !== (b[1] <= q[1])) {
        const x = a[0] + ((q[1] - a[1]) * (b[0] - a[0])) / (b[1] - a[1]);
        if (x > q[0]) { cross++; w += b[1] > a[1] ? 1 : -1; }
      }
    }
    return e.rule === 'evenodd' ? cross % 2 === 1 : w !== 0;
  };
}

// error of the current render against the image along a band around one outline
export function imageError(ctx, img, view) {
  const ref = sourceOnView(ctx.src, view);
  let sum = 0, bad = 0;
  const N = view.W * view.H;
  for (let p = 0; p < N; p++) {
    const a = lab(ref[p * 3], ref[p * 3 + 1], ref[p * 3 + 2]), b = lab(img[p * 3], img[p * 3 + 1], img[p * 3 + 2]);
    const d = dE(a, b); sum += d; if (d > 20) bad++;
  }
  return { mean: sum / N, bad, badShare: bad / N };
}

// Where the source image puts the edge of contour i, measured along the outline's
// normal every `stepPx` image pixels: d[k] is the signed distance (user units, outward
// positive) from the outline to the colour transition in the image; known[k] marks
// the samples where it could be measured (a visible edge, not covered, not ambiguous).
function measureEdges(ctx, e, subs, i, curImg, stepPx) {
  const { src, view } = ctx;
  const sp = subs[i];
  const s = src.T.s, px = 1 / s;                                  // one image pixel in user units
  const sc = e.scale || 1;
  const P = sampleNative(sp, (stepPx * px) / sc).pts;            // local, every stepPx image px
  const R = P.map((q) => apply(e.ctm, q));
  const inside = makeFillTest(e, subs);
  const F = labC(e.fill.rgb), n = R.length, D = 8 * px, step = 0.25 * px;
  const d = new Float32Array(n), known = new Uint8Array(n);
  const tmp = [0, 0, 0];
  const renderAt = (q) => { const x = Math.floor((q[0] - view.x) * view.k), y = Math.floor((q[1] - view.y) * view.k); if (x < 0 || y < 0 || x >= view.W || y >= view.H) return null; const p = (y * view.W + x) * 3; return [curImg[p], curImg[p + 1], curImg[p + 2]]; };
  for (let k = 0; k < n; k++) {
    const a = R[(k - 2 + n) % n], b = R[(k + 2) % n];
    let t = norm(sub(b, a));
    if (!t[0] && !t[1]) continue;
    let nOut = [t[1], -t[0]];
    // outward = away from the fill
    const eps = 0.6 * px;
    const inA = inside(add(R[k], mul(nOut, -eps))), inB = inside(add(R[k], mul(nOut, eps)));
    if (inA === inB) continue;                                   // ambiguous (thin part / touching)
    if (inB) nOut = mul(nOut, -1);
    if (hiddenAt(ctx, e, P[k])) continue;                         // covered by a shape above
    const oc = renderAt(add(R[k], mul(nOut, 2.5 / view.k)));
    if (!oc) continue;
    const O = labC(oc);
    if (dE(F, O) < 12) continue;                                  // no visible edge here
    // profile f(t) = distance to own colour - distance to the outside colour
    let best = null, prevT = null, prevF = null, allPos = true, allNeg = true;
    for (let tt = -D; tt <= D + 1e-9; tt += step) {
      const c = labC(sampleUser(src, R[k][0] + nOut[0] * tt, R[k][1] + nOut[1] * tt, tmp));
      const f = dE(c, F) - dE(c, O);
      if (f > 0) allNeg = false; else allPos = false;
      if (prevF !== null && prevF <= 0 && f > 0) {
        const z = prevT + (step * -prevF) / (f - prevF);
        if (!best || Math.abs(z) < Math.abs(best)) best = z;
      }
      prevT = tt; prevF = f;
    }
    if (best === null) { if (allPos) { d[k] = -D; known[k] = 1; } continue; }
    d[k] = best; known[k] = 1;
    R[k].nOut = nOut;
  }
  return { P, R, d, known, n, px };
}
// How far an outline is from the image's edges (image pixels): mean and 90th percentile
// of |d| over the measured samples. Blur and anti-aliasing do not move this measure
// (the transition's midpoint is found), unlike a count of differing pixels.
export function edgeError(ctx, e, subs, i, curImg) {
  const { d, known, n, px } = measureEdges(ctx, e, subs, i, curImg, 1);
  const v = [];
  for (let k = 0; k < n; k++) if (known[k]) v.push(Math.abs(d[k]) / px);
  v.sort((a, b) => a - b);
  return { mean: v.reduce((a, b) => a + b, 0) / Math.max(1, v.length), p90: v.length ? v[Math.floor(0.9 * (v.length - 1))] : 0, measured: v.length, samples: n };
}

export function snapSubpath(ctx, e, i, curImg) {
  const { src } = ctx;
  const sp = e.subpaths[i];
  const s = src.T.s, px = 1 / s;                                  // one image pixel in user units
  const sc = e.scale || 1, inv = invert(e.ctm);
  if (!inv) return null;
  if (sampleNative(sp, (0.5 * px) / sc).pts.length < 12) return null;
  const { R, d, known, n } = measureEdges(ctx, e, e.subpaths, i, curImg, 0.5);
  // nothing to correct?
  let moved = 0, cnt = 0;
  for (let k = 0; k < n; k++) if (known[k]) { cnt++; if (Math.abs(d[k]) > 0.6 * px) moved++; }
  if (cnt < 0.2 * n || moved < 3) return null;
  // robust smoothing of the displacement (median 7, then mean 3); unknown -> 0
  const med = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const w = [];
    for (let j = -3; j <= 3; j++) { const q = (k + j + n) % n; w.push(known[q] ? d[q] : 0); }
    w.sort((x, y) => x - y); med[k] = w[3];
  }
  const Q = [];
  for (let k = 0; k < n; k++) {
    const m = (med[(k - 1 + n) % n] + med[k] + med[(k + 1) % n]) / 3;
    const nOut = R[k].nOut;
    Q.push(nOut ? add(R[k], mul(nOut, m)) : R[k].slice());
  }
  // moving points near corners can fold the outline into tiny loops, or push one part
  // past its neighbours into a spike that turns straight back: both are cut out
  const Qc = removeSpurs(removeLoops(Q), 2 * px);
  if (Qc.length < 8) return null;
  // rebuild: corners on the corrected outline, simplest fit between them
  const L = Qc.map((q) => apply(inv, q));
  const segs = rebuild(L, (0.5 * px) / sc, ctx.S.cornerAngle);
  if (!segs) return null;
  return { ...sp, segs };
}

// Closed polyline without self-crossings: each crossing cuts off the shorter part.
function removeLoops(Q) {
  let P = Q.slice();
  for (let guard = 0; guard < 50; guard++) {
    const n = P.length;
    let hit = null;
    outer: for (let i = 0; i < n; i++) {
      const a = P[i], b = P[(i + 1) % n];
      for (let j = i + 2; j < n; j++) {
        if (i === 0 && j === n - 1) continue;
        const c = P[j], d = P[(j + 1) % n];
        const x = segX(a, b, c, d);
        if (x) { hit = { i, j, x }; break outer; }
      }
    }
    if (!hit) return P;
    const { i, j, x } = hit, inner = j - i, outerLen = n - inner;
    // keep the longer side of the crossing
    P = inner <= outerLen ? [...P.slice(0, i + 1), x, ...P.slice(j + 1)] : [x, ...P.slice(i + 1, j + 1)];
  }
  return P;
}
// Closed polyline without spurs: a point where the outline turns back by more than
// NEEDLE degrees, measured over `w` on each side, is the tip of a spike. Tips are
// removed one by one (the sharpest first) until no spike is left.
function removeSpurs(Q, w) {
  let P = Q.slice();
  const turnAt = (i) => {
    const n = P.length, q = P[i];
    let a = null, b = null;
    for (let k = 1; k < n; k++) { const r = P[(i - k + n) % n]; if (Math.hypot(r[0] - q[0], r[1] - q[1]) >= w) { a = r; break; } }
    for (let k = 1; k < n; k++) { const r = P[(i + k) % n]; if (Math.hypot(r[0] - q[0], r[1] - q[1]) >= w) { b = r; break; } }
    if (!a || !b) return 0;
    return turnDeg(norm(sub(q, a)), norm(sub(b, q)));
  };
  for (let guard = 0; guard < 400 && P.length > 8; guard++) {
    let worst = -1, at = -1;
    for (let i = 0; i < P.length; i++) { const t = turnAt(i); if (t > worst) { worst = t; at = i; } }
    if (worst <= NEEDLE) break;
    P = P.filter((_, i) => i !== at);
  }
  return P;
}
function segX(a, b, c, d) {
  const r = [b[0] - a[0], b[1] - a[1]], s = [d[0] - c[0], d[1] - c[1]], den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-12) return null;
  const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den, u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den;
  return t > 0 && t < 1 && u > 0 && u < 1 ? [a[0] + t * r[0], a[1] + t * r[1]] : null;
}

function rebuild(L, tol, cornerAngle) {
  const n = L.length, k = 3, ang = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = norm(sub(L[i], L[(i - k + n) % n])), b = norm(sub(L[(i + k) % n], L[i]));
    ang[i] = turnDeg(a, b);
  }
  const corners = [];
  for (let i = 0; i < n; i++) {
    if (ang[i] < Math.max(50, cornerAngle * 1.6)) continue;
    let isMax = true;
    for (let j = -k; j <= k; j++) if (j && ang[(i + j + n) % n] > ang[i]) { isMax = false; break; }
    if (isMax && (!corners.length || i - corners[corners.length - 1] > k)) corners.push(i);
  }
  if (corners.length > 1 && corners[0] + n - corners[corners.length - 1] <= k) corners.pop();
  const starts = corners.length ? corners : [0];
  const out = [];
  for (let c = 0; c < starts.length; c++) {
    const a = starts[c], b = c + 1 < starts.length ? starts[c + 1] : starts[0] + n;
    const run = [];
    for (let j = a; j <= b; j++) run.push(L[j % n]);
    if (run.length < 2) continue;
    const m = Math.min(k, run.length - 1);
    const t1 = norm(sub(run[m], run[0])), t2 = norm(sub(run[run.length - 1 - m], run[run.length - 1]));
    const f = fitStretch(run, t1, t2, tol, { allowArc: true });
    out.push(...f.segs.map((g) => ({ ...g, p: g.p.map((q) => q.slice()) })));
  }
  if (!out.length) return null;
  for (let j = 1; j < out.length; j++) out[j].p[0] = out[j - 1].p[out[j - 1].p.length - 1];
  const last = out[out.length - 1];
  last.p[last.p.length - 1] = out[0].p[0];
  return out;
}

// The pass. Candidates are judged against the source image, region by region.
export function passRestore(ctx) {
  const P = 'image restoration', { doc, view, src } = ctx;
  if (!src || !src.T) return;
  refreshOcclusion(ctx);
  const before = imageError(ctx, render(doc, view, { geom: (x) => (x.removed ? null : x.subpaths) }), view);
  for (let round = 0; round < 2; round++) {
    const curImg = render(doc, view, { geom: (x) => (x.removed ? null : x.subpaths) });
    for (const e of doc.elements) {
      if (!e.editable || e.removed || e.fill.kind !== 'solid' || e.stroke.kind !== 'none') continue;
      for (let i = 0; i < e.subpaths.length; i++) {
        const sp = e.subpaths[i];
        if (!sp.closed || sp.segs.length < 2) continue;
        const cand = snapSubpath(ctx, e, i, curImg);
        if (!cand) continue;
        judge(ctx, P, e, i, cand, curImg);
      }
    }
    refreshOcclusion(ctx);
  }
  const after = imageError(ctx, render(doc, view, { geom: (x) => (x.removed ? null : x.subpaths) }), view);
  ctx.imageFidelity = { before, after };
  record(ctx, { pass: P, op: 'image fidelity', accepted: after.mean <= before.mean, reason: `difference to the source image: mean ΔE ${before.mean.toFixed(2)} -> ${after.mean.toFixed(2)}, wrong pixels ${(before.badShare * 100).toFixed(2)}% -> ${(after.badShare * 100).toFixed(2)}%` });
}

const NEEDLE = 150;
export function newNeedles(cur, cand, u) {
  const sharp = (sp) => corners(outline(sp, u).poly, sp.closed, NEEDLE, 2 * u);
  const a = sharp(cur), fresh = sharp(cand).filter((c) => !a.some((q) => Math.hypot(c.p[0] - q.p[0], c.p[1] - q.p[1]) <= 2 * u));
  return fresh.length ? Math.max(...fresh.map((c) => c.turn)) : 0;
}
function judge(ctx, P, e, i, cand, curImg) {
  const cur = e.subpaths[i], u = ctx.u / (e.scale || 1);
  const subs = e.subpaths.map((s, k) => (k === i ? cand : s));
  const base = { pass: P, op: 'restore outline', el: e.idx, sub: i, nodes: [nodesOf([cur]), nodesOf([cand])] };
  const unsafe = featureSafety(ctx, e, subs);
  if (unsafe) return record(ctx, { ...base, accepted: false, reason: unsafe });
  const t0 = topology(e.subpaths, e.rule, u), t1 = topology(subs, e.rule, u);
  if (t0.signature !== t1.signature) return record(ctx, { ...base, accepted: false, reason: 'topology would change (contours / holes / nesting)' });
  const ia = selfIntersections(polyOf(cur, 0.25 * u), 50), ib = selfIntersections(polyOf(cand, 0.25 * u), 50);
  if (ib > ia) return record(ctx, { ...base, accepted: false, reason: `creates self-intersections (${ia} -> ${ib})` });
  // a spike: the outline turns back on itself (> 150 degrees within 2 u) where the
  // current outline does not. Snapping to blurred image edges can pull one node past
  // its neighbours; the needle it leaves is thin enough to improve the pixel error and
  // is still an artifact
  const needles = newNeedles(cur, cand, u);
  if (needles) return record(ctx, { ...base, accepted: false, reason: `creates a spike (the outline turns back by ${needles.toFixed(0)}°)` });
  if (nodesOf([cand]) > Math.max(nodesOf([cur]) * 1.5, nodesOf([cur]) + 10)) return record(ctx, { ...base, accepted: false, reason: 'too many nodes for the corrected outline' });
  const box = (() => { const a = subBox(e, cur), b = subBox(e, cand); return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]; })();
  let crop = cropView(ctx.view, box, 3 * ctx.u + 3 / ctx.view.k, Math.max(1, ctx.src.T.s / ctx.view.k));
  if (crop.W * crop.H > 400000) crop = cropView(ctx.view, box, 3 * ctx.u + 3 / ctx.view.k, 1);
  const geomCur = (x) => (x.removed ? null : x.subpaths);
  const a = imageError(ctx, render(ctx.doc, crop, { geom: geomCur, box: (x, s) => boxOf(x, s) }), crop);
  const b = imageError(ctx, render(ctx.doc, crop, { geom: (x) => (x === e ? subs : geomCur(x)), box: (x, s) => boxOf(x, s) }), crop);
  // Two measures of "closer to the image". The pixel count is dominated by the
  // anti-aliased edge band (a crisp outline against a soft image differs there wherever
  // the outline is), so it can reject an outline that sits measurably closer to the
  // image's edges; the edge distance measures exactly that. Either may accept, the other
  // must not get clearly worse.
  const ea = edgeError(ctx, e, e.subpaths, i, curImg), eb = edgeError(ctx, e, subs, i, curImg);
  const metrics = { imageErrorBefore: +a.mean.toFixed(3), imageErrorAfter: +b.mean.toFixed(3), wrongPixelsBefore: a.bad, wrongPixelsAfter: b.bad, edgeErrorBefore: +ea.mean.toFixed(3), edgeErrorAfter: +eb.mean.toFixed(3), edgeP90Before: +ea.p90.toFixed(3), edgeP90After: +eb.p90.toFixed(3) };
  const pixelsCloser = (b.mean <= a.mean - 0.02 && b.bad <= a.bad + Math.max(3, 0.05 * a.bad)) || (b.bad < a.bad * 0.97 && b.mean <= a.mean + 0.01);
  const edgesNotWorse = eb.mean <= ea.mean + 0.02 && eb.p90 <= ea.p90 + 0.05;
  const edgesCloser = eb.measured >= 0.8 * ea.measured && eb.mean <= 0.85 * ea.mean && eb.p90 <= ea.p90 && b.mean <= a.mean + 0.05 && b.bad <= a.bad * 1.25 + 5;
  const how = `mean ΔE ${a.mean.toFixed(2)} -> ${b.mean.toFixed(2)}, wrong pixels ${a.bad} -> ${b.bad}, distance to the image's edges ${ea.mean.toFixed(2)} -> ${eb.mean.toFixed(2)} px (90 % within ${ea.p90.toFixed(2)} -> ${eb.p90.toFixed(2)} px)`;
  if ((pixelsCloser && edgesNotWorse) || edgesCloser) {
    e.subpaths = subs;
    record(ctx, { ...base, accepted: true, label: 'outline moved to the source image', reason: `closer to the source image: ${how}`, metrics });
  } else record(ctx, { ...base, accepted: false, label: 'outline moved to the source image', reason: `not closer to the source image (${how})`, metrics });
}
