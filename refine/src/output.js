// Writes a processing state back into a copy of the original document.
// Untouched elements are written exactly as they were.
import { serialize, getAttr, setAttr, delAttr, walk, localName } from './xml.js';
import { writePath } from './pathdata.js';

function cloneWithMap(el, map, parent = null) {
  if (el.type === 'text') return { ...el, parent };
  const c = { type: 'el', name: el.name, attrs: el.attrs.map((a) => [a[0], a[1]]), children: [], parent };
  map.set(el, c);
  c.children = el.children.map((k) => cloneWithMap(k, map, c));
  return c;
}
const GEOM_ATTRS = { rect: ['x', 'y', 'width', 'height', 'rx', 'ry'], circle: ['cx', 'cy', 'r'], ellipse: ['cx', 'cy', 'rx', 'ry'], line: ['x1', 'y1', 'x2', 'y2'], polygon: ['points'], polyline: ['points'] };
const EDITOR_NS = /^(inkscape|sodipodi|sketch|serif|figma|i|x|graph|a|dc|cc|rdf):/;

export function exportSVG(doc, state, opts = {}) {
  const { minify = false, pretty = !minify, preserveStructure = true, exact = false } = opts;
  const map = new Map(), root = cloneWithMap(doc.root, map);
  for (const e of doc.elements) {
    const st = state[e.idx], node = map.get(e.node);
    if (!node || exact || !e.editable && !st.flat) continue;
    if (st.removed) { if (node.parent) node.parent.children = node.parent.children.filter((c) => c !== node); continue; }
    const digits = st.digits ?? 3;
    const changed = st.subpaths !== e.orig || st.flat;
    const tag = localName(node.name);
    if (tag === 'path') {
      // an unchanged path is written exactly as it was: rounding it was never validated
      if (changed) setAttr(node, 'd', writePath(st.subpaths, digits, { minify }));
    } else if ((tag === 'polygon' || tag === 'polyline') && !st.flat) {
      if (!changed) continue;
      const sp = st.subpaths[0];
      if (st.subpaths.length === 1 && sp.segs.every((g) => g.t === 'L') && sp.closed === (tag === 'polygon')) {
        const f = (v) => (+v.toFixed(digits)).toString();
        const pts = [sp.segs[0].p[0], ...sp.segs.map((g) => g.p[1])];
        if (sp.closed) pts.pop();
        setAttr(node, 'points', pts.map((q) => `${f(q[0])},${f(q[1])}`).join(' '));
      } else toPath(node, tag, writePath(st.subpaths, digits, { minify }));
    } else if (st.flat) toPath(node, tag, writePath(st.subpaths, digits, { minify }));
    if (st.flat) {
      delAttr(node, 'transform');
      if (e.stroke.kind !== 'none') {
        const style = getAttr(node, 'style');
        setAttr(node, 'style', `${style ? style.replace(/;?\s*$/, ';') : ''}stroke-width:${+st.flat.strokeWidth.toFixed(4)}`);
      }
    }
  }
  if (!preserveStructure) cleanStructure(root);
  const body = serialize(root, { pretty });
  return (pretty ? '' : '') + body;
}
function toPath(node, tag, d) {
  for (const k of GEOM_ATTRS[tag] || []) delAttr(node, k);
  node.name = node.name.includes(':') ? node.name.replace(/:[^:]+$/, ':path') : 'path';
  setAttr(node, 'd', d);
}
// editor metadata out, empty groups unwrapped, empty defs removed (ids are kept)
function cleanStructure(root) {
  const rec = (el) => {
    el.attrs = el.attrs.filter(([k]) => !EDITOR_NS.test(k) && !/^xmlns:(inkscape|sodipodi|sketch|serif|figma|i|x|graph|a|dc|cc|rdf)$/.test(k) && k !== 'data-name');
    const out = [];
    for (const c of el.children) {
      if (c.type !== 'el') { out.push(c); continue; }
      const t = localName(c.name);
      if (t === 'metadata' || EDITOR_NS.test(c.name)) continue;
      rec(c);
      if (t === 'g' && !c.attrs.length) { for (const k of c.children) { k.parent = el; out.push(k); } continue; }
      if ((t === 'g' || t === 'defs') && !c.children.some((k) => k.type === 'el') && !getAttr(c, 'id')) continue;
      out.push(c);
    }
    el.children = out;
  };
  rec(root);
}
