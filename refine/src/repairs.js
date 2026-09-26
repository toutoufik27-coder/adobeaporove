// Geometry REPAIRS (see changes.js): each one looks for one kind of real defect, builds
// the corrected geometry as a candidate, and hands it to engine.attempt(), which accepts
// it only on measured evidence (geometry, topology, local and global render). Nothing
// here is applied directly.
import { attempt, record, subBox, boxOf, occluderOf } from './engine.js';
import { cropView, rasterPolys, fillPolys, alphaBoxes } from './raster.js';
import { tanIn, tanOut, segStart, segEnd, sampleNative } from './features.js';
import { dist, sub, add, mul, norm, cross, turnDeg, bbox, hausdorff } from './geom.js';
import { apply } from './matrix.js';
import { outline, corners, contourEvidence, nearestDistance } from './evidence.js';

const lu = (ctx, e) => ctx.u / (e.scale || 1);
const replaceSub = (subs, i, sp) => subs.map((s, k) => (k === i ? sp : s));
const cloneSeg = (g) => ({ t: g.t, p: g.p.map((q) => q.slice()), ...(g.a ? { a: { ...g.a } } : {}) });
const spBox = (sp) => bbox(sp.segs.flatMap((g) => g.p));
const rootBox = (e, sp) => { const b = spBox(sp), P = [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]].map((q) => apply(e.ctm, q)); return bbox(P); };
const boxGap = (a, b) => Math.max(0, a[0] - b[2], b[0] - a[2], a[1] - b[3], b[1] - a[3]);
const samePaint = (a, b) => a.kind === b.kind && (a.kind === 'none' || (a.kind === 'solid' ? a.rgb.join() === b.rgb.join() : a.ref === b.ref));
const sameList = (a, b) => (a || []).length === (b || []).length && (a || []).every((x, i) => x.ref === b[i].ref && x.node === b[i].node);

// ---------------------------------------------------------------- hidden geometry
// A contour is removed as hidden only when it is CERTAINLY hidden: it has zero visible
// coverage at the working resolution AND at 4x in its own neighbourhood, measured
// through the shapes above it that the renderer draws exactly (anything unsupported -
// text, image, filter, pattern, marker, unknown CSS - hides nothing), and the
// candidate render must not change at all (engine.attempt strict). "Probably hidden"
// (a thin visible sliver, 1 % showing) is kept.
export function certainlyHidden(ctx, e, sp) {
  const { doc, view } = ctx;
  const box = rootBox(e, sp);
  if (!isFinite(box[0])) return false;
  let crop = cropView(view, box, 2 / view.k, 4);
  if (crop.W * crop.H > 1.5e6) crop = cropView(view, box, 2 / view.k, Math.max(1, 4 * Math.sqrt(1.5e6 / (crop.W * crop.H))));
  const r = rasterPolys(fillPolys([sp], e.ctm, crop), e.rule, crop);
  if (!r) return false;
  const above = { ...doc, elements: doc.elements.map((x) => (x.idx > e.idx ? occluderOf(x) : { ...x, render: false })) };
  const T = new Float32Array(crop.W * crop.H).fill(1);
  alphaBoxes(above, crop).forEach((b) => { if (b) for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) { const p = (b.y0 + y) * crop.W + b.x0 + x; T[p] *= 1 - b.data[y * b.w + x]; } });
  for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) { const c = r.data[y * r.w + x]; if (c > 0 && T[(r.y0 + y) * crop.W + r.x0 + x] > 0) return false; }
  return true;
}

