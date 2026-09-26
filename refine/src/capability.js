// Capability / protection system.
// PRESERVE FIRST. UNKNOWN = DO NOT MODIFY. UNSUPPORTED FEATURE = PROTECT.
// Every element gets a support level from what the reference renderer (raster.js CAPS)
// can draw exactly:
//   SUPPORTED            the geometry may be processed
//   PARTIALLY_SUPPORTED  processed with restrictions (listed in support.restrict)
//   UNSUPPORTED          locked: never modified, never removed, never merged or flattened
// Anything the renderer cannot draw exactly also marks where it paints as an uncertain
// region: a candidate whose change touches such a region is rejected, because the
// validation render there would be incomplete.
import { declared } from './css.js';
import { getAttr, localName, walk, textOf } from './xml.js';
import { parseTransform, apply, isUniform } from './matrix.js';
import { CAPS } from './raster.js';
import { elementBox } from './model.js';

export const SUPPORTED = 'SUPPORTED', PARTIAL = 'PARTIALLY_SUPPORTED', UNSUPPORTED = 'UNSUPPORTED';
export const ALL = Object.freeze([-Infinity, -Infinity, Infinity, Infinity]);

const ANIM = new Set(['animate', 'set', 'animateTransform', 'animateMotion', 'animateColor']);
const DRAWN = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'use', 'text', 'image']);
const CONDITIONAL = ['systemLanguage', 'requiredFeatures', 'requiredExtensions'];
const refId = (v) => { const m = /url\(\s*['"]?#([^'")\s]+)/.exec(v || ''); return m ? m[1] : null; };
const hrefOf = (n) => getAttr(n, 'href') ?? getAttr(n, 'xlink:href');
const nums = (v) => (String(v || '').match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) || []).map(Number);
const hasUnits = (v) => v != null && /[a-df-z%]/i.test(String(v).replace(/\d[eE][-+]?\d/g, '0'));
const isNone = (v) => v == null || v === '' || v === 'none';
export const boxesTouch = (a, b) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
const union = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
const grow = (b, d) => [b[0] - d, b[1] - d, b[2] + d, b[3] + d];
const mapBox = (m, x0, y0, x1, y1) => { const P = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map((p) => apply(m, p)); return [Math.min(...P.map((p) => p[0])), Math.min(...P.map((p) => p[1])), Math.max(...P.map((p) => p[0])), Math.max(...P.map((p) => p[1]))]; };

export function assessDoc(doc) {
  const regions = [];
  const cache = new Map();
  const decl = (n) => { let d = cache.get(n); if (!d) { d = declared(n, doc.rules); cache.set(n, d); } return d; };
  const vbSize = Math.max(doc.viewBox[2], doc.viewBox[3]);

  // nodes that are animated, and nodes whose geometry another element copies
  const animated = new Set(), copied = new Set();
  for (const n of walk(doc.root)) {
    const t = localName(n.name);
    if (ANIM.has(t)) { const h = hrefOf(n); const tgt = h && h.startsWith('#') ? doc.ids.get(h.slice(1)) : n.parent; if (tgt) animated.add(tgt); }
    if (t === 'use' || t === 'textPath' || t === 'mpath' || t === 'tref') { const h = hrefOf(n); const tgt = h && doc.ids.get(h.replace(/^#/, '')); if (tgt) for (const k of walk(tgt)) copied.add(k); }
  }
  // elements under every node (group-level regions: filter / mask / opacity on a <g>)
  const under = new Map();
  for (const e of doc.elements) for (let n = e.node; n; n = n.parent) { let l = under.get(n); if (!l) under.set(n, (l = [])); l.push(e); }
  const extentCache = new Map();
  const extent = (e) => { let b = extentCache.get(e); if (!b) { b = elementExtent(e, decl); extentCache.set(e, b); } return b; };
  const nodeBox = (n) => (under.get(n) || []).reduce((b, e) => union(b, extent(e)), [Infinity, Infinity, -Infinity, -Infinity]);

  // document-wide: a cascade that cannot be evaluated exactly makes every style unknown
  const inlineImportant = [...walk(doc.root)].some((n) => /!\s*important/i.test(getAttr(n, 'style') || ''));
  const docReasons = [];
  if (doc.rules.unsupported && doc.rules.unsupported.length) docReasons.push({ code: 'css-selector', text: `stylesheet rule the cascade cannot evaluate (${doc.rules.unsupported.slice(0, 3).join(', ')})` });
  if (doc.rules.important || inlineImportant) docReasons.push({ code: 'css-important', text: '!important declarations: the cascade order cannot be evaluated exactly' });
  if (docReasons.length) regions.push({ box: ALL, reason: docReasons[0].text, el: -1 });

  for (const e of doc.elements) {
    const reasons = [...docReasons], restrict = new Set();
    const lock = (code, text, box) => { reasons.push({ code, text }); if (box) regions.push({ box, reason: text, el: e.idx }); };
    const own = extent(e);
    // the element itself
    if (e.tag === 'text' && !CAPS.text) lock('text', '<text> is not drawn by the reference renderer (font metrics unknown)', own);
    if (e.tag === 'image' && !CAPS.image) lock('image', '<image> is not drawn by the reference renderer', own);
    if (e.tag === 'use') {
      const tgt = doc.ids.get((hrefOf(e.node) || '').replace(/^#/, ''));
      const tt = tgt && localName(tgt.name);
      if (!tgt) { /* a broken <use> draws nothing in browsers either */ }
      else if (tt === 'use' || tt === 'svg' || (tt === 'symbol' && !CAPS.nestedViewports)) lock('use-viewport', `<use> of <${tt}> is not drawn exactly`, ALL);
      else if (tgt && [...walk(tgt)].some((k) => ['text', 'image', 'use'].includes(localName(k.name)))) lock('use-content', '<use> copies text / image / use content', own);
    }
    if (copied.has(e.node)) lock('referenced', 'its geometry is copied by <use> / textPath elsewhere');
    // own paint
    for (const which of ['fill', 'stroke']) {
      const p = e[which];
      if (!p || p.kind === 'none') continue;
      if (which === 'stroke' && !(e.strokeWidth > 0)) continue;
      if (p.kind === 'pattern') {
        const tgt = doc.ids.get(p.ref);
        lock(tgt && localName(tgt.name) === 'pattern' ? 'pattern' : 'paint-ref', tgt && localName(tgt.name) === 'pattern' ? `${which} uses a pattern (not drawn exactly)` : `${which} references a missing paint server`, own);
      } else if (p.kind === 'gradient') {
        if (!CAPS.gradients) lock('gradient', `${which} gradient is drawn as its mean colour`, own);
        else if (!p.grad || p.grad.unknown) lock('gradient', `${which} gradient: ${p.grad ? p.grad.unknown : 'not resolved'}`, own);
        else if (p.units !== 'userSpaceOnUse') restrict.add('fixed-bbox');
      } else if (p.unknown) lock('paint-unknown', `${which} value "${String(p.unknown).slice(0, 30)}" is not understood`, own);
    }
    if (e.style) {
      for (const [k, v] of Object.entries(e.style)) if (typeof v === 'string' && /var\(|calc\(|env\(|attr\(|^\s*(initial|unset|revert)\s*$/i.test(v)) { lock('css-value', `${k}: "${v.slice(0, 30)}" cannot be resolved`, own); break; }
      const stroked = e.stroke && e.stroke.kind !== 'none' && e.strokeWidth > 0;
      if (stroked && e.style['vector-effect'] && e.style['vector-effect'] !== 'none' && !CAPS.nonScalingStroke) lock('vector-effect', `vector-effect: ${e.style['vector-effect']} is not drawn exactly`, grow(own, 10 * e.strokeWidth * Math.max(e.scale || 1, 1 / (e.scale || 1))));
      if (stroked && !isUniform(e.ctm) && !CAPS.affineStroke) lock('stroke-transform', 'stroke under a non-uniform scale or skew is not drawn exactly', own);
      if (stroked && !isNone(e.style['stroke-dasharray'])) { lock('dash', 'dashed stroke depends on the exact path length'); if (!CAPS.dashes) regions.push({ box: own, reason: 'dashes are drawn solid', el: e.idx }); }
      const markers = ['marker-start', 'marker-mid', 'marker-end'].map((k) => e.style[k]).filter((v) => !isNone(v));
      if (markers.length && DRAWN.has(e.tag) && e.tag !== 'text' && e.tag !== 'image') lock('marker', 'markers are placed on the nodes and not drawn by the renderer', markerRegion(doc, e, markers, own));
      if (!isNone(e.style['mix-blend-mode']) && e.style['mix-blend-mode'] !== 'normal') lock('blend', `mix-blend-mode: ${e.style['mix-blend-mode']}`, own);
      if (e.style.opacity != null && parseFloat(e.style.opacity) < 1 && e.fill && e.fill.kind !== 'none' && stroked && !CAPS.groupOpacity) lock('opacity-group', 'opacity on a shape with fill and stroke needs group compositing', own);
    }
    // the element and its ancestors
    for (let n = e.node; n; n = n.parent) {
      const t = localName(n.name), d = decl(n), isSelf = n === e.node;
      const box = isSelf ? own : nodeBox(n);
      if (!isNone(d.filter)) lock('filter', `filter on ${isSelf ? 'the element' : `<${t}>`} (${String(d.filter).slice(0, 40)}) is not rendered`, filterRegion(doc, n, d.filter, box, vbSize));
      if (!isNone(d.mask)) { const why = maskSupport(doc, refId(d.mask), e, isSelf, (under.get(n) || []).length); if (why) lock('mask', why, box); }
      if (!isNone(d['clip-path'])) { const why = clipSupport(doc, d['clip-path'], decl, isSelf); if (why) lock('clip', why, box); }
      if (d.transform != null && !isNone(d.transform)) lock('css-transform', `CSS transform on <${t}> is not modelled`, ALL);
      if (d.animation || d['animation-name'] || d.transition) lock('animation', `CSS animation / transition on <${t}>`, ALL);
      if (animated.has(n)) lock('animation', `<${t}> is animated`, ALL);
      const tf = getAttr(n, 'transform');
      if (tf != null && !parseTransform(tf)) lock('transform', `unreadable transform "${tf.slice(0, 30)}"`, ALL);
      if (CONDITIONAL.some((a) => getAttr(n, a) != null)) lock('conditional', `conditional processing attribute on <${t}>`, ALL);
      if (t === 'switch' && !CAPS.switchElement) lock('switch', '<switch> renders only its first matching child', ALL);
      if (t === 'svg' && n !== doc.root && !CAPS.nestedViewports) lock('nested-svg', 'nested <svg> viewport (viewBox / preserveAspectRatio / clipping) is not drawn exactly', ALL);
      if (!isSelf && d.opacity != null && parseFloat(d.opacity) < 1 && !CAPS.groupOpacity && (under.get(n) || []).length > 1) lock('opacity-group', `group opacity on <${t}> needs group compositing`, box);
      if (!isSelf && !isNone(d['mix-blend-mode']) && d['mix-blend-mode'] !== 'normal') lock('blend', `mix-blend-mode on <${t}>`, box);
    }
    const uniq = [];
    for (const r of reasons) if (!uniq.some((q) => q.code === r.code && q.text === r.text)) uniq.push(r);
    e.support = { level: uniq.length ? UNSUPPORTED : restrict.size ? PARTIAL : SUPPORTED, reasons: uniq, restrict: [...restrict] };
    e.locked = uniq.length > 0;
    if (e.locked && e.editable) { e.editable = false; e.reason = `protected: ${uniq[0].text}`; }
  }
  doc.uncertain = regions;
  const summary = {};
  for (const e of doc.elements) for (const r of e.support.reasons) summary[r.code] = (summary[r.code] || 0) + 1;
  doc.capability = { summary, regions: regions.length, locked: doc.elements.filter((e) => e.locked).length };
  return doc.capability;
}

// Where an element can paint, in root user space (strokes included).
function elementExtent(e, decl) {
  if (e.tag === 'text') return textBox(e, decl);
  if (e.tag === 'image') {
    const n = e.node, w = getAttr(n, 'width'), h = getAttr(n, 'height');
    if (w == null || h == null || hasUnits(w) || hasUnits(h)) return ALL;
    const x = +nums(getAttr(n, 'x'))[0] || 0, y = +nums(getAttr(n, 'y'))[0] || 0;
    return mapBox(e.ctm, x, y, x + +w, y + +h);
  }
  const b = elementBox(e);
  return isFinite(b[0]) ? b : [Infinity, Infinity, -Infinity, -Infinity];
}
// Text without font metrics: a generous box around every anchor, wide enough for every
// character at the largest font size, on both sides (any text-anchor / direction).
function textBox(e, decl) {
  let fs = 0, chars = 0, slack = 0;
  const xs = [], ys = [];
  for (const n of walk(e.node)) {
    const t = localName(n.name);
    if (t === 'textPath' || getAttr(n, 'rotate') != null || getAttr(n, 'textLength') != null) return ALL;
    const f = n === e.node ? e.style['font-size'] : decl(n)['font-size'];
    if (f != null) { if (/%|em|ex|ch|vw|vh|vmin|vmax|larger|smaller|x-|medium|small|large/i.test(f)) return ALL; fs = Math.max(fs, parseFloat(f) || 0); }
    for (const k of ['x', 'y', 'dx', 'dy']) if (hasUnits(getAttr(n, k))) return ALL;
    xs.push(...nums(getAttr(n, 'x'))); ys.push(...nums(getAttr(n, 'y')));
    slack += nums(getAttr(n, 'dx')).concat(nums(getAttr(n, 'dy'))).reduce((a, v) => a + Math.abs(v), 0);
    for (const c of n.children) if (c.type === 'text') chars += c.value.trim().length;
  }
  fs = fs || parseFloat(e.style && e.style['font-size']) || 16;
  if (!xs.length) xs.push(0);
  if (!ys.length) ys.push(0);
  const W = chars * fs * 1.2 + slack + fs, x0 = Math.min(...xs) - W, x1 = Math.max(...xs) + W;
  const y0 = Math.min(...ys) - 1.6 * fs - slack, y1 = Math.max(...ys) + 0.8 * fs + slack;
  return mapBox(e.ctm, x0, y0, x1, y1);
}
// A filter's output is clipped to its filter region: that region is where it can paint.
function filterRegion(doc, node, value, box, vbSize) {
  // CSS filter functions (blur(), drop-shadow() ...) have no declared region
  if (!/^url\(\s*['"]?#[^'")\s]+['"]?\s*\)$/.test(String(value).trim())) return ALL;
  const f = doc.ids.get(refId(value));
  if (!f || localName(f.name) !== 'filter') return ALL;
  const units = getAttr(f, 'filterUnits') || 'objectBoundingBox';
  const A = (k, d) => { const v = getAttr(f, k); if (v == null) return d; const n = parseFloat(v); return isFinite(n) ? (String(v).trim().endsWith('%') ? n / 100 : n) : d; };
  if (units === 'userSpaceOnUse') {
    if (['x', 'y', 'width', 'height'].some((k) => getAttr(f, k) == null || String(getAttr(f, k)).includes('%'))) return ALL;
    // in the user space of the filtered element (a group's own space is not tracked)
    const m = ctmOfNode(doc, node);
    if (!m) return ALL;
    const x = A('x', 0), y = A('y', 0);
    return mapBox(m, x, y, x + A('width', 0), y + A('height', 0));
  }
  if (!box || !isFinite(box[0])) return ALL;
  const fx = A('x', -0.1), fy = A('y', -0.1), fw = A('width', 1.2), fh = A('height', 1.2);
  const w = box[2] - box[0], h = box[3] - box[1], D = Math.max(w, h);
  // conservative under rotation: every extension measured on the larger side
  return [box[0] - Math.max(0, -fx) * D, box[1] - Math.max(0, -fy) * D, box[2] + Math.max(0, fx + fw - 1) * D, box[3] + Math.max(0, fy + fh - 1) * D];
}
function ctmOfNode(doc, node) {
  for (const e of doc.elements) if (e.node === node) return e.ctm;
  return null;
}
function markerRegion(doc, e, refs, own) {
  let size = 0;
  for (const v of refs) {
    const m = doc.ids.get(refId(v));
    if (!m || localName(m.name) !== 'marker') continue;
    if ((getAttr(m, 'overflow') || declared(m, doc.rules).overflow || '').match(/visible|auto/)) return ALL;
    const mw = parseFloat(getAttr(m, 'markerWidth') ?? '3'), mh = parseFloat(getAttr(m, 'markerHeight') ?? '3');
    const k = (getAttr(m, 'markerUnits') || 'strokeWidth') === 'strokeWidth' ? e.strokeWidth || 1 : 1;
    size = Math.max(size, Math.hypot(mw, mh) * k * (e.scale || 1));
  }
  return isFinite(own[0]) ? grow(own, size * 2 + 1) : ALL;
}
function maskSupport(doc, ref, e, isSelf, drawnUnder) {
  const res = ref && doc.masks.get(ref);
  if (!res) return 'mask reference is missing (browsers do not agree on the result)';
  if (!CAPS.masks) return 'mask rendering (units, region, mask-type) is approximate';
  if (res.unsupported.length) return `mask content: ${res.unsupported[0]}`;
  if (!isSelf && drawnUnder > 1 && !CAPS.groupOpacity) return 'mask on a group needs group compositing';
  if (isSelf && e.fill && e.stroke && e.fill.kind !== 'none' && e.stroke.kind !== 'none' && !CAPS.groupOpacity) return 'mask on fill + stroke needs group compositing';
  return null;
}
// Feature safety check of a candidate: which uncertain region does its change touch?
export function touchesUncertain(doc, box, selfIdx) {
  if (!doc.uncertain || !box || !isFinite(box[0])) return null;
  for (const r of doc.uncertain) if (r.el !== selfIdx && boxesTouch(r.box, box)) return r;
  return null;
}

function clipSupport(doc, value, decl, isSelf) {
  const ref = refId(value);
  if (!ref) return `clip-path "${String(value).slice(0, 30)}" (CSS shape) is not modelled`;
  const seen = new Set();
  for (let r = ref; r && !seen.has(r); ) {
    seen.add(r);
    const res = doc.clips.get(r);
    if (!res) return r === ref ? 'clip-path reference is missing' : 'nested clip-path reference is missing';
    if (res.unsupported.length) return `clipPath content: ${res.unsupported[0]}`;
    if (res.units === 'objectBoundingBox' && (!CAPS.clipBBoxUnits || !isSelf)) return 'clipPathUnits="objectBoundingBox" on a group (group box not tracked)';
    r = res.clipRef;
  }
  return null;
}
