// Analysis of the input: what is in the file, how complex every path is, and where
// the geometry is not clean. Nothing is changed here.
import { createContext, visiblePixels, resetDoc } from './engine.js';
import { complexity, nodeTypes, segLength, tanIn, tanOut, recognize, organicScore, topology, polyOf, sampleNative, symmetry } from './features.js';
import { selfIntersections, turnDeg, lineDeviation, dist, bbox, polyArea } from './geom.js';
import { walk, localName } from './xml.js';

export function analyzeDoc(doc, S) {
  resetDoc(doc);
  const ctx = createContext(doc, S);
  const u = ctx.u, issues = [], elements = [];
  const counts = {};
  const add = (kind, it) => { counts[kind] = (counts[kind] || 0) + (it.count || 1); if (issues.length < 3000) issues.push({ kind, ...it }); };
  let totalNodes = 0, drawn = 0, shown = 0;
  const tags = {};
  for (const el of walk(doc.root)) { const t = localName(el.name); tags[t] = (tags[t] || 0) + 1; }
  for (const e of doc.elements) {
    if (!e.subpaths.length && !e.parts) { elements.push({ idx: e.idx, tag: e.tag, id: e.id, editable: false, reason: e.reason }); continue; }
    const ul = u / (e.scale || 1);
    const cx = complexity(e, u);
    totalNodes += cx.nodes;
    const subs = [];
    let micro = 0, dup = 0, col = 0, kinks = 0, selfx = 0, hiddenSubs = 0, near = [];
    e.subpaths.forEach((sp, si) => {
      const where = { el: e.idx, sub: si };
      const size = (() => { const b = bbox(sp.segs.flatMap((g) => g.p)); return Math.max(b[2] - b[0], b[3] - b[1]); })();
      const microT = Math.min(S.micro * ul, 0.02 * size);
      let m = 0, d = 0, c = 0, k = 0;
      const n = sp.segs.length;
      sp.segs.forEach((g, i) => {
        const L = segLength(g);
        if (L === 0) d++;
        else if (L < 0.02 * ul) d++;
        else if (L < microT) m++;
        if (i > 0 || sp.closed) {
          const prev = sp.segs[(i - 1 + n) % n], ang = turnDeg(tanOut(prev), tanIn(g));
          if (ang > 2 && ang < S.cornerAngle) k++;
          if (prev.t === 'L' && g.t === 'L' && lineDeviation([g.p[0]], prev.p[0], g.p[1]) < S.simplify * ul * 0.5) c++;
        }
      });
      micro += m; dup += d; col += c; kinks += k;
      if (m) add('micro-segments', { ...where, count: m, text: `${m} segment(s) shorter than ${(microT * (e.scale || 1) / u / 10).toFixed(2)}% of the artwork` });
      if (d) add('duplicate-points', { ...where, count: d, text: `${d} zero-length or duplicate node(s)` });
      if (c) add('collinear-points', { ...where, count: c, text: `${c} node(s) on a straight line` });
      if (k) add('kinks', { ...where, count: k, text: `${k} slightly broken join(s) (between 2° and ${S.cornerAngle}°)` });
      let vis = null;
      if (e.fill.kind !== 'none' && sp.closed) {
        const v = visiblePixels(ctx, e, sp);
        drawn += v.total; shown += v.visible;
        vis = v.total ? v.visible / v.total : 0;
        if (v.visible <= 1 && v.total > 0) { hiddenSubs++; add('hidden', { ...where, text: 'completely covered by shapes above' }); }
      }
      if (sp.closed && e.fill.kind !== 'none') { const x = selfIntersections(polyOf(sp, 0.25 * ul), 50); if (x) { selfx += x; add('self-intersections', { ...where, count: x, text: `${x} self-intersection(s) (${e.rule} fill)` }); } }
      if (!sp.closed && e.fill.kind !== 'none' && sp.segs.length > 1 && e.stroke.kind === 'none') add('open-contour', { ...where, text: 'open contour in a filled shape (closed implicitly)' });
      const rec = sp.closed ? recognize(sp, ul) : [];
      const org = organicScore(sp, ul, rec);
      if (rec[0] && rec[0].confidence > 0.9 && sp.segs.length > ({ circle: 2, ellipse: 2, rectangle: 4, triangle: 3 }[rec[0].kind] || 4) && org <= 0.5) add('near-primitive', { ...where, text: `almost a perfect ${rec[0].kind} (${(rec[0].confidence * 100).toFixed(0)}%) drawn with ${sp.segs.length} segments` });
      const types = nodeTypes(sp, ul);
      subs.push({ segs: sp.segs.length, closed: sp.closed, size: +(size * (e.scale || 1)).toFixed(2), visible: vis == null ? null : +vis.toFixed(3), organic: +org.toFixed(2), shape: rec[0] ? { kind: rec[0].kind, confidence: +rec[0].confidence.toFixed(3) } : null, corners: { sharp: types.filter((t) => t.type === 'sharp').length, soft: types.filter((t) => t.type === 'soft').length, rounded: types.filter((t) => t.rounded).length, smooth: types.filter((t) => t.type === 'smooth' || t.type === 'transition').length } });
    });
    const topo = topology(e.subpaths, e.rule, ul);
    elements.push({ idx: e.idx, tag: e.tag, id: e.id, fill: e.fill.kind === 'solid' ? rgbHex(e.fill.rgb) : e.fill.kind, stroke: e.stroke.kind === 'solid' ? rgbHex(e.stroke.rgb) : e.stroke.kind, strokeWidth: e.strokeWidth, rule: e.rule, transform: e.ctm.join(',') !== '1,0,0,1,0,0', editable: e.editable, reason: e.reason, complexity: cx, topology: { contours: topo.contours, holes: topo.holes, components: topo.components }, micro, duplicates: dup, collinear: col, kinks, selfIntersections: selfx, hiddenContours: hiddenSubs, subs });
  }
  for (const [k, v] of Object.entries(doc.unsupported)) add('unsupported', { count: v, text: `${v} ${k} element(s) kept as they are (not validated by the renderer)` });
  if (doc.removed.length) add('security', { count: doc.removed.length, text: `${doc.removed.length} unsafe item(s) removed on input` });
  for (const w of doc.warnings) add('warning', { text: w });
  for (const e of doc.elements) if (e.errors && e.errors.length) add('invalid-path', { el: e.idx, text: e.errors[0] });
  const drawable = doc.elements.filter((e) => e.subpaths.length);
  const summary = {
    tags, elements: doc.elements.length, paths: doc.elements.filter((e) => e.tag === 'path').length, editable: doc.elements.filter((e) => e.editable).length,
    nodes: totalNodes, bytes: doc.bytes, viewBox: doc.viewBox, width: doc.width, height: doc.height,
    hiddenShare: drawn ? 1 - shown / drawn : 0,
    gradients: doc.gradients.size, clips: doc.clips.size, masks: doc.masks.size,
    strokes: drawable.filter((e) => e.stroke.kind !== 'none').length, transforms: drawable.filter((e) => e.ctm.join(',') !== '1,0,0,1,0,0').length,
    complexity: elements.filter((x) => x.complexity).reduce((a, x) => { a[x.complexity.label] = (a[x.complexity.label] || 0) + 1; return a; }, {}),
  };
  return { summary, elements, issues, counts, removed: doc.removed, unit: u };
}
const rgbHex = (c) => '#' + c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

