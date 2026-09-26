// The ten processing passes. Each pass only proposes candidates; the engine core
// validates them on measured evidence (geometry, topology, region render) and logs the decision.
import { attempt, record, hiddenAt, visiblePixels, subpathVisibility, refreshOcclusion, subBox, unionBox, boxOf, regionCheck, globalCheck, nodesOf, snapshot, restore } from './engine.js';
import { deepCopy } from './model.js';
import { tanIn, tanOut, segLength, segStart, segEnd, sampleNative, nodeTypes, recognize, organicScore, symmetry, topology, polyOf, complexity } from './features.js';
import { fitStretch } from './fit.js';
import { dist, sub, add, mul, norm, cross, dot, len, turnDeg, lineDeviation, polyArea, bbox, pointGrid, hausdorff } from './geom.js';
import { roundSubpaths, parsePath, writePath } from './pathdata.js';
import { mult, apply, isIdentity, isUniform, scaleOf, invert } from './matrix.js';
import { getAttr, localName } from './xml.js';
import { touchesUncertain } from './capability.js';
import { certainlyHidden, tinyArtifacts, duplicates, joinBrokenStrokes, loopRepair, kinkRepair, primitiveEvidence } from './repairs.js';
import { noteChange, dropChanges, REPAIR, OPTIMIZATION } from './changes.js';
import { curveDistance } from './evidence.js';

const lu = (ctx, e) => ctx.u / (e.scale || 1);                    // artwork unit in element-local units
const editable = (ctx, e) => e.editable && !e.removed && e.subpaths.length;
const strokeLocked = (ctx, e) => ctx.S.strokePreservation && e.stroke.kind !== 'none';
const cloneSeg = (g) => ({ t: g.t, p: g.p.map((q) => q.slice()), ...(g.a ? { a: { ...g.a } } : {}) });
const replaceSub = (subs, i, sp) => subs.map((s, k) => (k === i ? sp : s));
const spBox = (sp) => { const f = polyOf(sp, 1e-3 * Math.max(1e-9, (() => { const b = bbox(sp.segs.flatMap((g) => g.p)); return Math.max(b[2] - b[0], b[3] - b[1]); })())); return bbox(f); };
const spSize = (sp) => { const b = bbox(sp.segs.flatMap((g) => g.p)); return Math.max(b[2] - b[0], b[3] - b[1]); };
const hiddenFn = (ctx, e) => (q) => hiddenAt(ctx, e, q);

