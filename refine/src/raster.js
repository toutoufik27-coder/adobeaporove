// Exact software rasterizer used as the reference renderer for validation.
// Polygon coverage with 4 sub-rows per pixel and exact horizontal span coverage,
// nonzero / even-odd, strokes (joins and caps), clip-path, mask (luminance),
// opacity, gradients (as their mean colour). Coverage buffers are limited to the
// shape's box, so thousands of elements stay cheap.
import { flatten } from './geom.js';
import { expand } from './pathdata.js';
import { apply, invert } from './matrix.js';
import { gradientPixels, geomBox } from './paint.js';

// What this renderer draws exactly. The protection system (capability.js) locks every
// element that needs a feature marked false here, and marks where it paints as
// uncertain, so no candidate is ever judged on a render that lacks it.
export const CAPS = {
  gradients: true,
  patterns: false,
  filters: false,
  markers: false,
  text: false,
  image: false,
  masks: true,             // region, content units, mask-type, child opacity, gradients
  clipBBoxUnits: true,
  groupOpacity: true,      // groups with opacity / mask painted as isolated layers
  affineStroke: true,      // strokes built in local space, then mapped
  dashes: true,
  nonScalingStroke: false,
  nestedViewports: true,   // nested <svg> / used <symbol>: viewBox, preserveAspectRatio, overflow clip
  switchElement: false,
};

export function makeView(viewBox, maxSide = 700) {
  const [x, y, w, h] = viewBox, k = maxSide / Math.max(w, h);
  return { x, y, k, W: Math.max(1, Math.round(w * k)), H: Math.max(1, Math.round(h * k)) };
}
// A window of a view at the same (or a higher) scale around a box in user units.
export function cropView(view, box, pad, zoom = 1) {
  const k = view.k * zoom;
  const x0 = Math.max(view.x, box[0] - pad), y0 = Math.max(view.y, box[1] - pad);
  const x1 = Math.min(view.x + view.W / view.k, box[2] + pad), y1 = Math.min(view.y + view.H / view.k, box[3] + pad);
  const px0 = Math.floor((x0 - view.x) * k), py0 = Math.floor((y0 - view.y) * k);
  const px1 = Math.ceil((x1 - view.x) * k), py1 = Math.ceil((y1 - view.y) * k);
  return { x: view.x + px0 / k, y: view.y + py0 / k, k, W: Math.max(1, px1 - px0), H: Math.max(1, py1 - py0) };
}

// polys: arrays of [x,y] in pixel space. Returns { x0, y0, w, h, data } or null.
export function rasterPolys(polys, rule, view) {
  const S = 4, edges = [];
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (const pts of polys) {
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      if (a[0] < bx0) bx0 = a[0]; if (a[0] > bx1) bx1 = a[0]; if (a[1] < by0) by0 = a[1]; if (a[1] > by1) by1 = a[1];
      if (a[1] === b[1]) continue;
      edges.push(a[1] < b[1] ? [a[0], a[1], b[0], b[1], 1] : [b[0], b[1], a[0], a[1], -1]);
    }
  }
  if (!edges.length) return null;
  const x0 = Math.max(0, Math.floor(bx0)), y0 = Math.max(0, Math.floor(by0));
  const x1 = Math.min(view.W, Math.ceil(bx1) + 1), y1 = Math.min(view.H, Math.ceil(by1) + 1);
  if (x1 <= x0 || y1 <= y0) return null;
  const w = x1 - x0, h = y1 - y0, data = new Float32Array(w * h);
  edges.sort((e, f) => e[1] - f[1]);
  const evenodd = rule === 'evenodd', row = new Float32Array(w + 2), xs = [];
  let first = 0;
  for (let py = y0; py < y1; py++) {
    row.fill(0);
    let any = false;
    for (let s = 0; s < S; s++) {
      const sy = py + (s + 0.5) / S;
      xs.length = 0;
      for (let e = 0; e < edges.length; e++) {
        const E = edges[e];
        if (E[1] > sy) break;
        if (E[3] <= sy) continue;
        xs.push(E[0] + ((sy - E[1]) * (E[2] - E[0])) / (E[3] - E[1]), E[4]);
      }
      if (xs.length < 4) continue;
      // sort pairs by x
      const n = xs.length / 2, idx = new Array(n);
      for (let i = 0; i < n; i++) idx[i] = i;
      idx.sort((a, b) => xs[2 * a] - xs[2 * b]);
      let wind = 0;
      for (let q = 0; q < n - 1; q++) {
        wind += evenodd ? 1 : xs[2 * idx[q] + 1];
        if (evenodd ? wind % 2 === 0 : wind === 0) continue;
        const xa = Math.max(x0, xs[2 * idx[q]]) - x0, xb = Math.min(x1, xs[2 * idx[q + 1]]) - x0;
        if (xb <= xa) continue;
        any = true;
        const i0 = Math.floor(xa), i1 = Math.floor(xb);
        if (i0 === i1) row[i0] += (xb - xa) / S;
        else { row[i0] += (i0 + 1 - xa) / S; for (let k = i0 + 1; k < i1; k++) row[k] += 1 / S; if (i1 < w) row[i1] += (xb - i1) / S; }
      }
    }
    if (any) for (let k = 0; k < w; k++) data[(py - y0) * w + k] = Math.min(1, row[k]);
  }
  return { x0, y0, w, h, data };
}

