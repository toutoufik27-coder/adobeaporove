// SVG Geometry Restoration & Professional Reconstruction Engine — core.
// Every modification follows: Analyze -> Generate Candidate -> Compare With Original
// -> Calculate Error -> Accept / Reject. Rejected candidates leave the path as it was.
import { makeView, cropView, render, alphaBoxes, elementLayers, fillPolys, rasterPolys } from './raster.js';
import { compare, labImage, visualScore } from './metrics.js';
import { elementBox } from './model.js';
import { apply } from './matrix.js';
import { topology, sampleNative, polyOf, selfIntersections } from './features.js';
import { touchesUncertain, UNSUPPORTED } from './capability.js';
import { renderViewFor } from './viewport.js';

export const MODES = {
  safe:         { simplify: 0.3, curve: 0.35, maxDev: 0.7, cornerAngle: 20, shapeSensitivity: 0.97, micro: 0.6, precision: 'adaptive', symmetry: false, topologyRepair: true, strokePreservation: true,  flattenTransforms: false, removeHidden: true, mergePaths: false, minConfidence: 0.95, regionMax: 0.005, maxSolid: 0, globalMax: 0.0005, hiddenFactor: 2 },
  balanced:     { simplify: 0.5, curve: 0.6,  maxDev: 1.1, cornerAngle: 25, shapeSensitivity: 0.94, micro: 1.0, precision: 'adaptive', symmetry: false, topologyRepair: true, strokePreservation: true,  flattenTransforms: false, removeHidden: true, mergePaths: false, minConfidence: 0.9,  regionMax: 0.01,  maxSolid: 0, globalMax: 0.001,  hiddenFactor: 3 },
  professional: { simplify: 0.8, curve: 0.9,  maxDev: 1.6, cornerAngle: 30, shapeSensitivity: 0.9,  micro: 1.5, precision: 'adaptive', symmetry: true,  topologyRepair: true, strokePreservation: false, flattenTransforms: false, removeHidden: true, mergePaths: true,  minConfidence: 0.85, regionMax: 0.015, maxSolid: 2, globalMax: 0.002,  hiddenFactor: 4 },
  aggressive:   { simplify: 1.2, curve: 1.4,  maxDev: 2.4, cornerAngle: 35, shapeSensitivity: 0.86, micro: 2.2, precision: 'adaptive', symmetry: true,  topologyRepair: true, strokePreservation: false, flattenTransforms: false, removeHidden: true, mergePaths: true,  minConfidence: 0.8,  regionMax: 0.025, maxSolid: 4, globalMax: 0.0035, hiddenFactor: 5 },
};
export const settingsFor = (mode, over = {}) => ({ mode, ...MODES[mode || 'balanced'], ...over });

export function createContext(doc, S, src = null) {
  const size = Math.max(doc.viewBox[2], doc.viewBox[3]), u = size / 1000;
  // exactly what a browser shows (preserveAspectRatio, content outside the viewBox)
  const view = renderViewFor(doc, S.raster || 700).view;
  resetDoc(doc);
  const origImg = render(doc, view, { orig: true });
  const ctx = {
    doc, S, u, view, origImg, origLab: labImage(origImg, view.W * view.H), src,
    log: [], counts: {}, removedNodes: {}, rejectedCount: 0, acceptedCount: 0, history: [], info: [], crops: new Map(), t0: Date.now(),
  };
  refreshOcclusion(ctx);
  return ctx;
}

// back to the original geometry (the model keeps the original immutable)
export function resetDoc(doc) {
  for (const e of doc.elements) {
    if (!e.origCtm) { e.origCtm = e.ctm; e.origScale = e.scale; e.origStrokeWidth = e.strokeWidth; }
    e.subpaths = e.orig || []; e.removed = false; e.base = null; e.baseCtm = null; e.ctm = e.origCtm; e.scale = e.origScale; e.strokeWidth = e.origStrokeWidth; e.flat = null; e.digits = undefined;
  }
}