// ---------------------------------------------------------------- Pass 1
export function passStructure(ctx) {
  const { doc, S } = ctx, P = 'structural cleanup';
  const referenced = new Set();
  for (const e of doc.elements) if (e.id && doc.ids.has(e.id)) referenced.add(e.idx);
  for (const r of refsIn(doc)) { const el = doc.ids.get(r); if (el) for (const e of doc.elements) if (e.node === el) referenced.add(e.idx); }
  for (const e of doc.elements) {
    if (!e.editable || e.removed) continue;
    const keepNode = referenced.has(e.idx) || e.id;
    // empty / invisible elements
    const invisible = (e.fill.kind === 'none' && e.stroke.kind === 'none') || e.opacity === 0 || (e.fill.kind === 'none' && !(e.strokeWidth > 0));
    if ((!e.subpaths.length || invisible) && !keepNode) {
      const op = !e.subpaths.length ? 'empty element' : 'invisible element';
      e.removed = true;
      record(ctx, { pass: P, op, el: e.idx, accepted: true, reason: op === 'empty element' ? 'no geometry' : 'no fill and no stroke (or opacity 0)', nodes: [nodesOf(e.subpaths), 0] });
      continue;
    }
    // degenerate contours: lone moveto, closed filled contour with no area and no stroke
    const u = lu(ctx, e);
    const keep = e.subpaths.filter((sp) => {
      if (!sp.segs.length) return e.stroke.kind !== 'none' && e.style['stroke-linecap'] !== 'butt';
      if (e.stroke.kind === 'none' && Math.abs(polyArea(polyOf(sp, 0.1 * u))) < 1e-6 * u * u) return false;
      return true;
    });
    if (keep.length < e.subpaths.length) attempt(ctx, P, 'degenerate contour', e, [{ subpaths: keep, topologyChange: true, label: `${e.subpaths.length - keep.length} contour(s) without area` }]);
    // topology repair: an open contour whose ends almost meet (a tiny accidental gap).
    // Filled: the fill already closes it, Z makes it explicit. Stroked: the gap must also
    // be tiny against the stroke width, and the render decides (caps become a join).
    const stroked = e.stroke.kind !== 'none' && e.strokeWidth > 0;
    if (S.topologyRepair && (e.fill.kind !== 'none' || stroked) && !(stroked && strokeLocked(ctx, e))) {
      const gapMax = stroked ? Math.min(0.5 * u, 0.25 * e.strokeWidth) : 0.5 * u;
      e.subpaths.forEach((sp, i) => {
        sp = e.subpaths[i];
        if (sp.closed || sp.segs.length < 2) return;
        const a = segStart(sp.segs[0]), z = segEnd(sp.segs[sp.segs.length - 1]);
        if (dist(a, z) > gapMax) return;
        const segs = sp.segs.map(cloneSeg);
        if (dist(a, z) > 0) segs.push({ t: 'L', p: [z, a], implicit: true });
        attempt(ctx, P, 'close open contour', e, [{ subpaths: replaceSub(e.subpaths, i, { ...sp, segs, closed: true }), topologyChange: true, allowMore: true, label: `ends ${(dist(a, z) / u).toFixed(2)} u apart: closed with Z`, focus: subBox(e, sp) }], { sub: i });
      });
    }
  }
  // geometry that can never be seen: only when CERTAINLY hidden (see repairs.js) - zero
  // visible coverage here and at 4x, and a render that does not change at all
  if (S.removeHidden) {
    const vis = subpathVisibility(ctx);
    for (let k = doc.elements.length - 1; k >= 0; k--) {
      const e = doc.elements[k];
      if (!editable(ctx, e) || e.stroke.kind !== 'none' || referenced.has(e.idx)) continue;
      const hidden = [];
      (vis.get(e) || []).forEach((v, i) => { if (v.total > 0 && v.visible === 0 && certainlyHidden(ctx, e, e.subpaths[i])) hidden.push(i); });
      if (!hidden.length) continue;
      if (hidden.length === e.subpaths.length && !e.id) {
        const ok = attempt(ctx, P, 'hidden element', e, [{ subpaths: [], strict: true, topologyChange: true, label: 'completely covered by shapes above', focus: boxOf(e, e.subpaths) }]);
        if (ok) e.removed = true;
        continue;
      }
      const all = e.subpaths.filter((sp, i) => !hidden.includes(i));
      const ok = attempt(ctx, P, 'hidden contours', e, [{ subpaths: all, strict: true, topologyChange: true, label: `${hidden.length} contour(s) covered by shapes above`, focus: boxOf(e, e.subpaths) }]);
      if (!ok) for (const h of hidden.reverse()) {
        const sp = e.subpaths[h];
        attempt(ctx, P, 'hidden contours', e, [{ subpaths: e.subpaths.filter((s, i) => i !== h), strict: true, topologyChange: true, focus: subBox(e, sp) }]);
      }
    }
    refreshOcclusion(ctx);
  }
  // repairs of accidental geometry (each judged by attempt on its own evidence)
  if (S.topologyRepair) {
    duplicates(ctx, P, referenced);
    tinyArtifacts(ctx, P, referenced);
    joinBrokenStrokes(ctx, P, (e) => strokeLocked(ctx, e));
    loopRepair(ctx, P);
    refreshOcclusion(ctx);
  }
}
function refsIn(doc) {
  const out = new Set();
  const scan = (el) => {
    for (const [k, v] of el.attrs) { for (const m of v.matchAll(/url\(\s*['"]?#([^'")\s]+)/g)) out.add(m[1]); if (/href$/.test(k) && v.startsWith('#')) out.add(v.slice(1)); }
    for (const c of el.children) if (c.type === 'el') scan(c);
  };
  scan(doc.root);
  return out;
}

// ---------------------------------------------------------------- Pass 2
// zero-length segments, exact and near-duplicate nodes
export function passDuplicates(ctx) {
  const P = 'duplicate point cleanup';
  for (const e of ctx.doc.elements) {
    if (!editable(ctx, e)) continue;
    const u = lu(ctx, e), near = 0.02 * u;
    e.subpaths.forEach((sp, i) => {
      sp = e.subpaths[i];
      let zero = 0, nearN = 0;
      const segs = [];
      for (const g of sp.segs) {
        const L = segLength(g);
        if (L === 0 || (g.t !== 'A' && g.p.every((q) => q[0] === g.p[0][0] && q[1] === g.p[0][1]))) { zero++; continue; }
        if (L < near && segs.length) {
          // near-duplicate node: absorb into the previous segment (keep handle directions)
          const prev = segs[segs.length - 1], end = segEnd(g), d = sub(end, segEnd(prev));
          if (prev.t === 'C') prev.p[2] = add(prev.p[2], d);
          prev.p[prev.p.length - 1] = end.slice();
          nearN++; continue;
        }
        segs.push(cloneSeg(g));
      }
      if (!zero && !nearN) return;
      relink(segs, sp.closed);
      if (segs.length < (sp.closed ? 1 : 1)) return;
      const cand = { ...sp, segs };
      attempt(ctx, P, zero ? 'zero-length segment' : 'near-duplicate point', e, [{ subpaths: replaceSub(e.subpaths, i, cand), label: `${zero} zero-length, ${nearN} near-duplicate`, geom: [{ cur: sp, cand, maxDev: 0.2 }], focus: subBox(e, sp) }], { sub: i });
    });
  }
}
// make each segment start where the previous one ends
function relink(segs, closed) {
  for (let k = 1; k < segs.length; k++) segs[k].p[0] = segs[k - 1].p[segs[k - 1].p.length - 1];
  if (closed && segs.length) {
    const last = segs[segs.length - 1];
    if (dist(segEnd(last), segStart(segs[0])) > 1e-9) {
      if (last.implicit || last.t === 'L') last.p[last.p.length - 1] = segs[0].p[0];
      else segs.push({ t: 'L', p: [segEnd(last), segs[0].p[0]], implicit: true });
    }
  }
}

// ---------------------------------------------------------------- Pass 3
// Micro-segments: tiny compared to the shape and the artwork; decided by length,
// angles, neighbours and whether the shape is itself a small detail.
export function passMicro(ctx) {
  const P = 'micro-segment cleanup', S = ctx.S;
  for (const e of ctx.doc.elements) {
    if (!editable(ctx, e)) continue;
    const u = lu(ctx, e);
    e.subpaths.forEach((sp0, i) => {
      const sp = e.subpaths[i], n = sp.segs.length;
      if (n < 4) return;
      const size = spSize(sp), microT = Math.min(S.micro * u, 0.02 * size);
      if (size < 25 * microT) { return; }                   // small detail: protected
      const segs = sp.segs.map(cloneSeg), fixes = [];
      let bevel = false;
      for (let k = 0; k < segs.length; k++) {
        if (segs.length < 4) break;
        const s = segs[k], L = segLength(s);
        if (L >= microT) continue;
        if (!sp.closed && (k === 0 || k === segs.length - 1)) continue;
        const pk = (k - 1 + segs.length) % segs.length, nk = (k + 1) % segs.length;
        const prev = segs[pk], next = segs[nk];
        const a1 = turnDeg(tanOut(prev), tanIn(s)), a2 = turnDeg(tanOut(s), tanIn(next)), across = turnDeg(tanOut(prev), tanIn(next));
        let target;
        if (across <= S.cornerAngle) target = mul(add(segStart(s), segEnd(s)), 0.5);          // noise on a smooth stretch
        else if (a1 < across && a2 < across && L < 0.5 * microT) {
          // a tiny bevel on a corner: meet at the corner point when the arms cross nearby
          const t1 = tanOut(prev), t2 = tanIn(next), den = cross(t1, t2);
          const m = mul(add(segStart(s), segEnd(s)), 0.5);
          if (Math.abs(den) > 1e-9) { const d = sub(segStart(next), segEnd(prev)), tt = cross(d, t2) / den, c = add(segEnd(prev), mul(t1, tt)); target = dist(c, m) < 2 * L + 0.05 * u ? c : m; } else target = m;
          bevel = true;
        } else continue;                                                                     // a real feature
        moveEnd(prev, target); moveStart(next, target);
        segs.splice(k, 1); k--;
        fixes.push(L);
      }
      if (!fixes.length) return;
      relink(segs, sp.closed);
      const cand = { ...sp, segs };
      // a tracer's bevel cut into a corner is a defect (the corner is restored); tiny noise
      // on a smooth stretch is only removed (node reduction)
      attempt(ctx, P, 'micro-segment', e, [{ subpaths: replaceSub(e.subpaths, i, cand), cls: bevel ? [REPAIR, 'geometry correction'] : [OPTIMIZATION, 'node reduction'], label: `${fixes.length} micro-segment(s) < ${(microT * (e.scale || 1) / ctx.u / 10).toFixed(2)}%`, geom: [{ cur: sp, cand, maxDev: Math.min(S.maxDev, 0.6) }], focus: subBox(e, sp) }], { sub: i });
    });
  }
}
function moveEnd(s, q) { const d = sub(q, segEnd(s)); if (s.t === 'C') s.p[2] = add(s.p[2], d); else if (s.t === 'Q') s.p[1] = add(s.p[1], mul(d, 0.5)); s.p[s.p.length - 1] = q.slice(); }
function moveStart(s, q) { const d = sub(q, segStart(s)); if (s.t === 'C') s.p[1] = add(s.p[1], d); else if (s.t === 'Q') s.p[1] = add(s.p[1], mul(d, 0.5)); s.p[0] = q.slice(); }

// ---------------------------------------------------------------- Pass 4
// Collinear nodes and straight stretches -> one line (maximum deviation decides).
export function passCollinear(ctx) {
  const P = 'collinear simplification', S = ctx.S;
  for (const e of ctx.doc.elements) {
    if (!editable(ctx, e)) continue;
    const u = lu(ctx, e), tol = S.simplify * u;
    e.subpaths.forEach((x, i) => {
      const sp = e.subpaths[i], n = sp.segs.length;
      if (n < 3) return;
      // rotate a closed contour so it starts at a corner (a straight run never wraps)
      let segs = sp.segs.map(cloneSeg), startShift = 0;
      if (sp.closed) {
        let best = 0, ba = -1;
        for (let k = 0; k < n; k++) { const a = turnDeg(tanOut(segs[(k - 1 + n) % n]), tanIn(segs[k])); if (a > ba) { ba = a; best = k; } }
        startShift = best;
        segs = [...segs.slice(best), ...segs.slice(0, best)];
      }
      const straight = (g) => g.t === 'L' || (g.t !== 'A' && lineDeviation(g.p.slice(1, -1), g.p[0], segEnd(g)) <= 0.05 * u && dot(sub(segEnd(g), g.p[0]), sub(g.p[1], g.p[0])) >= 0);
      const out = [];
      let removed = 0, worst = 0, k = 0;
      while (k < segs.length) {
        if (!straight(segs[k])) { out.push(segs[k]); k++; continue; }
        // extend a straight run while every node stays within tolerance of the chord
        let j = k, pts = [segs[k].p[0], segEnd(segs[k])];
        while (j + 1 < segs.length && straight(segs[j + 1])) {
          const cand = [...pts, segEnd(segs[j + 1])];
          const dev = lineDeviation(cand, cand[0], cand[cand.length - 1]);
          const turn = turnDeg(norm(sub(segEnd(segs[j]), segs[j].p[0])), norm(sub(segEnd(segs[j + 1]), segs[j + 1].p[0])));
          if (dev > tol || turn > 12) break;
          pts = cand; j++;
        }
        if (j > k || segs[k].t !== 'L') { worst = Math.max(worst, lineDeviation(pts, pts[0], pts[pts.length - 1]) / tol); removed += j - k; out.push({ t: 'L', p: [pts[0], pts[pts.length - 1]] }); }
        else out.push(segs[k]);
        k = j + 1;
      }
      if (out.length >= n && !out.some((g, q) => g.t !== segs[q].t)) return;
      relink(out, sp.closed);
      const cand = { ...sp, segs: out };
      attempt(ctx, P, 'collinear points', e, [{ subpaths: replaceSub(e.subpaths, i, cand), label: `${removed} node(s) on straight lines`, geom: [{ cur: sp, cand, maxDev: Math.max(S.simplify, 0.3) * 1.2 }], focus: subBox(e, sp) }], { sub: i });
    });
  }
}

// ---------------------------------------------------------------- Pass 5
// Curve analysis: node types, organic / geometric character, primitives, symmetry,
// importance and detail flags. No geometry change.
export function passAnalysis(ctx) {
  const { doc, u } = ctx;
  const img = ctx.origImg, view = ctx.view;
  const cx0 = doc.viewBox[0] + doc.viewBox[2] / 2, cy0 = doc.viewBox[1] + doc.viewBox[3] / 2, diag = Math.hypot(doc.viewBox[2], doc.viewBox[3]) / 2;
  const totalArea = doc.viewBox[2] * doc.viewBox[3];
  let organic = 0, geometric = 0, details = 0;
  ctx.info = doc.elements.map((e) => {
    if (!editable(ctx, e)) return null;
    const ul = lu(ctx, e), b = boxOf(e, e.subpaths);
    const area = Math.max(0, (b[2] - b[0]) * (b[3] - b[1]));
    // contrast: element colour vs the colours around its box in the original render
    let contrast = 0.5;
    if (e.fill.kind !== 'none') {
      const ring = [];
      const px = (x, y) => { const X = Math.round((x - view.x) * view.k), Y = Math.round((y - view.y) * view.k); if (X >= 0 && Y >= 0 && X < view.W && Y < view.H) ring.push([img[(Y * view.W + X) * 3], img[(Y * view.W + X) * 3 + 1], img[(Y * view.W + X) * 3 + 2]]); };
      for (let t = 0; t <= 1; t += 0.125) { px(b[0] - u, b[1] + t * (b[3] - b[1])); px(b[2] + u, b[1] + t * (b[3] - b[1])); px(b[0] + t * (b[2] - b[0]), b[1] - u); px(b[0] + t * (b[2] - b[0]), b[3] + u); }
      if (ring.length) { const c = e.fill.rgb; contrast = Math.min(1, ring.reduce((s, r) => s + Math.hypot(r[0] - c[0], r[1] - c[1], r[2] - c[2]), 0) / ring.length / 200); }
    }
    const centre = 1 - Math.min(1, Math.hypot((b[0] + b[2]) / 2 - cx0, (b[1] + b[3]) / 2 - cy0) / diag);
    const cx = complexity(e, ctx.u);
    const subs = e.subpaths.map((sp) => {
      const rec = sp.closed ? recognize(sp, ul) : [];
      const org = organicScore(sp, ul, rec);
      const size = spSize(sp) * (e.scale || 1);
      const detail = size < 20 * u || (sp.closed && Math.abs(polyArea(polyOf(sp, ul))) / Math.max(1e-9, sampleNative(sp, ul).pts.length * ul) < 1.5 * ul);
      if (org > 0.5) organic++; else geometric++;
      if (detail) details++;
      return { types: nodeTypes(sp, ul), rec: rec.slice(0, 2), organic: +org.toFixed(2), detail, size, sym: ctx.S.symmetry && sp.closed && !detail ? symmetry(sp, ul) : null };
    });
    const isolation = e.subpaths.length === 1 ? 1 : 0.5;
    const importance = Math.min(1, 0.35 * Math.min(1, Math.sqrt(area / totalArea) * 2) + 0.25 * contrast + 0.15 * centre + 0.15 * isolation * (area < totalArea * 0.01 ? 1 : 0.3) + 0.1 * Math.min(1, cx.score / 10));
    return { importance: +importance.toFixed(2), contrast: +contrast.toFixed(2), subs, complexity: cx };
  });
  record(ctx, { pass: 'curve analysis', op: 'analysis', accepted: null, reason: `${organic} organic, ${geometric} geometric contours, ${details} protected details` });
}

// ---------------------------------------------------------------- Pass 6
// Curve fitting between the nodes that must stay (corners); three candidates per
// contour (tight / mode / loose tolerance), the simplest valid one wins.
export function passFit(ctx) {
  const P = 'curve fitting', S = ctx.S;
  refreshOcclusion(ctx);
  for (const e of ctx.doc.elements) {
    if (!editable(ctx, e) || strokeLocked(ctx, e)) continue;
    const info = ctx.info[e.idx];
    const u = lu(ctx, e), hid = hiddenFn(ctx, e);
    e.subpaths.forEach((x, i) => {
      // a smooth node broken by one outlier handle is repaired first; the repaired
      // contour is final (refitting it would move it again within the tolerance)
      if (S.topologyRepair && kinkRepair(ctx, P, e, i)) return;
      const sp = e.subpaths[i], si = info && info.subs[i];
      if (!sp.segs.length || sp.segs.length < 3) return;
      const size = spSize(sp);
      if (size < 6 * u) return;                                   // tiny detail: kept as drawn
      const imp = info ? info.importance : 0.5;
      const sizeF = Math.max(0.5, Math.min(1.5, Math.sqrt(size / (150 * u))));
      const base = S.curve * u * sizeF * (1.15 - 0.4 * imp) * (si && si.detail ? 0.5 : 1) * (si && si.organic > 0.6 ? 0.8 : 1);
      const cands = [];
      for (const f of [0.5, 1, 1.6]) {
        const tol = base * f;
        const segs = refitContour(sp, tol, u, S, hid, si);
        if (!segs || segs.length >= sp.segs.length) continue;
        const cand = { ...sp, segs };
        cands.push({ subpaths: replaceSub(e.subpaths, i, cand), label: `refit at ${(tol * (e.scale || 1) / ctx.u / 10).toFixed(2)}% tolerance`, geom: [{ cur: sp, cand, maxDev: S.maxDev * sizeF * (si && si.detail ? 0.5 : 1), hidden: hid }], focus: subBox(e, sp) });
      }
      if (cands.length) attempt(ctx, P, 'curve reconstruction', e, cands, { sub: i });
    });
  }
}
function refitContour(sp, tol, u, S, hid, si) {
  const segs = sp.segs, n = segs.length;
  const corners = [];
  for (let k = 0; k < n; k++) {
    if (!sp.closed && k === 0) { corners.push(0); continue; }
    if (turnDeg(tanOut(segs[(k - 1 + n) % n]), tanIn(segs[k])) > S.cornerAngle) corners.push(k);
  }
  const allowArc = !(si && si.organic > 0.6);
  let starts = corners.length ? corners : [0];
  const out = [];
  const endAt = sp.closed ? n : n;
  for (let c = 0; c < starts.length; c++) {
    const a = starts[c];
    const b = c + 1 < starts.length ? starts[c + 1] : sp.closed ? starts[0] + n : n;
    const run = [];
    for (let k = a; k < b; k++) run.push(segs[k % n]);
    if (!run.length) continue;
    const P = sampleNative({ segs: run, closed: false }, 0.3 * u).pts;
    const hidden = P.length > 2 && P.every(hid);
    const t1 = tanIn(run[0]), t2 = mul(tanOut(run[run.length - 1]), -1);
    let fit;
    if (run.length === 1 && run[0].t === 'L') fit = { segs: [cloneSeg(run[0])] };
    else fit = fitStretch(P, t1, t2, hidden ? tol * S.hiddenFactor : tol, { allowArc });
    const fitted = fit.segs.map((g) => ({ ...g, p: g.p.map((q) => q.slice()) }));
    out.push(...(fitted.length < run.length || (fitted.length === run.length && fitted[0].t === 'L' && run[0].t !== 'L') ? fitted : run.map(cloneSeg)));
  }
  relink(out, sp.closed);
  return smoothJoins(out, S.cornerAngle, sp.closed);
}
// joins that were smooth stay smooth: slight breaks become collinear handles
function smoothJoins(segs, cornerAngle, closed) {
  const n = segs.length;
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const A = segs[i], B = segs[(i + 1) % n];
    if (A.t !== 'C' && B.t !== 'C') continue;
    const q = segEnd(A), ta = tanOut(A), tb = tanIn(B), ang = turnDeg(ta, tb);
    if (ang > Math.min(12, cornerAngle) || ang < 1e-3) continue;
    const t = A.t !== 'C' ? ta : B.t !== 'C' ? tb : norm(add(ta, tb));
    if (A.t === 'C') A.p[2] = sub(q, mul(t, dist(q, A.p[2])));
    if (B.t === 'C') B.p[1] = add(q, mul(t, dist(B.p[1], q)));
  }
  return segs;
}

// ---------------------------------------------------------------- Pass 7
// Shape recognition (circle, ellipse, rectangle, rounded rectangle, triangle, polygon).
// Recognition is done on the contour as drawn (after structural cleanup), and the
// decision on measured evidence only (repairs.js primitiveEvidence: deviation, area,
// perimeter, corners, regularity; then the local and global render in attempt). A
// shape that departs from the primitive on purpose is kept as drawn.
// Repetition: circles of the same size (within 2 %) drawn three or more times are
// rebuilt with their common radius when every copy still meets the evidence limits.
// Optional symmetry correction, also on measured deviation only.
const PRIMITIVES = ['circle', 'ellipse', 'rectangle', 'rounded-rectangle', 'triangle', 'quadrilateral', 'polygon'];
const primSize = (r) => r.kind === 'circle' ? r.params.r : r.kind === 'ellipse' ? Math.min(r.params.rx, r.params.ry) : r.kind === 'rounded-rectangle' ? Math.min(r.params.w, r.params.h) : (() => { const V = r.params.vertices, b = bbox(V); return Math.max(1e-12, Math.min(b[2] - b[0], b[3] - b[1], ...V.map((v, k) => dist(v, V[(k + 1) % V.length])))); })();
export function passShapes(ctx, before, ref = before) {
  const P = 'shape recognition', S = ctx.S;
  const items = [];
  for (const e of ctx.doc.elements) {
    if (!editable(ctx, e) || strokeLocked(ctx, e)) continue;
    const info = ctx.info[e.idx];
    if (!info) continue;
    const refs = ref && ref[e.idx] && ref[e.idx].subpaths.length === e.subpaths.length ? ref[e.idx].subpaths : e.subpaths;
    const u = lu(ctx, e);
    e.subpaths.forEach((x, i) => {
      const r0 = refs[i], si = info.subs[i];
      if (!r0 || !r0.closed || !si) return;
      const rec = recognize(r0, u).filter((r) => PRIMITIVES.includes(r.kind) && !(r.kind === 'polygon' && r.params.vertices.length > 8));
      if (rec.length) items.push({ e, i, r0, rec, u });
    });
  }
  // repetition / context: circles of one size drawn several times
  const circ = items.map((it) => ({ it, c: it.rec.find((r) => r.kind === 'circle') })).filter((x) => x.c);
  for (const x of circ) {
    const R = x.c.params.r * (x.it.e.scale || 1);
    const same = circ.filter((y) => Math.abs(y.c.params.r * (y.it.e.scale || 1) - R) <= 0.02 * R);
    if (same.length >= 3) { const rs = same.map((y) => y.c.params.r * (y.it.e.scale || 1)).sort((a, b) => a - b); x.it.common = rs[Math.floor(rs.length / 2)] / (x.it.e.scale || 1); x.it.repeats = same.length; }
  }
  for (const it of items) {
    const { e, i, r0, u } = it, sp = e.subpaths[i];
    // every recognised primitive, closest first; the common size of a repeated circle first
    const tries = [];
    for (const r of [...it.rec].sort((a, b) => a.deviation - b.deviation)) {
      if (r.kind === 'circle' && it.common && Math.abs(it.common - r.params.r) > 1e-9) tries.push({ ...r, params: { ...r.params, r: it.common }, common: true });
      tries.push(r);
    }
    let done = false;
    for (const r of tries) {
      // the fit's own error is a lower bound of the distance: far fits are not measured
      if (!r.common && r.deviation > S.maxDev * u) { record(ctx, { pass: P, op: `${r.kind} reconstruction`, el: e.idx, sub: i, accepted: false, reason: `deviation ${(r.deviation / u).toFixed(2)} u from the ${r.kind} is above ${S.maxDev} u` }); continue; }
      const segs = primitiveSegs(r, r0);
      if (!segs) continue;
      const cand = { ...sp, segs, start: segs[0].p[0] };
      // a primitive that does not even share the outline's box is not this shape (and
      // a degenerate fit, such as a huge circle through a sliver, is not measured at all)
      const bA = spBox(r0), bB = spBox(cand), off = Math.max(...bA.map((v, k) => Math.abs(v - bB[k])));
      if (!(off <= S.maxDev * u)) { record(ctx, { pass: P, op: `${r.kind} reconstruction`, el: e.idx, sub: i, accepted: false, reason: `the ${r.kind} does not fit the outline's box (off by ${(off / u).toFixed(1)} u)` }); continue; }
      if (segs.length >= sp.segs.length && !(segs.some((g) => g.t === 'A') && !sp.segs.every((g) => g.t === 'A')) && hausdorffU(r0, cand, u) < 0.1) continue;   // already this primitive
      const { evidence, why } = primitiveEvidence(ctx, e, r0, cand, r.kind, primSize(r));
      const label = `${r.kind}${r.common ? ` (common radius of ${it.repeats} repeated circles)` : ''}: deviation ${evidence.hausdorff.toFixed(2)} u, area ${(evidence.areaError * 100).toFixed(2)}%, perimeter ${(evidence.perimeterError * 100).toFixed(2)}%`;
      if (why) { record(ctx, { pass: P, op: `${r.kind} reconstruction`, el: e.idx, sub: i, accepted: false, label, reason: why, evidence }); continue; }
      // exact already (only the path data changes): normalization, not a repair
      const cls = evidence.hausdorff <= 0.1 ? [OPTIMIZATION, 'path normalization'] : [REPAIR, 'primitive reconstruction'];
      if (attempt(ctx, P, `${r.kind} reconstruction`, e, [{ subpaths: replaceSub(e.subpaths, i, cand), cls, supersedes: true, allowMore: true, evidence, label, geom: [{ cur: sp, cand, maxDev: S.maxDev }], focus: subBox(e, sp) }], { sub: i })) { done = true; break; }
    }
    if (done) continue;
    // symmetry correction: only when the measured mirror deviation is small (below 0.5 %
    // of the size: a slip of the hand, not a design) and above noise
    const si = ctx.info[e.idx].subs[i], sym = si.sym;
    if (S.symmetry && sym) {
      const axis = sym.vertical.deviation <= sym.horizontal.deviation ? 'vertical' : 'horizontal';
      const sm = sym[axis];
      if (sm.deviation <= 0.005 * sym.size && sm.deviation > 0.15 * u) {
        const cur = e.subpaths[i];
        const segs = symmetrize(cur, axis, sm.axis, u, S);
        if (segs) {
          const cand = { ...cur, segs };
          attempt(ctx, P, 'symmetry correction', e, [{ subpaths: replaceSub(e.subpaths, i, cand), label: `${axis} mirror deviation ${(sm.deviation / u).toFixed(2)} u`, geom: [{ cur, cand, maxDev: S.maxDev }], focus: subBox(e, cur) }], { sub: i });
        }
      }
    }
  }
}
const hausdorffU = (a, b, u) => curveDistance(a, b, u) / u;
function primitiveSegs(r, sp) {
  const ccw = polyArea(sampleNative(sp, spSize(sp) / 64).pts) < 0;       // y-down: negative = counter-clockwise on screen
  const sweep = ccw ? 0 : 1;
  if (r.kind === 'circle' || r.kind === 'ellipse') {
    const { cx, cy } = r.params, rx = r.kind === 'circle' ? r.params.r : r.params.rx, ry = r.kind === 'circle' ? r.params.r : r.params.ry;
    let P = [[cx + rx, cy], [cx, cy + ry], [cx - rx, cy], [cx, cy - ry]];
    if (ccw) P = [P[0], P[3], P[2], P[1]];
    // two half arcs: the shortest exact circle / ellipse in path data
    return [{ t: 'A', p: [P[0], P[2]], a: { rx, ry, rot: 0, large: 0, sweep } }, { t: 'A', p: [P[2], P[0]], a: { rx, ry, rot: 0, large: 0, sweep } }];
  }
  if (r.kind === 'rounded-rectangle') {
    const { x, y, w, h, r: R } = r.params;
    const a = (p0, p1) => ({ t: 'A', p: [p0, p1], a: { rx: R, ry: R, rot: 0, large: 0, sweep: 1 } }), l = (p0, p1) => ({ t: 'L', p: [p0, p1] });
    const Q = [[x + R, y], [x + w - R, y], [x + w, y + R], [x + w, y + h - R], [x + w - R, y + h], [x + R, y + h], [x, y + h - R], [x, y + R]];
    let segs = [l(Q[0], Q[1]), a(Q[1], Q[2]), l(Q[2], Q[3]), a(Q[3], Q[4]), l(Q[4], Q[5]), a(Q[5], Q[6]), l(Q[6], Q[7]), a(Q[7], Q[0])];
    if (ccw) segs = segs.reverse().map((g) => ({ ...g, p: [g.p[1], g.p[0]], ...(g.a ? { a: { ...g.a, sweep: 0 } } : {}) }));
    return segs;
  }
  const V = r.params.vertices;
  if (!V) return null;
  return V.map((v, k) => ({ t: 'L', p: [v.slice(), V[(k + 1) % V.length].slice()] }));
}
function symmetrize(sp, axis, c, u, S) {
  const P = sampleNative(sp, 0.3 * u).pts;
  const M = P.map((p) => (axis === 'vertical' ? [2 * c - p[0], p[1]] : [p[0], 2 * c - p[1]]));
  // average every point with the nearest point of the mirrored outline
  const near = pointGrid(M, Math.max(u, spSize(sp) / 64));
  const avg = P.map((p) => mul(add(p, M[near(p)]), 0.5));
  const n = sp.segs.length, cornersIdx = [];
  const seg = sampleNative(sp, 0.3 * u).seg;
  for (let k = 0; k < n; k++) if (turnDeg(tanOut(sp.segs[(k - 1 + n) % n]), tanIn(sp.segs[k])) > S.cornerAngle) cornersIdx.push(seg.indexOf(k));
  const cut = cornersIdx.length ? cornersIdx.filter((x) => x >= 0) : [0];
  const out = [];
  for (let c2 = 0; c2 < cut.length; c2++) {
    const a = cut[c2], b = c2 + 1 < cut.length ? cut[c2 + 1] : cut[0] + avg.length;
    const run = [];
    for (let k = a; k <= b; k++) run.push(avg[k % avg.length]);
    if (run.length < 3) continue;
    const t1 = norm(sub(run[Math.min(2, run.length - 1)], run[0])), t2 = norm(sub(run[Math.max(0, run.length - 3)], run[run.length - 1]));
    out.push(...fitStretch(run, t1, t2, S.curve * u).segs);
  }
  if (!out.length) return null;
  relink(out, true);
  return out;
}

// ---------------------------------------------------------------- Pass 8
// Topology validation against the state after structural cleanup.
export function passTopology(ctx, ref) {
  const P = 'topology validation';
  for (const e of ctx.doc.elements) {
    const r = ref[e.idx];
    if (!e.editable || e.removed || r.removed || e.subpaths === r.subpaths) continue;
    const u = lu(ctx, e);
    const a = topology(r.subpaths, e.rule, u), b = topology(e.subpaths, e.rule, u);
    let bad = null;
    if (a.signature !== b.signature) bad = `contours ${a.contours}->${b.contours}, holes ${a.holes}->${b.holes}, components ${a.components}->${b.components}`;
    else if (e.fill.kind !== 'none') {
      const ia = r.subpaths.reduce((s, sp) => s + (sp.closed ? selfX(sp, u) : 0), 0), ib = e.subpaths.reduce((s, sp) => s + (sp.closed ? selfX(sp, u) : 0), 0);
      if (ib > ia) bad = `self-intersections ${ia}->${ib}`;
    }
    if (bad) { e.subpaths = r.subpaths; dropChanges(ctx, e.idx); record(ctx, { pass: P, op: 'topology rollback', el: e.idx, accepted: false, reason: bad }); }
  }
}
import { selfIntersections } from './geom.js';
const selfX = (sp, u) => selfIntersections(polyOf(sp, 0.25 * u), 50);

// ---------------------------------------------------------------- Pass 9
// Visual validation of the whole artwork; objects whose own region changed too much
// are rolled back (only them), then the global error must be within limits.
export function passVisual(ctx, ref) {
  const P = 'visual validation', S = ctx.S;
  const changed = ctx.doc.elements.filter((e) => e.editable && (e.subpaths !== ref[e.idx].subpaths || e.removed !== ref[e.idx].removed));
  const errs = [];
  for (const e of changed) {
    if (e.removed) continue;
    const orig = ref[e.idx].subpaths;
    const bad = (r) => r.share > S.regionMax * 1.5 || r.solid > S.maxSolid * 2;
    if (orig.length === e.subpaths.length && e.subpaths.length > 1) {
      // judge every changed contour where it is (large elements span many objects)
      e.subpaths.forEach((sp, i) => {
        if (sp === orig[i]) return;
        const r = regionCheck(ctx, e, e.subpaths, unionBox(subBox(e, sp), subBox(e, orig[i])));
        errs.push({ e, i, share: r.share, solid: r.solid });
        if (bad(r)) {
          e.subpaths = replaceSub(e.subpaths, i, orig[i]);
          dropChanges(ctx, e.idx, i);
          record(ctx, { pass: P, op: 'contour rollback', el: e.idx, sub: i, accepted: false, reason: `contour region error ${(r.share * 100).toFixed(2)}% after all passes` });
        }
      });
    } else {
      const r = regionCheck(ctx, e, e.subpaths, unionBox(boxOf(e, e.subpaths), boxOf(e, orig)));
      errs.push({ e, share: r.share, solid: r.solid });
      if (bad(r)) { e.subpaths = orig; dropChanges(ctx, e.idx); record(ctx, { pass: P, op: 'object rollback', el: e.idx, accepted: false, reason: `object error ${(r.share * 100).toFixed(2)}% (${r.solid} px spot) after all passes` }); }
    }
  }
  let g = globalCheck(ctx);
  errs.sort((a, b) => b.share - a.share);
  while ((g.visibleShare > S.globalMax || g.solid > S.maxSolid * 4) && errs.length) {
    const { e, i } = errs.shift();
    if (i != null) {
      if (e.subpaths[i] === ref[e.idx].subpaths[i] || e.subpaths.length !== ref[e.idx].subpaths.length) continue;
      e.subpaths = replaceSub(e.subpaths, i, ref[e.idx].subpaths[i]);
      dropChanges(ctx, e.idx, i);
    } else {
      if (e.subpaths === ref[e.idx].subpaths) continue;
      e.subpaths = ref[e.idx].subpaths;
      dropChanges(ctx, e.idx);
    }
    record(ctx, { pass: P, op: 'object rollback', el: e.idx, sub: i ?? null, accepted: false, reason: `global visible difference ${(g.visibleShare * 100).toFixed(3)}% above ${(S.globalMax * 100).toFixed(3)}%` });
    g = globalCheck(ctx);
  }
  record(ctx, { pass: P, op: 'global check', accepted: g.visibleShare <= S.globalMax, reason: `pixel difference ${(g.pixelShare * 100).toFixed(3)}%, mean ΔE ${g.mean.toFixed(3)}, structural ${(g.structural * 100).toFixed(3)}%` });
  ctx.final = g;
}

// ---------------------------------------------------------------- Pass 10
// Precision engine, path merging, optional transform flattening.
export function passFinal(ctx) {
  const P = 'final optimization', S = ctx.S;
  const { doc } = ctx;
  // transform flattening (independent option)
  if (S.flattenTransforms) flattenTransforms(ctx);
  // merge neighbouring paths with identical attributes
  if (S.mergePaths) {
    const list = doc.elements.filter((e) => e.tag === 'path' && editable(ctx, e));
    for (let k = 0; k + 1 < list.length; k++) {
      const a = list[k], b = list[k + 1];
      if (a.removed || b.removed || a.node.parent !== b.node.parent || b.idx !== a.idx + 1) continue;
      const sib = a.node.parent.children.filter((c) => c.type === 'el');
      if (sib.indexOf(b.node) !== sib.indexOf(a.node) + 1) continue;
      const attrsA = a.node.attrs.filter(([k2]) => k2 !== 'd').map((x) => x.join('=')).sort().join('|'), attrsB = b.node.attrs.filter(([k2]) => k2 !== 'd').map((x) => x.join('=')).sort().join('|');
      if (attrsA !== attrsB || getAttr(a.node, 'id') || getAttr(b.node, 'id') || getAttr(a.node, 'transform') || e_hasRefs(a) || e_hasRefs(b)) continue;
      const merged = [...a.subpaths, ...b.subpaths];
      const saved = b.subpaths;
      b.removed = true;
      const ok = attempt(ctx, P, 'merge paths', a, [{ subpaths: merged, topologyChange: true, label: 'same style, drawn one after the other', focus: unionBox(boxOf(a, a.subpaths), boxOf(b, saved)) }]);
      if (!ok) b.removed = false;
      else { list[k + 1] = a; (ctx.merged ||= {})[a.idx] = [...(ctx.merged[a.idx] || []), b.idx, ...(ctx.merged[b.idx] || [])]; }   // keep merging into a; remember the partners
    }
  }
  // precision: the fewest decimals whose rounding error stays invisible
  // Every decimal count is validated on the exact geometry that will be written (the
  // path text parsed back, in both output styles): rounding arc radii and endpoints can
  // move a whole outline, and export-time rounding was never rendered before.
  let rejectedDigits = 0;
  for (const e of doc.elements) {
    if (!e.editable || e.removed || e.tag !== 'path' && e.tag !== 'polygon' && e.tag !== 'polyline') continue;
    if (e.subpaths === e.orig) continue;                          // unchanged: written exactly as it was
    const u = lu(ctx, e), tolP = 0.05 * u;
    const fixed = S.precision === 'adaptive' ? null : +S.precision;
    const start = fixed ?? Math.max(0, Math.min(6, Math.ceil(-Math.log10(tolP))));
    const box = boxOf(e, e.subpaths);
    let digits = 8;
    for (let d = start; d <= 8; d++) {
      const written = e.tag === 'path' ? [false, true].map((minify) => parsePath(writePath(e.subpaths, d, { minify })).subpaths) : [roundSubpaths(e.subpaths, d)];
      if (!written.every((w) => precisionOk(e.subpaths, w, fixed != null && d === fixed ? Math.max(tolP, 0.5 * 10 ** -fixed * 1.5) : tolP))) continue;
      if (written.every((w) => { const v = regionCheck(ctx, e, w, box); return v.ok && v.solid === 0; })) { digits = d; break; }
      rejectedDigits++;
    }
    e.digits = digits;
    noteChange(ctx, { el: e.idx, op: 'precision', pass: P });
  }
  record(ctx, { pass: P, op: 'precision', accepted: true, reason: `${S.precision === 'adaptive' ? 'adaptive decimals per element' : S.precision + ' decimals'}, each validated on the written geometry (${rejectedDigits} rounding(s) rejected as visible)` });
}
function e_hasRefs(e) { return (e.clips && e.clips.length) || (e.masks && e.masks.length) || e.fill.kind === 'gradient' || e.fill.kind === 'pattern'; }
function precisionOk(a, b, tol) {
  // a different structure after re-parsing (e.g. a zero-length closing segment dropped by Z)
  // is judged by the render check alone
  if (a.length !== b.length || a.some((sp, i) => sp.segs.length !== b[i].segs.length || sp.segs.some((g, k) => g.t !== b[i].segs[k].t))) return true;
  for (let i = 0; i < a.length; i++) for (let k = 0; k < a[i].segs.length; k++) {
    const s = a[i].segs[k], r = b[i].segs[k];
    for (let j = 0; j < s.p.length; j++) if (dist(s.p[j], r.p[j]) > tol) return false;
    if (s.t === 'A') {
      // a rounded arc must keep its shape (tiny arcs are sensitive)
      if (dist(r.p[0], r.p[1]) < 1e-12 && dist(s.p[0], s.p[1]) > 0) return false;
      if (Math.abs(r.a.rx - s.a.rx) > tol || Math.abs(r.a.ry - s.a.ry) > tol) return false;
    }
  }
  return true;
}

// Only where it is exact: solid fills (or none), uniform scale when stroked, no clip /
// mask / pattern / gradient in user space, no nested group state that would change.
function flattenTransforms(ctx) {
  const P = 'final optimization';
  for (const e of ctx.doc.elements) {
    if (e.removed || !['path', 'polygon', 'polyline', 'rect', 'circle', 'ellipse', 'line'].includes(e.tag)) continue;
    const own = getAttr(e.node, 'transform');
    if (!own) continue;
    const m = parseOwn(own), inv = m && invert(m);
    const parentCtm = inv ? mult(e.ctm, inv) : e.ctm;
    let why = null;
    if (e.locked) why = `protected element: ${e.support.reasons[0].text}`;
    else if (!m || !inv) why = 'unreadable or singular transform';
    else if (e.stroke.kind !== 'none' && e.style['stroke-dasharray'] && e.style['stroke-dasharray'] !== 'none') why = 'dash lengths would change';
    else if (touchesUncertain(ctx.doc, boxOf(e, e.subpaths), e.idx)) why = 'touches a region the renderer cannot validate';
    else if (e.fill.kind === 'gradient' || e.fill.kind === 'pattern' || e.stroke.kind === 'gradient' || e.stroke.kind === 'pattern') why = 'gradient / pattern would be distorted';
    else if ((e.clips && e.clips.length) || (e.masks && e.masks.length)) why = 'clip / mask is in the same coordinate system';
    else if (e.stroke.kind !== 'none' && !isUniform(m)) why = 'non-uniform scale changes the stroke';
    if (why) { record(ctx, { pass: P, op: 'flatten transform', el: e.idx, accepted: false, reason: why }); continue; }
    const tf = (q) => apply(m, q), uni = isUniform(m), sc = scaleOf(m), det = m[0] * m[3] - m[1] * m[2];
    const rot = (Math.atan2(m[1], m[0]) * 180) / Math.PI;
    const subs = e.subpaths.map((sp) => ({ ...sp, start: sp.start && tf(sp.start), segs: sp.segs.flatMap((g) => {
      if (g.t === 'A' && !uni) return toCubicsSegs(g).map((c) => ({ t: 'C', p: c.p.map(tf) }));
      return [{ ...g, p: g.p.map(tf), ...(g.a ? { a: { ...g.a, rx: g.a.rx * sc, ry: g.a.ry * sc, rot: g.a.rot + rot, sweep: det < 0 ? 1 - g.a.sweep : g.a.sweep } } : {}) }];
    }) }));
    const saved = { subpaths: e.subpaths, ctm: e.ctm, scale: e.scale, strokeWidth: e.strokeWidth };
    e.ctm = parentCtm; e.scale = scaleOf(parentCtm); e.strokeWidth = e.strokeWidth * sc;
    const v = regionCheck(ctx, e, subs, null);
    if (v.ok) { e.subpaths = subs; e.flat = { strokeWidth: e.strokeWidth, scale: sc }; record(ctx, { pass: P, op: 'flatten transform', el: e.idx, accepted: true, reason: `transform applied to the coordinates (visual deviation ${(v.share * 100).toFixed(2)}%)` }); }
    else { Object.assign(e, saved); record(ctx, { pass: P, op: 'flatten transform', el: e.idx, accepted: false, reason: 'visual deviation after flattening' }); }
  }
}
import { parseTransform } from './matrix.js';
import { toCubics as toCubicsSegs } from './pathdata.js';
const parseOwn = (s) => parseTransform(s);