// ---- geometry of an element in pixel space
const toPx = (view, m) => (p) => { const q = apply(m, p); return [(q[0] - view.x) * view.k, (q[1] - view.y) * view.k]; };
export function fillPolys(subpaths, m, view) {
  const f = toPx(view, m), out = [];
  const tol = 0.2 / (view.k * Math.max(1e-9, Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]))));
  for (const sp of subpaths) {
    if (!sp.segs.length) continue;
    const pts = flatten(expand(sp.segs), tol);
    pts.push(sp.segs[sp.segs.length - 1].p.at(-1));
    out.push(pts.map(f));
  }
  return out;
}
// Largest stretch of a linear map (its largest singular value).
export const maxScale = (m) => { const p = m[0] * m[0] + m[1] * m[1], q = m[2] * m[2] + m[3] * m[3], r = m[0] * m[2] + m[1] * m[3]; return Math.sqrt((p + q + Math.sqrt((p - q) * (p - q) + 4 * r * r)) / 2) || 1; };
// Dash pattern in user units, or null for a solid stroke (an invalid pattern is ignored,
// as browsers ignore it).
export function dashPattern(style) {
  const v = style && style['stroke-dasharray'];
  if (!v || v === 'none') return null;
  const a = v.split(/[\s,]+/).filter(Boolean);
  if (!a.every((x) => /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?(px)?$/i.test(x))) return null;
  let d = a.map(parseFloat);
  if (d.some((x) => x < 0) || !(d.reduce((p, q) => p + q, 0) > 0)) return null;
  if (d.length % 2) d = d.concat(d);
  return { d, offset: parseFloat(style['stroke-dashoffset']) || 0 };
}
// Split a polyline into the "on" pieces of a dash pattern (user units).
function dashPieces(P, closed, dash) {
  const pts = closed ? [...P, P[0]] : P, total = dash.d.reduce((p, q) => p + q, 0);
  let pos = ((dash.offset % total) + total) % total, k = 0;
  while (pos >= dash.d[k]) { pos -= dash.d[k]; k = (k + 1) % dash.d.length; }
  let left = dash.d[k] - pos, on = k % 2 === 0;
  const out = [];
  let cur = on ? [pts[0]] : null;
  const startsOn = on;
  for (let i = 0; i + 1 < pts.length; i++) {
    let a = pts[i];
    const b = pts[i + 1];
    let L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    while (L > 1e-12) {
      if (left >= L) { left -= L; if (on) cur.push(b); break; }
      const t = left / L, q = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      if (on) { cur.push(q); out.push(cur); cur = null; } else cur = [q];
      on = !on; k = (k + 1) % dash.d.length; left = dash.d[k];
      L -= Math.hypot(q[0] - a[0], q[1] - a[1]); a = q;
    }
  }
  if (on && cur && cur.length > 1) {
    // on a closed contour, a dash running over the start point is one dash
    if (closed && startsOn && out.length) out[0] = [...cur, ...out[0].slice(1)];
    else out.push(cur);
  }
  return out;
}
// Stroke outline polygons (union by nonzero): one quad per flattened edge plus joins /
// caps. Built in the element's own coordinates and then mapped: exact under any affine
// transform (skew, non-uniform scale, reflection), because the stroke is defined there.
export function strokePolys(subpaths, m, view, style, width) {
  const f = toPx(view, m), out = [];
  const hw = width / 2, ms = maxScale(m);
  if (!(hw > 0)) return out;
  const tol = 0.2 / (view.k * ms);
  const join = style['stroke-linejoin'] || 'miter', cap = style['stroke-linecap'] || 'butt', limit = Math.max(1, parseFloat(style['stroke-miterlimit']) || 4);
  const dash = dashPattern(style);
  const orient = (poly) => { let a = 0; for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; a += p[0] * q[1] - q[0] * p[1]; } return a < 0 ? poly.reverse() : poly; };
  const emit = (poly) => out.push(orient(poly.map(f)));
  const nCirc = Math.max(8, Math.min(64, Math.ceil(hw * ms * view.k * 2)));
  const circle = (c) => { const P = []; for (let i = 0; i < nCirc; i++) { const t = (2 * Math.PI * i) / nCirc; P.push([c[0] + hw * Math.cos(t), c[1] + hw * Math.sin(t)]); } return P; };
  const strokeLine = (P, closed) => {
    if (P.length === 1) { if (cap === 'round') emit(circle(P[0])); else if (cap === 'square') emit([[P[0][0] - hw, P[0][1] - hw], [P[0][0] + hw, P[0][1] - hw], [P[0][0] + hw, P[0][1] + hw], [P[0][0] - hw, P[0][1] + hw]]); return; }
    const n = P.length, E = closed ? n : n - 1;
    const dir = (i) => { const a = P[i % n], b = P[(i + 1) % n], L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [(b[0] - a[0]) / L, (b[1] - a[1]) / L]; };
    for (let i = 0; i < E; i++) {
      let a = P[i], b = P[(i + 1) % n];
      const d = dir(i), nx = -d[1] * hw, ny = d[0] * hw;
      if (!closed && cap === 'square') { if (i === 0) a = [a[0] - d[0] * hw, a[1] - d[1] * hw]; if (i === E - 1) b = [b[0] + d[0] * hw, b[1] + d[1] * hw]; }
      emit([[a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny], [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny]]);
    }
    for (let i = closed ? 0 : 1; i < (closed ? n : n - 1); i++) {
      const v = P[i], d0 = dir((i - 1 + n) % n), d1 = dir(i);
      const cr = d0[0] * d1[1] - d0[1] * d1[0];
      if (Math.abs(cr) < 1e-9 && d0[0] * d1[0] + d0[1] * d1[1] > 0) continue;
      if (join === 'round') { emit(circle(v)); continue; }
      const s = cr > 0 ? -1 : 1;               // outer side
      const o0 = [v[0] - d0[1] * hw * s, v[1] + d0[0] * hw * s], o1 = [v[0] - d1[1] * hw * s, v[1] + d1[0] * hw * s];
      const cosT = d0[0] * d1[0] + d0[1] * d1[1], ratio = 1 / Math.sqrt(Math.max(1e-12, (1 + cosT) / 2));
      if ((join === 'miter' || join === 'miter-clip' || join === 'arcs') && ratio <= limit) {
        const bis = [o0[0] + o1[0] - 2 * v[0], o0[1] + o1[1] - 2 * v[1]], bl = Math.hypot(bis[0], bis[1]) || 1;
        emit([v, o0, [v[0] + (bis[0] / bl) * hw * ratio, v[1] + (bis[1] / bl) * hw * ratio], o1]);
      } else emit([v, o0, o1]);
    }
    if (!closed && cap === 'round') { emit(circle(P[0])); emit(circle(P[n - 1])); }
  };
  for (const sp of subpaths) {
    if (!sp.segs.length) continue;
    const pts = flatten(expand(sp.segs), tol);
    pts.push(sp.segs[sp.segs.length - 1].p.at(-1));
    const P = [pts[0]];
    for (let i = 1; i < pts.length; i++) if (Math.hypot(pts[i][0] - P[P.length - 1][0], pts[i][1] - P[P.length - 1][1]) > 1e-9) P.push(pts[i]);
    const closed = sp.closed;
    if (closed && P.length > 1 && Math.hypot(P[0][0] - P[P.length - 1][0], P[0][1] - P[P.length - 1][1]) < 1e-9) P.pop();
    if (!dash || P.length < 2) { strokeLine(P, closed); continue; }
    for (const piece of dashPieces(P, closed, dash)) strokeLine(piece, false);
  }
  return out;
}