// ---------------------------------------------------------------- accidental artifacts
// A speck left by the tracer: a closed filled contour no larger than the mode's
// micro-segment size, with no other geometry near it, and not one of a set of similar
// small marks (dots in a pattern are drawn on purpose). Its removal is judged by its
// absolute size on the render (engine.attempt visual 'tiny').
export function tinyArtifacts(ctx, P, referenced) {
  const { doc, S } = ctx, lim = S.micro * ctx.u;
  const all = [];
  for (const e of doc.elements) for (const [i, sp] of (e.subpaths || []).entries()) if (sp.segs.length) all.push({ e, i, sp, box: rootBox(e, sp) });
  // also everything the renderer draws but the engine does not edit (text, image, use ...)
  const others = doc.elements.filter((e) => e.render !== false && (!e.subpaths || !e.subpaths.length)).map((e) => ({ e, box: boxOf(e, e.subpaths || []) })).filter((x) => isFinite(x.box[0]));
  const sizeOf = (b) => Math.max(b[2] - b[0], b[3] - b[1]);
  for (const e of doc.elements) {
    if (!e.editable || e.removed || !e.subpaths.length || e.stroke.kind !== 'none' || e.fill.kind === 'none' || referenced.has(e.idx) || e.id) continue;
    for (let i = e.subpaths.length - 1; i >= 0; i--) {
      const sp = e.subpaths[i], box = rootBox(e, sp), size = sizeOf(box);
      if (!sp.closed && sp.segs.length < 2) continue;
      if (!(size > 0) || size > lim) continue;
      // isolated: nothing else within twice its size (or 2 u)
      const reach = Math.max(2 * size, 2 * ctx.u);
      if (all.some((o) => o.sp !== sp && boxGap(o.box, box) <= reach) || others.some((o) => boxGap(o.box, box) <= reach)) continue;
      // repetition: two or more other marks of about the same size are a pattern
      const alike = all.filter((o) => o.sp !== sp && Math.abs(sizeOf(o.box) - size) <= 0.5 * size).length;
      if (alike >= 2) { record(ctx, { pass: P, op: 'tiny artifact', el: e.idx, sub: i, accepted: false, reason: `kept: ${alike} other marks of the same size (a pattern, not an artifact)` }); continue; }
      const cand = e.subpaths.filter((s) => s !== sp);
      const ok = attempt(ctx, P, 'tiny artifact', e, [{ subpaths: cand, topologyChange: true, visual: 'tiny', label: `isolated speck ${(size / ctx.u).toFixed(2)} u (limit ${S.micro} u)`, focus: box }], { sub: cand.length ? i : null });
      if (ok && !e.subpaths.length) e.removed = true;
    }
  }
}

// ---------------------------------------------------------------- duplicate geometry
// The same outline drawn twice with the same paint: the lower copy only thickens the
// anti-aliased edge. It is removed when nothing drawn between the two copies overlaps
// them (the upper copy then shows exactly what both showed).
export function duplicates(ctx, P, referenced) {
  const { doc } = ctx;
  const root = (e) => e.subpaths.map((sp) => sampleNative(sp, 0.5 * lu(ctx, e)).pts.map((q) => apply(e.ctm, q)));
  const els = doc.elements.filter((e) => e.editable && !e.removed && e.subpaths.length && e.render !== false);
  for (let a = 0; a < els.length; a++) {
    const e = els[a];
    if (e.removed || referenced.has(e.idx) || e.id) continue;
    for (let b = a + 1; b < els.length; b++) {
      const f = els[b];
      if (f.removed || f.subpaths.length !== e.subpaths.length || e.rule !== f.rule) continue;
      if (!samePaint(e.fill, f.fill) || !samePaint(e.stroke, f.stroke) || e.fillOpacity !== f.fillOpacity || e.strokeOpacity !== f.strokeOpacity || e.opacity !== f.opacity || (e.stroke.kind !== 'none' && e.strokeWidth !== f.strokeWidth)) continue;
      if (!sameList(e.clips, f.clips) || !sameList(e.masks, f.masks) || (e.chain || []).length || (f.chain || []).length) continue;
      if (e.fill.kind !== 'none' && (e.fill.rgb[3] < 1 || e.fillOpacity < 1 || e.opacity < 1)) continue;   // translucent copies add up: not a duplicate
      const bxE = boxOf(e, e.subpaths), bxF = boxOf(f, f.subpaths);
      if (Math.max(...bxE.map((v, i) => Math.abs(v - bxF[i]))) > 0.05 * ctx.u) continue;
      const A = root(e), B = root(f);
      if (!A.every((pa, i) => pa.length && B[i].length && hausdorff(pa, B[i], ctx.u) <= 0.02 * ctx.u)) continue;
      // nothing in between may overlap them
      if (doc.elements.some((x) => x.idx > e.idx && x.idx < f.idx && !x.removed && x.render !== false && boxGap(boxOf(x, x.subpaths || []), bxE) <= 0)) continue;
      const ok = attempt(ctx, P, 'duplicate geometry', e, [{ subpaths: [], topologyChange: true, label: `drawn again as element #${f.idx}`, focus: bxE }]);
      if (ok) { e.removed = true; break; }
    }
  }
}

