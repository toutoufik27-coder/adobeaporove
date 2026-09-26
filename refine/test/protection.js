// Protection invariants on the adversarial fixtures (test/fixtures/):
//  - every element the capability system locks comes out byte-identical
//  - data-role="protected" elements are always locked and unchanged
//  - data-role="keep" elements are never removed
//  - the control geometry of fixtures whose feature is local is still improved
//    (the protection is targeted, not "freeze everything")
//   node test/protection.js        (also run from test/run.js)
import fs from 'fs';
import { loadSVG } from '../src/model.js';
import { processDoc, stateOutput } from '../src/process.js';
import { settingsFor } from '../src/engine.js';
import { parseXML, walk, getAttr } from '../src/xml.js';

const dir = new URL('./fixtures/', import.meta.url);
// fixtures whose risky feature is local: the plain control shape far away must still be processed
const LOCAL = ['filter-shadow', 'filter-group', 'pattern-fill', 'mask-luminance', 'mask-bbox-alpha', 'clip-bbox', 'clip-user-nested', 'text-overlap', 'image-overlap', 'marker-inherited', 'marker-css', 'vector-effect', 'stroke-dash', 'stroke-skew', 'use-referenced', 'hidden-under-filter', 'hidden-under-pattern', 'hidden-under-mask', 'group-opacity', 'opacity-fill-stroke'];

const byK = (text) => {
  const m = new Map();
  for (const el of walk(parseXML(text).root)) { const k = getAttr(el, 'data-k'); if (k != null) m.set(k, el); }
  return m;
};
const sig = (el) => el ? el.name + ' ' + el.attrs.map(([k, v]) => `${k}=${v}`).join(' ') : 'REMOVED';

export function protectionTests(ok, mode = 'professional') {
  const results = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.svg')).sort()) {
    const name = f.replace(/\.svg$/, ''), text = fs.readFileSync(new URL(f, dir), 'utf8');
    const doc = loadSVG(text);
    const ctx = processDoc(doc, settingsFor(mode));
    const out = stateOutput(ctx, ctx.history.length - 1, {});
    const A = byK(text), B = byK(out.text);
    const problems = [];
    for (const e of doc.elements) {
      const k = getAttr(e.node, 'data-k');
      const role = getAttr(e.node, 'data-role');
      if (e.locked && k != null && sig(A.get(k)) !== sig(B.get(k))) problems.push(`locked element data-k=${k} changed`);
      if (role === 'protected' && !e.locked) problems.push(`data-k=${k} should be protected (not locked)`);
      if (role === 'keep' && !B.get(k)) problems.push(`data-k=${k} was removed`);
    }
    // any locked element without data-k: compare by position in the document order
    const ea = [...walk(parseXML(text).root)], eb = [...walk(parseXML(out.text).root)];
    if (doc.elements.some((e) => e.locked && getAttr(e.node, 'data-k') == null)) for (const e of doc.elements) {
      if (!e.locked || getAttr(e.node, 'data-k') != null) continue;
      const i = ea.findIndex((n) => n.attrs.map(String).join() === e.node.attrs.map(String).join() && n.name === e.node.name);
      if (i < 0 || !eb.some((n) => sig(n) === sig(ea[i]))) problems.push(`locked <${e.tag}> changed`);
    }
    const control = [...A.entries()].find(([, el]) => getAttr(el, 'data-role') === 'control');
    const controlChanged = control ? sig(control[1]) !== sig(B.get(control[0])) : null;
    if (LOCAL.includes(name) && control && !controlChanged) problems.push('control geometry was not processed (protection is not targeted)');
    const locked = doc.elements.filter((e) => e.locked);
    results.push({ name, locked: locked.length, reasons: [...new Set(locked.flatMap((e) => e.support.reasons.map((r) => r.code)))], controlChanged, integrity: out.integrity.ok, problems });
    ok(!problems.length && out.integrity.ok, `protection ${name}: ${locked.length} locked [${results.at(-1).reasons.join(', ')}]${problems.length ? ' — ' + problems.join('; ') : ''}${out.integrity.ok ? '' : ' INTEGRITY ' + out.integrity.errors.join('; ')}`);
  }
  return results;
}

if (process.argv[1] && process.argv[1].endsWith('protection.js')) {
  let fail = 0;
  protectionTests((c, msg) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${msg}`); if (!c) fail++; });
  process.exit(fail ? 1 : 0);
}
