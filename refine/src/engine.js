// SVG Geometry Restoration & Professional Reconstruction Engine — core.
// Every modification follows: Analyze -> Generate Candidate -> Compare With Original
// -> Calculate Error -> Accept / Reject. Rejected candidates leave the path as it was.
import { makeView, cropView, render, alphaBoxes, elementLayers, fillPolys, rasterPolys } from './raster.js';
import { compare, labImage, visualScore } from './metrics.js';
import { elementBox } from './model.js';
import { apply } from './matrix.js';
import { topology, sampleNative, polyOf, selfIntersections } from './features.js';
import { touchesUncertain, UNSUPPORTED } from './capability.js';
import { contourEvidence, geometryVerdict, margin } from './evidence.js';
import { classify, noteChange } from './changes.js';
import { renderViewFor } from './viewport.js';
import { ByteLRU } from './lru.js';
import { probe } from './memprobe.js';

export const MODES = {
  safe:         { simplify: 0.3, curve: 0.35, maxDev: 0.7, cornerAngle: 20, micro: 0.6, precision: 'adaptive', symmetry: false, topologyRepair: true, consistency: false, strokePreservation: true,  flattenTransforms: false, removeHidden: true, mergePaths: false, maxAreaError: 0.004, shapeMaxDev: 0.008, shapeSystematic: 0.004, shapeArea: 0.006, shapePerimeter: 0.006, regionMax: 0.005, maxSolid: 0, globalMax: 0.0005, hiddenFactor: 2 },
  balanced:     { simplify: 0.5, curve: 0.6,  maxDev: 1.1, cornerAngle: 25, micro: 1.0, precision: 'adaptive', symmetry: false, topologyRepair: true, consistency: false, strokePreservation: true,  flattenTransforms: false, removeHidden: true, mergePaths: false, maxAreaError: 0.008, shapeMaxDev: 0.012, shapeSystematic: 0.006, shapeArea: 0.01,  shapePerimeter: 0.01,  regionMax: 0.01,  maxSolid: 0, globalMax: 0.001,  hiddenFactor: 3 },
  professional: { simplify: 0.8, curve: 0.9,  maxDev: 1.6, cornerAngle: 30, micro: 1.5, precision: 'adaptive', symmetry: true,  topologyRepair: true, consistency: true, strokePreservation: false, flattenTransforms: false, removeHidden: true, mergePaths: true,  maxAreaError: 0.015, shapeMaxDev: 0.02,  shapeSystematic: 0.008, shapeArea: 0.015, shapePerimeter: 0.015, regionMax: 0.015, maxSolid: 2, globalMax: 0.002,  hiddenFactor: 4 },
  aggressive:   { simplify: 1.2, curve: 1.4,  maxDev: 2.4, cornerAngle: 35, micro: 2.2, precision: 'adaptive', symmetry: true,  topologyRepair: true, consistency: true, strokePreservation: false, flattenTransforms: false, removeHidden: true, mergePaths: true,  maxAreaError: 0.025, shapeMaxDev: 0.03,  shapeSystematic: 0.012, shapeArea: 0.025, shapePerimeter: 0.025, regionMax: 0.025, maxSolid: 4, globalMax: 0.0035, hiddenFactor: 5 },
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
    log: [], counts: {}, removedNodes: {}, rejectedCount: 0, acceptedCount: 0, history: [], info: [], crops: new ByteLRU(S.cacheBytes), t0: Date.now(),
  };
  refreshOcclusion(ctx);
  return ctx;
}

// back to the original geometry (the model keeps the original immutable)
export function resetDoc(doc) {
  for (const e of doc.elements) {
    if (!e.origCtm) { e.origCtm = e.ctm; e.origScale = e.scale; e.origStrokeWidth = e.strokeWidth; }
    e.subpaths = e.orig || []; e.removed = false; e.base = null; e.baseCtm = null; e.ctm = e.origCtm; e.scale = e.origScale; e.strokeWidth = e.origStrokeWidth; e.flat = null; e.digits = undefined; e.refSubs = null;
  }
}