// ---------------------------------------------------------------- broken continuity
// One stroked line written as two subpaths that meet at the same node (M restarts where
// the last one ended): joined into one, so the join is drawn as a join, not as two caps.
export function joinBrokenStrokes(ctx, P, strokeLocked) {
  for (const e of ctx.doc.elements) {
    if (!e.editable || e.removed || e.stroke.kind === 'none' || e.fill.kind !== 'none' || strokeLocked(e) || e.subpaths.length < 2) continue;
    const u = lu(ctx, e), eps = Math.min(0.05 * u, 0.05 * (e.strokeWidth || 1));
    for (let i = e.subpaths.length - 2; i >= 0; i--) {
      const a = e.subpaths[i], b = e.subpaths[i + 1];
      if (a.closed || b.closed || !a.segs.length || !b.segs.length) continue;
      const gap = dist(segEnd(a.segs[a.segs.length - 1]), segStart(b.segs[0]));
      if (gap > eps) continue;
      const segs = [...a.segs.map(cloneSeg), ...b.segs.map(cloneSeg)];
      segs[a.segs.length].p[0] = segs[a.segs.length - 1].p.at(-1);
      const joined = { ...a, segs, closed: false };
      const cand = [...e.subpaths.slice(0, i), joined, ...e.subpaths.slice(i + 2)];
      attempt(ctx, P, 'join broken stroke', e, [{ subpaths: cand, topologyChange: true, allowMore: true, label: `subpaths ${i + 1} and ${i + 2} meet at one node (gap ${(gap / u).toFixed(3)} u)`, focus: subBox(e, joined) }], { sub: null });
    }
  }
}

// ---------------------------------------------------------------- self-intersection loops
// A closed outline of straight segments that crosses itself in a tiny loop (a corner
// that overshoots and comes back): the loop is cut at the crossing. Only loops no longer
// than the mode's micro size x 4; curved segments are not cut (reported as a limit).
export function loopRepair(ctx, P) {
  const S = ctx.S;
  for (const e of ctx.doc.elements) {
    if (!e.editable || e.removed || e.fill.kind === 'none' || e.stroke.kind !== 'none') continue;
    const u = lu(ctx, e), maxLoop = 4 * S.micro * u;
    e.subpaths.forEach((x, si) => {
      const sp = e.subpaths[si];
      if (!sp.closed || sp.segs.length < 4 || !sp.segs.every((g) => g.t === 'L')) return;
      const V = sp.segs.map((g) => g.p[0]), n = V.length;
      for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
        if (i === 0 && j === n - 1) continue;
        const X = crossAt(V[i], V[(i + 1) % n], V[j], V[(j + 1) % n]);
        if (!X) continue;
        // the two sides of the crossing: i+1..j (inner) and j+1..i (outer); the tiny one is the loop
        const inner = [X, ...V.slice(i + 1, j + 1)], outer = [X, ...V.slice(j + 1), ...V.slice(0, i + 1)];
        const len = (Q) => Q.reduce((s, q, k) => s + dist(q, Q[(k + 1) % Q.length]), 0);
        const keep = len(inner) <= len(outer) ? outer : inner, loop = keep === outer ? inner : outer;
        if (len(loop) > maxLoop) continue;
        const segs = keep.map((q, k) => ({ t: 'L', p: [q.slice(), keep[(k + 1) % keep.length].slice()] }));
        const cand = { ...sp, segs, start: keep[0] };
        const done = attempt(ctx, P, 'self-intersection loop', e, [{ subpaths: replaceSub(e.subpaths, si, cand), topologyChange: true, label: `loop of ${(len(loop) / u).toFixed(2)} u cut at the crossing`, geom: [{ cur: sp, cand, maxDev: S.maxDev, noArea: true }], focus: subBox(e, sp) }], { sub: si });
        if (done) return;
      }
    });
  }
}
function crossAt(a, b, c, d) {
  const r = sub(b, a), s = sub(d, c), den = cross(r, s);
  if (Math.abs(den) < 1e-12) return null;
  const t = cross(sub(c, a), s) / den, w = cross(sub(c, a), r) / den;
  if (t <= 1e-9 || t >= 1 - 1e-9 || w <= 1e-9 || w >= 1 - 1e-9) return null;
  return add(a, mul(r, t));
}

