// Minimal, strict XML parser and serializer for SVG documents.
// - no DOCTYPE / entity expansion (removed and reported: no XXE, no entity bombs)
// - comments and processing instructions are dropped
// - attribute order is kept so untouched elements are written back as they were
// Node: { type: 'el', name, attrs: [[name, value]...], children: [], parent }
//       { type: 'text', value, cdata }

const ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') { const c = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ''; }
    return ENT[e] ?? m;
  });
}
const escAttr = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;').replace(/\n/g, '&#10;');
const escText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export class XMLError extends Error {}

export function parseXML(text, limits = {}) {
  const maxEls = limits.maxElements ?? 300000, maxDepth = limits.maxDepth ?? 256;
  const removed = [];
  const doc = { type: 'el', name: '#document', attrs: [], children: [], parent: null };
  let cur = doc, i = 0, count = 0, depth = 0;
  const n = text.length;
  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt < 0) { addText(cur, text.slice(i)); break; }
    if (lt > i) addText(cur, text.slice(i, lt));
    if (text.startsWith('<!--', lt)) {
      const e = text.indexOf('-->', lt + 4);
      if (e < 0) throw new XMLError('unterminated comment');
      i = e + 3; continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const e = text.indexOf(']]>', lt + 9);
      if (e < 0) throw new XMLError('unterminated CDATA');
      cur.children.push({ type: 'text', value: text.slice(lt + 9, e), cdata: true, parent: cur });
      i = e + 3; continue;
    }
    if (text.startsWith('<?', lt)) {
      const e = text.indexOf('?>', lt + 2);
      if (e < 0) throw new XMLError('unterminated processing instruction');
      i = e + 2; continue;
    }
    if (text.startsWith('<!', lt)) {
      // DOCTYPE (possibly with an internal subset [...]): dropped, never expanded
      let j = lt + 2, br = 0;
      for (; j < n; j++) { const c = text[j]; if (c === '[') br++; else if (c === ']') br--; else if (c === '>' && br <= 0) break; }
      if (j >= n) throw new XMLError('unterminated declaration');
      const decl = text.slice(lt, j + 1);
      removed.push({ what: /ENTITY/i.test(decl) ? 'DOCTYPE with entity declarations' : 'DOCTYPE', detail: decl.slice(0, 80) });
      i = j + 1; continue;
    }
    if (text[lt + 1] === '/') {
      const e = text.indexOf('>', lt);
      if (e < 0) throw new XMLError('unterminated end tag');
      const name = text.slice(lt + 2, e).trim();
      if (cur === doc || cur.name !== name) throw new XMLError(`mismatched end tag </${name}>${cur !== doc ? ` (open: <${cur.name}>)` : ''}`);
      cur = cur.parent; depth--; i = e + 1; continue;
    }
    // start tag
    let j = lt + 1;
    while (j < n && !/[\s/>]/.test(text[j])) j++;
    const name = text.slice(lt + 1, j);
    if (!/^[A-Za-z_][\w.:-]*$/.test(name)) throw new XMLError(`invalid tag name "${name.slice(0, 30)}"`);
    const attrs = [];
    for (;;) {
      while (j < n && /\s/.test(text[j])) j++;
      if (j >= n) throw new XMLError(`unterminated tag <${name}>`);
      if (text[j] === '>' || (text[j] === '/' && text[j + 1] === '>')) break;
      let k = j;
      while (k < n && !/[\s=/>]/.test(text[k])) k++;
      const an = text.slice(j, k);
      if (!an) throw new XMLError(`bad attribute in <${name}>`);
      while (k < n && /\s/.test(text[k])) k++;
      if (text[k] !== '=') throw new XMLError(`attribute ${an} without value in <${name}>`);
      k++;
      while (k < n && /\s/.test(text[k])) k++;
      const q = text[k];
      if (q !== '"' && q !== "'") throw new XMLError(`unquoted attribute ${an} in <${name}>`);
      const e = text.indexOf(q, k + 1);
      if (e < 0) throw new XMLError(`unterminated attribute ${an}`);
      if (attrs.some((a) => a[0] === an)) throw new XMLError(`duplicate attribute ${an} in <${name}>`);
      attrs.push([an, decodeEntities(text.slice(k + 1, e))]);
      j = e + 1;
    }
    const el = { type: 'el', name, attrs, children: [], parent: cur };
    if (++count > maxEls) throw new XMLError(`too many elements (limit ${maxEls})`);
    cur.children.push(el);
    if (text[j] === '/') { i = j + 2; continue; }
    i = j + 1;
    cur = el;
    if (++depth > maxDepth) throw new XMLError(`nesting too deep (limit ${maxDepth})`);
  }
  if (cur !== doc) throw new XMLError(`unclosed element <${cur.name}>`);
  const root = doc.children.find((c) => c.type === 'el');
  if (!root) throw new XMLError('no root element');
  if (doc.children.filter((c) => c.type === 'el').length > 1) throw new XMLError('more than one root element');
  root.parent = null;
  return { root, removed, elements: count };
}
function addText(el, s) {
  if (!s) return;
  el.children.push({ type: 'text', value: decodeEntities(s), parent: el });
}

