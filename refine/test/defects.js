// Defect fixtures (test/defects/, made by make-defects.js): every bad.svg has a real
// geometric defect and expected.svg the corrected drawing. A repair must
//   - be validated (the exported file, re-parsed and rendered; browser when present)
//   - move the geometry TOWARD expected.svg (measured independently of the engine:
//     dense samples, symmetric Hausdorff distance, test/geodiff.js)
//   - reach the element / contour structure and topology of expected.svg
//   - be counted as a REPAIR of the right type (an optimization is not a repair)
// clean.svg: nothing to repair. No repair may be reported, and no geometry may move.
// Intentionally irregular shapes (an egg, a squircle) must keep their own outline.
//   node test/defects.js
import fs from 'fs';
import { loadSVG } from '../src/model.js';
import { processDoc, finalize, report } from '../src/process.js';
import { settingsFor } from '../src/engine.js';
import { drawing, geoDistance, paintDistance } from './geodiff.js';
import { DEFECTS } from './make-defects.js';

const dir = new URL('./defects/', import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, dir), 'utf8');

export async function runOne(text, mode, validation) {
  const doc = loadSVG(text), ctx = processDoc(doc, settingsFor(mode));
  const out = await finalize(ctx, {}, { validation });
  return { ctx, out, r: report(ctx, text, out.text) };
}

export async function defectTests(ok, skip, { validation = 'fallback', mode = 'professional' } = {}) {
  const rows = [];
  for (const [name, d] of Object.entries(DEFECTS)) {
    const bad = read(`${name}/bad.svg`), exp = read(`${name}/expected.svg`);
    const { out, r } = await runOne(bad, mode, validation);
    const B = drawing(bad), E = drawing(exp), O = drawing(out.text);
    const dBad = geoDistance(B, E), dOut = geoDistance(O, E), pBad = paintDistance(B, E), pOut = paintDistance(O, E);
    const rvo = r.repairVsOptimization, bucket = d.optimization ? rvo.optimizations : rvo.repairs, n = bucket.byType[d.kind] || 0;
    const structure = O.elements === E.elements && O.contours === E.contours && O.topo === E.topo;
    // closer to the truth: at most half the distance of the defect, or exact where the defect is structural;
    // the same paint by paint (a shape in the wrong colour is not in its place)
    const closer = isFinite(dBad) && dBad > 0 ? dOut <= 0.5 * dBad : dOut <= 0.05;
    const closerPaint = isFinite(pBad) && pBad > 0 ? pOut <= 0.5 * pBad : pOut <= 0.05;
    const v = out.validation, fmt = (x) => (isFinite(x) ? x.toFixed(3) : 'structure');
    rows.push({ name, dBad, dOut, pBad, pOut, repairs: rvo.repairs.total, optimizations: rvo.optimizations.total });
    ok(v.ok && out.integrity.ok && structure && closer && closerPaint && n >= d.count,
      `defect ${name} [${mode}]: distance to expected ${fmt(dBad)} u -> ${dOut.toFixed(3)} u${pBad !== dBad || pOut !== dOut ? ` (paint by paint ${fmt(pBad)} u -> ${fmt(pOut)} u)` : ''}; elements ${B.elements}/${O.elements} (expected ${E.elements}), contours ${B.contours}/${O.contours} (expected ${E.contours}); ${d.kind} x${n} (needed ${d.count}); repairs ${rvo.repairs.total}, optimizations ${rvo.optimizations.total}; ${v.level}`);
  }
  // clean geometry, every mode: no repair, no movement
  const clean = read('clean.svg'), C = drawing(clean);
  for (const mode2 of ['safe', 'balanced', 'professional', 'aggressive']) {
    const { out, r } = await runOne(clean, mode2, validation);
    const d = geoDistance(drawing(out.text), C), rvo = r.repairVsOptimization;
    ok(out.validation.ok && rvo.repairs.total === 0 && d <= 0.1 && r.processed.nodes <= r.original.nodes,
      `clean SVG [${mode2}]: NO SIGNIFICANT REPAIR (repairs ${rvo.repairs.total}, optimizations ${rvo.optimizations.total}, geometry moved ${d.toFixed(3)} u)`);
  }
  // intentionally irregular: close to a circle / ellipse, but not one
  const f = (v) => +v.toFixed(3);
  const outlinePath = (fn, n = 96) => 'M' + Array.from({ length: n }, (_, i) => { const t = (2 * Math.PI * i) / n, p = fn(t); return `${f(p[0])} ${f(p[1])}`; }).join(' L') + 'Z';
  const shapes = {
    egg: outlinePath((t) => [100 + 50 * Math.cos(t) * (1 + 0.08 * Math.sin(t)), 100 + 60 * Math.sin(t)]),
    squircle: outlinePath((t) => { const c = Math.cos(t), s = Math.sin(t), k = 2.6; return [100 + 55 * Math.sign(c) * Math.abs(c) ** (2 / k), 100 + 55 * Math.sign(s) * Math.abs(s) ** (2 / k)]; }),
  };
  // small shapes: a systematic departure of 1.6 % (three soft lobes) is a design;
  // random radial noise of ±1.2 % on a circle is a drawing error
  shapes['small three-lobed shape'] = outlinePath((t) => { const r = 10 * (1 + 0.016 * Math.cos(3 * t)); return [100 + r * Math.cos(t), 100 + r * Math.sin(t)]; }, 48);
  for (const [name, dd] of Object.entries(shapes)) {
    const text = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><path fill="#333" d="${dd}"/></svg>`;
    const m = name.startsWith('small') ? 'professional' : 'aggressive';
    const { ctx, out } = await runOne(text, m, validation);
    const rebuilt = ctx.log.filter((l) => l.accepted && / reconstruction$/.test(l.op) && l.op !== 'curve reconstruction');
    const d = geoDistance(drawing(out.text), drawing(text));
    ok(!rebuilt.length && d <= settingsFor(m).maxDev + 0.05, `intentionally irregular ${name} [${m}]: KEEP ORIGINAL shape (${rebuilt.length ? 'rebuilt as ' + rebuilt[0].op : 'not rebuilt as a primitive'}; moved ${d.toFixed(2)} u; ${ctx.log.filter((l) => / reconstruction$/.test(l.op) && l.accepted === false).map((l) => l.reason).slice(0, 1).join('') || 'no primitive close enough'})`);
  }
  {
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const noisy = outlinePath((t) => { const r = 10 * (1 + 0.012 * (2 * rnd() - 1)); return [100 + r * Math.cos(t), 100 + r * Math.sin(t)]; }, 48);
    const text = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><path fill="#333" d="${noisy}"/></svg>`;
    const { ctx } = await runOne(text, 'professional', validation);
    const rebuilt = ctx.log.find((l) => l.accepted && l.op === 'circle reconstruction');
    ok(!!rebuilt, `small circle with random radial noise of ±1.2 % [professional]: rebuilt as a circle (${rebuilt ? `regularity ${(rebuilt.evidence.systematic * 100).toFixed(2)}% of its size` : ctx.log.filter((l) => / reconstruction$/.test(l.op)).map((l) => l.reason).join('; ')})`);
  }
  return rows;
}

if (process.argv[1] && process.argv[1].endsWith('defects.js')) {
  let fail = 0;
  await defectTests((c, m) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) fail++; }, (m) => console.log('SKIP ' + m), { validation: process.argv.includes('--strict') ? 'strict' : 'fallback' });
  const { closeBrowser } = await import('../src/browser.js'); await closeBrowser();
  process.exit(fail ? 1 : 0);
}
