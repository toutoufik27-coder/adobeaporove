// Styles: presentation attributes < <style> sheet rules < inline style="".
// Supports the selectors vector tools write: tag, .class, #id, tag.class, comma lists.
import { walk, localName, textOf, getAttr } from './xml.js';

export const PROPS = ['fill', 'fill-rule', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'opacity', 'clip-path', 'clip-rule', 'mask', 'mask-type', 'filter', 'display', 'visibility', 'vector-effect', 'paint-order', 'color', 'marker-start', 'marker-mid', 'marker-end', 'stop-color', 'stop-opacity', 'overflow', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor', 'color-interpolation', 'mix-blend-mode', 'isolation'];
export const INHERITED = new Set(['fill', 'fill-rule', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'clip-rule', 'visibility', 'paint-order', 'color', 'marker-start', 'marker-mid', 'marker-end', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor', 'color-interpolation']);

export function parseDecls(s) {
  const out = {};
  for (const part of (s || '').split(';')) {
    const c = part.indexOf(':');
    if (c < 0) continue;
    const k = part.slice(0, c).trim().toLowerCase(), v = part.slice(c + 1).replace(/!important/i, '').trim();
    if (k === 'marker') { for (const p of ['marker-start', 'marker-mid', 'marker-end']) out[p] = v; continue; }
    if (k) out[k] = v;
  }
  return out;
}

export function parseSheets(root) {
  const rules = [];
  // what the cascade below cannot evaluate exactly (the protection system locks on it)
  rules.unsupported = []; rules.important = false;
  let order = 0;
  for (const el of walk(root)) {
    if (localName(el.name) !== 'style') continue;
    let css = textOf(el).replace(/\/\*[\s\S]*?\*\//g, '');
    if (/!\s*important/i.test(css)) rules.important = true;
    // drop at-rule blocks (@media, @font-face ...) — not used for geometry
    css = css.replace(/@[a-z-]+[^{;]*\{(?:[^{}]*\{[^}]*\})*[^}]*\}/gi, (m) => { rules.unsupported.push(m.slice(0, m.indexOf('{')).trim()); return ''; }).replace(/@[a-z-]+[^;{]*;/gi, (m) => { rules.unsupported.push(m.trim()); return ''; });
    for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      const decls = parseDecls(m[2]);
      for (let sel of m[1].split(',')) {
        sel = sel.trim();
        const sm = /^([A-Za-z][\w-]*)?((?:[.#][\w-]+)*)$/.exec(sel);
        if (!sm) { rules.unsupported.push(sel); continue; }   // complex selectors are not resolved
        const tag = sm[1] || null, parts = sm[2].match(/[.#][\w-]+/g) || [];
        const classes = parts.filter((p) => p[0] === '.').map((p) => p.slice(1)), ids = parts.filter((p) => p[0] === '#').map((p) => p.slice(1));
        const spec = ids.length * 100 + classes.length * 10 + (tag ? 1 : 0);
        rules.push({ tag, classes, ids, decls, spec, order: order++ });
      }
    }
  }
  return rules;
}

// Own (non-inherited-resolved) declared style of an element.
export function declared(el, rules) {
  const out = {};
  for (const p of PROPS) { const v = getAttr(el, p); if (v !== null) out[p] = v.trim(); }
  const tag = localName(el.name), cls = (getAttr(el, 'class') || '').split(/\s+/).filter(Boolean), id = getAttr(el, 'id');
  const hits = rules.filter((r) => (!r.tag || r.tag === tag) && r.classes.every((c) => cls.includes(c)) && r.ids.every((i) => i === id));
  hits.sort((a, b) => a.spec - b.spec || a.order - b.order);
  for (const r of hits) Object.assign(out, r.decls);
  Object.assign(out, parseDecls(getAttr(el, 'style')));
  return out;
}

// Computed style given the parent's computed style.
export function computed(el, rules, parent) {
  const d = declared(el, rules), out = {};
  for (const p of INHERITED) out[p] = parent ? parent[p] : undefined;
  for (const [k, v] of Object.entries(d)) out[k] = v === 'inherit' ? (parent ? parent[k] : undefined) : v;
  // defaults
  out.fill ??= '#000000'; out['fill-rule'] ??= 'nonzero'; out.stroke ??= 'none'; out['stroke-width'] ??= '1';
  out['stroke-linecap'] ??= 'butt'; out['stroke-linejoin'] ??= 'miter'; out['stroke-miterlimit'] ??= '4';
  out['clip-rule'] ??= 'nonzero'; out.visibility ??= 'visible';
  return out;
}

export const NAMED = { black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff', yellow: '#ffff00', gray: '#808080', grey: '#808080', orange: '#ffa500', purple: '#800080', silver: '#c0c0c0', navy: '#000080', teal: '#008080', maroon: '#800000', lime: '#00ff00', aqua: '#00ffff', cyan: '#00ffff', fuchsia: '#ff00ff', magenta: '#ff00ff', olive: '#808000', pink: '#ffc0cb', brown: '#a52a2a', gold: '#ffd700', transparent: null };
// '#rrggbb' → [r,g,b,a] or null
export function parseColor(c) {
  if (!c) return null;
  c = c.trim().toLowerCase();
  let m = /^#([0-9a-f]{3,4})$/.exec(c);
  if (m) { const h = m[1].split('').map((x) => parseInt(x + x, 16)); return [h[0], h[1], h[2], h.length > 3 ? h[3] / 255 : 1]; }
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(c);
  if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4), 16), m[2] ? parseInt(m[2], 16) / 255 : 1];
  m = /^rgba?\(\s*([\d.]+%?)\s*[, ]\s*([\d.]+%?)\s*[, ]\s*([\d.]+%?)\s*(?:[,/]\s*([\d.]+%?))?\s*\)$/.exec(c);
  if (m) { const v = (x) => x.endsWith('%') ? parseFloat(x) * 2.55 : +x; return [v(m[1]), v(m[2]), v(m[3]), m[4] ? (m[4].endsWith('%') ? parseFloat(m[4]) / 100 : +m[4]) : 1]; }
  if (c in NAMED) { const h = NAMED[c]; return h ? parseColor(h) : [0, 0, 0, 0]; }
  return null;
}