// ---- helpers
export const getAttr = (el, name) => { for (const a of el.attrs) if (a[0] === name) return a[1]; return null; };
export function setAttr(el, name, value) {
  for (const a of el.attrs) if (a[0] === name) { a[1] = String(value); return; }
  el.attrs.push([name, String(value)]);
}
export function delAttr(el, name) { el.attrs = el.attrs.filter((a) => a[0] !== name); }
export function* walk(el) { yield el; for (const c of el.children) if (c.type === 'el') yield* walk(c); }
export const localName = (name) => name.includes(':') ? name.slice(name.indexOf(':') + 1) : name;
export const textOf = (el) => el.children.filter((c) => c.type === 'text').map((c) => c.value).join('');

export function cloneTree(el, parent = null) {
  if (el.type === 'text') return { ...el, parent };
  const c = { type: 'el', name: el.name, attrs: el.attrs.map((a) => [a[0], a[1]]), children: [], parent };
  c.children = el.children.map((k) => cloneTree(k, c));
  if (el.geomRef !== undefined) c.geomRef = el.geomRef;
  return c;
}

// Text content where whitespace is part of the drawing: written verbatim (every text
// node kept, nothing indented). Pretty-printing or dropping the space between two
// <tspan>s changes what the text shows.
const VERBATIM = new Set(['text', 'tspan', 'textPath', 'tref', 'altGlyph', 'title', 'desc', 'style', 'script']);
const verbatimNode = (el) => VERBATIM.has(localName(el.name)) || getAttr(el, 'xml:space') === 'preserve';
// pretty: indent elements (text-bearing elements such as <text>/<style> stay inline)
export function serialize(root, { pretty = true, indent = '  ' } = {}) {
  const out = [];
  const exact = (el) => {
    const attrs = el.attrs.map(([k, v]) => ` ${k}="${escAttr(v)}"`).join('');
    if (!el.children.length) return `<${el.name}${attrs}/>`;
    return `<${el.name}${attrs}>` + el.children.map((c) => c.type === 'text' ? (c.cdata ? `<![CDATA[${c.value}]]>` : escText(c.value)) : exact(c)).join('') + `</${el.name}>`;
  };
  const rec = (el, level) => {
    const pad = pretty ? indent.repeat(level) : '';
    if (verbatimNode(el)) { out.push(pad + exact(el)); return; }
    const attrs = el.attrs.map(([k, v]) => ` ${k}="${escAttr(v)}"`).join('');
    if (!el.children.length) { out.push(`${pad}<${el.name}${attrs}/>`); return; }
    const hasText = el.children.some((c) => c.type === 'text' && c.value.trim());
    if (hasText || !pretty) {
      const kids = hasText ? el.children : el.children.filter((c) => c.type === 'el');
      if (!kids.length) { out.push(`${pad}<${el.name}${attrs}/>`); return; }
      out.push(`${pad}<${el.name}${attrs}>` + kids.map((c) => c.type === 'text' ? (c.cdata ? `<![CDATA[${c.value}]]>` : escText(c.value)) : inline(c)).join('') + `</${el.name}>`);
      return;
    }
    out.push(`${pad}<${el.name}${attrs}>`);
    for (const c of el.children) if (c.type === 'el') rec(c, level + 1);
    out.push(`${pad}</${el.name}>`);
  };
  const inline = (el) => { const saved = out.length; rec(el, 0); const s = out.splice(saved).join(''); return s; };
  rec(root, 0);
  return out.join(pretty ? '\n' : '');
}