// ---- occlusion: index of the top-most opaque element at each pixel.
// Only elements the renderer draws exactly can hide anything: a filter, pattern, text
// or image is treated as transparent, so nothing under it is ever judged hidden.
export const occluderOf = (e) => (e.removed || (e.support && e.support.level === UNSUPPORTED) ? { ...e, render: false } : e);
const occluder = occluderOf;
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
    ctx.crops.set(key, ref);
  }
  const cur = (x) => (x.removed ? null : x.subpaths);
  const curImg = render(doc, crop, { geom: cur, box: (x, s) => boxOf(x, s) });
  const candImg = render(doc, crop, { geom: (x) => (x === e ? cand : cur(x)), box: (x, s) => boxOf(x, s) });
  // edges may move by the mode's allowed deviation (in crop pixels), never more
  const radius = Math.max(1, Math.min(4, Math.round(S.maxDev * u * crop.k)));
  const rc = compare(ref.img, candImg, crop, { labA: ref.lab, radius }), rcur = compare(ref.img, curImg, crop, { labA: ref.lab, radius });
  probe(ctx, 'region check');
  // object area in this region (its own coverage), so errors are relative to the object
  let area = 0;
  for (const L of elementLayers({ ...e, subpaths: e.subpaths.length ? e.subpaths : e.orig }, doc, crop)) for (const v of L.box.data) area += v;
  area = Math.max(area, 40 * crop.k * crop.k * u * u, 30);
  const share = rc.visiblePixels / area, curShare = rcur.visiblePixels / area;
  // the same change at the scale of the whole artwork (the region is rendered at `zoom`)
  const zoom = crop.k / view.k, global = rc.visiblePixels / (zoom * zoom) / (view.W * view.H), curGlobal = rcur.visiblePixels / (zoom * zoom) / (view.W * view.H);
  const within = share <= S.regionMax && rc.solid <= S.maxSolid && global <= S.globalMax;
  const notWorse = rc.visiblePixels <= rcur.visiblePixels && rc.solid <= rcur.solid && global <= Math.max(S.globalMax, curGlobal);
  return { ok: within || notWorse, share, curShare, global, solid: rc.solid, mean: rc.mean, badPixels: rc.visiblePixels, strictPixels: rc.badPixels, strictShare: rc.badPixels / area, zoom };
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
  if (entry.accepted) { ctx.acceptedCount++; if (entry.nodes) ctx.removedNodes[entry.op] = (ctx.removedNodes[entry.op] || 0) + entry.nodes[0] - entry.nodes[1]; if (entry.el != null) noteChange(ctx, entry); }
  else if (entry.accepted === false) ctx.rejectedCount++;
  const k = `${entry.op}|${entry.accepted ? 'accepted' : entry.accepted === false ? 'rejected' : 'info'}`;
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
// passes every constraint is applied. The decision is made on measured evidence only:
// feature support, topology, geometric distance to the current contour and to the
// reference contour (so steps cannot add up), area change, and the local and global
// visual difference. A hand-written number is never a gate.
// cands: [{ subpaths, label, cls, geom: [{ cur, cand, maxDev?, hidden? }] | null, focus,
//           topologyChange, strict?, visual? }]
//   strict: the render must not change at all (certainly hidden geometry)
//   visual: 'tiny' judges a removal by its absolute size (a speck is its own object)
export function attempt(ctx, pass, op, e, cands, extra = {}) {
  const S = ctx.S;
  const now = nodesOf(e.subpaths);
  cands = cands.filter(Boolean).filter((c) => c.allowMore || nodesOf(c.subpaths) <= now).sort((a, b) => nodesOf(a.subpaths) - nodesOf(b.subpaths));
  for (const c of cands) {
    const base = { pass, op, el: e.idx, id: e.id || null, sub: extra.sub ?? null, label: c.label || op, cls: c.cls || classify(op), nodes: [nodesOf(e.subpaths), nodesOf(c.subpaths)], ...(c.supersedes ? { supersedes: true } : {}) };
    // feature safety: a protected element is never modified, and no change may touch a
    // region the renderer cannot draw exactly (the validation there would be blind)
    const unsafe = featureSafety(ctx, e, c.subpaths);
    if (unsafe) { record(ctx, { ...base, accepted: false, reason: unsafe, evidence: { featureSupport: e.support ? e.support.level : null } }); return null; }
    const evidence = { ...(c.evidence || {}), featureSupport: e.support ? e.support.level : 'SUPPORTED', topologyPreserved: true };
    // topology
    if (!c.topologyChange) {
      const t0 = topology(e.subpaths, e.rule, ctx.u / (e.scale || 1)), t1 = topology(c.subpaths, e.rule, ctx.u / (e.scale || 1));
      if (t0.signature !== t1.signature) { record(ctx, { ...base, accepted: false, reason: 'topology would change (contours / holes / nesting)', evidence: { ...evidence, topologyPreserved: false } }); continue; }
    } else evidence.topologyPreserved = false;
    // gradient mapped to the object's box: the box must not move
    if ((e.fill.kind === 'gradient' && e.fill.units !== 'userSpaceOnUse') || (e.stroke.kind === 'gradient' && e.stroke.units !== 'userSpaceOnUse')) {
      const a = boxOf(e, e.subpaths), b = c.subpaths.length ? boxOf(e, c.subpaths) : a;
      if (Math.max(...a.map((v, i) => Math.abs(v - b[i]))) > 0.1 * ctx.u) { record(ctx, { ...base, accepted: false, reason: 'would move the gradient (object bounding box changes)', evidence }); continue; }
    }
    const bad = geometryEvidence(ctx, e, c, evidence);
    if (bad) { record(ctx, { ...base, accepted: false, reason: bad, evidence }); continue; }
    const v = regionCheck(ctx, e, c.subpaths, c.focus);
    Object.assign(evidence, { localVisualError: +v.share.toFixed(5), globalVisualError: +v.global.toFixed(6), solid: v.solid, meanDE: +v.mean.toFixed(3) });
    let vbad = null;
    if (c.strict) { if (v.strictPixels || v.mean) vbad = `the render changes (${v.strictPixels} px): not certainly hidden`; }
    else if (c.visual === 'tiny') {
      const px = v.badPixels / (v.zoom * v.zoom), lim = Math.max(4, (S.micro * ctx.u * ctx.view.k) ** 2);
      if (px > lim || v.global > S.globalMax / 4) vbad = `removal changes ${px.toFixed(1)} px (limit ${lim.toFixed(1)} px)`;
    } else if (!v.ok) vbad = `visual deviation ${(v.share * 100).toFixed(2)}% of the object${v.solid ? `, ${v.solid} px spot` : ''} exceeds tolerance`;
    evidence.score = margin(evidence.geometry || null, S, { share: c.visual === 'tiny' || c.strict ? 0 : v.share, global: v.global });
    if (vbad) { record(ctx, { ...base, accepted: false, reason: vbad, evidence }); continue; }
    e.subpaths = c.subpaths;
    record(ctx, { ...base, accepted: true, reason: `visual deviation ${(v.share * 100).toFixed(2)}%`, evidence });
    return c;
  }
  return null;
}
// Geometry evidence of a candidate (fills evidence.geometry). Every changed contour is
// measured against the current contour (this step's own limit) and against the
// reference contour, the geometry after structural cleanup (the whole budget of the
// mode, so small steps cannot add up to a large drift). Returns the failed limit or null.
function geometryEvidence(ctx, e, c, evidence) {
  const S = ctx.S, ul = ctx.u / (e.scale || 1);
  let worst = null;
  for (const g of c.geom || []) {
    const r = geometryCheck(ctx, e, g.cur, g.cand, g);
    if (!r.ok) return r.reason;
    const i = e.subpaths.indexOf(g.cur), ref = e.refSubs && e.refSubs.length === e.subpaths.length && i >= 0 ? e.refSubs[i] : null;
    const budget = Math.max(S.maxDev, g.maxDev ?? S.maxDev);
    let drift = r.dev;
    if (ref && ref !== g.cur) {
      const d = geometryCheck(ctx, e, ref, g.cand, { maxDev: budget, hidden: g.hidden });
      if (!d.ok) return `${d.reason} (all steps together, from the original contour)`;
      drift = d.dev;
    }
    // hausdorff: the (hidden-aware) distance just measured; corners are compared only
    // where a decision depends on them (shape reconstruction)
    const ev = contourEvidence(ref || g.cur, g.cand, ul, S.cornerAngle, { hausdorff: drift / ul, corners: false });
    const hiddenPart = g.hidden && sampleNative(g.cand, 2 * ul).pts.some(g.hidden);
    const why = geometryVerdict({ ...ev, hausdorff: 0 }, S, { maxDev: budget, area: !hiddenPart && !g.noArea });
    if (why) return why;
    if (!worst || ev.hausdorff > worst.hausdorff) worst = ev;
  }
  if (worst) evidence.geometry = Object.fromEntries(Object.entries(worst).map(([k, v]) => [k, typeof v === 'number' ? +v.toFixed(4) : v]));
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
  probe(ctx, 'global check');
  return { ...r, score: visualScore(r), img };
}
export { nodesOf, unionBox, origBox };