// ---- occlusion: index of the top-most opaque element at each pixel.
// Only elements the renderer draws exactly can hide anything: a filter, pattern, text
// or image is treated as transparent, so nothing under it is ever judged hidden.
const occluder = (e) => (e.removed || (e.support && e.support.level === UNSUPPORTED) ? { ...e, render: false } : e);
export function refreshOcclusion(ctx) {
  const { doc, view } = ctx, N = view.W * view.H, top = new Int32Array(N).fill(-1);
  const boxes = alphaBoxes({ ...doc, elements: doc.elements.map(occluder) }, view);
  boxes.forEach((b, i) => {
    if (!b) return;
    for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) if (b.data[y * b.w + x] >= 0.999) top[(b.y0 + y) * view.W + b.x0 + x] = i;
  });
  ctx.top = top;
}
// true when the point (element-local coordinates) is covered by an opaque shape above e
export function hiddenAt(ctx, e, q) {
  const { view, top } = ctx, r = apply(e.ctm, q);
  const x = Math.round((r[0] - view.x) * view.k), y = Math.round((r[1] - view.y) * view.k);
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const X = x + dx, Y = y + dy;
    if (X < 0 || Y < 0 || X >= view.W || Y >= view.H) return false;
    if (top[Y * view.W + X] <= e.idx) return false;
  }
  return true;
}
// Seen amount of every subpath: its coverage times the light that passes through
// all shapes above it (anti-aliased edges and transparency included).
export function subpathVisibility(ctx) {
  const { doc, view } = ctx, N = view.W * view.H, T = new Float32Array(N).fill(1);
  const boxes = alphaBoxes({ ...doc, elements: doc.elements.map(occluder) }, view);
  const out = new Map();
  for (let i = doc.elements.length - 1; i >= 0; i--) {
    const e = doc.elements[i];
    if (!e.removed && e.subpaths.length) {
      out.set(e, e.subpaths.map((sp) => {
        const r = rasterPolys(fillPolys([sp], e.ctm, view), e.rule, view);
        let vis = 0, tot = 0;
        if (r) for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) { const c = r.data[y * r.w + x]; if (!c) continue; tot += c; vis += c * T[(r.y0 + y) * view.W + r.x0 + x]; }
        return { visible: vis, total: tot };
      }));
    }
    const b = boxes[i];
    if (b) for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) { const p = (b.y0 + y) * view.W + b.x0 + x; T[p] *= 1 - b.data[y * b.w + x]; }
  }
  return out;
}
// visible pixels of one subpath (fill coverage not covered by opaque shapes above)
export function visiblePixels(ctx, e, sp) {
  const { view, top } = ctx;
  const r = rasterPolys(fillPolys([sp], e.ctm, view), e.rule, view);
  if (!r) return { visible: 0, total: 0 };
  let vis = 0, tot = 0;
  for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) { const c = r.data[y * r.w + x]; if (c < 0.02) continue; tot += c; if (top[(r.y0 + y) * view.W + r.x0 + x] <= e.idx) vis += c; }
  return { visible: vis, total: tot };
}

export const boxOf = (e, subs) => {
  if (subs === e.subpaths) { if (e._boxSubs !== subs) { e._box = elementBox(e, subs); e._boxSubs = subs; } return e._box; }
  return elementBox(e, subs);
};
const origBox = (e) => { if (e.base) return elementBox({ ...e, ctm: e.baseCtm || e.ctm }, e.base); if (!e._obox) e._obox = elementBox({ ...e, ctm: e.origCtm || e.ctm }, e.orig); return e._obox; };

// After an intended change (restoration to the source image), the corrected geometry
// becomes the reference that the following passes must preserve.
export function rebase(ctx) {
  for (const e of ctx.doc.elements) { e.base = e.removed ? [] : e.subpaths; e.baseCtm = e.ctm; }
  ctx.origImg = render(ctx.doc, ctx.view, { orig: true });
  ctx.origLab = labImage(ctx.origImg, ctx.view.W * ctx.view.H);
  ctx.crops.clear();
}
const unionBox = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
export const subBox = (e, sp) => elementBox(e, [sp]);