// ---------------------------------------------------------------- outlier control point
// At a node that should be smooth (a slight break, well below the corner angle), one
// handle follows the curve around it and the other does not: the other one is an
// outlier. It is turned to continue the good handle (length kept), which restores the
// tangent continuity. Nodes where both handles disagree are left alone.
export function kinkRepair(ctx, P, e, i) {
  const S = ctx.S, sp = e.subpaths[i], n = sp.segs.length;
  if (n < 3) return false;
  const segs = sp.segs.map(cloneSeg), fixes = [];
  for (let k = sp.closed ? 0 : 1; k < n; k++) {
    const a = segs[(k - 1 + n) % n], b = segs[k];
    if (a.t !== 'C' || b.t !== 'C') continue;
    const q = b.p[0], ang = turnDeg(tanOut(a), tanIn(b));
    if (ang < 2 || ang > Math.min(S.cornerAngle, 20)) continue;
    // the direction the neighbourhood gives: from the previous node to the next one
    const t = norm(sub(segEnd(b), segStart(a)));
    const dA = turnDeg(tanOut(a), t), dB = turnDeg(tanIn(b), t);
    if (Math.min(dA, dB) > ang / 3) continue;                    // both off: not one outlier
    if (dA <= dB) { const L = dist(q, b.p[1]); b.p[1] = add(q, mul(tanOut(a), L)); }
    else { const L = dist(q, a.p[2]); a.p[2] = sub(q, mul(tanIn(b), L)); }
    fixes.push(ang);
  }
  if (!fixes.length) return false;
  const cand = { ...sp, segs };
  return !!attempt(ctx, P, 'kink repair', e, [{ subpaths: replaceSub(e.subpaths, i, cand), allowMore: true, label: `${fixes.length} broken smooth node(s) (${fixes.map((x) => x.toFixed(1) + '°').join(', ')})`, geom: [{ cur: sp, cand, maxDev: S.maxDev }], focus: subBox(e, sp) }], { sub: i });
}

// ---------------------------------------------------------------- primitive evidence
// Whether a contour really is a circle / ellipse / rectangle ... drawn imprecisely, or a
// shape that only resembles one. Measured against the contour as drawn:
//   hausdorff    max distance to the primitive, within the mode's deviation AND within
//                shapeMaxDev of the primitive's own size
//   area / perimeter   relative differences
//   corners      a round primitive may not replace real corners; a polygon must keep
//                exactly its corners
//   regularity   the deviation smoothed along the outline (a systematic departure, an
//                intentionally irregular shape) must stay under shapeSystematic
// Local and global render differences are then measured by engine.attempt.
export function primitiveEvidence(ctx, e, ref, cand, kind, size) {
  const S = ctx.S, u = lu(ctx, e);
  const ev = contourEvidence(ref, cand, u, S.cornerAngle);
  const rel = (ev.hausdorff * u) / Math.max(size, 1e-12);
  // regularity: signed distance of the drawn outline to the primitive, averaged over a
  // window of 1/12 of the outline
  const A = outline(ref, u).pts, B = outline(cand, u).pts;
  const bb = bbox(A.concat(B)), cell = Math.max(u, Math.hypot(bb[2] - bb[0], bb[3] - bb[1]) / 128);
  const near = nearestDistance(B, cell), d = A.map(near);
  const w = Math.max(1, Math.round(A.length / 12));
  let sys = 0;
  for (let i = 0; i < d.length; i++) { let s = 0; for (let k = -w; k <= w; k++) s += d[(i + k + d.length) % d.length]; sys = Math.max(sys, s / (2 * w + 1)); }
  const refCorners = corners(outline(ref, u).poly, true, S.cornerAngle, 2 * u).length;
  const out = { ...ev, relDeviation: rel, systematic: sys / Math.max(size, 1e-12), refCorners };
  let why = null;
  if (ev.hausdorff > S.maxDev) why = `deviation ${ev.hausdorff.toFixed(2)} u from the ${kind} is above ${S.maxDev} u`;
  else if (rel > S.shapeMaxDev) why = `deviation ${(rel * 100).toFixed(2)}% of its size is above ${(S.shapeMaxDev * 100).toFixed(2)}%`;
  else if (out.systematic > S.shapeSystematic) why = `the outline departs from the ${kind} systematically (${(out.systematic * 100).toFixed(2)}% of its size): an intentional shape, kept`;
  else if (ev.areaError > S.shapeArea) why = `area differs by ${(ev.areaError * 100).toFixed(2)}% (limit ${(S.shapeArea * 100).toFixed(2)}%)`;
  else if (ev.perimeterError > S.shapePerimeter) why = `perimeter differs by ${(ev.perimeterError * 100).toFixed(2)}% (limit ${(S.shapePerimeter * 100).toFixed(2)}%)`;
  else if ((kind === 'circle' || kind === 'ellipse') && refCorners > 0) why = `the outline has ${refCorners} real corner(s): not a ${kind}`;
  else if (ev.cornersLost || ev.cornersAdded) why = `corners would change (${ev.cornersLost} lost, ${ev.cornersAdded} added)`;
  return { evidence: out, why };
}