// Which mode suits this file (the expected numbers come from a real dry run).
export function recommendMode(a) {
  const s = a.summary, c = a.counts, nodes = Math.max(1, s.nodes);
  const noise = ((c['micro-segments'] || 0) + (c['duplicate-points'] || 0) + (c.kinks || 0) + (c['collinear-points'] || 0)) / nodes;
  const reasons = [];
  if (s.hiddenShare > 0.2) reasons.push(`${Math.round(s.hiddenShare * 100)}% of the drawn area is hidden under other shapes`);
  if ((s.complexity['High'] || 0) + (s.complexity['Very high'] || 0)) reasons.push('highly detailed vector paths');
  if (noise > 0.05) reasons.push(`${Math.round(noise * 100)}% of the nodes are noise (micro-segments, duplicates, kinks, collinear)`);
  if (c['near-primitive']) reasons.push(`${c['near-primitive']} shape(s) that are almost perfect circles / rectangles`);
  let mode = 'professional';
  if (s.gradients || s.masks || s.clips || s.strokes > s.editable / 2) { mode = 'balanced'; reasons.push('gradients / masks / strokes present: conservative reconstruction'); }
  else if (!reasons.length) { mode = 'safe'; reasons.push('the geometry is already clean'); }
  return { mode, reasons };
}