// ---- region-based visual validation: render the neighbourhood of the change from
// the original document, the current state and the candidate, at 2x detail.
export function regionCheck(ctx, e, cand, focus) {
  const { doc, view, S, u } = ctx;
  let box = focus;
  if (!box || !isFinite(box[0])) { const a = boxOf(e, e.subpaths), b = cand.length ? boxOf(e, cand) : a; box = unionBox(a, b); }
  if (!isFinite(box[0])) return { ok: true, share: 0, solid: 0, mean: 0, badPixels: 0 };
  let crop = cropView(view, box, 3 * u + 2 / view.k, 2);
  if (crop.W * crop.H > 360000) crop = cropView(view, box, 3 * u + 2 / view.k, Math.max(0.5, 2 * Math.sqrt(360000 / (crop.W * crop.H))));
  const key = `${crop.x.toFixed(4)},${crop.y.toFixed(4)},${crop.W},${crop.H},${crop.k.toFixed(6)}`;
  let ref = ctx.crops.get(key);
  if (!ref) {
    const img = render(doc, crop, { orig: true, box: (x) => origBox(x) });
    ref = { img, lab: labImage(img, crop.W * crop.H) };
    if (ctx.crops.size > 400) ctx.crops.clear();
    ctx.crops.set(key, ref);
  }
  const cur = (x) => (x.removed ? null : x.subpaths);
  const curImg = render(doc, crop, { geom: cur, box: (x, s) => boxOf(x, s) });
  const candImg = render(doc, crop, { geom: (x) => (x === e ? cand : cur(x)), box: (x, s) => boxOf(x, s) });
  // edges may move by the mode's allowed deviation (in crop pixels), never more
  const radius = Math.max(1, Math.min(4, Math.round(S.maxDev * u * crop.k)));
  const rc = compare(ref.img, candImg, crop, { labA: ref.lab, radius }), rcur = compare(ref.img, curImg, crop, { labA: ref.lab, radius });
  // object area in this region (its own coverage), so errors are relative to the object
  let area = 0;
  for (const L of elementLayers({ ...e, subpaths: e.subpaths.length ? e.subpaths : e.orig }, doc, crop)) for (const v of L.box.data) area += v;
  area = Math.max(area, 40 * crop.k * crop.k * u * u, 30);
  const share = rc.visiblePixels / area, curShare = rcur.visiblePixels / area;
  const within = share <= S.regionMax && rc.solid <= S.maxSolid;
  const notWorse = rc.visiblePixels <= rcur.visiblePixels && rc.solid <= rcur.solid;
  return { ok: within || notWorse, share, curShare, solid: rc.solid, mean: rc.mean, badPixels: rc.visiblePixels, strictShare: rc.badPixels / area, zoom: crop.k / view.k };
}

