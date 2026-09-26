// Repeated parts of a symmetric drawing. Contours that are mirror images of each other
// (across the drawing's vertical axis, its horizontal axis, or both) are one part of the
// design drawn several times, like the four corner pieces of a frame. When at least
// three copies share one fill colour and one copy has another, the odd copy is a colour
// assignment error of the tracer: a vectorizer gives every region the nearest palette
// colour, and a copy that is lit a little lighter in the picture lands on the
// neighbouring colour. The odd copy is moved into an element of the majority colour.
//
// Evidence, all measured:
//   - mirror match: after the mirror, the copies are within max(2 u, 8 % of their size)
//     of each other (Hausdorff), and their boxes within max(2 u, 4 %)
//   - count: at least 3 copies agree, and they are at least 3/4 of the group
//   - every copy is in its own place: a group with two parts at the same place is a
//     stack of layers (an outline and its fill, a highlight), not a repetition, and is
//     left alone
//   - the source image, when there is one, may not contradict: inside the odd copy the
//     picture looks like at least one of the other copies (ΔE to the nearest one no
//     more than the spread among the other copies themselves + 2, and at most 12).
//     Copies of one part are often lit a little differently in the picture; the tracer
//     then puts one of them on the neighbouring palette colour, which is the error
//   - render check: outside the copy nothing changes; inside it the colour is exactly
//     the majority colour (paint order, fill rule and overlaps included)
// The change is intended (a visible colour change), so it becomes a history stage and
// the reference of the following passes, like the restoration to the source image.
import { sampleNative, polyOf } from './features.js';
import { apply, invert, mult } from './matrix.js';
import { bbox, pointInPoly } from './geom.js';
import { render, cropView, rasterPolys, fillPolys, lab } from './raster.js';
import { record } from './engine.js';
import { elementBox } from './model.js';
import { sampleUser } from './source.js';

const dE = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const labOf = (c) => lab(c[0], c[1], c[2]);
const hex = (c) => '#' + c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
const isIdentity = (m) => Math.abs(m[0] - 1) < 1e-9 && Math.abs(m[1]) < 1e-9 && Math.abs(m[2]) < 1e-9 && Math.abs(m[3] - 1) < 1e-9 && Math.abs(m[4]) < 1e-9 && Math.abs(m[5]) < 1e-9;

export function passConsistency(ctx) {
  const P = 'repetition consistency';
  if (!ctx.S.consistency) return 0;
  let changed = 0;
  for (const { g, major, n, count } of findRepeats(ctx)) {
    const odd = g.filter((p) => p.color !== major);
    const label = `${g.length} mirror copies, ${n} of them ${major}`;
    if (n < 3 || n < 0.75 * g.length) { for (const m of odd) record(ctx, { pass: P, op: 'repetition consistency', el: m.e.idx, sub: m.i, accepted: false, label, reason: `no clear majority colour (${[...count.entries()].map(([c, k]) => `${k} x ${c}`).join(', ')})` }); continue; }
    const target = g.find((p) => p.color === major).e, sibs = g.filter((p) => p.color === major);
    for (const m of odd) {
      const why = moveCheck(ctx, m, target, major, sibs);
      if (why.fail) { record(ctx, { pass: P, op: 'repetition consistency', el: m.e.idx, sub: m.i, accepted: false, label, reason: why.fail, evidence: why.evidence }); continue; }
      // apply: the contour leaves its element and joins the target
      const src = m.e, idx = src.subpaths.indexOf(m.sp);
      src.subpaths = src.subpaths.filter((s, k) => k !== idx);
      if (!src.subpaths.length) src.removed = true;
      target.subpaths = [...target.subpaths, why.moved];
      changed++;
      const im = why.evidence.image;
      record(ctx, { pass: P, op: 'repetition consistency', el: src.idx, sub: null, accepted: true, label, reason: `colour ${m.color} -> ${major}, like the other copies${im ? ` (in the source image it looks like the other copies: ΔE ${im.toSibling} to the nearest one, ${im.spread} among them)` : ''}`, evidence: why.evidence });
      // the same repair seen from the receiving element (informational: counted once)
      record(ctx, { pass: P, op: 'repetition consistency', el: target.idx, sub: null, accepted: null, label: `receives a copy from element #${src.idx}`, reason: 'the copy is drawn in the majority colour', evidence: why.evidence });
    }
  }
  return changed;
}

