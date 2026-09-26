#!/usr/bin/env node
// svg-refine — SVG Geometry Restoration & Professional Reconstruction Engine
//   node cli.js in.svg                      analysis + recommendation only
//   node cli.js in.svg out.svg [options]
// options: --mode safe|balanced|professional|aggressive (default: recommended)
//          --stage Original|Cleaned|Simplified|Reconstructed|Shapes|Final
//          --minify | --pretty   --flatten-transforms   --no-structure
//          --precision adaptive|2|3|4   --report file.json   --force
//          --validation strict|fallback   strict (default): the result is accepted only
//               when the browser drew it and it passed; without Chrome / Edge the
//               original is kept. fallback: without a browser the internal renderer
//               alone may accept it, reported as NOT browser-verified.
//          --no-browser   do not use the browser (with strict: the original is kept)
//          --ai URL --model NAME [--provider ollama|openai] [--apply-semantic]
//               semantic check with a local vision model (Ollama, LM Studio ...)
import fs from 'fs';
import { loadSVG } from './src/model.js';
import { analyzeDoc, recommendMode } from './src/analyze.js';
import { processDoc, stateOutput, report, finalize, STAGES } from './src/process.js';
import { settingsFor } from './src/engine.js';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const has = (k) => args.includes(k);
const valued = new Set(['--mode', '--stage', '--precision', '--report', '--ai', '--model', '--provider', '--validation']);
const files = args.filter((a, i) => !a.startsWith('--') && !valued.has(args[i - 1]));
if (!files[0]) { console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 15).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')); process.exit(1); }

const text = fs.readFileSync(files[0], 'utf8');
const doc = loadSVG(text);
for (const r of doc.removed) console.warn(`security: removed ${r.what} (${r.detail})`);
const a = analyzeDoc(doc, settingsFor('balanced'));
const rec = recommendMode(a);
const s = a.summary;
console.log(`${s.elements} elements, ${s.paths} paths, ${s.nodes} nodes, ${(s.bytes / 1024).toFixed(1)} KB, ${Math.round(s.hiddenShare * 100)}% of the drawn area hidden`);
console.log('issues:', Object.entries(a.counts).map(([k, v]) => `${k} ${v}`).join(', ') || 'none');
console.log(`recommended: ${rec.mode} — ${rec.reasons.join('; ')}`);
if (!files[1]) process.exit(0);