// ---- geometric checks between the current and the candidate subpath (1:1)
export function geometryCheck(ctx, e, cur, cand, o = {}) {
  const u = ctx.u / (e.scale || 1), maxDev = (o.maxDev ?? ctx.S.maxDev) * u;
  if (cur.closed !== cand.closed) return { ok: false, reason: 'closed / open state changed' };
  const A = sampleNative(cur, 0.4 * u).pts, B = sampleNative(cand, 0.4 * u).pts;
  const hid = o.hidden || (() => false), factor = o.hiddenFactor ?? ctx.S.hiddenFactor;
  const dev = hausdorffAware(A, B, hid, maxDev, factor);
  if (dev === null) return { ok: false, reason: `outline moved more than ${(maxDev * (e.scale || 1) / ctx.u * 0.1).toFixed(2)}% of the artwork` };
  if (cur.closed && e.fill.kind !== 'none') {
    const pa = polyOf(cur, 0.25 * u), pb = polyOf(cand, 0.25 * u);
    const ia = selfIntersections(pa, 50), ib = selfIntersections(pb, 50);
    if (ib > ia) return { ok: false, reason: `creates self-intersections (${ia} -> ${ib})` };
  }
  return { ok: true, dev };
}
function hausdorffAware(A, B, hidden, maxDev, factor) {
  const lim = maxDev * factor, cell = Math.max(lim, 1e-9), grid = new Map();
  const key = (x, y) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
  const index = (Q) => { grid.clear(); for (const q of Q) { const k = key(q[0], q[1]); (grid.get(k) || grid.set(k, []).get(k)).push(q); } };
  const nearest = (p) => {
    const gx = Math.floor(p[0] / cell), gy = Math.floor(p[1] / cell);
    let best = Infinity;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) { const arr = grid.get(`${gx + dx},${gy + dy}`); if (arr) for (const q of arr) { const d = Math.hypot(p[0] - q[0], p[1] - q[1]); if (d < best) best = d; } }
    return best;
  };
  let worst = 0;
  index(B);
  for (const p of A) { const d = nearest(p); if (d > (hidden(p) ? lim : maxDev)) return null; if (d > worst) worst = d; }
  index(A);
  for (const p of B) { const d = nearest(p); if (d > (hidden(p) ? lim : maxDev)) return null; if (d > worst) worst = d; }
  return worst;
}

// ---- logging
const MAX_LOG = 4000;
export function record(ctx, entry) {
  if (entry.accepted) { ctx.acceptedCount++; if (entry.nodes) ctx.removedNodes[entry.op] = (ctx.removedNodes[entry.op] || 0) + entry.nodes[0] - entry.nodes[1]; }
  else if (entry.accepted === false) ctx.rejectedCount++;
  const k = `${entry.op}|${entry.accepted ? 'accepted' : 'rejected'}`;
  ctx.counts[k] = (ctx.counts[k] || 0) + 1;
  if (ctx.log.length < MAX_LOG) ctx.log.push(entry);
}
const nodesOf = (subs) => subs.reduce((n, s) => n + s.segs.length + (s.closed ? 0 : 1), 0);

// The part of the artwork a candidate changes: the boxes (strokes included) of every
// subpath that is new, removed or replaced.
export function changeBox(e, cand) {
  const a = new Set(e.subpaths), b = new Set(cand);
  let box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const sp of e.subpaths) if (!b.has(sp)) box = unionBox(box, elementBox(e, [sp]));
  for (const sp of cand) if (!a.has(sp)) box = unionBox(box, elementBox(e, [sp]));
  return box;
}
export function featureSafety(ctx, e, cand) {
  if (e.locked) return `protected element: ${e.support.reasons[0].text}`;
  if (!e.editable) return `not editable: ${e.reason}`;
  const box = changeBox(e, cand);
  const r = touchesUncertain(ctx.doc, box, e.idx);
  return r ? `change touches a region the renderer cannot validate (${r.reason})` : null;
}

