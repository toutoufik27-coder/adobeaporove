// SVG document -> geometry model.
// Every drawable element (path, rect, circle, ellipse, line, polyline, polygon, use)
// becomes subpaths of native segments in its own coordinates, with its computed
// style, full transform (CTM), paint, clip / mask references and document order.
// `orig` is a frozen deep copy of the geometry: the original is never lost.
import { parseXML, getAttr, setAttr, delAttr, walk, localName, cloneTree, serialize } from './xml.js';
import { sanitize } from './security.js';
import { parseSheets, computed, parseColor } from './css.js';
import { parseTransform, mult, I, apply, scaleOf } from './matrix.js';
import { parsePath, expand } from './pathdata.js';
import { flatten, bbox } from './geom.js';
import { assessDoc } from './capability.js';
import { resolveGradient } from './paint.js';
import { parseLength, parsePAR, viewBoxTransform } from './viewport.js';
import { maxScale } from './raster.js';

const SHAPES = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'use', 'text', 'image']);
const RESOURCES = new Set(['defs', 'clipPath', 'mask', 'pattern', 'symbol', 'marker', 'linearGradient', 'radialGradient', 'filter', 'style', 'title', 'desc', 'metadata']);
const len = (v, ref = 0) => { if (v == null) return 0; const s = String(v).trim(); const n = parseFloat(s); if (!isFinite(n)) return 0; return s.endsWith('%') ? (n / 100) * ref : n; };
export const deepCopy = (subs) => subs.map((s) => ({ closed: s.closed, start: s.start && s.start.slice(), endsAtStart: s.endsAtStart, segs: s.segs.map((g) => ({ t: g.t, p: g.p.map((q) => q.slice()), ...(g.a ? { a: { ...g.a } } : {}), ...(g.implicit ? { implicit: true } : {}) })) }));
const freeze = (subs) => { const c = deepCopy(subs); for (const s of c) { for (const g of s.segs) { g.p.forEach(Object.freeze); Object.freeze(g.p); Object.freeze(g); } Object.freeze(s.segs); Object.freeze(s); } return Object.freeze(c); };

export function loadSVG(text) {
  if (text.length > 25 * 1024 * 1024) throw new Error('File is larger than 25 MB');
  const { root, removed: xmlRemoved, elements } = parseXML(text);
  const removed = [...xmlRemoved, ...sanitize(root)];
  const doc = buildModel(root, { removed, elementCount: elements, bytes: text.length });
  // the input exactly as given: the browser reference for the final validation
  doc.sourceText = text;
  return doc;
}