// ---- compositing
const boxCache = new WeakMap();
// Geometry box (local coordinates) of the element a clip / mask entry belongs to: needed
// for objectBoundingBox units. Only the element itself is known here (a group's box is
// not tracked: the capability system locks that case).
function ownerBox(e, c) {
  if (e.box !== undefined && c.node === e.node) return e.box;        // a group: its box is given
  if (!c.node || c.node !== e.node || !e.subpaths || !e.subpaths.length) return null;
  const b = geomBox(e.subpaths, (sp) => flatten(expand(sp.segs), 1e-3));
  return isFinite(b[0]) ? b : null;
}
const bboxMatrix = (b) => [b[2] - b[0], 0, 0, b[3] - b[1], b[0], b[1]];
// intersection of every clip in the chain; each clip is the union of its children
function clipCoverage(doc, clips, view, cache, e) {
  let acc = null;
  for (const c of clips) {
    if (c.rect) { const cov = rectCoverage(c, view, cache); acc = acc ? acc.map((v, i) => v * cov[i]) : cov; continue; }
    const res = doc.clips.get(c.ref);
    if (!res) continue;
    const cov = clipOne(doc, res, c, view, cache, e, 0);
    if (!cov) continue;
    acc = acc ? acc.map((v, i) => v * cov[i]) : cov;
  }
  return acc;
}
// a viewport clip (nested <svg>, used <symbol>): its rectangle in the parent's space
function rectCoverage(c, view, cache) {
  const key = 'r:' + c.rect.join(',') + '|' + c.ctm.join(',');
  let cov = cache.get(key);
  if (cov) return cov;
  const [x, y, w, h] = c.rect;
  const r = rasterPolys([[[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map((q) => { const t = apply(c.ctm, q); return [(t[0] - view.x) * view.k, (t[1] - view.y) * view.k]; })], 'nonzero', view);
  cov = new Float32Array(view.W * view.H);
  if (r) for (let yy = 0; yy < r.h; yy++) for (let xx = 0; xx < r.w; xx++) cov[(r.y0 + yy) * view.W + r.x0 + xx] = r.data[yy * r.w + xx];
  cache.set(key, cov);
  return cov;
}
function clipOne(doc, res, c, view, cache, e, depth) {
  let base = c.ctm, bkey = '';
  if (res.units === 'objectBoundingBox') {
    const bb = ownerBox(e, c);
    if (!bb) return null;
    if (!(bb[2] > bb[0] && bb[3] > bb[1])) return new Float32Array(view.W * view.H);   // empty box: clips everything
    base = mult6(base, bboxMatrix(bb)); bkey = bb.join(',');
  }
  base = mult6(base, res.tf);
  const key = 'c:' + c.ref + '|' + base.join(',') + '|' + bkey + '|' + depth;
  let cov = cache.get(key);
  if (!cov) {
    cov = new Float32Array(view.W * view.H);
    for (const k of res.els) {
      if (!k.render) continue;
      const r = rasterPolys(fillPolys(k.subpaths, mult6(base, k.ctm), view), k.style['clip-rule'] === 'evenodd' ? 'evenodd' : 'nonzero', view);
      if (r) for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) { const v = r.data[y * r.w + x], p = (r.y0 + y) * view.W + r.x0 + x; cov[p] += v * (1 - cov[p]); }
    }
    // a clip-path on the <clipPath> itself intersects its region
    const inner = res.clipRef && depth < 8 && doc.clips.get(res.clipRef);
    if (inner) { const c2 = clipOne(doc, inner, c, view, cache, e, depth + 1); if (c2) for (let p = 0; p < cov.length; p++) cov[p] *= c2[p]; }
    cache.set(key, cov);
  }
  return cov;
}
const LUM = [0.2125, 0.7154, 0.0721];
function maskCoverage(doc, masks, view, cache, e) {
  let acc = null;
  for (const c of masks) {
    const res = doc.masks.get(c.ref);
    if (!res) continue;
    const cov = maskOne(doc, res, c, view, cache, e);
    if (!cov) continue;
    acc = acc ? acc.map((v, i) => v * cov[i]) : cov;
  }
  return acc;
}
function maskOne(doc, res, c, view, cache, e) {
  const needBox = res.units === 'objectBoundingBox' || res.regionUnits === 'objectBoundingBox';
  const bb = needBox ? ownerBox(e, c) : null;
  if (needBox && !bb) return null;
  if (needBox && !(bb[2] > bb[0] && bb[3] > bb[1])) return new Float32Array(view.W * view.H);
  const key = 'm:' + c.ref + '|' + c.ctm.join(',') + '|' + (bb ? bb.join(',') : '');
  let cov = cache.get(key);
  if (cov) return cov;
  // mask region (x / y / width / height), clipping the mask content
  const vb = doc.viewBox, num = (v, frac, ref, d) => { if (v == null) return d; const s = String(v).trim(), n = parseFloat(s); if (!isFinite(n)) return d; return s.endsWith('%') ? (frac ? n / 100 : (n / 100) * ref) : n; };
  let R;
  if (res.regionUnits === 'objectBoundingBox') {
    const [fx, fy, fw, fh] = res.region.map((v, i) => num(v, true, 1, [-0.1, -0.1, 1.2, 1.2][i]));
    const w = bb[2] - bb[0], h = bb[3] - bb[1];
    R = [bb[0] + fx * w, bb[1] + fy * h, fw * w, fh * h];
  } else R = [num(res.region[0], false, vb[2], vb[0] - 0.1 * vb[2]), num(res.region[1], false, vb[3], vb[1] - 0.1 * vb[3]), num(res.region[2], false, vb[2], 1.2 * vb[2]), num(res.region[3], false, vb[3], 1.2 * vb[3])];
  cov = new Float32Array(view.W * view.H);
  if (!(R[2] > 0 && R[3] > 0)) { cache.set(key, cov); return cov; }
  const base = res.units === 'objectBoundingBox' ? mult6(c.ctm, bboxMatrix(bb)) : c.ctm;
  const alphaType = res.type === 'alpha';
  for (const k of res.els) {
    if (!k.render) continue;
    const m = mult6(base, k.ctm);
    for (const which of (k.style && /^\s*stroke/.test(k.style['paint-order'] || '') ? ['stroke', 'fill'] : ['fill', 'stroke'])) {
      const paint = k[which];
      if (!paint || paint.kind === 'none' || (paint.kind === 'gradient' && !(paint.grad && paint.grad.stops.length))) continue;
      const polys = which === 'fill' ? fillPolys(k.subpaths, m, view) : strokePolys(k.subpaths, m, view, k.style, k.strokeWidth);
      const r = polys.length && rasterPolys(polys, which === 'fill' ? k.rule : 'nonzero', view);
      if (!r) continue;
      const col = paint.kind === 'gradient' ? gradientPixels(paint.grad, r, view, m, geomBox(k.subpaths, (sp) => flatten(expand(sp.segs), 1e-3))) : null;
      if (paint.kind === 'gradient' && !col) continue;
      const a0 = (col ? 1 : paint.rgb[3]) * (which === 'fill' ? k.fillOpacity : k.strokeOpacity) * k.opacity;
      const lum0 = (LUM[0] * paint.rgb[0] + LUM[1] * paint.rgb[1] + LUM[2] * paint.rgb[2]) / 255;
      for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
        const i = y * r.w + x;
        let v = r.data[i] * a0, lum = lum0;
        if (!v) continue;
        if (col) { v *= col[i * 4 + 3]; lum = (LUM[0] * col[i * 4] + LUM[1] * col[i * 4 + 1] + LUM[2] * col[i * 4 + 2]) / 255; }
        const p = (r.y0 + y) * view.W + r.x0 + x;
        cov[p] = cov[p] * (1 - v) + (alphaType ? 1 : lum) * v;       // premultiplied source-over
      }
    }
  }
  const rr = rasterPolys([[[R[0], R[1]], [R[0] + R[2], R[1]], [R[0] + R[2], R[1] + R[3]], [R[0], R[1] + R[3]]].map((q) => { const t = apply(c.ctm, q); return [(t[0] - view.x) * view.k, (t[1] - view.y) * view.k]; })], 'nonzero', view);
  const region = new Float32Array(view.W * view.H);
  if (rr) for (let y = 0; y < rr.h; y++) for (let x = 0; x < rr.w; x++) region[(rr.y0 + y) * view.W + rr.x0 + x] = rr.data[y * rr.w + x];
  for (let p = 0; p < cov.length; p++) cov[p] *= region[p];
  cache.set(key, cov);
  return cov;
}
const mult6 = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
function addBox(full, r, view, a) { for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) { const p = (r.y0 + y) * view.W + r.x0 + x; full[p] = Math.max(full[p], r.data[y * r.w + x] * a); } }