// Candidate system: candidates are tried simplest first (fewest nodes); the first that
// passes every constraint is applied. Each candidate carries its own confidence.
// cands: [{ subpaths, confidence, label, geom: [{ i, cur, cand, maxDev?, hidden? }] | null, focus, topologyChange }]
export function attempt(ctx, pass, op, e, cands, extra = {}) {
  const S = ctx.S;
  const now = nodesOf(e.subpaths);
  cands = cands.filter(Boolean).filter((c) => c.allowMore || nodesOf(c.subpaths) <= now).sort((a, b) => nodesOf(a.subpaths) - nodesOf(b.subpaths));
  for (const c of cands) {
    const base = { pass, op, el: e.idx, id: e.id || null, sub: extra.sub ?? null, label: c.label || op, confidence: +c.confidence.toFixed(3), nodes: [nodesOf(e.subpaths), nodesOf(c.subpaths)] };
    // feature safety: a protected element is never modified, and no change may touch a
    // region the renderer cannot draw exactly (the validation there would be blind)
    const unsafe = featureSafety(ctx, e, c.subpaths);
    if (unsafe) { record(ctx, { ...base, accepted: false, reason: unsafe }); return null; }
    if (c.confidence < S.minConfidence) { record(ctx, { ...base, accepted: false, reason: `confidence ${(c.confidence * 100).toFixed(0)}% is below ${(S.minConfidence * 100).toFixed(0)}%` }); continue; }
    // topology
    if (!c.topologyChange) {
      const t0 = topology(e.subpaths, e.rule, ctx.u / (e.scale || 1)), t1 = topology(c.subpaths, e.rule, ctx.u / (e.scale || 1));
      if (t0.signature !== t1.signature) { record(ctx, { ...base, accepted: false, reason: 'topology would change (contours / holes / nesting)' }); continue; }
    }
    // gradient mapped to the object's box: the box must not move
    if ((e.fill.kind === 'gradient' && e.fill.units !== 'userSpaceOnUse') || (e.stroke.kind === 'gradient' && e.stroke.units !== 'userSpaceOnUse')) {
      const a = boxOf(e, e.subpaths), b = c.subpaths.length ? boxOf(e, c.subpaths) : a;
      if (Math.max(...a.map((v, i) => Math.abs(v - b[i]))) > 0.1 * ctx.u) { record(ctx, { ...base, accepted: false, reason: 'would move the gradient (object bounding box changes)' }); continue; }
    }
    let gdev = 0, bad = null;
    for (const g of c.geom || []) {
      const r = geometryCheck(ctx, e, g.cur, g.cand, g);
      if (!r.ok) { bad = r.reason; break; }
      gdev = Math.max(gdev, r.dev || 0);
    }
    if (bad) { record(ctx, { ...base, accepted: false, reason: bad }); continue; }
    const v = regionCheck(ctx, e, c.subpaths, c.focus);
    const metrics = { deviation: +(gdev * (e.scale || 1) / ctx.u / 10).toFixed(3), regionError: +(v.share * 100).toFixed(3), solid: v.solid, meanDE: +v.mean.toFixed(3) };
    if (!v.ok) { record(ctx, { ...base, accepted: false, reason: `visual deviation ${(v.share * 100).toFixed(2)}% of the object${v.solid ? `, ${v.solid} px spot` : ''} exceeds tolerance`, metrics }); continue; }
    e.subpaths = c.subpaths;
    record(ctx, { ...base, accepted: true, reason: `visual deviation ${(v.share * 100).toFixed(2)}%`, metrics });
    return c;
  }
  return null;
}

// ---- history
export function snapshot(ctx, name) {
  const st = ctx.doc.elements.map((e) => ({ subpaths: e.subpaths, removed: e.removed, digits: e.digits, flat: e.flat || null, ctm: e.ctm }));
  ctx.history.push({ name, state: st, at: Date.now() - ctx.t0, nodes: countNodes(ctx.doc, st) });
}
export function restore(ctx, state) {
  ctx.doc.elements.forEach((e, i) => { const s = state[i]; e.subpaths = s.subpaths; e.removed = s.removed; e.digits = s.digits; e.flat = s.flat; e.ctm = s.ctm; });
}
export const countNodes = (doc, st) => doc.elements.reduce((n, e, i) => n + (st ? (st[i].removed ? 0 : nodesOf(st[i].subpaths)) : e.removed ? 0 : nodesOf(e.subpaths)), 0);

// global visual difference of the current state against the original
export function globalCheck(ctx, structural = true) {
  const img = render(ctx.doc, ctx.view, { geom: (x) => (x.removed ? null : x.subpaths) });
  const radius = Math.max(1, Math.min(3, Math.round(ctx.S.maxDev * ctx.u * ctx.view.k)));
  const r = compare(ctx.origImg, img, ctx.view, { labA: ctx.origLab, structural, radius });
  return { ...r, score: visualScore(r), img };
}
export { nodesOf, unionBox, origBox };
