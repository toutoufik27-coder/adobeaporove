// SVG Integrity Check (before export): XML, SVG root, path data, references,
// gradients, masks, clipping, IDs, numbers.
import { parseXML, walk, getAttr, localName } from './xml.js';
import { parsePath } from './pathdata.js';

export function integrity(text) {
  const errors = [], warnings = [];
  let root;
  try { root = parseXML(text).root; } catch (e) { return { ok: false, errors: [`XML: ${e.message}`], warnings }; }
  if (localName(root.name) !== 'svg') errors.push('root element is not <svg>');
  if (!getAttr(root, 'xmlns')) errors.push('missing xmlns="http://www.w3.org/2000/svg"');
  const vb = (getAttr(root, 'viewBox') || '').split(/[\s,]+/).filter(Boolean).map(Number);
  if (getAttr(root, 'viewBox') && (vb.length !== 4 || !vb.every(isFinite) || vb[2] <= 0 || vb[3] <= 0)) errors.push('invalid viewBox');
  if (!getAttr(root, 'viewBox') && !(getAttr(root, 'width') && getAttr(root, 'height'))) warnings.push('no viewBox (the drawing will not scale)');
  const ids = new Map(), refs = [];
  let paths = 0;
  for (const el of walk(root)) {
    const tag = localName(el.name), id = getAttr(el, 'id');
    if (id != null) { if (ids.has(id)) errors.push(`duplicate id "${id}"`); ids.set(id, el); if (!/^[A-Za-z_][\w.:-]*$/.test(id)) warnings.push(`unusual id "${id}"`); }
    for (const [k, v] of el.attrs) {
      for (const m of v.matchAll(/url\(\s*['"]?#([^'")\s]+)/g)) refs.push([m[1], `${tag} ${k}`]);
      if (/href$/.test(k) && v.startsWith('#')) refs.push([v.slice(1), `${tag} ${k}`]);
      if (/^(x|y|width|height|r|rx|ry|cx|cy|x1|x2|y1|y2|stroke-width|opacity)$/.test(k) && !/^\s*[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?(px|%|pt|mm|cm|in|em)?\s*$/i.test(v) && v !== 'auto' && !(k === 'width' || k === 'height') ) errors.push(`${tag}: invalid number ${k}="${v.slice(0, 20)}"`);
    }
    if (tag === 'path') {
      paths++;
      const r = parsePath(getAttr(el, 'd') || '');
      if (r.errors.length) errors.push(`path${id ? '#' + id : ''}: ${r.errors[0]}`);
      if (!getAttr(el, 'd')) warnings.push('path without d');
    }
    if (tag === 'linearGradient' || tag === 'radialGradient') {
      const stops = el.children.filter((c) => c.type === 'el' && localName(c.name) === 'stop');
      if (!stops.length && !getAttr(el, 'href') && !getAttr(el, 'xlink:href')) errors.push(`gradient ${id || ''} has no stops`);
    }
    if ((tag === 'clipPath' || tag === 'mask') && !el.children.some((c) => c.type === 'el')) warnings.push(`${tag} ${id || ''} is empty`);
    if (tag === 'script' || tag === 'foreignObject' || el.attrs.some(([k]) => /^on/i.test(k))) errors.push(`unsafe content <${tag}>`);
  }
  for (const [r, where] of refs) if (!ids.has(r)) errors.push(`broken reference #${r} (${where})`);
  return { ok: !errors.length, errors, warnings, paths };
}