// Paint layers of one element: [{ box, rgb, alpha }] where box.data is final alpha.
export function elementLayers(e, doc, view, cache = new Map()) {
  if (!e.render) return [];
  // parts already carry the use's opacity / clips / masks (plus a used symbol's viewport clip)
  if (e.parts) return e.parts.flatMap((q) => elementLayers({ ...q, render: true, masks: e.masks, opacity: q.opacity * (e.opacity / (e.fullOpacity || e.opacity || 1)) }, doc, view, cache));
  const out = [];
  const order = (e.style && /^\s*stroke/.test(e.style['paint-order'] || '')) ? ['stroke', 'fill'] : ['fill', 'stroke'];
  for (const which of order) {
    const paint = e[which];
    if (!paint || paint.kind === 'none' || !e.subpaths.length) continue;
    const polys = which === 'fill' ? fillPolys(e.subpaths, e.ctm, view) : strokePolys(e.subpaths, e.ctm, view, e.style, e.strokeWidth);
    const r = polys.length && rasterPolys(polys, which === 'fill' ? e.rule : 'nonzero', view);
    if (!r) continue;
    let col = null;
    if (paint.kind === 'gradient' && paint.grad && paint.grad.stops.length) {
      col = gradientPixels(paint.grad, r, view, e.ctm, geomBox(e.subpaths, (sp) => flatten(expand(sp.segs), 0.01 * Math.max(1e-9, (r.w + r.h) / view.k / 100))));
      if (!col) continue;                                      // zero-size box: paints nothing
    } else if (paint.kind === 'gradient') continue;              // no stops: paints nothing
    const a = (col ? 1 : paint.rgb[3]) * (which === 'fill' ? e.fillOpacity : e.strokeOpacity) * e.opacity;
    if (e.clips && e.clips.length) { const c = clipCoverage(doc, e.clips, view, cache, e); if (c) mulBox(r, c, view); }
    if (e.masks && e.masks.length) { const c = maskCoverage(doc, e.masks, view, cache, e); if (c) mulBox(r, c, view); }
    out.push({ box: r, rgb: paint.rgb, alpha: a, which, col });
  }
  return out;
}
function mulBox(r, full, view) { for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) r.data[y * r.w + x] *= full[(r.y0 + y) * view.W + r.x0 + x]; }