const mode = opt('--mode', rec.mode);
const S = settingsFor(mode, { flattenTransforms: has('--flatten-transforms'), ...(opt('--precision') ? { precision: opt('--precision') } : {}) });
const ctx = processDoc(doc, S, (p) => process.stderr.write(`  pass ${p}\n`));
if (has('--ai')) {
  // semantic check: exact structure from the engine, meaning from the local model
  const { detectGroups, buildPrompt, proposals, applyRing, verifyRing } = await import('./src/semantic.js');
  const { askVision, ANSWER_SCHEMA } = await import('./src/ai.js');
  const { pngBase64 } = await import('./src/png.js');
  const { makeView, render } = await import('./src/raster.js');
  const groups = detectGroups(doc, ctx.u);
  if (!groups.length) console.log('semantic: no repeated parts to check');
  else {
    const view = makeView(doc.viewBox, 768), img = render(doc, view, { geom: (x) => (x.removed ? null : x.subpaths) });
    const cfg = { provider: opt('--provider', 'ollama'), url: opt('--ai'), model: opt('--model') };
    console.log(`semantic: asking ${cfg.model} about ${groups.length} group(s)…`);
    const { answer, raw } = await askVision(cfg, buildPrompt(groups), pngBase64(img, view.W, view.H), ANSWER_SCHEMA);
    if (!answer) console.log('semantic: the model did not return JSON:', String(raw).slice(0, 200));
    else {
      console.log(`semantic: the model sees "${answer.object}"`);
      const list = proposals(groups, answer);
      for (const p of list) console.log(`  group ${p.group}: ${p.reason}${p.op === 'count' ? ` (${p.from} -> ${p.to})` : ''}`);
      if (has('--apply-semantic')) {
        const { snapshot, record } = await import('./src/engine.js');
        for (const p of list) {
          const g = groups.find((x) => x.id === p.group), before = doc.elements.map((e) => ({ subpaths: e.subpaths }));
          applyRing(doc, g, p.to, ctx.u);
          const v = verifyRing(doc, before, g, ctx.u);
          if (!v.ok) doc.elements.forEach((e, i) => { e.subpaths = before[i].subpaths; });
          record(ctx, { pass: 'semantic correction', op: p.op === 'count' ? 'set count' : 'even spacing', el: g.el, accepted: v.ok, confidence: p.confidence, label: p.reason, reason: v.ok ? 'nothing outside the group changed' : `${v.outside} px outside the group would change` });
          console.log(`  ${v.ok ? 'applied' : 'rejected'}: group ${p.group}`);
        }
        snapshot(ctx, 'Semantic');
      } else if (list.length) console.log('  (add --apply-semantic to apply)');
    }
  }
}
const stageName = opt('--stage', ctx.history[ctx.history.length - 1].name);
const stage = Math.max(0, ctx.history.findIndex((h) => h.name === stageName));
const exportOpts = { minify: has('--minify'), pretty: !has('--minify'), preserveStructure: !has('--no-structure') };
// the final stage is written only after the exported text itself passed the final
// validation (re-parsed, re-rendered, and rendered in the browser when one is available)
const isFinal = Math.min(stage, ctx.history.length - 1) === ctx.history.length - 1 && ctx.history.at(-1).name === 'Final';
const validation = opt('--validation', 'strict');
if (!['strict', 'fallback'].includes(validation)) { console.error(`--validation must be strict or fallback, not "${validation}"`); process.exit(1); }
const out = isFinal ? await finalize(ctx, exportOpts, { browser: !has('--no-browser'), validation }) : stateOutput(ctx, Math.min(stage, ctx.history.length - 1), exportOpts);
if (isFinal) {
  const v = out.validation;
  const b = v.browser && v.browser.visible != null ? `browser ${(v.browser.visible * 100).toFixed(3)}% / ${v.browser.solid} spot px` : `browser not measured (${v.browserStatus.reason || 'not used'})`;
  const i = v.internal ? `internal ${(v.internal.visible * 100).toFixed(3)}% / ${v.internal.solid} spot px` : 'internal not measured';
  const level = { 'browser-verified': 'passed, browser-verified', 'internal-only': 'passed with the internal renderer only (NOT browser-verified)', 'original-kept': 'the original is kept' }[v.level];
  console.log(`final validation [${v.mode}]: ${level}${v.ok ? '' : ' (' + v.reason + ')'}${v.rolledBack.length ? `, ${v.rolledBack.length} change(s) returned to the original` : ''}; ${i}, ${b}`);
} else console.log(`stage ${ctx.history[stage].name}: written without the final validation (only the Final stage is validated)`);
const r = report(ctx, text, out.text, stage);
console.log(`mode ${mode}: nodes ${r.original.nodes} -> ${r.processed.nodes}, paths ${r.original.paths} -> ${r.processed.paths}, ${(r.original.bytes / 1024).toFixed(1)} KB -> ${(r.processed.bytes / 1024).toFixed(1)} KB`);
console.log(`changes: ${Object.entries(r.changes).map(([k, v]) => `${k} ${v}`).join(', ')}`);
const rvo = r.repairVsOptimization, types = (b) => Object.entries(b.byType).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
console.log(`repairs ${rvo.repairs.total} (${types(rvo.repairs)}); optimizations ${rvo.optimizations.total} (${types(rvo.optimizations)}); rejected ${rvo.rejected}; rolled back ${rvo.rolledBack}`);
console.log(`visual difference: ${r.visual.visible}% visible, ${r.visual.pixelDifference}% of pixels, mean ΔE ${r.visual.meanDeltaE}, ${r.visual.spots} spot pixels`);
if (has('--report')) fs.writeFileSync(opt('--report'), JSON.stringify({ analysis: { summary: a.summary, counts: a.counts }, recommendation: rec, report: r, log: ctx.log }, null, 1));
if (!out.integrity.ok) {
  console.error('integrity check failed:\n  ' + out.integrity.errors.join('\n  '));
  if (!has('--force')) { console.error('not written (use --force to write anyway)'); const { closeBrowser } = await import('./src/browser.js'); await closeBrowser(); process.exit(2); }
}
fs.writeFileSync(files[1], out.text);
console.log(`written ${files[1]}`);
const { closeBrowser } = await import('./src/browser.js');
await closeBrowser();