// Groups of mirror copies whose colours differ: [{ g: parts, major, n, count }], where
// `major` is the most frequent colour, held by n copies. Also used by the analysis: an
// odd copy with a clear majority (n >= 3 and 3/4 of the group) is reported as an issue.
export function findRepeats(ctx) {
  const { doc, u } = ctx;
  const usable = (e) => e.editable && !e.removed && !e.locked && e.fill.kind === 'solid' && e.stroke.kind === 'none' && e.fill.rgb[3] === 1 && e.fillOpacity === 1 && e.opacity === 1
    && !(e.clips && e.clips.length) && !(e.masks && e.masks.length) && !(e.chain && e.chain.length);
  const parts = [];
  for (const e of doc.elements) {
    if (!usable(e)) continue;
    e.subpaths.forEach((sp, i) => {
      if (!sp.closed || sp.segs.length < 2) return;
      const pts = sampleNative(sp, (0.5 * u) / (e.scale || 1)).pts.map((q) => apply(e.ctm, q));
      const b = bbox(pts);
      parts.push({ e, i, sp, pts, box: b, size: Math.max(b[2] - b[0], b[3] - b[1]), color: hex(e.fill.rgb) });
    });
  }
  if (parts.length < 3) return [];
  // the drawing's centre: the box of everything drawn
  let all = [Infinity, Infinity, -Infinity, -Infinity];
  for (const e of doc.elements) {
    if (e.removed || e.render === false) continue;
    const b = elementBox(e);
    if (isFinite(b[0])) all = [Math.min(all[0], b[0]), Math.min(all[1], b[1]), Math.max(all[2], b[2]), Math.max(all[3], b[3])];
  }
  const cx = (all[0] + all[2]) / 2, cy = (all[1] + all[3]) / 2;
  const mirrors = [(q) => [2 * cx - q[0], q[1]], (q) => [q[0], 2 * cy - q[1]], (q) => [2 * cx - q[0], 2 * cy - q[1]]];
  // groups of mirror copies (union-find)
  const parent = parts.map((_, k) => k), find = (k) => (parent[k] === k ? k : (parent[k] = find(parent[k])));
  // Hausdorff distance up to the tolerance: one grid per part, built only for the parts
  // that pass the box test, and searched ring by ring, never farther than the tolerance
  const cellOf = (p) => Math.max(u, 0.005 * p.size);
  const near = [], nearOf = (b) => (near[b] ||= withinDistance(parts[b].pts, cellOf(parts[b])));
  for (let a = 0; a < parts.length; a++) {
    const A = parts[a], tolBox = Math.max(2 * u, 0.04 * A.size), tol = Math.max(2 * u, 0.08 * A.size);
    for (const g of mirrors) {
      const gb = bbox([g([A.box[0], A.box[1]]), g([A.box[2], A.box[3]])]);
      let gA = null, nA = null;
      for (let b = 0; b < parts.length; b++) {
        const B = parts[b];
        if (b === a || find(a) === find(b) || Math.abs(B.size - A.size) > tolBox) continue;
        if (Math.abs(gb[0] - B.box[0]) > tolBox || Math.abs(gb[1] - B.box[1]) > tolBox || Math.abs(gb[2] - B.box[2]) > tolBox || Math.abs(gb[3] - B.box[3]) > tolBox) continue;
        if (!gA) { gA = A.pts.map(g); nA = withinDistance(gA, cellOf(A)); }
        const nB = nearOf(b);
        let h = 0;
        for (const q of gA) { h = Math.max(h, nB(q, tol)); if (h > tol) break; }
        if (h <= tol) for (const q of B.pts) { h = Math.max(h, nA(q, tol)); if (h > tol) break; }
        if (h <= tol) parent[find(a)] = find(b);
      }
    }
  }
  const groups = new Map(), out = [];
  parts.forEach((p, k) => { const r = find(k); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(p); });
  const centre = (p) => [(p.box[0] + p.box[2]) / 2, (p.box[1] + p.box[3]) / 2];
  for (const g of groups.values()) {
    if (g.length < 3) continue;
    // layers: two members of the group in the same place
    if (g.some((p, a) => g.some((q, b) => b > a && Math.hypot(centre(p)[0] - centre(q)[0], centre(p)[1] - centre(q)[1]) <= Math.max(2 * u, 0.04 * p.size)))) continue;
    const count = new Map();
    for (const p of g) count.set(p.color, (count.get(p.color) || 0) + 1);
    const [major, n] = [...count.entries()].sort((x, y) => y[1] - x[1])[0];
    if (n < g.length) out.push({ g, major, n, count });
  }
  return out;
}