// Composite the document over white: Float32 RGB.
// geom(e): the subpaths to draw for e (null = skip the element); box(e): its root
// box, used to skip elements outside the view.
export function render(doc, view, { geom = null, box = null, orig = false } = {}) {
  if (doc.elements.some((e) => e.chain && e.chain.length)) return renderLayered(doc, view, { geom, box, orig });
  const N = view.W * view.H, img = new Float32Array(N * 3).fill(255), cache = new Map();
  const vx1 = view.x + view.W / view.k, vy1 = view.y + view.H / view.k;
  for (const e of doc.elements) {
    let el = e;
    if (orig) el = e.base ? { ...e, subpaths: e.base, ctm: e.baseCtm || e.ctm } : e.origCtm ? { ...e, subpaths: e.orig, ctm: e.origCtm } : e.orig ? { ...e, subpaths: e.orig } : e;
    else if (geom) { const g = geom(e); if (g === null) continue; if (g !== e.subpaths) el = { ...e, subpaths: g }; }
    else if (e.removed) continue;
    if (box) { const b = box(e, el.subpaths); if (b && (b[0] > vx1 || b[2] < view.x || b[1] > vy1 || b[3] < view.y)) continue; }
    for (const L of elementLayers(el, doc, view, cache)) paint(img, L, view);
  }
  return img;
}
// Group compositing: every group with opacity < 1 or a mask is painted into its own
// premultiplied RGBA layer, then blended once onto its parent with its opacity and mask
// (overlapping children are not blended twice). Leaves carry only their own opacity.
function renderLayered(doc, view, { geom, box, orig }) {
  const N = view.W * view.H, base = new Float32Array(N * 3).fill(255), cache = new Map();
  const vx1 = view.x + view.W / view.k, vy1 = view.y + view.H / view.k;
  const stack = [];                                  // [{ g, buf }]
  const blend = (top) => {
    const g = top.g, below = stack.length ? stack[stack.length - 1].buf : null;
    let m = null;
    if (g.masks.length) m = maskCoverage(doc, g.masks, view, cache, { node: g.node, subpaths: [], box: groupBox(g, top.members) });
    for (let p = 0; p < N; p++) {
      const f = g.opacity * (m ? m[p] : 1), a = top.buf[p * 4 + 3] * f;
      if (!a) continue;
      if (below) { for (let c = 0; c < 3; c++) below[p * 4 + c] = top.buf[p * 4 + c] * f + below[p * 4 + c] * (1 - a); below[p * 4 + 3] = a + below[p * 4 + 3] * (1 - a); }
      else for (let c = 0; c < 3; c++) base[p * 3 + c] = top.buf[p * 4 + c] * f + base[p * 3 + c] * (1 - a);
    }
  };
  for (const e of doc.elements) {
    let el = e;
    if (orig) el = e.base ? { ...e, subpaths: e.base, ctm: e.baseCtm || e.ctm } : e.origCtm ? { ...e, subpaths: e.orig, ctm: e.origCtm } : e.orig ? { ...e, subpaths: e.orig } : e;
    else if (geom) { const g = geom(e); if (g === null) continue; if (g !== e.subpaths) el = { ...e, subpaths: g }; }
    else if (e.removed) continue;
    if (box) { const b = box(e, el.subpaths); if (b && (b[0] > vx1 || b[2] < view.x || b[1] > vy1 || b[3] < view.y)) continue; }
    const chain = e.chain || [];
    let k = 0;
    while (k < stack.length && k < chain.length && stack[k].g === chain[k]) k++;
    while (stack.length > k) blend(stack.pop());
    for (let i = k; i < chain.length; i++) stack.push({ g: chain[i], buf: new Float32Array(N * 4), members: [] });
    for (const s of stack) s.members.push(el);
    const leaf = { ...el, opacity: e.leafOpacity ?? e.opacity, masks: e.leafMasks || [] };
    for (const L of elementLayers(leaf, doc, view, cache)) {
      if (stack.length) paintRGBA(stack[stack.length - 1].buf, L, view); else paint(base, L, view);
    }
  }
  while (stack.length) blend(stack.pop());
  return base;
}
// geometry box of a group in its own user space (its members, current geometry)
function groupBox(g, members) {
  const inv = invert(g.ctm);
  if (!inv) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const el of members) {
    const m = mult6(inv, el.ctm);
    for (const sp of el.subpaths || []) for (const q of [...flatten(expand(sp.segs), 1e-3), ...(sp.segs.length ? [sp.segs[sp.segs.length - 1].p.at(-1)] : [])]) { const p = apply(m, q); if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
  }
  return isFinite(x0) ? [x0, y0, x1, y1] : null;
}
function paintRGBA(buf, L, view) {
  const { box: r, alpha, col } = L;
  let rgb = L.rgb;
  if (!(alpha > 0)) return;
  for (let y = 0; y < r.h; y++) {
    let p = (r.y0 + y) * view.W + r.x0;
    for (let x = 0; x < r.w; x++, p++) {
      const i = y * r.w + x;
      let a = r.data[i] * alpha;
      if (!a) continue;
      if (col) { a *= col[i * 4 + 3]; if (!a) continue; rgb = col.subarray(i * 4, i * 4 + 3); }
      for (let c = 0; c < 3; c++) buf[p * 4 + c] = rgb[c] * a + buf[p * 4 + c] * (1 - a);
      buf[p * 4 + 3] = a + buf[p * 4 + 3] * (1 - a);
    }
  }
}
function paint(img, L, view) {
  const { box: r, alpha, col } = L;
  let rgb = L.rgb;
  if (!(alpha > 0)) return;
  for (let y = 0; y < r.h; y++) {
    let p = (r.y0 + y) * view.W + r.x0;
    for (let x = 0; x < r.w; x++, p++) {
      const i = y * r.w + x;
      let a = r.data[i] * alpha;
      if (!a) continue;
      if (col) { a *= col[i * 4 + 3]; if (!a) continue; rgb = col.subarray(i * 4, i * 4 + 3); }
      img[p * 3] += (rgb[0] - img[p * 3]) * a; img[p * 3 + 1] += (rgb[1] - img[p * 3 + 1]) * a; img[p * 3 + 2] += (rgb[2] - img[p * 3 + 2]) * a;
    }
  }
}

