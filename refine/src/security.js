// SVG input is untrusted. Everything that can run code, load remote content or
// break out of the image is removed, and each removal is reported.
import { walk, getAttr, delAttr, localName, textOf } from './xml.js';

const BANNED = new Set(['script', 'foreignObject', 'iframe', 'embed', 'object', 'audio', 'video', 'canvas', 'handler', 'listener', 'discard']);
const ANIM = new Set(['animate', 'set', 'animateTransform', 'animateMotion', 'animateColor']);
const LIMITS = { maxBytes: 25 * 1024 * 1024, maxElements: 300000, maxDepth: 256, maxAttr: 8 * 1024 * 1024 };
export { LIMITS };

const safeHref = (v, tag) => {
  const s = v.trim();
  if (s.startsWith('#')) return true;
  if (tag === 'image' && /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=\s]*$/i.test(s)) return true;
  return false;
};
const badUrl = /url\(\s*['"]?\s*(?!#)[^)]*\)/i;
function cleanCss(css) {
  const found = [];
  let out = css.replace(/@import[^;]*;?/gi, (m) => { found.push('CSS @import'); return ''; });
  out = out.replace(/url\(\s*(['"]?)\s*(?!#)[^)]*\)/gi, (m) => { found.push('CSS external url()'); return 'none'; });
  out = out.replace(/expression\s*\(|javascript:|-moz-binding|behavior\s*:/gi, (m) => { found.push('CSS script construct'); return '/*removed*/'; });
  return { out, found };
}

export function sanitize(root) {
  const removed = [];
  if (localName(root.name) !== 'svg') throw new Error('The root element is not <svg>');
  const kill = [];
  for (const el of walk(root)) {
    const tag = localName(el.name);
    const ns = el.name.includes(':') ? el.name.slice(0, el.name.indexOf(':')) : '';
    if (BANNED.has(tag) || ns === 'html' || ns === 'xhtml') { kill.push(el); removed.push({ what: `<${el.name}> element`, detail: 'can run code or embed foreign content' }); continue; }
    if (ANIM.has(tag)) {
      const an = (getAttr(el, 'attributeName') || '').toLowerCase();
      if (/href|^on/.test(an) || /javascript:/i.test(getAttr(el, 'values') || '') || /javascript:/i.test(getAttr(el, 'to') || '')) { kill.push(el); removed.push({ what: `<${tag}> element`, detail: `animates ${an}` }); continue; }
    }
    for (const [k, v] of [...el.attrs]) {
      const lk = k.toLowerCase(), ln = localName(lk);
      if (ln.startsWith('on')) { delAttr(el, k); removed.push({ what: `${k} attribute`, detail: `event handler on <${tag}>` }); continue; }
      if (ln === 'href' || ln === 'src' || lk === 'xlink:arcrole' && false) {
        if (!safeHref(v, tag)) { delAttr(el, k); removed.push({ what: `${k} attribute`, detail: `${tag}: ${/^\s*javascript:/i.test(v) ? 'javascript: link' : 'external or unsafe reference'}` }); }
        continue;
      }
      if (v.length > LIMITS.maxAttr) { delAttr(el, k); removed.push({ what: `${k} attribute`, detail: 'value too large' }); continue; }
      if (lk === 'style' || /url\(/i.test(v)) {
        if (lk === 'style') {
          const r = cleanCss(v);
          if (r.found.length) { el.attrs.find((a) => a[0] === k)[1] = r.out; for (const f of r.found) removed.push({ what: f, detail: `style on <${tag}>` }); }
        } else if (badUrl.test(v)) { delAttr(el, k); removed.push({ what: `${k} attribute`, detail: 'external url()' }); }
      }
    }
    if (tag === 'style') {
      const r = cleanCss(textOf(el));
      if (r.found.length) {
        el.children = [{ type: 'text', value: r.out, parent: el }];
        for (const f of r.found) removed.push({ what: f, detail: '<style> sheet' });
      }
    }
  }
  for (const el of kill) if (el.parent) el.parent.children = el.parent.children.filter((c) => c !== el);
  return removed;
}