// Can copy m be drawn by `target` instead (only its colour changing)?
function moveCheck(ctx, m, target, major, sibs) {
  const { doc, view, u } = ctx, evidence = {};
  const inv = invert(target.ctm);
  if (!inv) return { fail: 'singular transform', evidence };
  const rel = mult(inv, m.e.ctm);
  if (!isIdentity(rel)) return { fail: 'the two elements are in different coordinate systems', evidence };
  const moved = m.sp;
  // the source image may not contradict: the odd copy must look like the other copies
  const own = ctx.src && ctx.src.T ? imageColor(m, ctx) : null;
  if (own) {
    const others = sibs.map((p) => imageColor(p, ctx)).filter(Boolean);
    if (others.length >= 2) {
      const L = labOf(own), toSibling = Math.min(...others.map((c) => dE(L, labOf(c))));
      let spread = 0;
      for (let a = 0; a < others.length; a++) for (let b = a + 1; b < others.length; b++) spread = Math.max(spread, dE(labOf(others[a]), labOf(others[b])));
      evidence.image = { color: hex(own), others: others.map(hex), toSibling: +toSibling.toFixed(1), spread: +spread.toFixed(1), toMajor: +dE(L, labOf(hexToRgb(major))).toFixed(1), toCurrent: +dE(L, labOf(m.e.fill.rgb)).toFixed(1) };
      if (toSibling > Math.max(spread, 3) + 2 || toSibling > 12) return { fail: `the source image contradicts it (inside the copy ΔE ${toSibling.toFixed(1)} to the nearest other copy, which differ by up to ${spread.toFixed(1)} among themselves)`, evidence };
    }
  }
  // render check around the copy
  const b = bbox(m.pts);
  let crop = cropView(view, b, 3 * u + 2 / view.k, 2);
  if (crop.W * crop.H > 360000) crop = cropView(view, b, 3 * u + 2 / view.k, 1);
  const geomNow = (x) => (x.removed ? null : x.subpaths);
  const srcSubs = m.e.subpaths.filter((s) => s !== m.sp), tgtSubs = [...target.subpaths, moved];
  const geomNew = (x) => (x === m.e ? (srcSubs.length ? srcSubs : null) : x === target ? tgtSubs : geomNow(x));
  const before = render(doc, crop, { geom: geomNow }), after = render(doc, crop, { geom: geomNew });
  const cov = rasterPolys(fillPolys([m.sp], m.e.ctm, crop), 'nonzero', crop);
  const covAt = (x, y) => (cov && x >= cov.x0 && y >= cov.y0 && x < cov.x0 + cov.w && y < cov.y0 + cov.h ? cov.data[(y - cov.y0) * cov.w + x - cov.x0] : 0);
  // inside the copy, only its own colour may change: it must show its colour now (nothing
  // above it) and the majority colour after
  const M = labOf(hexToRgb(major)), C = labOf(m.e.fill.rgb);
  let outside = 0, insideWrong = 0, insideN = 0, covered = 0;
  for (let y = 0; y < crop.H; y++) for (let x = 0; x < crop.W; x++) {
    const p = (y * crop.W + x) * 3, c = covAt(x, y);
    if (c === 0) { if (Math.abs(before[p] - after[p]) + Math.abs(before[p + 1] - after[p + 1]) + Math.abs(before[p + 2] - after[p + 2]) > 0.5) outside++; }
    else if (c >= 0.999) {
      insideN++;
      if (dE(labOf([before[p], before[p + 1], before[p + 2]]), C) > 1) covered++;
      else if (dE(labOf([after[p], after[p + 1], after[p + 2]]), M) > 1) insideWrong++;
    }
  }
  evidence.render = { outsideChanged: outside, insidePixels: insideN, coveredNow: covered, insideNotMajor: insideWrong };
  if (outside) return { fail: `${outside} px outside the copy would change (paint order or overlap)`, evidence };
  if (covered) return { fail: `${covered} px of the copy are covered by another shape now: moving it would change more than its colour`, evidence };
  if (!insideN || insideWrong) return { fail: `the copy would not be drawn in ${major} (${insideWrong} of ${insideN} px)`, evidence };
  return { moved, evidence };
}
const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
// Distance from a point to the nearest point of Q when it is at most `limit`, else
// Infinity. The grid is read ring by ring from the point's cell, stopping when no closer
// point can exist or the rings pass `limit` (a hash collision can only add candidates,
// whose real distance is then measured).
function withinDistance(Q, cell) {
  const grid = new Map(), key = (i, j) => (i * 73856093) ^ (j * 19349663);
  for (const q of Q) { const k = key(Math.floor(q[0] / cell), Math.floor(q[1] / cell)); (grid.get(k) || grid.set(k, []).get(k)).push(q); }
  return (p, limit) => {
    const ix = Math.floor(p[0] / cell), iy = Math.floor(p[1] / cell), R = Math.ceil(limit / cell) + 1;
    let best = Infinity;
    const visit = (gx, gy) => {
      const l = grid.get(key(ix + gx, iy + gy));
      if (l) for (const q of l) { const d = Math.hypot(p[0] - q[0], p[1] - q[1]); if (d < best) best = d; }
    };
    for (let r = 0; r <= R && best > (r - 1) * cell; r++) {
      if (r === 0) { visit(0, 0); continue; }
      for (let g = -r; g <= r; g++) { visit(g, -r); visit(g, r); }
      for (let g = -r + 1; g <= r - 1; g++) { visit(-r, g); visit(r, g); }
    }
    return best <= limit ? best : Infinity;
  };
}
// the median colour of the source image inside a copy (null when it has too few pixels)
function imageColor(m, ctx) {
  if (m.image !== undefined) return m.image;
  const inside = interiorPoints(m, ctx);
  if (inside.length < 5) return (m.image = null);
  const cols = inside.map((q) => sampleUser(ctx.src, q[0], q[1], [0, 0, 0]).slice());
  return (m.image = [0, 1, 2].map((k) => { const v = cols.map((c) => c[k]).sort((a, b) => a - b); return v[v.length >> 1]; }));
}
// points inside a copy, at least 1.5 image px (or 1.5 u) from its outline, in root space
function interiorPoints(m, ctx) {
  const px = ctx.src && ctx.src.T ? 1 / ctx.src.T.s : ctx.u, poly = polyOf(m.sp, 0.1 * px).map((q) => apply(m.e.ctm, q));
  const b = bbox(poly), nd = withinDistance(m.pts, 1.5 * px), out = [];
  for (let y = b[1]; y <= b[3]; y += 0.5 * px) for (let x = b[0]; x <= b[2]; x += 0.5 * px) if (pointInPoly([x, y], poly) && nd([x, y], 1.5 * px) >= 1.5 * px) out.push([x, y]);
  return out;
}