// Per element: total alpha box (fill + stroke), for visibility / occlusion analysis.
export function alphaBoxes(doc, view) {
  const cache = new Map();
  return doc.elements.map((e) => {
    const layers = elementLayers(e, doc, view, cache);
    if (!layers.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const L of layers) { x0 = Math.min(x0, L.box.x0); y0 = Math.min(y0, L.box.y0); x1 = Math.max(x1, L.box.x0 + L.box.w); y1 = Math.max(y1, L.box.y0 + L.box.h); }
    const w = x1 - x0, h = y1 - y0, data = new Float32Array(w * h), opaque = new Float32Array(w * h);
    for (const L of layers) for (let y = 0; y < L.box.h; y++) for (let x = 0; x < L.box.w; x++) {
      const v = L.box.data[y * L.box.w + x] * L.alpha * (L.col ? L.col[(y * L.box.w + x) * 4 + 3] : 1), p = (L.box.y0 - y0 + y) * w + L.box.x0 - x0 + x;
      data[p] = 1 - (1 - data[p]) * (1 - v);
    }
    return { x0, y0, w, h, data };
  });
}

// ---- colour difference
const LIN = new Float64Array(256);
for (let i = 0; i < 256; i++) { const c = i / 255; LIN[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }
const F = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
export function lab(r, g, b) {
  const R = LIN[Math.max(0, Math.min(255, Math.round(r)))], G = LIN[Math.max(0, Math.min(255, Math.round(g)))], B = LIN[Math.max(0, Math.min(255, Math.round(b)))];
  const x = F((R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047), y = F(R * 0.2126 + G * 0.7152 + B * 0.0722), z = F((R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
export const labOfRGB = (c) => lab(c[0], c[1], c[2]);