export function buildModel(root, info = {}) {
  const rules = parseSheets(root);
  const vbA = (getAttr(root, 'viewBox') || '').split(/[\s,]+/).filter(Boolean).map(Number);
  const W = getAttr(root, 'width'), H = getAttr(root, 'height');
  const viewBox = vbA.length === 4 && vbA.every(isFinite) && vbA[2] > 0 && vbA[3] > 0 ? vbA : [0, 0, parseLength(W) > 0 ? parseLength(W) : 300, parseLength(H) > 0 ? parseLength(H) : 150];
  const ids = new Map(), warnings = [];
  for (const el of walk(root)) { const id = getAttr(el, 'id'); if (id != null) { if (ids.has(id)) warnings.push(`duplicate id "${id}"`); else ids.set(id, el); } }

  const doc = { root, viewBox, width: W, height: H, rules, ids, elements: [], gradients: new Map(), clips: new Map(), masks: new Map(), warnings, removed: info.removed || [], bytes: info.bytes || 0, elementCount: info.elementCount || 0, unsupported: {} };
  const note = (k) => { doc.unsupported[k] = (doc.unsupported[k] || 0) + 1; };

  // gradients: mean colour for rendering (the gradient itself is always kept)
  for (const el of walk(root)) {
    const t = localName(el.name);
    if (t === 'linearGradient' || t === 'radialGradient') doc.gradients.set(getAttr(el, 'id'), el);
  }

  let order = 0;
  // chain: the ancestors painted as isolated layers (opacity < 1 or a mask), outer first
  // vp: size of the nearest viewport in current user units (percentages resolve on it)
  const visit = (el, style, ctm, opacity, clips, masks, inRes, chain = [], vp = [viewBox[2], viewBox[3]]) => {
    const tag = localName(el.name);
    if (tag !== 'svg' && RESOURCES.has(tag)) {
      // resources are rendered only through references
      if (tag === 'defs' || tag === 'symbol') { for (const c of el.children) if (c.type === 'el' && ['clipPath', 'mask', 'defs'].includes(localName(c.name))) visit(c, style, ctm, opacity, clips, masks, true); return; }
      if (tag === 'clipPath' || tag === 'mask') {
        const id = getAttr(el, 'id'), own = computed(el, rules, null);
        const tfs = getAttr(el, 'transform'), tf = tfs != null ? parseTransform(tfs) : I;
        const res = {
          node: el, els: [], unsupported: [],
          units: getAttr(el, tag === 'clipPath' ? 'clipPathUnits' : 'maskContentUnits') === 'objectBoundingBox' ? 'objectBoundingBox' : 'userSpaceOnUse',
          regionUnits: tag === 'mask' && getAttr(el, 'maskUnits') === 'userSpaceOnUse' ? 'userSpaceOnUse' : 'objectBoundingBox',
          region: tag === 'mask' ? ['x', 'y', 'width', 'height'].map((k) => getAttr(el, k)) : null,
          type: tag === 'mask' && (own['mask-type'] || '').trim() === 'alpha' ? 'alpha' : 'luminance',
          tf: tf || I, clipRef: tag === 'clipPath' && own['clip-path'] && own['clip-path'] !== 'none' ? refId(own['clip-path']) : null,
        };
        if (!tf) res.unsupported.push('unreadable transform on the resource');
        if (tag === 'mask' && tfs != null) res.unsupported.push('transform on <mask>');
        if (tag === 'mask' && own['clip-path'] && own['clip-path'] !== 'none') res.unsupported.push('clip-path on <mask>');
        const drawn = (n) => [...walk(n)].filter((k) => SHAPES.has(localName(k.name))).length;
        // children, with their own opacity; everything that is not modelled is recorded
        const inner = (c, st, m, op) => {
          for (const k of c.children) if (k.type === 'el') {
            const kt = localName(k.name), s2 = computed(k, rules, st);
            if (s2.display === 'none') continue;
            const ks = getAttr(k, 'transform'), t = ks != null ? parseTransform(ks) : I;
            if (!t) { res.unsupported.push(`unreadable transform on <${kt}>`); continue; }
            const m2 = mult(m, t), o2 = op * (s2.opacity != null ? clamp01(s2.opacity) : 1);
            for (const p of ['filter', 'mask', 'clip-path']) if (s2[p] && s2[p] !== 'none') res.unsupported.push(`${p} on <${kt}> inside <${tag}>`);
            if (s2['mix-blend-mode'] && s2['mix-blend-mode'] !== 'normal') res.unsupported.push('blend mode inside');
            if (kt === 'g' || kt === 'a') { if (tag === 'mask' && o2 < op && drawn(k) > 1) res.unsupported.push('group opacity inside <mask>'); inner(k, s2, m2, o2); }
            else if (kt === 'text' || kt === 'image' || kt === 'use' || kt === 'svg' || kt === 'switch' || kt === 'foreignObject') res.unsupported.push(`<${kt}> inside <${tag}>`);
            else if (SHAPES.has(kt)) {
              const e = makeElement(k, kt, s2, m2, tag === 'mask' ? o2 : 1, [], [], doc, -1);
              if (!e) continue;
              if (tag === 'mask') for (const w of ['fill', 'stroke']) { const p = e[w]; if (p && (p.kind === 'pattern' || p.unknown || (p.kind === 'gradient' && (!p.grad || p.grad.unknown)))) res.unsupported.push(`${w} paint of a <${kt}> inside <mask>`); }
              if (tag === 'mask' && e.fill.kind !== 'none' && e.stroke.kind !== 'none' && e.opacity < 1) res.unsupported.push('opacity on fill + stroke inside <mask>');
              if (tag === 'mask' && s2['stroke-dasharray'] && s2['stroke-dasharray'] !== 'none' && e.stroke.kind !== 'none') { /* dashes are drawn */ }
              for (const mk of ['marker-start', 'marker-mid', 'marker-end']) if (s2[mk] && s2[mk] !== 'none') res.unsupported.push(`marker inside <${tag}>`);
              res.els.push(e);
            }
          }
        };
        inner(el, own, I, 1);
        if (id) (tag === 'clipPath' ? doc.clips : doc.masks).set(id, res);
      }
      return;
    }
    const st = computed(el, rules, style);
    if (st.display === 'none') return;
    const tf = getAttr(el, 'transform');
    let t = I;
    if (tf) { const p = parseTransform(tf); if (!p) warnings.push(`unreadable transform "${tf.slice(0, 40)}"`); else t = p; }
    let m = mult(ctm, t);
    let vpClip = null, vp2 = vp;
    if (tag === 'svg' && el !== root) {
      // nested <svg>: its viewport (x, y, width, height; percentages of the parent
      // viewport), its viewBox with preserveAspectRatio, and overflow clipping (hidden
      // by default for a nested <svg>)
      const vr = viewportOf(el, vp);
      if (!vr) return;                                        // zero-size viewport: not rendered
      const ov = (st.overflow || 'hidden').trim();
      if (ov === 'hidden' || ov === 'scroll' || ov === 'clip') vpClip = { rect: vr.rect, ctm: m, node: el };
      m = mult(m, vr.m); vp2 = vr.vp;
    }
    const op = opacity * (st.opacity != null ? Math.max(0, Math.min(1, parseFloat(st.opacity))) : 1);
    let cp = st['clip-path'] && st['clip-path'] !== 'none' ? [...clips, { ref: refId(st['clip-path']), ctm: m, node: el }] : clips;
    if (vpClip) cp = [...cp, vpClip];
    const mk = st.mask && st.mask !== 'none' ? [...masks, { ref: refId(st.mask), ctm: m, node: el }] : masks;
    const ownOp = st.opacity != null ? clamp01(st.opacity) : 1, ownMask = mk !== masks ? [mk[mk.length - 1]] : [];
    if (tag === 'svg' || tag === 'g' || tag === 'a' || tag === 'switch') {
      const ch = ownOp < 1 || ownMask.length ? [...chain, { node: el, opacity: ownOp, masks: ownMask, ctm: m }] : chain;
      for (const c of el.children) if (c.type === 'el') visit(c, st, m, op, cp, mk, inRes, ch, vp2);
      return;
    }
    if (!SHAPES.has(tag)) { note(`<${tag}>`); return; }
    if (tag === 'text' || tag === 'image') { note(`<${tag}>`); doc.elements.push({ idx: doc.elements.length, node: el, tag, order: order++, style: st, ctm: m, subpaths: [], orig: [], editable: false, reason: `<${tag}> is kept as is`, render: false, opacity: op, clips: cp, masks: mk }); return; }
    const e = makeElement(el, tag, st, m, op, cp, mk, doc, order++);
    if (e) {
      e.idx = doc.elements.length; doc.elements.push(e);
      // fill and stroke overlap: with opacity or a mask the element is its own layer
      const both = e.fill && e.stroke && e.fill.kind !== 'none' && e.stroke.kind !== 'none';
      if (both && (ownOp < 1 || ownMask.length)) { e.chain = [...chain, { node: el, opacity: ownOp, masks: ownMask, ctm: m }]; e.leafOpacity = 1; e.leafMasks = []; }
      else { e.chain = chain; e.leafOpacity = ownOp; e.leafMasks = ownMask; }
    }
  };
  visit(root, null, I, 1, [], [], false);
  assessDoc(doc);
  return doc;
}

const refId = (v) => { const m = /url\(\s*['"]?#([^'")\s]+)/.exec(v || ''); return m ? m[1] : null; };

// Viewport of a nested <svg> / used <symbol>: its rectangle in the parent's user space,
// the map from its own user space, and its size for percentages. null: zero size.
function viewportOf(el, vp, over = {}) {
  const L = (k, ref, d) => { const v = parseLength(over[k] ?? getAttr(el, k), ref); return v == null ? d : v; };
  const x = L('x', vp[0], 0), y = L('y', vp[1], 0), w = L('width', vp[0], vp[0]), h = L('height', vp[1], vp[1]);
  if (!(w > 0 && h > 0)) return null;
  const vb = (getAttr(el, 'viewBox') || '').split(/[\s,]+/).filter(Boolean).map(Number);
  let m = [1, 0, 0, 1, x, y], size = [w, h];
  if (vb.length === 4 && vb.every(isFinite) && vb[2] > 0 && vb[3] > 0) { m = mult(m, viewBoxTransform(vb, w, h, parsePAR(getAttr(el, 'preserveAspectRatio')) || parsePAR(''))); size = [vb[2], vb[3]]; }
  return { rect: [x, y, w, h], m, vp: size };
}

export function paintOf(v, doc, style = null) {
  if (!v || v === 'none') return { kind: 'none' };
  // currentColor is the inherited `color` property (black when none is set)
  if (/^currentcolor$/i.test(v.trim())) v = (style && style.color && !/^currentcolor$/i.test(style.color) ? style.color : '#000000');
  const r = refId(v);
  if (r) {
    const g = doc.gradients.get(r);
    if (g) { const grad = resolveGradient(g, doc); return { kind: 'gradient', ref: r, rgb: gradientMean(g, doc), units: grad.units, grad }; }
    const fb = v.replace(/url\([^)]*\)/, '').trim();
    return { kind: 'pattern', ref: r, rgb: (parseColor(fb) || [128, 128, 128, 1]) };
  }
  const c = parseColor(v);
  return c ? { kind: 'solid', rgb: c } : { kind: 'solid', rgb: [0, 0, 0, 1], unknown: v };
}
function gradientMean(g, doc, depth = 0) {
  let stops = g.children.filter((c) => c.type === 'el' && localName(c.name) === 'stop');
  if (!stops.length && depth < 8) {
    const h = getAttr(g, 'href') || getAttr(g, 'xlink:href');
    const tgt = h && doc.gradients.get(h.replace(/^#/, ''));
    if (tgt) return gradientMean(tgt, doc, depth + 1);
  }
  if (!stops.length) return [0, 0, 0, 0];
  const acc = [0, 0, 0, 0];
  for (const s of stops) {
    const st = computed(s, doc.rules, null);
    const c = parseColor(st['stop-color'] || getAttr(s, 'stop-color') || '#000') || [0, 0, 0, 1];
    const o = parseFloat(st['stop-opacity'] ?? getAttr(s, 'stop-opacity') ?? '1');
    acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2]; acc[3] += c[3] * (isFinite(o) ? o : 1);
  }
  return acc.map((v) => v / stops.length);
}

function makeElement(el, tag, st, m, op, clips, masks, doc, order) {
  let subpaths = [], errors = [], editable = true, reason = '', stats = null;
  const A = (k) => getAttr(el, k);
  if (tag === 'path') { const r = parsePath(A('d') || ''); subpaths = r.subpaths; errors = r.errors; stats = r.stats; }
  else if (tag === 'rect') { subpaths = rectSubpaths(len(A('x')), len(A('y')), len(A('width'), doc.viewBox[2]), len(A('height'), doc.viewBox[3]), A('rx'), A('ry')); editable = false; reason = 'already an exact rectangle'; }
  else if (tag === 'circle') { const r = len(A('r')); subpaths = ellipseSubpaths(len(A('cx')), len(A('cy')), r, r); editable = false; reason = 'already an exact circle'; }
  else if (tag === 'ellipse') { subpaths = ellipseSubpaths(len(A('cx')), len(A('cy')), len(A('rx')), len(A('ry'))); editable = false; reason = 'already an exact ellipse'; }
  else if (tag === 'line') { subpaths = [{ closed: false, start: [len(A('x1')), len(A('y1'))], segs: [{ t: 'L', p: [[len(A('x1')), len(A('y1'))], [len(A('x2')), len(A('y2'))]] }] }]; editable = false; reason = 'a single line'; }
  else if (tag === 'polyline' || tag === 'polygon') {
    const n = (A('points') || '').match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) || [];
    const pts = [];
    for (let i = 0; i + 1 < n.length; i += 2) pts.push([+n[i], +n[i + 1]]);
    if (n.length % 2) errors.push('odd number of coordinates in points');
    const segs = [];
    for (let i = 1; i < pts.length; i++) segs.push({ t: 'L', p: [pts[i - 1], pts[i]] });
    if (tag === 'polygon' && pts.length > 1) segs.push({ t: 'L', p: [pts[pts.length - 1], pts[0]], implicit: true });
    subpaths = pts.length ? [{ closed: tag === 'polygon', start: pts[0], segs }] : [];
  } else if (tag === 'use') {
    const h = (A('href') || A('xlink:href') || '').replace(/^#/, '');
    const tgt = doc.ids.get(h);
    editable = false; reason = '<use> copy (the referenced shape is kept as is)';
    if (tgt && localName(tgt.name) !== 'use') {
      const tt = localName(tgt.name), ts = computed(tgt, doc.rules, st);
      let tm = mult(m, [1, 0, 0, 1, len(A('x')), len(A('y'))]), pclips = clips;
      if (tt === 'symbol') {
        // a used <symbol> is a viewport: the use's width / height (default 100%), the
        // symbol's viewBox and preserveAspectRatio, clipped unless overflow is visible
        const vr = viewportOf(tgt, [doc.viewBox[2], doc.viewBox[3]], { x: '0', y: '0', width: A('width'), height: A('height') });
        if (!vr) return { node: el, tag, order, style: st, ctm: m, subpaths: [], orig: [], editable, reason, render: false, opacity: op, clips, masks };
        const ov = (ts.overflow || 'hidden').trim();
        if (ov === 'hidden' || ov === 'scroll' || ov === 'clip') pclips = [...clips, { rect: vr.rect, ctm: tm, node: el }];
        tm = mult(tm, vr.m);
      } else tm = mult(tm, parseTransform(getAttr(tgt, 'transform')) || I);
      if (tt === 'symbol' || tt === 'g') {
        // the content, with every nested transform and inherited style (validation only)
        const parts = [];
        const walkIn = (n, style, mm) => {
          for (const k of n.children) if (k.type === 'el') {
            const kt = localName(k.name), ks = computed(k, doc.rules, style);
            if (ks.display === 'none') continue;
            const mk2 = mult(mm, parseTransform(getAttr(k, 'transform')) || I);
            if (kt === 'g' || kt === 'a') walkIn(k, ks, mk2);
            else if (SHAPES.has(kt) && kt !== 'use' && kt !== 'text' && kt !== 'image') { const e = makeElement(k, kt, ks, mk2, op * (ks.opacity != null ? clamp01(ks.opacity) : 1), pclips, masks, doc, -1); if (e) parts.push(e); }
          }
        };
        walkIn(tgt, ts, tm);
        return { node: el, tag, order, style: st, ctm: m, subpaths: [], orig: [], editable, reason, render: true, parts, opacity: op, fullOpacity: op, clips, masks, fill: { kind: 'none' }, stroke: { kind: 'none' } };
      }
      const e = makeElement(tgt, tt, ts, tm, op, clips, masks, doc, -1);
      return e && { ...e, node: el, tag, order, editable, reason, parts: [e], subpaths: [], orig: [], fullOpacity: op };
    }
    return { node: el, tag, order, style: st, ctm: m, subpaths: [], orig: [], editable: false, reason: 'broken <use> reference', render: false, opacity: op, clips, masks };
  }
  const sw = len(st['stroke-width']);
  const e = {
    node: el, tag, order, id: A('id'), style: st, ctm: m, scale: scaleOf(m),
    subpaths, orig: freeze(subpaths), errors, stats,
    fill: paintOf(st.fill, doc, st), stroke: paintOf(st.stroke, doc, st),
    fillOpacity: clamp01(st['fill-opacity']), strokeOpacity: clamp01(st['stroke-opacity']),
    strokeWidth: sw, rule: st['fill-rule'] === 'evenodd' ? 'evenodd' : 'nonzero',
    opacity: op, clips, masks, editable, reason, render: st.visibility !== 'hidden' && st.visibility !== 'collapse',
  };
  if (editable) {
    if (errors.length) { e.editable = false; e.reason = 'path data has errors (kept exactly as written)'; }
    else if (st['stroke-dasharray'] && st['stroke-dasharray'] !== 'none' && e.stroke.kind !== 'none') { e.editable = false; e.reason = 'dashed stroke depends on exact path length'; }
    else if (A('marker-start') || A('marker-mid') || A('marker-end') || st['marker-start'] || st['marker-mid'] || st['marker-end']) { e.editable = false; e.reason = 'markers are placed on the nodes'; }
    else if (el.parent && [...ancestors(el)].some((a) => RESOURCES.has(localName(a.name)))) { e.editable = false; e.reason = 'inside a resource'; }
  }
  return e;
}
function* ancestors(el) { for (let p = el.parent; p; p = p.parent) yield p; }
const clamp01 = (v) => { const n = parseFloat(v ?? '1'); return isFinite(n) ? Math.max(0, Math.min(1, n)) : 1; };

export function rectSubpaths(x, y, w, h, rxA, ryA) {
  if (!(w > 0 && h > 0)) return [];
  let rx = rxA != null ? len(rxA, w) : null, ry = ryA != null ? len(ryA, h) : null;
  if (rx == null) rx = ry ?? 0; if (ry == null) ry = rx;
  rx = Math.min(rx, w / 2); ry = Math.min(ry, h / 2);
  if (!rx || !ry) {
    const P = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
    return [{ closed: true, start: P[0], segs: P.map((p, i) => ({ t: 'L', p: [p, P[(i + 1) % 4]], ...(i === 3 ? { implicit: true } : {}) })) }];
  }
  const a = (p0, p1) => ({ t: 'A', p: [p0, p1], a: { rx, ry, rot: 0, large: 0, sweep: 1 } }), l = (p0, p1) => ({ t: 'L', p: [p0, p1] });
  const P = [[x + rx, y], [x + w - rx, y], [x + w, y + ry], [x + w, y + h - ry], [x + w - rx, y + h], [x + rx, y + h], [x, y + h - ry], [x, y + ry]];
  return [{ closed: true, start: P[0], segs: [l(P[0], P[1]), a(P[1], P[2]), l(P[2], P[3]), a(P[3], P[4]), l(P[4], P[5]), a(P[5], P[6]), l(P[6], P[7]), a(P[7], P[0])] }];
}
export function ellipseSubpaths(cx, cy, rx, ry) {
  if (!(rx > 0 && ry > 0)) return [];
  const P = [[cx + rx, cy], [cx, cy + ry], [cx - rx, cy], [cx, cy - ry]];
  return [{ closed: true, start: P[0], segs: P.map((p, i) => ({ t: 'A', p: [p, P[(i + 1) % 4]], a: { rx, ry, rot: 0, large: 0, sweep: 1 } })) }];
}

// Bounding box of an element in root user space (geometry only, strokes widen it).
export function elementBox(e, subs = e.subpaths) {
  let pts = [];
  // flatten() gives segment starts only: the end point of an open subpath is added
  for (const sp of subs) { const f = flatten(expand(sp.segs), 0.5); for (const p of f) pts.push(apply(e.ctm, p)); if (sp.segs.length) pts.push(apply(e.ctm, sp.segs[sp.segs.length - 1].p.at(-1))); else if (sp.start) pts.push(apply(e.ctm, sp.start)); }
  if (e.parts) for (const q of e.parts) { const b = elementBox(q); if (isFinite(b[0])) pts.push([b[0], b[1]], [b[2], b[3]]); }
  if (!pts.length) return [Infinity, Infinity, -Infinity, -Infinity];
  // stroke reach: half the width, stretched by the largest scale of the transform, times
  // the miter limit (miter joins) or sqrt(2) (square caps)
  const st = e.style || {}, reach = (st['stroke-linejoin'] || 'miter') === 'miter' ? Math.max(1, parseFloat(st['stroke-miterlimit']) || 4) : 1;
  const b = bbox(pts), w = e.stroke && e.stroke.kind !== 'none' ? (e.strokeWidth / 2) * maxScale(e.ctm) * Math.max(reach, st['stroke-linecap'] === 'square' ? Math.SQRT2 : 1) : 0;
  return [b[0] - w, b[1] - w, b[2] + w, b[3] + w];
}
export { cloneTree, serialize, setAttr, delAttr, getAttr };
